// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  Contract, Network, ProposalOptions, StatusCode,
} from '@hyperledger/fabric-gateway';
import {
  ChannelFunctionMap,
  PublicStateRecord,
  PublicHistoryRecord,
  PrivateStateRecord,
  PrivateHistoryRecord,
  ReplayConfig,
  ReplayRecord,
  StateDeleteRecord,
} from '../../types';
import { ReplayError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import { decodeLedgerValue, isTextValue } from '../../utils/value-codec';
import { ReplayIdentity } from '../collection-identities';
import {
  collectionLabel,
  destinationCollection,
  implicitCollectionOwner,
} from '../collection-routing';
import {
  DEFAULT_MIGRATION_CONTRACT,
  mappedFunction,
  parseQualifiedFunction,
} from '../function-mapping';
import {
  BATCH_HEADER_BYTES,
  MAX_BATCH_BYTES,
  PRIVATE_BATCH_TRANSIENT,
  PUBLIC_BATCH_TRANSIENT,
  StateBatchEntry,
  frameStateBatch,
  framedBatchEntryBytes,
} from '../state-batch';
import { RESILIENT_BATCH_ENTRY_OVERHEAD } from '../history-import/protocol';
import {
  HistoryImportConflictError,
  ResilientHistoryReplayer,
} from '../history-import/replayer';

const logger = createLogger('chaincode-adapter');

/**
 * A contract whose every proposal is endorsed by one org's peers.
 *
 * For `ownerEndorsement`: a write to another org's implicit collection is valid
 * only if that org's peer endorses it, and the gateway left to choose may pick
 * the submitter's own peer — which is refused for the endorsement policy and
 * cannot store the value either. Wrapping the contract rather than the call
 * covers every path that submits through it, the resilient history protocol's
 * included, without each of them having to know.
 */
function endorsedBy(contract: Contract, mspId: string): Contract {
  return new Proxy(contract, {
    get(target, prop, receiver) {
      if (prop === 'newProposal') {
        return (name: string, options: ProposalOptions = {}) =>
          target.newProposal(name, {
            ...options,
            endorsingOrganizations: [mspId],
          });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const DEFAULT_FUNCTION = 'PutState';

/** Batched public write. Only the migration contract has one. */
const BATCH_FUNCTION = 'PutStateBatch';
const PRIVATE_BATCH_FUNCTION = 'ImportPrivateDataBatch';

/** Public delete used when `deleteMapping` names none for a deployment. */
export const DEFAULT_DELETE_FUNCTION = 'DeleteState';

/** How a write to one destination collection is submitted. */
export interface PrivateWriteRoute {
  /** Top-level identity's network on the destination channel. */
  network: Network;
  /** Collection → its own identity on this channel, from the identity pool. */
  identities: Map<string, ReplayIdentity>;
  defaultMspId: string;
  ownerEndorsement: boolean;
}

/**
 * The contract a write to `destCollection` is submitted on — over the identity
 * configured for the collection, and endorsed by its owner under
 * `ownerEndorsement`. Shared by the adapter and the endorsement pre-flight, so
 * the probe asks exactly the question the writes will.
 */
export function privateWriteContract(
  route: PrivateWriteRoute,
  chaincode: string,
  destCollection: string | undefined,
  contractName: string,
): Contract {
  const identity = destCollection === undefined
    ? undefined : route.identities.get(destCollection);
  const network = identity?.network ?? route.network;
  const contract = network.getContract(chaincode, contractName);

  const owner = destCollection === undefined
    ? null : implicitCollectionOwner(destCollection);
  if (!route.ownerEndorsement || owner === null) return contract;
  if ((identity?.mspId ?? route.defaultMspId) === owner) return contract;
  return endorsedBy(contract, owner);
}
const DEFAULT_PRIVATE_FUNCTION = 'ImportPrivateData';
const DEFAULT_PRIVATE_DELETE_FUNCTION = 'DeletePrivateData';

/**
 * Transient keys the migration contract reads values from.
 *
 * No value travels as a transaction argument. The Node and Java contract shims
 * UTF-8-decode arguments before the chaincode sees them (`fabric-shim` stores
 * `entry.toString('utf8')`; the Java serializer builds `new String(bytes,
 * UTF_8)`), so any byte sequence that is not valid UTF-8 would reach
 * `putState` as U+FFFD and be written to the destination ledger that way.
 * Transient data is `bytes` on the wire and is delivered raw — `[]byte`,
 * `Buffer`, `byte[]` — in all three contract APIs.
 */
const PUBLIC_VALUE_TRANSIENT = 'public_value';
const PRIVATE_VALUE_TRANSIENT = 'private_value';

/** Writes per `PutStateBatch` when the config names none. */
const DEFAULT_WRITE_BATCH_SIZE = 500;

/** A tombstone's value. A delete is a flag in the framing, not empty bytes. */
const NO_VALUE = Buffer.alloc(0);

/**
 * Transaction validation code names, by code.
 *
 * fabric-gateway exports the code table but not its inverse, and a bare number
 * in a failure report is not something an operator can act on.
 */
const STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(StatusCode).map(([name, code]) => [code, name]),
);

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

type ActionableRecord =
  | PublicStateRecord
  | PrivateStateRecord
  | PublicHistoryRecord
  | PrivateHistoryRecord;

export interface ChaincodeReplayFailure {
  chaincode: string;
  /** Private data collection. Absent for public state/history records. */
  collection?: string;
  key: string;
  /**
   * MSP that submitted the failed write.
   *
   * With a replay identity per collection, "this collection was denied" is only
   * actionable alongside the identity it was denied for — otherwise the
   * operator cannot tell a missing `collectionIdentities` entry from a wrong
   * one.
   */
  mspId: string;
  error: string;
  /**
   * Further writes to this key abandoned after the failure.
   *
   * Writes to one key are ordered and interdependent, so the queue stops at the
   * first failure. Those abandoned writes count towards `totalFailed` but share
   * this one entry — without the count, a report of 1 line cannot be reconciled
   * with a "Records failed: 12" summary.
   */
  skippedAfter: number;
}

export interface ChaincodeReplayStats {
  totalReplayed: number;
  totalFailed: number;
  historyReplayed: number;
  failedKeys: ChaincodeReplayFailure[];
}

/** Private data collection a record belongs to, or `undefined` if public. */
function collectionOf(record: ActionableRecord): string | undefined {
  return 'collection' in record ? record.collection : undefined;
}

/**
 * Collection a record's writes will name, or `undefined` if public.
 *
 * The source name identifies the file the record came from; this is the name the
 * destination knows it by. Everything the destination decides — which identity
 * may submit, which policy admits the write, which peers store the value — is
 * decided by this one, so it is what the identity lookup and the submitted
 * argument both use.
 */
function destCollectionOf(
  record: ActionableRecord,
  collectionMapping: Record<string, string>,
): string | undefined {
  const collection = collectionOf(record);
  return collection === undefined
    ? undefined
    : destinationCollection(collectionMapping, collection);
}

/**
 * Validate the configured submission concurrency.
 *
 * A value of 0 would start zero drain workers, silently replaying nothing
 * while reporting success, so anything below 1 is rejected outright.
 */
function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new ReplayError(
      `chaincode.concurrency must be an integer >= 1, got: ${value}. ` +
      'Use 1 for sequential replay.',
    );
  }
  return value;
}

/**
 * Validate the configured batch size.
 *
 * There is no upper bound to check: `MAX_BATCH_BYTES` is what a transaction has
 * to clear to be orderable, and a count high enough to matter is cut by it.
 */
function resolveWriteBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WRITE_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1) {
    throw new ReplayError(
      `chaincode.writeBatchSize must be an integer >= 1, got: ${value}. ` +
      'Use 1 to submit every write in its own transaction.',
    );
  }
  return value;
}

/** Records for one (chaincode, collection, key), and how far they have got. */
interface KeyQueue {
  /** In write order. Writes to one key are ordered and interdependent. */
  records: ActionableRecord[];
  /** Index of the next record to submit. */
  next: number;
  /** Whether a failure abandoned the rest of this queue. */
  failed: boolean;
}

/** One record's place in a batch: what to write, and whose queue to advance. */
interface BatchTask {
  queue: KeyQueue;
  record: ActionableRecord;
  entry: StateBatchEntry;
  /** Destination collection for a private write; absent for public. */
  destCollection?: string;
}

/**
 * Cut a round's writes into batches: by (chaincode, destination collection)
 * first, then by the caps.
 *
 * A batch is one transaction on one chaincode's contract, so two chaincodes'
 * writes cannot share one — every key of the second would be written into the
 * first one's namespace, under a chaincode that never held it. Private writes
 * are further confined to one destination collection per batch: transient data
 * reaches every endorser, so a batch spanning collections would disclose each
 * one's values to peers that may not be its members. One collection per batch
 * also means one submitting identity per batch, since identities are chosen by
 * destination collection. Public writes form their own group per chaincode.
 */
function splitBatches(tasks: BatchTask[], maxCount: number, entryOverhead = 0): BatchTask[][] {
  const byChaincode = new Map<string, BatchTask[]>();

  for (const task of tasks) {
    const groupKey = `${task.record.chaincode}\x00${task.destCollection ?? ''}`;
    const group = byChaincode.get(groupKey);
    if (group) group.push(task);
    else byChaincode.set(groupKey, [task]);
  }

  return [...byChaincode.values()].flatMap(
    (group) => splitBySize(group, maxCount, entryOverhead),
  );
}

/**
 * Cut one chaincode's writes into batches no larger than the count and byte
 * caps.
 *
 * Greedy, and it always admits at least one task into an empty batch. That is
 * what keeps an oversized value from needing a case of its own: a value cannot
 * be written in pieces, so a record whose framed size exceeds `MAX_BATCH_BYTES`
 * becomes a batch of one — and a batch of one is submitted through the
 * single-record `PutState`, which has no framing bound to clear.
 */
function splitBySize(tasks: BatchTask[], maxCount: number, entryOverhead = 0): BatchTask[][] {
  const batches: BatchTask[][] = [];
  let current: BatchTask[] = [];
  let bytes = BATCH_HEADER_BYTES;

  for (const task of tasks) {
    const size = framedBatchEntryBytes(task.entry) + entryOverhead;
    const full = current.length >= maxCount || bytes + size > MAX_BATCH_BYTES;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      bytes = BATCH_HEADER_BYTES;
    }
    current.push(task);
    bytes += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** A `replay --since` state delete, shaped as the tombstone the delete path already sends. */
function stateDeleteAsTombstone(d: StateDeleteRecord): PublicHistoryRecord | PrivateHistoryRecord {
  const common = { channel: d.channel, chaincode: d.chaincode, key: d.key, value: '', txId: '', txIndex: 0, blockNumber: 0, timestamp: '', isDelete: true };
  return d.collection !== undefined
    ? { _type: 'private_history', ...common, collection: d.collection }
    : { _type: 'public_history', ...common, creator: { mspId: '', commonName: '', certFingerprint: '', org: '' } };
}

export class ChaincodeAdapter {
  private network: Network;
  private identities: Map<string, ReplayIdentity>;
  private defaultMspId: string;
  private keyMapping: ChannelFunctionMap;
  private deleteMapping: ChannelFunctionMap;
  private collectionMapping: Record<string, string>;
  private migrationContract: string;
  private concurrency: number;
  private writeBatchSize: number;
  private replayHistory: boolean;
  private embedSourceMetadata: boolean;
  private ownerEndorsement: boolean;
  /** Set when resilient idempotent history import is configured. */
  private resilient?: ResilientHistoryReplayer;
  private totalReplayed = 0;
  private totalFailed = 0;
  private historyReplayed = 0;
  private failedKeys: ChaincodeReplayStats['failedKeys'] = [];
  private warnedNotEmbeddable = false;

  /**
   * @param network Destination channel for the top-level replay identity.
   * @param identities Destination collection → the identity that writes it, for
   *   collections the top-level identity is not admitted to. Keyed by the
   *   destination name because that is the collection whose policy decides.
   *   Empty for a single-org replay.
   */
  constructor(
    network: Network,
    config: ChaincodeConfig,
    identities: Map<string, ReplayIdentity> = new Map(),
    resilient?: ResilientHistoryReplayer,
  ) {
    this.network = network;
    this.identities = identities;
    this.defaultMspId = config.mspId;
    this.keyMapping = config.keyMapping ?? {};
    this.deleteMapping = config.deleteMapping ?? {};
    this.collectionMapping = config.collectionMapping ?? {};
    this.migrationContract =
      config.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
    this.concurrency = resolveConcurrency(config.concurrency);
    this.writeBatchSize = resolveWriteBatchSize(config.writeBatchSize);
    this.replayHistory = config.replayHistory ?? false;
    this.embedSourceMetadata = config.embedSourceMetadata ?? false;
    this.ownerEndorsement = config.ownerEndorsement ?? false;
    this.resilient = resilient;
  }

  /**
   * Replay a batch of extraction records using key-partitioned concurrency.
   *
   * Records are grouped by (chaincode, collection, key). Per-key queues are
   * drained sequentially to preserve write ordering, while up to `concurrency`
   * queues run in parallel for throughput. If a record fails, its key's
   * queue stops (subsequent writes depend on this one) but other keys
   * continue.
   *
   * The collection is part of the partition because a denial is per collection,
   * not per key: without it, one collection the replay identity may not write
   * takes every other collection's records for the same key down with it, and
   * those collections were writable.
   *
   * When replayHistory is enabled, public_history and private_history
   * records are replayed via the same PutState / ImportPrivateData
   * calls as current-state records, preserving the full write sequence
   * so the destination's GetHistoryForKey reflects history.
   *
   * Public writes to the migration contract are batched — one transaction
   * carrying the head of up to `writeBatchSize` keys' queues, which is what
   * makes a deep history replayable in hours rather than weeks. Everything else
   * keeps one transaction per record. The two run as separate phases because a
   * queue belongs wholly to one of them, and each phase gets the whole
   * concurrency budget.
   */
  async replayBatch(records: ReplayRecord[]): Promise<void> {
    const actionable = this.filterActionable(records);
    if (actionable.length === 0) return;

    const queues = new Map<string, KeyQueue>();
    for (const record of actionable) {
      const partitionKey = this.partitionKey(record);
      let queue = queues.get(partitionKey);
      if (!queue) {
        queue = { records: [], next: 0, failed: false };
        queues.set(partitionKey, queue);
      }
      queue.records.push(record);
    }

    const all = [...queues.values()];
    const batched = all.filter((queue) => this.canBatch(queue));
    const single = all.filter((queue) => !this.canBatch(queue));

    await this.drainBatched(batched);
    await this.runTasks(single.map((queue) => () => this.drainKeyQueue(queue)));
  }

  /**
   * Run tasks with at most `concurrency` in flight.
   *
   * The workers share one iterator rather than taking a slice each, so a slow
   * task does not leave its worker's share of the queue waiting behind it.
   * `next()` is synchronous, so no two workers can be handed the same task.
   */
  private async runTasks(tasks: (() => Promise<void>)[]): Promise<void> {
    const pending = tasks[Symbol.iterator]();
    const workers: Promise<void>[] = [];

    for (let i = 0; i < Math.min(this.concurrency, tasks.length); i++) {
      workers.push((async () => {
        for (const task of pending) await task();
      })());
    }

    await Promise.all(workers);
  }

  /**
   * Replay batchable queues in rounds: one write per key per transaction.
   *
   * A round takes the head of every queue still going, so a batch holds each of
   * its keys exactly once. That is not an optimisation but the constraint the
   * encoding is built around — a transaction's write set records one value per
   * key, so a second version of a key in the same batch would overwrite the
   * first and leave the destination's history a version short.
   *
   * Rounds are barriers. Ordering within a key is the only ordering that
   * matters, so letting a fast queue run ahead would also be correct, but it
   * would mean holding partly-filled batches open and deciding when to submit
   * them; a barrier costs the difference between the slowest and fastest
   * transaction in a round and needs no such rule.
   */
  private async drainBatched(queues: KeyQueue[]): Promise<void> {
    let live = queues;
    const overhead = this.resilient ? RESILIENT_BATCH_ENTRY_OVERHEAD : 0;

    while (live.length > 0) {
      const round = splitBatches(
        this.roundTasks(live), this.writeBatchSize, overhead,
      );
      await this.runTasks(
        round.map((batch) => () => this.submitStateBatch(batch)),
      );
      live = live.filter(
        (queue) => !queue.failed && queue.next < queue.records.length,
      );
    }
  }

  /**
   * The head of every live queue, framed and ready to batch.
   *
   * A value that cannot be decoded fails its own key here rather than the
   * round: it is the same defect in one record that the single-record path
   * reports against one key, and a batch that never formed should not take the
   * other keys' writes with it.
   */
  private roundTasks(queues: KeyQueue[]): BatchTask[] {
    const tasks: BatchTask[] = [];

    for (const queue of queues) {
      const record = queue.records[queue.next];
      try {
        tasks.push({
          queue,
          record,
          entry: this.batchEntry(record),
          destCollection: destCollectionOf(record, this.collectionMapping),
        });
      } catch (err) {
        this.failQueue(
          queue,
          new ReplayError(
            `Failed to read the value for key ${record.key} of ` +
            `${record.chaincode}`,
            err as Error,
          ),
        );
      }
    }

    return tasks;
  }

  /** What one record contributes to a batch. */
  private batchEntry(record: ActionableRecord): StateBatchEntry {
    if (record._type === 'public_history' || record._type === 'private_history') {
      if (record.isDelete) {
        return { key: record.key, value: NO_VALUE, isDelete: true };
      }
      return {
        key: record.key, value: this.maybeWrapValue(record), isDelete: false,
      };
    }
    return {
      key: record.key, value: decodeLedgerValue(record), isDelete: false,
    };
  }

  /**
   * Submit one batch and advance the queues it carried.
   *
   * A batch of one is submitted through the single-record path instead: it
   * costs the same one transaction, and it is the path whose bound on a value
   * is the peer's message limit rather than `MAX_BATCH_BYTES`, so a value too
   * large to batch needs no case of its own.
   *
   * A batch is one transaction, so a failure fails every key in it. Each gets
   * its own failure entry — the operator's list is of keys to look at, and one
   * entry naming a batch would say nothing about which keys are missing.
   */
  private async submitStateBatch(tasks: BatchTask[]): Promise<void> {
    if (tasks.length === 1) {
      await this.submitSingle(tasks[0]);
      return;
    }

    if (tasks[0].destCollection !== undefined) {
      await this.submitPrivateBatch(tasks, tasks[0].destCollection);
      return;
    }

    if (this.resilient) {
      await this.submitResilientBatch(tasks);
      return;
    }

    const { chaincode } = tasks[0].record;
    const framed = frameStateBatch(tasks.map((task) => task.entry));

    try {
      await this.submitWrite(
        this.contractFor(tasks[0].record), BATCH_FUNCTION, [],
        { [PUBLIC_BATCH_TRANSIENT]: framed },
      );
    } catch (err) {
      const failure = new ReplayError(
        `Failed to submit a batch of ${tasks.length} public writes ` +
        `(${framed.length} bytes) to ` +
        `${chaincode}/${this.migrationContract}:${BATCH_FUNCTION}`,
        err as Error,
      );
      for (const task of tasks) this.failQueue(task.queue, failure);
      return;
    }

    for (const task of tasks) {
      this.countReplayed(task.record);
      task.queue.next++;
    }
  }

  /**
   * Submit one destination collection's batch of private writes.
   *
   * Over the collection's own identity — `contractFor` resolves it from the
   * destination collection, and every task in the batch shares that collection
   * — so the batch is endorsed and disclosed exactly as each of its records
   * would have been on its own.
   */
  private async submitPrivateBatch(
    tasks: BatchTask[],
    destCollection: string,
  ): Promise<void> {
    const { chaincode } = tasks[0].record;
    const collection = collectionOf(tasks[0].record) as string;
    const framed = frameStateBatch(tasks.map((task) => task.entry));

    try {
      await this.submitWrite(
        this.contractFor(tasks[0].record), PRIVATE_BATCH_FUNCTION,
        [destCollection], { [PRIVATE_BATCH_TRANSIENT]: framed },
      );
    } catch (err) {
      const failure = new ReplayError(
        `Failed to submit a batch of ${tasks.length} private writes ` +
        `(${framed.length} bytes) for ` +
        `${collectionLabel(collection, destCollection)} to ` +
        `${chaincode}/${this.migrationContract}:${PRIVATE_BATCH_FUNCTION}`,
        err as Error,
      );
      for (const task of tasks) this.failQueue(task.queue, failure);
      return;
    }

    for (const task of tasks) {
      this.countReplayed(task.record);
      task.queue.next++;
    }
  }

  /**
   * Submit a batch of public history through the resilient protocol.
   *
   * Only public history is batchable, and in resilient mode every record here is
   * a `public_history` record (current-state files are not replayed when
   * `replayHistory` is on). A conflicting receipt aborts the run; any other
   * failure fails every key in the batch, exactly as the legacy path does.
   */
  private async submitResilientBatch(tasks: BatchTask[]): Promise<void> {
    const { chaincode } = tasks[0].record;
    const contract = this.contractFor(tasks[0].record);
    const entries = tasks.map((task) => ({
      record: task.record as PublicHistoryRecord,
      value: task.entry.value,
      isDelete: task.entry.isDelete,
    }));

    try {
      await this.resilient!.submitPublicBatch(contract, chaincode, entries);
    } catch (err) {
      if (err instanceof HistoryImportConflictError) throw err;
      for (const task of tasks) this.failQueue(task.queue, err as Error);
      return;
    }

    for (const task of tasks) {
      this.countReplayed(task.record);
      task.queue.next++;
    }
  }

  /** Submit a batchable record on its own, through the single-record path. */
  private async submitSingle(task: BatchTask): Promise<void> {
    try {
      await this.submitRecord(task.record);
      this.countReplayed(task.record);
      task.queue.next++;
    } catch (err) {
      if (err instanceof HistoryImportConflictError) throw err;
      this.failQueue(task.queue, err as Error);
    }
  }

  /**
   * Whether a queue's writes can share transactions with other keys'.
   *
   * A queue is one key of one chaincode, so its records are all public or all
   * private and all resolve the same mapping — `every` states the rule the two
   * phases need rather than screening a mixture the partition key can produce.
   * The rule is what matters: a queue split across the phases would have its
   * writes submitted in two, and the order writes to one key arrive in is the
   * order its history ends up in.
   *
   * Private data batches through `ImportPrivateDataBatch`, one destination
   * collection per batch (see `splitBatches`), except under `historyImport`,
   * whose receipts are per mutation and whose private path has no batch form.
   * A `keyMapping` or `deleteMapping`
   * entry pointing anywhere else is not either: it names an application's own
   * function, which takes one key and knows nothing of this framing.
   */
  private canBatch(queue: KeyQueue): boolean {
    if (this.writeBatchSize < 2) return false;
    return queue.records.every((record) => this.batchableRecord(record));
  }

  private batchableRecord(record: ActionableRecord): boolean {
    if (record._type === 'private_state' || record._type === 'private_history') {
      return !this.resilient;
    }
    return (
      this.writesTo(this.keyMapping, record, DEFAULT_FUNCTION) &&
      this.writesTo(this.deleteMapping, record, DEFAULT_DELETE_FUNCTION)
    );
  }

  /**
   * Whether a map leaves a record on the migration contract's own function.
   *
   * An entry naming that function is the same configuration as no entry at all,
   * so it has to batch the same way. `generate-replay-config` writes `PutState`
   * for every deployment, and an explicit `DeleteState` is what silences the
   * unmapped-delete warning — batching only the unmapped ones would leave both
   * submitting a transaction per write for a reason nothing in the config
   * expresses.
   */
  private writesTo(
    map: ChannelFunctionMap | undefined,
    record: ActionableRecord,
    contractFunction: string,
  ): boolean {
    const configured = mappedFunction(map, record.channel, record.chaincode);
    if (configured === undefined) return true;

    const parsed = parseQualifiedFunction(configured, this.migrationContract);
    return parsed.isMigrationContract
      && parsed.functionName === contractFunction;
  }

  /**
   * Queue a record belongs to: everything that must be written in order.
   *
   * `\x00` delimits unambiguously even though keys may contain it: Fabric
   * restricts chaincode and collection names to word characters, so the first
   * two separators are always the field boundaries and the rest is the key.
   */
  private partitionKey(record: ActionableRecord): string {
    return [
      record.chaincode,
      collectionOf(record) ?? '',
      record.key,
    ].join('\x00');
  }

  getStats(): ChaincodeReplayStats {
    return {
      totalReplayed: this.totalReplayed,
      totalFailed: this.totalFailed,
      historyReplayed: this.historyReplayed,
      failedKeys: [...this.failedKeys],
    };
  }

  /** Records that failed so far. Cheap enough to poll after every batch. */
  failureCount(): number {
    return this.totalFailed;
  }

  private filterActionable(
    records: ReplayRecord[],
  ): ActionableRecord[] {
    const result: ActionableRecord[] = [];

    for (const r of records) {
      switch (r._type) {
        case 'public_state':
        case 'private_state':
          result.push(r);
          break;
        case 'public_history':
        case 'private_history':
          if (this.replayHistory) result.push(r);
          break;
        case 'state_delete':
          // `replay --since` into a state-only destination: a key deleted in the replayed range. Sent through the
          // same delete functions (deleteMapping / DeletePrivateData) a history replay uses for a tombstone.
          result.push(stateDeleteAsTombstone(r));
          break;
        default:
          break;
      }
    }

    return result;
  }

  /**
   * Drain a single key's queue sequentially. Stops on first failure
   * since subsequent writes to this key depend on earlier ones.
   */
  private async drainKeyQueue(queue: KeyQueue): Promise<void> {
    while (queue.next < queue.records.length) {
      const record = queue.records[queue.next];
      try {
        await this.submitRecord(record);
        this.countReplayed(record);
        queue.next++;
      } catch (err) {
        if (err instanceof HistoryImportConflictError) throw err;
        this.failQueue(queue, err as Error);
        return;
      }
    }
  }

  private countReplayed(record: ActionableRecord): void {
    this.totalReplayed++;
    if (
      record._type === 'public_history' ||
      record._type === 'private_history'
    ) {
      this.historyReplayed++;
    }
  }

  /**
   * Report a failed write and abandon the rest of its key's queue.
   *
   * Every path that fails a write ends here, so a batched write and a
   * single-record one leave the same entry in the report: the key, who
   * submitted it, and how many of its later writes were dropped with it.
   */
  private failQueue(queue: KeyQueue, err: Error): void {
    const record = queue.records[queue.next];
    const remaining = queue.records.length - queue.next - 1;
    queue.failed = true;

    // Both halves. The ReplayError names the record and the
    // chaincode/Contract:function it was submitted to; the peer's reason is
    // nested below it, in the gateway error's endorsement details. Keeping
    // only the innermost message loses the target — which, for a mapped
    // function, is the part that says which config entry to change.
    const cause = (err as any).cause;
    const inner = cause?.details?.[0]?.message ?? cause?.message;
    const outer = err.message;
    const detail = inner ? `${outer}: ${inner}` : outer;
    const collection = collectionOf(record);
    const mspId = this.mspIdFor(
      destCollectionOf(record, this.collectionMapping),
    );

    this.totalFailed += 1 + remaining;
    this.failedKeys.push({
      chaincode: record.chaincode,
      collection,
      key: record.key,
      mspId,
      error: detail,
      skippedAfter: remaining,
    });
    logger.warn(
      {
        chaincode: record.chaincode,
        collection,
        key: record.key,
        mspId,
        remaining,
        error: detail,
      },
      'Key queue stopped — subsequent writes skipped',
    );
  }

  /**
   * The contract to submit a record on, resolved through its collection.
   *
   * A collection with its own identity is submitted over that identity's
   * connection — a different gateway, and usually a peer of the owning org,
   * because a peer that is not a collection member cannot store the private
   * data it endorses. Public records always go over the top-level identity.
   *
   * @param contractName Contract namespace within the record's chaincode.
   *   Defaults to the migration contract, which holds every function this
   *   adapter calls unless `keyMapping` names another one.
   */
  private contractFor(
    record: ActionableRecord,
    contractName: string = this.migrationContract,
  ): Contract {
    return privateWriteContract(
      {
        network: this.network,
        identities: this.identities,
        defaultMspId: this.defaultMspId,
        ownerEndorsement: this.ownerEndorsement,
      },
      record.chaincode,
      destCollectionOf(record, this.collectionMapping),
      contractName,
    );
  }

  /**
   * The call one public record is submitted through.
   *
   * Two resolutions, both of which `replay` used to skip. The map is read by
   * `(channel, chaincode)`, because a chaincode name is only unique within a
   * channel and the same application on two channels can need two destination
   * functions. Its value is then split on the contract, because Fabric namespaces
   * functions by contract within a chaincode: a mapping of
   * `"SampleAssets:StoreAsset"` means the customer's own contract, and submitting
   * that whole string as a function name on the migration contract — which is
   * what happened before — is rejected by the peer on every record.
   *
   * @param map `keyMapping` for a write, `deleteMapping` for a tombstone.
   * @param defaultFunction Function used when the pair has no entry, taken to be
   *   the migration contract's.
   */
  private publicCall(
    record: PublicStateRecord | PublicHistoryRecord,
    map: ChannelFunctionMap,
    defaultFunction: string,
  ): { contract: Contract; target: string; functionName: string } {
    const configured =
      mappedFunction(map, record.channel, record.chaincode)
      ?? defaultFunction;
    const { contractName, functionName } = parseQualifiedFunction(
      configured, this.migrationContract,
    );
    return {
      contract: this.contractFor(record, contractName),
      target: `${record.chaincode}/${contractName}:${functionName}`,
      functionName,
    };
  }

  /** The call a public value is written through — `keyMapping`. */
  private publicWrite(
    record: PublicStateRecord | PublicHistoryRecord,
  ): { contract: Contract; target: string; functionName: string } {
    return this.publicCall(record, this.keyMapping, DEFAULT_FUNCTION);
  }

  /**
   * The call a public tombstone is replayed through — `deleteMapping`.
   *
   * Its own map rather than `keyMapping`'s: a delete takes the key alone and
   * carries no transient data, so submitting the write function for a tombstone
   * would write an empty value where the source deleted the key. A destination
   * whose writes go to an application function needs its delete named here, or
   * the pair splits across two contracts.
   */
  private publicDelete(
    record: PublicHistoryRecord,
  ): { contract: Contract; target: string; functionName: string } {
    return this.publicCall(
      record, this.deleteMapping, DEFAULT_DELETE_FUNCTION,
    );
  }

  /**
   * MSP that submits writes to a destination collection, or public writes if
   * absent.
   */
  private mspIdFor(collection: string | undefined): string {
    if (collection === undefined) return this.defaultMspId;
    return this.identities.get(collection)?.mspId ?? this.defaultMspId;
  }

  private async submitRecord(
    record: ActionableRecord,
  ): Promise<void> {
    switch (record._type) {
      case 'public_state':
        return this.submitPublicState(record);
      case 'private_state':
        return this.submitPrivateState(record);
      case 'public_history':
        return this.submitPublicHistory(record);
      case 'private_history':
        return this.submitPrivateHistory(record);
    }
  }

  /**
   * Submit one write and confirm it committed.
   *
   * Always the full proposal flow, because a value travels as transient data
   * (see `PUBLIC_VALUE_TRANSIENT`) and `submitTransaction` cannot carry any.
   *
   * The commit status is awaited rather than assumed. A transaction that
   * endorses and orders successfully can still fail validation — an MVCC
   * conflict, an endorsement policy the destination applies, a collection this
   * identity may not write — and counting those as replayed would report a
   * success the destination ledger does not hold.
   */
  private async submitWrite(
    contract: Contract,
    functionName: string,
    args: string[],
    transientData?: Record<string, Uint8Array>,
  ): Promise<void> {
    const proposal = contract.newProposal(functionName, {
      arguments: args,
      ...(transientData ? { transientData } : {}),
    });
    const transaction = await proposal.endorse();
    const commit = await transaction.submit();

    const status = await commit.getStatus();
    if (status.successful) return;

    throw new Error(
      `transaction ${status.transactionId} was ordered but failed validation ` +
      `in block ${status.blockNumber}: ` +
      `${STATUS_NAMES[status.code] ?? `code ${status.code}`}`,
    );
  }

  private async submitPublicState(
    record: PublicStateRecord,
  ): Promise<void> {
    const { contract, target, functionName } = this.publicWrite(record);

    try {
      await this.submitWrite(contract, functionName, [record.key], {
        [PUBLIC_VALUE_TRANSIENT]: decodeLedgerValue(record),
      });
    } catch (err) {
      throw new ReplayError(
        `Failed to submit public state for key ${record.key} to ${target}`,
        err as Error,
      );
    }
  }

  private async submitPrivateState(
    record: PrivateStateRecord,
  ): Promise<void> {
    const functionName = DEFAULT_PRIVATE_FUNCTION;
    const contract = this.contractFor(record);
    const collection = destinationCollection(
      this.collectionMapping, record.collection,
    );

    try {
      await this.submitWrite(
        contract, functionName, [collection, record.key],
        { [PRIVATE_VALUE_TRANSIENT]: decodeLedgerValue(record) },
      );
    } catch (err) {
      throw new ReplayError(
        `Failed to submit private state for ` +
        `${collectionLabel(record.collection, collection)}:${record.key} ` +
        `to ${record.chaincode}:${functionName}`,
        err as Error,
      );
    }
  }

  private async submitPublicHistory(
    record: PublicHistoryRecord,
  ): Promise<void> {
    if (this.resilient) {
      const value = record.isDelete ? NO_VALUE : this.maybeWrapValue(record);
      await this.resilient.submitEntry(this.contractFor(record), {
        record,
        value,
        isDelete: record.isDelete,
      });
      return;
    }

    if (record.isDelete) {
      const { contract, target, functionName } = this.publicDelete(record);
      try {
        await this.submitWrite(contract, functionName, [record.key]);
      } catch (err) {
        throw new ReplayError(
          `Failed to replay public delete for key ${record.key} ` +
          `block ${record.blockNumber} to ${target}`,
          err as Error,
        );
      }
      return;
    }

    const { contract, target, functionName } = this.publicWrite(record);
    const value = this.maybeWrapValue(record);

    try {
      await this.submitWrite(contract, functionName, [record.key], {
        [PUBLIC_VALUE_TRANSIENT]: value,
      });
    } catch (err) {
      throw new ReplayError(
        `Failed to replay public history for key ${record.key} ` +
        `block ${record.blockNumber} to ${target}`,
        err as Error,
      );
    }
  }

  private async submitPrivateHistory(
    record: PrivateHistoryRecord,
  ): Promise<void> {
    const contract = this.contractFor(record);
    const collection = destinationCollection(
      this.collectionMapping, record.collection,
    );
    const label = collectionLabel(record.collection, collection);

    if (this.resilient) {
      const value = record.isDelete ? NO_VALUE : this.maybeWrapValue(record);
      await this.resilient.submitEntry(contract, {
        record,
        destCollection: collection,
        value,
        isDelete: record.isDelete,
      });
      return;
    }

    if (record.isDelete) {
      const functionName = DEFAULT_PRIVATE_DELETE_FUNCTION;
      try {
        await this.submitWrite(
          contract, functionName, [collection, record.key],
        );
      } catch (err) {
        throw new ReplayError(
          `Failed to replay private delete for ` +
          `${label}:${record.key} ` +
          `block ${record.blockNumber} ` +
          `to ${record.chaincode}:${functionName}`,
          err as Error,
        );
      }
      return;
    }

    const functionName = DEFAULT_PRIVATE_FUNCTION;
    const value = this.maybeWrapValue(record);

    try {
      await this.submitWrite(
        contract, functionName, [collection, record.key],
        { [PRIVATE_VALUE_TRANSIENT]: value },
      );
    } catch (err) {
      throw new ReplayError(
        `Failed to replay private history for ` +
        `${label}:${record.key} ` +
        `block ${record.blockNumber} ` +
        `to ${record.chaincode}:${functionName}`,
        err as Error,
      );
    }
  }

  /**
   * The bytes to submit for a history record.
   *
   * With `embedSourceMetadata` on, source provenance is merged into values
   * that are JSON objects — an additive change the destination chaincode can
   * ignore. Anything else (binary, a JSON scalar, an array, non-JSON text) is
   * submitted byte-for-byte: wrapping it would change its type at the
   * destination, which is corruption, not annotation.
   */
  private maybeWrapValue(
    record: PublicHistoryRecord | PrivateHistoryRecord,
  ): Buffer {
    const bytes = decodeLedgerValue(record);
    if (!this.embedSourceMetadata) return bytes;
    return this.mergeMigrationMeta(record, bytes) ?? bytes;
  }

  /**
   * Merge migration provenance into a JSON-object value.
   *
   * @returns The merged bytes, or `null` if the value is not a JSON object.
   */
  private mergeMigrationMeta(
    record: PublicHistoryRecord | PrivateHistoryRecord,
    bytes: Buffer,
  ): Buffer | null {
    if (!isTextValue(record)) {
      this.warnNotEmbeddable(record, 'binary');
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf-8'));
    } catch {
      this.warnNotEmbeddable(record, 'not JSON');
      return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warnNotEmbeddable(record, 'not a JSON object');
      return null;
    }

    if ('migrationMeta' in parsed) {
      logger.warn(
        {
          chaincode: record.chaincode,
          key: record.key,
          blockNumber: record.blockNumber,
        },
        'Source value already contains migrationMeta field; overwriting with migration metadata',
      );
    }

    const migrationMeta = {
      blockNumber: record.blockNumber,
      txId: record.txId,
      timestamp: record.timestamp,
      isDelete: record.isDelete,
    };

    return Buffer.from(JSON.stringify({ ...parsed, migrationMeta }), 'utf-8');
  }

  private warnNotEmbeddable(
    record: PublicHistoryRecord | PrivateHistoryRecord,
    reason: string,
  ): void {
    if (this.warnedNotEmbeddable) return;
    this.warnedNotEmbeddable = true;
    logger.warn(
      { chaincode: record.chaincode, key: record.key, reason },
      'embedSourceMetadata is on but this value is not a JSON object — ' +
        'submitting the source bytes unchanged. Logged once per run.',
    );
  }
}
