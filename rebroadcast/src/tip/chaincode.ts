/**
 * `tip chaincode-check` (design §9). Replaying the archive also replays the source's `_lifecycle` writes, so each
 * chaincode's SOURCE definition is committed on the destination at the source's sequence. No destination org approved
 * it with a destination package, so it cannot run there. The tip step is one approve + commit per chaincode at the next
 * sequence, with a package holding the migration contract and collection policies naming orgs that have peers on
 * the destination.
 *
 * For each chaincode this reports the source definition (rebuilt from the archive), the destination's committed
 * definition, whether the migration contract answers, and what is wrong with the collection and endorsement policies.
 * It prints the lifecycle commands to run, and can write the collection config files they name. It never approves,
 * commits, installs or builds anything.
 */
import * as fs from 'fs';
import * as path from 'path';
import { common, ledger, msp, peer } from '@hyperledger/fabric-protos';
import { Archive } from '../archive/reader';
import { Destination, liveConfig } from '../destination';
import { appOrgs } from '../config/chain';
import { Endorser } from '../fabric/endorser';
import { validActions } from '../verify/facts';

const lc = peer.lifecycle;
const ROLE: Record<number, string> = { 0: 'member', 1: 'admin', 2: 'client', 3: 'peer', 4: 'orderer' };

export interface Policy { kind: 'signature' | 'reference' | 'none'; text: string; msps: string[] }
export interface Collection { name: string; policy: Policy; requiredPeerCount: number; maxPeerCount: number; blockToLive: number; memberOnlyRead: boolean; memberOnlyWrite: boolean; endorsement?: Policy }
export interface Definition { name: string; sequence: number; version: string; initRequired: boolean; endorsement: Policy; collections: Collection[]; block?: number }

/** A SignaturePolicyEnvelope as the peer CLI writes it: OR('A.member', ...), AND(...), OutOf(n, ...). */
export function renderSignaturePolicy(env: common.SignaturePolicyEnvelope): Policy {
  const ids = env.getIdentitiesList().map((p) => {
    if (p.getPrincipalClassification() !== msp.MSPPrincipal.Classification.ROLE) return { msp: '?', text: "'<non-role principal>'" };
    const r = msp.MSPRole.deserializeBinary(p.getPrincipal_asU8());
    return { msp: r.getMspIdentifier(), text: `'${r.getMspIdentifier()}.${ROLE[r.getRole()] ?? r.getRole()}'` };
  });
  const walk = (s: common.SignaturePolicy): string => {
    if (s.hasSignedBy()) return ids[s.getSignedBy()]?.text ?? '?';
    const n = s.getNOutOf()!;
    const parts = n.getRulesList().map(walk);
    if (n.getN() === 1 && parts.length > 1) return `OR(${parts.join(', ')})`;
    if (n.getN() === parts.length && parts.length > 1) return `AND(${parts.join(', ')})`;
    if (parts.length === 1 && n.getN() === 1) return `OR(${parts[0]})`;
    return `OutOf(${n.getN()}, ${parts.join(', ')})`;
  };
  return { kind: 'signature', text: env.getRule() ? walk(env.getRule()!) : '', msps: [...new Set(ids.map((i) => i.msp))] };
}

export function renderApplicationPolicy(bytes: Uint8Array | undefined): Policy {
  if (!bytes || !bytes.length) return { kind: 'none', text: '', msps: [] };
  const ap = common.ApplicationPolicy.deserializeBinary(bytes);
  if (ap.hasSignaturePolicy()) return renderSignaturePolicy(ap.getSignaturePolicy()!);
  return { kind: 'reference', text: ap.getChannelConfigPolicyReference(), msps: [] };
}

export function collectionsOf(pkg: peer.CollectionConfigPackage | undefined): Collection[] {
  return (pkg?.getConfigList() ?? []).filter((c) => c.hasStaticCollectionConfig()).map((c) => {
    const s = c.getStaticCollectionConfig()!;
    const sp = s.getMemberOrgsPolicy()?.getSignaturePolicy();
    const ep = s.getEndorsementPolicy();
    return {
      name: s.getName(),
      policy: sp ? renderSignaturePolicy(sp) : { kind: 'none', text: '', msps: [] },
      requiredPeerCount: s.getRequiredPeerCount(), maxPeerCount: s.getMaximumPeerCount(), blockToLive: Number(s.getBlockToLive()),
      memberOnlyRead: s.getMemberOnlyRead(), memberOnlyWrite: s.getMemberOnlyWrite(),
      endorsement: ep ? renderApplicationPolicy(ep.serializeBinary()) : undefined,
    };
  });
}

