// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { NetworkAdapter, ContractAdapter } from '../../connection/network-adapter';
import {
  MigrationTier,
  ChannelInfo,
  IdentityRecord,
  FabricIdentity,
  PublicStateRecord,
} from '../../types';
import { BlockParser, ParsedBlock } from '../block-parser';
import { CheckpointManager } from '../checkpoint-manager';
import { NdjsonWriter } from '../../output/ndjson-writer';
import { FileLayoutManager } from '../../output/file-layout-manager';
import {
  StateAccumulator,
  StateBackend,
  createStateAccumulator,
} from '../state-accumulator';
import * as crypto from 'crypto';
import { ExtractionError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';
import { decodeProtobufBlock } from '../block-decoder';
import type { BlockSink } from '../block-archive';

const logger = createLogger('block-walker');

const DEFAULT_PREFETCH_BUFFER = 8;
const DEFAULT_MEMORY_LIMIT_MB = 512;

/** Registry size at whose multiples growth is reported. */
const IDENTITY_GROWTH_WARN_AT = 10_000;

export interface BlockWalkerOptions {
  reconstructState?: boolean;
  /** Number of blocks to fetch ahead while processing. Default: 8. Set to 0 to disable. */
  prefetchBuffer?: number;
  /** Verify block hash chain integrity during walk. Default: true. */
  verifyHashChain?: boolean;
  /** State accumulator backend. Default: 'auto' (in-memory with LevelDB promotion). */
  stateBackend?: StateBackend;
  /** Memory limit in MB before promoting to LevelDB. Default: 512. */
  memoryLimitMb?: number;
  /** Directory for LevelDB storage when spilling to disk. Default: os.tmpdir(). */
  stateDataDir?: string;
  /** Continue extraction when hash chain breaks instead of throwing. Default: false. */
  continueOnHashChainBreak?: boolean;
  /**
   * Blocks between durability points, where the NDJSON files are fsynced and the
   * checkpoint file is then rewritten. Default: 100. Set to 0 to fsync nothing
   * and write the checkpoint once, when the walk ends.
   */
  durabilityInterval?: number;
  /**
   * Receives every block's raw bytes after its hash-chain check and before any
   * record is derived from it (`--save-blocks`). Absent by default, in which
   * case nothing in the walk differs from a walker that never heard of it.
   */
  blockSink?: BlockSink;
  /**
   * Verify and hand blocks to the sink, derive nothing from them (`--blocks-only`).
   * Needs a `blockSink`; no state, history, metadata or identity record is produced.
   */
  blocksOnly?: boolean;
  /**
   * Bytes held in memory beside this walk's state accumulator and counted
   * against the same `memoryLimitMb`: the private pass's map, when it runs
   * during the walk.
   */
  alsoHeldBytes?: () => number;
  /**
   * The tip an earlier walk of this channel recorded. A walk that starts at the
   * block after it checks that the peer still serves that block, so a directory
   * is never continued with another chain's blocks.
   */
  expectedTip?: WalkTip;
}

/** The last block a walk verified: its number and SHA-256(ASN.1 header). */
export interface WalkTip {
  blockNumber: number;
  headerHash: string;
}

export interface IntegrityReport {
  blocksVerified: number;
  hashChainValid: boolean;
  /** Block number where the first hash chain break was detected, if any. */
  brokenAtBlock?: number;
  invalidTransactionsSkipped: number;
  /**
   * Blocks that produced no block-metadata records: config blocks and blocks
   * whose every transaction was invalidated. These leave legitimate gaps in
   * block-metadata.ndjson, and recording them here is the only way a later
   * validation pass can tell such a gap from a lost block.
   *
   * Only populated at Tier 2+, where block metadata is written at all.
   */
  blocksWithoutMetadata: number[];
}

export class BlockWalker {
  private blockParser = new BlockParser();
  private identityRegistry = new Map<string, IdentityRecord>();
  private stateAccumulator: StateAccumulator | null = null;
  private readonly reconstructState: boolean;
  private readonly prefetchBuffer: number;
  private readonly verifyHashChain: boolean;
  private readonly continueOnHashChainBreak: boolean;
  private readonly stateBackend: StateBackend;
  private readonly memoryLimitMb: number;
  private readonly stateDataDir?: string;
  private readonly durabilityInterval: number;
  private readonly blockSink?: BlockSink;
  private readonly blocksOnly: boolean;
  private readonly expectedTip?: WalkTip;
  /** Number of the block whose header hash is `lastBlockHeaderHash`, or -1. */
  private lastBlockNumber = -1;
  private integrityReport: IntegrityReport = {
    blocksVerified: 0,
    hashChainValid: true,
    invalidTransactionsSkipped: 0,
    blocksWithoutMetadata: [],
  };
  /** SHA-256(ASN.1(BlockHeader)) of the most recently processed block, for chain verification. */
  private lastBlockHeaderHash: string = '';

  constructor(
    private readonly network: NetworkAdapter,
    private readonly writer: NdjsonWriter,
    private readonly layout: FileLayoutManager,
    private readonly checkpointManager: CheckpointManager,
    private readonly tier: MigrationTier,
    options?: BlockWalkerOptions,
  ) {
    this.reconstructState = options?.reconstructState ?? false;
    this.prefetchBuffer = options?.prefetchBuffer ?? DEFAULT_PREFETCH_BUFFER;
    this.verifyHashChain = options?.verifyHashChain ?? true;
    this.continueOnHashChainBreak = options?.continueOnHashChainBreak ?? false;
    this.stateBackend = options?.stateBackend ?? 'auto';
    this.memoryLimitMb = options?.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    this.stateDataDir = options?.stateDataDir;
    this.durabilityInterval = options?.durabilityInterval ?? 100;
    this.blockSink = options?.blockSink;
    this.blocksOnly = options?.blocksOnly ?? false;
    this.expectedTip = options?.expectedTip;
    if (this.blocksOnly && !this.blockSink) {
      throw new ExtractionError('A blocks-only walk needs a block sink: it would read every block and keep nothing');
    }

    if (this.reconstructState) {
      this.stateAccumulator = createStateAccumulator({
        backend: this.stateBackend,
        memoryLimitBytes: this.memoryLimitMb * 1024 * 1024,
        dataDir: this.stateDataDir,
        alsoHeldBytes: options?.alsoHeldBytes,
      });
    }
  }

  /**
   * Walk blocks from genesis (or checkpoint) to ledger height.
   * Tier 2: extract block metadata only.
   * Tier 3: extract full write-set history.
   *
   * Blocks are pre-fetched in parallel to hide network latency, then
   * processed strictly in order for correctness.
   */
  async walk(channel: ChannelInfo): Promise<IntegrityReport> {
    const channelId = channel.channelId;
    const startBlock = this.checkpointManager.getLastBlockNumber(channelId, 'block-walk') + 1;
    const endBlock = channel.ledgerHeight - 1; // ledger height = last block number + 1

    const archived = this.blockSink ? await this.requireArchiveMatches(channelId, startBlock) : undefined;

    if (startBlock > endBlock) {
      logger.info({ channelId, startBlock, endBlock }, 'Block walk already complete');
      return this.integrityReport;
    }

    if (this.verifyHashChain && startBlock > 0) await this.seedHashChain(channelId, startBlock - 1, archived);

    const totalBlocks = endBlock - startBlock + 1;
    logger.info(
      {
        channelId,
        startBlock,
        endBlock,
        totalBlocks,
        prefetchBuffer: this.prefetchBuffer,
        verifyHashChain: this.verifyHashChain,
        stateBackend: this.reconstructState ? this.stateBackend : 'n/a',
        memoryLimitMb: this.reconstructState ? this.memoryLimitMb : 'n/a',
      },
      'Starting block walk',
    );

    const contract = this.network.getContract('qscc');

    try {
      if (this.prefetchBuffer > 0) {
        await this.walkWithPrefetch(contract, channelId, startBlock, endBlock);
      } else {
        await this.walkSequential(contract, channelId, startBlock, endBlock);
      }
    } catch (err) {
      // A walk that dies still has to leave its progress on disk, or the rerun
      // repeats every block since the last durability point.
      this.makeDurable(channelId, true);
      throw err;
    }

    // Final durability point, before the caller writes identities and drains state.
    this.makeDurable(channelId);

    // Identity registry is NOT written here — the caller (HybridExtractor)
    // merges registries across all channels and writes once after all walks complete.

    if (this.stateAccumulator) {
      logger.info(
        {
          channelId,
          stateKeys: this.stateAccumulator.keyCount(),
          activeBackend: this.stateAccumulator.activeBackend(),
          estimatedMemoryMb: (this.stateAccumulator.estimatedMemoryBytes() / (1024 * 1024)).toFixed(1),
        },
        'State accumulation complete',
      );
    }

    if (this.verifyHashChain) {
      logger.info(
        {
          channelId,
          ...this.integrityReport,
        },
        this.integrityReport.hashChainValid
          ? 'Block walk complete — hash chain integrity verified'
          : 'Block walk complete — HASH CHAIN INTEGRITY FAILURE',
      );
    } else {
      logger.info(
        {
          channelId,
          blocksProcessed: totalBlocks,
          identities: this.identityRegistry.size,
        },
        'Block walk complete',
      );
    }

    return this.integrityReport;
  }

  /**
   * Start the chain check from the block before the walk's first.
   *
   * Without it a resumed or extended walk accepts its first block unchecked:
   * nothing links it to the blocks the earlier run verified. The peer's block
   * is hashed, and compared with the tip the earlier walk recorded if there is
   * one for that block.
   */
  private async seedHashChain(channelId: string, blockNum: number, served?: Uint8Array): Promise<void> {
    const bytes = served ?? await this.fetchBlock(this.network.getContract('qscc'), channelId, blockNum);
    const parsed = this.blockParser.parseBlock(this.decodeBlock(bytes));
    const hash = this.computeBlockHeaderHash(blockNum, parsed.previousHash, parsed.dataHash);
    if (this.expectedTip && this.expectedTip.blockNumber === blockNum && this.expectedTip.headerHash !== hash) {
      throw new ExtractionError(
        `Channel ${channelId}: block ${blockNum} served by the peer has header hash ${hash}, but the extraction being ` +
          `continued recorded ${this.expectedTip.headerHash}. The directory holds another chain; extract afresh.`,
      );
    }
    this.lastBlockHeaderHash = hash;
    this.lastBlockNumber = blockNum;
  }

  /**
   * Fill the state accumulator with the state an earlier extraction ended at,
   * before walking the blocks above it.
   *
   * @returns The number of keys seeded.
   */
  async seedState(records: AsyncIterable<PublicStateRecord>): Promise<number> {
    if (!this.stateAccumulator) throw new ExtractionError('seedState needs a walker that reconstructs state');
    let n = 0;
    for await (const r of records) {
      await this.stateAccumulator.put(r.chaincode, r.key, { value: r.value, valueEncoding: r.valueEncoding }, r.creator);
      n++;
    }
    return n;
  }

  /** The last block this walk verified, or the seeded one; `undefined` before either. */
  getWalkTip(): WalkTip | undefined {
    return this.lastBlockNumber >= 0 && this.lastBlockHeaderHash
      ? { blockNumber: this.lastBlockNumber, headerHash: this.lastBlockHeaderHash }
      : undefined;
  }

  /**
   * Sequential block fetching (prefetch disabled). Simple but slow for high-latency peers.
   */
  private async walkSequential(
    contract: ContractAdapter,
    channelId: string,
    startBlock: number,
    endBlock: number,
  ): Promise<void> {
    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      const blockBytes = await this.fetchBlock(contract, channelId, blockNum);
      await this.processAndCheckpoint(blockBytes, channelId, blockNum, startBlock, endBlock);
    }
  }

  /**
   * Pre-fetching block walk. Fetches up to `prefetchBuffer` blocks ahead
   * while processing the current block. Blocks are always *processed* in
   * strict order — only the network fetches happen concurrently.
   */
  private async walkWithPrefetch(
    contract: ContractAdapter,
    channelId: string,
    startBlock: number,
    endBlock: number,
  ): Promise<void> {
    const pending = new Map<number, Promise<Uint8Array>>();

    const prefetchEnd = Math.min(startBlock + this.prefetchBuffer - 1, endBlock);
    for (let i = startBlock; i <= prefetchEnd; i++) {
      pending.set(i, this.fetchBlock(contract, channelId, i));
    }

    let nextFetch = prefetchEnd + 1;

    try {
      for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
        const blockBytes = await pending.get(blockNum)!;
        pending.delete(blockNum);

        if (nextFetch <= endBlock) {
          pending.set(nextFetch, this.fetchBlock(contract, channelId, nextFetch));
          nextFetch++;
        }

        await this.processAndCheckpoint(blockBytes, channelId, blockNum, startBlock, endBlock);
      }
    } finally {
      // Drain any in-flight prefetch promises to avoid unhandled rejections
      if (pending.size > 0) {
        await Promise.allSettled(pending.values());
        pending.clear();
      }
    }
  }

  private async fetchBlock(
    contract: ContractAdapter,
    channelId: string,
    blockNum: number,
  ): Promise<Uint8Array> {
    return withRetry(
      async () => contract.evaluateTransaction('GetBlockByNumber', channelId, blockNum.toString()),
      `fetchBlock(${channelId}#${blockNum})`,
    );
  }

  private async processAndCheckpoint(
    blockBytes: Uint8Array,
    channelId: string,
    blockNum: number,
    startBlock: number,
    endBlock: number,
  ): Promise<void> {
    try {
      const blockJson = this.decodeBlock(blockBytes);
      const parsed = this.blockParser.parseBlock(blockJson);

      // Verify hash chain integrity
      if (this.verifyHashChain) {
        this.verifyBlock(parsed, blockNum);
      }

      if (this.blockSink) {
        this.blockSink.write({
          channelId,
          blockNumber: blockNum,
          bytes: blockBytes,
          previousHash: parsed.previousHash,
          dataHash: parsed.dataHash,
        });
      }

      if (!this.blocksOnly) await this.processBlock(parsed, channelId);

      this.recordProgress(channelId, blockNum);

      if (blockNum % 100 === 0) {
        const logFields: Record<string, unknown> = {
          channelId,
          blockNumber: blockNum,
          progress: `${blockNum - startBlock + 1}/${endBlock - startBlock + 1}`,
        };
        if (this.stateAccumulator) {
          logFields.stateKeys = this.stateAccumulator.keyCount();
          logFields.stateBackend = this.stateAccumulator.activeBackend();
          logFields.estimatedMemoryMb =
            (this.stateAccumulator.estimatedMemoryBytes() / (1024 * 1024)).toFixed(1);
        }
        logger.info(logFields, 'Block walk progress');
      }
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      throw new ExtractionError(
        `Block walk failed at block ${blockNum} on channel ${channelId}`,
        err as Error,
      );
    }
  }

  /**
   * Note a block whose records are all written, and periodically make that
   * durable.
   *
   * The checkpoint only reaches its file at a durability point. Writing it per
   * block cost 0.366 ms of stringify-write-rename on a test machine — 49
   * minutes of blocked event loop across an 8M-block walk, spent to persist a
   * block number that was already stale by the time the next block was
   * fetched. In-process nothing changes: `CheckpointManager` answers from
   * memory, so a walk resumed within the same run still starts where this one
   * stopped.
   *
   * @param channelId Channel being walked.
   * @param blockNum Block whose records are all written.
   */
  private recordProgress(channelId: string, blockNum: number): void {
    this.checkpointManager.recordBlock(channelId, 'block-walk', blockNum);

    if (
      this.durabilityInterval > 0 &&
      blockNum > 0 &&
      blockNum % this.durabilityInterval === 0
    ) {
      this.makeDurable(channelId);
    }
  }

  /**
   * A checkpoint can claim blocks the archive never saw: an earlier run made
   * without `--save-blocks` walked them and moved on. Resuming now would leave a
   * hole at the start of the archive, which nothing downstream could repair, so
   * refuse and say what to do.
   */
  /** @returns The peer's block `startBlock - 1` when it was fetched for the check. */
  private async requireArchiveMatches(channelId: string, startBlock: number): Promise<Uint8Array | undefined> {
    const have = this.blockSink!.contiguousBlocks(channelId);
    if (have < startBlock) {
      throw new ExtractionError(
        `Channel ${channelId}: the checkpoint says blocks 0..${startBlock - 1} were already extracted, but the ` +
          `block archive holds only ${have} of them. They were walked without --save-blocks. Extract into a fresh ` +
          '--output-dir with --save-blocks, or run --blocks-only to build the archive on its own.',
      );
    }
    // The archive must be this channel of this network, not a look-alike: the last block it holds has to be the
    // block the peer serves under that number. Otherwise a rerun against another network would extend, or just
    // re-label, a chain that is not this one.
    if (startBlock > 0) {
      const last = startBlock - 1;
      const served = await this.fetchBlock(this.network.getContract('qscc'), channelId, last);
      if (!this.blockSink!.holds(channelId, last, served)) {
        throw new ExtractionError(
          `Channel ${channelId}: block ${last} in the archive differs from the block the peer serves under that number. ` +
            'The archive holds a different channel or network. Use an empty directory for this one.',
        );
      }
      return served;
    }
    return undefined;
  }

  /**
   * Fsync the written records, then write the checkpoint that claims them.
   *
   * The order is the point. `stream.write()` resolves once a record is in the
   * stream buffer, so a checkpoint renamed at that moment names records that a
   * SIGKILL still loses (C6). Syncing first means the persisted block number
   * can lag the durable records but never lead them, so the worst a rerun does
   * is re-walk blocks — never skip them.
   *
   * @param channelId Channel being walked, for the failure log.
   * @param walkFailed True when the walk is already unwinding. A checkpoint
   *   write that fails here is almost always the same disk problem that
   *   stopped the walk, and the error already in flight names the block it
   *   stopped at — so this one is logged rather than thrown over it.
   */
  private makeDurable(channelId: string, walkFailed = false): void {
    try {
      // The archive first: it may run ahead of the checkpoint, never behind it.
      this.blockSink?.flush(channelId);
      if (this.durabilityInterval > 0) {
        this.writer.syncAll();
      }
      this.checkpointManager.flush();
    } catch (err) {
      if (!walkFailed) throw err;
      logger.error(
        { channelId, error: (err as Error).message },
        'Could not record progress after the walk failed — the rerun will start ' +
          'from the last checkpoint that reached disk',
      );
    }
  }

  /**
   * Verify that this block's previousHash matches the prior block's dataHash.
   * The genesis block (block 0) has no previous hash to verify.
   */
  /**
   * Verify that this block's previousHash matches the ASN.1 header hash of the
   * prior block. Fabric computes block hashes as SHA-256 of an ASN.1 DER encoding
   * of {number, previous_hash, data_hash} — NOT just the data_hash.
   */
  private verifyBlock(parsed: ParsedBlock, blockNum: number): void {
    this.integrityReport.blocksVerified++;

    if (blockNum > 0 && this.lastBlockHeaderHash && parsed.previousHash) {
      if (parsed.previousHash !== this.lastBlockHeaderHash) {
        this.integrityReport.hashChainValid = false;
        if (this.integrityReport.brokenAtBlock === undefined) {
          this.integrityReport.brokenAtBlock = blockNum;
        }
        logger.error(
          {
            blockNumber: blockNum,
            expectedPreviousHash: this.lastBlockHeaderHash,
            actualPreviousHash: parsed.previousHash,
          },
          'BLOCK HASH CHAIN BREAK — block previousHash does not match prior block header hash',
        );
        if (!this.continueOnHashChainBreak) {
          throw new ExtractionError(
            `Hash chain integrity failure at block ${blockNum}: ` +
              `expected previousHash=${this.lastBlockHeaderHash}, got ${parsed.previousHash}. ` +
              'Use continueOnHashChainBreak option to continue extraction despite integrity failures.',
          );
        }
      }
    }

    // Compute SHA-256(ASN.1(BlockHeader)) for this block
    this.lastBlockHeaderHash = this.computeBlockHeaderHash(
      blockNum,
      parsed.previousHash,
      parsed.dataHash,
    );
    this.lastBlockNumber = blockNum;
  }

  /**
   * Compute the Fabric block header hash: SHA-256 of ASN.1 DER encoding of
   * { INTEGER number, OCTET STRING previous_hash, OCTET STRING data_hash }.
   * This matches Go's protoutil.BlockHeaderHash().
   */
  private computeBlockHeaderHash(
    blockNumber: number,
    previousHash: string,
    dataHash: string,
  ): string {
    // ASN.1 DER encode: SEQUENCE { INTEGER, OCTET STRING, OCTET STRING }
    const numberBuf = this.asn1EncodeInteger(blockNumber);
    const prevHashBuf = this.asn1EncodeOctetString(
      previousHash ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0),
    );
    const dataHashBuf = this.asn1EncodeOctetString(
      dataHash ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0),
    );

    const contentLen = numberBuf.length + prevHashBuf.length + dataHashBuf.length;
    const seqHeader = this.asn1LengthPrefix(0x30, contentLen);
    const derEncoded = Buffer.concat([seqHeader, numberBuf, prevHashBuf, dataHashBuf]);

    return crypto.createHash('sha256').update(derEncoded).digest('hex');
  }

  private asn1EncodeInteger(value: number): Buffer {
    // Encode as unsigned big-endian bytes
    if (value === 0) {
      return Buffer.from([0x02, 0x01, 0x00]);
    }
    const hex = value.toString(16);
    const paddedHex = hex.length % 2 ? '0' + hex : hex;
    let bytes = Buffer.from(paddedHex, 'hex');
    // If high bit is set, prepend 0x00 to keep it positive
    if (bytes[0] & 0x80) {
      bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
    }
    return Buffer.concat([this.asn1LengthPrefix(0x02, bytes.length), bytes]);
  }

  private asn1EncodeOctetString(data: Buffer): Buffer {
    return Buffer.concat([this.asn1LengthPrefix(0x04, data.length), data]);
  }

  private asn1LengthPrefix(tag: number, length: number): Buffer {
    if (length < 128) {
      return Buffer.from([tag, length]);
    } else if (length < 256) {
      return Buffer.from([tag, 0x81, length]);
    } else {
      return Buffer.from([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
    }
  }

  private async processBlock(parsed: ParsedBlock, channelId: string): Promise<void> {
    // Track identities from all transactions
    for (const tx of parsed.transactions) {
      this.trackIdentity(tx.creator, parsed.blockNumber);
    }

    // Accumulate current state from write sets when reconstruction is enabled.
    // The creator of the last write to each key is stored alongside the value
    // so it can be emitted in the PublicStateRecord for identity-mapped replay.
    if (this.stateAccumulator) {
      for (const tx of parsed.transactions) {
        for (const write of tx.writes) {
          if (write.isDelete) {
            await this.stateAccumulator.delete(write.namespace, write.key);
          } else {
            await this.stateAccumulator.put(write.namespace, write.key, write, tx.creator);
          }
        }
      }
    }

    if (this.tier >= MigrationTier.StateWithAudit) {
      // Tier 2+: write block metadata
      const metadataRecords = this.blockParser.toMetadataRecords(parsed, channelId);
      if (metadataRecords.length > 0) {
        await this.writer.writeBatch(
          this.layout.blockMetadataPath(channelId),
          metadataRecords,
        );
      } else {
        // Config block, or every transaction was invalidated. Record it so
        // validation can distinguish this expected gap from a lost block.
        this.integrityReport.blocksWithoutMetadata.push(parsed.blockNumber);
      }
    }

    if (this.tier >= MigrationTier.FullHistory) {
      // Tier 3: write full history records
      const historyRecords = this.blockParser.toHistoryRecords(parsed, channelId);
      if (historyRecords.length > 0) {
        await this.writer.writeBatch(
          this.layout.publicHistoryPath(channelId),
          historyRecords,
        );
      }

      // Write private data hash records from block
      const hashRecords = this.blockParser.toPrivateHashRecords(parsed, channelId);
      for (const record of hashRecords) {
        await this.writer.write(
          this.layout.privateHashesPath(
            channelId, record.chaincode, record.collection,
          ),
          record,
        );
      }
    }
  }

  /**
   * Returns an async iterable of the reconstructed current state, grouped by
   * chaincode namespace. Works for both in-memory and disk-backed accumulators.
   * Only populated when `reconstructState` was enabled.
   */
  async *getReconstructedState(channelId: string): AsyncGenerator<PublicStateRecord> {
    if (!this.stateAccumulator) return;
    for await (const record of this.stateAccumulator.drain(channelId)) {
      yield record;
    }
  }

  /**
   * Returns the integrity report from the most recent walk.
   */
  getIntegrityReport(): IntegrityReport {
    return {
      ...this.integrityReport,
      blocksWithoutMetadata: [...this.integrityReport.blocksWithoutMetadata],
    };
  }

  /**
   * Returns the accumulated identity registry from this block walk.
   * Keyed by `mspId:certFingerprint`.
   */
  getIdentityRegistry(): Map<string, IdentityRecord> {
    return this.identityRegistry;
  }

  /**
   * Returns the state accumulator for inspection (key count, backend, memory).
   */
  getStateAccumulator(): StateAccumulator | null {
    return this.stateAccumulator;
  }

  /**
   * Clean up resources (close LevelDB, remove temp files).
   */
  async cleanup(): Promise<void> {
    if (this.stateAccumulator) {
      await this.stateAccumulator.close();
    }
  }

  /**
   * Aggregate one transaction's creator into the in-memory identity registry.
   *
   * The registry is held whole for the length of the walk and never flushed
   * part-way. A flush would have to clear the map to free anything, and a key
   * seen again afterwards would start a second aggregate from `txCount: 1` —
   * leaving two partial records for one identity that no downstream fold can
   * reconcile. `GREATEST` in the PostgreSQL upsert would keep the larger and
   * silently under-count; summing would double-count an honest re-replay.
   *
   * Holding it is affordable because the registry is sized by the number of
   * distinct signing certificates in the network, not by ledger height: it
   * stops growing once every member has been seen. A cert-per-session issuer
   * is the exception, hence the growth warning.
   *
   * @param creator Identity that signed the transaction.
   * @param blockNumber Block the transaction was committed in.
   */
  private trackIdentity(creator: FabricIdentity, blockNumber: number): void {
    const key = `${creator.mspId}:${creator.certFingerprint}`;
    const existing = this.identityRegistry.get(key);

    if (existing) {
      existing.lastSeenBlock = Math.max(existing.lastSeenBlock, blockNumber);
      existing.txCount++;
      return;
    }

    this.identityRegistry.set(key, {
      _type: 'identity',
      ...creator,
      firstSeenBlock: blockNumber,
      lastSeenBlock: blockNumber,
      txCount: 1,
    });
    this.warnOnIdentityGrowth(blockNumber);
  }

  /**
   * Report registry growth so an unbounded issuer is visible before it
   * exhausts the heap.
   *
   * @param blockNumber Block being processed, for locating the growth.
   */
  private warnOnIdentityGrowth(blockNumber: number): void {
    const size = this.identityRegistry.size;
    if (size < IDENTITY_GROWTH_WARN_AT || size % IDENTITY_GROWTH_WARN_AT !== 0) {
      return;
    }
    logger.warn(
      { identityCount: size, blockNumber },
      'Identity registry is large — the network appears to issue a distinct ' +
        'signing certificate per session. The registry is held in memory for ' +
        'the whole walk; raise the heap with --max-old-space-size if the ' +
        'extraction runs out.',
    );
  }

  /**
   * Decode a raw block response into a JSON structure.
   * Tries JSON.parse first (fast path), falls back to protobuf decoding
   * via fabric-protos when the response is raw protobuf bytes.
   */
  /**
   * Decode a block exactly as qscc serves it: protobuf, always.
   *
   * There is deliberately no other format. The content check against the
   * header's `data_hash` needs the raw envelope bytes, which only the protobuf
   * form carries, so a block accepted in any other form would be walked
   * without it.
   */
  private decodeBlock(blockBytes: Uint8Array): any {
    return decodeProtobufBlock(Buffer.from(blockBytes));
  }
}
