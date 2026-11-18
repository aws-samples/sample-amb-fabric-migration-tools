// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import {
  MigrationTier,
  ChannelInfo,
  FabricIdentity,
  PrivateStateRecord,
  PrivateHistoryRecord,
} from '../../types';
import { parseCreator } from '../../utils/cert-parser';
import { TX_VALID, blockValidationCodes } from '../block-parser';
import { ExtractionError } from '../../utils/errors';
import { PrivateDataBlockCallback } from '../../discovery/chaincode-discoverer';
import { NdjsonWriter } from '../../output/ndjson-writer';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { createLogger } from '../../utils/logger';
import { EncodedValue, encodeLedgerValue } from '../../utils/value-codec';
import { NdjsonReader } from '../../replay/ndjson-reader';
import { STAGED_SUFFIX, stagedPath } from '../extension';
import { keyChargeBytes } from '../state-accumulator';
import * as crypto from 'crypto';
import * as fs from 'fs';

const logger = createLogger('private-data-delivery');

/**
 * A single private data write from a delivered block.
 */
interface PrivateWrite extends EncodedValue {
  chaincode: string;
  collection: string;
  key: string;
  isDelete: boolean;
  txId: string;
  blockNumber: number;
  txIndex: number;
  timestamp: string;
  creator?: FabricIdentity;
}

/**
 * A private write the block records by hash, with no value delivered for it:
 * the peer does not hold that transaction's private data.
 */
interface UnresolvedWrite {
  chaincode: string;
  collection: string;
  /** SHA-256 of the key, hex, as the block carries it. */
  keyHash: string;
  isDelete: boolean;
  txIndex: number;
}

/**
 * Extracts private data by replaying blocks delivered via the peer's
 * DeliverWithPrivateData gRPC endpoint.
 *
 * The peer includes actual private data values for collections the connected
 * org is authorized to see. For unauthorized collections, only hashes are
 * available (extracted separately from the block's hashed rwsets by BlockWalker).
 *
 * This extractor:
 * - Re-walks every delivered block from genesis to ledger height
 * - Discards partial private state/history from any prior attempt first
 * - Accumulates current private state (latest value per namespace+collection+key)
 * - Emits PrivateStateRecord for each live key (Tier 1+)
 * - Emits PrivateHistoryRecord for each write (Tier 3)
 *
 * Current private state cannot resume from a block checkpoint: its accumulator
 * exists only in this process and is emitted after the walk. Starting after a
 * checkpoint would therefore omit every live key last written before it. A
 * retry instead re-derives both private state and private history from block 0.
 *
 * No helper chaincode deployment is required — the peer already has the data.
 */
export class PrivateDataDeliveryExtractor {
  /** Estimated bytes of current private state this pass holds right now. */
  private held = 0;
  /** Set by `cancel`: the next delivered block stops the pass with it. */
  private cancelled?: Error;

  constructor(
    private readonly deliverFn: (
      channelId: string,
      startBlock: number,
      endBlock: number,
      onBlock: PrivateDataBlockCallback,
    ) => Promise<void>,
    private readonly writer: NdjsonWriter,
    private readonly layout: FileLayoutManager,
    private readonly tier: MigrationTier,
  ) {}

  /**
   * Estimated bytes of current private state held in memory, 0 once written out.
   *
   * Read by the public walk's state accumulator while both passes run, so that
   * the two together stay inside `--memory-limit` (see `extractChannel` in
   * hybrid-extractor.ts).
   */
  heldBytes(): number {
    return this.held;
  }

  /**
   * Stop a running pass at its next block, failing it with `reason`.
   *
   * For the public walk running beside it: a walk that fails cannot produce a
   * complete extraction, so delivering the rest of the ledger would only delay
   * the error. Nothing is lost by stopping, since a rerun re-derives private
   * state from block 0 anyway.
   */
  cancel(reason: Error): void {
    this.cancelled ??= reason;
  }

