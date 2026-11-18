// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { writtenKeys } from './helpers/state-batch';
import { checkpointFileName } from '../src/replay/replay-checkpoint-manager';
import { computePlanDigest } from '../src/replay/history-import/plan-digest';
import {
  FN_GET_RECEIPT,
  FN_INITIALIZE,
  FN_PROTOCOL,
  HISTORY_ENTRY_TRANSIENT,
  PROTOCOL_VERSION,
  PUBLIC_HISTORY_BATCH_TRANSIENT,
} from '../src/replay/history-import/protocol';

// Orchestration-level acceptance coverage for resilient, idempotent Tier 3
// history replay. The protocol wire primitives, config validation, the receipt
// parser, the pre-flight probe, and the replayer's reconciliation are proved in
// history-import.test.ts against stubs; the shipped contract's own framing in
// migration-contract.test.ts; and legacy append-only history in
// replay-failure-report.test.ts. This suite drives the whole ReplayOrchestrator
// with a mocked destination and proves the orchestration-level guarantees the
// feat/resilient-history-replay branch adds:
//
//  1. A resilient history failure stops the current history file before a later
//     outer input batch is submitted, freezes the normal checkpoint at the last
//     safe batch, and — unlike legacy history — leaves no dirtyFile marker and
//     no historyAborted.
//  2. A fresh run with the cause fixed resumes from that frozen checkpoint
//     (it does not re-submit the writes already checkpointed) and clears the
//     checkpoint on clean completion.
//  3. The legacy replayHistory path, by contrast, still marks the checkpoint
//     dirty and aborts (also covered in full by replay-failure-report.test.ts).
//
// Plus plan-digest binding: the source network and the history file bytes are
// part of the plan, and writeBatchSize is deliberately not.

// ── Mocks ──

/** Ledger keys whose submission should reject, simulating a lost commit. */
const failingKeys = new Set<string>();

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

/**
 * Decode the framed public-history batch (`ImportHistoryBatch` transient) into
 * its keys, mirroring `frameHistoryBatch`: a uint32 count, then per entry 32
 * raw operation-ID bytes, 32 raw intent bytes, then `keyLen | key | flag |
 * valueLen | value`.
 */
function decodeHistoryBatch(framed: Buffer): string[] {
  const keys: string[] = [];
  const count = framed.readUInt32BE(0);
  let pos = 4;
  for (let i = 0; i < count; i++) {
    pos += 64; // operation ID (32) + intent (32)
    const keyLen = framed.readUInt32BE(pos);
    pos += 4;
    keys.push(framed.subarray(pos, pos + keyLen).toString('utf-8'));
    pos += keyLen;
    pos += 1; // write/delete flag
    const valueLen = framed.readUInt32BE(pos);
    pos += 4 + valueLen;
  }
  return keys;
}

/**
 * Decode the single-mutation envelope (`ImportHistory` transient) to its key,
 * mirroring `frameHistoryEnvelope`: `kind | collLen | coll | keyLen | key |
 * valueLen | value`.
 */
function decodeHistoryEnvelope(framed: Buffer): string {
  let pos = 1; // kind
  const collLen = framed.readUInt32BE(pos);
  pos += 4 + collLen;
  const keyLen = framed.readUInt32BE(pos);
  pos += 4;
  return framed.subarray(pos, pos + keyLen).toString('utf-8');
}

/**
 * The ledger keys one proposal writes, across both the resilient and legacy
 * framings. Protocol control calls that carry no key (`InitializeHistoryImport`)
 * contribute nothing, so the flattened stream is exactly the writes attempted.
 */
function keysOf(fn: string, opts: { arguments: string[]; transientData?: Record<string, Uint8Array> }): string[] {
  if (fn === FN_INITIALIZE) return [];
  const t = opts.transientData;
  const batch = t?.[PUBLIC_HISTORY_BATCH_TRANSIENT];
  if (batch) return decodeHistoryBatch(Buffer.from(batch));
  const entry = t?.[HISTORY_ENTRY_TRANSIENT];
  if (entry) return [decodeHistoryEnvelope(Buffer.from(entry))];
  return writtenKeys(opts.arguments, t);
}

