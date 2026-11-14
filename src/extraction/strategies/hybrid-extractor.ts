import * as fs from 'fs';
import * as path from 'path';
import { NetworkAdapter } from '../../connection/network-adapter';
import { DiscoveryGateway, PrivateDataBlockCallback } from '../../discovery/chaincode-discoverer';
import { RunCapacityEstimate, estimateRunCapacity } from '../../discovery/capacity-estimator';
import {
  ChannelMetadata,
  ExtractOptions,
  Manifest,
  ChannelInfo,
  CollectionConfig,
  IdentityRecord,
} from '../../types';
import { NdjsonWriter } from '../../output/ndjson-writer';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { CheckpointManager } from '../checkpoint-manager';
import { BlockArchiveWriter } from '../block-archive';
import { assertBudgetFitsHeap, readHeapBudget } from '../heap-budget';
import { StateReconstructionExtractor } from './state-reconstruction-extractor';
import {
  markStateReconstructionComplete,
  stateReconstructionCompletePath,
} from '../state-completion';
import { WalkTip } from './block-walker';
import {
  beginExtension,
  commitExtension,
  planExtension,
  recoverExtension,
  refuseGrowthWithoutExtend,
  stagedPath,
  STAGED_SUFFIX,
} from '../extension';
import {
  identityPartPath,
  mergeIdentityRegistries,
  readIdentities,
  writeIdentities,
  writeIdentityRegistry,
} from '../identity-parts';
import { PrivateDataDeliveryExtractor } from '../../extraction/private-data/private-data-delivery';
import { PurgeAssessor, PurgeRisk } from '../../extraction/private-data/purge-assessor';
import { collectionPolicyIncludes } from '../../extraction/private-data/collection-policy';
import {
  CoverageReason,
  PrivateCollectionCoverage,
  PurgeHorizon,
  classifyCoverageReason,
} from '../../extraction/private-data/coverage';
import { readNewestHashBlock } from '../../extraction/private-data/newest-hash-block';
import { ExtractionError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const logger = createLogger('hybrid-extractor');

/**
 * Function type for delivering blocks with private data.
 * Wraps the gateway's DeliverWithPrivateData capability.
 */
export type PrivateDataDeliveryFn = (
  channelId: string,
  startBlock: number,
  endBlock: number,
  onBlock: PrivateDataBlockCallback,
) => Promise<void>;

/**
 * Hybrid extraction orchestrator implementing the recommended default strategy:
 *
 * Tier 1: Current state snapshot (public + private)
 * Tier 2: Tier 1 + block walk for metadata (txId, timestamp, keys, creator)
 * Tier 3: Tier 2 + full write-set history + private data history + hashes for purged data
 *
 * **Public state** is always extracted via block reconstruction (replaying write
 * sets from committed blocks). This correctly attributes state to the originating
 * chaincode namespace and requires no custom chaincode deployment.
 *
 * **Private data** extraction uses the peer's DeliverWithPrivateData gRPC endpoint.
 * The peer delivers actual private data values for collections the connected
 * org is authorized to see. For unauthorized collections, only hashes
 * (from the block's hashed rwsets) are available.
 */
export class HybridExtractor {
  private writer: NdjsonWriter;
  private layout: FileLayoutManager;
  /** channelId → the signers this run's walk of the channel saw. */
  private channelIdentities = new Map<string, Map<string, IdentityRecord>>();
  /** channelId → blocks that produced no block-metadata records this run. */
  private blocksWithoutMetadata = new Map<string, number[]>();
  /** channelId → "chaincode:collection" entries that yielded plaintext values. */
  private collectionsWithValues = new Map<string, Set<string>>();
  /** channelId → purge risk per collection, from the pre-extraction assessment. */
  private purgeRisks = new Map<string, PurgeRisk[]>();
  /**
   * `--memory-limit`'s share for one channel.
   *
   * The flag names one budget and every channel extracted in parallel builds
   * its own state accumulator, so the whole limit per channel is the limit
   * times the worker count: `--memory-limit 512 --concurrency 8` promotes at
   * ~4 GB of accumulators against a default V8 heap ceiling well under that.
   * Narrowed in `run`, once the number of workers is known.
   */
  private channelMemoryLimitMb: number;
  /** Present only with `--save-blocks`. */
  private readonly archive?: BlockArchiveWriter;
  /** `--extend`: channel ID → first block to extract (the earlier height). */
  private extension = new Map<string, number>();
  /** channelId → last block the public walk verified this run. */
  private walkTips = new Map<string, WalkTip>();

  constructor(
    private readonly options: ExtractOptions,
    private readonly manifest: Manifest,
    private readonly gateway?: DiscoveryGateway,
    private readonly connectedMspId?: string,
    private readonly deliverPrivateData?: PrivateDataDeliveryFn,
  ) {
    this.layout = new FileLayoutManager(options.outputDir);
    this.writer = new NdjsonWriter(options.outputDir);
    this.channelMemoryLimitMb = options.memoryLimitMb;
    if (options.saveBlocksDir) {
      this.archive = new BlockArchiveWriter(options.saveBlocksDir, {
        networkId: manifest.networkId,
        memberId: manifest.memberId,
        nodeId: options.nodeId ?? manifest.nodeId,
        mspId: connectedMspId,
        region: manifest.region,
      });
    }
  }

  async run(channels: ChannelInfo[]): Promise<void> {
    if (this.options.extend) {
      recoverExtension(this.options.outputDir, this.layout);
      this.extension = planExtension(
        this.options.outputDir, this.layout, channels, this.options.tier, this.options.privateOnly === true,
      );
      channels = channels.filter((c) => this.extension.has(c.channelId));
      if (channels.length === 0) {
        logger.info('Every channel is already at the manifest height — nothing to extend');
        return;
      }
      beginExtension(this.options.outputDir, this.layout, this.extension);
      logger.info(
        { channels: Object.fromEntries([...this.extension].map(([c, from]) => [c, { fromBlock: from }])) },
        'Extending the extraction: only blocks above its height are read',
      );
    } else {
      refuseGrowthWithoutExtend(this.options.outputDir, this.layout, channels);
      this.prepareFreshRecovery(channels);
    }

    this.channelMemoryLimitMb = this.resolveChannelMemoryLimit(channels.length);
    this.checkHeapCeiling();
    this.prepareStateDataDir();
    this.logCapacityEstimate(channels);

    logger.info(
      {
        tier: this.options.tier,
        strategy: 'block-reconstruction',
        channels: channels.map((c) => c.channelId),
        outputDir: this.options.outputDir,
      },
      'Starting hybrid extraction',
    );

    // Assess purge risk for all channels. Results are kept so they can be
    // persisted per collection in each channel's metadata.json.
    const purgeAssessor = new PurgeAssessor();
    for (const channel of channels) {
      const risks = purgeAssessor.assess(channel);
      this.purgeRisks.set(channel.channelId, risks);
      const highRisks = risks.filter((r) => r.riskLevel === 'high');
      if (highRisks.length > 0) {
        logger.warn(
          { channelId: channel.channelId, highRiskCollections: highRisks.map((r) => r.collection) },
          'High purge risk detected — some private data may be irrecoverable',
        );
      }
    }

    try {
      // Process channels with configurable parallelism
      const concurrency = this.options.concurrency;
      if (concurrency <= 1) {
        for (const channel of channels) {
          await this.extractChannel(channel);
        }
      } else {
        logger.info(
          { concurrency, totalChannels: channels.length },
          'Extracting channels in parallel',
        );
        await this.extractChannelsParallel(channels, concurrency);
      }
    } finally {
      await this.writer.close();
    }

    // Metadata is written *after* the writers are closed, and must stay there:
    // `buildPrivateCoverage` reads the tail of each hashes file off disk, and
    // `write()` resolves once a record is in the stream's buffer rather than in
    // the file. `syncAll()` cannot reach those records either — fsync flushes
    // the descriptor, not the stream. Read before the close and the newest
    // captured hash comes back stale or unreadable, which makes the purge
    // window look like it explains a collection's missing values when it does
    // not: `purge-window` is accepted loss, so the failure direction is a stop
    // silently becoming a signature. A fresh full extraction commits each
    // channel as it finishes (`commitChannel`, after closing that channel's
    // streams), so only the extension and private-only paths remain here.
    if (this.options.extend) {
      this.commitExtension(channels);
    } else if (this.options.privateOnly) {
      for (const channel of channels) {
        this.writeChannelMetadata(channel);
      }
    } else if (!this.options.identitiesOut) {
      // A --processes child leaves the registry to the parent, which rebuilds
      // it once every child has committed.
      const identities = writeIdentityRegistry(this.options.outputDir, this.layout.identitiesPath);
      logger.info({ identities }, 'Wrote identity registry from the completed channels');
    }
    logger.info('Hybrid extraction complete');
  }

  /**
   * Clear what an unfinished attempt left of each selected channel that has no
   * completion marker, so it is rebuilt and recommitted. Completed channels are
   * left alone, and skipped by `extractChannel`.
   */
  private prepareFreshRecovery(channels: ChannelInfo[]): void {
    if (this.options.privateOnly) return;
    const unfinished = channels.filter((channel) => !this.isComplete(channel.channelId));
    if (unfinished.length === 0) return;
    this.refuseUnmarkedCompletion(unfinished);
    for (const { channelId } of unfinished) {
      for (const rel of [this.layout.channelMetadataPath(channelId), identityPartPath(this.layout, channelId)]) {
        const full = path.join(this.options.outputDir, rel);
        if (fs.existsSync(full)) fs.rmSync(full);
      }
    }
  }

  private isComplete(channelId: string): boolean {
    return fs.existsSync(stateReconstructionCompletePath(this.options.outputDir, this.layout, channelId));
  }

  /**
   * Refuse to discard a channel that looks completely extracted but has no
   * completion marker, rather than delete it and walk the ledger again.
   *
   * Metadata is written only after a walk to the tip and a durable close, so
   * metadata plus a tip checkpoint means the work was done. Without the marker
   * it came from a process that died between the two final writes, or from a
   * tool version with another completion record. Either way the rebuild would
   * delete it first, and the source ledger may no longer be there to re-read.
   */
  private refuseUnmarkedCompletion(channels: ChannelInfo[]): void {
    const unmarked = channels.filter((channel) => {
      const { channelId } = channel;
      const metadataPath = path.join(this.options.outputDir, this.layout.channelMetadataPath(channelId));
      if (!fs.existsSync(metadataPath)) return false;
      let metadata: ChannelMetadata;
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as ChannelMetadata;
      } catch {
        return false;
      }
      if (typeof metadata.ledgerHeight !== 'number' || metadata.ledgerHeight < 1) return false;
      const checkpoints = new CheckpointManager(path.join(this.options.outputDir, this.layout.checkpointDir(channelId)));
      return checkpoints.getLastBlockNumber(channelId, 'block-walk') === metadata.ledgerHeight - 1;
    });
    if (unmarked.length > 0) {
      throw new ExtractionError(
        `${this.options.outputDir} holds a completed-looking extraction of ${unmarked.map((c) => c.channelId).join(', ')} ` +
          '(metadata.json and a block-walk checkpoint at its height) with no completion marker: a run that died while ' +
          'committing, or output from another version of this tool. Nothing was changed. To rebuild it, move the ' +
          'directory aside and extract into an empty one.',
      );
    }
  }

  /**
   * Log what the run is estimated to need, while the estimate is still useful.
   *
   * `discover` printed the same arithmetic for a hypothetical run; this is the
   * one actually about to happen, so it knows the tier, the concurrency and
   * whether private values will be delivered — which is most of what moves the
   * figures. Reported, never enforced: they are heuristics over ledger height,
   * so refusing on them would refuse runs that would have finished. Their value
   * is that a bigger instance, a different `--state-backend` or another volume
   * are all still choices here, and none of them are twenty hours into a walk.
   */
  private logCapacityEstimate(channels: ChannelInfo[]): void {
    const estimate = estimateRunCapacity(
      channels,
      {
        tier: this.options.tier,
        privateDataDelivery: this.deliverPrivateData !== undefined,
      },
      this.options.concurrency,
    );

    logger.info(
      {
        workers: estimate.workers,
        peakAccumulatorMb: estimate.peakAccumulatorMb,
        peakPrivateStateMb: estimate.peakPrivateStateMb,
        peakSpillMb: estimate.peakSpillMb,
        totalOutputMb: estimate.totalOutputMb,
        totalBlockFetchMb: estimate.totalBlockFetchMb,
        perChannelMemoryLimitMb: this.channelMemoryLimitMb,
        perChannel: estimate.perChannel.map((e) => ({
          channelId: e.channelId,
          estimatedLiveKeys: e.estimatedLiveKeys,
          estimatedTransactions: e.estimatedTransactions,
          estimatedMemoryMb: e.estimatedMemoryMb,
          estimatedOutputMb: e.estimatedOutputMb,
        })),
      },
      'Estimated capacity for this run — heuristics from ledger height, not ' +
        'measurements. Peaks are what the run holds at once, across the channels ' +
        'extracted together; totals are what it writes over all of them',
    );

    this.warnOnEstimatedPromotion(estimate);
    this.warnOnUnboundedPrivateState(estimate);
  }

  /**
   * Say which channels are expected to outgrow their share of `--memory-limit`.
   *
   * The comparison is per channel against its own share, not the run's peak
   * against the whole flag, because that is the condition the accumulator
   * actually tests: a run whose peak fits can still promote on its one large
   * channel while the small ones sit well under.
   */
  private warnOnEstimatedPromotion(estimate: RunCapacityEstimate): void {
    if (this.options.stateBackend === 'leveldb') return;

    // Under `auto` the private pass runs during the walk and its map counts
    // against the same share (see `extractChannel`), so it can be what tips a
    // channel into LevelDB.
    const overlapping = this.options.stateBackend !== 'memory' && !this.options.privateOnly;
    const held = (e: RunCapacityEstimate['perChannel'][number]): number =>
      e.estimatedMemoryMb + (overlapping ? e.estimatedPrivateMemoryMb : 0);
    const over = estimate.perChannel.filter(
      (e) => held(e) > this.channelMemoryLimitMb,
    );
    if (over.length === 0) return;

    const context = {
      perChannelMemoryLimitMb: this.channelMemoryLimitMb,
      channels: over.map((e) => ({
        channelId: e.channelId,
        estimatedMemoryMb: e.estimatedMemoryMb,
        ...(overlapping && { estimatedPrivateMemoryMb: e.estimatedPrivateMemoryMb }),
        estimatedSpillMb: e.estimatedDiskMb,
      })),
    };

    if (this.options.stateBackend === 'memory') {
      logger.warn(
        context,
        '--state-backend memory never spills, so a channel estimated above the ' +
          'limit has nothing but the V8 heap between it and an out-of-memory — ' +
          'auto or leveldb would spill it to disk instead',
      );
      return;
    }

    logger.warn(
      context,
      'Estimated state exceeds a channel\'s share of --memory-limit — expect a ' +
        'LevelDB promotion mid-walk, and size --state-data-dir for the spill',
    );
  }

  /**
   * Name the private current state, because no flag bounds it.
   *
   * The delivery pass holds one record per private key for a whole channel in a
   * plain map, outside the accumulator: it never promotes to LevelDB and never
   * counts against `--memory-limit`. Measured against that flag anyway, since an
   * operator who set a budget has said what they consider large, and the point
   * of the warning is that this memory is not part of the budget they set.
   */
  private warnOnUnboundedPrivateState(estimate: RunCapacityEstimate): void {
    if (estimate.peakPrivateStateMb <= this.options.memoryLimitMb) return;

    logger.warn(
      {
        peakPrivateStateMb: estimate.peakPrivateStateMb,
        memoryLimitMb: this.options.memoryLimitMb,
      },
      'Estimated private current state exceeds --memory-limit, which does not ' +
        'bound it: private data is collected per channel in memory and written ' +
        'at the end, with no spill to disk. Extract fewer channels at once, or ' +
        'fewer collections per run, if the heap cannot hold it',
    );
  }

  /**
   * Split `--memory-limit` across the channels that will hold an accumulator
   * at the same time.
   *
   * The divisor is the worker count, not `--concurrency`: extracting two
   * channels with `--concurrency 8` runs two workers, and dividing by eight
   * would spill both to LevelDB at a quarter of the memory the host has for
   * them. A floor of 1 MB keeps a nonsensical divisor from producing a limit
   * that promotes on the first key.
   */
  private resolveChannelMemoryLimit(channelCount: number): number {
    const workers = Math.max(
      1,
      Math.min(this.options.concurrency, channelCount),
    );
    if (workers === 1) return this.options.memoryLimitMb;

    const share = Math.max(1, Math.floor(this.options.memoryLimitMb / workers));
    logger.info(
      {
        memoryLimitMb: this.options.memoryLimitMb,
        workers,
        perChannelMemoryLimitMb: share,
      },
      'Dividing --memory-limit across channels extracted in parallel — each ' +
        'channel accumulates state separately, so the flag is the budget for ' +
        'all of them together',
    );
    return share;
  }

  /**
   * Refuse a `--memory-limit` the V8 heap cannot hold, before the first block.
   *
   * `--max-old-space-size` can only be set as the process starts, so nothing here
   * can raise a ceiling that is too low — and what a low one produces is an
   * out-of-memory hours into a walk, when the accumulator is at its largest. The
   * budget checked is the flag rather than a channel's share of it, because the
   * shares add back up to the flag: the run's heap commitment is the same at any
   * `--concurrency`.
   *
   * `--state-backend leveldb` never accumulates in memory, so it has nothing to
   * check. `--state-backend memory` never promotes, so it has no budget to check
   * against — only a ceiling worth naming while the log can still be read.
   */
  private checkHeapCeiling(): void {
    if (this.options.stateBackend === 'leveldb') return;

    const budget = readHeapBudget(this.options.memoryLimitMb);

    if (this.options.stateBackend === 'memory') {
      logger.warn(
        { heapCeilingMb: budget.heapCeilingMb },
        '--state-backend memory never spills to LevelDB, so --memory-limit bounds ' +
          'nothing: the V8 heap ceiling is the only limit on reconstructed state, ' +
          'and reaching it ends the run with an out-of-memory instead of a promotion',
      );
      return;
    }

    assertBudgetFitsHeap(budget);
    logger.info(
      { memoryLimitMb: budget.memoryLimitMb, heapCeilingMb: budget.heapCeilingMb },
      'State accumulator budget fits the V8 heap ceiling',
    );
  }

  /**
   * Create the spill directory and prove it is writable before the walk starts.
   *
   * The accumulator opens LevelDB only when it promotes, which on a large
   * channel is hours in: a directory that does not exist, or that the extracting
   * user cannot write, would fail there and cost the whole walk. `os.tmpdir()`
   * is the root volume on AL2, which is the reason to point this elsewhere at
   * all, so a path that is unusable is a refusal rather than a fallback.
   */
  private prepareStateDataDir(): void {
    const dir = this.options.stateDataDir;
    if (!dir) return;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (err) {
      throw new ExtractionError(
        `--state-data-dir ${dir} cannot be used for LevelDB spill: ` +
          `${(err as Error).message}. It must exist or be creatable, and be ` +
          'writable by the user running the extraction.',
      );
    }

    logger.info(
      { stateDataDir: dir },
      'State accumulator will spill to LevelDB under --state-data-dir, one ' +
        'subdirectory per channel — size the volume for the whole reconstructed state',
    );
  }

  /**
   * Where one channel's accumulator spills, or `undefined` for the system temp
   * directory.
   *
   * Per channel rather than one shared directory so that eight parallel spills
   * can be attributed and sized separately; the name matches the channel's
   * output directory, and is sanitized the same way, so the two line up.
   */
  private channelStateDataDir(channelId: string): string | undefined {
    const root = this.options.stateDataDir;
    if (!root) return undefined;

    const dir = path.join(root, this.layout.channelDir(channelId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Extract multiple channels concurrently using a worker-pool pattern.
   * Each channel is fully independent (separate ledger, namespace, checkpoint),
   * so parallel extraction is safe.
   */
  private async extractChannelsParallel(
    channels: ChannelInfo[],
    concurrency: number,
  ): Promise<void> {
    const queue = [...channels];
    const errors: Array<{ channelId: string; error: Error }> = [];

    const runNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const channel = queue.shift()!;
        try {
          await this.extractChannel(channel);
        } catch (err) {
          logger.error(
            { channelId: channel.channelId, error: (err as Error).message },
            'Channel extraction failed',
          );
          errors.push({ channelId: channel.channelId, error: err as Error });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, channels.length) },
      () => runNext(),
    );
    await Promise.all(workers);

    if (errors.length > 0) {
      const failedChannels = errors.map((e) => e.channelId).join(', ');
      throw new ExtractionError(
        `Extraction failed for ${errors.length} channel(s): ${failedChannels}`,
        errors[0].error,
      );
    }
  }

  private async extractChannel(channel: ChannelInfo): Promise<void> {
    const channelId = channel.channelId;
    const checkpointDir = path.join(this.options.outputDir, this.layout.checkpointDir(channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    logger.info({ channelId, tier: this.options.tier }, 'Extracting channel');

    if (!this.gateway) {
      logger.warn(
        'Hybrid extractor requires a live gateway connection. ' +
          'In production, inject the Gateway via the constructor.',
      );
      return;
    }

    // Private-only skips the public block walk entirely. Private delivery
    // re-walks the blocks itself from the manifest's height and reads nothing
    // the public walk produces, so it stands alone.
    if (this.options.privateOnly) {
      await this.extractPrivateData(channel);
      return;
    }

    // A committed channel is not extracted again: the private pass would
    // truncate its committed files before re-deriving them. The walk is only
    // repeated for --save-blocks, where it walks nothing but checks that the
    // archive holds every block (and refuses when it was walked without one).
    const extending = this.extension.has(channelId);
    if (!extending && this.isComplete(channelId)) {
      if (this.archive) {
        await this.extractWithBlockReconstruction(channel, this.gateway.getNetwork(channelId), checkpointManager);
      }
      logger.info({ channelId }, 'Channel already extracted — skipping');
      return;
    }

    // Otherwise both passes run at once: each is its own stream to the peer,
    // and measured on one channel neither slowed the other, so the channel takes
    // about as long as the longer pass instead of the sum of both. They share
    // memory instead, so the private map's size is charged to the walk's state
    // accumulator, which promotes to LevelDB when the two together reach the
    // channel's share of --memory-limit. `--state-backend memory` never promotes,
    // so nothing would bound the two together: there the passes run one after
    // the other, as they always did.
    const delivery = this.privateDeliveryExtractor();
    const network = this.gateway.getNetwork(channelId);
    if (!delivery || this.options.stateBackend === 'memory') {
      this.channelIdentities.set(channelId, await this.extractWithBlockReconstruction(channel, network, checkpointManager));
      await this.extractPrivateData(channel, delivery);
      if (!extending) await this.commitChannel(channel);
      return;
    }

    const [walk, priv] = await Promise.allSettled([
      this.extractWithBlockReconstruction(channel, network, checkpointManager, delivery)
        .catch((err: Error) => {
          delivery.cancel(err);
          throw err;
        }),
      this.extractPrivateData(channel, delivery),
    ]);

    // Both are settled before either failure is reported, so a failed walk has
    // written its checkpoint and a stopped delivery has stopped writing before
    // the run unwinds. A failed walk stops the delivery at its next block. A
    // failed delivery lets the walk finish, because the walk resumes from its
    // checkpoint and the rerun keeps its work. The walk's error is reported
    // first, since the delivery's is then only its consequence.
    if (walk.status === 'rejected') throw walk.reason;
    if (priv.status === 'rejected') throw priv.reason;
    this.channelIdentities.set(channelId, walk.value);
    if (!extending) await this.commitChannel(channel);
  }

  /**
   * Commit one channel of a fresh extraction, while other channels may still
   * be running: its signers into its identity part, its files closed and
   * synced, its metadata, then the completion marker. Every step is durable
   * before the next, so a marker always means the channel's outputs are whole.
   */
  private async commitChannel(channel: ChannelInfo): Promise<void> {
    const { channelId } = channel;
    writeIdentities(
      path.join(this.options.outputDir, identityPartPath(this.layout, channelId)),
      mergeIdentityRegistries([this.channelIdentities.get(channelId) ?? new Map()]),
    );
    await this.writer.closeDir(this.layout.channelDir(channelId));
    this.writeChannelMetadata(channel);
    // The channel directory's own entry is in the output root.
    const rootFd = fs.openSync(this.options.outputDir, 'r');
    try {
      fs.fsyncSync(rootFd);
    } finally {
      fs.closeSync(rootFd);
    }
    markStateReconstructionComplete(this.options.outputDir, this.layout, channelId);
    logger.info({ channelId }, 'Channel extraction committed');
  }

  /** The private pass for one channel, or `undefined` when the gateway cannot deliver private data. */
  private privateDeliveryExtractor(): PrivateDataDeliveryExtractor | undefined {
    if (!this.deliverPrivateData) return undefined;
    return new PrivateDataDeliveryExtractor(this.deliverPrivateData, this.writer, this.layout, this.options.tier);
  }

  /**
   * Block-reconstruction strategy: walks all blocks and reconstructs state from
   * write sets. Correctly attributes state to each chaincode namespace.
   * Does not require any custom chaincode deployment.
   *
   * For Tier 2+, the same block walk emits metadata and history records.
   */
  private async extractWithBlockReconstruction(
    channel: ChannelInfo,
    network: NetworkAdapter,
    checkpointManager: CheckpointManager,
    concurrentDelivery?: PrivateDataDeliveryExtractor,
  ): Promise<Map<string, IdentityRecord>> {
    const extending = this.extension.has(channel.channelId);
    const reconstructor = new StateReconstructionExtractor(
      network,
      this.writer,
      this.layout,
      checkpointManager,
      this.options.tier,
      {
        ...(extending && { extension: { expectedTip: this.readMetadataOf(channel.channelId)?.walkTip } }),
        stateBackend: this.options.stateBackend as any,
        memoryLimitMb: this.channelMemoryLimitMb,
        stateDataDir: this.channelStateDataDir(channel.channelId),
        prefetchBuffer: this.options.prefetchBuffer,
        ...(concurrentDelivery && { alsoHeldBytes: () => concurrentDelivery.heldBytes() }),
        ...(this.archive && { blockSink: this.archive }),
      },
    );

    // Single block walk handles state reconstruction + metadata + history.
    // The returned BlockWalker holds the per-channel identity registry.
    const blockWalker = await reconstructor.extract(channel);
    this.archive?.finalize(channel.channelId, channel.ledgerHeight);
    this.blocksWithoutMetadata.set(
      channel.channelId,
      blockWalker.getIntegrityReport().blocksWithoutMetadata,
    );
    const tip = blockWalker.getWalkTip();
    if (tip) this.walkTips.set(channel.channelId, tip);
    return blockWalker.getIdentityRegistry();
  }

  /**
   * Extract private data values and history via DeliverWithPrivateData.
   *
   * The peer delivers actual private data values for collections the connected
   * org is authorized to see. For unauthorized collections, only hashes from
   * the block walk are available.
   *
   * Attempted for every channel, never gated on the manifest's collection
   * count: Fabric 2.x implicit collections appear in no chaincode definition,
   * so a channel that declares none can still hold private data the peer will
   * deliver. Skipping on a zero count is how that data went missing silently.
   *
   * @param deliveryExtractor The pass to run, when the caller needs to read its
   *   memory while it runs; otherwise one is made here.
   */
  private async extractPrivateData(
    channel: ChannelInfo,
    deliveryExtractor = this.privateDeliveryExtractor(),
  ): Promise<void> {
    const channelId = channel.channelId;

    if (deliveryExtractor) {
      logger.info(
        { channelId },
        'Extracting private data via DeliverWithPrivateData — values for accessible ' +
          'collections, hashes for inaccessible collections (from block walk)',
      );

      const summary = await deliveryExtractor.extract(channel, this.extension.get(channelId));
      this.collectionsWithValues.set(
        channelId, new Set(summary.collectionsWithData),
      );

      if (summary.collectionsWithData.length > 0) {
        logger.info(
          { channelId, collections: summary.collectionsWithData },
          'Private data values extracted for accessible collections',
        );
      }
      return;
    }

    // No private data extraction method available
    logger.warn(
      { channelId },
      'No private data extraction method available. Private data hashes are still ' +
        'extracted from the block walk. To extract private data values, ensure the ' +
        'gateway supports DeliverWithPrivateData.',
    );
  }

  /**
   * Stage an extension's identities: each extended channel's part with the new
   * blocks' signers folded in, and the registry rebuilt from every completed
   * channel's part, the staged ones in place of theirs. Both are renamed in at
   * the journaled commit.
   */
  private stageExtensionIdentities(channels: ChannelInfo[]): string[] {
    const staged = new Map<string, string>();
    const files: string[] = [];
    for (const { channelId } of channels) {
      const part = identityPartPath(this.layout, channelId);
      const full = path.join(this.options.outputDir, part);
      if (!this.isComplete(channelId) || !fs.existsSync(full)) {
        throw new ExtractionError(
          `--extend: channel ${channelId} has no completion marker or no identity part (${full}), so its signers ` +
            'cannot be carried forward. ' +
            'Extract into an empty directory.',
        );
      }
      const next = path.join(this.options.outputDir, stagedPath(part));
      writeIdentities(next, mergeIdentityRegistries([readIdentities(full), this.channelIdentities.get(channelId) ?? new Map()]));
      staged.set(channelId, next);
      files.push(part);
    }
    writeIdentityRegistry(this.options.outputDir, stagedPath(this.layout.identitiesPath), staged);
    files.push(this.layout.identitiesPath);
    return files;
  }

  /**
   * Replace an extension's state files, identities and metadata in one
   * journaled step, after every writer has closed.
   */
  private commitExtension(channels: ChannelInfo[]): void {
    // A private-only extraction records no signers.
    const stateFiles = this.options.privateOnly ? [] : this.stageExtensionIdentities(channels);
    const metadata: Record<string, ChannelMetadata> = {};
    for (const channel of channels) {
      const { channelId } = channel;
      if (!this.options.privateOnly) stateFiles.push(this.layout.publicStatePath(channelId));
      const dir = this.layout.channelDir(channelId);
      for (const f of this.layout.listPrivateFiles(channelId, '-state.ndjson')) stateFiles.push(path.join(dir, f));
      for (const f of this.layout.listPrivateFiles(channelId, '-state.ndjson' + STAGED_SUFFIX)) {
        stateFiles.push(path.join(dir, f.slice(0, -STAGED_SUFFIX.length)));
      }
      metadata[channelId] = this.buildChannelMetadata(channel);
    }
    commitExtension(this.options.outputDir, stateFiles, metadata);
  }

  private readMetadataOf(channelId: string): Partial<ChannelMetadata> | undefined {
    return this.readExistingMetadata(path.join(this.options.outputDir, this.layout.channelMetadataPath(channelId)));
  }

  private writeChannelMetadata(channel: ChannelInfo): void {
    const metadataPath = path.join(
      this.options.outputDir,
      this.layout.channelMetadataPath(channel.channelId),
    );
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const tmp = metadataPath + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(this.buildChannelMetadata(channel), null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, metadataPath);
    const dirFd = fs.openSync(path.dirname(metadataPath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  private buildChannelMetadata(channel: ChannelInfo): ChannelMetadata {
    const channelId = channel.channelId;
    const metadataPath = path.join(
      this.options.outputDir,
      this.layout.channelMetadataPath(channelId),
    );

    const previous = this.readExistingMetadata(metadataPath);
    const gaps = new Set(previous?.blocksWithoutMetadata ?? []);
    for (const blockNumber of this.blocksWithoutMetadata.get(channelId) ?? []) {
      gaps.add(blockNumber);
    }

    const metadata: ChannelMetadata = {
      channelId,
      extractedAt: new Date().toISOString(),
      nodeId: this.options.nodeId ?? this.manifest.nodeId ?? previous?.nodeId,
      tier: this.options.tier,
      strategy: this.options.strategy,
      ledgerHeight: channel.ledgerHeight,
      extractedByMspId: this.connectedMspId ?? previous?.extractedByMspId,
      chaincodes: channel.chaincodes.map((cc) => ({
        name: cc.name,
        version: cc.version,
        collections: cc.collections.length,
      })),
      blocksWithoutMetadata: [...gaps].sort((a, b) => a - b),
      privateDataCoverage: this.buildPrivateCoverage(channel),
      ...(this.options.privateOnly ? { scope: 'private-only' as const } : {}),
      ...((this.walkTips.get(channelId) ?? previous?.walkTip) && {
        walkTip: this.walkTips.get(channelId) ?? previous?.walkTip,
      }),
      ...(this.extension.has(channelId) && {
        extensions: [
          ...(previous?.extensions ?? []),
          { fromBlock: this.extension.get(channelId)!, toLedgerHeight: channel.ledgerHeight, extractedAt: new Date().toISOString() },
        ],
      }),
      outputFiles: this.countOutputRecords(channelId, previous?.outputFiles),
    };
    return metadata;
  }

  /**
   * Read the metadata.json written by a previous run into this directory.
   *
   * Extraction is resumable, so a run may only walk the blocks a prior run did
   * not reach. Fields that accumulate across runs are merged with this.
   */
  private readExistingMetadata(
    metadataPath: string,
  ): Partial<ChannelMetadata> | undefined {
    if (!fs.existsSync(metadataPath)) return undefined;
    try {
      return JSON.parse(
        fs.readFileSync(metadataPath, 'utf-8'),
      ) as Partial<ChannelMetadata>;
    } catch (err) {
      logger.warn(
        { path: metadataPath, error: (err as Error).message },
        'Existing metadata.json is unreadable — rewriting it from this run alone',
      );
      return undefined;
    }
  }

  /**
   * Record what was actually captured for each of the channel's private
   * collections.
   *
   * Synthesized implicit collections that captured nothing are left out. Every
   * 2.x org has one on every chaincode whether or not anything was ever written
   * to it, so reporting the untouched ones would bury the collections a
   * coordinator has to make a call on. One that captured values or hashes is real
   * and is reported like any other.
   */
  private buildPrivateCoverage(
    channel: ChannelInfo,
  ): PrivateCollectionCoverage[] {
    const delivered =
      this.collectionsWithValues.get(channel.channelId) ?? new Set<string>();
    const risks = this.purgeRisks.get(channel.channelId) ?? [];
    const coverage: PrivateCollectionCoverage[] = [];

    for (const cc of channel.chaincodes) {
      for (const coll of cc.collections) {
        const captured = this.classifyCoverage(
          channel, cc.name, coll.name, delivered,
        );
        if (coll.implicit && captured === 'absent') continue;

        const risk = risks.find(
          (r) => r.chaincode === cc.name && r.collection === coll.name,
        );
        const authorized = this.isAuthorized(coll);
        coverage.push({
          chaincode: cc.name,
          collection: coll.name,
          coverage: captured,
          ...(authorized === undefined ? {} : { authorized }),
          ...(captured === 'values'
            ? {}
            : { reason: this.coverageReason(channel, cc.name, coll, captured, authorized) }),
          blockToLive: coll.blockToLive,
          purgeRisk: risk?.riskLevel ?? 'none',
          estimatedPurgedBlocks: risk?.estimatedPurgedBlocks ?? 0,
        });
      }
    }

    return coverage;
  }

  /**
   * Why a collection has no values.
   *
   * A private-only extraction wrote no hashes, so for a collection it was
   * entitled to, `absent` is not evidence of `never-written`: the values may
   * exist and be missing. It says `indeterminate` instead — which `merge`
   * resolves from the hashes a full member contributed, and which stops a
   * sign-off made from this directory alone. Non-membership is still
   * definitive, being read from the policy rather than from the ledger.
   */
  private coverageReason(
    channel: ChannelInfo,
    chaincode: string,
    coll: CollectionConfig,
    captured: 'hashes-only' | 'absent',
    authorized: boolean | undefined,
  ): CoverageReason {
    if (this.options.privateOnly && authorized !== false) return 'indeterminate';
    return classifyCoverageReason(
      captured, authorized, this.purgeHorizon(channel, chaincode, coll, captured),
    );
  }

  /**
   * What the purge horizon has to explain for one collection.
   *
   * The newest captured hash is only read for a `hashes-only` collection, which
   * is the one outcome the purge window is ever offered as the cause of.
   */
  private purgeHorizon(
    channel: ChannelInfo,
    chaincode: string,
    coll: CollectionConfig,
    captured: PrivateCollectionCoverage['coverage'],
  ): PurgeHorizon {
    const horizon: PurgeHorizon = {
      blockToLive: coll.blockToLive,
      ledgerHeight: channel.ledgerHeight,
    };
    if (captured !== 'hashes-only') return horizon;

    const newestHashBlock = readNewestHashBlock(
      path.join(
        this.options.outputDir,
        this.layout.privateHashesPath(channel.channelId, chaincode, coll.name),
      ),
    );
    return newestHashBlock === undefined
      ? horizon
      : { ...horizon, newestHashBlock };
  }

  /**
   * Whether the extracting identity is a member of this collection.
   *
   * @returns `undefined` when the connected MSP is unknown, so that an
   *   undetermined membership is never recorded as a denial.
   */
  private isAuthorized(coll: CollectionConfig): boolean | undefined {
    if (!this.connectedMspId) return undefined;
    return collectionPolicyIncludes(coll.policy, this.connectedMspId);
  }

  /**
   * Classify what was captured for one collection.
   *
   * The delivery summary only names collections written in the blocks this run
   * walked, so a resumed extraction sees a subset — on-disk evidence fills the
   * gap. Both files name the chaincode as well as the collection, so a channel
   * whose chaincodes share a collection name is attributed exactly rather than
   * having to fall back to the delivery signal alone.
   */
  private classifyCoverage(
    channel: ChannelInfo,
    chaincode: string,
    collection: string,
    delivered: Set<string>,
  ): PrivateCollectionCoverage['coverage'] {
    if (delivered.has(`${chaincode}:${collection}`)) return 'values';

    const channelId = channel.channelId;

    if (
      this.hasRecords(
        this.layout.privateStatePath(channelId, chaincode, collection),
      )
    ) {
      return 'values';
    }
    if (
      this.hasRecords(
        this.layout.privateHashesPath(channelId, chaincode, collection),
      )
    ) {
      return 'hashes-only';
    }
    return 'absent';
  }

  /**
   * True if an output file holds at least one record, whether written by this
   * run or a previous one. The writer only counts its own writes, so the file
   * itself is checked as well.
   */
  private hasRecords(relativePath: string): boolean {
    if (this.writer.getRecordCount(relativePath) > 0) return true;
    const fullPath = path.join(this.options.outputDir, relativePath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
  }

  /**
   * Sum this run's record counts with any recorded by a previous run.
   *
   * NDJSON output is opened in append mode, so a resumed run adds to the
   * existing files rather than replacing them.
   */
  private countOutputRecords(
    channelId: string,
    previous?: ChannelMetadata['outputFiles'],
  ): ChannelMetadata['outputFiles'] {
    const written = (relativePath: string): number =>
      this.writer.getRecordCount(relativePath);
    // An extension rewrites the state file whole, so its count replaces the old one.
    const publicState = !this.options.privateOnly
      ? written(stagedPath(this.layout.publicStatePath(channelId))) +
        (this.extension.has(channelId)
          ? 0
          : (previous?.publicState ?? 0) + written(this.layout.publicStatePath(channelId)))
      : previous?.publicState ?? 0;
    return {
      publicState,
      publicHistory: (previous?.publicHistory ?? 0) +
        written(this.layout.publicHistoryPath(channelId)),
      blockMetadata: (previous?.blockMetadata ?? 0) +
        written(this.layout.blockMetadataPath(channelId)),
    };
  }
}
