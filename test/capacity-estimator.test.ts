// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CapacityInputs,
  estimateCapacity,
  estimateRunCapacity,
  printCapacityAdvisory,
} from '../src/discovery/capacity-estimator';
import { InMemoryStateAccumulator } from '../src/extraction/state-accumulator';
import { ChannelInfo, CollectionConfig, MigrationTier } from '../src/types';

const MB = 1024 * 1024;

/** Tier 3 with values delivered — the widest run, so every figure is non-zero. */
const FULL: CapacityInputs = {
  tier: MigrationTier.FullHistory,
  privateDataDelivery: true,
};

function makeCollection(name: string): CollectionConfig {
  return { name, policy: '', requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: false, memberOnlyWrite: false };
}

function makeChannel(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    channelId: 'testchannel',
    chaincodes: [{ name: 'mycc', version: '1.0', sequence: 1, collections: [] }],
    ledgerHeight: 100,
    ...overrides,
  };
}

/** A channel whose one chaincode declares `count` private collections. */
function withCollections(count: number, overrides: Partial<ChannelInfo> = {}): ChannelInfo {
  return makeChannel({
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: Array.from({ length: count }, (_, i) => makeCollection(`col${i}`)),
      },
    ],
    ...overrides,
  });
}

describe('estimateCapacity', () => {
  it('returns correct channel metadata', () => {
    const channel = makeChannel({
      channelId: 'ch1',
      chaincodes: [
        { name: 'cc1', version: '1', sequence: 1, collections: [makeCollection('col1')] },
        { name: 'cc2', version: '1', sequence: 1, collections: [makeCollection('col2'), makeCollection('col3')] },
      ],
      ledgerHeight: 500,
    });

    const est = estimateCapacity(channel, FULL);
    expect(est.channelId).toBe('ch1');
    expect(est.ledgerHeight).toBe(500);
    expect(est.chaincodeCount).toBe(2);
    expect(est.collectionCount).toBe(3);
  });

  // Discovery synthesizes one per channel org per chaincode whether or not it
  // holds anything, so counting them would misreport how much private data the
  // channel has.
  it('excludes synthesized implicit collections from the count', () => {
    const implicit = { ...makeCollection('_implicit_org_Org1MSP'), implicit: true };
    const channel = makeChannel({
      chaincodes: [
        {
          name: 'cc1',
          version: '1',
          sequence: 1,
          collections: [makeCollection('col1'), implicit],
        },
      ],
    });

    expect(estimateCapacity(channel, FULL).collectionCount).toBe(1);
  });

  it('computes write and key estimates from ledger height', () => {
    const est = estimateCapacity(makeChannel({ ledgerHeight: 1000 }), FULL);
    // avgWritesPerBlock = 3
    expect(est.estimatedTotalWrites).toBe(3000);
    // liveKeyFraction = 0.5
    expect(est.estimatedLiveKeys).toBe(1500);
    // avgWritesPerTx = 2, and block metadata is one record per transaction
    expect(est.estimatedTransactions).toBe(1500);
  });

  describe('small ledger (< 256 MB memory)', () => {
    it('recommends memory backend', () => {
      const est = estimateCapacity(makeChannel({ ledgerHeight: 100 }), FULL);
      expect(est.recommendedBackend).toBe('memory');
      expect(est.recommendedMemoryLimitMb).toBe(512);
      expect(est.memoryWarning).toBe(false);
    });
  });

  describe('medium ledger (256-2048 MB memory)', () => {
    // liveKeys = height * 3 * 0.5, memBytes = liveKeys * 660 (see keyChargeBytes)
    // 256 MB = 268,435,456 bytes => liveKeys = 406,721 => height = 271,148
    it('recommends auto backend', () => {
      const est = estimateCapacity(makeChannel({ ledgerHeight: 280_000 }), FULL);
      expect(est.recommendedBackend).toBe('auto');
      expect(est.memoryWarning).toBe(false);
      expect(est.recommendedMemoryLimitMb).toBe(est.estimatedMemoryMb);
    });

    // A limit is only useful if the heap can hold it, and nothing here can raise
    // --max-old-space-size after the process has started.
    it('recommends no more than 1024 MB however large the estimate', () => {
      // 1,500,000 blocks => 2,250,000 live keys => 1,416 MB, still under the
      // 2048 MB band where the recommendation becomes leveldb outright.
      const est = estimateCapacity(makeChannel({ ledgerHeight: 1_500_000 }), FULL);
      expect(est.recommendedBackend).toBe('auto');
      expect(est.estimatedMemoryMb).toBeGreaterThan(1024);
      expect(est.recommendedMemoryLimitMb).toBe(1024);
    });
  });

  describe('large ledger (>= 2048 MB memory)', () => {
    // 2048 MB = 2,147,483,648 bytes => liveKeys = 3,253,763 => height = 2,169,176
    it('recommends leveldb backend with warning', () => {
      const est = estimateCapacity(makeChannel({ ledgerHeight: 2_300_000 }), FULL);
      expect(est.recommendedBackend).toBe('leveldb');
      expect(est.recommendedMemoryLimitMb).toBe(512);
      expect(est.memoryWarning).toBe(true);
    });
  });

  it('computes positive estimates for all resource dimensions', () => {
    const est = estimateCapacity(withCollections(1, { ledgerHeight: 10_000 }), FULL);
    expect(est.estimatedMemoryMb).toBeGreaterThan(0);
    expect(est.estimatedPrivateMemoryMb).toBeGreaterThan(0);
    expect(est.estimatedDiskMb).toBeGreaterThan(0);
    expect(est.estimatedOutputMb).toBeGreaterThan(0);
    expect(est.estimatedBlockFetchMb).toBeGreaterThan(0);
  });

  it('handles zero-height ledger', () => {
    const est = estimateCapacity(makeChannel({ ledgerHeight: 0 }), FULL);
    expect(est.estimatedTotalWrites).toBe(0);
    expect(est.estimatedLiveKeys).toBe(0);
    expect(est.estimatedMemoryMb).toBe(0);
    expect(est.recommendedBackend).toBe('memory');
    expect(est.memoryWarning).toBe(false);
  });

  it('handles channel with no chaincodes', () => {
    const est = estimateCapacity(makeChannel({ chaincodes: [] }), FULL);
    expect(est.chaincodeCount).toBe(0);
    expect(est.collectionCount).toBe(0);
  });

  it('disk estimate is less than memory estimate for same ledger', () => {
    // perKeyDisk (600) < perKeyMemory (660)
    const est = estimateCapacity(makeChannel({ ledgerHeight: 10_000 }), FULL);
    expect(est.estimatedDiskMb).toBeLessThan(est.estimatedMemoryMb);
  });

  it('estimates scale linearly with ledger height', () => {
    const est1 = estimateCapacity(makeChannel({ ledgerHeight: 1000 }), FULL);
    const est2 = estimateCapacity(makeChannel({ ledgerHeight: 2000 }), FULL);
    expect(est2.estimatedTotalWrites).toBe(est1.estimatedTotalWrites * 2);
    expect(est2.estimatedLiveKeys).toBe(est1.estimatedLiveKeys * 2);
  });
});