/**
 * The destination migration contract.
 *
 * Reads dispatch on the function name: the write pre-flight probes `ListKeys`,
 * the resilient pre-flight probes `HistoryImportProtocol`, and reconciliation
 * after a failed submit reads `GetHistoryImportReceipt`. The receipt is always
 * absent here — a failed `ImportHistoryBatch` leaves no receipt behind — so
 * reconciliation is "recoverable" and the failure is preserved, which is what
 * freezes the checkpoint and keeps the run safe to resume.
 *
 * Writes are newProposal → endorse → submit → getStatus. A proposal carrying a
 * key in `failingKeys` rejects at endorse, and every key it carried fails with
 * it — one batched transaction lands all of its keys or none.
 */
const mockContract = {
  evaluateTransaction: jest.fn(async (fn: string) => {
    if (fn === FN_PROTOCOL) {
      return Buffer.from(JSON.stringify({ protocol: PROTOCOL_VERSION }), 'utf-8');
    }
    if (fn === FN_GET_RECEIPT) {
      return Buffer.from(JSON.stringify({ exists: false }), 'utf-8');
    }
    // ListKeys and any other read: an empty page of keys.
    return Buffer.from(JSON.stringify({ keys: [], bookmark: '' }), 'utf-8');
  }),
  newProposal: jest.fn((fn: string, opts: any) => ({
    endorse: async () => {
      const rejected = keysOf(fn, opts).find((key) => failingKeys.has(key));
      if (rejected !== undefined) {
        throw new Error(`destination rejected ${rejected}`);
      }
      return {
        submit: async () => ({ getStatus: async () => COMMITTED }),
      };
    },
  })),
};

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    getGatewayNetwork: jest.fn(() => ({
      getContract: jest.fn(() => mockContract),
    })),
    disconnect: jest.fn(),
  })),
}));

/**
 * One chaincode, committed on every destination with no collections in scope —
 * so a failure in these runs is the submission failing, not the pre-flight
 * refusing.
 */
jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => [{
      name: 'mycc',
      version: '1.0',
      sequence: 1,
      collections: [],
    }]),
  })),
}));

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

let tmpDir: string;
let layout: FileLayoutManager;
let keyFile: string;

/** Scope: 32 lowercase hex characters. */
const SCOPE = 'ab'.repeat(16);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resilient-history-'));
  layout = new FileLayoutManager(tmpDir);
  keyFile = path.join(tmpDir, 'history.key');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 7)); // 32 raw HMAC bytes
  failingKeys.clear();
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const CHAINCODE_CONFIG = {
  connectionProfilePath: 'profile.json',
  mspId: 'Org1MSP',
  certPath: 'cert.pem',
  keyPath: 'key.pem',
  keyMapping: {},
};

function writeManifest(channelIds: string[]): void {
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb: 'CouchDB',
      extractedAt: '2026-01-01T00:00:00.000Z',
      channels: channelIds.map((channelId) => ({
        channelId,
        chaincodes: [],
        ledgerHeight: 1,
      })),
    }),
    'utf-8',
  );
}

