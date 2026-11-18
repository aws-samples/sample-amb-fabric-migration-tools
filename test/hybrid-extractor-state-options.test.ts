// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChannelInfo, ExtractOptions, Manifest, MigrationTier } from '../src/types';
import { StateReconstructionExtractor } from '../src/extraction/strategies/state-reconstruction-extractor';
import { HybridExtractor } from '../src/extraction/strategies/hybrid-extractor';

// The state accumulator's options reach it through this constructor, so the
// constructor arguments are what the extractor has to get right.
jest.mock('../src/extraction/strategies/state-reconstruction-extractor', () => ({
  StateReconstructionExtractor: jest.fn().mockImplementation(() => ({
    extract: jest.fn(async () => ({
      getIntegrityReport: () => ({ blocksWithoutMetadata: [] }),
      getIdentityRegistry: () => new Map(),
      getWalkTip: () => undefined,
    })),
  })),
}));

const warnings: string[] = [];
const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
const infos: Array<{ ctx: Record<string, unknown>; msg: string }> = [];

jest.mock('../src/utils/logger', () => {
  const noop = (): void => {};
  const warn = (ctx: unknown, message?: string): void => {
    warnings.push(message ?? String(ctx));
    warns.push(
      typeof ctx === 'string'
        ? { ctx: {}, msg: ctx }
        : { ctx: ctx as Record<string, unknown>, msg: message ?? '' },
    );
  };
  const info = (ctx: unknown, message?: string): void => {
    infos.push(
      typeof ctx === 'string'
        ? { ctx: {}, msg: ctx }
        : { ctx: ctx as Record<string, unknown>, msg: message ?? '' },
    );
  };
  const make = () => ({
    warn, info, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

const mockedExtractor = StateReconstructionExtractor as unknown as jest.Mock;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-state-options-test-'));
  mockedExtractor.mockClear();
  warnings.length = 0;
  warns.length = 0;
  infos.length = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Channels with no blocks to walk — only the options handed down are at issue. */
function channels(count: number, ledgerHeight = 0): ChannelInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    channelId: `ch${i}`,
    ledgerHeight,
    chaincodes: [{ name: 'mycc', version: '1.0', sequence: 1, collections: [] }],
  }));
}

function options(overrides: Partial<ExtractOptions> = {}): ExtractOptions {
  return {
    manifest: path.join(tmpDir, 'manifest.json'),
    tier: MigrationTier.CurrentState,
    outputDir: tmpDir,
    batchSize: 100,
    strategy: 'block-reconstruction',
    concurrency: 1,
    stateBackend: 'memory',
    memoryLimitMb: 512,
    prefetchBuffer: 0,
    ...overrides,
  };
}

/** State options the extractor handed to each channel's state reconstruction. */
async function perChannelStateOptions(
  channelCount: number,
  overrides: Partial<ExtractOptions>,
  channelIds?: string[],
): Promise<any[]> {
  const chans = channels(channelCount);
  if (channelIds) chans.forEach((c, i) => { c.channelId = channelIds[i]; });
  const manifest: Manifest = {
    networkId: 'nd-TEST',
    memberId: 'm-TEST',
    region: 'us-east-1',
    stateDb: 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z',
    channels: chans,
  };
  const gateway: any = { getNetwork: jest.fn(() => ({ getContract: jest.fn() })) };
  await new HybridExtractor(options(overrides), manifest, gateway).run(chans);
  return mockedExtractor.mock.calls.map((call) => call[5]);
}

async function perChannelLimits(
  channelCount: number,
  overrides: Partial<ExtractOptions>,
): Promise<number[]> {
  const stateOptions = await perChannelStateOptions(channelCount, overrides);
  return stateOptions.map((o) => o.memoryLimitMb);
}

async function perChannelSpillDirs(
  channelCount: number,
  overrides: Partial<ExtractOptions>,
  channelIds?: string[],
): Promise<Array<string | undefined>> {
  const stateOptions = await perChannelStateOptions(channelCount, overrides, channelIds);
  return stateOptions.map((o) => o.stateDataDir);
}