// `--memory-limit` is compared against the accumulator's own byte count, not
// against real heap, so an estimate that predicts anything else cannot predict a
// promotion. This is the check that the two stay the same arithmetic.
describe('the memory estimate against the accumulator it predicts', () => {
  it('matches what the accumulator charges for the same keys', async () => {
    const channel = makeChannel({ ledgerHeight: 70_000 });
    const est = estimateCapacity(channel, FULL);

    const accumulator = new InMemoryStateAccumulator();
    const value = { value: 'v'.repeat(500) };
    for (let i = 0; i < est.estimatedLiveKeys; i++) {
      await accumulator.put('mycc', `${i}`.padStart(50, 'k'), value);
    }

    expect(accumulator.keyCount()).toBe(est.estimatedLiveKeys);
    expect(Math.ceil(accumulator.estimatedMemoryBytes() / MB)).toBe(est.estimatedMemoryMb);
    await accumulator.close();
  });
});

describe('output files the tier writes', () => {
  const channel = withCollections(1, { ledgerHeight: 10_000 });

  it('writes only public state at tier 1', () => {
    const { outputBreakdownMb } = estimateCapacity(channel, {
      ...FULL,
      tier: MigrationTier.CurrentState,
    });

    expect(outputBreakdownMb.publicStateMb).toBeGreaterThan(0);
    expect(outputBreakdownMb.blockMetadataMb).toBe(0);
    expect(outputBreakdownMb.publicHistoryMb).toBe(0);
    expect(outputBreakdownMb.privateHistoryMb).toBe(0);
    expect(outputBreakdownMb.privateHashesMb).toBe(0);
  });

  it('adds block metadata at tier 2 but no history', () => {
    const { outputBreakdownMb } = estimateCapacity(channel, {
      ...FULL,
      tier: MigrationTier.StateWithAudit,
    });

    expect(outputBreakdownMb.blockMetadataMb).toBeGreaterThan(0);
    expect(outputBreakdownMb.publicHistoryMb).toBe(0);
    expect(outputBreakdownMb.privateHashesMb).toBe(0);
  });

  // Each kind is priced by serialising a record of that kind, because the
  // envelopes differ: a metadata record lists the keys a transaction wrote and
  // carries no value, where a state record is mostly its value.
  it('prices a record by its own shape, not by one figure for all of them', () => {
    const est = estimateCapacity(channel, { ...FULL, tier: MigrationTier.StateWithAudit });

    // At two writes per transaction and half the writes surviving as live keys,
    // the two files hold the same number of records — so any difference between
    // them is the record shape and nothing else.
    expect(est.estimatedTransactions).toBe(est.estimatedLiveKeys);
    expect(est.outputBreakdownMb.blockMetadataMb).toBeLessThan(
      est.outputBreakdownMb.publicStateMb,
    );
  });

  it('adds history and hashes at tier 3', () => {
    const { outputBreakdownMb } = estimateCapacity(channel, FULL);

    expect(outputBreakdownMb.publicHistoryMb).toBeGreaterThan(0);
    expect(outputBreakdownMb.privateHistoryMb).toBeGreaterThan(0);
    expect(outputBreakdownMb.privateHashesMb).toBeGreaterThan(0);
  });

  it('grows with each tier', () => {
    const forTier = (tier: MigrationTier): number =>
      estimateCapacity(channel, { ...FULL, tier }).estimatedOutputMb;

    expect(forTier(MigrationTier.StateWithAudit)).toBeGreaterThan(
      forTier(MigrationTier.CurrentState),
    );
    expect(forTier(MigrationTier.FullHistory)).toBeGreaterThan(
      forTier(MigrationTier.StateWithAudit),
    );
  });

  it('counts every file in the total', () => {
    const est = estimateCapacity(channel, FULL);
    const parts = Object.values(est.outputBreakdownMb).reduce((sum, mb) => sum + mb, 0);

    // Each part is rounded up on its own, so the total cannot exceed their sum
    // and cannot be more than one MB per file below it.
    expect(est.estimatedOutputMb).toBeLessThanOrEqual(parts);
    expect(est.estimatedOutputMb).toBeGreaterThan(parts - 6);
  });

  it('counts a channel with no private collections as having no private output', () => {
    const { outputBreakdownMb } = estimateCapacity(
      makeChannel({ ledgerHeight: 10_000 }),
      FULL,
    );

    expect(outputBreakdownMb.publicStateMb).toBeGreaterThan(0);
    expect(outputBreakdownMb.privateStateMb).toBe(0);
    expect(outputBreakdownMb.privateHashesMb).toBe(0);
  });

  it('scales private output with the number of collections', () => {
    const one = estimateCapacity(withCollections(1, { ledgerHeight: 10_000 }), FULL);
    const four = estimateCapacity(withCollections(4, { ledgerHeight: 10_000 }), FULL);

    expect(four.outputBreakdownMb.privateStateMb).toBeGreaterThan(
      one.outputBreakdownMb.privateStateMb,
    );
    expect(four.estimatedLiveKeys).toBe(one.estimatedLiveKeys);
  });
});

