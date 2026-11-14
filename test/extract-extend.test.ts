import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChannelInfo, ExtractOptions, Manifest, MigrationTier } from '../src/types';
import { HybridExtractor, PrivateDataDeliveryFn } from '../src/extraction/strategies/hybrid-extractor';
import { EXTEND_JOURNAL, recoverExtension } from '../src/extraction/extension';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { ADMIN_CERT_PEM } from './helpers/test-certs';
import { encodeBlock, sealBlock } from './helpers/protobuf-block';

// `extract --extend`: an extraction taken at one height and extended to a
// later one must hold exactly what a fresh extraction at the later height holds.

// ── Hash-linked ledger (header hashing mirrors block-walker) ──

function lp(tag: number, n: number): Buffer {
  if (n < 128) return Buffer.from([tag, n]);
  if (n < 256) return Buffer.from([tag, 0x81, n]);
  return Buffer.from([tag, 0x82, (n >> 8) & 0xff, n & 0xff]);
}
function int(v: number): Buffer {
  if (v === 0) return Buffer.from([0x02, 0x01, 0x00]);
  const h = v.toString(16);
  let b = Buffer.from(h.length % 2 ? '0' + h : h, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([lp(0x02, b.length), b]);
}
function oct(d: Buffer): Buffer {
  return Buffer.concat([lp(0x04, d.length), d]);
}
function headerHash(n: number, prev: string, data: string): string {
  const body = Buffer.concat([int(n), oct(Buffer.from(prev, 'hex')), oct(Buffer.from(data, 'hex'))]);
  return crypto.createHash('sha256').update(Buffer.concat([lp(0x30, body.length), body])).digest('hex');
}

interface W { key: string; value?: string; del?: boolean }
interface BlockSpec { pub: W[]; priv: W[] }

/** When set, this block deletes every public and private key written before it. */
let deleteAllAt: number | undefined;

/** Writes of block i: public keys overwritten and deleted, private keys likewise, one signer per block parity. */
function specOf(i: number): BlockSpec {
  if (i === 0) return { pub: [], priv: [] };
  if (i === deleteAllAt) {
    const pub: W[] = [0, 1, 2, 3].map((k) => ({ key: `k${k}`, del: true }));
    for (let j = 1; j < i; j++) pub.push({ key: `n${j}`, del: true });
    return { pub, priv: [0, 1, 2].map((k) => ({ key: `p${k}`, del: true })) };
  }
  const pub: W[] = [{ key: `k${i % 4}`, value: `v${i}` }, { key: `n${i}`, value: `once${i}` }];
  if (i === 9) pub.push({ key: 'k1', del: true });
  if (i === 11) pub.push({ key: 'n2', del: true });
  const priv: W[] = [{ key: `p${i % 3}`, value: `pv${i}` }];
  if (i === 10) priv.push({ key: 'p0', del: true });
  return { pub, priv };
}

function makeBlock(i: number, prev: string, salt = ''): any {
  const { pub, priv } = specOf(i);
  const hashed = priv.map((w) => ({
    key_hash: crypto.createHash('sha256').update(w.key).digest(),
    value_hash: crypto.createHash('sha256').update(w.value ?? '').digest(),
    is_delete: w.del ?? false,
  }));
  return sealBlock({
    header: { number: String(i), previous_hash: prev, data_hash: '' },
    data: {
      data: pub.length === 0 ? [] : [{
        payload: {
          header: {
            // The salt makes another chain: different transactions, so different data hashes
            channel_header: { tx_id: `tx-${i}${salt}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` },
            signature_header: { creator: { mspid: i % 2 ? 'Org1MSP' : 'Org2MSP', id_bytes: ADMIN_CERT_PEM } },
          },
          data: {
            actions: [{
              payload: {
                chaincode_proposal_payload: { input: { chaincode_spec: { chaincode_id: { name: 'mycc' } } } },
                action: {
                  proposal_response_payload: {
                    extension: {
                      results: {
                        ns_rwset: [{
                          namespace: 'mycc',
                          rwset: { writes: pub.map((w) => ({ key: w.key, value: w.value ?? '', is_delete: w.del ?? false })) },
                          collection_hashed_rwset: [{ collection_name: 'col1', hashed_rwset: { hashed_writes: hashed } }],
                        }],
                      },
                    },
                  },
                },
              },
            }],
          },
        },
      }],
    },
    metadata: { metadata: [[], [], pub.length === 0 ? [] : [0]] },
  });
}

function buildLedger(height: number, salt = ''): any[] {
  const blocks: any[] = [];
  let prev = '';
  for (let i = 0; i < height; i++) {
    const b = makeBlock(i, prev, salt);
    blocks.push(b);
    prev = headerHash(i, b.header.previous_hash, b.header.data_hash);
  }
  return blocks;
}

function gateway(blocks: any[], failAt?: number): any {
  const contract = {
    evaluateTransaction: jest.fn(async (_f: string, _c: string, n: string) => {
      const i = parseInt(n, 10);
      if (i === failAt) throw new Error(`PERMISSION_DENIED: peer stopped serving at block ${i}`); // permanent: not retried
      if (!blocks[i]) throw new Error(`Block ${n} not found`);
      return encodeBlock(blocks[i]);
    }),
  };
  return { getNetwork: () => ({ getContract: () => contract }) };
}

/** DeliverWithPrivateData over the same ledger: the private values of each block. */
function delivery(blocks: any[]): PrivateDataDeliveryFn {
  return async (_ch, start, end, onBlock) => {
    for (let i = start; i <= end; i++) {
      const { priv } = specOf(i);
      const map = priv.length === 0 ? {} : {
        0: {
          ns_pvt_rwset: [{
            namespace: 'mycc',
            collection_pvt_rwset: [{
              collection_name: 'col1',
              rwset: { writes: priv.map((w) => ({ key: w.key, value: Buffer.from(w.value ?? ''), is_delete: w.del ?? false })) },
            }],
          }],
        },
      };
      await onBlock(i, blocks[i], map);
    }
  };
}

// ── Fixtures ──

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'extend-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); deleteAllAt = undefined; });

const channel = (h: number): ChannelInfo => ({
  channelId: 'ch1',
  ledgerHeight: h,
  chaincodes: [{
    name: 'mycc', version: '1', sequence: 1,
    collections: [{ name: 'col1', policy: "OR('Org1MSP.member')", requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: true, memberOnlyWrite: true }],
  }],
});
const manifest = (c: ChannelInfo): Manifest => ({
  networkId: 'n', memberId: 'm', region: 'us-east-1', stateDb: 'CouchDB', extractedAt: '', channels: [c],
});
const opts = (dir: string, extra: Partial<ExtractOptions> = {}): ExtractOptions => ({
  manifest: '', nodeId: 'nd', tier: MigrationTier.FullHistory, channels: ['ch1'], outputDir: dir, batchSize: 100,
  strategy: 'block-reconstruction', concurrency: 1, stateBackend: 'auto', memoryLimitMb: 512, prefetchBuffer: 0, ...extra,
});

async function extract(dir: string, h: number, blocks: any[], extra: Partial<ExtractOptions> = {}, failAt?: number): Promise<void> {
  const c = channel(h);
  await new HybridExtractor(opts(dir, extra), manifest(c), gateway(blocks, failAt), 'Org1MSP', delivery(blocks)).run([c]);
}

/** Every NDJSON file of a directory, its lines sorted; a missing or empty file is the same as no file. */
function contents(dir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) { if (f !== 'checkpoints') walk(full); continue; }
      if (!f.endsWith('.ndjson') && !f.endsWith('.part')) continue;
      const lines = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean).sort();
      if (lines.length) out[path.relative(dir, full)] = lines;
    }
  };
  walk(dir);
  return out;
}

