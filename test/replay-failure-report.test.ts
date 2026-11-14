import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { writtenKeys } from './helpers/state-batch';

// ── Mocks ──

/** Ledger keys whose submission should reject. */
const failingKeys = new Set<string>();

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

/**
 * The destination contract.
 *
 * Every write is newProposal → endorse → submit → getStatus, because values
 * travel as transient data and `submitTransaction` cannot carry any.
 *
 * A batched public write carries its keys in the transient blob rather than in
 * its arguments, and rejecting one rejects the transaction — so every key the
 * batch carried fails with it, which is what the reports below are of.
 */
const mockContract = {
  /** What the write pre-flight's probe of the migration contract answers. */
  evaluateTransaction: jest.fn(
    async () => Buffer.from('{"keys":[],"bookmark":""}', 'utf-8'),
  ),
  newProposal: jest.fn((_fn: string, opts: any) => ({
    endorse: async () => {
      const keys = writtenKeys(opts.arguments, opts.transientData);
      const rejected = keys.find((key) => failingKeys.has(key));
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
 * The one chaincode these runs replay, committed on every destination with the
 * one collection they write — so a failure here is the submission failing, not
 * the pre-flight refusing.
 */
jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => [{
      name: 'mycc',
      version: '1.0',
      sequence: 1,
      collections: [{
        name: 'col1',
        policy: "OR('Org1MSP.member')",
        requiredPeerCount: 0,
        maxPeerCount: 1,
        blockToLive: 0,
        memberOnlyRead: true,
        memberOnlyWrite: true,
      }],
    }]),
  })),
}));

import { ChaincodeAdapter } from '../src/replay/adapters/chaincode-adapter';
import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';
import { checkpointFileName } from '../src/replay/replay-checkpoint-manager';

// ── Fixtures ──

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-failure-test-'));
  layout = new FileLayoutManager(tmpDir);
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

function writeRecords(
  relativePath: string,
  records: ExtractionRecord[],
): void {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function publicState(key: string, value: string): ExtractionRecord {
  return {
    _type: 'public_state',
    channel: 'ch1',
    chaincode: 'mycc',
    key,
    value,
  };
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

function checkpointPath(): string {
  return path.join(tmpDir, checkpointFileName('chaincode'));
}

function readCheckpoint(): any {
  return JSON.parse(fs.readFileSync(checkpointPath(), 'utf-8'));
}

function chaincodeConfig(
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

function readFailureReport(): any[] {
  const reportPath = path.join(tmpDir, 'replay-failures.ndjson');
  return fs
    .readFileSync(reportPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function checkpointExists(): boolean {
  return fs.existsSync(checkpointPath());
}

// ── Concurrency validation ──

describe('ChaincodeAdapter concurrency validation', () => {
  const network = { getContract: () => mockContract } as any;

  it('rejects a concurrency of 0, which would replay nothing', () => {
    expect(
      () => new ChaincodeAdapter(network, {
        ...CHAINCODE_CONFIG, channel: 'dest1', concurrency: 0,
      }),
    ).toThrow(/concurrency must be an integer >= 1, got: 0/);
  });

  it('rejects a fractional concurrency', () => {
    expect(
      () => new ChaincodeAdapter(network, {
        ...CHAINCODE_CONFIG, channel: 'dest1', concurrency: 1.5,
      }),
    ).toThrow(/must be an integer/);
  });

  it('defaults to sequential submission when unset', async () => {
    const adapter = new ChaincodeAdapter(network, {
      ...CHAINCODE_CONFIG, channel: 'dest1',
    });
    await adapter.replayBatch([publicState('k1', 'v1')]);
    expect(adapter.getStats().totalReplayed).toBe(1);
  });
});

// ── Failure reporting ──

describe('replay failure reporting', () => {
  it('reports failed records, writes a report, and keeps the checkpoint', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
      publicState('k3', 'v3'),
      publicState('k4', 'v4'),
    ]);
    failingKeys.add('k3');

    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    expect(summary.totalFailed).toBeGreaterThan(0);
    // k3 and k4 are the second replay batch, so they are one transaction, and a
    // transaction the destination rejects lands none of what it carried. Both
    // keys are reported: k4's value is as absent as k3's, and a report naming
    // only the key the peer complained about would leave it looking replayed.
    expect(summary.failures.map((f) => f.key)).toEqual(['k3', 'k4']);
    expect(summary.failures[0]).toMatchObject({
      channel: 'ch1',
      chaincode: 'mycc',
      key: 'k3',
    });
    expect(summary.failures[0].error).toContain('destination rejected k3');
    expect(summary.failureReportPath).toBe(
      path.join(tmpDir, 'replay-failures.ndjson'),
    );
    expect(readFailureReport()).toHaveLength(2);
    expect(checkpointExists()).toBe(true);
  });

  it('does not advance the checkpoint past a batch that failed', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
      publicState('k3', 'v3'),
      publicState('k4', 'v4'),
    ]);
    failingKeys.add('k3');

    await new ReplayOrchestrator(chaincodeConfig()).run();

    const checkpoint = readCheckpoint();
    // Batch size is 2, so the first batch (k1, k2) is the last clean one.
    expect(checkpoint.recordsCompleted).toBe(2);
  });

  it('records the collection for a failed private state write', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      {
        _type: 'private_state',
        channel: 'ch1',
        chaincode: 'mycc',
        collection: 'col1',
        key: 'pk1',
        value: 'pv1',
      },
    ]);
    failingKeys.add('pk1');

    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      channel: 'ch1',
      chaincode: 'mycc',
      collection: 'col1',
      key: 'pk1',
    });
  });

  it('clears the checkpoint and writes no report on a clean run', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
    ]);

    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    expect(summary.totalFailed).toBe(0);
    expect(summary.totalReplayed).toBe(2);
    expect(summary.failureReportPath).toBeUndefined();
    expect(checkpointExists()).toBe(false);
    expect(
      fs.existsSync(path.join(tmpDir, 'replay-failures.ndjson')),
    ).toBe(false);
  });

  it('reports channels that channelMapping does not cover', async () => {
    writeManifest(['ch1', 'ch2']);
    writeRecords(layout.publicStatePath('ch1'), [publicState('k1', 'v1')]);
    writeRecords(layout.publicStatePath('ch2'), [publicState('k9', 'v9')]);

    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    expect(summary.skippedChannels).toEqual(['ch2']);
    expect(summary.totalReplayed).toBe(1);
  });
});

