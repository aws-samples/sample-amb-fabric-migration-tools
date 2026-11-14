import * as fs from 'fs';
import * as path from 'path';
import { ReplayConfig, Manifest, ExtractionRecord, ReplayRecord } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { NdjsonReader } from './ndjson-reader';
import { assertPostgresqlTls, PostgresqlAdapter } from './adapters/postgresql-adapter';
import {
  ChaincodeAdapter,
  ChaincodeReplayFailure,
  ChaincodeReplayStats,
  DEFAULT_DELETE_FUNCTION,
  privateWriteContract,
} from './adapters/chaincode-adapter';
import { assertDestinationFingerprint } from './destination-fingerprint';
import {
  formatEndorsementRefusal,
  probePrivateEndorsements,
} from './endorsement-probe';
import { DynamoDBAdapter } from './adapters/dynamodb-adapter';
import { ChaincodeDiscoverer } from '../discovery/chaincode-discoverer';
import { CollectionIdentityPool } from './collection-identities';
import { withOrgRouting } from './org-routing';
import {
  PrivateWriteTarget,
  PurgingCollection,
  formatPreflightRefusal,
  listPrivateWriteTargets,
  preflightCollections,
} from './collection-preflight';
import { ChannelRoute, resolveChannelRouting } from './channel-routing';
import {
  DestinationDefinitions,
  DeploymentTarget,
  formatDeploymentRefusal,
  listDeployments,
  migrationContractProbe,
  preflightDeployments,
  findOccupiedNamespaces,
  formatOccupiedRefusal,
  keyPageProbe,
  readDestinationDefinitions,
} from './chaincode-preflight';
import {
  assertCollectionRouting,
  collectionLabel,
  destinationCollection,
} from './collection-routing';
import {
  DEFAULT_MIGRATION_CONTRACT,
  countFunctions,
  mappedFunction,
  parseQualifiedFunction,
} from './function-mapping';
import {
  ReplayCheckpointManager,
  checkpointFileName,
  scopedCheckpointFiles,
} from './replay-checkpoint-manager';
import { resolveHistoryImport, ResilientHistoryContext } from './history-import/config';
import { computePlanDigest } from './history-import/plan-digest';
import { probeHistoryImportProtocol } from './history-import/preflight';
import { ResilientHistoryReplayer } from './history-import/replayer';
import { ReplayError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { RecordOrderingChecker } from '../utils/record-ordering';
import { ChannelDelta, SinceSpec, channelDelta, inDelta, resolveSince } from './delta';
import * as crypto from 'crypto';

const logger = createLogger('replay-orchestrator');

const DEFAULT_BATCH_SIZE = 500;

/** NDJSON report listing every record that failed to replay. */
const FAILURE_REPORT_FILE = 'replay-failures.ndjson';

/** Record types where blockNumber/txIndex ordering is meaningful. */
const ORDERED_TYPES = new Set([
  'public_history',
  'block_metadata',
  'private_hash',
  'private_history',
]);

/** A record that could not be written to the destination. */
export interface ReplayFailure extends ChaincodeReplayFailure {
  /** Source channel the failing record came from. */
  channel: string;
}

export interface ReplaySummary {
  adapter: ReplayConfig['adapter'];
  totalReplayed: number;
  totalFailed: number;
  failures: ReplayFailure[];
  /** Path to the full failure report. Written only when failures occurred. */
  failureReportPath?: string;
  /** Source channels skipped because channelMapping had no entry for them. */
  skippedChannels: string[];
  /**
   * Checkpoint key of the history file whose replay stopped part-way.
   *
   * Set only for append-only (Tier 3 chaincode) replay. Its presence means the
   * destination cannot be repaired by re-running: it must be reset first.
   */
  historyAborted?: string;
}

/** One NDJSON file to stream into a destination adapter. */
interface FileReplayJob {
  replayBatch: (batch: ReplayRecord[]) => Promise<void>;
  /** `replay --since`: records that belong to the replay. Others are read past, and count toward the resume offset. */
  filter?: (record: ExtractionRecord) => boolean;
  checkpoint: ReplayCheckpointManager;
  filePath: string;
  fileKey: string;
  allFiles: string[];
  offset: number;
  /** Cumulative adapter failure count, polled after every batch. */
  failureCount?: () => number;
  /**
   * Stop reading this file after its first failed batch. Required for every
   * history mode so a later version of the same key cannot land beyond a gap.
   */
  stopOnFailure?: boolean;
  /**
   * The legacy history mode cannot safely retry what may already have landed.
   * In addition to stopping, it marks the checkpoint dirty and requires reset.
   */
  appendOnly?: boolean;
}

/** One source channel to replay through the chaincode adapter. */
interface ChannelReplayJob {
  adapter: ChaincodeAdapter;
  checkpoint: ReplayCheckpointManager;
  allKeys: string[];
  ccConfig: NonNullable<ReplayConfig['chaincode']>;
  channelId: string;
  destChannel: string;
}

/**
 * Validate `chaincode.channelConcurrency`. Below 1 would start no channel at
 * all and report success, the same failure `concurrency: 0` used to have.
 */
function resolveChannelConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new ReplayError(
      `chaincode.channelConcurrency must be an integer >= 1, got: ${value}. ` +
      'Use 1 to replay channels one after another.',
    );
  }
  return value;
}

/**
 * Replay channels with at most `limit` running at once.
 *
 * Every channel is allowed to finish before an error is rethrown: a channel
 * still writing when another throws would otherwise be abandoned mid-batch,
 * with its checkpoint describing less than what reached its destination.
 */