function writeRecords(relativePath: string, records: ExtractionRecord[]): void {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function publicHistory(
  key: string,
  value: string,
  blockNumber: number,
  channel = 'ch1',
): ExtractionRecord {
  return {
    _type: 'public_history',
    channel,
    chaincode: 'mycc',
    key,
    value,
    txId: `tx-${blockNumber}`,
    txIndex: 0,
    blockNumber,
    timestamp: '2026-01-01T00:00:00Z',
    isDelete: false,
    creator: {
      mspId: 'Org1MSP',
      commonName: 'admin',
      org: 'org1',
      certFingerprint: 'fp1',
    },
  };
}

/** Six history writes to distinct keys, one per block, in order. */
function historyFile(): ExtractionRecord[] {
  return [1, 2, 3, 4, 5, 6].map((n) => publicHistory(`h${n}`, `hv${n}`, n));
}

function checkpointPath(): string {
  return path.join(tmpDir, checkpointFileName('chaincode'));
}

function readCheckpoint(): any {
  return JSON.parse(fs.readFileSync(checkpointPath(), 'utf-8'));
}

function checkpointExists(): boolean {
  return fs.existsSync(checkpointPath());
}

/**
 * Every ledger key the destination was asked to write, in order, flattened
 * across proposals. One transaction can carry several keys; what these tests
 * assert is which writes reached the destination, not how they were framed.
 */
function submittedKeys(): string[] {
  return mockContract.newProposal.mock.calls.flatMap(
    (c: any) => keysOf(c[0], c[1]),
  );
}

function baseConfig(
  overrides: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
): ReplayConfig {
  return {
    adapter: 'chaincode',
    inputDir: tmpDir,
    batchSize: 2,
    chaincode: {
      ...CHAINCODE_CONFIG,
      channelMapping: { ch1: 'dest1' },
      ...overrides,
    },
  };
}

/** Resilient idempotent history replay config. */
function resilientConfig(
  overrides: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
): ReplayConfig {
  return baseConfig({
    replayHistory: true,
    historyImport: { mode: 'idempotent-v1', scope: SCOPE, keyPath: keyFile },
    ...overrides,
  });
}

/** Legacy (non-resilient) history replay config. */
function legacyHistoryConfig(): ReplayConfig {
  return baseConfig({ replayHistory: true });
}

// ── Resilient idempotent history replay ──

describe('resilient idempotent Tier 3 history replay', () => {
  it('stops before the next outer batch and freezes the checkpoint without a dirty marker', async () => {
    // batchSize 2 over six records: [h1,h2] clean, [h3,h4] fails its
    // ImportHistoryBatch, [h5,h6] must never be dispatched.
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');

    const summary = await new ReplayOrchestrator(resilientConfig()).run();

    // The later outer batch never reached the destination.
    expect(submittedKeys()).toEqual(['h1', 'h2', 'h3', 'h4']);
    // The receipt was consulted after the failed submit and found absent.
    expect(mockContract.evaluateTransaction).toHaveBeenCalledWith(
      FN_GET_RECEIPT, SCOPE, expect.any(String),
    );

    // Checkpoint frozen at the last safe batch (h1,h2), and retained.
    expect(checkpointExists()).toBe(true);
    const cp = readCheckpoint();
    expect(cp.recordsCompleted).toBe(2);
    expect(cp.lastFile).toBe('ch1/public-history');

    // Resilient replay is resumable, so neither the dirty marker nor the abort
    // that the legacy path leaves is set.
    expect(cp.dirtyFile).toBeUndefined();
    expect(summary.historyAborted).toBeUndefined();
    expect(summary.totalFailed).toBeGreaterThan(0);
  });

  it('resumes from the frozen checkpoint on a re-run and clears it on completion', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());

    // First run fails at the second outer batch, freezing the checkpoint.
    failingKeys.add('h3');
    await new ReplayOrchestrator(resilientConfig()).run();
    expect(readCheckpoint().recordsCompleted).toBe(2);

    // Cause fixed. A fresh orchestrator does not refuse (there is no dirty
    // marker to refuse on) and resumes from the checkpoint.
    failingKeys.clear();
    jest.clearAllMocks();
    const summary = await new ReplayOrchestrator(resilientConfig()).run();

    // h1 and h2 were already checkpointed, so they are not written again; the
    // run picks up at h3 and finishes the file.
    expect(summary.totalFailed).toBe(0);
    expect(submittedKeys()).toEqual(['h3', 'h4', 'h5', 'h6']);
    // A clean completion clears the checkpoint.
    expect(checkpointExists()).toBe(false);
  });

  it('legacy replayHistory still marks the checkpoint dirty and aborts', async () => {
    // The contrast case, covered fully in replay-failure-report.test.ts: with
    // the same records and the same failure but no historyImport, the run is
    // append-only, so it marks the checkpoint dirty and reports historyAborted.
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');

    const summary = await new ReplayOrchestrator(legacyHistoryConfig()).run();

    expect(summary.historyAborted).toBe('ch1/public-history');
    expect(readCheckpoint().dirtyFile).toBe('ch1/public-history');

    // And a later run refuses to resume over the partial destination history.
    failingKeys.clear();
    jest.clearAllMocks();
    await expect(
      new ReplayOrchestrator(legacyHistoryConfig()).run(),
    ).rejects.toThrow(/stopped part-way through ch1\/public-history/);
    expect(mockContract.newProposal).not.toHaveBeenCalled();
  });

  it('refuses to resume a legacy history replay that was killed mid-batch', async () => {
    // A run killed inside a batch leaves the write-ahead marker. Whether the batch
    // landed is unknown, so resending it could duplicate history: refuse, for the
    // legacy path and for the protocol alike.
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');
    await new ReplayOrchestrator(legacyHistoryConfig()).run();
    const cp = readCheckpoint();
    delete cp.dirtyFile;
    cp.inFlight = 'ch1/public-history';
    fs.writeFileSync(checkpointPath(), JSON.stringify(cp));

    failingKeys.clear();
    jest.clearAllMocks();
    await expect(new ReplayOrchestrator(legacyHistoryConfig()).run()).rejects.toThrow(/stopped while a batch of ch1\/public-history was being written/);
    await expect(new ReplayOrchestrator(resilientConfig()).run()).rejects.toThrow(/stopped while a batch of ch1\/public-history was being written/);
    expect(mockContract.newProposal).not.toHaveBeenCalled();
  });

  it('clears the write-ahead marker after every completed legacy batch', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');
    await new ReplayOrchestrator(legacyHistoryConfig()).run();
    // Stopped by a counted failure: the dirty marker says so, and no batch is left in flight.
    expect(readCheckpoint().dirtyFile).toBe('ch1/public-history');
    expect(readCheckpoint().inFlight).toBeUndefined();
  });

  it('refuses to put receipts over a dirty legacy history attempt', async () => {
    // A legacy transaction that may already have landed has no receipt. Turning
    // the protocol on cannot retroactively identify it, so accepting this
    // checkpoint would append duplicates under fresh receipts.
    writeManifest(['ch1']);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');
    await new ReplayOrchestrator(legacyHistoryConfig()).run();
    expect(readCheckpoint().dirtyFile).toBe('ch1/public-history');

    failingKeys.clear();
    jest.clearAllMocks();
    await expect(
      new ReplayOrchestrator(resilientConfig()).run(),
    ).rejects.toThrow(/stopped part-way through ch1\/public-history/);
    expect(mockContract.newProposal).not.toHaveBeenCalled();
  });
});

