// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChannelInfo,
  CollectionConfig,
  ExtractionRecord,
  Manifest,
  MigrationTier,
  PrivateHashRecord,
  PrivateHistoryRecord,
  PrivateStateRecord,
} from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { MergeReport, MergeRunner } from '../src/merge/merge-runner';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { runValidation } from '../src/validation/validation-runner';

let root: string;
let outputDir: string;
const layout = new FileLayoutManager('');
const reader = new NdjsonReader();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
  outputDir = path.join(root, 'merged');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Fixtures ──

const CREATOR = {
  mspId: 'Org1MSP',
  commonName: 'admin',
  org: 'Org1',
  certFingerprint: 'fp1',
};

function collection(
  overrides: Partial<CollectionConfig> = {},
): CollectionConfig {
  return {
    name: 'col1',
    policy: "OR('Org1MSP.member', 'Org2MSP.member')",
    requiredPeerCount: 1,
    maxPeerCount: 2,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    ...overrides,
  };
}

function channel(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    channelId: 'ch1',
    ledgerHeight: 10,
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: [collection()],
      },
    ],
    ...overrides,
  };
}

/**
 * A channel whose col1 collection has a non-zero blockToLive, so a key written
 * early in the ledger is genuinely past its purge horizon — what an accepted
 * purge-window loss looks like once the manifest and the coverage agree.
 */
function purgeChannel(): ChannelInfo {
  return channel({
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: [collection({ blockToLive: 5 })],
      },
    ],
  });
}

interface MemberSpec {
  memberId: string;
  nodeId?: string;
  mspId?: string;
  channels?: ChannelInfo[];
  networkId?: string;
  region?: string;
  stateDb?: 'CouchDB' | 'LevelDB';
}

/** Create a member extraction directory with a manifest. */
function member(spec: MemberSpec): string {
  const dir = path.join(root, spec.memberId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Manifest = {
    networkId: spec.networkId ?? 'nd-TEST',
    memberId: spec.memberId,
    ...(spec.nodeId ? { nodeId: spec.nodeId } : {}),
    region: spec.region ?? 'us-east-1',
    stateDb: spec.stateDb ?? 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z',
    ...(spec.mspId ? { mspId: spec.mspId } : {}),
    channels: spec.channels ?? [channel()],
  };
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest),
    'utf-8',
  );
  // A real extraction always writes a metadata.json per channel, and merge now
  // validates every input before merging it. Write a minimal valid one so tests
  // that do not care about metadata still present a sound member; tests that do
  // call writeMetadata afterward, overwriting this default.
  for (const ch of manifest.channels) {
    writeMetadata(dir, ch.channelId, defaultChannelMetadata(ch));
  }
  return dir;
}

/** A minimal valid metadata.json for a channel, as `member()` writes by default. */
function defaultChannelMetadata(ch: ChannelInfo): Record<string, unknown> {
  return {
    channelId: ch.channelId,
    extractedAt: '2026-01-01T00:00:00.000Z',
    tier: MigrationTier.CurrentState,
    strategy: 'block-reconstruction',
    ledgerHeight: ch.ledgerHeight,
    chaincodes: ch.chaincodes.map((cc) => ({
      name: cc.name,
      version: cc.version,
      collections: cc.collections.length,
    })),
    blocksWithoutMetadata: [],
    privateDataCoverage: [],
    outputFiles: { publicState: 0, publicHistory: 0, blockMetadata: 0 },
  };
}

function writeRecords(
  dir: string,
  relativePath: string,
  records: ExtractionRecord[],
): void {
  const full = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function writeMetadata(
  dir: string,
  channelId: string,
  metadata: Record<string, unknown>,
): void {
  const full = path.join(dir, layout.channelMetadataPath(channelId));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(metadata), 'utf-8');
}

function coverageMetadata(
  coverage: Array<Record<string, unknown>>,
  tier: MigrationTier = MigrationTier.StateWithAudit,
): Record<string, unknown> {
  return {
    channelId: 'ch1',
    extractedAt: '2026-01-01T00:00:00.000Z',
    tier,
    strategy: 'block-reconstruction',
    ledgerHeight: 10,
    chaincodes: [{ name: 'mycc', version: '1.0', collections: 1 }],
    blocksWithoutMetadata: [],
    privateDataCoverage: coverage,
    outputFiles: { publicState: 0, publicHistory: 0, blockMetadata: 0 },
  };
}

function privateState(
  key: string,
  value: string,
  overrides: Partial<PrivateStateRecord> = {},
): PrivateStateRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value,
    creator: CREATOR,
    ...overrides,
  };
}

function privateHistory(
  key: string,
  blockNumber: number,
  txIndex: number,
  overrides: Partial<PrivateHistoryRecord> = {},
): PrivateHistoryRecord {
  return {
    _type: 'private_history',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value: `v-${key}-${blockNumber}`,
    txId: `tx${blockNumber}-${txIndex}`,
    blockNumber,
    txIndex,
    timestamp: '2026-01-01T00:00:00.000Z',
    isDelete: false,
    ...overrides,
  };
}

function privateHash(
  key: string,
  blockNumber: number,
  txIndex = 0,
  overrides: Partial<PrivateHashRecord> = {},
): PrivateHashRecord {
  return {
    _type: 'private_hash',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    hash: `h-${key}`,
    blockNumber,
    txId: `tx${blockNumber}-${txIndex}`,
    txIndex,
    ...overrides,
  };
}

function publicState(key: string, value: string): ExtractionRecord {
  return {
    _type: 'public_state',
    channel: 'ch1',
    chaincode: 'mycc',
    key,
    value,
    creator: CREATOR,
  };
}

async function readOut<T>(relativePath: string): Promise<T[]> {
  return (await reader.readAll(
    path.join(outputDir, relativePath),
  )) as unknown as T[];
}

function merge(inputDirs: string[]): Promise<MergeReport> {
  return new MergeRunner({ inputDirs, outputDir }).run();
}

const STATE_PATH = layout.privateStatePath('ch1', 'mycc', 'col1');
const HISTORY_PATH = layout.privateHistoryPath('ch1', 'mycc', 'col1');
const HASHES_PATH = layout.privateHashesPath('ch1', 'mycc', 'col1');
const OTHER_CC_STATE_PATH = layout.privateStatePath('ch1', 'othercc', 'col1');
const PUBLIC_STATE_PATH = layout.publicStatePath('ch1');