async function runChannels(
  routes: ChannelRoute[],
  limit: number,
  replay: (route: ChannelRoute) => Promise<void>,
): Promise<void> {
  const pending = routes[Symbol.iterator]();
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(limit, routes.length) }, async () => {
    for (const route of pending) {
      try {
        await replay(route);
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
}

export class ReplayOrchestrator {
  private reader = new NdjsonReader();
  private layout: FileLayoutManager;
  private batchSize: number;
  /**
   * Failure state per checkpoint. A sequential run has one checkpoint and so
   * one state; a parallel chaincode run has one per channel, so a failure on
   * one channel freezes and aborts that channel alone.
   *
   * `frozen` is set once any record fails: no further checkpoint update is
   * written, so a resume restarts from the last fully successful batch.
   * `aborted` is the first append-only file that stopped on a failure; once
   * set, the scope's remaining append-only files are skipped, since every
   * further write lands on a destination that has to be reset anyway.
   */
  private failureState = new Map<
    ReplayCheckpointManager, { frozen: boolean; aborted: string | null }
  >();

  private stateOf(
    checkpoint: ReplayCheckpointManager,
  ): { frozen: boolean; aborted: string | null } {
    let state = this.failureState.get(checkpoint);
    if (!state) {
      state = { frozen: false, aborted: null };
      this.failureState.set(checkpoint, state);
    }
    return state;
  }

  /** First append-only file any scope aborted on, for the run summary. */
  private get historyAborted(): string | null {
    for (const state of this.failureState.values()) {
      if (state.aborted !== null) return state.aborted;
    }
    return null;
  }

  /** Source network ID from the manifest, part of every resilient operation ID. */
  private sourceNetworkId = '';
  /**
   * True when this run replays history through the resilient idempotent
   * protocol. In that mode history replay is safely resumable, so the
   * append-only abort/dirty-marker behaviour is not applied.
   */
  private idempotentHistory = false;
  /** `replay --since`: the first block to replay, per channel. */
  private since?: SinceSpec;
  private deltas = new Map<string, ChannelDelta>();

  private readonly config: ReplayConfig;

  constructor(config: ReplayConfig) {
    // Expanded once here so the adapter, the pre-flights and the plan digest
    // all route through the same effective collectionMapping.
    this.config = withOrgRouting(config);
    this.layout = new FileLayoutManager(config.inputDir);
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async run(): Promise<ReplaySummary> {
    const manifestPath = this.layout.manifestPath;
    if (!fs.existsSync(manifestPath)) {
      throw new ReplayError(`Manifest not found at ${manifestPath}`);
    }

    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest: Manifest = JSON.parse(raw);
    this.sourceNetworkId = manifest.networkId;
    const channels = this.config.channels
      ?? manifest.channels.map((c) => c.channelId);
    this.refusePrivateOnly(channels);
    if (this.config.since) {
      this.since = resolveSince(this.config.since, this.config.inputDir, this.layout, channels);
      logger.info({ since: Object.fromEntries(this.since) }, 'Replaying only the records at or above each channel\'s height');
    }

    logger.info(
      {
        adapter: this.config.adapter,
        channels,
        inputDir: this.config.inputDir,
      },
      'Starting replay',
    );

    let summary: ReplaySummary;
    switch (this.config.adapter) {
      case 'postgresql':
        summary = await this.replayToPostgresql(channels);
        break;
      case 'chaincode':
        summary = await this.replayToChaincode(channels);
        break;
      case 'dynamodb':
        summary = await this.replayToDynamodb(channels);
        break;
      default:
        throw new ReplayError(`Unsupported adapter: ${this.config.adapter}`);
    }

    if (summary.totalFailed > 0) {
      summary.failureReportPath = this.writeFailureReport(summary.failures);
      logger.error(
        {
          adapter: summary.adapter,
          totalReplayed: summary.totalReplayed,
          totalFailed: summary.totalFailed,
          failureReportPath: summary.failureReportPath,
        },
        'Replay finished with failures — the destination is incomplete',
      );
    }

    return summary;
  }

  /**
   * Refuse a `--private-only` member extraction as replay input.
   *
   * It holds one member's private data and no public state, so replaying it
   * would write a destination missing every public key, and exit 0 — nothing
   * failed, there was just nothing to send. It is merge input, not replay input.
   */
  private refusePrivateOnly(channels: string[]): void {
    const privateOnly = channels.filter((channelId) => {
      const metadataPath = path.join(
        this.config.inputDir, this.layout.channelMetadataPath(channelId),
      );
      if (!fs.existsSync(metadataPath)) return false;
      try {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).scope ===
          'private-only';
      } catch {
        return false;
      }
    });
    if (privateOnly.length === 0) return;

    throw new ReplayError(
      `${privateOnly.join(', ')} ${privateOnly.length === 1 ? 'was' : 'were'} ` +
        `extracted with --private-only, so ${this.config.inputDir} holds no ` +
        'public data to replay. Merge it with a full extraction of the same ' +
        'channels and replay the merged directory.',
    );
  }

  /** Write every failure to an NDJSON report and return its path. */
  private writeFailureReport(failures: ReplayFailure[]): string {
    const reportPath = path.join(this.config.inputDir, FAILURE_REPORT_FILE);
    const body = failures.map((f) => JSON.stringify(f)).join('\n');
    fs.writeFileSync(reportPath, body + '\n', 'utf-8');
    return reportPath;
  }

  /**
   * Advance the file checkpoint unless a failure has already been seen.
   *
   * The checkpoint holds a single cursor and skips every file listed before
   * `lastFile`, so advancing past a file that had failures would make a
   * resume skip those records entirely.
   */
  private advanceCheckpoint(
    checkpoint: ReplayCheckpointManager,
    fileKey: string,
    recordsCompleted: number,
    allFiles: string[],
  ): void {
    if (this.stateOf(checkpoint).frozen) return;
    checkpoint.update(fileKey, recordsCompleted, allFiles);
  }

  /**
   * Refuse to start when a previous run left append-only replay part-way.
   *
   * History replay turns every source write into a fresh destination write, so
   * the destination's `GetHistoryForKey` grows by one entry per record. There
   * is no key to overwrite and no transaction to roll back: once a batch has
   * partially landed, the entries already written cannot be distinguished from
   * the ones still owed, and re-submitting the batch appends duplicates in the
   * wrong order. The only correct recovery is to reset the destination.
   *
   * @throws ReplayError naming the file and the exact recovery steps.
   */
  private assertResumable(checkpoint: ReplayCheckpointManager): void {
    const inFlight = checkpoint.getInFlight();
    if (checkpoint.getDirtyFile() === null && inFlight !== null) {
      throw new ReplayError(
        `A previous history replay stopped while a batch of ${inFlight} was being written ` +
        '(the process was killed or crashed), so whether that batch reached the destination is unknown. ' +
        'Resuming would write it again and append duplicate history entries, so this run is refusing to start.\n' +
        "To recover: reset the destination channel's state and history for the affected chaincode, delete " +
        `${checkpoint.getCheckpointPath()}, then replay from the beginning. A history replay with ` +
        'chaincode.historyImport is safe to resume after an interruption.',
      );
    }
    const dirtyFile = checkpoint.getDirtyFile();
    if (dirtyFile === null) return;

    const checkpointPath = checkpoint.getCheckpointPath();
    throw new ReplayError(
      `A previous history replay stopped part-way through ${dirtyFile} ` +
      'because a record failed, so the destination now holds an incomplete ' +
      'history for that file. Resuming would append duplicate entries out of ' +
      'order, so this run is refusing to start.\n' +
      'To recover: fix the cause listed in ' +
      `${FAILURE_REPORT_FILE}, reset the destination channel's state and ` +
      `history for the affected chaincode, delete ${checkpointPath}, then ` +
      'replay from the beginning.',
    );
  }

  private freezeCheckpoint(
    checkpoint: ReplayCheckpointManager,
    fileKey: string,
  ): void {
    const state = this.stateOf(checkpoint);
    if (state.frozen) return;
    state.frozen = true;
    logger.warn(
      { label: fileKey },
      'Replay failure detected — checkpoint frozen so a resume re-processes ' +
      'from the last fully successful batch',
    );
  }

  private clearCheckpointIfClean(checkpoint: ReplayCheckpointManager): void {
    if (this.stateOf(checkpoint).frozen) {
      logger.warn(
        'Replay checkpoint retained because records failed — fix the cause ' +
        'and re-run the same command to retry them',
      );
      return;
    }
    checkpoint.clear();
  }

  /**
   * The checkpoint name for this run's adapter. A `--since` replay keeps its own, named by its heights, so it can never
   * resume a full replay's checkpoint (or the other way round) at an offset counted over different records.
   */
  private checkpointLabel(adapter: string): string {
    if (!this.since) return adapter;
    const h = crypto.createHash('sha256').update(JSON.stringify([...this.since].sort())).digest('hex').slice(0, 12);
    return `since-${h}-${adapter}`;
  }

  private async deltaFor(channelId: string): Promise<ChannelDelta | undefined> {
    if (!this.since) return undefined;
    let d = this.deltas.get(channelId);
    if (!d) {
      d = await channelDelta(this.config.inputDir, this.layout, channelId, this.since.get(channelId)!);
      this.deltas.set(channelId, d);
      logger.info({ channel: channelId, fromBlock: d.from, keysChanged: d.touched.size, keysDeleted: d.deletes.length }, 'Records to replay since the earlier height');
    }
    return d;
  }

  /** Send a channel's `--since` state deletes, once; recorded in the checkpoint like a file. */
  private async replayStateDeletes(
    channelId: string, checkpoint: ReplayCheckpointManager, allKeys: string[],
    replayBatch: (batch: ReplayRecord[]) => Promise<void>,
  ): Promise<number> {
    const key = `${channelId}/state-deletes`;
    if (checkpoint.shouldSkipFile(key, allKeys) || checkpoint.getResumeOffset(key) > 0) return 0;
    const deletes = (await this.deltaFor(channelId))?.deletes ?? [];
    for (let i = 0; i < deletes.length; i += this.batchSize) await replayBatch(deletes.slice(i, i + this.batchSize));
    this.advanceCheckpoint(checkpoint, key, Math.max(1, deletes.length), allKeys);
    if (deletes.length) logger.info({ channel: channelId, deleted: deletes.length }, 'Keys deleted since the earlier height removed');
    return deletes.length;
  }

  private buildChannelFileList(
    channels: string[],
  ): Array<{ path: string; key: string }> {
    const files: Array<{ path: string; key: string }> = [];
    const inputDir = this.config.inputDir;

    files.push({
      path: path.join(inputDir, this.layout.identitiesPath),
      key: 'identities',
    });

    for (const channelId of channels) {
      files.push(
        {
          path: path.join(
            inputDir,
            this.layout.publicStatePath(channelId),
          ),
          key: `${channelId}/public-state`,
        },
        {
          path: path.join(
            inputDir,
            this.layout.publicHistoryPath(channelId),
          ),
          key: `${channelId}/public-history`,
        },
        {
          path: path.join(
            inputDir,
            this.layout.blockMetadataPath(channelId),
          ),
          key: `${channelId}/block-metadata`,
        },
      );

      const channelDir = path.join(
        inputDir, this.layout.channelDir(channelId),
      );
      for (const pf of this.layout.listPrivateFiles(
        channelId, '.ndjson',
      )) {
        files.push({
          path: path.join(channelDir, pf),
          key: `${channelId}/${pf}`,
        });
      }
      if (this.since) files.push({ path: '', key: `${channelId}/state-deletes` });
    }

    return files;
  }

  private async replayToPostgresql(channels: string[]): Promise<ReplaySummary> {
    if (!this.config.postgresql?.connectionString) {
      throw new ReplayError(
        'PostgreSQL connection string required',
      );
    }

    const checkpoint = new ReplayCheckpointManager(
      this.config.inputDir, this.checkpointLabel('postgresql'),
    );
    const connStr = this.config.postgresql.connectionString;
    assertPostgresqlTls(connStr, this.config.postgresql.allowInsecure);
    const adapter = new PostgresqlAdapter(connStr);
    await adapter.initialize();

    let totalReplayed = 0;
    try {
      totalReplayed = await this.replayAllFiles(
        channels, checkpoint, (batch) => adapter.replayBatch(batch),
      );
    } finally {
      await adapter.close();
    }

    this.clearCheckpointIfClean(checkpoint);

    return {
      adapter: 'postgresql',
      totalReplayed,
      totalFailed: 0,
      failures: [],
      skippedChannels: [],
    };
  }

  private async replayToDynamodb(channels: string[]): Promise<ReplaySummary> {
    if (!this.config.dynamodb?.stateTable) {
      throw new ReplayError('DynamoDB stateTable is required');
    }

    const checkpoint = new ReplayCheckpointManager(
      this.config.inputDir, this.checkpointLabel('dynamodb'),
    );
    const adapter = new DynamoDBAdapter(this.config.dynamodb);
    await adapter.initialize();

    let totalReplayed = 0;
    try {
      totalReplayed = await this.replayAllFiles(
        channels, checkpoint, (batch) => adapter.replayBatch(batch),
      );
    } finally {
      await adapter.close();
    }

    this.clearCheckpointIfClean(checkpoint);

    return {
      adapter: 'dynamodb',
      totalReplayed,
      totalFailed: 0,
      failures: [],
      skippedChannels: [],
    };
  }

  /**
   * Stream every extraction file for the given channels into a database
   * adapter. These adapters have no partial-failure mode: a write error
   * throws and aborts the whole replay.
   */
  private async replayAllFiles(
    channels: string[],
    checkpoint: ReplayCheckpointManager,
    replayBatch: (batch: ReplayRecord[]) => Promise<void>,
  ): Promise<number> {
    const allFiles = this.buildChannelFileList(channels);
    const allKeys = allFiles.map((f) => f.key);
    let totalReplayed = 0;

    for (const file of allFiles) {
      const channelId = file.key === 'identities' ? undefined : file.key.slice(0, file.key.indexOf('/'));
      if (file.key.endsWith('/state-deletes')) {
        totalReplayed += await this.replayStateDeletes(channelId!, checkpoint, allKeys, replayBatch);
        continue;
      }
      if (checkpoint.shouldSkipFile(file.key, allKeys)) {
        logger.info({ label: file.key }, 'Skipping already-completed file');
        continue;
      }
      const delta = channelId ? await this.deltaFor(channelId) : undefined;
      totalReplayed += await this.replayFile({
        replayBatch,
        checkpoint,
        filePath: file.path,
        fileKey: file.key,
        allFiles: allKeys,
        offset: checkpoint.getResumeOffset(file.key),
        ...(delta && { filter: (rec: ExtractionRecord) => inDelta(rec, delta) }),
      });
    }

    return totalReplayed;
  }

  /**
   * Replay extracted state to a target Fabric network via the Fabric Gateway SDK.
   *
   * Connects using a standard Fabric connection profile, which works with
   * self-managed open-source Fabric, a managed Fabric service, Amazon Managed Blockchain,
   * or any Fabric 2.x deployment.
   */
  private async replayToChaincode(channels: string[]): Promise<ReplaySummary> {
    const ccConfig = this.config.chaincode;
    if (!ccConfig) {
      throw new ReplayError('Chaincode replay config required');
    }
    this.validateChaincodeConfig(ccConfig);
    const resilient = resolveHistoryImport(ccConfig);
    this.idempotentHistory = resilient !== null;
    if (this.since && ccConfig.replayHistory && !resilient) {
      throw new ReplayError(
        '--since into a Fabric history destination needs chaincode.historyImport: the destination already holds the ' +
          'earlier history, and only receipts make it safe to add to it (a plain history replay refuses a destination ' +
          'that holds keys). Use historyImport with a scope of its own for this replay; the operation IDs of records at ' +
          'or above the height are new, so nothing the earlier replay wrote is written again.',
      );
    }

    const { pairs, skippedChannels } = this.resolveDestinations(
      ccConfig, channels,
    );
    const channelConcurrency = resolveChannelConcurrency(
      ccConfig.channelConcurrency,
    );
    const checkpoints = this.chaincodeCheckpoints(
      pairs.map((p) => p.channel), channelConcurrency > 1,
    );
    // A dirty marker can only have been written by the legacy history path,
    // whose already-landed writes have no receipts. Enabling the resilient
    // protocol cannot retroactively make that partial destination safe.
    for (const checkpoint of new Set(checkpoints.values())) {
      this.assertResumable(checkpoint);
    }
    const replayChannels = pairs.map((p) => p.channel);
    this.warnUnusedKeyMappings(ccConfig, replayChannels);
    this.warnSplitDeleteTargets(ccConfig, replayChannels);
    const pool = await CollectionIdentityPool.connect(
      ccConfig, this.config.timeouts,
    );

    try {
      await this.preflightDestination(pool, pairs, ccConfig, resilient, checkpoints);

      const planDigest = resilient
        ? await computePlanDigest({
          context: resilient,
          ccConfig,
          layout: this.layout,
          pairs,
          sourceNetworkId: this.sourceNetworkId,
          ...(this.since && { since: this.since }),
        })
        : undefined;
      if (resilient && planDigest) {
        logger.info(
          { scope: resilient.scope, planDigest },
          'Resilient idempotent history import enabled',
        );
      }

      logger.info(
        {
          sourceChannels: pairs.map((p) => p.channel),
          destinationChannels: pairs.map((p) => p.destChannel),
          concurrency: ccConfig.concurrency,
          channelConcurrency,
          keyMappings: countFunctions(ccConfig.keyMapping),
          deleteMappings: countFunctions(ccConfig.deleteMapping),
        },
        'Starting chaincode replay',
      );

      // A shared checkpoint's cursor runs across every channel's files; a
      // channel's own checkpoint covers that channel's files alone.
      const allKeysFor = (channelId: string): string[] => (
        channelConcurrency > 1
          ? this.buildChaincodeFileKeys([channelId])
          : this.buildChaincodeFileKeys(pairs.map((p) => p.channel))
      );
      let totalReplayed = 0;
      let totalFailed = 0;
      const failures: ReplayFailure[] = [];

      const replayOne = async (
        { channel: channelId, destChannel }: ChannelRoute,
      ): Promise<void> => {
        const historyReplayer =
          resilient && planDigest
            ? new ResilientHistoryReplayer({
              context: resilient,
              planDigest,
              sourceNetworkId: this.sourceNetworkId,
              destChannel,
            })
            : undefined;
        const adapter = new ChaincodeAdapter(
          pool.defaultNetwork(destChannel),
          ccConfig,
          pool.identitiesFor(destChannel),
          historyReplayer,
        );

        const checkpoint = checkpoints.get(channelId) as ReplayCheckpointManager;
        const stats = await this.replayChannel({
          adapter,
          checkpoint,
          allKeys: allKeysFor(channelId),
          ccConfig,
          channelId,
          destChannel,
        });
        totalReplayed += stats.totalReplayed;
        totalFailed += stats.totalFailed;
        for (const failure of stats.failedKeys) {
          failures.push({ channel: channelId, ...failure });
        }
        if (channelConcurrency > 1) this.clearCheckpointIfClean(checkpoint);
      };

      await runChannels(pairs, channelConcurrency, replayOne);

      logger.info(
        { totalReplayed, totalFailed, channelConcurrency },
        'Chaincode replay complete',
      );

      if (channelConcurrency === 1) {
        for (const checkpoint of new Set(checkpoints.values())) {
          this.clearCheckpointIfClean(checkpoint);
        }
      }

      return {
        adapter: 'chaincode',
        totalReplayed,
        totalFailed,
        failures,
        skippedChannels,
        ...(this.historyAborted ? { historyAborted: this.historyAborted } : {}),
      };
    } finally {
      pool.disconnect();
    }
  }

  /**
   * The checkpoint each channel's progress is kept in.
   *
   * Sequential: one shared file, exactly as before parallel replay existed.
   * Parallel: one file per channel, because one cursor cannot describe several
   * channels advancing at once. Each mode refuses to start over the other's
   * files — resuming from the wrong one starts over, and at a history
   * destination that appends every version a second time.
   */
  private chaincodeCheckpoints(
    channels: string[],
    parallel: boolean,
  ): Map<string, ReplayCheckpointManager> {
    const inputDir = this.config.inputDir;
    const label = this.checkpointLabel('chaincode');
    const shared = checkpointFileName(label);
    const scoped = scopedCheckpointFiles(inputDir, label);

    if (parallel && fs.existsSync(path.join(inputDir, shared))) {
      throw new ReplayError(
        `${path.join(inputDir, shared)} is a sequential replay's checkpoint, ` +
        'and chaincode.channelConcurrency above 1 keeps one checkpoint per ' +
        'channel instead. Finish that run with channelConcurrency 1, or reset ' +
        'the destination and delete the checkpoint to start over in parallel.',
      );
    }
    if (!parallel && scoped.length > 0) {
      throw new ReplayError(
        `${scoped.join(', ')} ${scoped.length === 1 ? 'is a' : 'are'} parallel ` +
        'replay checkpoint(s), and channelConcurrency 1 keeps a single shared ' +
        'one. Re-run with the channelConcurrency that wrote them, or reset the ' +
        'destination and delete them to start over sequentially.',
      );
    }

    const result = new Map<string, ReplayCheckpointManager>();
    if (!parallel) {
      const checkpoint = new ReplayCheckpointManager(inputDir, label);
      for (const channel of channels) result.set(channel, checkpoint);
      return result;
    }
    for (const channel of channels) {
      // The layout's sanitiser, so a channel name cannot step outside the
      // input directory by way of the checkpoint's file name.
      const scope = this.layout.channelDir(channel).replace(/^channel-/, '');
      result.set(channel, new ReplayCheckpointManager(inputDir, label, scope));
    }
    return result;
  }

  /**
   * Pair each in-scope source channel with its destination.
   *
   * A channel with no destination is warned about and left out rather than
   * refused: narrowing a replay to part of a migration is routine, and the run
   * that skipped it reports it in `skippedChannels`. `verify` refuses the same
   * config, because a channel it silently left out reads as verified.
   */
  private resolveDestinations(
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    channels: string[],
  ): { pairs: ChannelRoute[]; skippedChannels: string[] } {
    const { routes, unroutedChannels } = resolveChannelRouting(
      ccConfig, channels,
    );

    if (unroutedChannels.length > 0) {
      logger.warn(
        {
          skippedChannels: unroutedChannels,
          mappedChannels: Object.keys(ccConfig.channelMapping ?? {}),
        },
        'Channels have no channelMapping entry and will NOT be replayed — ' +
        'add them to chaincode.channelMapping if their data is in scope',
      );
    }

    return { pairs: routes, skippedChannels: unroutedChannels };
  }

  /**
   * Refuse before the first write if the destination cannot take what is coming.
   *
   * Three questions, cheapest first. Whether every collection can be *named* at
   * the destination, which the config alone settles. Whether every chaincode in
   * scope is committed there under the same name and answers the migration
   * contract — a chaincode name is its state namespace and nothing here renames
   * one. And whether each collection admits the identity that would write it,
   * since a collection admits writes only from the orgs its policy names.
   *
   * Finding any of it out per record costs a whole run and leaves the
   * destination holding part of a migration, so it is established up front and
   * reported in full.
   *
   * The destination is queried whether or not the run carries private data: the
   * chaincodes have to be there either way, and a public-only replay fails just
   * as completely on a name the destination does not have.
   *
   * @throws ExtractorError when a collection has nowhere to be written.
   * @throws ReplayError naming every chaincode or collection that would reject
   *   its writes.
   */
  private async preflightDestination(
    pool: CollectionIdentityPool,
    pairs: ChannelRoute[],
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    resilient: ResilientHistoryContext | null,
    checkpoints: Map<string, ReplayCheckpointManager>,
  ): Promise<void> {
    // Before anything else is asked of it: is this the destination at all?
    const bound = await assertDestinationFingerprint(
      ccConfig.destinationFingerprint,
      (destChannel) => pool.defaultNetwork(destChannel),
      pairs.map((p) => p.destChannel),
    );
    if (!bound) {
      logger.warn(
        'chaincode.destinationFingerprint is not set, so nothing confirms this ' +
        'is the destination the config was made for — run ' +
        'fingerprint-destination and add the map before a production run',
      );
    }

    const targets = await this.listPrivateTargets(pool, pairs, ccConfig);

    const discoverer = new ChaincodeDiscoverer(pool.defaultGateway());
    const definitions = await readDestinationDefinitions(
      pairs.map((p) => p.destChannel),
      (destChannel) => discoverer.queryCommitted(destChannel),
    );
    this.warnUnchecked(definitions.unchecked);

    const deployments = await listDeployments(
      this.reader,
      this.layout,
      pairs,
      ccConfig.replayHistory ?? false,
      targets,
    );

    await this.preflightChaincodes(pool, ccConfig, definitions, deployments);

    if (resilient) {
      await this.preflightHistoryProtocol(pool, ccConfig, deployments, resilient);
    } else if (ccConfig.replayHistory) {
      await this.preflightEmptyDestination(pool, ccConfig, deployments, checkpoints);
    }

    if (targets.length === 0) return;

    const result = preflightCollections(
      targets,
      definitions.byChannel,
      (collection, destChannel) => pool.mspIdFor(collection, destChannel),
      ccConfig.ownerEndorsement ?? false,
    );
    this.warnUnchecked(result.unchecked);
    if (result.blockers.length > 0) {
      throw new ReplayError(formatPreflightRefusal(result.blockers));
    }
    this.warnPurging(result.purging);

    // The definitions are consistent; now ask the destination itself.
    const endorsementBlockers = await probePrivateEndorsements(
      targets,
      (target) => privateWriteContract(
        {
          network: pool.defaultNetwork(target.destChannel),
          identities: pool.identitiesFor(target.destChannel),
          defaultMspId: ccConfig.mspId,
          ownerEndorsement: ccConfig.ownerEndorsement ?? false,
        },
        target.chaincode,
        target.destCollection,
        ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT,
      ),
    );
    if (endorsementBlockers.length > 0) {
      throw new ReplayError(formatEndorsementRefusal(endorsementBlockers));
    }

    logger.info(
      { collections: result.checked },
      'Destination collections accept the identities configured for them, ' +
      'and endorse a probe write',
    );
  }

  /**
   * Refuse a resilient run whose destination contract does not implement the
   * history-import protocol, before the first write.
   *
   * Probed once per destination chaincode over the same gateway the writes will
   * use. A contract that predates the protocol would fail on the first
   * `ImportHistory` — a submit that leaves the destination touched — so the
   * probe (a read) catches it up front.
   *
   * @throws ReplayError naming every chaincode whose contract cannot serve it.
   */
  private async preflightHistoryProtocol(
    pool: CollectionIdentityPool,
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    deployments: DeploymentTarget[],
    resilient: ResilientHistoryContext,
  ): Promise<void> {
    const contract = ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
    const problems: string[] = [];

    for (const deployment of deployments) {
      const problem = await probeHistoryImportProtocol(
        pool
          .defaultNetwork(deployment.destChannel)
          .getContract(deployment.chaincode, contract),
        resilient.mode,
      );
      if (problem !== null) {
        problems.push(
          `${deployment.destChannel}/${deployment.chaincode}: ${problem}`,
        );
      }
    }

    if (problems.length > 0) {
      throw new ReplayError(
        `${problems.length} destination chaincode(s) do not implement the ` +
        `resilient history-import protocol (${resilient.mode}) required by ` +
        'chaincode.historyImport, so this run is refusing to start:\n' +
        `  ${problems.join('\n  ')}\n` +
        'Upgrade the migration contract on these chaincodes to a version that ' +
        'exports the history-import protocol, or remove chaincode.historyImport ' +
        'to use non-resilient history replay.',
      );
    }

    logger.info(
      { chaincodes: deployments.length, mode: resilient.mode },
      'Destination migration contract implements the resilient history-import protocol',
    );
  }

  /**
   * The private write targets, with the routing they depend on established.
   *
   * `assertCollectionRouting` comes before any query because it needs none: a
   * collection with nowhere to be written is decided by the config, and refusing
   * on it first means an operator with two problems is not shown the second one
   * as though it were the whole story.
   */
  private async listPrivateTargets(
    pool: CollectionIdentityPool,
    pairs: ChannelRoute[],
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
  ): Promise<PrivateWriteTarget[]> {
    const suffix = ccConfig.replayHistory
      ? '-history.ndjson'
      : '-state.ndjson';
    const targets = await listPrivateWriteTargets(
      this.reader, this.layout, pairs, suffix,
      (collection) => destinationCollection(
        ccConfig.collectionMapping, collection,
      ),
    );
    this.warnUnusedIdentities(pool, targets);
    if (targets.length > 0) {
      assertCollectionRouting(ccConfig, targets.map((t) => t.collection));
    }
    return targets;
  }

  /**
   * Refuse a destination missing a chaincode this run writes into.
   *
   * Probed over the same gateway and identity the writes will use, so a contract
   * that will not answer here will not take a write either.
   *
   * @throws ReplayError naming every chaincode that cannot take its writes.
   */
  private async preflightChaincodes(
    pool: CollectionIdentityPool,
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    definitions: DestinationDefinitions,
    deployments: DeploymentTarget[],
  ): Promise<void> {
    const contract = ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
    const result = await preflightDeployments(
      deployments,
      ccConfig,
      definitions.byChannel,
      migrationContractProbe(
        (destChannel) => pool.defaultNetwork(destChannel), contract,
      ),
    );

    this.warnUnchecked(result.unchecked);
    if (result.blockers.length > 0) {
      throw new ReplayError(formatDeploymentRefusal(result.blockers));
    }

    logger.info(
      { chaincodes: result.checked, contract },
      'Destination chaincodes are committed and answer the migration contract',
    );
  }

  /**
   * Refuse a fresh one-shot history replay over a destination that holds keys.
   *
   * Only for channels starting from no checkpoint: a resumed run is expected
   * to find its own earlier writes there.
   */
  private async preflightEmptyDestination(
    pool: CollectionIdentityPool,
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    deployments: DeploymentTarget[],
    checkpoints: Map<string, ReplayCheckpointManager>,
  ): Promise<void> {
    const fresh = deployments.filter(
      (d) => checkpoints.get(d.channel)?.load() == null,
    );
    if (fresh.length === 0) return;

    const { occupied, unchecked } = await findOccupiedNamespaces(
      fresh,
      keyPageProbe(
        (destChannel) => pool.defaultNetwork(destChannel),
        ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT,
      ),
    );
    this.warnUnchecked(unchecked);
    if (occupied.length > 0) {
      throw new ReplayError(formatOccupiedRefusal(occupied));
    }
  }

  /**
   * Warn about destination collections that will purge what this run writes.
   *
   * Not a refusal: a short window is sometimes the intended destination
   * behaviour, and a run whose writes finish inside the window loses nothing.
   * But the run cannot know how many blocks it will add, and every block after
   * a write moves that write toward its horizon, so the operator is told which
   * collections and how to keep their data until cutover.
   */
  private warnPurging(purging: PurgingCollection[]): void {
    for (const p of purging) {
      logger.warn(
        {
          channel: p.channel,
          destChannel: p.destChannel,
          chaincode: p.chaincode,
          collection: collectionLabel(p.collection, p.destCollection),
          blockToLive: p.blockToLive,
        },
        `Destination collection ${p.chaincode}/${p.destCollection} on ` +
          `${p.destChannel} purges private data after ${p.blockToLive} blocks. ` +
          'Every replayed write is a destination transaction, so values written ' +
          'early in this run can be purged by the destination before it ends, ' +
          'and verify then reports them missing. blockToLive cannot be changed ' +
          'after the definition is committed: replay this collection last and ' +
          'verify straight after, or choose blockToLive 0 as its lasting value — see ' +
          'docs/replay-config-reference.md#destination-blocktolive-during-migration',
      );
    }
  }

  /** Report one pre-flight question per line, none of them fatal. */
  private warnUnchecked(notes: string[]): void {
    for (const note of notes) {
      logger.warn({ preflight: 'unchecked' }, note);
    }
  }

  /**
   * Warn about a `collectionIdentities` entry no record will use.
   *
   * Almost always a mistyped collection name, whose effect is that the
   * collection it was meant to cover is written by the default identity after
   * all — silently, and with a denial per record if that identity is not a
   * member.
   */
  private warnUnusedIdentities(
    pool: CollectionIdentityPool,
    /** Every (destination channel, collection) this run writes. */
    targets: PrivateWriteTarget[],
  ): void {
    const present = new Set(targets.map((t) => t.destCollection));
    const unused = pool
      .configuredCollections()
      .filter((collection) => !present.has(collection));
    if (unused.length > 0) {
      logger.warn(
        { collections: unused, replaying: [...present] },
        'chaincode.collectionIdentities names collections this run has no data ' +
        'for — check the names against the private data files if you expected ' +
        'those collections to be replayed by their own identity',
      );
    }

    // A per-channel entry is also unused when its channel is: a source channel
    // name in place of the destination one is the likely mistake.
    const written = new Set(targets.map((t) => `${t.destChannel}\0${t.destCollection}`));
    const unusedPerChannel = pool
      .configuredChannelCollections()
      .filter((e) => !written.has(`${e.destChannel}\0${e.collection}`))
      .map((e) => `${e.destChannel}/${e.collection}`);
    if (unusedPerChannel.length > 0) {
      logger.warn(
        {
          entries: unusedPerChannel,
          destinationChannels: [...new Set(targets.map((t) => t.destChannel))],
        },
        'chaincode.channelCollectionIdentities names destination channel/' +
        'collection pairs this run writes nothing to — its keys are ' +
        'destination channel names, not source ones',
      );
    }
  }

  /**
   * Warn about a `keyMapping` or `deleteMapping` channel this run will not read.
   *
   * Both are keyed by source channel, and a channel that is misspelled or out of
   * scope matches no record — so every chaincode listed under it falls back to
   * `PutState`/`DeleteState` silently, which is the wrong function on a
   * destination that needed the mapping. Nothing else reports it: unlike the
   * verify maps, both have a working default, so a missing entry is not an error.
   */
  private warnUnusedKeyMappings(
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    replayChannels: string[],
  ): void {
    const inScope = new Set(replayChannels);
    const mapped = new Set([
      ...Object.keys(ccConfig.keyMapping ?? {}),
      ...Object.keys(ccConfig.deleteMapping ?? {}),
    ]);
    const unused = [...mapped].filter((channel) => !inScope.has(channel));
    if (unused.length === 0) return;

    logger.warn(
      { channels: unused, replaying: replayChannels },
      'chaincode.keyMapping or chaincode.deleteMapping names source channels ' +
      'this run does not replay — their chaincodes will be written with the ' +
      'default PutState and DeleteState if those channel names are misspelled',
    );
  }

  /**
   * Warn when a deployment's writes leave the migration contract but its deletes
   * do not.
   *
   * A `keyMapping` of `"SampleAssets:StoreAsset"` says the destination's own
   * function owns the write, usually because it maintains something besides the
   * key — a composite-key index, a counter, an event. With no `deleteMapping`
   * entry the matching tombstone goes to the migration contract's `DeleteState`,
   * which removes the key and leaves the rest of that bookkeeping referring to
   * it.
   *
   * A warning rather than a refusal, because `DeleteState` does delete the key
   * and whether anything else depended on it is a property of the destination
   * chaincode this tool cannot see. Reported only when `replayHistory` is on: a
   * tombstone reaches the destination only through `public_history`.
   */
  private warnSplitDeleteTargets(
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
    replayChannels: string[],
  ): void {
    if (!ccConfig.replayHistory) return;

    const contract = ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
    const split: string[] = [];

    for (const channel of replayChannels) {
      const byChaincode = ccConfig.keyMapping?.[channel] ?? {};
      for (const [chaincode, fn] of Object.entries(byChaincode)) {
        const onMigrationContract =
          parseQualifiedFunction(fn, contract).isMigrationContract;
        const deleteFn = mappedFunction(
          ccConfig.deleteMapping, channel, chaincode,
        );
        if (!onMigrationContract && deleteFn === undefined) {
          split.push(`${channel}/${chaincode}`);
        }
      }
    }
    if (split.length === 0) return;

    logger.warn(
      { deployments: split },
      'chaincode.keyMapping sends these writes to an application contract, ' +
      'but chaincode.deleteMapping names no delete function for them — their ' +
      `deletes will be replayed as ${contract}:${DEFAULT_DELETE_FUNCTION}, ` +
      'which removes the key without anything the write function maintains ' +
      'alongside it. Add a deleteMapping entry per deployment, naming that ' +
      'function explicitly if it is the one you want',
    );
  }

  private validateChaincodeConfig(
    ccConfig: NonNullable<ReplayConfig['chaincode']>,
  ): void {
    if (!ccConfig.connectionProfilePath) {
      throw new ReplayError(
        'connectionProfilePath is required — ' +
        'provide a standard Fabric connection profile JSON',
      );
    }
    if (
      !ccConfig.mspId ||
      !ccConfig.certPath ||
      !ccConfig.keyPath
    ) {
      throw new ReplayError(
        'mspId, certPath, and keyPath are required ' +
        'for chaincode replay identity',
      );
    }
  }

  private async replayChannel(
    job: ChannelReplayJob,
  ): Promise<ChaincodeReplayStats> {
    const { adapter, ccConfig, channelId, destChannel } = job;
    logger.info(
      { sourceChannel: channelId, destChannel },
      'Replaying channel',
    );

    const suffix = ccConfig.replayHistory ? '-history.ndjson' : '-state.ndjson';
    const publicPath = ccConfig.replayHistory
      ? this.layout.publicHistoryPath(channelId)
      : this.layout.publicStatePath(channelId);
    const publicKey = ccConfig.replayHistory
      ? `${channelId}/public-history`
      : `${channelId}/public-state`;

    await this.replayChaincodeFile(job, publicPath, publicKey);

    for (const pf of this.layout.listPrivateFiles(channelId, suffix)) {
      await this.replayChaincodeFile(
        job,
        path.join(this.layout.channelDir(channelId), pf),
        `${channelId}/${pf}`,
      );
    }

    // A history replay carries its deletes as tombstones; a state replay since a height has to send them.
    if (this.since && !ccConfig.replayHistory) {
      await this.replayStateDeletes(channelId, job.checkpoint, job.allKeys, (batch) => adapter.replayBatch(batch));
    }

    const stats = adapter.getStats();

    if (stats.historyReplayed > 0) {
      logger.info(
        {
          sourceChannel: channelId,
          historyReplayed: stats.historyReplayed,
        },
        'Tier 3 history replay stats',
      );
    }

    if (stats.totalFailed > 0) {
      logger.error(
        {
          sourceChannel: channelId,
          failed: stats.totalFailed,
          failedKeyCount: stats.failedKeys.length,
        },
        'Records failed during chaincode replay — see the failure report ' +
        'written at the end of the run for the complete list',
      );
    }

    return stats;
  }

  private buildChaincodeFileKeys(replayChannels: string[]): string[] {
    const keys: string[] = [];
    const ccConfig = this.config.chaincode;

    for (const channelId of replayChannels) {
      keys.push(`${channelId}/public-state`);
      for (const pf of this.layout.listPrivateFiles(
        channelId, '-state.ndjson',
      )) {
        keys.push(`${channelId}/${pf}`);
      }
      if (ccConfig?.replayHistory) {
        keys.push(`${channelId}/public-history`);
        for (const pf of this.layout.listPrivateFiles(
          channelId, '-history.ndjson',
        )) {
          keys.push(`${channelId}/${pf}`);
        }
      }
      // Last for the channel: replayChannel sends the deletes after every state file.
      if (this.since && !ccConfig?.replayHistory) keys.push(`${channelId}/state-deletes`);
    }

    return keys;
  }

  private async replayChaincodeFile(
    job: ChannelReplayJob,
    relPath: string,
    fileKey: string,
  ): Promise<void> {
    const { adapter, checkpoint, allKeys, ccConfig } = job;
    if (checkpoint.shouldSkipFile(fileKey, allKeys)) {
      logger.info({ label: fileKey }, 'Skipping already-completed file');
      return;
    }

    // Resilient idempotent history replay is safely resumable, so it is not
    // treated as append-only: a failure freezes the checkpoint and a re-run
    // retries from the last successful batch instead of refusing.
    const history = ccConfig.replayHistory === true;
    const appendOnly = history && !this.idempotentHistory;
    const aborted = this.stateOf(checkpoint).aborted;
    if (appendOnly && aborted !== null) {
      logger.error(
        { label: fileKey, abortedAt: aborted },
        'Skipping history file — an earlier history file failed, so this run ' +
        'ends with the destination needing a reset either way',
      );
      return;
    }

    const channelId = fileKey.slice(0, fileKey.indexOf('/'));
    const delta = await this.deltaFor(channelId);
    await this.replayFile({
      replayBatch: (batch) => adapter.replayBatch(batch),
      ...(delta && { filter: (rec: ExtractionRecord) => inDelta(rec, delta) }),
      checkpoint,
      filePath: path.join(this.config.inputDir, relPath),
      fileKey,
      allFiles: allKeys,
      offset: checkpoint.getResumeOffset(fileKey),
      failureCount: () => adapter.failureCount(),
      stopOnFailure: history,
      appendOnly,
    });
  }

  /** Stream one NDJSON file into the adapter. Returns records replayed. */
  private async replayFile(job: FileReplayJob): Promise<number> {
    const {
      replayBatch, checkpoint, filePath, fileKey, allFiles, offset,
    } = job;
    if (!fs.existsSync(filePath)) {
      logger.debug({ filePath, fileKey }, 'File not found — skipping');
      return 0;
    }

    if (offset > 0) {
      logger.info({ label: fileKey, offset }, 'Resuming file from offset');
    }

    let batch: ExtractionRecord[] = [];
    let totalRecords = 0;
    let skipped = 0;
    // Records read past the resume offset, whether or not the filter kept them: the checkpoint counts lines read.
    let consumed = 0;
    let failuresSeen = job.failureCount?.() ?? 0;
    let aborted = false;
    const orderChecker = new RecordOrderingChecker();

    const submit = async (records: ExtractionRecord[]): Promise<void> => {
      // Write-ahead for append-only history: a run killed inside replayBatch
      // leaves this marker, and the next run refuses rather than resend it.
      if (job.appendOnly && !this.stateOf(checkpoint).frozen) checkpoint.markInFlight(fileKey, allFiles);
      await replayBatch(records);
      totalRecords += records.length;
      const failed = job.failureCount?.() ?? 0;
      if (failed > failuresSeen) {
        failuresSeen = failed;
        this.freezeCheckpoint(checkpoint, fileKey);
        if (job.stopOnFailure) {
          aborted = true;
          if (job.appendOnly) {
            this.abortAppendOnly(
              checkpoint, fileKey, totalRecords, allFiles,
            );
          }
          return;
        }
      }
      this.advanceCheckpoint(
        checkpoint, fileKey, offset + consumed, allFiles,
      );
    };

    for await (const record of this.reader.stream(filePath)) {
      if (skipped < offset) {
        skipped++;
        continue;
      }
      consumed++;

      if (ORDERED_TYPES.has(record._type)) {
        const r = record as any;
        if (typeof r.blockNumber === 'number') {
          const txIdx = typeof r.txIndex === 'number' ? r.txIndex : 0;
          const v = orderChecker.check(r.blockNumber, txIdx);
          if (v) {
            const detail = v.type === 'block'
              ? `blockNumber went from ${v.prevBlock}` +
                ` to ${v.currentBlock}`
              : `in block ${v.currentBlock}, txIndex` +
                ` went from ${v.prevTxIndex}` +
                ` to ${v.currentTxIndex}`;
            throw new ReplayError(
              `Record ordering violation in ${fileKey}` +
              ` at record ${totalRecords + 1}: ${detail}`,
            );
          }
        }
      }

      if (job.filter && !job.filter(record)) continue;
      batch.push(record);

      if (batch.length >= this.batchSize) {
        await submit(batch);
        batch = [];
        if (aborted) break;

        if (totalRecords % 1000 === 0) {
          logger.info(
            { label: fileKey, records: totalRecords },
            'Replay progress',
          );
        }
      }
    }

    if (batch.length > 0 && !aborted) {
      await submit(batch);
    } else if (job.filter && !aborted && consumed > 0 && !this.stateOf(checkpoint).frozen) {
      // Every remaining record was filtered out: record the file as read to its end.
      this.advanceCheckpoint(checkpoint, fileKey, offset + consumed, allFiles);
    }

    logger.info(
      { label: fileKey, totalRecords, aborted },
      aborted ? 'File replay aborted' : 'File replay complete',
    );

    return totalRecords;
  }

  /**
   * Stop an append-only file at its first failure and make that durable.
   *
   * Carrying on would write records the operator has to discard anyway, and
   * would push the destination's history further out of order. The dirty
   * marker is written to the checkpoint so a later run refuses to resume —
   * see `assertResumable`.
   *
   * @param checkpoint Checkpoint for the current adapter.
   * @param fileKey File that failed.
   * @param recordsSubmitted Records submitted from this file before stopping.
   */
  private abortAppendOnly(
    checkpoint: ReplayCheckpointManager,
    fileKey: string,
    recordsSubmitted: number,
    allFiles: string[],
  ): void {
    const state = this.stateOf(checkpoint);
    if (state.aborted === null) state.aborted = fileKey;
    checkpoint.markDirty(fileKey, allFiles);
    logger.error(
      { label: fileKey, recordsSubmitted },
      'History replay stopped at the first failure — the destination holds a ' +
      'partial history for this file. Re-running cannot repair it: reset the ' +
      'destination and replay from the beginning',
    );
  }

}