// ── Plan-digest binding ──

describe('resilient history-import plan digest', () => {
  const context = {
    mode: PROTOCOL_VERSION as typeof PROTOCOL_VERSION,
    scope: SCOPE,
    key: Buffer.alloc(32, 7),
  };
  const pairs = [{ channel: 'ch1', destChannel: 'dest1' }];

  function ccConfig(
    overrides: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
  ): NonNullable<ReplayConfig['chaincode']> {
    return { ...CHAINCODE_CONFIG, channelMapping: { ch1: 'dest1' }, ...overrides };
  }

  function digest(opts: {
    sourceNetworkId?: string;
    ccConfig?: NonNullable<ReplayConfig['chaincode']>;
  } = {}): Promise<string> {
    return computePlanDigest({
      context,
      ccConfig: opts.ccConfig ?? ccConfig(),
      layout,
      pairs,
      sourceNetworkId: opts.sourceNetworkId ?? 'nd-TEST',
    });
  }

  beforeEach(() => {
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
  });

  it('changes when the source network changes', async () => {
    const a = await digest({ sourceNetworkId: 'nd-ONE' });
    const b = await digest({ sourceNetworkId: 'nd-TWO' });

    expect(a).not.toBe(b);
  });

  it('changes when the history file bytes change', async () => {
    const before = await digest();

    // Same file, different contents: a new write appended to the history.
    writeRecords(layout.publicHistoryPath('ch1'), [
      ...historyFile(),
      publicHistory('h7', 'hv7', 7),
    ]);
    const after = await digest();

    expect(after).not.toBe(before);
  });

  it('does not change when only writeBatchSize changes', async () => {
    const small = await digest({ ccConfig: ccConfig({ writeBatchSize: 10 }) });
    const large = await digest({ ccConfig: ccConfig({ writeBatchSize: 500 }) });

    expect(small).toBe(large);
  });
});
