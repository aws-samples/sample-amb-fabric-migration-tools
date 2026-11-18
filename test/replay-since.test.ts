// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// pg is mocked: every statement the PostgreSQL adapter sends is recorded.
const queries: Array<{ text: string; values?: unknown[] }> = [];
let failOnStateInsert = 0;
jest.mock('pg', () => {
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (failOnStateInsert > 0 && /INSERT INTO fabric_state/.test(text) && --failOnStateInsert === 0) throw new Error('db down');
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn(async (text: string) => { queries.push({ text }); return { rows: [] }; }),
      end: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';
import { channelDelta, resolveSince } from '../src/replay/delta';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { computePlanDigest } from '../src/replay/history-import/plan-digest';
import { MigrationTier } from '../src/types';

let dir: string;
let layout: FileLayoutManager;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'since-'));
  layout = new FileLayoutManager(dir);
  queries.length = 0;
  failOnStateInsert = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const creator = { mspId: 'Org1MSP', certFingerprint: 'f', commonName: 'admin', org: 'Org1MSP' };
const hist = (key: string, block: number, value: string, isDelete = false) =>
  ({ _type: 'public_history', channel: 'ch1', chaincode: 'cc', key, value, txId: `t${block}`, txIndex: 0, blockNumber: block, timestamp: '', isDelete, creator });
const phist = (key: string, block: number, value: string, isDelete = false) =>
  ({ _type: 'private_history', channel: 'ch1', chaincode: 'cc', collection: 'col', key, value, txId: `t${block}`, txIndex: 0, blockNumber: block, timestamp: '', isDelete });
const state = (key: string, value: string) => ({ _type: 'public_state', channel: 'ch1', chaincode: 'cc', key, value });
const pstate = (key: string, value: string) => ({ _type: 'private_state', channel: 'ch1', chaincode: 'cc', collection: 'col', key, value });

function write(rel: string, records: object[]): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * A Tier 3 extraction extended from height 10 to 20:
 *   a: written at 3, rewritten at 12          -> changed
 *   b: written at 4 only                      -> unchanged
 *   c: written at 5, deleted at 15            -> deleted
 *   d: written at 11, deleted at 13, re-written at 16 -> changed
 *   private p1: written at 2, rewritten at 14 -> changed; p2: written at 6, deleted at 17 -> deleted
 */
function extendedExtraction(tier = MigrationTier.FullHistory, extensions = [{ fromBlock: 10, toLedgerHeight: 20, extractedAt: '' }]): void {
  fs.writeFileSync(layout.manifestPath, JSON.stringify({ networkId: 'n', channels: [{ channelId: 'ch1', ledgerHeight: 20, chaincodes: [] }] }));
  fs.mkdirSync(path.join(dir, layout.channelDir('ch1')), { recursive: true });
  fs.writeFileSync(path.join(dir, layout.channelMetadataPath('ch1')), JSON.stringify({ channelId: 'ch1', tier, ledgerHeight: 20, extensions }));
  write(layout.publicHistoryPath('ch1'), [hist('a', 3, 'a1'), hist('b', 4, 'b1'), hist('c', 5, 'c1'), hist('d', 11, 'd1'), hist('a', 12, 'a2'), hist('d', 13, '', true), hist('c', 15, '', true), hist('d', 16, 'd2')]);
  write(layout.publicStatePath('ch1'), [state('a', 'a2'), state('b', 'b1'), state('d', 'd2')]);
  write(layout.blockMetadataPath('ch1'), [3, 4, 5, 11, 12, 13, 15, 16].map((n) => ({ _type: 'block_metadata', channel: 'ch1', blockNumber: n, txId: `t${n}`, txIndex: 0, timestamp: '', chaincodeId: 'cc', keysWritten: [], keysDeleted: [], creator })));
  write(layout.privateHistoryPath('ch1', 'cc', 'col'), [phist('p1', 2, 'x1'), phist('p2', 6, 'y1'), phist('p1', 14, 'x2'), phist('p2', 17, '', true)]);
  write(layout.privateStatePath('ch1', 'cc', 'col'), [pstate('p1', 'x2')]);
}

const pg = (since?: string) => new ReplayOrchestrator({ adapter: 'postgresql', inputDir: dir, postgresql: { connectionString: 'postgres://localhost/x' }, ...(since && { since }) });

const stateKeysUpserted = (): string[] => queries.filter((q) => /INSERT INTO fabric_state/.test(q.text)).flatMap((q) => {
  const v = q.values ?? [];
  const cols = /collection\)/.test(q.text.split('FROM')[0]) ? 6 : 5;
  const out: string[] = [];
  for (let i = 0; i < v.length; i += cols) out.push(String(v[i + 2]));
  return out;
}).sort();
const deletes = (): string[] => queries.filter((q) => /DELETE FROM fabric_state/.test(q.text)).map((q) => `${(q.values ?? [])[2]}|${(q.values ?? [])[3]}`).sort();
const historyBlocks = (): number[] => queries.filter((q) => /INSERT INTO fabric_history/.test(q.text)).flatMap((q) => {
  const v = q.values ?? [];
  const cols = /collection/.test(q.text.split('FROM')[0]) ? 14 : 12;
  const out: number[] = [];
  for (let i = 0; i < v.length; i += cols) out.push(Number(v[i + 6]));
  return out;
}).sort((a, b) => a - b);