  /**
   * @param fromBlock `extract --extend`: deliver only from this block (the
   *   earlier extraction's height), seeding current state from the state files
   *   already there. History is then appended to, and the new state goes to the
   *   staged siblings of the state files, renamed over them at commit.
   */
  async extract(channel: ChannelInfo, fromBlock?: number): Promise<PrivateDataDeliverySummary> {
    const channelId = channel.channelId;
    const extending = fromBlock !== undefined;
    const startBlock = fromBlock ?? 0;
    const endBlock = channel.ledgerHeight - 1;
    const stateOut = (rel: string): string => (extending ? stagedPath(rel) : rel);

    // State is emitted only after delivery finishes, and history is append-only.
    // A retry must therefore discard both products before re-deriving them from
    // genesis. The public block walk's private-hash files are separate and stay.
    // An extension discards only its own staged state: the history it appends
    // to is cut back by the extension journal if a run is interrupted.
    const discard = extending
      ? this.layout.listPrivateFiles(channelId, '-state.ndjson' + STAGED_SUFFIX)
      : [...this.layout.listPrivateFiles(channelId, '-state.ndjson'), ...this.layout.listPrivateFiles(channelId, '-history.ndjson')];
    for (const file of discard) {
      await this.writer.truncate(path.join(this.layout.channelDir(channelId), file));
    }

    logger.info(
      { channelId, startBlock, endBlock, tier: this.tier },
      'Starting private data extraction via DeliverWithPrivateData',
    );

    // Accumulate current private state: compositeKey → record. `byHash` finds
    // a held key from the key hash a block records, for writes whose value the
    // peer did not deliver.
    const currentState = new Map<string, PrivateStateRecord>();
    const byHash = new Map<string, string>();
    const hashKey = (chaincode: string, collection: string, keyHash: string): string =>
      `${chaincode}\0${collection}\0${keyHash}`;
    const indexOf = (r: PrivateStateRecord): string => hashKey(r.chaincode, r.collection, sha256Hex(r.key));
    const collectionsWithData = new Set<string>();
    /** chaincode:collection → keys whose latest write's value the peer does not hold, and the blocks they span. */
    const missing = new Map<string, { writes: number; dropped: number; firstBlock: number; lastBlock: number }>();
    let processedBlocks = 0;
    this.held = 0;
    const set = (compositeKey: string, record: PrivateStateRecord): void => {
      const previous = currentState.get(compositeKey);
      if (previous) this.held -= recordCharge(compositeKey, previous);
      else {
        const index = indexOf(record);
        byHash.set(index, compositeKey);
        this.held += keyChargeBytes(Buffer.byteLength(index, 'utf-8'));
      }
      currentState.set(compositeKey, record);
      this.held += recordCharge(compositeKey, record);
    };
    const remove = (compositeKey: string): void => {
      const previous = currentState.get(compositeKey);
      if (!previous) return;
      this.held -= recordCharge(compositeKey, previous);
      currentState.delete(compositeKey);
      const index = indexOf(previous);
      byHash.delete(index);
      this.held -= keyChargeBytes(Buffer.byteLength(index, 'utf-8'));
    };
    /**
     * A write the block records by hash alone. Its key's current value is no
     * longer the one held, so the key is dropped rather than left with its
     * previous value: current state must never hold a value the source ledger
     * has since replaced. A delete needs no value and is applied as such.
     */
    const blockToLive = new Map<string, number>();
    for (const cc of channel.chaincodes) for (const c of cc.collections) blockToLive.set(`${cc.name}:${c.name}`, c.blockToLive);
    const unresolved = (w: UnresolvedWrite, blockNumber: number): void => {
      const compositeKey = byHash.get(hashKey(w.chaincode, w.collection, w.keyHash));
      if (compositeKey) remove(compositeKey);
      if (w.isDelete) return;
      // Expired by blockToLive, as validate's expected-purged rule has it: the
      // source purged the key too, so it is not data the peer lacks.
      const btl = blockToLive.get(`${w.chaincode}:${w.collection}`) ?? 0;
      if (btl > 0 && blockNumber < channel.ledgerHeight - btl) return;
      const id = `${w.chaincode}:${w.collection}`;
      const m = missing.get(id) ?? { writes: 0, dropped: 0, firstBlock: blockNumber, lastBlock: blockNumber };
      m.writes++;
      if (compositeKey) m.dropped++;
      m.lastBlock = blockNumber;
      missing.set(id, m);
    };

    if (extending) {
      const reader = new NdjsonReader();
      for (const file of this.layout.listPrivateFiles(channelId, '-state.ndjson')) {
        const full = path.join(this.writer.getBaseDir(), this.layout.channelDir(channelId), file);
        if (!fs.existsSync(full)) continue;
        for await (const rec of reader.stream(full)) {
          const r = rec as PrivateStateRecord;
          set(`${r.chaincode}\0${r.collection}\0${r.key}`, r);
          collectionsWithData.add(`${r.chaincode}:${r.collection}`);
        }
      }
      logger.info({ channelId, fromBlock, seededKeys: currentState.size }, 'Seeded private state from the extraction being extended');
    }

    await this.deliverFn(channelId, startBlock, endBlock, async (blockNumber, block, privateDataMap) => {
      if (this.cancelled) {
        throw new ExtractionError(
          `Private data delivery for ${channelId} stopped at block ${blockNumber}: the public walk failed`,
          this.cancelled,
        );
      }

      // Extract tx metadata (txId, timestamp) directly from the block's channel
      // headers. We index by tx position within the block, which is the same key
      // used in the privateDataMap.
      const txMetadata = this.extractTxMetadata(block);

      // Process private data for each transaction in this block, and the
      // writes it records by hash whose values were not delivered, in
      // transaction order.
      const writes = this.extractPrivateWrites(blockNumber, block, privateDataMap, txMetadata);
      const gaps = this.unresolvedWrites(blockNumber, block, writes);
      const events: Array<{ txIndex: number; write?: PrivateWrite; gap?: UnresolvedWrite }> = [
        ...writes.map((write) => ({ txIndex: write.txIndex, write })),
        ...gaps.map((gap) => ({ txIndex: gap.txIndex, gap })),
      ].sort((a, b) => a.txIndex - b.txIndex);

      for (const { write, gap } of events) {
        if (gap) {
          unresolved(gap, blockNumber);
          continue;
        }
        if (!write) continue;
        const compositeKey = `${write.chaincode}\0${write.collection}\0${write.key}`;

        // Update current state accumulator
        if (write.isDelete) {
          remove(compositeKey);
        } else {
          set(compositeKey, {
            _type: 'private_state',
            channel: channelId,
            chaincode: write.chaincode,
            collection: write.collection,
            key: write.key,
            value: write.value,
            valueEncoding: write.valueEncoding,
            creator: write.creator,
          });
          collectionsWithData.add(`${write.chaincode}:${write.collection}`);
        }

        // Tier 3: emit history record for each write
        if (this.tier >= MigrationTier.FullHistory) {
          const historyRecord: PrivateHistoryRecord = {
            _type: 'private_history',
            channel: channelId,
            chaincode: write.chaincode,
            collection: write.collection,
            key: write.key,
            value: write.isDelete ? '' : write.value,
            valueEncoding: write.isDelete ? undefined : write.valueEncoding,
            txId: write.txId,
            blockNumber: write.blockNumber,
            txIndex: write.txIndex,
            timestamp: write.timestamp,
            isDelete: write.isDelete,
            creator: write.creator,
          };
          await this.writer.write(
            this.layout.privateHistoryPath(
              channelId, write.chaincode, write.collection,
            ),
            historyRecord,
          );
        }
      }

      processedBlocks++;

      if (processedBlocks % 500 === 0) {
        logger.info(
          { channelId, blockNumber, processedBlocks, currentStateKeys: currentState.size },
          'Private data delivery progress',
        );
      }
    });

    // Write current state records
    for (const record of currentState.values()) {
      await this.writer.write(
        stateOut(this.layout.privateStatePath(
          channelId, record.chaincode, record.collection,
        )),
        record,
      );
    }
    const liveKeys = currentState.size;
    currentState.clear();
    byHash.clear();
    this.held = 0;

    // Only collections the peer delivered values for: one it never held is not
    // this org's to read, and its coverage report says so.
    for (const id of [...missing.keys()]) if (!collectionsWithData.has(id)) missing.delete(id);
    if (missing.size > 0) {
      logger.warn(
        { channelId, collections: Object.fromEntries(missing) },
        'The peer does not hold the private values of some writes its blocks record by hash. Keys whose latest ' +
          'write is one of them are left out of current state rather than given an earlier value; validate reports ' +
          'them. Another member of the collection may hold them: extract it too and merge.',
      );
    }

    // Which declared collections had data vs. none. Synthesized implicit
    // collections are left out: one exists for every org on every chaincode
    // whether or not it was ever written to, so "declared but nothing delivered"
    // says nothing about it. Whether one held data is settled by the coverage
    // report, which reads the hash files the block walk wrote.
    const allCollections = new Set<string>();
    for (const cc of channel.chaincodes) {
      for (const coll of cc.collections) {
        if (coll.implicit) continue;
        allCollections.add(`${cc.name}:${coll.name}`);
      }
    }
    const collectionsHashOnly = [...allCollections].filter((c) => !collectionsWithData.has(c));

    const summary: PrivateDataDeliverySummary = {
      processedBlocks,
      currentStateKeys: liveKeys,
      collectionsWithData: [...collectionsWithData],
      collectionsHashOnly,
      valuesMissing: Object.fromEntries(missing),
    };

    logger.info(
      {
        channelId,
        ...summary,
      },
      'Private data delivery extraction complete',
    );

    if (collectionsHashOnly.length > 0) {
      logger.warn(
        {
          channelId,
          collections: collectionsHashOnly,
        },
        'Some collections had no private data values — the connected org may not be ' +
          'a member of these collection policies, or the data may have been purged ' +
          '(blockToLive exceeded). Only hashes are available for these collections.',
      );
    }

    return summary;
  }

