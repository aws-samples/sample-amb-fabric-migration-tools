/**
 * `plan`: everything computable from the archive and the descriptor (design §8), before anything is sent.
 *   - archive integrity (digests, data hashes, hash chain)
 *   - block survey: sizes against the destination's BatchSize (a block the destination would cut early is a split)
 *   - signer certificates that will have expired (the stock orderer refuses them at ingress, F1)
 *   - the whole config chain, simulated offline: for each source config block, what changes and who must sign
 *   - provider alignment: the platform's own leading blocks must stand in for source config blocks
 *   - a duration estimate
 * Findings are `blocking` (run would fail or diverge) or `note`. Exit 2 if any is blocking.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Archive } from '../archive/reader';
import { Destination } from '../destination';
import { chainStart } from './start';
import { appOrgs } from '../config/chain';
import { ConfigJson } from '../config/configtxlator';
import { configStep } from '../config/step';
import { durationMs } from '../util/misc';

export interface Finding { level: 'blocking' | 'note'; id: string; message: string }
export interface Plan {
  schema: 1;
  channel: string;
  profile: string;
  mode: string;
  batchTimeout: string;
  archive: { blocks: number; configBlocks: number[]; txBlocks: number; transactions: number; manifest: boolean; verified: boolean; validationCodes: Record<string, number> };
  survey: { maxTxPerBlock: number; maxTxBlock: number; maxBatchBytes: number; maxMultiTxBatchBytes: number; maxEnvelopeBytes: number; largestBlockBytes: number };
  signers: { creators: Record<string, number>; earliestExpiry?: string; expiredAt: { date: string; count: number } };
  destination: { reachable: boolean; height?: number; startsAt: number; batchSize?: ConfigJson; orderers?: { address: string; height?: number; error?: string }[] };
  configChain: { sourceBlock: number; changed: string[]; signers: string[] }[];
  estimate: { seconds: number; basis: string };
  findings: Finding[];
}

export interface PlanOptions { verify: boolean; at?: string; /** self-managed, no destination yet: build the start from the template */ offline?: boolean; log: (s: string) => void }