describe('private data the peer will not deliver', () => {
  const channel = withCollections(2, { ledgerHeight: 10_000 });

  it('estimates no private values without delivery', () => {
    const est = estimateCapacity(channel, { ...FULL, privateDataDelivery: false });

    expect(est.outputBreakdownMb.privateStateMb).toBe(0);
    expect(est.outputBreakdownMb.privateHistoryMb).toBe(0);
    expect(est.estimatedPrivateMemoryMb).toBe(0);
  });

  // Hashes come out of the block itself, so they are written whichever way the
  // delivery attempt goes.
  it('still estimates the hashes read out of the blocks', () => {
    const est = estimateCapacity(channel, { ...FULL, privateDataDelivery: false });
    expect(est.outputBreakdownMb.privateHashesMb).toBeGreaterThan(0);
  });

  it('walks the ledger once instead of twice', () => {
    // A whole number of 4 KB blocks per MB, so the doubling is not obscured by
    // the rounding up that each figure does on its own.
    const exact = withCollections(2, { ledgerHeight: 10_240 });
    const once = estimateCapacity(exact, { ...FULL, privateDataDelivery: false });
    const twice = estimateCapacity(exact, FULL);

    expect(twice.estimatedBlockFetchMb).toBe(once.estimatedBlockFetchMb * 2);
  });

  // Nothing bounds the delivery pass's in-memory map, so the figure exists to be
  // read rather than to be compared against --memory-limit.
  it('reports private current state separately from the accumulator', () => {
    const est = estimateCapacity(channel, FULL);
    expect(est.estimatedPrivateMemoryMb).toBeGreaterThan(0);
    expect(est.estimatedMemoryMb).toBeGreaterThan(0);
  });
});

