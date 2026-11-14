import * as fs from 'fs';
import * as path from 'path';
import { NetworkAdapter } from '../../connection/network-adapter';
import { MigrationTier, ChannelInfo, PublicStateRecord } from '../../types';
import { BlockWalker, BlockWalkerOptions, WalkTip } from './block-walker';
import { NdjsonReader } from '../../replay/ndjson-reader';
import { stagedPath } from '../extension';
import { StateBackend } from '../state-accumulator';
import { CheckpointManager } from '../checkpoint-manager';
import { NdjsonWriter } from '../../output/ndjson-writer';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { createLogger } from '../../utils/logger';
import type { BlockSink } from '../block-archive';
import { stateReconstructionCompletePath } from '../state-completion';

const logger = createLogger('state-reconstruction-extractor');

export interface StateReconstructionOptions {
  stateBackend?: StateBackend;
  memoryLimitMb?: number;
  stateDataDir?: string;
  prefetchBuffer?: number;
  /** `--save-blocks`: receives every block's raw bytes during the walk. */
  blockSink?: BlockSink;
  /** See `BlockWalkerOptions.alsoHeldBytes`. */
  alsoHeldBytes?: () => number;
  /**
   * `extract --extend`: the walk continues a completed extraction. Its state
   * accumulator is seeded from the existing state file, and the new state is
   * written to that file's staged sibling, renamed over it at commit.
   */
  extension?: { expectedTip?: WalkTip };
}

/**
 * Reconstructs current public state for all chaincode namespaces by replaying
 * block write sets. Does not require any custom chaincode deployment.
 *
 * This works by walking all blocks from genesis to ledger height with the
 * BlockWalker in state-accumulation mode, then flushing the final state map
 * as PublicStateRecords grouped by chaincode namespace.
 *
 * For large ledgers, the state accumulator automatically promotes from
 * in-memory storage to a local LevelDB instance when memory pressure
 * exceeds the configured threshold.
 *
 * When used with Tier 2+, the same block walk also emits block metadata and
 * history records, avoiding redundant passes over the chain.
 */
export class StateReconstructionExtractor {
  constructor(
    private readonly network: NetworkAdapter,
    private readonly writer: NdjsonWriter,
    private readonly layout: FileLayoutManager,
    private readonly checkpointManager: CheckpointManager,
    private readonly tier: MigrationTier,
    private readonly stateOptions?: StateReconstructionOptions,
  ) {}