/** Two chaincodes sharing a collection name, as on any Fabric 2.x channel. */
const TWO_CHAINCODES = channel({
  chaincodes: [
    { name: 'mycc', version: '1.0', sequence: 1, collections: [collection()] },
    {
      name: 'othercc',
      version: '1.0',
      sequence: 1,
      collections: [collection()],
    },
  ],
});

// ── Pre-flight ──

describe('merge pre-flight', () => {
  test('rejects a single input directory', async () => {
    const org1 = member({ memberId: 'org1' });
    await expect(merge([org1])).rejects.toThrow(
      /at least two member directories/,
    );
  });

  test('rejects a member with no manifest', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = path.join(root, 'org2');
    fs.mkdirSync(org2);

    await expect(merge([org1, org2])).rejects.toThrow(/No manifest\.json/);
  });

  test('rejects a missing member directory', async () => {
    const org1 = member({ memberId: 'org1' });
    await expect(merge([org1, path.join(root, 'nope')])).rejects.toThrow(
      /Member directory not found/,
    );
  });

  test('rejects an unparseable manifest naming the file', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    fs.writeFileSync(path.join(org2, 'manifest.json'), '{ not json', 'utf-8');

    await expect(merge([org1, org2])).rejects.toThrow(/Cannot parse .*org2/);
  });

  test('rejects the same member passed twice', async () => {
    const org1 = member({ memberId: 'org1' });
    await expect(merge([org1, org1])).rejects.toThrow(
      /both member "org1"/,
    );
  });

  /** A staged merge credits no MSP for the members already rolled up. */
  test('rejects a directory merge itself produced', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    const org3 = member({ memberId: 'org3', mspId: 'Org3MSP' });
    const manifestPath = path.join(org2, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.mergedFrom = [{ inputDir: org1, memberId: 'org1', mspId: 'Org1MSP' }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    await expect(merge([org1, org2, org3])).rejects.toThrow(
      /org2 is already the output of merge.*one merge/s,
    );
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  test('rejects members on different networks', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2', networkId: 'nd-OTHER' });

    await expect(merge([org1, org2])).rejects.toThrow(
      /disagree on networkId/,
    );
  });

  test('accepts members whose peers use different state databases, recording each', async () => {
    const org1 = member({ memberId: 'org1', stateDb: 'LevelDB' });
    const org2 = member({ memberId: 'org2', stateDb: 'CouchDB' });

    await merge([org1, org2]);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    expect(manifest.stateDb).toBe('CouchDB');
    expect(manifest.mergedFrom.map((m: { stateDb: string }) => m.stateDb)).toEqual(['LevelDB', 'CouchDB']);
  });

  test('rejects members at different ledger heights, naming both', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({
      memberId: 'org2',
      channels: [channel({ ledgerHeight: 12 })],
    });

    await expect(merge([org1, org2])).rejects.toThrow(
      /different ledger heights: 10 \(.*org1\); 12 \(.*org2\)/,
    );
  });

  test('rejects members whose public state differs in size', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, PUBLIC_STATE_PATH, [publicState('k1', 'v1')]);
    writeRecords(org2, PUBLIC_STATE_PATH, [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /disagree on ch1\/public-state\.ndjson/,
    );
  });

  test('accepts public state that differs only in record order', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, PUBLIC_STATE_PATH, [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
    ]);
    writeRecords(org2, PUBLIC_STATE_PATH, [
      publicState('k2', 'v2'),
      publicState('k1', 'v1'),
    ]);

    const report = await merge([org1, org2]);
    expect(report.channels[0].publicSource).toBe('org1');
  });

  test('refuses to write into a non-empty output directory', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), '{}', 'utf-8');

    await expect(merge([org1, org2])).rejects.toThrow(/is not empty/);
  });

  test('leaves no manifest behind when a member fails validation', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    // org2's history goes backwards, which validation rejects before any write.
    writeRecords(org1, HISTORY_PATH, [privateHistory('k1', 1, 0)]);
    writeRecords(org2, HISTORY_PATH, [
      privateHistory('k1', 5, 0),
      privateHistory('k1', 2, 0),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /failed validation[\s\S]*org2[\s\S]*Record ordering/,
    );
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  test('names the member whose input was out of order', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org2, HASHES_PATH, [
      privateHash('k1', 5),
      privateHash('k2', 3),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /failed validation[\s\S]*org2[\s\S]*Record ordering/,
    );
  });
});

// ── Private state ──

describe('merge private state', () => {
  test('deduplicates a key both members hold', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [privateState('k1', 'v1')]);

    const report = await merge([org1, org2]);

    const merged = await readOut<PrivateStateRecord>(STATE_PATH);
    expect(merged).toHaveLength(1);
    expect(report.channels[0].counts.privateState).toBe(1);
    expect(report.conflicts).toEqual([]);
  });

  test('unions keys only one member could see', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [privateState('k2', 'v2')]);

    await merge([org1, org2]);

    const merged = await readOut<PrivateStateRecord>(STATE_PATH);
    expect(merged.map((r) => r.key).sort()).toEqual(['k1', 'k2']);
  });

  test('treats the same value in different encodings as one record', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'hello')]);
    writeRecords(org2, STATE_PATH, [
      privateState('k1', Buffer.from('hello', 'utf-8').toString('base64'), {
        valueEncoding: 'base64',
      }),
    ]);

    const report = await merge([org1, org2]);

    expect(await readOut(STATE_PATH)).toHaveLength(1);
    expect(report.conflicts).toEqual([]);
  });

  test('reports a key whose value differs between members', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [privateState('k1', 'DIFFERENT')]);

    const report = await merge([org1, org2]);

    expect(report.ok).toBe(false);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({
      channel: 'ch1',
      chaincode: 'mycc',
      collection: 'col1',
      key: 'k1',
      kept: 'org1',
    });
    expect(Object.keys(report.conflicts[0].digests).sort()).toEqual([
      'org1',
      'org2',
    ]);
  });

  test('keeps the first member value and writes it once on conflict', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [privateState('k1', 'DIFFERENT')]);

    await merge([org1, org2]);

    const merged = await readOut<PrivateStateRecord>(STATE_PATH);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('v1');
  });

  test('collects every disagreeing member for one key', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    const org3 = member({ memberId: 'org3' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'a')]);
    writeRecords(org2, STATE_PATH, [privateState('k1', 'b')]);
    writeRecords(org3, STATE_PATH, [privateState('k1', 'c')]);

    const report = await merge([org1, org2, org3]);

    expect(report.conflicts).toHaveLength(1);
    expect(Object.keys(report.conflicts[0].digests).sort()).toEqual([
      'org1',
      'org2',
      'org3',
    ]);
  });

  test('distinguishes the same key in two chaincodes', async () => {
    const org1 = member({ memberId: 'org1', channels: [TWO_CHAINCODES] });
    const org2 = member({ memberId: 'org2', channels: [TWO_CHAINCODES] });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, OTHER_CC_STATE_PATH, [
      privateState('k1', 'other', { chaincode: 'othercc' }),
    ]);

    const report = await merge([org1, org2]);

    expect(report.conflicts).toEqual([]);
    expect(await readOut<PrivateStateRecord>(STATE_PATH))
      .toEqual([privateState('k1', 'v1')]);
    expect(await readOut<PrivateStateRecord>(OTHER_CC_STATE_PATH))
      .toEqual([privateState('k1', 'other', { chaincode: 'othercc' })]);
  });
});

