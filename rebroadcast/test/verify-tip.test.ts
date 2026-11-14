import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { common, ledger, peer } from '@hyperledger/fabric-protos';
import { Archive } from '../src/archive/reader';
import { headerHash } from '../src/fabric/blocks';
import { rebuildFacts, Facts } from '../src/verify/facts';
import { verify, loadPrivate, privateInputMembers } from '../src/verify/verify';
import { Endorser, QueryResult } from '../src/fabric/endorser';
import { tipTarget } from '../src/tip/tip';
import { envelope, writeArchive } from './helpers';

const sha = (b: Buffer | string): Buffer<ArrayBufferLike> => crypto.createHash('sha256').update(b).digest();
type W = { key: string; value?: string; del?: boolean };
type HW = { coll: string; key: string; value?: string; del?: boolean };

/** Transaction bytes whose single action writes `ws` (and hashed writes `hs`) in namespace `ns`. */
function txData(ns: string, ws: W[], hs: HW[] = []): Buffer {
  const kv = new ledger.rwset.kvrwset.KVRWSet();
  kv.setWritesList(ws.map((w) => { const x = new ledger.rwset.kvrwset.KVWrite(); x.setKey(w.key); x.setIsDelete(!!w.del); x.setValue(Buffer.from(w.value ?? '')); return x; }));
  const nsr = new ledger.rwset.NsReadWriteSet();
  nsr.setNamespace(ns);
  nsr.setRwset(kv.serializeBinary());
  const byColl = new Map<string, HW[]>();
  for (const h of hs) byColl.set(h.coll, [...(byColl.get(h.coll) ?? []), h]);
  nsr.setCollectionHashedRwsetList([...byColl].map(([c, list]) => {
    const hr = new ledger.rwset.kvrwset.HashedRWSet();
    hr.setHashedWritesList(list.map((h) => { const x = new ledger.rwset.kvrwset.KVWriteHash(); x.setKeyHash(sha(h.key)); x.setIsDelete(!!h.del); if (!h.del) x.setValueHash(sha(h.value ?? '')); return x; }));
    const ch = new ledger.rwset.CollectionHashedReadWriteSet();
    ch.setCollectionName(c);
    ch.setHashedRwset(hr.serializeBinary());
    return ch;
  }));
  const rw = new ledger.rwset.TxReadWriteSet();
  rw.setNsRwsetList([nsr]);
  const ca = new peer.ChaincodeAction();
  ca.setResults(rw.serializeBinary());
  const prp = new peer.ProposalResponsePayload();
  prp.setExtension$(ca.serializeBinary());
  const cea = new peer.ChaincodeEndorsedAction();
  cea.setProposalResponsePayload(prp.serializeBinary());
  const cap = new peer.ChaincodeActionPayload();
  cap.setAction(cea);
  const ta = new peer.TransactionAction();
  ta.setPayload(cap.serializeBinary());
  const tx = new peer.Transaction();
  tx.setActionsList([ta]);
  return Buffer.from(tx.serializeBinary());
}

function blocks(channel: string, txs: { data: Buffer; code: number }[][]): Buffer[] {
  const out: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(0);
  const all = [[{ env: envelope(channel, '', common.HeaderType.CONFIG), code: 0 }], ...txs.map((b, n) => b.map((t, i) => ({ env: envelope(channel, `tx-${n}-${i}`, common.HeaderType.ENDORSER_TRANSACTION, Buffer.from(t.data)), code: t.code })))];
  all.forEach((b, n) => {
    const envs = b.map((x) => x.env);
    const dh = sha(Buffer.concat(envs));
    const hdr = new common.BlockHeader(); hdr.setNumber(n); hdr.setPreviousHash(prev); hdr.setDataHash(dh);
    const data = new common.BlockData(); data.setDataList(envs);
    const md = new common.BlockMetadata(); md.setMetadataList([Buffer.alloc(0), Buffer.alloc(0), Buffer.from(b.map((x) => x.code)), Buffer.alloc(0), Buffer.alloc(0)]);
    const blk = new common.Block(); blk.setHeader(hdr); blk.setData(data); blk.setMetadata(md);
    out.push(Buffer.from(blk.serializeBinary()));
    prev = Buffer.from(headerHash(n, prev, dh), 'hex');
  });
  return out;
}

