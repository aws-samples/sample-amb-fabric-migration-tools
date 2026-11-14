import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';

// ── Mocks ──

/** One write that reached the orderer, and where it was submitted. */
interface MockWrite {
  chaincode: string;
  contract: string;
  fn: string;
  key: string;
}

const writes: MockWrite[] = [];

/**
 * Warnings the run emitted.
 *
 * The only place an unused `keyMapping` channel surfaces: the run succeeds, so
 * there is no exception or summary field to assert on instead.
 */
const warnings: Array<{ ctx: Record<string, unknown>; msg: string }> = [];

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

/** What the destination's migration contract answers the write pre-flight with. */
const EMPTY_KEY_PAGE = Buffer.from('{"keys":[],"bookmark":""}', 'utf-8');

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    getGatewayNetwork: jest.fn(() => ({
      getContract: jest.fn((chaincode: string, contract: string) => ({
        evaluateTransaction: jest.fn(async () => EMPTY_KEY_PAGE),
        newProposal: jest.fn((fn: string, opts: { arguments: string[] }) => ({
          endorse: async () => ({
            submit: async () => {
              writes.push({
                chaincode, contract, fn,
                key: opts.arguments[opts.arguments.length - 1],
              });
              return { getStatus: async () => COMMITTED };
            },
          }),
        })),
      })),
    })),
    disconnect: jest.fn(),
  })),
}));

/** The one chaincode these runs replay, committed on every destination. */
jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => [
      { name: 'marketplace', version: '1.0', sequence: 1, collections: [] },
    ]),
  })),
}));

jest.mock('../src/utils/logger', () => {
  const warn = (ctx: unknown, msg?: string): void => {
    warnings.push(
      typeof ctx === 'string'
        ? { ctx: {}, msg: ctx }
        : { ctx: ctx as Record<string, unknown>, msg: msg ?? '' },
    );
  };
  const noop = (): void => {};
  const make = () => ({
    warn, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-keymapping-test-'));
  layout = new FileLayoutManager(tmpDir);
  writes.length = 0;
  warnings.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
        channelId, chaincodes: [], ledgerHeight: 1,
      })),
    }),
    'utf-8',
  );
}

/** One public record on a channel, in the chaincode both channels deploy. */
function writePublicState(channel: string, key: string): void {
  const record: ExtractionRecord = {
    _type: 'public_state', channel, chaincode: 'marketplace', key, value: 'v',
  };
  const full = path.join(tmpDir, layout.publicStatePath(channel));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(record) + '\n', 'utf-8');
}

/** A two-channel run, as an eight-channel one scales. */
function setupTwoChannels(): void {
  writeManifest(['orders-ch', 'trades-ch']);
  writePublicState('orders-ch', 'k1');
  writePublicState('trades-ch', 'k2');
}

function run(
  keyMapping: Record<string, Record<string, string>>,
  overrides: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
): Promise<any> {
  const config: ReplayConfig = {
    adapter: 'chaincode',
    inputDir: tmpDir,
    chaincode: {
      connectionProfilePath: 'profile.json',
      mspId: 'Org1MSP',
      certPath: 'cert.pem',
      keyPath: 'key.pem',
      channelMapping: { 'orders-ch': 'dest-orders', 'trades-ch': 'dest-trades' },
      keyMapping,
      ...overrides,
    },
  };
  return new ReplayOrchestrator(config).run();
}

/** The warning about mapped channels out of scope, if it was emitted. */
function unusedMappingWarning() {
  return warnings.find((w) => w.msg.includes('names source channels'));
}

/** The warning about writes and deletes on different contracts, if emitted. */
function splitDeleteWarning() {
  return warnings.find(
    (w) => w.msg.includes('names no delete function for them'),
  );
}

// ── keyMapping through a whole run ──
//
// Row 2.8. The maps are keyed by `(channel, chaincode)` because a chaincode name
// is only unique within a channel. The nesting also introduces a way to
// misconfigure a run silently, which the adapter cannot see: an entry under a
// channel the run does not replay matches no record, and every chaincode under
// it falls back to `PutState`.

