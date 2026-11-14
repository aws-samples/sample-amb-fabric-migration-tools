import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NetworkAdapter } from '../../connection/network-adapter';
import { ChannelInfo, MigrationTier } from '../../types';
import { ExtractionError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { NdjsonWriter } from '../../output/ndjson-writer';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { CheckpointManager } from '../checkpoint-manager';
import { BlockArchiveWriter } from '../block-archive';
import { BlockWalker } from './block-walker';

const logger = createLogger('block-archive-extractor');

export interface BlockArchiveExtractorOptions {
  prefetchBuffer?: number;
}

/**
 * `extract --blocks-only`: walk a channel, verify the hash chain, write the
 * block archive, and stop. It produces none of the extraction output, so there
 * is no `public-state.ndjson` for anything to mistake for a finished extraction.
 *
 * It runs the same {@link BlockWalker} the full extraction uses, so fetching,
 * prefetching, retries and hash-chain verification are not a second
 * implementation. The archive itself is the progress record: a rerun starts at
 * the first missing block, and the walker's checkpoint is a throwaway.
 */
export class BlockArchiveExtractor {
  constructor(
    private readonly network: NetworkAdapter,
    private readonly archive: BlockArchiveWriter,
    private readonly options: BlockArchiveExtractorOptions = {},
  ) {}

  async extract(channel: ChannelInfo): Promise<void> {
    const { channelId, ledgerHeight } = channel;
    const have = this.archive.contiguousBlocks(channelId);
    logger.info({ channelId, ledgerHeight, alreadyArchived: have }, 'Archiving blocks');

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'block-archive-'));
    try {
      const checkpoints = new CheckpointManager(scratch);
      checkpoints.updateBlock(channelId, 'block-walk', have - 1);

      const walker = new BlockWalker(
        this.network,
        new NdjsonWriter(scratch),
        new FileLayoutManager(scratch),
        checkpoints,
        MigrationTier.CurrentState,
        { blocksOnly: true, blockSink: this.archive, prefetchBuffer: this.options.prefetchBuffer },
      );
      const report = await walker.walk(channel);
      if (!report.hashChainValid) {
        throw new ExtractionError(
          `Channel ${channelId}: hash chain break at block ${report.brokenAtBlock}. The archive is not sealed.`,
        );
      }
      this.archive.finalize(channelId, ledgerHeight);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
