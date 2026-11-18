// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Client driver for the resilient, idempotent history-import protocol.
 *
 * The chaincode adapter owns the per-key queues, rounds, and concurrency that
 * order and parallelise writes; this driver owns only the wire protocol for the
 * history mutations that flow through them. For each mutation it computes the
 * operation ID and intent commitment, frames the envelope or batch, submits it
 * to the migration contract, and — crucially — reconciles against the stored
 * receipt when a submit fails:
 *
 *  - **success**: the operation's receipt exists and matches this run's intent.
 *    The write already landed (this run or a prior one), so a failed submit is
 *    reported as success and the queue advances. This is what makes a re-run
 *    idempotent.
 *  - **recoverable**: the receipt is absent, or could not be read. The original
 *    failure is preserved, so the queue fails and the checkpoint freezes; a
 *    later run retries safely.
 *  - **mismatch**: the receipt exists but commits to a *different* intent. The
 *    destination already imported a conflicting value for this operation, which
 *    no re-run can reconcile. This is a hard failure that aborts the run.
 *
 * There are no broad automatic retries here: a submit is tried once, and the
 * receipt decides what its failure means. Restarting from the prior checkpoint
 * is always safe because every replayed mutation is idempotent.
 */
import { Contract, StatusCode } from '@hyperledger/fabric-gateway';
import { PublicHistoryRecord, PrivateHistoryRecord } from '../../types';
import { ReplayError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import {
  DestinationIntent,
  FN_GET_PLAN,
  FN_GET_RECEIPT,
  FN_IMPORT_HISTORY,
  FN_IMPORT_HISTORY_BATCH,
  FN_INITIALIZE,
  HISTORY_ENTRY_TRANSIENT,
  HistoryBatchEntry,
  KIND_PRIVATE_DELETE,
  KIND_PRIVATE_WRITE,
  KIND_PUBLIC_DELETE,
  KIND_PUBLIC_WRITE,
  PUBLIC_HISTORY_BATCH_TRANSIENT,
  SourceIdentity,
  frameHistoryBatch,
  frameHistoryEnvelope,
  intentDigest,
  operationId,
  parsePlan,
  parseReceipt,
} from './protocol';
import { ResilientHistoryContext } from './config';

const logger = createLogger('resilient-history-replayer');

/** Transaction validation code names, by code. See chaincode-adapter. */
const STATUS_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(StatusCode).map(([name, code]) => [code, name]),
);

type HistoryRecord = PublicHistoryRecord | PrivateHistoryRecord;

/** A history mutation the adapter hands the driver to submit. */
export interface HistorySubmission {
  record: HistoryRecord;
  /** Destination collection for private data; `undefined` for public. */
  destCollection?: string;
  /** Exact value bytes to write, after metadata embedding. Empty for a delete. */
  value: Buffer;
  isDelete: boolean;
}

/**
 * A conflicting receipt: the destination committed a different intent for an
 * operation this run is replaying. Extends `ReplayError` so it surfaces as a
 * refusal message and aborts the run rather than failing one key.
 */
/** A stored plan or receipt conflicts with the run being attempted. */
export class HistoryImportConflictError extends ReplayError {}

/** A receipt exists for the source operation but binds a different intent. */
export class HistoryImportMismatchError extends HistoryImportConflictError {
  constructor(scope: string, chaincode: string, key: string, opIdHex: string, stored: Buffer, intended: Buffer) {
    super(
      `Resilient history import found a conflicting receipt under scope ` +
      `${scope} for ${chaincode} key ${key} (operation ${opIdHex}): the ` +
      `destination recorded intent ${stored.toString('hex')}, but this run ` +
      `intends ${intended.toString('hex')}. A different value was already ` +
      'imported for this operation, so re-running cannot reconcile it. ' +
      'Investigate the divergence before retrying — this run is aborting.',
    );
    this.name = 'HistoryImportMismatchError';
  }
}


/** A scope is already bound to a different exact replay plan. */
export class HistoryImportPlanMismatchError extends HistoryImportConflictError {
  constructor(scope: string, stored: string, intended: string) {
    super(
      `Resilient history import scope ${scope} is already bound to plan ` +
      `${stored}, but this run requires ${intended}. Restore the original ` +
      'history files, routing, metadata setting and HMAC key, or use a fresh ' +
      'empty destination and scope for a genuinely different migration.',
    );
    this.name = 'HistoryImportPlanMismatchError';
  }
}
/** One operation to reconcile: its ID, its intended commitment, and where. */
interface ReconcileOp {
  opId: Buffer;
  opIdHex: string;
  intent: Buffer;
  key: string;
  chaincode: string;
}