// ── A member file holding a collection it is not named for ──

/**
 * The merge is where one member reads another's files, so it is where the
 * one-pair-per-file assumption can first be violated by something other than
 * this tool. Merging such a file through would put two collections in one output
 * file, which is the collision the chaincode in the name exists to prevent.
 */
describe('merge private files naming a different collection', () => {
  test('refuses a state file holding another chaincode', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [
      privateState('k1', 'other', { chaincode: 'othercc' }),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /org2's private-mycc-col1-state\.ndjson holds a record from chaincode/,
    );
  });

  test('refuses a hashes file holding another collection', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeRecords(org2, HASHES_PATH, [
      privateHash('k1', 2, 0, { collection: 'col2' }),
    ]);

    // Both members name the col1 hashes file, but hold different records in it:
    // the canonical cross-member comparison refuses the disagreement.
    await expect(merge([org1, org2])).rejects.toThrow(
      /disagree on ch1\/private-mycc-col1-hashes\.ndjson/,
    );
  });

  test('names the member to re-extract and says the output is incomplete', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [
      privateState('k1', 'other', { chaincode: 'othercc' }),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /is now incomplete — delete it, re-extract org2, and merge again/,
    );
  });
});

// ── Private history and hashes ──

describe('merge private history', () => {
  test('interleaves two members in ledger order', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HISTORY_PATH, [
      privateHistory('k1', 1, 0),
      privateHistory('k1', 5, 0),
    ]);
    writeRecords(org2, HISTORY_PATH, [
      privateHistory('k2', 2, 0),
      privateHistory('k2', 6, 0),
    ]);

    await merge([org1, org2]);

    const merged = await readOut<PrivateHistoryRecord>(HISTORY_PATH);
    expect(merged.map((r) => r.blockNumber)).toEqual([1, 2, 5, 6]);
  });

  test('orders by txIndex within one block', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HISTORY_PATH, [
      privateHistory('k1', 3, 0),
      privateHistory('k1', 3, 2),
    ]);
    writeRecords(org2, HISTORY_PATH, [privateHistory('k2', 3, 1)]);

    await merge([org1, org2]);

    const merged = await readOut<PrivateHistoryRecord>(HISTORY_PATH);
    expect(merged.map((r) => r.txIndex)).toEqual([0, 1, 2]);
  });

  test('drops a write both members recorded', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HISTORY_PATH, [privateHistory('k1', 4, 0)]);
    writeRecords(org2, HISTORY_PATH, [privateHistory('k1', 4, 0)]);

    const report = await merge([org1, org2]);

    expect(await readOut(HISTORY_PATH)).toHaveLength(1);
    expect(report.channels[0].counts.privateHistory).toBe(1);
  });

  test('keeps two keys written in the same transaction', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HISTORY_PATH, [privateHistory('k1', 4, 0)]);
    writeRecords(org2, HISTORY_PATH, [privateHistory('k2', 4, 0)]);

    await merge([org1, org2]);

    const merged = await readOut<PrivateHistoryRecord>(HISTORY_PATH);
    expect(merged.map((r) => r.key).sort()).toEqual(['k1', 'k2']);
  });

  test('keeps the same key written in two different blocks', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HISTORY_PATH, [
      privateHistory('k1', 1, 0),
      privateHistory('k1', 2, 0),
    ]);
    writeRecords(org2, HISTORY_PATH, [privateHistory('k1', 1, 0)]);

    await merge([org1, org2]);

    expect(await readOut(HISTORY_PATH)).toHaveLength(2);
  });

  test('merges hashes in ledger order and deduplicates them', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    // Hashes are on-chain public data, so every member of the channel records
    // the same set — the merge deduplicates the members' identical copies.
    writeRecords(org1, HASHES_PATH, [
      privateHash('k1', 1),
      privateHash('k2', 4),
      privateHash('k1', 7),
    ]);
    writeRecords(org2, HASHES_PATH, [
      privateHash('k1', 1),
      privateHash('k2', 4),
      privateHash('k1', 7),
    ]);

    const report = await merge([org1, org2]);

    const merged = await readOut<PrivateHashRecord>(HASHES_PATH);
    expect(merged.map((r) => r.blockNumber)).toEqual([1, 4, 7]);
    expect(report.channels[0].counts.privateHashes).toBe(3);
  });

  test('merges collections only one member has files for', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    const other = layout.privateStatePath('ch1', 'mycc', 'col2');
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, other, [
      privateState('k9', 'v9', { collection: 'col2' }),
    ]);

    await merge([org1, org2]);

    expect(await readOut(STATE_PATH)).toHaveLength(1);
    expect(await readOut(other)).toHaveLength(1);
  });
});

// ── Public data and identities ──

