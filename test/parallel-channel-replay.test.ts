import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';

// ── Mocks ──
//
// A destination whose channels are told apart by name, so a test can see which
// channel each write reached, hold one channel's writes back to observe overlap,
// and make one channel's writes fail.

const writes: Array<{ destChannel: string; key: string }> = [];
let inFlight = 0;
let peakInFlight = 0;
/** Destination channels whose writes fail. */
const failing = new Set<string>();
/** Milliseconds each write takes, so channels overlap when run together. */
let writeDelayMs = 0;

const COMMITTED = { successful: true, code: 0, blockNumber: 1n, transactionId: 'tx' };
const EMPTY_KEY_PAGE = Buffer.from('{"keys":[],"bookmark":""}', 'utf-8');

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => ({
    connect: jest.fn(async () => undefined),
    getGatewayNetwork: jest.fn((destChannel: string) => ({
      getContract: jest.fn(() => ({
        evaluateTransaction: jest.fn(async () => EMPTY_KEY_PAGE),
        newProposal: jest.fn((_fn: string, opts: { arguments: string[] }) => ({
          endorse: async () => ({
            submit: async () => {
              inFlight++;
              peakInFlight = Math.max(peakInFlight, inFlight);
              await new Promise((r) => setTimeout(r, writeDelayMs));
              inFlight--;
              if (failing.has(destChannel)) throw new Error('endorsement refused');
              writes.push({ destChannel, key: opts.arguments[opts.arguments.length - 1] });
              return { getStatus: async () => COMMITTED };
            },
          }),
        })),
      })),
    })),
    disconnect: jest.fn(),
  })),
}));

jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => [
      {
        name: 'cc', version: '1.0', sequence: 1,
        collections: [{
          name: 'col', policy: "OR('Org1MSP.member')", requiredPeerCount: 0,
          maxPeerCount: 1, blockToLive: 0, memberOnlyRead: true, memberOnlyWrite: true,
        }],
      },
    ]),
  })),
}));

