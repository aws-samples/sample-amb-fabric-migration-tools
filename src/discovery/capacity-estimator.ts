// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { keyChargeBytes } from '../extraction/state-accumulator';
import { ChannelInfo, ExtractionRecord, FabricIdentity, MigrationTier } from '../types';

const MB = 1024 * 1024;

/**
 * Heuristic constants for capacity estimation.
 *
 * These are conservative estimates based on typical Fabric workloads.
 * Actual values depend on chaincode behavior, transaction frequency,
 * value sizes, and key cardinality — which can't be known until extraction.
 */
const ESTIMATES = {
  /** Average bytes per block fetched from the peer (protobuf-encoded). */
  avgBlockSizeBytes: 4 * 1024, // 4 KB (config blocks are small, data blocks vary widely)
  /** Average write-set entries per data block (varies enormously by workload). */
  avgWritesPerBlock: 3,
  /**
   * Write-set entries per transaction.
   *
   * Block metadata is one record per *transaction*, each listing the keys that
   * transaction wrote, so this is what turns a write count into a record count.
   */
  avgWritesPerTx: 2,
  /** Average key size in bytes. */
  avgKeySizeBytes: 50,
  /**
   * Conservative average value size, as the extraction emits it.
   *
   * `value-codec` emits base64 for any value that does not round-trip as UTF-8,
   * and both the accumulator and the output files hold the encoded form — so a
   * binary ledger costs 4 bytes here for every 3 on the ledger, while a ledger of
   * JSON documents costs what it holds.
   */
  avgValueSizeBytes: 500,
  /** Per-key overhead on disk in LevelDB (key encoding + block index). */
  perKeyDiskOverheadBytes: 50,
  /**
   * Fraction of total write-set entries that remain as live keys (not deleted/overwritten).
   * On ledgers with heavy overwrites, this is low (0.1-0.3).
   * On append-mostly ledgers, this is high (0.7-0.9).
   * We use a middle estimate.
   */
  liveKeyFraction: 0.5,
};

/** A signing identity of typical size, embedded in most record kinds. */
const SAMPLE_CREATOR: FabricIdentity = {
  mspId: 'Org1MSP',
  certFingerprint: 'f'.repeat(64), // SHA-256 hex
  commonName: 'User1@org1.example.com',
  org: 'org1.example.com',
};

/**
 * Bytes one NDJSON line costs, per record kind, at the modelled key and value
 * sizes.
 *
 * Measured by serialising a representative record of each kind rather than
 * multiplying the payload by a fudge factor: every kind carries a different
 * envelope — a history record carries a txId, a timestamp and a whole creator
 * identity, a hash record carries no value at all, a metadata record carries a
 * list of keys — and one factor over "key + value" cannot express that. A record
 * shape that grows a field moves this figure with it.
 */
function measureRecordBytes(): Record<string, number> {
  const channel = 'mychannel';
  const chaincode = 'mycc';
  const collection = 'collectionMarbles';
  const key = 'k'.repeat(ESTIMATES.avgKeySizeBytes);
  const value = 'v'.repeat(ESTIMATES.avgValueSizeBytes);
  const valueEncoding = 'base64' as const;
  const txId = 'a'.repeat(64);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const blockNumber = 1_000_000;
  const creator = SAMPLE_CREATOR;

  // The newline the writer appends is part of what the file costs.
  const line = (record: ExtractionRecord): number =>
    Buffer.byteLength(JSON.stringify(record), 'utf-8') + 1;

  return {
    publicState: line({
      _type: 'public_state', channel, chaincode, key, value, valueEncoding, creator,
    }),
    publicHistory: line({
      _type: 'public_history', channel, chaincode, key, value, valueEncoding,
      txId, txIndex: 0, blockNumber, timestamp, isDelete: false, creator,
    }),
    blockMetadata: line({
      _type: 'block_metadata', channel, blockNumber, txId, txIndex: 0, timestamp,
      chaincodeId: chaincode,
      keysWritten: new Array(ESTIMATES.avgWritesPerTx).fill(key),
      keysDeleted: [],
      creator,
    }),
    privateState: line({
      _type: 'private_state', channel, chaincode, collection, key, value, valueEncoding, creator,
    }),
    privateHistory: line({
      _type: 'private_history', channel, chaincode, collection, key, value, valueEncoding,
      txId, blockNumber, txIndex: 0, timestamp, isDelete: false, creator,
    }),
    privateHash: line({
      _type: 'private_hash', channel, chaincode, collection, key,
      hash: 'b'.repeat(64), blockNumber, txId, txIndex: 0,
    }),
  };
}