describe('merge public data and identities', () => {
  test('copies public files from the first member that has them', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, PUBLIC_STATE_PATH, [publicState('k1', 'v1')]);
    writeRecords(org2, PUBLIC_STATE_PATH, [publicState('k1', 'v1')]);

    const report = await merge([org1, org2]);

    expect(await readOut(PUBLIC_STATE_PATH)).toHaveLength(1);
    expect(report.channels[0].publicSource).toBe('org1');
  });

  test('takes public history from a member that has it when the first does not',
    async () => {
      const org1 = member({ memberId: 'org1' });
      const org2 = member({ memberId: 'org2' });
      const historyPath = layout.publicHistoryPath('ch1');
      writeRecords(org2, historyPath, [
        {
          _type: 'public_history',
          channel: 'ch1',
          chaincode: 'mycc',
          key: 'k1',
          value: 'v1',
          txId: 'tx1',
          txIndex: 0,
          blockNumber: 1,
          timestamp: '2026-01-01T00:00:00.000Z',
          isDelete: false,
          creator: CREATOR,
        },
      ]);

      await merge([org1, org2]);

      expect(await readOut(historyPath)).toHaveLength(1);
    });

  test('takes the greatest txCount rather than summing identities', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    const identity = {
      _type: 'identity' as const,
      mspId: 'Org1MSP',
      certFingerprint: 'fp1',
      commonName: 'admin',
      org: 'Org1',
      firstSeenBlock: 3,
      lastSeenBlock: 8,
      txCount: 5,
    };
    writeRecords(org1, layout.identitiesPath, [identity]);
    writeRecords(org2, layout.identitiesPath, [
      { ...identity, firstSeenBlock: 1, lastSeenBlock: 9, txCount: 5 },
    ]);

    const report = await merge([org1, org2]);

    const merged = await readOut<typeof identity>(layout.identitiesPath);
    expect(merged).toHaveLength(1);
    expect(merged[0].txCount).toBe(5);
    expect(merged[0].firstSeenBlock).toBe(1);
    expect(merged[0].lastSeenBlock).toBe(9);
    expect(report.identities).toBe(1);
  });

  test('keeps distinct certificates for one MSP apart', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    const identity = {
      _type: 'identity' as const,
      mspId: 'Org1MSP',
      certFingerprint: 'fp1',
      commonName: 'admin',
      org: 'Org1',
      firstSeenBlock: 1,
      lastSeenBlock: 2,
      txCount: 1,
    };
    writeRecords(org1, layout.identitiesPath, [identity]);
    writeRecords(org2, layout.identitiesPath, [
      { ...identity, certFingerprint: 'fp2' },
    ]);

    await merge([org1, org2]);

    expect(await readOut(layout.identitiesPath)).toHaveLength(2);
  });
});

// ── Manifest and metadata ──

describe('merged manifest and metadata', () => {
  test('omits mspId and records every contributing member', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });

    await merge([org1, org2]);

    const manifest: Manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.mspId).toBeUndefined();
    expect(manifest.memberId).toBe('org1+org2');
    expect(manifest.mergedFrom?.map((m) => m.mspId)).toEqual([
      'Org1MSP',
      'Org2MSP',
    ]);
  });

  test('unions collections the members declared separately', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({
      memberId: 'org2',
      channels: [
        channel({
          chaincodes: [
            {
              name: 'mycc',
              version: '1.0',
              sequence: 1,
              collections: [collection({ name: 'col2' })],
            },
          ],
        }),
      ],
    });

    await merge([org1, org2]);

    const manifest: Manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'),
    );
    expect(
      manifest.channels[0].chaincodes[0].collections.map((c) => c.name),
    ).toEqual(['col1', 'col2']);
  });

  test('unions channels only one member extracted', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({
      memberId: 'org2',
      channels: [channel(), channel({ channelId: 'ch2' })],
    });

    await merge([org1, org2]);

    const manifest: Manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.channels.map((c) => c.channelId)).toEqual(['ch1', 'ch2']);
  });

  test('keeps each member peer node in merged provenance', async () => {
    const org1 = member({ memberId: 'org1', nodeId: 'nd-ORG1' });
    const org2 = member({ memberId: 'org2', nodeId: 'nd-ORG2' });

    await merge([org1, org2]);

    const manifest: Manifest = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.mergedFrom?.map((m) => [m.memberId, m.nodeId]))
      .toEqual([['org1', 'nd-ORG1'], ['org2', 'nd-ORG2']]);
  });

  test('omits extractedByMspId from the merged channel metadata', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeMetadata(org1, 'ch1', {
      ...coverageMetadata([]),
      extractedByMspId: 'Org1MSP',
    });

    await merge([org1, org2]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.extractedByMspId).toBeUndefined();
    expect(metadata.strategy).toBe('merge');
  });

  test('unions blocks the members recorded as metadata gaps', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeMetadata(org1, 'ch1', {
      ...coverageMetadata([]),
      blocksWithoutMetadata: [3, 1],
    });
    writeMetadata(org2, 'ch1', {
      ...coverageMetadata([]),
      blocksWithoutMetadata: [1, 5],
    });

    await merge([org1, org2]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.blocksWithoutMetadata).toEqual([1, 3, 5]);
  });

  test('warns and takes the highest tier when members disagree', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeMetadata(org1, 'ch1', coverageMetadata([], MigrationTier.FullHistory));
    writeMetadata(org2, 'ch1', coverageMetadata([], MigrationTier.CurrentState));

    const report = await merge([org1, org2]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.tier).toBe(MigrationTier.FullHistory);
    expect(report.warnings.join(' ')).toMatch(/different tiers/);
  });

  test('warns when members disagree on a chaincode definition', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({
      memberId: 'org2',
      channels: [
        channel({
          chaincodes: [
            {
              name: 'mycc',
              version: '2.0',
              sequence: 2,
              collections: [collection()],
            },
          ],
        }),
      ],
    });

    const report = await merge([org1, org2]);

    expect(report.warnings.join(' ')).toMatch(
      /kept version 1\.0 sequence 1; org2 reported version 2\.0 sequence 2/,
    );
  });

  test('counts copied public records in the merged metadata', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, PUBLIC_STATE_PATH, [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
    ]);
    writeRecords(org2, PUBLIC_STATE_PATH, [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
    ]);

    await merge([org1, org2]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.outputFiles.publicState).toBe(2);
  });

  test('counts copied public records without reading the file whole', async () => {
    // A Tier 3 public history can exceed the ~512 MiB string ceiling, so the
    // count must stream; a readFileSync of the merged copy is the regression.
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    for (const org of [org1, org2]) {
      writeRecords(org, PUBLIC_STATE_PATH, [
        publicState('k1', 'v1'),
        publicState('k2', 'v2'),
        publicState('k3', 'v3'),
      ]);
    }
    const mergedPublic = path.join(outputDir, PUBLIC_STATE_PATH);
    // The interop namespace's properties are non-configurable; spy on the real
    // module, which the namespace's getters read through.
    const spy = jest.spyOn(jest.requireActual<typeof fs>('fs'), 'readFileSync');

    try {
      await merge([org1, org2]);
      const wholeReads = spy.mock.calls.filter(
        ([file]) => path.resolve(String(file)) === path.resolve(mergedPublic),
      );
      expect(wholeReads).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.outputFiles.publicState).toBe(3);
  });
});

// ── Coverage matrix (row 2.19) ──