  /**
   * Extract private writes from a delivered block's private data map.
   *
   * The privateDataMap is keyed by tx sequence index within the block.
   * Each entry is a TxPvtReadWriteSet decoded by fabric-common's BlockDecoder:
   *   { ns_pvt_rwset: [{ namespace, collection_pvt_rwset: [{ collection_name, rwset }] }] }
   *
   * Transactions that failed validation are skipped, matching the public path:
   * the peer stores private data at endorsement time, before validation, so a
   * transaction rejected at commit can still have a payload here — and its
   * writes never reached the source ledger's state.
   *
   * The codes are read only when the block carries private data, so a block
   * with nothing to filter cannot abort the extraction.
   *
   * @param blockNumber Block being processed.
   * @param block Decoded block, for its TRANSACTIONS_FILTER.
   * @param privateDataMap Private read-write sets keyed by tx index.
   * @param txMetadata Per-tx txId, timestamp and creator.
   */
  private extractPrivateWrites(
    blockNumber: number,
    block: any,
    privateDataMap: Record<string, any>,
    txMetadata: Map<number, { txId: string; timestamp: string; creator?: FabricIdentity }>,
  ): PrivateWrite[] {
    const writes: PrivateWrite[] = [];
    const txEntries = Object.entries(privateDataMap);
    if (txEntries.length === 0) return writes;

    const validationCodes = blockValidationCodes(block, blockNumber);

    for (const [txIndexStr, txPvtRwSet] of txEntries) {
      const txIndex = Number(txIndexStr);
      if (validationCodes[txIndex] !== TX_VALID) {
        logger.warn(
          { blockNumber, txIndex, validationCode: validationCodes[txIndex] },
          'Discarding private data from a transaction that did not commit — its ' +
            'writes are absent from the source ledger, so replaying them would ' +
            'create state the source never had',
        );
        continue;
      }

      const meta = txMetadata.get(txIndex) ?? { txId: '', timestamp: '' };
      const nsPvtRwSets = txPvtRwSet?.ns_pvt_rwset ?? [];

      for (const nsRwSet of nsPvtRwSets) {
        const namespace = nsRwSet.namespace ?? '';
        // Skip system chaincodes
        if (namespace === 'lscc' || namespace === '_lifecycle') continue;

        const collPvtRwSets = nsRwSet.collection_pvt_rwset ?? [];

        for (const collRwSet of collPvtRwSets) {
          const collName = collRwSet.collection_name ?? '';
          const rwset = collRwSet.rwset;
          const kvWrites = rwset?.writes ?? [];

          for (const w of kvWrites) {
            writes.push({
              chaincode: namespace,
              collection: collName,
              key: w.key ?? '',
              ...encodeLedgerValue(w.value),
              isDelete: w.is_delete ?? false,
              txId: meta.txId,
              blockNumber,
              txIndex,
              timestamp: meta.timestamp,
              creator: meta.creator,
            });
          }
        }
      }
    }

    return writes;
  }