export interface ResilientHistoryReplayerOptions {
  context: ResilientHistoryContext;
  /** Plan digest for this run, lowercase hex. */
  planDigest: string;
  /** Source network ID, from the manifest. Part of every operation ID. */
  sourceNetworkId: string;
  /** Destination channel these writes land on. Part of every intent. */
  destChannel: string;
}

export class ResilientHistoryReplayer {
  private readonly scope: string;
  private readonly key: Buffer;
  private readonly planDigest: string;
  private readonly sourceNetworkId: string;
  private readonly destChannel: string;
  /** Chaincodes whose plan has been initialized on this channel. */
  private readonly initialized = new Set<string>();

  constructor(opts: ResilientHistoryReplayerOptions) {
    this.scope = opts.context.scope;
    this.key = opts.context.key;
    this.planDigest = opts.planDigest;
    this.sourceNetworkId = opts.sourceNetworkId;
    this.destChannel = opts.destChannel;
  }

  /**
   * Submit one history mutation through `ImportHistory`.
   *
   * @throws HistoryImportMismatchError on a conflicting receipt (aborts the run).
   * @throws ReplayError on a preserved failure (fails the key's queue).
   */
  async submitEntry(contract: Contract, submission: HistorySubmission): Promise<void> {
    const { record, destCollection, value, isDelete } = submission;
    const chaincode = record.chaincode;
    await this.ensureInitialized(contract, chaincode);

    const opId = operationId(this.key, this.sourceIdentity(record));
    const intent = intentDigest(
      this.key, this.destIntent(record, destCollection, value, isDelete),
    );
    const kind = kindFor(destCollection !== undefined, isDelete);
    const envelope = frameHistoryEnvelope(
      kind, destCollection ?? '', record.key, value,
    );

    try {
      await this.submit(
        contract, FN_IMPORT_HISTORY,
        [this.scope, this.planDigest, opId.toString('hex'), intent.toString('hex')],
        { [HISTORY_ENTRY_TRANSIENT]: envelope },
      );
    } catch (err) {
      const outcome = await this.reconcile(contract, [{
        opId, opIdHex: opId.toString('hex'), intent, key: record.key, chaincode,
      }]);
      if (outcome === 'success') return;
      throw new ReplayError(
        `Failed to replay ${destCollection === undefined ? 'public' : 'private'} ` +
        `history for key ${record.key} block ${record.blockNumber} to ` +
        `${chaincode} under scope ${this.scope}`,
        err as Error,
      );
    }
  }

  /**
   * Submit a batch of public-history mutations through `ImportHistoryBatch`.
   *
   * @param entries One per distinct key, each a single version for this round.
   * @throws HistoryImportMismatchError on any conflicting receipt (aborts).
   * @throws ReplayError on a preserved failure (fails every key's queue).
   */
  async submitPublicBatch(
    contract: Contract,
    chaincode: string,
    entries: Array<{ record: PublicHistoryRecord; value: Buffer; isDelete: boolean }>,
  ): Promise<void> {
    await this.ensureInitialized(contract, chaincode);

    const framed: HistoryBatchEntry[] = entries.map((entry) => {
      const opId = operationId(this.key, this.sourceIdentity(entry.record));
      const intent = intentDigest(
        this.key, this.destIntent(entry.record, undefined, entry.value, entry.isDelete),
      );
      return {
        operationId: opId,
        intent,
        key: entry.record.key,
        value: entry.value,
        isDelete: entry.isDelete,
      };
    });

    try {
      await this.submit(
        contract, FN_IMPORT_HISTORY_BATCH, [this.scope, this.planDigest],
        { [PUBLIC_HISTORY_BATCH_TRANSIENT]: frameHistoryBatch(framed) },
      );
    } catch (err) {
      const ops: ReconcileOp[] = framed.map((f) => ({
        opId: f.operationId,
        opIdHex: f.operationId.toString('hex'),
        intent: f.intent,
        key: f.key,
        chaincode,
      }));
      const outcome = await this.reconcile(contract, ops);
      if (outcome === 'success') return;
      throw new ReplayError(
        `Failed to submit a resilient history batch of ${entries.length} ` +
        `public writes to ${chaincode} under scope ${this.scope}`,
        err as Error,
      );
    }
  }