  /**
   * Walk blocks and reconstruct current state for all chaincode namespaces.
   * Returns the BlockWalker instance so the caller can access identity data.
   */
  async extract(channel: ChannelInfo): Promise<BlockWalker> {
    const channelId = channel.channelId;

    logger.info(
      {
        channelId,
        ledgerHeight: channel.ledgerHeight,
        stateBackend: this.stateOptions?.stateBackend ?? 'auto',
        memoryLimitMb: this.stateOptions?.memoryLimitMb ?? 512,
      },
      'Reconstructing state from blocks',
    );

    // State reconstruction requires a full block walk from genesis — the
    // accumulator is transient (in-memory or temp LevelDB). If a previous run
    // checkpointed progress but crashed before flushing state to disk, the
    // checkpoint will cause the walk to be skipped and produce an empty state
    // file. Detect this and reset the block-walk checkpoint so we re-walk.
    const stateFilePath = path.join(
      this.writer.getBaseDir(),
      this.layout.publicStatePath(channelId),
    );
    const lastCheckpointBlock = this.checkpointManager.getLastBlockNumber(channelId, 'block-walk');
    const extension = this.stateOptions?.extension;
    const completeMarker = stateReconstructionCompletePath(
      this.writer.getBaseDir(),
      this.layout,
      channelId,
    );
    // The accumulator is transient and current state is flushed only after the
    // block-walk checkpoint reaches the tip. The completion marker is created
    // by HybridExtractor only after every NDJSON stream has closed. Without it,
    // any existing output may be a partial walk or a partial state flush.
    if (!extension && !fs.existsSync(completeMarker)) {
      if (lastCheckpointBlock >= 0) {
        logger.warn(
          { channelId, lastCheckpointBlock },
          'State reconstruction did not complete — resetting checkpoint to re-walk',
        );
        this.checkpointManager.updateBlock(channelId, 'block-walk', -1);
      }
      await this.truncateWalkOutputs(channelId);
    }

    const walkerOptions: BlockWalkerOptions = {
      reconstructState: true,
      stateBackend: this.stateOptions?.stateBackend,
      memoryLimitMb: this.stateOptions?.memoryLimitMb,
      stateDataDir: this.stateOptions?.stateDataDir,
      prefetchBuffer: this.stateOptions?.prefetchBuffer,
      alsoHeldBytes: this.stateOptions?.alsoHeldBytes,
      ...(this.stateOptions?.blockSink && { blockSink: this.stateOptions.blockSink }),
      ...(extension?.expectedTip && { expectedTip: extension.expectedTip }),
    };

    const blockWalker = new BlockWalker(
      this.network,
      this.writer,
      this.layout,
      this.checkpointManager,
      this.tier,
      walkerOptions,
    );

    const statePath = extension
      ? stagedPath(this.layout.publicStatePath(channelId))
      : this.layout.publicStatePath(channelId);

    try {
      if (extension) {
        await this.writer.truncate(statePath);
        const seeded = fs.existsSync(stateFilePath)
          ? await blockWalker.seedState(new NdjsonReader().stream(stateFilePath) as AsyncIterable<PublicStateRecord>)
          : 0;
        logger.info({ channelId, seededKeys: seeded }, 'Seeded state from the extraction being extended');
      }

      // Walk all blocks — this accumulates state, verifies hash chain integrity,
      // and emits metadata/history records depending on the tier level
      const integrityReport = await blockWalker.walk(channel);

      if (!integrityReport.hashChainValid) {
        logger.error(
          { channelId, brokenAtBlock: integrityReport.brokenAtBlock },
          'Block hash chain integrity verification FAILED — extracted state may be untrustworthy',
        );
      } else if (integrityReport.blocksVerified > 0) {
        logger.info(
          { channelId, blocksVerified: integrityReport.blocksVerified },
          'Block hash chain integrity verified',
        );
      }

      // Flush the reconstructed current state (streaming — works for any size)
      const namespaces = new Set<string>();
      let totalKeys = 0;
      const FLUSH_BATCH_SIZE = 1000;
      let batch: PublicStateRecord[] = [];

      for await (const record of blockWalker.getReconstructedState(channelId)) {
        namespaces.add(record.chaincode);
        batch.push(record);
        totalKeys++;

        if (batch.length >= FLUSH_BATCH_SIZE) {
          await this.writer.writeBatch(statePath, batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        await this.writer.writeBatch(statePath, batch);
      }

      const accumulator = blockWalker.getStateAccumulator();
      logger.info(
        {
          channelId,
          totalKeys,
          chaincodeNamespaces: Array.from(namespaces),
          hashChainValid: integrityReport.hashChainValid,
          finalBackend: accumulator?.activeBackend(),
        },
        'State reconstruction complete',
      );

      return blockWalker;
    } finally {
      // Clean up LevelDB temp files if used
      await blockWalker.cleanup();
    }
  }

  /**
   * Truncate every file the block walk is about to re-derive from block 0.
   *
   * NDJSON streams append, so a reset checkpoint without this leaves the
   * abandoned attempt's records in place and the re-walk duplicates all of
   * them. Only files the block walk itself produces are truncated. Private
   * current state/history belong to a separate delivery pass that always
   * truncates and rewalks from block 0, while `identities.ndjson` spans all
   * channels and is not a per-channel block-walk output.
   *
   * @param channelId Channel whose block-walk outputs are being reset.
   */
  private async truncateWalkOutputs(channelId: string): Promise<void> {
    const paths = [this.layout.publicStatePath(channelId)];

    if (this.tier >= MigrationTier.StateWithAudit) {
      paths.push(this.layout.blockMetadataPath(channelId));
    }

    if (this.tier >= MigrationTier.FullHistory) {
      paths.push(this.layout.publicHistoryPath(channelId));
      for (const file of this.layout.listPrivateFiles(channelId, '-hashes.ndjson')) {
        paths.push(path.join(this.layout.channelDir(channelId), file));
      }
    }

    const discarded = paths.filter((p) => {
      const full = path.join(this.writer.getBaseDir(), p);
      return fs.existsSync(full) && fs.statSync(full).size > 0;
    });

    for (const p of paths) {
      await this.writer.truncate(p);
    }

    // A fresh extraction has nothing to discard; only an abandoned attempt's records are worth a warning.
    if (discarded.length > 0) {
      logger.warn({ channelId, files: discarded }, 'Truncated re-derived block-walk outputs');
    }
  }
}