describe('estimateRunCapacity', () => {
  const eight = (): ChannelInfo[] =>
    Array.from({ length: 8 }, (_, i) =>
      makeChannel({ channelId: `ch${i}`, ledgerHeight: 300_000 }),
    );

  it('holds one channel at a time on the sequential default', () => {
    const run = estimateRunCapacity(eight(), FULL, 1);

    expect(run.workers).toBe(1);
    expect(run.peakAccumulatorMb).toBe(run.perChannel[0].estimatedMemoryMb);
  });

  // The defect C3 named: eight channels extracted one at a time never hold eight
  // accumulators, so reporting the sum as a peak overstates it eightfold.
  it('does not report the cross-channel sum as the peak', () => {
    const run = estimateRunCapacity(eight(), FULL, 1);
    const sum = run.perChannel.reduce((total, e) => total + e.estimatedMemoryMb, 0);

    expect(run.peakAccumulatorMb).toBe(sum / 8);
  });

  it('holds every channel at once when they all run in parallel', () => {
    const run = estimateRunCapacity(eight(), FULL, 8);
    const sum = run.perChannel.reduce((total, e) => total + e.estimatedMemoryMb, 0);

    expect(run.workers).toBe(8);
    expect(run.peakAccumulatorMb).toBe(sum);
  });

  it('counts workers, not --concurrency', () => {
    const run = estimateRunCapacity(eight().slice(0, 2), FULL, 8);
    expect(run.workers).toBe(2);
  });

  it('treats a nonsensical concurrency as a single worker', () => {
    expect(estimateRunCapacity(eight(), FULL, 0).workers).toBe(1);
  });

  // A worker pool schedules in whatever order channels finish, so the peak has
  // to assume the largest of them are in flight together.
  it('takes the largest channels for the peak, not the first', () => {
    const channels = [
      makeChannel({ channelId: 'small', ledgerHeight: 10_000 }),
      makeChannel({ channelId: 'huge', ledgerHeight: 800_000 }),
      makeChannel({ channelId: 'medium', ledgerHeight: 400_000 }),
    ];
    const run = estimateRunCapacity(channels, FULL, 2);
    const byId = new Map(run.perChannel.map((e) => [e.channelId, e]));

    expect(run.peakAccumulatorMb).toBe(
      byId.get('huge')!.estimatedMemoryMb + byId.get('medium')!.estimatedMemoryMb,
    );
  });

  it('sums output and block fetch across every channel', () => {
    const run = estimateRunCapacity(eight(), FULL, 1);
    const sum = (pick: (e: typeof run.perChannel[0]) => number): number =>
      run.perChannel.reduce((total, e) => total + pick(e), 0);

    expect(run.totalOutputMb).toBe(sum((e) => e.estimatedOutputMb));
    expect(run.totalBlockFetchMb).toBe(sum((e) => e.estimatedBlockFetchMb));
  });

  it('peaks the private state and the spill over the same workers', () => {
    const channels = eight().map((c, i) =>
      withCollections(2, { channelId: c.channelId, ledgerHeight: (i + 1) * 100_000 }),
    );
    const run = estimateRunCapacity(channels, FULL, 2);
    const largest = [...run.perChannel].sort(
      (a, b) => b.estimatedMemoryMb - a.estimatedMemoryMb,
    );

    expect(run.peakPrivateStateMb).toBe(
      largest[0].estimatedPrivateMemoryMb + largest[1].estimatedPrivateMemoryMb,
    );
    expect(run.peakSpillMb).toBe(largest[0].estimatedDiskMb + largest[1].estimatedDiskMb);
  });

  it('handles a run with no channels', () => {
    const run = estimateRunCapacity([], FULL, 8);

    expect(run.workers).toBe(1);
    expect(run.peakAccumulatorMb).toBe(0);
    expect(run.totalOutputMb).toBe(0);
  });
});