describe('replay --since: which records', () => {
  it('finds the keys changed and deleted at or above the height, private included', async () => {
    extendedExtraction();
    const d = await channelDelta(dir, layout, 'ch1', 10);
    expect([...d.touched].map((k) => k.split('\u0000\u0001').filter(Boolean).join('/')).sort()).toEqual(['cc/a', 'cc/c', 'cc/col/p1', 'cc/col/p2', 'cc/d']);
    expect(d.deletes.map((x) => `${x.collection ?? ''}/${x.key}`)).toEqual(['/c', 'col/p2']);
  });

  it('PostgreSQL: upserts only changed state, deletes what was deleted, and writes only history at or above the height', async () => {
    extendedExtraction();
    await pg('extension').run();
    expect(stateKeysUpserted()).toEqual(['a', 'd', 'p1']);
    expect(deletes()).toEqual(['c|', 'p2|col']);
    expect(historyBlocks()).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });

  it('a full replay is unchanged: everything upserted, nothing deleted', async () => {
    extendedExtraction();
    await pg().run();
    expect(stateKeysUpserted()).toEqual(['a', 'b', 'd', 'p1']);
    expect(deletes()).toEqual([]);
    expect(historyBlocks()).toEqual([2, 3, 4, 5, 6, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('takes explicit heights', async () => {
    extendedExtraction();
    await pg('ch1=14').run();
    expect(stateKeysUpserted()).toEqual(['d', 'p1']);
    expect(deletes()).toEqual(['c|', 'p2|col']);
  });

  it('Tier 2: finds changed and deleted public keys from block metadata', async () => {
    extendedExtraction(MigrationTier.StateWithAudit);
    fs.rmSync(path.join(dir, layout.publicHistoryPath('ch1')));
    for (const f of layout.listPrivateFiles('ch1', '.ndjson')) fs.rmSync(path.join(dir, layout.channelDir('ch1'), f));
    write(layout.blockMetadataPath('ch1'), [
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 4, txId: 't4', txIndex: 0, timestamp: '', chaincodeId: 'cc', keysWritten: ['b'], keysDeleted: [], creator },
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 12, txId: 't12', txIndex: 0, timestamp: '', chaincodeId: 'cc', keysWritten: ['a'], keysDeleted: [], creator },
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 15, txId: 't15', txIndex: 0, timestamp: '', chaincodeId: 'cc', keysWritten: [], keysDeleted: ['c'], creator },
    ]);
    await pg('extension').run();
    expect(stateKeysUpserted()).toEqual(['a']);
    expect(deletes()).toEqual(['c|']);
  });
});

describe('replay --since: refusals', () => {
  it('refuses a channel with no recorded extension, a Tier 1 extraction, and Tier 2 private data', () => {
    extendedExtraction(MigrationTier.FullHistory, []);
    expect(() => resolveSince('extension', dir, layout, ['ch1'])).toThrow(/no extract --extend recorded/);
    expect(() => resolveSince('ch2=4', dir, layout, ['ch1'])).toThrow(/no height for channel ch1/);
    expect(() => resolveSince('ch1=x', dir, layout, ['ch1'])).toThrow(/not <channel>=<block>/);
    extendedExtraction(MigrationTier.CurrentState);
    expect(() => resolveSince('extension', dir, layout, ['ch1'])).toThrow(/Tier 1/);
    extendedExtraction(MigrationTier.StateWithAudit);
    expect(() => resolveSince('extension', dir, layout, ['ch1'])).toThrow(/private data extracted at Tier 2/);
  });

  it('refuses a Fabric history destination without historyImport, before connecting', async () => {
    extendedExtraction();
    const o = new ReplayOrchestrator({
      adapter: 'chaincode', inputDir: dir, since: 'extension',
      chaincode: { connectionProfilePath: '/nonexistent', mspId: 'Org1MSP', certPath: '/x', keyPath: '/y', channel: 'ch1', replayHistory: true } as never,
    });
    await expect(o.run()).rejects.toThrow(/--since into a Fabric history destination needs chaincode.historyImport/);
  });

  it('binds the heights into the history-import plan digest, and leaves a full replay\'s digest alone', async () => {
    extendedExtraction();
    const base = { context: { scope: 'a'.repeat(32), key: Buffer.alloc(32, 1) } as never, ccConfig: {} as never, layout, pairs: [{ channel: 'ch1', destChannel: 'ch1' }], sourceNetworkId: 'n' };
    const full = await computePlanDigest(base);
    const s10 = await computePlanDigest({ ...base, since: new Map([['ch1', 10]]) });
    const s11 = await computePlanDigest({ ...base, since: new Map([['ch1', 11]]) });
    expect(new Set([full, s10, s11]).size).toBe(3);
  });
});

describe('replay --since: resume', () => {
  it('keeps its own checkpoint, counted in lines read, and resumes to the same result', async () => {
    extendedExtraction();
    failOnStateInsert = 2; // the second state upsert fails (the private state file's)
    await expect(pg('extension').run()).rejects.toThrow();
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('replay-checkpoint-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^replay-checkpoint-since-[0-9a-f]{12}-postgresql\.json$/);
    const cp = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    // the file before the failing one is complete: all four lines read, two of them kept
    expect(cp.lastFile).toBe('ch1/private-cc-col-history.ndjson');
    expect(cp.recordsCompleted).toBe(4);

    queries.length = 0;
    await pg('extension').run();
    expect(stateKeysUpserted()).toEqual(['p1']);
    expect(deletes()).toEqual(['c|', 'p2|col']);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('replay-checkpoint-'))).toEqual([]);
  });
});