jest.mock('../src/utils/logger', () => {
  const noop = (): void => {};
  const make = () => ({
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

const CHANNELS = ['ch-a', 'ch-b', 'ch-c'];

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-replay-'));
  layout = new FileLayoutManager(tmpDir);
  writes.length = 0;
  inFlight = 0;
  peakInFlight = 0;
  failing.clear();
  writeDelayMs = 0;
  jest.clearAllMocks();

  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
    networkId: 'nd-TEST', memberId: 'm-TEST', region: 'us-east-1',
    stateDb: 'CouchDB', extractedAt: '2026-01-01T00:00:00.000Z',
    channels: CHANNELS.map((channelId) => ({ channelId, chaincodes: [], ledgerHeight: 1 })),
  }));
  for (const channel of CHANNELS) {
    // One key, three versions: the per-key order is what must survive.
    const records: ExtractionRecord[] = [1, 2, 3].map((n) => ({
      _type: 'public_history', channel, chaincode: 'cc', key: `${channel}-k`,
      value: `v${n}`, txId: `t${n}`, txIndex: 0, blockNumber: n,
      timestamp: '', isDelete: false,
    } as ExtractionRecord));
    const full = path.join(tmpDir, layout.publicHistoryPath(channel));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // A second history file, so a channel has a file to start after another
    // channel has already failed.
    const priv: ExtractionRecord = {
      _type: 'private_history', channel, chaincode: 'cc', collection: 'col',
      key: `${channel}-p`, value: 'pv', txId: 'tp', txIndex: 0, blockNumber: 4,
      timestamp: '', isDelete: false,
    } as ExtractionRecord;
    fs.writeFileSync(
      path.join(tmpDir, layout.privateHistoryPath(channel, 'cc', 'col')),
      JSON.stringify(priv) + '\n',
    );
  }
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(
  chaincode: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
): Promise<any> {
  return new ReplayOrchestrator({
    adapter: 'chaincode',
    inputDir: tmpDir,
    chaincode: {
      connectionProfilePath: 'profile.json', mspId: 'Org1MSP',
      certPath: 'cert.pem', keyPath: 'key.pem',
      channelMapping: Object.fromEntries(CHANNELS.map((c) => [c, `dest-${c}`])),
      replayHistory: true,
      ...chaincode,
    },
  }).run();
}

const checkpointFiles = (): string[] =>
  fs.readdirSync(tmpDir).filter((f) => f.startsWith('replay-checkpoint-')).sort();

// ── Parallel channel replay ──

describe('chaincode replay — channelConcurrency', () => {
  it('replays channels at once when channelConcurrency allows', async () => {
    writeDelayMs = 20;

    const summary = await run({ channelConcurrency: 3, concurrency: 1 });

    expect(summary.totalReplayed).toBe(12);
    expect(peakInFlight).toBe(3);
  });

  it('replays one channel at a time by default', async () => {
    writeDelayMs = 5;

    await run({ concurrency: 1 });

    expect(peakInFlight).toBe(1);
  });

  /** Parallel across channels, never within one key. */
  it('keeps each key\'s versions in order on its own destination channel', async () => {
    writeDelayMs = 5;

    await run({ channelConcurrency: 3 });

    for (const channel of CHANNELS) {
      expect(writes.filter((w) => w.destChannel === `dest-${channel}`).length).toBe(4);
    }
    expect(new Set(writes.map((w) => w.destChannel)))
      .toEqual(new Set(CHANNELS.map((c) => `dest-${c}`)));
  });

  it('clears every channel\'s checkpoint after a clean run', async () => {
    await run({ channelConcurrency: 2 });

    expect(checkpointFiles()).toEqual([]);
  });

  /** A failure on one destination ledger says nothing about the others. */
  it('stops only the failing channel and keeps its checkpoint alone', async () => {
    failing.add('dest-ch-b');

    const summary = await run({ channelConcurrency: 3 });

    // ch-b's public history fails and its private file is skipped; ch-a and
    // ch-c replay both of their files in full.
    expect(summary.totalFailed).toBe(3);
    expect(summary.totalReplayed).toBe(8);
    expect(writes.filter((w) => w.key.endsWith('-p')).map((w) => w.destChannel).sort())
      .toEqual(['dest-ch-a', 'dest-ch-c']);
    expect(summary.historyAborted).toBe('ch-b/public-history');
    expect(checkpointFiles()).toEqual(['replay-checkpoint-chaincode-ch-b.json']);
    const cp = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'replay-checkpoint-chaincode-ch-b.json'), 'utf-8',
    ));
    expect(cp.dirtyFile).toBe('ch-b/public-history');
    // This channel's files only — another channel's progress is not its cursor.
    expect(cp.files.every((f: string) => f.startsWith('ch-b/'))).toBe(true);
  });

  it('refuses to resume a dirty channel, naming it', async () => {
    failing.add('dest-ch-b');
    await run({ channelConcurrency: 3 });
    failing.clear();
    writes.length = 0;

    await expect(run({ channelConcurrency: 3 })).rejects.toThrow(/ch-b\/public-history/);
    expect(writes).toEqual([]);
  });

  /**
   * One cursor cannot describe the other mode's progress, and resuming from
   * the wrong file starts over — at a history destination, every version again.
   */
  it('refuses a sequential checkpoint when run in parallel', async () => {
    fs.writeFileSync(path.join(tmpDir, 'replay-checkpoint-chaincode.json'), '{}');

    await expect(run({ channelConcurrency: 2 })).rejects.toThrow(/sequential replay's checkpoint/);
    expect(writes).toEqual([]);
  });

  it('refuses parallel checkpoints when run sequentially', async () => {
    fs.writeFileSync(path.join(tmpDir, 'replay-checkpoint-chaincode-ch-a.json'), '{}');

    await expect(run({})).rejects.toThrow(/replay-checkpoint-chaincode-ch-a\.json .*parallel/);
    expect(writes).toEqual([]);
  });

  it.each([0, -1, 1.5])('rejects channelConcurrency %p', async (value) => {
    await expect(run({ channelConcurrency: value })).rejects.toThrow(
      /channelConcurrency must be an integer >= 1/,
    );
  });
});