const meta = (dir: string): any =>
  JSON.parse(fs.readFileSync(path.join(dir, new FileLayoutManager(dir).channelMetadataPath('ch1')), 'utf-8'));

// ── Tests ──

describe('extract --extend', () => {
  const blocks = buildLedger(12);

  it('equals a fresh extraction at the new height, file by file', async () => {
    const fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 12, blocks);
    await extract(ext, 7, blocks);
    await extract(ext, 12, blocks, { extend: true });

    expect(contents(ext)).toEqual(contents(fresh));
    expect(Object.keys(contents(fresh)).sort()).toEqual(expect.arrayContaining([
      'channel-ch1/public-state.ndjson', 'channel-ch1/public-history.ndjson', 'channel-ch1/block-metadata.ndjson',
      'channel-ch1/private-mycc-col1-state.ndjson', 'channel-ch1/private-mycc-col1-history.ndjson',
      'channel-ch1/private-mycc-col1-hashes.ndjson', 'identities.ndjson',
    ]));

    const m = meta(ext), f = meta(fresh);
    expect(m.ledgerHeight).toBe(12);
    expect(m.outputFiles).toEqual(f.outputFiles);
    expect(m.walkTip).toEqual(f.walkTip);
    expect(m.blocksWithoutMetadata).toEqual(f.blocksWithoutMetadata);
    expect(m.privateDataCoverage).toEqual(f.privateDataCoverage);
    expect(m.extensions).toEqual([expect.objectContaining({ fromBlock: 7, toLedgerHeight: 12 })]);
    expect(fs.existsSync(path.join(ext, EXTEND_JOURNAL))).toBe(false);
    expect(fs.readdirSync(path.join(ext, 'channel-ch1')).filter((x) => x.endsWith('.next'))).toEqual([]);
  });

  it('reads only the block before the old height and the blocks above it', async () => {
    const ext = path.join(root, 'ext');
    await extract(ext, 7, blocks);
    const c = channel(12), gw = gateway(blocks);
    await new HybridExtractor(opts(ext, { extend: true }), manifest(c), gw, 'Org1MSP', delivery(blocks)).run([c]);
    const fetched = gw.getNetwork().getContract().evaluateTransaction.mock.calls.map((x: any[]) => Number(x[2]));
    expect(fetched).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('extends more than once', async () => {
    const fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 12, blocks);
    await extract(ext, 4, blocks);
    await extract(ext, 9, blocks, { extend: true });
    await extract(ext, 12, blocks, { extend: true });
    expect(contents(ext)).toEqual(contents(fresh));
    expect(meta(ext).extensions.map((e: any) => e.fromBlock)).toEqual([4, 9]);
  });

  it('carries the new signers into the identity part, so a later run that rebuilds the registry keeps them', async () => {
    const fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 12, blocks);
    await extract(ext, 7, blocks);
    await extract(ext, 12, blocks, { extend: true });
    // A plain re-run at the extended height walks nothing and rebuilds identities.ndjson from the parts.
    await extract(ext, 12, blocks);
    expect(contents(ext)).toEqual(contents(fresh));
  });

  it('empties the state files when every key was deleted above the old height', async () => {
    deleteAllAt = 8;
    const ledger = buildLedger(9), fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 9, ledger);
    await extract(ext, 8, ledger);
    expect(contents(ext)['channel-ch1/public-state.ndjson']).toBeDefined();
    await extract(ext, 9, ledger, { extend: true });
    expect(contents(ext)).toEqual(contents(fresh));
    expect(contents(ext)['channel-ch1/public-state.ndjson']).toBeUndefined();
    expect(contents(ext)['channel-ch1/private-mycc-col1-state.ndjson']).toBeUndefined();
    expect(meta(ext).outputFiles.publicState).toBe(0);
  });

  it('is a no-op when the manifest height has not moved', async () => {
    const ext = path.join(root, 'ext');
    await extract(ext, 7, blocks);
    const before = contents(ext);
    await extract(ext, 7, blocks, { extend: true });
    expect(contents(ext)).toEqual(before);
    expect(meta(ext).extensions).toBeUndefined();
  });

  it('recovers from a walk interrupted part-way, on the same command', async () => {
    const fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 12, blocks);
    await extract(ext, 7, blocks);
    const hist = path.join(ext, 'channel-ch1/public-history.ndjson'), baseSize = fs.statSync(hist).size;
    await expect(extract(ext, 12, blocks, { extend: true }, 10)).rejects.toThrow();
    expect(fs.statSync(hist).size).toBeGreaterThan(baseSize); // blocks 7-9 were appended before the failure
    expect(fs.existsSync(path.join(ext, EXTEND_JOURNAL))).toBe(true);
    expect(meta(ext).ledgerHeight).toBe(7);

    // Without --extend the directory is refused while the journal is there.
    await expect(extract(ext, 12, blocks)).rejects.toThrow(/interrupted extract --extend/);

    await extract(ext, 12, blocks, { extend: true });
    expect(contents(ext)).toEqual(contents(fresh));
  });

  it('finishes a commit interrupted between renames', async () => {
    const dir = path.join(root, 'c');
    fs.mkdirSync(path.join(dir, 'channel-ch1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'channel-ch1/public-state.ndjson'), 'old\n');
    fs.writeFileSync(path.join(dir, 'channel-ch1/public-state.ndjson.next'), 'new\n');
    fs.writeFileSync(path.join(dir, 'identities.ndjson'), 'already renamed\n');
    fs.writeFileSync(path.join(dir, EXTEND_JOURNAL), JSON.stringify({
      version: 1, phase: 'committing', channels: { ch1: { fromBlock: 7, grown: {} } },
      renames: ['channel-ch1/public-state.ndjson', 'identities.ndjson'], empties: [],
      metadata: { ch1: { channelId: 'ch1', ledgerHeight: 12 } },
    }));
    expect(recoverExtension(dir, new FileLayoutManager(dir))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'channel-ch1/public-state.ndjson'), 'utf-8')).toBe('new\n');
    expect(fs.readFileSync(path.join(dir, 'identities.ndjson'), 'utf-8')).toBe('already renamed\n');
    expect(meta(dir).ledgerHeight).toBe(12);
    expect(fs.existsSync(path.join(dir, EXTEND_JOURNAL))).toBe(false);
  });

  it('refuses a grown manifest without --extend', async () => {
    const ext = path.join(root, 'ext');
    await extract(ext, 7, blocks);
    await expect(extract(ext, 12, blocks)).rejects.toThrow(/Add --extend/);
  });

  it('refuses a directory that holds another chain', async () => {
    const ext = path.join(root, 'ext');
    await extract(ext, 7, blocks);
    await expect(extract(ext, 12, buildLedger(12, 'other'), { extend: true })).rejects.toThrow(/another chain/);
  });

  it('refuses a directory with no completed extraction, another tier, or a lower height', async () => {
    const ext = path.join(root, 'ext');
    await expect(extract(ext, 7, blocks, { extend: true })).rejects.toThrow(/no completed extraction/);
    await extract(ext, 7, blocks);
    await expect(extract(ext, 12, blocks, { extend: true, tier: MigrationTier.StateWithAudit })).rejects.toThrow(/tier/);
    await expect(extract(ext, 5, blocks, { extend: true })).rejects.toThrow(/below/);
  });

  it('as a --processes child, writes its identity part and not identities.ndjson', async () => {
    const dir = path.join(root, 'child');
    await extract(dir, 12, blocks, { identitiesOut: 'channel-ch1/identities.part' });
    expect(fs.existsSync(path.join(dir, 'identities.ndjson'))).toBe(false);
    const fresh = path.join(root, 'fresh');
    await extract(fresh, 12, blocks);
    expect(fs.readFileSync(path.join(dir, 'channel-ch1/identities.part'), 'utf-8'))
      .toBe(fs.readFileSync(path.join(fresh, 'identities.ndjson'), 'utf-8'));
  });

  it('extends a private-only extraction', async () => {
    const fresh = path.join(root, 'fresh'), ext = path.join(root, 'ext');
    await extract(fresh, 12, blocks, { privateOnly: true });
    await extract(ext, 7, blocks, { privateOnly: true });
    await extract(ext, 12, blocks, { privateOnly: true, extend: true });
    expect(contents(ext)).toEqual(contents(fresh));
    await expect(extract(ext, 12, blocks, { extend: true })).rejects.toThrow(/private-only/);
  });
});