// ── Tier 3 append-only history ──

describe('append-only history replay', () => {
  /** Six history writes to distinct keys, ordered by block. */
  function historyFile(): ExtractionRecord[] {
    return [1, 2, 3, 4, 5, 6].map((n) => publicHistory(`h${n}`, `hv${n}`, n));
  }

  function historyConfig(): ReplayConfig {
    return chaincodeConfig({ replayHistory: true });
  }

  /**
   * The ledger keys the adapter attempted, in order, including failed ones.
   *
   * One submission can carry several keys, so this flattens: what matters to
   * these tests is which writes reached the destination, not how many
   * transactions carried them.
   */
  function keysSubmitted(): string[] {
    return mockContract.newProposal.mock.calls.flatMap(
      (c) => writtenKeys(c[1].arguments, c[1].transientData),
    );
  }

  it('submits no further batches once a history batch fails', async () => {
    // Each replayed write appends a destination history entry, so records after
    // a failure would land out of order behind a gap. The stop is at replay
    // batch granularity: the writes alongside the failing one were already in
    // flight — here, in the same transaction — but the next batch never starts.
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');

    const summary = await new ReplayOrchestrator(historyConfig()).run();

    // Batch size 2: [h1,h2] clean, [h3,h4] fails, [h5,h6] never dispatched.
    expect(summary.historyAborted).toBe('ch1/public-history');
    expect(keysSubmitted()).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('counts the writes skipped behind a failed one as failures too', async () => {
    // A key's queue stops at its first failure, so the writes behind it never
    // reach the destination. They are missing records, not skipped work, so
    // totalFailed covers them and the report says how many there were.
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), [
      publicHistory('h1', 'hv1', 1),
      publicHistory('h1', 'hv2', 2),
      publicHistory('h1', 'hv3', 3),
      publicHistory('h2', 'hv4', 4),
    ]);
    failingKeys.add('h1');

    // One replay batch, so all three h1 writes share a queue.
    const summary = await new ReplayOrchestrator({
      ...historyConfig(),
      batchSize: 4,
    }).run();

    // h1's first write and h2's only one are the heads of their queues in the
    // same round, so one transaction carries both and h2 fails with h1. Only
    // h1 has writes behind it, and only h1's entry counts any as skipped.
    const report = readFailureReport();
    expect(report.map((r) => r.key)).toEqual(['h1', 'h2']);
    expect(report[0]).toMatchObject({ key: 'h1', skippedAfter: 2 });
    expect(report[1]).toMatchObject({ key: 'h2', skippedAfter: 0 });
    const skipped = report.reduce((n, r) => n + r.skippedAfter, 0);
    expect(summary.totalFailed).toBe(report.length + skipped);
    expect(keysSubmitted()).toEqual(['h1', 'h2']);
  });

  it('makes the abort durable in the checkpoint', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');

    await new ReplayOrchestrator(historyConfig()).run();

    expect(readCheckpoint().dirtyFile).toBe('ch1/public-history');
  });

  it('skips the remaining history files once one has aborted', async () => {
    // The destination needs a reset either way, so further writes only add to
    // what the operator has to discard.
    writeManifest(['ch1', 'ch2']);
    for (const ch of ['ch1', 'ch2']) {
      writeRecords(layout.publicStatePath(ch), []);
      writeRecords(layout.publicHistoryPath(ch), [
        publicHistory('h1', 'hv1', 1, ch),
        publicHistory('h2', 'hv2', 2, ch),
      ]);
    }
    failingKeys.add('h1');

    const summary = await new ReplayOrchestrator(
      chaincodeConfig({
        replayHistory: true,
        channelMapping: { ch1: 'dest1', ch2: 'dest2' },
      }),
    ).run();

    expect(summary.historyAborted).toBe('ch1/public-history');
    // Only ch1's first batch was submitted; ch2's history never started.
    expect(keysSubmitted()).toEqual(['h1', 'h2']);
  });

  it('refuses to start a later run while the checkpoint is dirty', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');
    await new ReplayOrchestrator(historyConfig()).run();

    // Cause fixed, but the destination still holds the partial history.
    failingKeys.clear();
    jest.clearAllMocks();

    await expect(new ReplayOrchestrator(historyConfig()).run()).rejects.toThrow(
      /stopped part-way through ch1\/public-history/,
    );
    expect(mockContract.newProposal).not.toHaveBeenCalled();
  });

  it('names the recovery steps in the refusal', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h3');
    await new ReplayOrchestrator(historyConfig()).run();

    const run = new ReplayOrchestrator(historyConfig()).run();
    await expect(run).rejects.toThrow(/replay-failures\.ndjson/);
    await expect(
      new ReplayOrchestrator(historyConfig()).run(),
    ).rejects.toThrow(checkpointPath());
  });

  it('keeps the dirty marker when progress is checkpointed again', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [publicState('k1', 'v1')]);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());
    failingKeys.add('h1');

    await new ReplayOrchestrator(historyConfig()).run();

    // public-state replays cleanly and updates the checkpoint after the
    // history file is marked dirty; the marker has to survive that write.
    expect(readCheckpoint().dirtyFile).toBe('ch1/public-history');
  });

  it('does not abort or mark dirty when only state is replayed', async () => {
    // Overwriting a key is idempotent, so a state-only run is safe to resume:
    // it carries on past a failure and retries from the last clean batch.
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
      publicState('k3', 'v3'),
      publicState('k4', 'v4'),
    ]);
    failingKeys.add('k3');

    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    expect(summary.historyAborted).toBeUndefined();
    expect(readCheckpoint().dirtyFile).toBeUndefined();
    expect(keysSubmitted()).toEqual(['k1', 'k2', 'k3', 'k4']);
  });

  it('lets a state-only run resume after the cause is fixed', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('k1', 'v1'),
      publicState('k2', 'v2'),
      publicState('k3', 'v3'),
      publicState('k4', 'v4'),
    ]);
    failingKeys.add('k3');
    await new ReplayOrchestrator(chaincodeConfig()).run();

    failingKeys.clear();
    jest.clearAllMocks();
    const summary = await new ReplayOrchestrator(chaincodeConfig()).run();

    // Resumes from the last clean batch, so k1/k2 are not rewritten.
    expect(summary.totalFailed).toBe(0);
    expect(keysSubmitted()).toEqual(['k3', 'k4']);
    expect(checkpointExists()).toBe(false);
  });

  it('starts a clean run when no file has aborted', async () => {
    writeManifest(['ch1']);
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), historyFile());

    const summary = await new ReplayOrchestrator(historyConfig()).run();

    expect(summary.historyAborted).toBeUndefined();
    expect(summary.totalReplayed).toBe(6);
    expect(checkpointExists()).toBe(false);
  });
});