/** The chaincode definitions the source committed, rebuilt from the archive's VALID `_lifecycle` writes. */
export function sourceDefinitions(archive: Archive): Map<string, Definition> {
  const fields = new Map<string, Map<string, { v: Uint8Array; block: number }>>();
  for (const { block, rw } of validActions(archive)) {
    for (const ns of rw.getNsRwsetList()) {
      if (ns.getNamespace() !== '_lifecycle') continue;
      for (const w of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8()).getWritesList()) {
        const m = /^namespaces\/fields\/([^/]+)\/(Sequence|EndorsementInfo|ValidationInfo|Collections)$/.exec(w.getKey());
        if (!m) continue;
        let f = fields.get(m[1]);
        if (!f) fields.set(m[1], (f = new Map()));
        if (w.getIsDelete()) f.delete(m[2]); else f.set(m[2], { v: w.getValue_asU8(), block });
      }
    }
  }
  const out = new Map<string, Definition>();
  for (const [name, f] of fields) {
    const sd = (k: string): peer.lifecycle.StateData | undefined => (f.get(k) ? lc.StateData.deserializeBinary(f.get(k)!.v) : undefined);
    const seq = sd('Sequence');
    if (!seq) continue;
    const ei = sd('EndorsementInfo') ? lc.ChaincodeEndorsementInfo.deserializeBinary(sd('EndorsementInfo')!.getBytes_asU8()) : undefined;
    const vi = sd('ValidationInfo') ? lc.ChaincodeValidationInfo.deserializeBinary(sd('ValidationInfo')!.getBytes_asU8()) : undefined;
    const cb = sd('Collections')?.getBytes_asU8();
    out.set(name, {
      name, sequence: Number(seq.getInt64()), version: ei?.getVersion() ?? '', initRequired: ei?.getInitRequired() ?? false,
      endorsement: renderApplicationPolicy(vi?.getValidationParameter_asU8()),
      collections: collectionsOf(cb && cb.length ? peer.CollectionConfigPackage.deserializeBinary(cb) : undefined),
      block: f.get('Sequence')!.block,
    });
  }
  return out;
}

/**
 * Every collection the archive defines, keyed "chaincode/collection": the latest config committed through
 * `_lifecycle`, or through legacy `lscc` (`<chaincode>~collection`, AMB 1.4 sources) for chaincodes `_lifecycle` never
 * defined.
 */
export function archiveCollections(archive: Archive): Map<string, Collection> {
  const out = new Map<string, Collection>();
  const fromLifecycle = sourceDefinitions(archive);
  for (const d of fromLifecycle.values()) for (const c of d.collections) out.set(`${d.name}/${c.name}`, c);
  const legacy = new Map<string, Uint8Array>();
  for (const { rw } of validActions(archive)) {
    for (const ns of rw.getNsRwsetList()) {
      if (ns.getNamespace() !== 'lscc') continue;
      for (const w of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8()).getWritesList()) {
        const m = /^(.+)~collection$/.exec(w.getKey());
        if (m && !w.getIsDelete()) legacy.set(m[1], w.getValue_asU8());
      }
    }
  }
  for (const [cc, bytes] of legacy) {
    if (fromLifecycle.has(cc) || !bytes.length) continue;
    for (const c of collectionsOf(peer.CollectionConfigPackage.deserializeBinary(bytes))) out.set(`${cc}/${c.name}`, c);
  }
  return out;
}