  /**
   * The private writes of a block's valid transactions that the block records
   * by hash but for which no value was delivered.
   *
   * A delivered write covers the hashed write of the same transaction,
   * chaincode, collection and key hash. Everything else is a value the peer
   * does not hold: never delivered to it, purged from its transient store
   * before the block committed, or expired by `blockToLive`. Collections the
   * org is not a member of land here too, harmlessly: nothing of theirs is held.
   */
  private unresolvedWrites(blockNumber: number, block: any, delivered: PrivateWrite[]): UnresolvedWrite[] {
    const txs = block?.data?.data ?? [];
    if (txs.length === 0) return [];
    const covered = new Set(delivered.map((w) => `${w.txIndex}\0${w.chaincode}\0${w.collection}\0${sha256Hex(w.key)}`));
    const out: UnresolvedWrite[] = [];
    for (let txIndex = 0; txIndex < txs.length; txIndex++) {
      for (const action of txs[txIndex]?.payload?.data?.actions ?? []) {
        for (const ns of action?.payload?.action?.proposal_response_payload?.extension?.results?.ns_rwset ?? []) {
          const chaincode = ns.namespace ?? '';
          if (chaincode === 'lscc' || chaincode === '_lifecycle') continue;
          for (const coll of ns.collection_hashed_rwset ?? []) {
            const collection = coll.collection_name ?? '';
            for (const hw of coll.hashed_rwset?.hashed_writes ?? []) {
              if (!hw.key_hash) continue;
              const keyHash = Buffer.from(hw.key_hash).toString('hex');
              if (covered.has(`${txIndex}\0${chaincode}\0${collection}\0${keyHash}`)) continue;
              out.push({ chaincode, collection, keyHash, isDelete: hw.is_delete ?? false, txIndex });
            }
          }
        }
      }
    }
    // Read only when there is something to filter, as extractPrivateWrites does.
    if (out.length === 0) return out;
    const validationCodes = blockValidationCodes(block, blockNumber);
    return out.filter((w) => validationCodes[w.txIndex] === TX_VALID);
  }