describe('cross-member coverage matrix', () => {
  test('names the members that contributed values', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeRecords(org2, STATE_PATH, [privateState('k1', 'v1')]);

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row).toMatchObject({
      chaincode: 'mycc',
      collection: 'col1',
      outcome: 'values',
      contributedValues: ['org1', 'org2'],
      needsAttention: false,
    });
    expect(row.reason).toBeUndefined();
  });

  test('reports values when only one member could see the collection', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        authorized: true, blockToLive: 0, purgeRisk: 'none',
        estimatedPurgedBlocks: 0 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 0,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row.outcome).toBe('values');
    expect(row.contributedValues).toEqual(['org1']);
    expect(row.byMember.map((m) => m.coverage)).toEqual([
      'values',
      'hashes-only',
    ]);
    expect(report.ok).toBe(true);
  });

  test('surfaces purge-window loss without blocking sign-off', async () => {
    const org1 = member({ memberId: 'org1', channels: [purgeChannel()] });
    const org2 = member({
      memberId: 'org2', mspId: 'Org2MSP', channels: [purgeChannel()],
    });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: true, reason: 'purge-window', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 5,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row.outcome).toBe('hashes-only');
    expect(row.reason).toBe('purge-window');
    expect(row.needsAttention).toBe(false);
    expect(report.ok).toBe(true);
  });

  test('refutes a purge-window claim another member delivered values for', async () => {
    const org1 = member({ memberId: 'org1', channels: [purgeChannel()] });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: true, reason: 'purge-window', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));
    writeRecords(org2, STATE_PATH, [privateState('k1', 'v1')]);
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        authorized: true, blockToLive: 5, purgeRisk: 'high',
        estimatedPurgedBlocks: 4 },
    ]));
    const org3 = member({ memberId: 'org3', mspId: 'Org3MSP' });
    writeMetadata(org3, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 5,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2, org3]);

    expect(report.warnings.join(' ')).toMatch(
      /org1 reported purge-window .*but org2 contributed plaintext values/,
    );
    expect(report.warnings.join(' ')).toMatch(/anchor peer at commit time/);
    // Only the member that made the claim is accused of making it. Saying org2
    // or org3 reported a purge would be the same kind of false claim this
    // check exists to catch.
    expect(report.warnings.filter((w) => /reported purge-window/.test(w)))
      .toHaveLength(1);
    // Advisory: the merged directory holds the values, so nothing is lost.
    expect(report.channels[0].coverage[0].outcome).toBe('values');
    expect(report.ok).toBe(true);
  });

  test('leaves a purge-window claim standing when no member had values', async () => {
    const org1 = member({ memberId: 'org1', channels: [purgeChannel()] });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: true, reason: 'purge-window', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 5,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2]);

    expect(report.warnings.join(' ')).not.toMatch(/reported purge-window/);
    expect(report.channels[0].coverage[0].reason).toBe('purge-window');
  });

  test('does not refute a purge claim from a values report with no records', async () => {
    const org1 = member({ memberId: 'org1', channels: [purgeChannel()] });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: true, reason: 'purge-window', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        authorized: true, blockToLive: 5, purgeRisk: 'high',
        estimatedPurgedBlocks: 4 },
    ]));

    const report = await merge([org1, org2]);

    // org2 claimed values and shipped none. An unbacked claim is a
    // disagreement, and it must not be the evidence that refutes a purge.
    expect(report.warnings.join(' ')).toMatch(/contributed no plaintext records/);
    expect(report.warnings.join(' ')).not.toMatch(/reported purge-window/);
    expect(report.channels[0].coverage[0].reason).toBe('purge-window');
  });

  test('blocks sign-off on an unexplained collection', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: true, reason: 'unexplained', blockToLive: 0,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 0,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2]);

    expect(report.channels[0].coverage[0].reason).toBe('unexplained');
    expect(report.channels[0].coverage[0].needsAttention).toBe(true);
    expect(report.ok).toBe(false);
  });

  test('calls a collection nobody explained indeterminate', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row.outcome).toBe('hashes-only');
    expect(row.reason).toBe('indeterminate');
    expect(report.ok).toBe(false);
  });

  test('flags a member that reported values but shipped none', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org2, STATE_PATH, [privateState('k1', 'v1')]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        authorized: true, blockToLive: 0, purgeRisk: 'none',
        estimatedPurgedBlocks: 0 },
    ]));

    const report = await merge([org1, org2]);

    expect(report.warnings.join(' ')).toMatch(
      /org1 reported values for mycc\/col1 but contributed no plaintext/,
    );
  });

  test('keeps the worst purge risk in the merged coverage', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        blockToLive: 5, purgeRisk: 'low', estimatedPurgedBlocks: 2 },
    ]));
    writeMetadata(org2, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'values',
        blockToLive: 5, purgeRisk: 'high', estimatedPurgedBlocks: 7 },
    ]));

    await merge([org1, org2]);

    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(outputDir, layout.channelMetadataPath('ch1')),
        'utf-8',
      ),
    );
    expect(metadata.privateDataCoverage[0]).toMatchObject({
      purgeRisk: 'high',
      estimatedPurgedBlocks: 7,
      blockToLive: 0,
    });
    expect(metadata.privateDataCoverage[0].authorized).toBeUndefined();
  });

  test('reports a collection with records nobody declared', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, layout.privateStatePath('ch1', 'mycc', 'ghost'), [
      privateState('k1', 'v1', { collection: 'ghost' }),
    ]);

    const report = await merge([org1, org2]);

    expect(
      report.channels[0].coverage.map((r) => r.collection).sort(),
    ).toEqual(['col1', 'ghost']);
  });

  // Discovery synthesizes one implicit collection per channel org per chaincode,
  // so taking them from the manifests would add a block of rows no member
  // reported on — each landing on 'indeterminate' and blocking the sign-off.
  // They come from the members' own coverage reports instead, which name only
  // the ones that captured something.
  describe('synthesized implicit collections', () => {
    const IMPLICIT = '_implicit_org_Org1MSP';

    function withImplicit(): ChannelInfo {
      return channel({
        chaincodes: [
          {
            name: 'mycc',
            version: '1.0',
            sequence: 1,
            collections: [
              collection(),
              collection({ name: IMPLICIT, implicit: true }),
            ],
          },
        ],
      });
    }

    test('leaves out an implicit collection no member accounted for', async () => {
      const channels = [withImplicit()];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);

      const report = await merge([org1, org2]);

      expect(report.channels[0].coverage.map((r) => r.collection)).toEqual([
        'col1',
      ]);
      expect(report.ok).toBe(true);
    });

    test('reports an implicit collection a member covered', async () => {
      const channels = [withImplicit()];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      writeRecords(org1, layout.privateStatePath('ch1', 'mycc', IMPLICIT), [
        privateState('k1', 'v1', { collection: IMPLICIT }),
      ]);
      writeMetadata(org1, 'ch1', coverageMetadata([
        { chaincode: 'mycc', collection: IMPLICIT, coverage: 'values',
          authorized: true, blockToLive: 0, purgeRisk: 'none',
          estimatedPurgedBlocks: 0 },
      ]));

      const report = await merge([org1, org2]);

      const row = report.channels[0].coverage.find(
        (r) => r.collection === IMPLICIT,
      );
      expect(row).toMatchObject({
        outcome: 'values',
        contributedValues: ['org1'],
        needsAttention: false,
      });
    });

    // Without the row there is nothing for the disagreement check to compare, so
    // a member whose implicit-collection values never arrived would pass in
    // silence.
    test('reports an implicit collection a member covered but did not ship', async () => {
      const channels = [withImplicit()];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      writeMetadata(org1, 'ch1', coverageMetadata([
        { chaincode: 'mycc', collection: IMPLICIT, coverage: 'values',
          authorized: true, blockToLive: 0, purgeRisk: 'none',
          estimatedPurgedBlocks: 0 },
      ]));

      const report = await merge([org1, org2]);

      const row = report.channels[0].coverage.find(
        (r) => r.collection === IMPLICIT,
      );
      expect(row?.outcome).toBe('absent');
      expect(report.warnings.join(' ')).toMatch(
        new RegExp(`org1 reported values for mycc/${IMPLICIT}`),
      );
    });

    // Records without a member report still mean data is being carried, and a
    // row nobody can explain is exactly what has to reach the sign-off.
    test('reports an implicit collection that contributed records', async () => {
      const channels = [withImplicit()];
      const org1 = member({ memberId: 'org1', channels });
      const org2 = member({ memberId: 'org2', channels });
      writeRecords(org1, layout.privateHashesPath('ch1', 'mycc', IMPLICIT), [
        privateHash('k1', 1, 0, { collection: IMPLICIT }),
      ]);

      const report = await merge([org1, org2]);

      const row = report.channels[0].coverage.find(
        (r) => r.collection === IMPLICIT,
      );
      expect(row?.outcome).toBe('hashes-only');
      expect(row?.reason).toBe('indeterminate');
    });
  });

  test('writes the report to merge-report.json', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, STATE_PATH, [privateState('k1', 'v1')]);

    const report = await merge([org1, org2]);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(outputDir, 'merge-report.json'), 'utf-8'),
    );
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