const RECORD_BYTES = measureRecordBytes();

/** What the run will do, which decides which files it writes and how often. */
export interface CapacityInputs {
  /** Tier being extracted: tier 2 adds block metadata, tier 3 adds history. */
  tier: MigrationTier;
  /**
   * Whether the peer will deliver private values.
   *
   * Without `DeliverWithPrivateData` there is no private state or private
   * history at all — only the hashes the block walk reads out of the block — and
   * the ledger is walked once instead of twice.
   */
  privateDataDelivery: boolean;
}

/** NDJSON output a run writes, split by the files it lands in (MB). */
export interface OutputBreakdownMb {
  publicStateMb: number;
  publicHistoryMb: number;
  blockMetadataMb: number;
  privateStateMb: number;
  privateHistoryMb: number;
  privateHashesMb: number;
}

export interface CapacityEstimate {
  channelId: string;
  ledgerHeight: number;
  chaincodeCount: number;
  /**
   * Collections the chaincodes declare. Synthesized implicit collections are not
   * counted: one exists per channel org per chaincode regardless of use, so
   * including them would misreport how much private data a channel holds.
   */
  collectionCount: number;

  /** Estimated total write-set entries across all blocks. */
  estimatedTotalWrites: number;
  /** Estimated number of live keys (current state). */
  estimatedLiveKeys: number;
  /**
   * Estimated transactions across all blocks.
   *
   * Block metadata is one record per transaction rather than per write, so this
   * is the count behind the tier 2 output figure.
   */
  estimatedTransactions: number;

  /** Estimated memory for the state accumulator, which `--memory-limit` bounds (MB). */
  estimatedMemoryMb: number;
  /**
   * Estimated memory for private current state (MB).
   *
   * Reported separately because no flag bounds it: the delivery pass holds one
   * record per private key for the whole channel in a plain `Map`
   * (`private-data-delivery.ts`), so it neither promotes to LevelDB nor counts
   * against `--memory-limit`.
   */
  estimatedPrivateMemoryMb: number;
  /** Estimated LevelDB disk usage if the accumulator spills (MB). */
  estimatedDiskMb: number;
  /** Estimated NDJSON output for this tier (MB). */
  estimatedOutputMb: number;
  /** Which files that output lands in. */
  outputBreakdownMb: OutputBreakdownMb;
  /** Estimated total block data to fetch from the peer, over every pass (MB). */
  estimatedBlockFetchMb: number;

  /** Recommended state backend based on estimated memory. */
  recommendedBackend: 'memory' | 'auto' | 'leveldb';
  /** Recommended --memory-limit setting (MB). */
  recommendedMemoryLimitMb: number;
  /** Whether the estimate exceeds safe in-memory limits. */
  memoryWarning: boolean;
}

/** What a whole run needs: what it holds at once, and what it writes in total. */
export interface RunCapacityEstimate {
  perChannel: CapacityEstimate[];
  /** Channels holding state at the same time: `min(concurrency, channels)`. */
  workers: number;
  /** Accumulator memory the `workers` largest channels hold at once (MB). */
  peakAccumulatorMb: number;
  /** Private current state those channels hold at once (MB). */
  peakPrivateStateMb: number;
  /** LevelDB spill those channels hold at once, if they all promote (MB). */
  peakSpillMb: number;
  /** NDJSON written across every channel — cumulative, so a sum (MB). */
  totalOutputMb: number;
  /** Block data fetched across every channel — cumulative (MB). */
  totalBlockFetchMb: number;
}

/** Write-set entries the channel's private collections are modelled as holding. */
function privateWriteCount(
  channel: ChannelInfo,
  collectionCount: number,
  totalWrites: number,
): number {
  // The manifest supports one ratio and no more: a collection is assumed to
  // carry what one chaincode's public namespace carries. Implicit collections
  // are excluded from the count for the reason they always are, so a 2.x channel
  // whose private data lives in them is estimated at zero here.
  const perNamespace = totalWrites / Math.max(1, channel.chaincodes.length);
  return Math.ceil(collectionCount * perNamespace);
}