  /**
   * Extract transaction metadata (txId, timestamp) from a block's envelope
   * headers, indexed by position in the block's data array.
   *
   * This extracts directly from channel headers rather than going through
   * BlockParser, because BlockParser filters out non-endorsement transactions
   * (config txs, etc.) which shifts the indices. The privateDataMap keys
   * correspond to the raw tx position in block.data.data[], so we need the
   * unfiltered list.
   */
  private extractTxMetadata(block: any): Map<number, { txId: string; timestamp: string; creator?: FabricIdentity }> {
    const metadata = new Map<number, { txId: string; timestamp: string; creator?: FabricIdentity }>();
    if (!block?.data?.data) return metadata;

    const txDataArray = block.data.data;
    for (let i = 0; i < txDataArray.length; i++) {
      const header = txDataArray[i]?.payload?.header;
      const channelHeader = header?.channel_header;
      if (channelHeader) {
        const entry: { txId: string; timestamp: string; creator?: FabricIdentity } = {
          txId: channelHeader.tx_id ?? '',
          timestamp: channelHeader.timestamp ?? '',
        };
        // Extract creator identity from the signature header
        const sigHeader = header?.signature_header;
        const creatorId = sigHeader?.creator;
        if (creatorId?.mspid) {
          entry.creator = parseCreator(creatorId);
        }
        metadata.set(i, entry);
      }
    }
    return metadata;
  }

}

/**
 * Bytes charged for one private state record held in the map.
 *
 * The state accumulator's accounting (`keyChargeBytes` plus the value), so the
 * two passes' memory can be compared against one `--memory-limit`. A floor, not
 * a measurement: each map entry holds a whole record object rather than the key
 * and value alone.
 */
function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function recordCharge(compositeKey: string, record: PrivateStateRecord): number {
  return keyChargeBytes(Buffer.byteLength(compositeKey, 'utf-8')) + Buffer.byteLength(record.value, 'utf-8');
}

export interface PrivateDataDeliverySummary {
  processedBlocks: number;
  currentStateKeys: number;
  /** Collections (as "chaincode:collection") that had private data values. */
  collectionsWithData: string[];
  /** Collections (as "chaincode:collection") where only hashes are available. */
  collectionsHashOnly: string[];
  /**
   * Collections (as "chaincode:collection") with writes recorded by hash whose
   * values the peer did not deliver: how many, how many keys that left out of
   * current state, and the blocks they span.
   */
  valuesMissing: Record<string, { writes: number; dropped: number; firstBlock: number; lastBlock: number }>;
}
