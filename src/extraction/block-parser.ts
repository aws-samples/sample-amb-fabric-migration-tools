// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  FabricIdentity,
  PublicHistoryRecord,
  BlockMetadataRecord,
  PrivateHashRecord,
} from '../types';
import { parseCreator } from '../utils/cert-parser';
import { ExtractionError } from '../utils/errors';
import { EncodedValue, encodeLedgerValue } from '../utils/value-codec';

/** Fabric's TxValidationCode for a committed, valid transaction. */
export const TX_VALID = 0;

/**
 * Parsed representation of a single valid transaction from a block.
 */
export interface ParsedTransaction {
  txId: string;
  txIndex: number;
  timestamp: string;
  chaincodeId: string;
  creator: FabricIdentity;
  writes: Array<EncodedValue & {
    namespace: string;
    key: string;
    isDelete: boolean;
  }>;
  privateDataHashes: Array<{
    namespace: string;
    collection: string;
    key: string;
    hash: string;
  }>;
}

/**
 * Parsed representation of a Fabric block.
 */
export interface ParsedBlock {
  blockNumber: number;
  dataHash: string;
  previousHash: string;
  transactions: ParsedTransaction[];
}

/**
 * Parses Fabric block structures into typed extraction records.
 *
 * Block path reference:
 *   block.data.data[i].payload.header.channel_header → {tx_id, timestamp}
 *   block.data.data[i].payload.header.signature_header.creator → {mspid, id_bytes (cert)}
 *   block.data.data[i].payload.data.actions[j].payload.action.proposal_response_payload
 *     .extension.results.ns_rwset[k].rwset.writes → [{key, value, is_delete}]
 *   block.metadata.metadata[2][i] → tx validation code (0 = valid)
 */
export class BlockParser {
  /**
   * Parse a decoded block object (JSON structure from Fabric SDK / event listener).
   */
  parseBlock(block: any): ParsedBlock {
    const blockNumber = Number(block.header?.number ?? 0);
    const dataHash = block.header?.data_hash ?? '';
    const previousHash = block.header?.previous_hash ?? '';
    const transactions: ParsedTransaction[] = [];

    const txDataArray = block.data?.data ?? [];
    const validationCodes = blockValidationCodes(block, blockNumber);

    for (let txIndex = 0; txIndex < txDataArray.length; txIndex++) {
      if (validationCodes[txIndex] !== TX_VALID) {
        continue;
      }

      // A committed transaction whose writes cannot be read cannot be skipped:
      // the reconstructed state would silently lack them.
      const txData = txDataArray[txIndex];
      if (txData?.decodeError !== undefined) {
        throw unreadableTransaction(blockNumber, txIndex, 'decode', txData.decodeError);
      }

      let tx: ParsedTransaction | null;
      try {
        tx = this.parseTransaction(txData, blockNumber, txIndex);
      } catch (err) {
        throw unreadableTransaction(blockNumber, txIndex, 'parse', (err as Error).message);
      }
      if (tx) {
        transactions.push(tx);
      }
    }

    return { blockNumber, dataHash, previousHash, transactions };
  }

  private parseTransaction(txData: any, blockNumber: number, txIndex: number): ParsedTransaction | null {
    const payload = txData?.payload;
    if (!payload) return null;

    const channelHeader = payload.header?.channel_header;
    const signatureHeader = payload.header?.signature_header;

    if (!channelHeader) return null;

    const txId = channelHeader.tx_id ?? '';
    const timestamp = channelHeader.timestamp ?? '';

    // Parse creator identity from signature header
    const creator = this.parseCreator(signatureHeader?.creator);

    // Parse write sets from actions
    const actions = payload.data?.actions ?? [];
    const writes: ParsedTransaction['writes'] = [];
    const privateDataHashes: ParsedTransaction['privateDataHashes'] = [];
    let chaincodeId = '';

    for (const action of actions) {
      const chaincodeSpec =
        action?.payload?.chaincode_proposal_payload?.input?.chaincode_spec;
      const actionChaincodeId = chaincodeSpec?.chaincode_id?.name ?? '';

      if (actionChaincodeId) {
        chaincodeId = actionChaincodeId;
      }

      const extension =
        action?.payload?.action?.proposal_response_payload?.extension;
      const nsRwSets = extension?.results?.ns_rwset ?? [];

      for (const nsRwSet of nsRwSets) {
        const namespace = nsRwSet.namespace;

        // Skip lifecycle system chaincodes
        if (namespace === 'lscc' || namespace === '_lifecycle') {
          continue;
        }

        // Public writes
        const rwWrites = nsRwSet.rwset?.writes ?? [];
        for (const w of rwWrites) {
          writes.push({
            namespace,
            key: w.key ?? '',
            ...encodeLedgerValue(w.value),
            isDelete: w.is_delete ?? false,
          });
        }

        // Private data hash writes (collection_hashed_rwset)
        const collHashRwSets = nsRwSet.collection_hashed_rwset ?? [];
        for (const collSet of collHashRwSets) {
          const collName = collSet.collection_name ?? '';
          const hashedWrites = collSet.hashed_rwset?.hashed_writes ?? [];
          for (const hw of hashedWrites) {
            privateDataHashes.push({
              namespace,
              collection: collName,
              key: hw.key_hash ? Buffer.from(hw.key_hash).toString('hex') : '',
              hash: hw.value_hash ? Buffer.from(hw.value_hash).toString('hex') : '',
            });
          }
        }
      }
    }

    // Skip config transactions (no chaincode ID, no writes)
    if (!chaincodeId && writes.length === 0) {
      return null;
    }

    return { txId, txIndex, timestamp, chaincodeId, creator, writes, privateDataHashes };
  }