/** Record counts the tier will produce, before they are priced. */
interface RecordCounts {
  liveKeys: number;
  totalWrites: number;
  transactions: number;
  privateLiveKeys: number;
  privateWrites: number;
}

/** NDJSON bytes per file family, for the records this tier writes. */
function outputBytes(counts: RecordCounts, inputs: CapacityInputs): Record<string, number> {
  const withAudit = inputs.tier >= MigrationTier.StateWithAudit;
  const fullHistory = inputs.tier >= MigrationTier.FullHistory;
  const values = inputs.privateDataDelivery;

  return {
    publicState: counts.liveKeys * RECORD_BYTES.publicState,
    publicHistory: fullHistory ? counts.totalWrites * RECORD_BYTES.publicHistory : 0,
    blockMetadata: withAudit ? counts.transactions * RECORD_BYTES.blockMetadata : 0,
    privateState: values ? counts.privateLiveKeys * RECORD_BYTES.privateState : 0,
    privateHistory:
      fullHistory && values ? counts.privateWrites * RECORD_BYTES.privateHistory : 0,
    // Hashes come out of the block itself, so they are written whether or not
    // the peer will part with the values behind them.
    privateHashes: fullHistory ? counts.privateWrites * RECORD_BYTES.privateHash : 0,
  };
}

const toMb = (bytes: number): number => Math.ceil(bytes / MB);

/**
 * Estimate the storage and memory capacity required for extraction.
 *
 * These are heuristic estimates based on ledger height and chaincode count.
 * Actual resource usage depends on workload characteristics that can only
 * be determined by examining the blocks.
 *
 * The estimates are intentionally conservative (they tend to overestimate)
 * so that users provision sufficient resources rather than running out
 * mid-extraction.
 *
 * @param channel The channel as discovery described it.
 * @param inputs The tier being extracted and whether private values will arrive.
 * @returns Per-channel figures, including which files the output lands in.
 */
export function estimateCapacity(
  channel: ChannelInfo,
  inputs: CapacityInputs,
): CapacityEstimate {
  const collectionCount = channel.chaincodes.reduce(
    (sum, cc) => sum + cc.collections.filter((c) => !c.implicit).length,
    0,
  );

  const estimatedTotalWrites = channel.ledgerHeight * ESTIMATES.avgWritesPerBlock;
  const privateWrites = privateWriteCount(channel, collectionCount, estimatedTotalWrites);
  const counts: RecordCounts = {
    liveKeys: Math.ceil(estimatedTotalWrites * ESTIMATES.liveKeyFraction),
    totalWrites: estimatedTotalWrites,
    transactions: Math.ceil(estimatedTotalWrites / ESTIMATES.avgWritesPerTx),
    privateLiveKeys: Math.ceil(privateWrites * ESTIMATES.liveKeyFraction),
    privateWrites,
  };

  // The accumulator's own arithmetic, so the figure predicts the promotion
  // threshold rather than a second opinion about it.
  const perKeyMemory = keyChargeBytes(ESTIMATES.avgKeySizeBytes) + ESTIMATES.avgValueSizeBytes;
  const estimatedMemoryMb = toMb(counts.liveKeys * perKeyMemory);

  const perKeyDisk =
    ESTIMATES.perKeyDiskOverheadBytes + ESTIMATES.avgKeySizeBytes + ESTIMATES.avgValueSizeBytes;

  const bytes = outputBytes(counts, inputs);
  const totalOutputBytes = Object.values(bytes).reduce((sum, b) => sum + b, 0);

  // The delivery pass walks the same ledger a second time, so a channel whose
  // private data will be delivered is fetched twice.
  const fetchPasses = inputs.privateDataDelivery ? 2 : 1;

  return {
    channelId: channel.channelId,
    ledgerHeight: channel.ledgerHeight,
    chaincodeCount: channel.chaincodes.length,
    collectionCount,
    estimatedTotalWrites,
    estimatedLiveKeys: counts.liveKeys,
    estimatedTransactions: counts.transactions,
    estimatedMemoryMb,
    // A floor: the delivery map holds a whole record object per key, not just
    // the key and value the accumulator keeps.
    estimatedPrivateMemoryMb: inputs.privateDataDelivery
      ? toMb(counts.privateLiveKeys * perKeyMemory)
      : 0,
    estimatedDiskMb: toMb(counts.liveKeys * perKeyDisk),
    estimatedOutputMb: toMb(totalOutputBytes),
    outputBreakdownMb: {
      publicStateMb: toMb(bytes.publicState),
      publicHistoryMb: toMb(bytes.publicHistory),
      blockMetadataMb: toMb(bytes.blockMetadata),
      privateStateMb: toMb(bytes.privateState),
      privateHistoryMb: toMb(bytes.privateHistory),
      privateHashesMb: toMb(bytes.privateHashes),
    },
    estimatedBlockFetchMb: toMb(
      channel.ledgerHeight * ESTIMATES.avgBlockSizeBytes * fetchPasses,
    ),
    ...recommendation(estimatedMemoryMb),
  };
}