const VALID = peer.TxValidationCode.VALID, MVCC = peer.TxValidationCode.MVCC_READ_CONFLICT;

function archiveWith(txs: { data: Buffer; code: number }[][]): { a: Archive; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-verify-'));
  writeArchive(tmp, 'ch1', blocks('ch1', txs));
  return { a: new Archive(tmp, 'ch1'), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

const SOURCE = [
  [{ data: txData('cc', [{ key: 'a', value: '1' }, { key: 'b', value: '1' }], [{ coll: 'c1', key: 'p1', value: 'secret' }]), code: VALID }],
  [{ data: txData('cc', [{ key: 'a', value: '2' }]), code: VALID }, { data: txData('cc', [{ key: 'z', value: 'never' }]), code: MVCC }],
  [{ data: txData('cc', [{ key: 'b', del: true }, { key: 'comp\u0000x\u0000', value: 'i' }], [{ coll: 'c1', key: 'gone', value: 'v' }]), code: VALID }],
  [{ data: txData('cc', [], [{ coll: 'c1', key: 'gone', del: true }]), code: VALID }],
];

describe('facts rebuilt from blocks', () => {
  it('applies only VALID transactions, in order, with deletes and private hashes', () => {
    const { a, cleanup } = archiveWith(SOURCE);
    try {
      const f = rebuildFacts(a);
      expect(f.validTxs).toBe(4);
      expect(f.skippedTxs).toBe(1);
      const st = f.state.get('cc')!;
      expect(st.get('a')!.value.toString()).toBe('2');
      expect(st.get('b')!.isDelete).toBe(true);
      expect(st.has('z')).toBe(false);
      expect(f.history.get('cc')!.get('a')!.map((v) => v.value.toString())).toEqual(['1', '2']);
      const ph = f.privateHashes.get('cc/c1')!;
      expect([...ph.keys()]).toEqual([sha('p1').toString('hex')]);
      expect(ph.get(sha('p1').toString('hex'))).toBe(sha('secret').toString('hex'));
    } finally { cleanup(); }
  });

  it('refuses orderer blocks (no validation codes)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-verify-'));
    try {
      const bs = blocks('ch1', [[{ data: txData('cc', [{ key: 'a', value: '1' }]), code: VALID }]]).map((b) => {
        const blk = common.Block.deserializeBinary(b);
        const md = blk.getMetadata()!; const l = md.getMetadataList_asU8(); l[2] = new Uint8Array(); md.setMetadataList(l);
        return Buffer.from(blk.serializeBinary());
      });
      writeArchive(tmp, 'ch1', bs);
      expect(() => rebuildFacts(new Archive(tmp, 'ch1'))).toThrow(/no validation codes/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

/** A destination peer answering the migration contract from an in-memory ledger. */
function fakeEndorser(state: Record<string, string>, history: Record<string, { value: string; isDelete: boolean }[]>, priv: Record<string, string> = {}): Endorser {
  const ok = (s: string): QueryResult => ({ status: 200, message: '', payload: Buffer.from(s) });
  const nf = (m: string): QueryResult => ({ status: 500, message: m, payload: Buffer.alloc(0) });
  return {
    mspId: 'Plat',
    query: async (_cc: string, args: string[]) => {
      const [fn, x, y] = args as string[];
      if (fn === 'MigrationContract:ReadState') return x in state ? ok(Buffer.from(state[x]).toString('base64')) : nf(`key ${x} does not exist`);
      if (fn === 'MigrationContract:ListKeys') return ok(JSON.stringify({ keys: Object.keys(state).filter((k) => !k.includes('\u0000')).map((k) => Buffer.from(k).toString('base64')), bookmark: '' }));
      if (fn === 'MigrationContract:GetKeyHistory') return ok(JSON.stringify((history[x] ?? []).map((h) => ({ value: Buffer.from(h.value).toString('base64'), isDelete: h.isDelete })).reverse()));
      if (fn === 'MigrationContract:ReadPrivateDataHash') return `${x}/${y}` in priv ? ok(sha(priv[`${x}/${y}`]).toString('base64')) : nf('does not exist');
      if (fn === 'MigrationContract:ReadPrivateData') return `${x}/${y}` in priv ? ok(Buffer.from(priv[`${x}/${y}`]).toString('base64')) : nf('does not exist');
      return nf('unknown');
    },
    close: () => undefined,
  } as unknown as Endorser;
}

describe('verify', () => {
  let facts: Facts, cleanup: () => void;
  beforeAll(() => { const x = archiveWith(SOURCE); facts = rebuildFacts(x.a); cleanup = x.cleanup; });
  afterAll(() => cleanup());
  const hist = { a: [{ value: '1', isDelete: false }, { value: '2', isDelete: false }], b: [{ value: '1', isDelete: false }, { value: '', isDelete: true }], 'comp\u0000x\u0000': [{ value: 'i', isDelete: false }] };
  const opts = { channel: 'ch1', concurrency: 2, log: (): void => undefined };

  it('passes a faithful destination, history newest-first, private by hash and value', async () => {
    const r = await verify(facts, fakeEndorser({ a: '2', 'comp\u0000x\u0000': 'i' }, hist, { 'c1/p1': 'secret' }), { ...opts, priv: [{ chaincode: 'cc', collection: 'c1', key: 'p1', value: Buffer.from('secret') }] });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.state).toEqual({ live: 2, ok: 2, differ: 0, missing: 0, jsonNormalized: 0 });
    expect(r.deletes).toEqual({ total: 1, absent: 1, present: 0 });
    expect(r.history.order.newestFirst).toBe(2);
    expect(r.private).toMatchObject({ hashOk: 1, valueOk: 1, uncheckedLiveKeys: 0 });
  });

  it('accepts a JSON value a CouchDB peer re-serialised (keys sorted), and still names a different one', async () => {
    const v = (value: string) => ({ txId: 't', value: Buffer.from(value), isDelete: false });
    const json: Facts = {
      state: new Map([['cc', new Map([['j', v('{"round":2,"key":"j","pad":"x"}')], ['k', v('{"round":2,"key":"k"}')]])]]),
      history: new Map([['cc', new Map([['j', [v('{"round":2,"key":"j","pad":"x"}')]], ['k', [v('{"round":2,"key":"k"}')]]])]]),
      privateHashes: new Map(), privateWriteBlock: new Map(), lastBlock: 2, validTxs: 2, skippedTxs: 0,
    };
    const dest = fakeEndorser({ j: '{"key":"j","pad":"x","round":2}', k: '{"key":"k","round":3}' },
      { j: [{ value: '{"round":2,"key":"j","pad":"x"}', isDelete: false }], k: [{ value: '{"round":2,"key":"k"}', isDelete: false }] });
    const r = await verify(json, dest, opts);
    expect(r.state).toEqual({ live: 2, ok: 1, differ: 1, missing: 0, jsonNormalized: 1 });
    expect(r.failures.join('\n')).toMatch(/STATE cc\/"k"/);
  });

  it('names a wrong value, a resurrected delete, an extra key and a short history', async () => {
    const r = await verify(facts, fakeEndorser({ a: '3', b: '1', extra: 'x', 'comp\u0000x\u0000': 'i' }, { ...hist, a: [{ value: '2', isDelete: false }] }), opts);
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/STATE cc\/"a"/);
    expect(r.failures.join('\n')).toMatch(/DELETED-AT-SOURCE-BUT-PRESENT cc\/"b"/);
    expect(r.failures.join('\n')).toMatch(/EXTRA cc\/"extra"/);
    expect(r.failures.join('\n')).toMatch(/HISTORY cc\/"a": expected 2 versions, got 1/);
    expect(r.failures.join('\n')).not.toMatch(/"3"/); // values are hashed unless showValues
  });

  it('refuses private input that does not hash to the blocks', async () => {
    const r = await verify(facts, fakeEndorser({ a: '2', 'comp\u0000x\u0000': 'i' }, hist, { 'c1/p1': 'secret' }), { ...opts, priv: [{ chaincode: 'cc', collection: 'c1', key: 'p1', value: Buffer.from('tampered') }] });
    expect(r.ok).toBe(false);
    expect(r.private!.inputDisagrees).toBe(1);
  });

  describe('live private keys no input supplies', () => {
    const dest = (): Endorser => fakeEndorser({ a: '2', 'comp\u0000x\u0000': 'i' }, hist, { 'c1/p1': 'secret' });
    const c1 = (readers: string[], blockToLive = 0): Map<string, Collection> => new Map([['cc/c1', {
      name: 'c1', policy: { kind: 'signature', text: '', msps: readers }, requiredPeerCount: 0, maxPeerCount: 1, blockToLive, memberOnlyRead: true, memberOnlyWrite: false,
    }]]);

    it('fail the run, naming the collection, who can read it and the way out', async () => {
      const r = await verify(facts, dest(), { ...opts, collections: c1(['OrgB']) });
      expect(r.ok).toBe(false);
      expect(r.private).toMatchObject({ uncheckedLiveKeys: 1, uncheckedInScope: 1, members: 'all' });
      expect(r.failures.join('\n')).toMatch(/PRIVATE-UNCHECKED cc\/c1: 1 live key\(s\) have no value in --private \(readable by OrgB\)\. .*private-cc-c1-state\.ndjson.*--accept-unchecked cc\/c1/);
    });

    it('pass when the data owners accepted them, and say so', async () => {
      const r = await verify(facts, dest(), { ...opts, collections: c1(['OrgB']), acceptUnchecked: ['c1'] });
      expect(r.ok).toBe(true);
      expect(r.private).toMatchObject({ uncheckedLiveKeys: 1, uncheckedInScope: 0, accepted: ['cc/c1'] });
      expect((await verify(facts, dest(), { ...opts, acceptUnchecked: ['all'] })).ok).toBe(true);
    });

    it('are left to the members who can read them when this run is another member\'s', async () => {
      const r = await verify(facts, dest(), { ...opts, collections: c1(['OrgB']), members: { msps: ['OrgA'], all: false }, sourceOrgs: ['OrgA', 'OrgB'] });
      expect(r.ok).toBe(true);
      expect(r.private).toMatchObject({ members: ['OrgA'], uncheckedInScope: 0, toVerifyBy: { OrgB: ['cc/c1'] } });
      // Accepting loss in this run does not take another member's collection off its list.
      const all = await verify(facts, dest(), { ...opts, collections: c1(['OrgB']), members: { msps: ['OrgA'], all: false }, sourceOrgs: ['OrgA', 'OrgB'], acceptUnchecked: ['all'] });
      expect(all.private).toMatchObject({ accepted: [], toVerifyBy: { OrgB: ['cc/c1'] } });
    });

    it('fail a run through a source org\'s peer that reads the collection, even with no --private at all', async () => {
      const r = await verify(facts, dest(), { ...opts, collections: c1(['Plat']), sourceOrgs: ['Plat', 'OrgB'] });
      expect(r.ok).toBe(false);
      expect(r.private).toMatchObject({ members: ['Plat'], uncheckedInScope: 1 });
    });

    it('fail every collection for a merged input, which stands for every member', async () => {
      const r = await verify(facts, dest(), { ...opts, collections: c1(['OrgB']), members: { msps: [], all: true }, sourceOrgs: ['OrgA', 'OrgB'] });
      expect(r.private).toMatchObject({ members: 'all', uncheckedInScope: 1 });
    });

    it('are counted apart, not failed, once blockToLive purged them at the source', async () => {
      // p1 is written in block 1 of an archive whose last block is 4. Fabric purges it with the commit of block
      // 1 + blockToLive + 1: block 4 for blockToLive 2, block 5 (not yet) for 3.
      expect(facts.lastBlock).toBe(4);
      const purged = await verify(facts, dest(), { ...opts, collections: c1(['OrgB'], 2) });
      expect(purged.ok).toBe(true);
      expect(purged.private).toMatchObject({ expiredAtSource: 1, uncheckedLiveKeys: 0, perCollection: { 'cc/c1': expect.objectContaining({ expired: 1 }) } });
      const live = await verify(facts, dest(), { ...opts, collections: c1(['OrgB'], 3) });
      expect(live.private).toMatchObject({ expiredAtSource: 0, uncheckedInScope: 1 });
    });

    it('a member is recognised from its extraction\'s metadata.json; a merged directory stands for every member', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-members-'));
      try {
        for (const [m, meta] of [['a', { channelId: 'ch1', extractedByMspId: 'OrgA' }], ['b', { channelId: 'ch1', extractedByMspId: 'OrgB' }], ['other', { channelId: 'ch2', extractedByMspId: 'OrgC' }]] as const) {
          fs.mkdirSync(path.join(tmp, m, 'channel-x'), { recursive: true });
          fs.writeFileSync(path.join(tmp, m, 'channel-x', 'metadata.json'), JSON.stringify(meta));
        }
        expect(privateInputMembers(tmp, 'ch1')).toEqual({ msps: ['OrgA', 'OrgB'], all: false });
        fs.writeFileSync(path.join(tmp, 'a', 'channel-x', 'metadata.json'), JSON.stringify({ channelId: 'ch1' }));
        expect(privateInputMembers(path.join(tmp, 'a'), 'ch1')).toEqual({ msps: [], all: true });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  });

  it('reads extractor private-state files (literal UTF-8) and base64 ndjson', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-priv-'));
    try {
      fs.mkdirSync(path.join(tmp, 'channel-ch1'));
      fs.writeFileSync(path.join(tmp, 'channel-ch1', 'private-cc-c1-state.ndjson'), JSON.stringify({ _type: 'private_state', channel: 'ch1', chaincode: 'cc', collection: 'c1', key: 'p1', value: 'secret' }) + '\n');
      fs.writeFileSync(path.join(tmp, 'x.ndjson'), JSON.stringify({ chaincode: 'cc', collection: 'c1', key: 'p1', value: Buffer.from('secret').toString('base64') }) + '\n');
      expect(loadPrivate(tmp, 'ch1')[0].value.toString()).toBe('secret');
      expect(loadPrivate(path.join(tmp, 'x.ndjson'), 'ch1')[0].value.toString()).toBe('secret');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('tip config target', () => {
  const pol = (rule: string): object => ({ mod_policy: 'Admins', policy: { type: 3, value: { rule, sub_policy: 'X' } } });
  const original = { channel_group: { groups: { Application: { groups: { Plat: { v: 'plat' } }, policies: { Admins: pol('PLAT-ADMIN'), LifecycleEndorsement: pol('ANY'), Endorsement: pol('MAJORITY') } } } } };
  const cur = { channel_group: { groups: { Application: { groups: { SrcA: { v: 'a' } }, policies: { Admins: pol('MAJORITY'), LifecycleEndorsement: pol('MAJORITY'), Endorsement: pol('MAJORITY') } } } } };

  it('adds the platform org back, restores its Admins and LifecycleEndorsement, and sets Endorsement ANY', () => {
    const t = tipTarget(cur, original, 'Plat');
    const a = t.channel_group.groups.Application;
    expect(Object.keys(a.groups).sort()).toEqual(['Plat', 'SrcA']);
    expect(a.policies.Admins.policy.value.rule).toBe('PLAT-ADMIN');
    expect(a.policies.LifecycleEndorsement.policy.value.rule).toBe('ANY');
    expect(a.policies.Endorsement.policy.value).toEqual({ rule: 'ANY', sub_policy: 'Endorsement' });
    expect(cur.channel_group.groups.Application.groups).not.toHaveProperty('Plat'); // input untouched
  });

  it('refuses a platform MSP that block 0 does not have', () => {
    expect(() => tipTarget(cur, original, 'Other')).toThrow(/no Application org Other/);
  });
});

// ── tip chaincode-check / import-private ──
import { msp as mspPb } from '@hyperledger/fabric-protos';
import { renderSignaturePolicy, destinationCollections, sourceDefinitions, archiveCollections, Collection } from '../src/tip/chaincode';
import { frameBatch } from '../src/tip/import-private';

function sigEnv(principals: [string, number][], n: number): common.SignaturePolicyEnvelope {
  const env = new common.SignaturePolicyEnvelope();
  env.setIdentitiesList(principals.map(([m, role]) => {
    const r = new mspPb.MSPRole(); r.setMspIdentifier(m); r.setRole(role as mspPb.MSPRole.MSPRoleTypeMap[keyof mspPb.MSPRole.MSPRoleTypeMap]);
    const p = new mspPb.MSPPrincipal(); p.setPrincipalClassification(mspPb.MSPPrincipal.Classification.ROLE); p.setPrincipal(r.serializeBinary());
    return p;
  }));
  const rule = new common.SignaturePolicy();
  const nof = new common.SignaturePolicy.NOutOf();
  nof.setN(n);
  nof.setRulesList(principals.map((_, i) => { const s = new common.SignaturePolicy(); s.setSignedBy(i); return s; }));
  rule.setNOutOf(nof);
  env.setRule(rule);
  return env;
}

describe('chaincode-check pieces', () => {
  it('renders signature policies as the peer CLI writes them', () => {
    expect(renderSignaturePolicy(sigEnv([['A', 0], ['B', 3]], 1))).toEqual({ kind: 'signature', text: "OR('A.member', 'B.peer')", msps: ['A', 'B'] });
    expect(renderSignaturePolicy(sigEnv([['A', 0], ['B', 0]], 2)).text).toBe("AND('A.member', 'B.member')");
    expect(renderSignaturePolicy(sigEnv([['A', 1], ['B', 0], ['C', 0]], 2)).text).toBe("OutOf(2, 'A.admin', 'B.member', 'C.member')");
  });

  const coll: Collection = { name: 'c1', policy: { kind: 'signature', text: "OR('A.member', 'B.member')", msps: ['A', 'B'] }, requiredPeerCount: 1, maxPeerCount: 3, blockToLive: 10, memberOnlyRead: true, memberOnlyWrite: false, endorsement: { kind: 'signature', text: "OR('A.peer')", msps: ['A'] } };

  it('rewrites collections for a provider: the platform org holds them, no dissemination, no collection endorsement policy', () => {
    const { json, notes } = destinationCollections([coll], 'Plat');
    expect(json).toEqual([{ name: 'c1', policy: "OR('Plat.member')", requiredPeerCount: 0, maxPeerCount: 3, blockToLive: 10, memberOnlyRead: true, memberOnlyWrite: false }]);
    expect(notes.join('\n')).toMatch(/requiredPeerCount 1 → 0/);
    expect(notes.join('\n')).toMatch(/endorsement policy OR\('A.peer'\) dropped/);
  });

  it('keeps collections as they were for a self-managed destination (same MSP IDs)', () => {
    const { json } = destinationCollections([coll], undefined);
    expect(json[0]).toMatchObject({ policy: "OR('A.member', 'B.member')", requiredPeerCount: 1, endorsementPolicy: { signaturePolicy: "OR('A.peer')" } });
  });

  it('rebuilds the source definition from VALID _lifecycle writes only', () => {
    const sd = (f: (s: peer.lifecycle.StateData) => void): string => { const s = new peer.lifecycle.StateData(); f(s); return Buffer.from(s.serializeBinary()).toString('latin1'); };
    const ei = new peer.lifecycle.ChaincodeEndorsementInfo(); ei.setVersion('2.1'); ei.setInitRequired(true);
    const cfg = new peer.StaticCollectionConfig(); cfg.setName('c1'); cfg.setBlockToLive(5);
    const pol = new peer.CollectionPolicyConfig(); pol.setSignaturePolicy(sigEnv([['A', 0]], 1)); cfg.setMemberOrgsPolicy(pol);
    const cc = new peer.CollectionConfig(); cc.setStaticCollectionConfig(cfg);
    const pkg = new peer.CollectionConfigPackage(); pkg.setConfigList([cc]);
    const w = (k: string, v: string): W => ({ key: `namespaces/fields/cc1/${k}`, value: v });
    // KVWrite values are strings in the helper; carry raw bytes through latin1.
    const life = (ws: W[]): Buffer => {
      const kv = new ledger.rwset.kvrwset.KVRWSet();
      kv.setWritesList(ws.map((x) => { const y = new ledger.rwset.kvrwset.KVWrite(); y.setKey(x.key); y.setValue(Buffer.from(x.value!, 'latin1')); return y; }));
      const nsr = new ledger.rwset.NsReadWriteSet(); nsr.setNamespace('_lifecycle'); nsr.setRwset(kv.serializeBinary());
      const rw = new ledger.rwset.TxReadWriteSet(); rw.setNsRwsetList([nsr]);
      const ca = new peer.ChaincodeAction(); ca.setResults(rw.serializeBinary());
      const prp = new peer.ProposalResponsePayload(); prp.setExtension$(ca.serializeBinary());
      const cea = new peer.ChaincodeEndorsedAction(); cea.setProposalResponsePayload(prp.serializeBinary());
      const cap = new peer.ChaincodeActionPayload(); cap.setAction(cea);
      const ta = new peer.TransactionAction(); ta.setPayload(cap.serializeBinary());
      const tx = new peer.Transaction(); tx.setActionsList([ta]);
      return Buffer.from(tx.serializeBinary());
    };
    const { a, cleanup } = archiveWith([
      [{ data: life([w('Sequence', sd((s) => s.setInt64(1))), w('EndorsementInfo', sd((s) => s.setBytes(ei.serializeBinary()))), w('Collections', sd((s) => s.setBytes(pkg.serializeBinary())))]), code: VALID }],
      [{ data: life([w('Sequence', sd((s) => s.setInt64(7)))]), code: MVCC }],
    ]);
    try {
      const d = sourceDefinitions(a).get('cc1')!;
      expect(d).toMatchObject({ sequence: 1, version: '2.1', initRequired: true, block: 1 });
      expect(d.collections).toEqual([expect.objectContaining({ name: 'c1', blockToLive: 5, policy: expect.objectContaining({ text: "OR('A.member')" }) })]);
    } finally { cleanup(); }
  });

  it('reads collections committed through legacy lscc (AMB 1.4 sources) as well as _lifecycle', () => {
    const cfg = new peer.StaticCollectionConfig(); cfg.setName('c9'); cfg.setBlockToLive(7);
    const pol = new peer.CollectionPolicyConfig(); pol.setSignaturePolicy(sigEnv([['A', 0], ['B', 0]], 1)); cfg.setMemberOrgsPolicy(pol);
    const cc = new peer.CollectionConfig(); cc.setStaticCollectionConfig(cfg);
    const pkg = new peer.CollectionConfigPackage(); pkg.setConfigList([cc]);
    const kv = new ledger.rwset.kvrwset.KVRWSet();
    const w = new ledger.rwset.kvrwset.KVWrite(); w.setKey('old~collection'); w.setValue(pkg.serializeBinary()); kv.setWritesList([w]);
    const nsr = new ledger.rwset.NsReadWriteSet(); nsr.setNamespace('lscc'); nsr.setRwset(kv.serializeBinary());
    const rw = new ledger.rwset.TxReadWriteSet(); rw.setNsRwsetList([nsr]);
    const ca = new peer.ChaincodeAction(); ca.setResults(rw.serializeBinary());
    const prp = new peer.ProposalResponsePayload(); prp.setExtension$(ca.serializeBinary());
    const cea = new peer.ChaincodeEndorsedAction(); cea.setProposalResponsePayload(prp.serializeBinary());
    const cap = new peer.ChaincodeActionPayload(); cap.setAction(cea);
    const ta = new peer.TransactionAction(); ta.setPayload(cap.serializeBinary());
    const tx = new peer.Transaction(); tx.setActionsList([ta]);
    const { a, cleanup } = archiveWith([[{ data: Buffer.from(tx.serializeBinary()), code: VALID }]]);
    try {
      expect(archiveCollections(a).get('old/c9')).toMatchObject({ blockToLive: 7, policy: { msps: ['A', 'B'] } });
    } finally { cleanup(); }
  });

  it('frames a private batch exactly as the migration contract parses it', () => {
    expect(frameBatch([{ key: 'a', value: Buffer.from('xy') }, { key: 'bc', value: Buffer.alloc(0) }]).toString('hex'))
      .toBe('00000002' + '00000001' + '61' + '00' + '00000002' + '7879' + '00000002' + '6263' + '00' + '00000000');
  });
});