// The estimate is reported where the run that it describes happens, rather than
// only in `discover`: the tier, the concurrency and whether private values will
// be delivered are all known here and all move the figures.
describe('the capacity estimate for the run about to start', () => {
  /** Channels of a given size, each chaincode declaring `collections` collections. */
  function sized(count: number, ledgerHeight: number, collections = 0): ChannelInfo[] {
    return channels(count, ledgerHeight).map((c) => ({
      ...c,
      chaincodes: [
        {
          name: 'mycc',
          version: '1.0',
          sequence: 1,
          collections: Array.from({ length: collections }, (_, i) => ({
            name: `col${i}`,
            policy: '',
            requiredPeerCount: 0,
            maxPeerCount: 1,
            blockToLive: 0,
            memberOnlyRead: false,
            memberOnlyWrite: false,
          })),
        },
      ],
    }));
  }

  async function run(
    chans: ChannelInfo[],
    overrides: Partial<ExtractOptions> = {},
    deliverPrivateData?: unknown,
  ): Promise<void> {
    const manifest: Manifest = {
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb: 'CouchDB',
      extractedAt: '2026-01-01T00:00:00.000Z',
      channels: chans,
    };
    const gateway: any = { getNetwork: jest.fn(() => ({ getContract: jest.fn() })) };
    await new HybridExtractor(
      options(overrides),
      manifest,
      gateway,
      undefined,
      deliverPrivateData as any,
    ).run(chans);
  }

  /** The estimate's structured context, as it was logged. */
  function estimate(): Record<string, any> {
    const logged = infos.find((i) => /Estimated capacity for this run/.test(i.msg));
    expect(logged).toBeDefined();
    return logged!.ctx;
  }

  it('reports every dimension of the run', async () => {
    await run(sized(2, 100_000, 1), { concurrency: 2 }, jest.fn());

    expect(estimate()).toMatchObject({
      workers: 2,
      perChannelMemoryLimitMb: 256,
    });
    for (const field of [
      'peakAccumulatorMb',
      'peakPrivateStateMb',
      'peakSpillMb',
      'totalOutputMb',
      'totalBlockFetchMb',
    ]) {
      expect(estimate()[field]).toBeGreaterThan(0);
    }
  });

  it('names each channel and what it will hold', async () => {
    await run(sized(2, 100_000));

    expect(estimate().perChannel).toEqual([
      expect.objectContaining({ channelId: 'ch0', estimatedLiveKeys: 150_000 }),
      expect.objectContaining({ channelId: 'ch1', estimatedLiveKeys: 150_000 }),
    ]);
  });

  // The defect C3 named: eight channels extracted one at a time hold one
  // accumulator, and the estimate that mattered was reporting all eight.
  it('reports the peak for the concurrency the run will use', async () => {
    await run(sized(8, 100_000), { concurrency: 1 });
    const sequential = estimate();

    infos.length = 0;
    await run(sized(8, 100_000), { concurrency: 8 });
    const parallel = estimate();

    expect(sequential.workers).toBe(1);
    expect(parallel.workers).toBe(8);
    expect(parallel.peakAccumulatorMb).toBe(sequential.peakAccumulatorMb * 8);
  });

  it('reports the output for the tier the run will write', async () => {
    await run(sized(1, 100_000), { tier: MigrationTier.CurrentState });
    const tier1 = estimate().totalOutputMb;

    infos.length = 0;
    await run(sized(1, 100_000), { tier: MigrationTier.FullHistory });

    expect(estimate().totalOutputMb).toBeGreaterThan(tier1);
  });

  it('counts the second ledger walk only when private data will be delivered', async () => {
    await run(sized(1, 100_000, 1));
    const withoutDelivery = estimate();

    infos.length = 0;
    await run(sized(1, 100_000, 1), {}, jest.fn());
    const withDelivery = estimate();

    expect(withoutDelivery.peakPrivateStateMb).toBe(0);
    expect(withDelivery.peakPrivateStateMb).toBeGreaterThan(0);
    expect(withDelivery.totalBlockFetchMb).toBeGreaterThan(withoutDelivery.totalBlockFetchMb);
  });

  it('says which channels are expected to outgrow their share of the limit', async () => {
    const chans = [...sized(1, 100_000), ...sized(1, 100)];
    chans[1].channelId = 'tiny';
    await run(chans, { stateBackend: 'auto', memoryLimitMb: 64 });

    const warned = warns.find((w) => /expect a LevelDB promotion mid-walk/.test(w.msg));
    expect(warned?.ctx).toMatchObject({ perChannelMemoryLimitMb: 64 });
    expect(warned!.ctx.channels).toEqual([
      expect.objectContaining({ channelId: 'ch0' }),
    ]);
  });

  // The accumulator tests a channel's share, so a run whose total fits can still
  // promote on a channel that does not.
  it('measures a channel against its share, not against the whole flag', async () => {
    await run(sized(2, 50_000), { stateBackend: 'auto', memoryLimitMb: 64, concurrency: 2 });

    // 48 MB each, under the 64 MB flag but over the 32 MB each channel gets.
    const warned = warns.find((w) => /expect a LevelDB promotion mid-walk/.test(w.msg));
    expect(warned?.ctx).toMatchObject({ perChannelMemoryLimitMb: 32 });
    expect(warned!.ctx.channels).toEqual([
      expect.objectContaining({ channelId: 'ch0', estimatedMemoryMb: 48 }),
      expect.objectContaining({ channelId: 'ch1', estimatedMemoryMb: 48 }),
    ]);
  });

  it('warns that --state-backend memory has no spill to promote to', async () => {
    await run(sized(1, 100_000), { stateBackend: 'memory', memoryLimitMb: 64 });

    expect(warnings.join('\n')).toMatch(/never spills, so a channel estimated above the limit/);
    expect(warnings.join('\n')).not.toMatch(/expect a LevelDB promotion/);
  });

  it('has nothing to warn about for a run that never accumulates in memory', async () => {
    await run(sized(1, 100_000), { stateBackend: 'leveldb', memoryLimitMb: 64 });

    expect(warnings.join('\n')).not.toMatch(/LevelDB promotion/);
    expect(warnings.join('\n')).not.toMatch(/never spills/);
  });

  it('stays quiet about a run the limit has room for', async () => {
    await run(sized(1, 1000), { stateBackend: 'auto', memoryLimitMb: 64 });

    expect(warnings.join('\n')).not.toMatch(/LevelDB promotion/);
  });

  // Private current state is collected in a plain map for the whole channel, so
  // --memory-limit does not bound it and a promotion cannot save it.
  it('warns that --memory-limit does not bound the private state', async () => {
    await run(sized(1, 100_000, 1), { memoryLimitMb: 64 }, jest.fn());

    expect(warnings.join('\n')).toMatch(
      /private current state exceeds --memory-limit, which does not bound it/,
    );
  });

  it('says nothing about private state for a run that will not collect it', async () => {
    await run(sized(1, 100_000, 1), { memoryLimitMb: 64 });

    expect(warnings.join('\n')).not.toMatch(/does not bound it/);
  });
});