// ── The merged directory as validate sees it ──

describe('validate on a merged directory', () => {
  test('refuses to merge a member whose authorized value is missing', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org3MSP' });
    // Written on chain and readable by org1's MSP, but org1 produced no value —
    // an unexplained gap no other member fills. Input validation refuses it
    // before the merge writes anything, rather than leaving it for a later
    // validate of the merged directory.
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /failed validation[\s\S]*org1[\s\S]*no value and no explanation/,
    );
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  test('excuses a missing value no contributing MSP was entitled to', async () => {
    const org1 = member({
      memberId: 'org1',
      mspId: 'Org8MSP',
      channels: [
        channel({
          chaincodes: [
            {
              name: 'mycc',
              version: '1.0',
              sequence: 1,
              collections: [
                collection({ policy: "OR('Org9MSP.member')" }),
              ],
            },
          ],
        }),
      ],
    });
    const org2 = member({
      memberId: 'org2',
      mspId: 'Org7MSP',
      channels: [
        channel({
          chaincodes: [
            {
              name: 'mycc',
              version: '1.0',
              sequence: 1,
              collections: [
                collection({ policy: "OR('Org9MSP.member')" }),
              ],
            },
          ],
        }),
      ],
    });
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);

    await merge([org1, org2]);
    const results = await runValidation(outputDir);

    const coverage = results.find((r) =>
      r.check.startsWith('Private value coverage'),
    );
    expect(coverage?.status).toBe('pass');
    expect(coverage?.details).toMatch(/expected-unauthorized/);
  });

  test('passes ordering validation on the merged history', async () => {
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
    writeRecords(org1, HISTORY_PATH, [
      privateHistory('k1', 1, 0),
      privateHistory('k1', 9, 0),
    ]);
    writeRecords(org2, HISTORY_PATH, [
      privateHistory('k2', 4, 0),
      privateHistory('k2', 6, 0),
    ]);

    await merge([org1, org2]);
    const results = await runValidation(outputDir);

    const ordering = results.filter((r) =>
      r.check.startsWith('Record ordering'),
    );
    expect(ordering.map((r) => r.check)).toContain(
      'Record ordering (ch1/private-mycc-col1-history.ndjson)',
    );
    expect(ordering.every((r) => r.status === 'pass')).toBe(true);
  });
});

// ── Integrity gates ──

/** SHA-256 hex, matching how the extractor hashes keys and values on chain. */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** A channel whose col1 collection admits only the named MSP. */
function authorizedChannel(policy: string): ChannelInfo {
  return channel({
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: [collection({ policy })],
      },
    ],
  });
}