/** Backend and limit to recommend for a channel of this estimated size. */
function recommendation(estimatedMemoryMb: number): {
  recommendedBackend: 'memory' | 'auto' | 'leveldb';
  recommendedMemoryLimitMb: number;
  memoryWarning: boolean;
} {
  if (estimatedMemoryMb < 256) {
    return { recommendedBackend: 'memory', recommendedMemoryLimitMb: 512, memoryWarning: false };
  }

  if (estimatedMemoryMb < 2048) {
    return {
      recommendedBackend: 'auto',
      recommendedMemoryLimitMb: Math.min(estimatedMemoryMb, 1024),
      memoryWarning: false,
    };
  }

  return { recommendedBackend: 'leveldb', recommendedMemoryLimitMb: 512, memoryWarning: true };
}

/** Sum of the `count` largest values — what is held at once, not what is held at all. */
function sumLargest(values: number[], count: number): number {
  return [...values]
    .sort((a, b) => b - a)
    .slice(0, count)
    .reduce((sum, v) => sum + v, 0);
}

/**
 * Estimate what a whole run needs, separating what it holds at once from what
 * it writes in total.
 *
 * Summing memory across channels is the defect C3 named: eight channels
 * extracted one at a time never hold eight accumulators, so the sum overstates
 * the peak eightfold on the sequential default. Output and block fetch are
 * genuinely cumulative — every channel's records stay on disk — so those remain
 * sums. The peak takes the largest channels rather than the first `workers` of
 * them, since a worker pool is free to schedule them in any order.
 *
 * @param channels Channels the run will extract, after any `--channels` filter.
 * @param inputs The tier being extracted and whether private values will arrive.
 * @param concurrency The run's `--concurrency`.
 * @returns Per-channel estimates plus the run's peaks and totals.
 */
export function estimateRunCapacity(
  channels: ChannelInfo[],
  inputs: CapacityInputs,
  concurrency: number,
): RunCapacityEstimate {
  const perChannel = channels.map((channel) => estimateCapacity(channel, inputs));
  const workers = Math.max(1, Math.min(concurrency, channels.length));
  const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);

  return {
    perChannel,
    workers,
    peakAccumulatorMb: sumLargest(perChannel.map((e) => e.estimatedMemoryMb), workers),
    peakPrivateStateMb: sumLargest(perChannel.map((e) => e.estimatedPrivateMemoryMb), workers),
    peakSpillMb: sumLargest(perChannel.map((e) => e.estimatedDiskMb), workers),
    totalOutputMb: sum(perChannel.map((e) => e.estimatedOutputMb)),
    totalBlockFetchMb: sum(perChannel.map((e) => e.estimatedBlockFetchMb)),
  };
}

const TIERS = [
  MigrationTier.CurrentState,
  MigrationTier.StateWithAudit,
  MigrationTier.FullHistory,
];

/** `~1 MB (tier 1) / ~2 MB (tier 2) / ~3 MB (tier 3)`, since `discover` cannot know the tier. */
function perTierOutput(estimate: (tier: MigrationTier) => number): string {
  return TIERS.map((tier) => `~${estimate(tier).toLocaleString()} MB (tier ${tier})`).join(' / ');
}

const mb = (value: number): string => `~${value.toLocaleString()} MB`;