describe('--memory-limit across parallel channels', () => {
  it('gives a single channel the whole limit', async () => {
    expect(await perChannelLimits(1, { concurrency: 1 })).toEqual([512]);
  });

  it('divides the limit between every channel accumulating at once', async () => {
    const limits = await perChannelLimits(8, { concurrency: 8 });
    expect(limits).toHaveLength(8);
    expect(limits).toEqual(Array(8).fill(64));
  });

  it('divides by the worker count, not by --concurrency', async () => {
    expect(await perChannelLimits(2, { concurrency: 8 })).toEqual([256, 256]);
  });

  it('leaves the whole limit to one channel even at high concurrency', async () => {
    expect(await perChannelLimits(1, { concurrency: 8 })).toEqual([512]);
  });

  it('leaves the whole limit to channels extracted one at a time', async () => {
    expect(await perChannelLimits(8, { concurrency: 1 })).toEqual(Array(8).fill(512));
  });

  it('treats a nonsensical concurrency as a single worker', async () => {
    expect(await perChannelLimits(1, { concurrency: 0 })).toEqual([512]);
  });

  it('rounds an uneven share down', async () => {
    expect(await perChannelLimits(8, { concurrency: 8, memoryLimitMb: 500 })).toEqual(
      Array(8).fill(62),
    );
  });

  it('never divides below 1 MB', async () => {
    expect(await perChannelLimits(8, { concurrency: 8, memoryLimitMb: 4 })).toEqual(
      Array(8).fill(1),
    );
  });
});