  /**
   * Initialize the scope's plan on a chaincode, once per run.
   *
   * The contract accepts a matching plan as a no-op and refuses a different one,
   * so a failure here is a hard refusal (aborting the run) rather than a
   * per-key failure: either the plan genuinely changed under a reused scope, or
   * the contract cannot serve the protocol. Re-running after the cause is fixed
   * is safe — initialization is idempotent.
   */
  private async ensureInitialized(contract: Contract, chaincode: string): Promise<void> {
    if (this.initialized.has(chaincode)) return;
    try {
      await this.submit(
        contract, FN_INITIALIZE, [this.scope, this.planDigest], undefined,
      );
    } catch (err) {
      let stored: string | null = null;
      try {
        stored = parsePlan(await contract.evaluateTransaction(
          FN_GET_PLAN, this.scope,
        ));
      } catch {
        // The original initialization failure remains the actionable error.
      }
      if (stored === this.planDigest) {
        this.initialized.add(chaincode);
        return;
      }
      if (stored !== null) {
        throw new HistoryImportPlanMismatchError(
          this.scope, stored, this.planDigest,
        );
      }
      throw new ReplayError(
        `Failed to initialize resilient history import for ${chaincode} under ` +
        `scope ${this.scope}. The destination did not confirm the requested ` +
        'plan after the submit failed. Fix the connection or contract error ' +
        'and re-run with the same scope and key.',
        err as Error,
      );
    }
    this.initialized.add(chaincode);
    logger.debug({ chaincode, scope: this.scope }, 'History import plan initialized');
  }

  /**
   * Read the receipt for each operation and decide what a submit failure means.
   *
   * @returns `'success'` when every receipt exists and matches; `'recoverable'`
   *   when any is absent or unreadable.
   * @throws HistoryImportMismatchError when any receipt commits to a different
   *   intent. A mismatch is definitive and takes precedence over a recoverable
   *   gap.
   */
  private async reconcile(
    contract: Contract,
    ops: ReconcileOp[],
  ): Promise<'success' | 'recoverable'> {
    let recoverable = false;

    for (const op of ops) {
      let answer: Uint8Array;
      try {
        answer = await contract.evaluateTransaction(
          FN_GET_RECEIPT, this.scope, op.opIdHex,
        );
      } catch {
        recoverable = true;
        continue;
      }

      const receipt = parseReceipt(answer);
      if (receipt === null) {
        recoverable = true;
        continue;
      }
      if (!receipt.equals(op.intent)) {
        throw new HistoryImportMismatchError(
          this.scope, op.chaincode, op.key, op.opIdHex, receipt, op.intent,
        );
      }
    }

    return recoverable ? 'recoverable' : 'success';
  }

  /** Endorse, submit, and confirm one transaction committed. */
  private async submit(
    contract: Contract,
    functionName: string,
    args: string[],
    transientData: Record<string, Uint8Array> | undefined,
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

  private sourceIdentity(record: HistoryRecord): SourceIdentity {
    return {
      sourceNetworkId: this.sourceNetworkId,
      sourceChannel: record.channel,
      blockNumber: record.blockNumber,
      txIndex: record.txIndex,
      txId: record.txId,
      chaincode: record.chaincode,
      collection: 'collection' in record ? record.collection : '',
      key: record.key,
    };
  }

  private destIntent(
    record: HistoryRecord,
    destCollection: string | undefined,
    value: Buffer,
    isDelete: boolean,
  ): DestinationIntent {
    return {
      destChannel: this.destChannel,
      chaincode: record.chaincode,
      collection: destCollection ?? '',
      key: record.key,
      isDelete,
      value,
    };
  }
}

/** Envelope kind for a mutation, by publicness and delete flag. */
function kindFor(isPrivate: boolean, isDelete: boolean): number {
  if (isPrivate) return isDelete ? KIND_PRIVATE_DELETE : KIND_PRIVATE_WRITE;
  return isDelete ? KIND_PUBLIC_DELETE : KIND_PUBLIC_WRITE;
}