export async function plan(archive: Archive, dst: Destination, opts: PlanOptions): Promise<Plan> {
  const { ld, channel, ctl } = dst;
  const findings: Finding[] = [];
  const add = (level: Finding['level'], id: string, message: string): void => { findings.push({ level, id, message }); };
  for (const w of archive.warnings) add('note', 'archive-layout', w);
  if (archive.channel !== channel) add('blocking', 'channel-name', `archive channel "${archive.channel}" ≠ destination channel "${channel}" (names are signed into every envelope)`);

  let verified = false;
  if (opts.verify) {
    opts.log(`verifying ${archive.height} blocks (digests, data hashes, hash chain) ...`);
    archive.verify();
    verified = true;
  }

  // ── survey ──
  const at = opts.at ? new Date(opts.at) : new Date();
  const configBlocks: number[] = [];
  const codes: Record<string, number> = {}, creators: Record<string, number> = {};
  let tx = 0, maxTx = 0, maxTxBlock = 0, maxBatch = 0, maxMulti = 0, maxEnv = 0, maxBytes = 0, expired = 0;
  let earliest: string | undefined;
  for (let n = 0; n < archive.height; n++) {
    const raw = archive.raw(n);
    const b = archive.block(n);
    maxBytes = Math.max(maxBytes, raw.length);
    if (b.isConfig) { configBlocks.push(n); continue; }
    tx += b.txs.length;
    if (b.txs.length > maxTx) { maxTx = b.txs.length; maxTxBlock = n; }
    const sizes = b.txs.map((t) => t.cutterBytes), sum = sizes.reduce((a, c) => a + c, 0);
    maxBatch = Math.max(maxBatch, sum);
    if (sizes.length > 1) maxMulti = Math.max(maxMulti, sum);
    maxEnv = Math.max(maxEnv, ...sizes);
    for (const t of b.txs) {
      if (t.code) codes[t.code] = (codes[t.code] ?? 0) + 1;
      creators[t.mspId] = (creators[t.mspId] ?? 0) + 1;
      if (t.notAfter) {
        if (!earliest || t.notAfter < earliest) earliest = t.notAfter;
        if (new Date(t.notAfter) < at) expired++;
      }
    }
  }
  if (expired) add('blocking', 'E6-expired-signers', `${expired} transactions were signed by certificates expired by ${at.toISOString().slice(0, 10)}; a stock orderer refuses them. Needs the expiry-bypass orderer option (design §4.1) or state replay`);

  // ── destination and the config chain ──
  const cs = await chainStart(archive, dst, !!opts.offline);
  const { start, startsAt, height } = cs;
  const reachable = !opts.offline;
  let orderers: { address: string; height?: number; error?: string }[] | undefined;
  if (!opts.offline) {
    orderers = await dst.orderer.heights();
    const down = orderers.filter((o) => o.error);
    if (down.length) add('note', 'orderer-unreachable', `${down.length} of ${orderers.length} orderers do not answer (${down.map((o) => `${o.address}: ${o.error}`).join('; ')}): run would fail over away from them`);
    const top = Math.max(...orderers.filter((o) => o.height !== undefined).map((o) => o.height!));
    const behind = orderers.filter((o) => o.height !== undefined && o.height < top);
    if (behind.length) add('note', 'orderer-behind', `${behind.map((o) => `${o.address} at ${o.height}`).join(', ')} behind the newest height ${top} (fine if it is catching up)`);
    if (orderers.length === 1) add('note', 'one-orderer', 'one orderer endpoint: a failed send can only wait for it to come back. List every node of the ordering service in orderer.endpoints');
  }
  if (opts.offline) add('note', 'offline', 'destination not contacted: the chain starts from the genesis `genesis` would write');
  else {
    if (cs.started && height! > 1) add('note', 'resume', `the destination is at height ${height} with source orgs already in it: \`run\` would resume there`);
    if (!cs.started && ld.d.profile === 'provider') {
      const bad = Array.from({ length: Math.min(height!, archive.height) }, (_, i) => i).find((i) => !configBlocks.includes(i));
      if (bad !== undefined) add('blocking', 'E2-alignment', `the platform channel starts at height ${height}, but source block ${bad} is a transaction block: blocks cannot line up. The archive needs ≥ ${height} leading config blocks`);
    }
    if (height! > archive.height) add('blocking', 'destination-ahead', `the destination (height ${height}) is beyond the archive (${archive.height} blocks)`);
  }

  const chain: Plan['configChain'] = [];
  const ceremony = new Set<string>();
  let cur = start;
  for (const n of configBlocks.filter((x) => x >= startsAt)) {
    const step = configStep(ctl, ld, channel, cur, archive.raw(n), n);
    if (step.empty) { add('blocking', 'empty-config-step', `source config block ${n} changes nothing the destination keeps: no block would be made for it`); continue; }
    for (const m of step.signers) {
      if (!(m in ld.d.orgs) && m !== ld.d.platform?.msp && m !== ld.d.ordererOrg?.msp) add('blocking', 'signer-missing', `config block ${n} needs ${m}'s signature, and the descriptor has no key for it`);
      else if (ld.d.orgs[m]?.signer.mode === 'ceremony') ceremony.add(m);
    }
    chain.push({ sourceBlock: n, changed: step.changed, signers: step.signers });
    cur = step.next;
  }
  if (ceremony.size) add('note', 'ceremony', `${[...ceremony].join(', ')} sign by ceremony: \`sign-config export\`, each member \`sign-config sign\`, then \`run --bundle\``);
  for (const m of new Set(configBlocks.flatMap((n) => appOrgs(ctl.blockConfig(archive.raw(n)))))) {
    if (!(m in ld.d.orgs)) add('blocking', 'org-missing', `source org ${m} has no entry under "orgs" in the descriptor`);
  }

  // ── batch preflight: the destination must never cut a block earlier than the source did ──
  const bs = cur.channel_group.groups.Orderer.values.BatchSize.value;
  const bt = cur.channel_group.groups.Orderer.values.BatchTimeout.value.timeout;
  for (const [name, need, have] of [
    ['MaxMessageCount', maxTx, Number(bs.max_message_count)],
    ['PreferredMaxBytes (blocks of 2+ transactions)', maxMulti, Number(bs.preferred_max_bytes)],
    ['AbsoluteMaxBytes (largest envelope)', maxEnv, Number(bs.absolute_max_bytes)],
  ] as [string, number, number][]) {
    if (have < need) add('blocking', 'E6-batch-size', `destination BatchSize ${name} is ${have}, the archive needs ${need}: blocks would split. Raise it in ordererOverrides`);
  }
  if (bt !== ld.d.orderer.batchTimeout) add('blocking', 'batch-timeout', `the destination's BatchTimeout after the first update would be ${bt}, the descriptor paces at ${ld.d.orderer.batchTimeout}: set ordererOverrides.BatchTimeout`);
  if (ld.d.orderer.mode === 'timeout' && durationMs(ld.d.orderer.batchTimeout) < 500) add('note', 'batch-timeout-low', 'below 500 ms in timeout mode: a block whose envelopes take longer than BatchTimeout to arrive splits. Measure delivery first (`probe`, design §8)');

  const txBlocks = archive.height - configBlocks.length;
  const btMs = durationMs(ld.d.orderer.batchTimeout);
  const perBlock = ld.d.orderer.mode === 'cut-markers' ? 60 : btMs + 250;
  const seconds = Math.round(((archive.height - startsAt - chain.length) * perBlock + chain.length * 2000) / 1000);
  const p: Plan = {
    schema: 1, channel, profile: ld.d.profile, mode: ld.d.orderer.mode, batchTimeout: ld.d.orderer.batchTimeout,
    archive: { blocks: archive.height, configBlocks, txBlocks, transactions: tx, manifest: !!archive.manifest, verified, validationCodes: codes },
    survey: { maxTxPerBlock: maxTx, maxTxBlock, maxBatchBytes: maxBatch, maxMultiTxBatchBytes: maxMulti, maxEnvelopeBytes: maxEnv, largestBlockBytes: maxBytes },
    signers: { creators, earliestExpiry: earliest, expiredAt: { date: at.toISOString(), count: expired } },
    destination: { reachable, height, startsAt, batchSize: bs, orderers },
    configChain: chain,
    estimate: { seconds, basis: `${ld.d.orderer.mode === 'cut-markers' ? '~60 ms' : `BatchTimeout + 250 ms`} per transaction block, 2 s per config block` },
    findings,
  };
  const dir = path.join(ld.workDir, 'plan');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${channel}.json`), JSON.stringify(p, null, 2));
  return p;
}