  private parseCreator(creatorObj: any): FabricIdentity {
    return parseCreator(creatorObj);
  }

  /**
   * Convert a parsed block into extraction records.
   */
  toHistoryRecords(parsed: ParsedBlock, channel: string): PublicHistoryRecord[] {
    const records: PublicHistoryRecord[] = [];

    for (const tx of parsed.transactions) {
      for (const write of tx.writes) {
        records.push({
          _type: 'public_history',
          channel,
          chaincode: write.namespace,
          key: write.key,
          value: write.value,
          valueEncoding: write.valueEncoding,
          txId: tx.txId,
          txIndex: tx.txIndex,
          blockNumber: parsed.blockNumber,
          timestamp: tx.timestamp,
          isDelete: write.isDelete,
          creator: tx.creator,
        });
      }
    }

    return records;
  }

  /**
   * Convert a parsed block into metadata records (Tier 2).
   */
  toMetadataRecords(parsed: ParsedBlock, channel: string): BlockMetadataRecord[] {
    return parsed.transactions.map((tx) => ({
      _type: 'block_metadata' as const,
      channel,
      blockNumber: parsed.blockNumber,
      txId: tx.txId,
      txIndex: tx.txIndex,
      timestamp: tx.timestamp,
      chaincodeId: tx.chaincodeId,
      keysWritten: tx.writes.filter((w) => !w.isDelete).map((w) => w.key),
      keysDeleted: tx.writes.filter((w) => w.isDelete).map((w) => w.key),
      creator: tx.creator,
    }));
  }

  /**
   * Extract private data hash records from block.
   */
  toPrivateHashRecords(parsed: ParsedBlock, channel: string): PrivateHashRecord[] {
    const records: PrivateHashRecord[] = [];

    for (const tx of parsed.transactions) {
      for (const ph of tx.privateDataHashes) {
        records.push({
          _type: 'private_hash',
          channel,
          chaincode: ph.namespace,
          collection: ph.collection,
          key: ph.key,
          hash: ph.hash,
          blockNumber: parsed.blockNumber,
          txId: tx.txId,
          txIndex: tx.txIndex,
        });
      }
    }

    return records;
  }
}

/**
 * The error for a committed transaction the walk cannot read.
 *
 * @param stage Whether the envelope failed protobuf decoding or record parsing.
 * @param cause The underlying error message.
 */
function unreadableTransaction(
  blockNumber: number,
  txIndex: number,
  stage: 'decode' | 'parse',
  cause: string,
): ExtractionError {
  return new ExtractionError(
    `Block ${blockNumber}, transaction ${txIndex}: the peer marked it valid, ` +
      `but it could not be ${stage === 'decode' ? 'decoded' : 'parsed'} ` +
      `(${cause}). Its writes are part of the source ledger, so extraction stops ` +
      'rather than leave them out. Capture the block with "capture-fixtures" ' +
      'for diagnosis.',
  );
}

/**
 * Validation code per transaction, indexed by position in `block.data.data`.
 *
 * metadata[2] is the TRANSACTIONS_FILTER — a byte array where index i
 * corresponds to data.data[i]. Value 0 = VALID.
 *
 * Fails closed: a block with transactions but no usable filter aborts
 * extraction. Admitting every transaction as valid would replay writes
 * that never committed on the source ledger.
 *
 * Shared with the private-data delivery path, which reads the same filter to
 * decide whether a transaction's private writes ever committed.
 *
 * @param block Decoded block.
 * @param blockNumber Block number, for the error message.
 * @throws ExtractionError if the filter is missing, unrecognised, or short.
 */
export function blockValidationCodes(block: any, blockNumber: number): number[] {
  const txCount = (block?.data?.data ?? []).length;
  if (txCount === 0) return [];

  const codes = toValidationCodeArray(block.metadata?.metadata?.[2]);
  if (codes === null || codes.length < txCount) {
    const found = codes === null ? 'an unrecognised value' : `${codes.length} code(s)`;
    throw new ExtractionError(
      `Block ${blockNumber} has ${txCount} transaction(s) but its ` +
        `TRANSACTIONS_FILTER holds ${found}. Refusing to extract: without the ` +
        'filter, transactions that failed validation cannot be told apart from ' +
        'committed ones and would be replayed as real writes. Re-run "discover" ' +
        'to confirm the Fabric version, and capture the block with ' +
        '"capture-fixtures" for diagnosis.',
    );
  }

  return codes;
}

/**
 * Normalise a TRANSACTIONS_FILTER into validation codes.
 *
 * @param txFilter Raw metadata[2] in any shape a decoder may produce.
 * @returns The codes, or `null` if the shape is not recognised.
 */
function toValidationCodeArray(txFilter: unknown): number[] | null {
  if (txFilter === null || txFilter === undefined) return null;
  if (Array.isArray(txFilter)) return txFilter;
  if (Buffer.isBuffer(txFilter)) return Array.from(txFilter);
  if (txFilter instanceof Uint8Array) return Array.from(txFilter);
  return null;
}