export async function destinationDefinition(e: Endorser, name: string): Promise<Definition | undefined> {
  const args = new lc.QueryChaincodeDefinitionArgs();
  args.setName(name);
  const r = await e.query('_lifecycle', ['QueryChaincodeDefinition', Buffer.from(args.serializeBinary())]);
  if (r.status !== 200) {
    if (/not found|does not exist|namespace .* is not defined/i.test(r.message)) return undefined;
    throw new Error(`QueryChaincodeDefinition ${name}: ${r.status} ${r.message}`);
  }
  const d = lc.QueryChaincodeDefinitionResult.deserializeBinary(r.payload);
  return { name, sequence: Number(d.getSequence()), version: d.getVersion(), initRequired: d.getInitRequired(), endorsement: renderApplicationPolicy(d.getValidationParameter_asU8()), collections: collectionsOf(d.getCollections()) };
}

/** The collection config file `peer lifecycle --collections-config` reads, for this destination. */
export function destinationCollections(src: Collection[], provider: string | undefined): { json: object[]; notes: string[] } {
  const notes: string[] = [];
  const json = src.map((c) => {
    const o: Record<string, unknown> = { name: c.name, policy: provider ? `OR('${provider}.member')` : c.policy.text, requiredPeerCount: provider ? 0 : c.requiredPeerCount, maxPeerCount: c.maxPeerCount, blockToLive: c.blockToLive, memberOnlyRead: c.memberOnlyRead, memberOnlyWrite: c.memberOnlyWrite };
    if (provider) {
      notes.push(`${c.name}: member policy ${c.policy.text} → OR('${provider}.member') (only the platform org has peers here)${c.requiredPeerCount ? `; requiredPeerCount ${c.requiredPeerCount} → 0 (one peer cannot disseminate to another)` : ''}`);
      if (c.endorsement && c.endorsement.kind !== 'none') notes.push(`${c.name}: collection endorsement policy ${c.endorsement.text} dropped (the chaincode's applies)`);
    } else if (c.endorsement?.kind === 'signature') o.endorsementPolicy = { signaturePolicy: c.endorsement.text };
    else if (c.endorsement?.kind === 'reference') o.endorsementPolicy = { channelConfigPolicy: c.endorsement.text };
    return o;
  });
  return { json, notes };
}

export interface ChaincodeReport {
  name: string;
  source: Definition;
  destination?: Definition;
  state: 'ready' | 'needs-commit' | 'problem';
  contractAnswers: boolean | 'not-checked';
  issues: string[];
  notes: string[];
  commands: string[];
  collectionsFile?: string;
}

