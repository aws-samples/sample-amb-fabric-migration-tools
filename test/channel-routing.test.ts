import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { resolveChannelRouting } from '../src/replay/channel-routing';

// ── Mocks ──
//
// A refusal has to land before the destination is touched, so the run's contact
// with the gateway is what these record: connecting at all means the config was
// accepted, and a write means the merge happened.

const connectedProfiles: string[] = [];
const writtenKeys: string[] = [];

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
    connect: jest.fn(async (opts: { connectionProfilePath: string }) => {
      connectedProfiles.push(opts.connectionProfilePath);
    }),
    getGatewayNetwork: jest.fn(() => ({
      getContract: jest.fn(() => ({
        evaluateTransaction: jest.fn(async () => EMPTY_KEY_PAGE),
        newProposal: jest.fn((_fn: string, opts: { arguments: string[] }) => ({
          endorse: async () => ({
            submit: async () => {
              writtenKeys.push(opts.arguments[opts.arguments.length - 1]);
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
  const noop = (): void => {};
  const make = () => ({
    warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

/** The credentials every config needs, none of which this row is about. */
const CREDENTIALS = {
  connectionProfilePath: 'profile.json',
  mspId: 'Org1MSP',
  certPath: 'cert.pem',
  keyPath: 'key.pem',
};

function config(
  chaincode: Partial<NonNullable<ReplayConfig['chaincode']>>,
): NonNullable<ReplayConfig['chaincode']> {
  return { ...CREDENTIALS, ...chaincode };
}

// ── Routing one channel at a time ──

describe('resolveChannelRouting — channel', () => {
  it('routes the one source channel in scope to the named destination', () => {
    const routing = resolveChannelRouting(
      config({ channel: 'dest-ch' }), ['source-ch'],
    );

    expect(routing.routes).toEqual([
      { channel: 'source-ch', destChannel: 'dest-ch' },
    ]);
    expect(routing.unroutedChannels).toEqual([]);
  });

  /**
   * The merge this row exists to prevent. Eight source channels and one
   * destination is not a migration of eight channels: it is one channel holding
   * whichever channel's copy of each shared key was replayed last.
   */
  it('refuses more than one source channel', () => {
    expect(() => resolveChannelRouting(
      config({ channel: 'dest-ch' }), ['orders-ch', 'trades-ch'],
    )).toThrow(/sends every source channel to "dest-ch"/);
  });

  it('names every channel it would have merged, and the way out', () => {
    let message = '';
    try {
      resolveChannelRouting(
        config({ channel: 'dest-ch' }), ['orders-ch', 'trades-ch'],
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('orders-ch, trades-ch');
    expect(message).toContain('channelMapping');
    expect(message).toContain('--channels');
  });

  /** A manifest with no channels has nothing to merge and nothing to route. */
  it('routes nothing when no channel is in scope', () => {
    const routing = resolveChannelRouting(config({ channel: 'dest-ch' }), []);

    expect(routing).toEqual({ routes: [], unroutedChannels: [] });
  });
});

// ── Routing by explicit map ──

describe('resolveChannelRouting — channelMapping', () => {
  it('routes each source channel to its own destination', () => {
    const routing = resolveChannelRouting(
      config({
        channelMapping: { 'orders-ch': 'dest-orders', 'trades-ch': 'dest-trades' },
      }),
      ['orders-ch', 'trades-ch'],
    );

    expect(routing.routes).toEqual([
      { channel: 'orders-ch', destChannel: 'dest-orders' },
      { channel: 'trades-ch', destChannel: 'dest-trades' },
    ]);
  });

  /**
   * Requiring `channelMapping` closes nothing on its own: a map that names one
   * destination twice merges exactly as `channel` did, and spells it out.
   */
  it('refuses a map that sends two source channels to one destination', () => {
    expect(() => resolveChannelRouting(
      config({
        channelMapping: { 'orders-ch': 'everything', 'trades-ch': 'everything' },
      }),
      ['orders-ch', 'trades-ch'],
    )).toThrow(/orders-ch \+ trades-ch → everything/);
  });

  /**
   * Scoped to the run, because the map outlives it: a config written for eight
   * channels is the same config when `--channels` narrows a rerun to one, and
   * refusing on entries that will not be used would make the narrow run
   * impossible.
   */
  it('allows a collision between channels this run leaves out', () => {
    const routing = resolveChannelRouting(
      config({
        channelMapping: { 'orders-ch': 'dest-a', 'trades-ch': 'dest-b',
          'audit-ch': 'dest-b' },
      }),
      ['orders-ch', 'trades-ch'],
    );

    expect(routing.routes).toHaveLength(2);
  });

  it('reports an unmapped source channel rather than routing it', () => {
    const routing = resolveChannelRouting(
      config({ channelMapping: { 'orders-ch': 'dest-orders' } }),
      ['orders-ch', 'trades-ch'],
    );

    expect(routing.routes).toEqual([
      { channel: 'orders-ch', destChannel: 'dest-orders' },
    ]);
    expect(routing.unroutedChannels).toEqual(['trades-ch']);
  });
});

// ── Configs that answer the question twice, or not at all ──

describe('resolveChannelRouting — ambiguous configs', () => {
  /**
   * `channelMapping` used to win silently. An operator who set both and mistyped
   * one map key got that channel skipped while `channel` sat in the config
   * looking like the fallback it never was.
   */
  it('refuses both forms at once', () => {
    expect(() => resolveChannelRouting(
      config({ channel: 'dest-ch', channelMapping: { 'orders-ch': 'dest-orders' } }),
      ['orders-ch'],
    )).toThrow(/both set/);
  });

  it('refuses a config that names no destination', () => {
    expect(() => resolveChannelRouting(config({}), ['orders-ch']))
      .toThrow(/Either channel .* or channelMapping/);
  });
});

// ── Through a whole replay run ──

describe('chaincode replay — channel routing', () => {
  let tmpDir: string;
  let layout: FileLayoutManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-routing-test-'));
    layout = new FileLayoutManager(tmpDir);
    connectedProfiles.length = 0;
    writtenKeys.length = 0;
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
    chaincode: Partial<NonNullable<ReplayConfig['chaincode']>>,
    channels?: string[],
  ): Promise<unknown> {
    return new ReplayOrchestrator({
      adapter: 'chaincode',
      inputDir: tmpDir,
      ...(channels ? { channels } : {}),
      chaincode: config(chaincode),
    }).run();
  }

  /**
   * A --private-only member directory holds no public data, so a replay of it
   * would exit 0 having written none. It is merge input; replay says so.
   */
  it('refuses a private-only member extraction before connecting', async () => {
    setupTwoChannels();
    const metadataPath = path.join(tmpDir, layout.channelMetadataPath('trades-ch'));
    fs.writeFileSync(metadataPath, JSON.stringify({ channelId: 'trades-ch', scope: 'private-only' }));

    await expect(run({ channelMapping: { 'orders-ch': 'dest-orders', 'trades-ch': 'dest-trades' } }))
      .rejects.toThrow(/trades-ch was extracted with --private-only[\s\S]*Merge it/);
    expect(connectedProfiles).toEqual([]);
  });

  it('refuses a single channel for a two-channel manifest', async () => {
    setupTwoChannels();

    await expect(run({ channel: 'dest-ch' }))
      .rejects.toThrow(/sends every source channel to "dest-ch"/);
  });

  /**
   * Where the refusal has to land. A merge caught after the first channel has
   * already been written leaves the destination holding half a migration, and
   * the operator with a ledger to reset before the retry.
   */
  it('refuses before connecting to the destination', async () => {
    setupTwoChannels();

    await expect(run({ channel: 'dest-ch' })).rejects.toThrow();

    expect(connectedProfiles).toEqual([]);
    expect(writtenKeys).toEqual([]);
  });

  it('refuses a channelMapping that merges two channels in scope', async () => {
    setupTwoChannels();

    await expect(run({
      channelMapping: { 'orders-ch': 'everything', 'trades-ch': 'everything' },
    })).rejects.toThrow(/same destination channel/);

    expect(writtenKeys).toEqual([]);
  });

  /** The documented way to keep using `channel`: one source channel per run. */
  it('accepts a single channel once --channels narrows the run to one', async () => {
    setupTwoChannels();

    await run({ channel: 'dest-ch' }, ['orders-ch']);

    expect(writtenKeys).toEqual(['k1']);
  });

  it('replays each channel to its own destination', async () => {
    setupTwoChannels();

    await run({
      channelMapping: { 'orders-ch': 'dest-orders', 'trades-ch': 'dest-trades' },
    });

    expect(writtenKeys.sort()).toEqual(['k1', 'k2']);
  });
});