describe('printCapacityAdvisory', () => {
  let printed: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    printed = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      printed.push(String(line ?? ''));
    });
  });

  afterEach(() => spy.mockRestore());

  const output = (): string => printed.join('\n');

  it('prints a block per channel', () => {
    printCapacityAdvisory([
      makeChannel({ channelId: 'ch0' }),
      makeChannel({ channelId: 'ch1' }),
    ]);

    expect(output()).toContain('Channel: ch0');
    expect(output()).toContain('Channel: ch1');
  });

  // `discover` runs before the operator has chosen a tier, so it cannot pick one.
  it('prices all three tiers', () => {
    printCapacityAdvisory([makeChannel({ ledgerHeight: 500_000 })]);

    expect(output()).toMatch(/tier 1.*tier 2.*tier 3/);
  });

  // Nor has the operator chosen a --concurrency, so both ends of the range are
  // shown rather than one of them presented as the answer.
  it('prints both ends of the concurrency range for a multi-channel network', () => {
    printCapacityAdvisory([
      makeChannel({ channelId: 'ch0', ledgerHeight: 500_000 }),
      makeChannel({ channelId: 'ch1', ledgerHeight: 1_000_000 }),
    ]);

    // One at a time holds the larger channel's 945 MB; together they hold that
    // plus the smaller channel's 473 MB.
    expect(output()).toContain(
      'Peak accumulator:     ~945 MB at --concurrency 1, ~1,418 MB with all 2 in parallel',
    );
  });

  it('leaves out the totals block for a single channel', () => {
    printCapacityAdvisory([makeChannel({ ledgerHeight: 500_000 })]);
    expect(output()).not.toContain('Totals (all channels)');
  });

  // The large channel comes first, so the flag has to survive the small one that
  // follows it rather than being whatever the last channel decided.
  it('warns once when any channel is estimated too large for memory', () => {
    printCapacityAdvisory([
      makeChannel({ channelId: 'huge', ledgerHeight: 2_300_000 }),
      makeChannel({ channelId: 'small', ledgerHeight: 100 }),
    ]);

    expect(output()).toContain('Channel: huge [!]');
    expect(output()).not.toContain('Channel: small [!]');
    expect(output().match(/--state-backend leveldb is strongly recommended/g)).toHaveLength(1);
  });

  it('says nothing about leveldb for a network that fits in memory', () => {
    printCapacityAdvisory([makeChannel({ ledgerHeight: 100 })]);
    expect(output()).not.toContain('strongly recommended');
  });

  it('names implicit collections as unaccounted for', () => {
    printCapacityAdvisory([makeChannel()]);
    expect(output()).toContain('implicit collections will write more than is shown');
  });
});