/** One channel's block in the advisory. Returns whether it warned. */
function printChannel(channel: ChannelInfo): boolean {
  const forTier = (tier: MigrationTier): CapacityEstimate =>
    estimateCapacity(channel, { tier, privateDataDelivery: true });
  const est = forTier(MigrationTier.FullHistory);
  const line = (label: string, value: string): void =>
    console.log(`    ${label.padEnd(22)}${value}`);

  console.log(`  Channel: ${est.channelId}${est.memoryWarning ? ' [!]' : ''}`);
  line('Ledger height:', `${est.ledgerHeight.toLocaleString()} blocks`);
  line('Chaincodes:', `${est.chaincodeCount} (${est.collectionCount} private collections)`);
  line('Est. live keys:', `~${est.estimatedLiveKeys.toLocaleString()}`);
  line(
    'Est. transactions:',
    `~${est.estimatedTransactions.toLocaleString()} — one block-metadata record each, tier 2+`,
  );
  line(
    'Est. accumulator:',
    `${mb(est.estimatedMemoryMb)} in memory, ${mb(est.estimatedDiskMb)} if it spills to LevelDB`,
  );
  line(
    'Est. private state:',
    `${mb(est.estimatedPrivateMemoryMb)} in memory, a whole channel's worth at once`,
  );
  line(
    'Est. block fetch:',
    `${mb(est.estimatedBlockFetchMb)} — two walks: state reconstruction, then private data`,
  );
  line('Est. NDJSON output:', perTierOutput((tier) => forTier(tier).estimatedOutputMb));
  line('Recommended backend:', `--state-backend ${est.recommendedBackend}`);
  if (est.recommendedBackend === 'auto') {
    line('Recommended limit:', `--memory-limit ${est.recommendedMemoryLimitMb}`);
  }
  console.log('');
  return est.memoryWarning;
}

/**
 * What the run holds at once against what it writes in total.
 *
 * Two peaks are printed because `discover` does not know what `--concurrency`
 * the extraction will use, and they are the two ends of the range: one channel
 * at a time, or all of them together.
 */
function printTotals(channels: ChannelInfo[]): void {
  const inputs = { tier: MigrationTier.FullHistory, privateDataDelivery: true };
  const sequential = estimateRunCapacity(channels, inputs, 1);
  const parallel = estimateRunCapacity(channels, inputs, channels.length);

  console.log('  Totals (all channels):');
  console.log(
    `    Peak accumulator:     ${mb(sequential.peakAccumulatorMb)} at --concurrency 1, ` +
      `${mb(parallel.peakAccumulatorMb)} with all ${channels.length} in parallel`,
  );
  console.log(
    `    Peak private state:   ${mb(sequential.peakPrivateStateMb)} at --concurrency 1, ` +
      `${mb(parallel.peakPrivateStateMb)} in parallel`,
  );
  console.log(
    `    Peak LevelDB spill:   ${mb(sequential.peakSpillMb)} at --concurrency 1, ` +
      `${mb(parallel.peakSpillMb)} in parallel`,
  );
  console.log(`    Block fetch:          ${mb(sequential.totalBlockFetchMb)}`);
  console.log(
    `    NDJSON output:        ${perTierOutput(
      (tier) => estimateRunCapacity(channels, { ...inputs, tier }, 1).totalOutputMb,
    )}`,
  );
  console.log('');
}

/**
 * Print a capacity advisory for all channels in the manifest.
 *
 * `extract` logs the same estimate for the tier and concurrency it was actually
 * given (`HybridExtractor.run`); this is the version an operator reads before
 * choosing either, so it shows all three tiers and both ends of the concurrency
 * range.
 */
export function printCapacityAdvisory(channels: ChannelInfo[]): void {
  console.log('\n  Capacity Estimates (heuristic — actual usage depends on workload):\n');

  let anyWarning = false;
  for (const channel of channels) {
    anyWarning = printChannel(channel) || anyWarning;
  }

  if (channels.length > 1) {
    printTotals(channels);
  }

  if (anyWarning) {
    console.log(
      '  [!] WARNING: One or more channels have large estimated state. Using\n' +
        '      --state-backend leveldb is strongly recommended to avoid out-of-memory\n' +
        '      errors. Ensure the EC2 instance has sufficient EBS/local disk.\n',
    );
  }

  console.log(
    '  NOTE: These estimates assume average workloads. Ledgers with large values\n' +
      '  (>5KB), high write density, or low deletion rates may require more resources.\n' +
      '  Private data is estimated from declared collections only, so a Fabric 2.x\n' +
      '  channel using implicit collections will write more than is shown here.\n' +
      '  Monitor the extraction logs for state accumulator backend promotions.\n',
  );
}