// A budget above the V8 heap ceiling makes the LevelDB promotion unreachable, so
// the run is refused before it walks a block rather than out-of-memorying hours
// in. 1 TB is above any default ceiling, so these do not depend on the host.
describe('--memory-limit against the V8 heap ceiling', () => {
  const OVER_CEILING = { stateBackend: 'auto' as const, memoryLimitMb: 1_000_000 };

  it('refuses a budget the heap cannot hold', async () => {
    await expect(perChannelLimits(1, OVER_CEILING)).rejects.toThrow(
      /--memory-limit 1000000 lets the state accumulators reach/,
    );
  });

  it('refuses before the first channel is touched', async () => {
    await expect(perChannelLimits(4, OVER_CEILING)).rejects.toThrow();
    expect(mockedExtractor).not.toHaveBeenCalled();
  });

  // 8000 MB over eight channels is a 1000 MB share, which any default heap
  // ceiling holds — the run still commits to all 8000 MB at once.
  it('checks the whole budget, not the share one channel gets', async () => {
    await expect(
      perChannelLimits(8, { stateBackend: 'auto', memoryLimitMb: 8000, concurrency: 8 }),
    ).rejects.toThrow(/--memory-limit 8000/);
  });

  it('accepts a budget the heap has room for', async () => {
    expect(await perChannelLimits(1, { stateBackend: 'auto', memoryLimitMb: 64 })).toEqual([64]);
  });

  it('logs the ceiling the run started with', async () => {
    await perChannelLimits(1, { stateBackend: 'auto', memoryLimitMb: 64 });

    const logged = infos.find((i) => /fits the V8 heap ceiling/.test(i.msg));
    expect(logged?.ctx).toMatchObject({ memoryLimitMb: 64 });
    expect(logged!.ctx.heapCeilingMb).toBeGreaterThan(64);
  });

  it('leaves a run that never accumulates in memory alone', async () => {
    expect(
      await perChannelLimits(1, { ...OVER_CEILING, stateBackend: 'leveldb' }),
    ).toEqual([1_000_000]);
  });

  it('warns that --state-backend memory has no bound but the ceiling', async () => {
    await perChannelLimits(1, { stateBackend: 'memory', memoryLimitMb: 1_000_000 });

    expect(warnings.join('\n')).toMatch(
      /--state-backend memory never spills to LevelDB/,
    );
  });
});

describe('--state-data-dir', () => {
  it('leaves the spill in the system temp directory when unset', async () => {
    expect(await perChannelSpillDirs(2, {})).toEqual([undefined, undefined]);
  });

  it('gives each channel its own subdirectory under the root', async () => {
    const root = path.join(tmpDir, 'spill');
    const dirs = await perChannelSpillDirs(3, { stateDataDir: root });
    expect(dirs).toEqual([
      path.join(root, 'channel-ch0'),
      path.join(root, 'channel-ch1'),
      path.join(root, 'channel-ch2'),
    ]);
    for (const dir of dirs) {
      expect(fs.statSync(dir!).isDirectory()).toBe(true);
    }
  });

  it('creates a root that does not exist yet', async () => {
    const root = path.join(tmpDir, 'a', 'b', 'spill');
    await perChannelSpillDirs(1, { stateDataDir: root });
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it('keeps a channel name from escaping the root', async () => {
    const root = path.join(tmpDir, 'spill');
    const dirs = await perChannelSpillDirs(1, { stateDataDir: root }, ['../../etc']);
    expect(dirs).toEqual([path.join(root, 'channel-.._.._etc')]);
  });

  it('refuses a root that is not a directory', async () => {
    const root = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(root, 'x', 'utf-8');
    await expect(perChannelSpillDirs(1, { stateDataDir: root })).rejects.toThrow(
      /--state-data-dir .*cannot be used for LevelDB spill/,
    );
  });

  it('refuses a root the extracting user cannot write', async () => {
    const root = path.join(tmpDir, 'read-only');
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o500);
    try {
      await expect(perChannelSpillDirs(1, { stateDataDir: root })).rejects.toThrow(
        /--state-data-dir .*cannot be used for LevelDB spill/,
      );
    } finally {
      fs.chmodSync(root, 0o700);
    }
  });

  it('refuses before the first channel is touched', async () => {
    const root = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(root, 'x', 'utf-8');
    await expect(perChannelSpillDirs(4, { stateDataDir: root })).rejects.toThrow();
    expect(mockedExtractor).not.toHaveBeenCalled();
  });
});