describe('merge integrity gates', () => {
  // Requirement 1: every input is validated before any write.
  test('refuses a member whose private value fails its own hash cross-check',
    async () => {
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP' });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP' });
      writeRecords(org1, STATE_PATH, [privateState('asset1', 'CORRECT')]);
      writeRecords(org1, HASHES_PATH, [
        privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('WRONG') }),
      ]);

      await expect(merge([org1, org2])).rejects.toThrow(
        /failed validation[\s\S]*org1[\s\S]*Private data hashes/,
      );
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
    });

  // Requirement 2: shared records are compared canonically, not by file size.
  test('rejects public state whose records differ at equal byte length',
    async () => {
      const org1 = member({ memberId: 'org1' });
      const org2 = member({ memberId: 'org2' });
      // Same length, different bytes: a size check would accept these.
      writeRecords(org1, PUBLIC_STATE_PATH, [publicState('k1', 'AAAA')]);
      writeRecords(org2, PUBLIC_STATE_PATH, [publicState('k1', 'BBBB')]);

      await expect(merge([org1, org2])).rejects.toThrow(
        /disagree on ch1\/public-state\.ndjson/,
      );
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
    });

  // Requirement 2: private hashes are on-chain public data every member must
  // agree on.
  test('rejects members whose private hashes disagree', async () => {
    const org1 = member({ memberId: 'org1' });
    const org2 = member({ memberId: 'org2' });
    writeRecords(org1, HASHES_PATH, [
      privateHash('k1', 1),
      privateHash('k2', 2),
    ]);
    writeRecords(org2, HASHES_PATH, [
      privateHash('k1', 1),
      privateHash('k3', 2),
    ]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /disagree on ch1\/private-mycc-col1-hashes\.ndjson/,
    );
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  // Requirement 3: a value from one member is checked against the hash another
  // member recorded, before any write.
  test("refuses a value that contradicts another member's recorded hash",
    async () => {
      const channels = [authorizedChannel("OR('Org1MSP.member')")];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      // org1 alone is authorized and holds the value; org2 holds only the hash,
      // which is public. The value does not hash to what the ledger recorded.
      writeRecords(org1, STATE_PATH, [privateState('asset1', 'CORRECT')]);
      writeRecords(org2, HASHES_PATH, [
        privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('WRONG') }),
      ]);

      await expect(merge([org1, org2])).rejects.toThrow(
        /do not match the hash the ledger recorded[\s\S]*asset1[\s\S]*org1/,
      );
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
    });

  // Requirement 3: a value that does hash to the recorded value is accepted.
  test('accepts a value that matches another member\'s recorded hash',
    async () => {
      const channels = [authorizedChannel("OR('Org1MSP.member')")];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      writeRecords(org1, STATE_PATH, [privateState('asset1', 'CORRECT')]);
      writeRecords(org2, HASHES_PATH, [
        privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('CORRECT') }),
      ]);

      const report = await merge([org1, org2]);
      expect(report.channels[0].counts.privateState).toBe(1);
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(true);
    });

  // Requirement 4: the merged directory is validated as a whole, and its
  // manifest removed if it fails — catching a gap invisible to either member
  // alone.
  test('removes the manifest when the merged output fails validation',
    async () => {
      const channels = [authorizedChannel("OR('Org2MSP.member')")];
      const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
      const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
      // org1 is outside the policy, so its hashes-only view is expected on its
      // own. org2 is inside it but shipped no value. Neither member fails alone,
      // but the merged directory — which knows Org2MSP was entitled — has an
      // unexplained gap.
      writeRecords(org1, HASHES_PATH, [privateHash(sha256Hex('asset1'), 1)]);

      await expect(merge([org1, org2])).rejects.toThrow(
        /merged output failed validation[\s\S]*Private value coverage[\s\S]*no value and no explanation/,
      );
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
    });
});

// ── Private-only members ──
//
// A member extracted with --private-only carries its private values and no
// public data or hashes. The lead's full extraction supplies those, and the
// merge has to (a) take public data from the lead, (b) check the member's
// values against the lead's hashes, (c) refuse a channel nobody extracted in
// full, and (d) resolve the `indeterminate` a private-only member reports for
// a collection it was entitled to but delivered nothing for — from the hashes
// it could not see.

describe('merge with private-only members', () => {
  const ONLY_ORG2 = "OR('Org2MSP.member')";

  /** Metadata a --private-only extraction writes for ch1. */
  function privateOnlyMetadata(
    coverage: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return { ...coverageMetadata(coverage), scope: 'private-only' };
  }

  /** The lead: public state, and the channel's hashes for col1. */
  function lead(hashes: PrivateHashRecord[], reason = 'unauthorized'): string {
    const channels = [authorizedChannel(ONLY_ORG2)];
    const dir = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
    writeRecords(dir, PUBLIC_STATE_PATH, [publicState('pub1', 'p')]);
    if (hashes.length > 0) writeRecords(dir, HASHES_PATH, hashes);
    writeMetadata(dir, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1',
        coverage: hashes.length > 0 ? 'hashes-only' : 'absent',
        authorized: false, reason, blockToLive: 0,
        purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));
    return dir;
  }

  function privateOnlyMember(
    values: PrivateStateRecord[],
    memberId = 'org2',
  ): string {
    const channels = [authorizedChannel(ONLY_ORG2)];
    const dir = member({ memberId, mspId: 'Org2MSP', channels });
    if (values.length > 0) writeRecords(dir, STATE_PATH, values);
    writeMetadata(dir, 'ch1', privateOnlyMetadata([
      values.length > 0
        ? { chaincode: 'mycc', collection: 'col1', coverage: 'values',
            authorized: true, blockToLive: 0,
            purgeRisk: 'none', estimatedPurgedBlocks: 0 }
        : { chaincode: 'mycc', collection: 'col1', coverage: 'absent',
            authorized: true, reason: 'indeterminate', blockToLive: 0,
            purgeRisk: 'none', estimatedPurgedBlocks: 0 },
    ]));
    return dir;
  }

  test('takes public data from the full member and values from the private-only one', async () => {
    const org1 = lead([privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('V') })]);
    const org2 = privateOnlyMember([privateState('asset1', 'V')]);

    const report = await merge([org1, org2]);

    expect(report.ok).toBe(true);
    expect(report.channels[0].publicSource).toBe('org1');
    expect(await readOut(PUBLIC_STATE_PATH)).toHaveLength(1);
    expect(report.channels[0].coverage[0].contributedValues).toEqual(['org2']);
  });

  test("checks a private-only member's values against the full member's hashes", async () => {
    const org1 = lead([privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('V') })]);
    const org2 = privateOnlyMember([privateState('asset1', 'TAMPERED')]);

    await expect(merge([org1, org2])).rejects.toThrow(
      /do not match the hash the ledger recorded[\s\S]*asset1[\s\S]*org2/,
    );
  });

  test('refuses a channel every member extracted private-only', async () => {
    const org2 = privateOnlyMember([privateState('asset1', 'V')]);
    const org3 = privateOnlyMember([], 'org3');

    await expect(merge([org2, org3])).rejects.toThrow(
      /No full extraction of ch1[\s\S]*--private-only/,
    );
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });

  /**
   * The case the resolution exists for. The lead is not a member and reports
   * `unauthorized`; the entitled member delivered nothing for data the hashes
   * prove exists. The merged output's own validation refuses it, by key.
   */
  test('refuses when the entitled member delivered nothing the hashes prove exists', async () => {
    const org1 = lead([privateHash('k1', 1)]);
    const org2 = privateOnlyMember([]);

    await expect(merge([org1, org2])).rejects.toThrow(/no value and no explanation/);
  });

  /**
   * Where the hashes do explain the gap, the private-only member's
   * `indeterminate` must become the reason they support. Taken as given it
   * stops the sign-off over a loss the purge horizon accounts for; and the
   * sign-off form lists purge-window collections, which `unauthorized` (the
   * lead's reason) would leave this one out of.
   */
  test("resolves a private-only member's indeterminate to purge-window from the hashes", async () => {
    const channels = [channel({
      chaincodes: [{ name: 'mycc', version: '1.0', sequence: 1,
        collections: [collection({ policy: ONLY_ORG2, blockToLive: 5 })] }],
    })];
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
    writeRecords(org1, PUBLIC_STATE_PATH, [publicState('pub1', 'p')]);
    // Block 1 + 5 < height 10: past the horizon on every peer.
    writeRecords(org1, HASHES_PATH, [privateHash('k1', 1)]);
    writeMetadata(org1, 'ch1', coverageMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'hashes-only',
        authorized: false, reason: 'unauthorized', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
    writeMetadata(org2, 'ch1', privateOnlyMetadata([
      { chaincode: 'mycc', collection: 'col1', coverage: 'absent',
        authorized: true, reason: 'indeterminate', blockToLive: 5,
        purgeRisk: 'high', estimatedPurgedBlocks: 4 },
    ]));

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row.byMember.find((m) => m.member === 'org2')?.reason).toBe('purge-window');
    expect(row.reason).toBe('purge-window');
    expect(row.needsAttention).toBe(false);
  });

  test('resolves to never-written when no member saw a hash', async () => {
    const org1 = lead([], 'unauthorized');
    const org2 = privateOnlyMember([]);

    const report = await merge([org1, org2]);

    const row = report.channels[0].coverage[0];
    expect(row.outcome).toBe('absent');
    expect(row.byMember.find((m) => m.member === 'org2')?.reason).toBe('never-written');
    expect(row.needsAttention).toBe(false);
  });

  test('does not mark the merged channel private-only', async () => {
    const org1 = lead([privateHash(sha256Hex('asset1'), 1, 0, { hash: sha256Hex('V') })]);
    const org2 = privateOnlyMember([privateState('asset1', 'V')]);

    await merge([org1, org2]);

    const metadata = JSON.parse(fs.readFileSync(
      path.join(outputDir, layout.channelMetadataPath('ch1')), 'utf-8',
    ));
    expect(metadata).not.toHaveProperty('scope');
  });
});