describe('chaincode replay — keyMapping by channel', () => {
  it('writes one chaincode name through each channel\'s own function', async () => {
    setupTwoChannels();

    const summary = await run({
      'orders-ch': { marketplace: 'ImportOrder' },
      'trades-ch': { marketplace: 'SampleAssets:ImportTrade' },
    });

    expect(summary.totalFailed).toBe(0);
    expect(writes.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { chaincode: 'marketplace', contract: 'MigrationContract', fn: 'ImportOrder', key: 'k1' },
      { chaincode: 'marketplace', contract: 'SampleAssets', fn: 'ImportTrade', key: 'k2' },
    ]);
  });

  it('warns about a mapped channel the run does not replay', async () => {
    setupTwoChannels();

    await run({
      'orders-ch': { marketplace: 'ImportOrder' },
      // One letter out — the entry this was meant to be is not there.
      'trades-chh': { marketplace: 'ImportTrade' },
    });

    expect(unusedMappingWarning()?.ctx.channels).toEqual(['trades-chh']);
  });

  /**
   * What the warning is about: the typo does not fail, it downgrades. Every
   * record the missing entry covered is written with the default `PutState`, on
   * a destination whose whole reason for a mapping was that `PutState` is wrong.
   */
  it('falls back to PutState for the channel the typo left unmapped', async () => {
    setupTwoChannels();

    await run({
      'orders-ch': { marketplace: 'ImportOrder' },
      'trades-chh': { marketplace: 'ImportTrade' },
    });

    expect(writes.find((w) => w.key === 'k2')?.fn).toBe('PutState');
  });

  it('does not warn when every mapped channel is in scope', async () => {
    setupTwoChannels();

    await run({
      'orders-ch': { marketplace: 'ImportOrder' },
      'trades-ch': { marketplace: 'ImportTrade' },
    });

    expect(unusedMappingWarning()).toBeUndefined();
  });

  /**
   * Mapping a channel the run skips is the same mistake as misspelling one: the
   * entry describes writes that will not happen on this run.
   */
  it('warns about a channel channelMapping leaves out of scope', async () => {
    writeManifest(['orders-ch', 'trades-ch', 'audit-ch']);
    writePublicState('orders-ch', 'k1');
    writePublicState('trades-ch', 'k2');
    writePublicState('audit-ch', 'k3');

    const summary = await run({
      'orders-ch': { marketplace: 'ImportOrder' },
      'audit-ch': { marketplace: 'ImportAudit' },
    });

    expect(summary.skippedChannels).toEqual(['audit-ch']);
    expect(unusedMappingWarning()?.ctx.channels).toEqual(['audit-ch']);
  });

  /** The same typo in the delete map downgrades the same way. */
  it('warns about a deleteMapping channel the run does not replay', async () => {
    setupTwoChannels();

    await run({}, {
      deleteMapping: { 'trades-chh': { marketplace: 'RemoveTrade' } },
    });

    expect(unusedMappingWarning()?.ctx.channels).toEqual(['trades-chh']);
  });
});

// ── Writes and deletes on different contracts ──
//
// Row 2.10. A `keyMapping` naming an application contract says that function
// owns the write, usually because it maintains something besides the key. With
// no `deleteMapping` entry the tombstone goes to the migration contract's
// `DeleteState`, which removes the key and leaves the rest of that bookkeeping
// referring to it. Warned rather than refused: `DeleteState` does delete the
// key, and what else depended on it is not something this tool can see.

describe('chaincode replay — split delete targets', () => {
  it('warns when a write leaves the migration contract with no delete mapped',
    async () => {
      setupTwoChannels();

      await run(
        { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
        { replayHistory: true },
      );

      expect(splitDeleteWarning()?.ctx.deployments)
        .toEqual(['orders-ch/marketplace']);
    });

  it('does not warn once deleteMapping names the deployment\'s delete', async () => {
    setupTwoChannels();

    await run(
      { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
      {
        replayHistory: true,
        deleteMapping: {
          'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' },
        },
      },
    );

    expect(splitDeleteWarning()).toBeUndefined();
  });

  /**
   * Naming the migration contract's own delete is an answer, not an omission:
   * the operator was asked and said the key is all there is to remove.
   */
  it('does not warn when the mapped delete is the migration contract\'s',
    async () => {
      setupTwoChannels();

      await run(
        { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
        {
          replayHistory: true,
          deleteMapping: { 'orders-ch': { marketplace: 'DeleteState' } },
        },
      );

      expect(splitDeleteWarning()).toBeUndefined();
    });

  it('does not warn when the write stays on the migration contract', async () => {
    setupTwoChannels();

    await run(
      { 'orders-ch': { marketplace: 'ImportOrder' } },
      { replayHistory: true },
    );

    expect(splitDeleteWarning()).toBeUndefined();
  });

  /** A tombstone reaches the destination only through `public_history`. */
  it('does not warn when history is not being replayed', async () => {
    setupTwoChannels();

    await run({ 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } });

    expect(splitDeleteWarning()).toBeUndefined();
  });

  /** The mapping is read against the run's channels, not the whole config. */
  it('says nothing about a deployment on a channel the run skips', async () => {
    writeManifest(['orders-ch', 'trades-ch', 'audit-ch']);
    writePublicState('audit-ch', 'k3');

    await run(
      { 'audit-ch': { marketplace: 'SampleAssets:StoreAsset' } },
      { replayHistory: true },
    );

    expect(splitDeleteWarning()).toBeUndefined();
  });
});