export async function chaincodeCheck(archive: Archive, dst: Destination, e: Endorser, opts: { writeCollections?: string; log: (s: string) => void }): Promise<{ channel: string; chaincodes: ChaincodeReport[]; installed: string[] | string }> {
  const src = sourceDefinitions(archive);
  const provider = dst.ld.d.profile === 'provider' ? dst.ld.d.platform!.msp : undefined;
  const { config } = await liveConfig(dst);
  const orgs = new Set(appOrgs(config));
  const channel = dst.channel;

  // Installed packages need the peer's admin; report rather than fail.
  let installed: string[] | string;
  try {
    const ie = new Endorser(e.endpoint, '', e.identity);
    const r = await ie.query('_lifecycle', ['QueryInstalledChaincodes', Buffer.from(new lc.QueryInstalledChaincodesArgs().serializeBinary())]);
    ie.close();
    installed = r.status === 200 ? lc.QueryInstalledChaincodesResult.deserializeBinary(r.payload).getInstalledChaincodesList().map((c) => `${c.getPackageId()}`) : `not listed: ${r.message.slice(0, 120)}`;
  } catch (err) { installed = `not listed: ${(err as Error).message.slice(0, 120)}`; }

  const out: ChaincodeReport[] = [];
  for (const s of [...src.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const d = await destinationDefinition(e, s.name);
    const issues: string[] = [], notes: string[] = [];
    const policyIssues = (where: string, p: Policy): void => {
      if (p.kind !== 'signature') return;
      for (const m of p.msps) if (!orgs.has(m)) issues.push(`${where} names ${m}, which is not an org of the channel`);
      if (provider && !p.msps.includes(provider)) issues.push(`${where} (${p.text}) does not name ${provider}: no peer here can satisfy it`);
    };
    let state: ChaincodeReport['state'];
    let contractAnswers: ChaincodeReport['contractAnswers'] = 'not-checked';
    if (!d) { state = 'problem'; issues.push('no committed definition on the destination (the archive\'s lifecycle writes did not replay?)'); }
    else if (d.sequence <= s.sequence) {
      state = 'needs-commit';
      if (d.sequence < s.sequence) issues.push(`destination sequence ${d.sequence} is behind the source's ${s.sequence}: the archive is not fully replayed`);
    } else {
      // Upgraded: the definition must keep every source collection, and its policies must work here.
      for (const c of s.collections) if (!d.collections.some((x) => x.name === c.name)) issues.push(`collection ${c.name} is missing from the destination definition: its private data would be unreachable`);
      for (const c of d.collections) {
        policyIssues(`collection ${c.name} member policy`, c.policy);
        const sc = s.collections.find((x) => x.name === c.name);
        if (sc && sc.blockToLive !== c.blockToLive) notes.push(`collection ${c.name}: blockToLive ${sc.blockToLive} at the source, ${c.blockToLive} here`);
        if (c.endorsement) policyIssues(`collection ${c.name} endorsement policy`, c.endorsement);
      }
      policyIssues('endorsement policy', d.endorsement);
      const r = await e.query(s.name, ['MigrationContract:ListKeys', '1', '']);
      contractAnswers = r.status === 200;
      if (!contractAnswers) {
        const why = /could not launch|connection refused|not installed|no such host|chaincode .* not found/i.test(r.message) ? 'the chaincode does not run on this peer (package not installed for this definition, or its CCaaS server is down)'
          : /function|contract/i.test(r.message) ? 'the package does not include the migration contract' : 'the migration contract does not answer';
        issues.push(`${why}: ${r.status} ${r.message.replace(/^error in simulation: failed to execute transaction \w+: /, '').slice(0, 160)}`);
      }
      state = issues.length ? 'problem' : 'ready';
    }

    // What to run when it still needs the commit.
    const commands: string[] = [];
    let collectionsFile: string | undefined;
    if (state === 'needs-commit') {
      const next = (d?.sequence ?? s.sequence) + 1;
      const cc = destinationCollections(s.collections, provider);
      notes.push(...cc.notes);
      if (s.collections.length) {
        collectionsFile = path.join(opts.writeCollections ?? '.', `${channel}-${s.name}-collections.json`);
        if (opts.writeCollections) { fs.mkdirSync(opts.writeCollections, { recursive: true }); fs.writeFileSync(collectionsFile, JSON.stringify(cc.json, null, 2) + '\n'); }
      }
      let pol = '';
      if (s.endorsement.kind === 'signature') {
        if (provider) notes.push(`endorsement policy ${s.endorsement.text} dropped: the default (/Channel/Application/Endorsement, ANY after tip config) applies`);
        else pol = ` --signature-policy "${s.endorsement.text}"`;
      } else if (s.endorsement.kind === 'reference' && s.endorsement.text !== '/Channel/Application/Endorsement') pol = ` --channel-config-policy ${s.endorsement.text}`;
      const common_ = `-C ${channel} -n ${s.name} -v ${s.version || '1.0'} --sequence ${next}${s.initRequired ? ' --init-required' : ''}${pol}${collectionsFile ? ` --collections-config ${collectionsFile}` : ''}`;
      // Which installed package holds the migration contract cannot be told from its label: list candidates only.
      const cands = Array.isArray(installed) ? installed.filter((p) => p.startsWith(s.name)) : [];
      if (cands.length) notes.push(`installed packages named like ${s.name}: ${cands.join(', ')}; use one only if it holds the migration contract (the source's own package does not)`);
      commands.push(`peer lifecycle chaincode approveformyorg $ORDERER_ARGS ${common_} --package-id <PACKAGE_ID of a package with the migration contract> --waitForEvent`);
      commands.push(`peer lifecycle chaincode commit $ORDERER_ARGS ${common_} --peerAddresses <peer> --tlsRootCertFiles <peer tls ca> --waitForEvent`);
      if (!provider) notes.push('self-managed: every org the LifecycleEndorsement policy needs must approve before the commit');
    }
    out.push({ name: s.name, source: s, destination: d, state, contractAnswers, issues, notes, commands, collectionsFile });
  }
  return { channel, chaincodes: out, installed };
}