// ── Late-joining members ──
//
// A member whose peer joined the channel after a private write never received that value or its history. Judged alone
// it has a gap; the members that were there hold it. merge judges each member with the others in view, and still
// validates the merged output whole.

describe('merge with a late-joining member', () => {
  const both = "OR('Org1MSP.member', 'Org2MSP.member')";
  const hashes = [
    privateHash(sha256Hex('k1'), 2, 0, { hash: sha256Hex('V1') }),
    privateHash(sha256Hex('k2'), 3, 0, { hash: sha256Hex('V2') }),
  ];

  function pair(): { org1: string; org2: string } {
    const channels = [authorizedChannel(both)];
    const org1 = member({ memberId: 'org1', mspId: 'Org1MSP', channels });
    const org2 = member({ memberId: 'org2', mspId: 'Org2MSP', channels });
    for (const dir of [org1, org2]) writeRecords(dir, HASHES_PATH, hashes);
    writeRecords(org1, STATE_PATH, [privateState('k1', 'V1'), privateState('k2', 'V2')]);
    writeRecords(org1, HISTORY_PATH, [privateHistory('k1', 2, 0, { value: 'V1' }), privateHistory('k2', 3, 0, { value: 'V2' })]);
    // org2 joined after block 2: it has k2 only, and no history for block 2
    writeRecords(org2, STATE_PATH, [privateState('k2', 'V2')]);
    writeRecords(org2, HISTORY_PATH, [privateHistory('k2', 3, 0, { value: 'V2' })]);
    return { org1, org2 };
  }

  test('merges, and the merged output holds every value', async () => {
    const { org1, org2 } = pair();
    const report = await merge([org1, org2]);
    expect(report.channels[0].counts.privateState).toBe(2);
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(true);
  });

  test('the late joiner alone still fails validate (standalone checks are unchanged)', async () => {
    const { org2 } = pair();
    const results = await runValidation(org2);
    expect(results.filter((r) => r.status === 'fail').map((r) => r.check)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Private value coverage/), expect.stringMatching(/^Private history completeness/)]),
    );
    // and each failure says how to account for a late join
    for (const r of results.filter((x) => x.status === 'fail' && /^Private (value coverage|history completeness)/.test(x.check))) {
      expect(r.details).toMatch(/--other-members/);
    }
  });

  test('accounts for the gaps in the report details when others hold them', async () => {
    const { org1, org2 } = pair();
    const results = await runValidation(org2, undefined, { otherMembers: [org1] });
    const cov = results.find((r) => r.check.startsWith('Private value coverage'))!;
    const hist = results.find((r) => r.check.startsWith('Private history completeness'))!;
    expect(cov.status).toBe('pass');
    expect(cov.details).toMatch(/held-by-other-member/);
    expect(hist.status).toBe('pass');
    expect(hist.message).toMatch(/held by another member/);
  });

  test('still refuses when no member holds the value or the history', async () => {
    const { org1, org2 } = pair();
    // org1 loses k1's value and history too: nobody holds block 2
    writeRecords(org1, STATE_PATH, [privateState('k2', 'V2')]);
    writeRecords(org1, HISTORY_PATH, [privateHistory('k2', 3, 0, { value: 'V2' })]);
    await expect(merge([org1, org2])).rejects.toThrow(/failed validation[\s\S]*(no value and no explanation|missing from private history)/);
    expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(false);
  });
});

describe('merge carries the extension record for replay --since', () => {
  const ext = (fromBlock: number) => [{ fromBlock, toLedgerHeight: 10, extractedAt: '2026-01-01T00:00:00.000Z' }];
  const tip = { blockNumber: 9, headerHash: 'ab'.repeat(32) };
  function pairWith(e1: unknown, e2: unknown): string[] {
    const dirs = [member({ memberId: 'm1', mspId: 'Org1MSP' }), member({ memberId: 'm2', mspId: 'Org2MSP' })];
    dirs.forEach((d, i) => writeMetadata(d, 'ch1', { ...defaultChannelMetadata(channel()), walkTip: tip, extensions: i === 0 ? e1 : e2 }));
    return dirs;
  }
  const mergedMeta = () => JSON.parse(fs.readFileSync(path.join(outputDir, layout.channelMetadataPath('ch1')), 'utf-8'));

  test('when every member extended from the same height', async () => {
    await merge(pairWith(ext(7), ext(7)));
    expect(mergedMeta().extensions).toEqual(ext(7));
    expect(mergedMeta().walkTip).toEqual(tip);
  });

  test('not when members extended from different heights', async () => {
    await merge(pairWith(ext(7), ext(8)));
    expect(mergedMeta().extensions).toBeUndefined();
  });
});
