/**
 * Wire primitives for resilient, idempotent Tier 3 history replay.
 *
 * This is the client half of a protocol the destination migration contract
 * implements. Only *history* records travel through it; current-state replay is
 * untouched (`src/replay/adapters/chaincode-adapter.ts`). The protocol makes a
 * failed or interrupted history replay safe to re-run: every mutation carries a
 * deterministic operation ID and an intent commitment, and the contract records
 * a receipt per operation, so re-submitting a mutation that already landed is a
 * no-op rather than a duplicate history entry.
 *
 * Three commitments, all keyed by a secret the client never sends:
 *
 *  - The **operation ID** is an HMAC over the *immutable source identity* of a
 *    write — where in the source ledger it came from. It never depends on the
 *    destination value or any routing, so the same source write has the same
 *    operation ID across runs, retries, and destinations. It is what the
 *    contract keys a receipt by.
 *  - The **intent commitment** is a separately domain-separated HMAC over the
 *    exact *destination intent* — the channel, chaincode, collection, key,
 *    delete flag, and the exact value bytes that will be written (after any
 *    `embedSourceMetadata` merge). The contract stores it as the receipt, so a
 *    second run that resolves the same operation to a different destination
 *    value is caught as a mismatch rather than silently overwriting.
 *  - The **key commitment** binds the HMAC key into the plan digest without
 *    exposing it, so a scope reused with a different key is refused.
 *
 * The HMAC key is a client secret (`chaincode.historyImport.keyPath`). The
 * contract never sees it: it stores the 32-byte operation ID and 32-byte intent
 * the client computes, and cannot recompute either. Determinism across runs
 * therefore comes entirely from this file, so the canonical encoding here is the
 * single source of truth for it.
 *
 * Canonical encoding is length-delimited: every field is a big-endian uint32
 * byte length followed by that many bytes, and every integer is a length-
 * delimited 8-byte big-endian value. Length-delimiting every field makes the
 * concatenation unambiguous regardless of what bytes a key, value, or ID holds.
 */
import * as crypto from 'crypto';

/** Protocol identifier. Also the only accepted `historyImport.mode`. */
export const PROTOCOL_VERSION = 'idempotent-v1';

/** Namespace every domain-separation tag is built under. */
const PROTOCOL_NAMESPACE = 'fabric-amb-extractor/history-import';

/**
 * Domain-separation tags, each the first field fed into its HMAC/hash.
 *
 * Distinct tags keep three keyed digests that share one key from ever colliding:
 * an operation ID can never equal an intent commitment for the same inputs.
 */
const DOMAIN_OPERATION_ID = `${PROTOCOL_NAMESPACE}/${PROTOCOL_VERSION}/operation-id`;
const DOMAIN_INTENT = `${PROTOCOL_NAMESPACE}/${PROTOCOL_VERSION}/intent`;
const DOMAIN_KEY_COMMITMENT = `${PROTOCOL_NAMESPACE}/${PROTOCOL_VERSION}/key-commitment`;
export const DOMAIN_PLAN_DIGEST = `${PROTOCOL_NAMESPACE}/${PROTOCOL_VERSION}/plan-digest`;

// ── Contract functions ──

export const FN_INITIALIZE = 'InitializeHistoryImport';
export const FN_IMPORT_HISTORY = 'ImportHistory';
export const FN_IMPORT_HISTORY_BATCH = 'ImportHistoryBatch';
export const FN_GET_PLAN = 'GetHistoryImportPlan';
export const FN_GET_RECEIPT = 'GetHistoryImportReceipt';
export const FN_PROTOCOL = 'HistoryImportProtocol';

// ── Transient entry names ──

/** Single-mutation envelope for `ImportHistory`. */
export const HISTORY_ENTRY_TRANSIENT = 'history_entry';

/** Framed batch of public-history mutations for `ImportHistoryBatch`. */
export const PUBLIC_HISTORY_BATCH_TRANSIENT = 'public_history_batch';

// ── Envelope kinds ──

export const KIND_PUBLIC_WRITE = 0;
export const KIND_PUBLIC_DELETE = 1;
export const KIND_PRIVATE_WRITE = 2;
export const KIND_PRIVATE_DELETE = 3;

// ── Batch entry flags ──

const BATCH_ENTRY_WRITE = 0;
const BATCH_ENTRY_DELETE = 1;

// ── Sizes ──

/** Bytes in an operation ID (HMAC-SHA256 output). */
export const OP_ID_BYTES = 32;

/** Bytes in an intent commitment (HMAC-SHA256 output). */
export const INTENT_BYTES = 32;

/**
 * Fixed per-entry bytes a batch entry adds beyond the legacy state-batch
 * framing: the raw operation ID and intent that prefix each entry.
 *
 * The single-transaction batching in the chaincode adapter sizes rounds with
 * the legacy `framedBatchEntryBytes`; a resilient batch carries these extra
 * bytes per entry, so the adapter adds this to keep a framed batch under the
 * transaction size cap.
 */
export const RESILIENT_BATCH_ENTRY_OVERHEAD = OP_ID_BYTES + INTENT_BYTES;

/** Width of every length field and of the entry count. */
const LENGTH_BYTES = 4;

/** Width of the per-entry write/delete flag. */
const FLAG_BYTES = 1;

/**
 * Largest framed public-history batch a destination will accept.
 *
 * Matches the legacy `PutStateBatch` cap: a batch is one transaction, refused
 * whole if it exceeds the channel's `AbsoluteMaxBytes`, so it stays a fifth of
 * Fabric's 10 MiB default. The bound is on the framed blob because the blob is
 * what travels.
 */
export const MAX_HISTORY_BATCH_BYTES = 2 * 1024 * 1024;

/** A digest sink: a keyed HMAC or a plain hash. Both expose `update`. */
type DigestSink = crypto.Hmac | crypto.Hash;

/** Immutable source identity of one history write, for the operation ID. */
export interface SourceIdentity {
  sourceNetworkId: string;
  sourceChannel: string;
  blockNumber: number;
  txIndex: number;
  txId: string;
  chaincode: string;
  /** Source collection, or `''` for public data. */
  collection: string;
  key: string;
}

/** Exact destination intent of one history write, for the intent commitment. */
export interface DestinationIntent {
  destChannel: string;
  chaincode: string;
  /** Destination collection, or `''` for public data. */
  collection: string;
  key: string;
  isDelete: boolean;
  /** Exact value bytes to be written, after metadata embedding. Empty on delete. */
  value: Buffer;
}

/**
 * Write one length-delimited field: a uint32 big-endian byte length, then the
 * bytes.
 */
export function writeField(sink: DigestSink, data: Buffer | string): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const len = Buffer.allocUnsafe(LENGTH_BYTES);
  len.writeUInt32BE(bytes.length, 0);
  sink.update(len);
  sink.update(bytes);
}

/** Write one length-delimited unsigned integer as 8 big-endian bytes. */
export function writeUint(sink: DigestSink, value: number): void {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64BE(BigInt(value), 0);
  writeField(sink, buf);
}

/**
 * The operation ID for one source write: HMAC over its immutable source
 * identity, domain-separated. Independent of the destination by construction.
 */
export function operationId(key: Buffer, id: SourceIdentity): Buffer {
  const h = crypto.createHmac('sha256', key);
  writeField(h, DOMAIN_OPERATION_ID);
  writeField(h, id.sourceNetworkId);
  writeField(h, id.sourceChannel);
  writeUint(h, id.blockNumber);
  writeUint(h, id.txIndex);
  writeField(h, id.txId);
  writeField(h, id.chaincode);
  writeField(h, id.collection);
  writeField(h, id.key);
  return h.digest();
}

/**
 * The intent commitment for one destination write: HMAC over the exact
 * destination intent, separately domain-separated.
 */
export function intentDigest(key: Buffer, intent: DestinationIntent): Buffer {
  const h = crypto.createHmac('sha256', key);
  writeField(h, DOMAIN_INTENT);
  writeField(h, intent.destChannel);
  writeField(h, intent.chaincode);
  writeField(h, intent.collection);
  writeField(h, intent.key);
  writeField(h, Buffer.from([intent.isDelete ? 1 : 0]));
  writeField(h, intent.value);
  return h.digest();
}

/**
 * The key commitment: HMAC of the domain tag alone under the key.
 *
 * Binds the HMAC key into the plan digest so a scope reused with a different key
 * is refused, without ever placing the key itself where the digest can leak it.
 */
export function keyCommitment(key: Buffer): Buffer {
  const h = crypto.createHmac('sha256', key);
  writeField(h, DOMAIN_KEY_COMMITMENT);
  return h.digest();
}

/**
 * Frame the single-mutation envelope for `ImportHistory`.
 *
 * `kind | collectionLen | collection | keyLen | key | valueLen | value`. The
 * collection, key, and value never travel as arguments — a byte string passed
 * as a Fabric argument is UTF-8-mangled by the Node and Java shims — so all
 * three are length-delimited here and delivered as transient bytes.
 *
 * @param collection Destination collection, or `''` for public data.
 * @param value Value bytes; empty for a delete.
 */
export function frameHistoryEnvelope(
  kind: number,
  collection: string,
  key: string,
  value: Buffer,
): Buffer {
  const collBytes = Buffer.from(collection, 'utf-8');
  const keyBytes = Buffer.from(key, 'utf-8');
  const size =
    1 +
    LENGTH_BYTES + collBytes.length +
    LENGTH_BYTES + keyBytes.length +
    LENGTH_BYTES + value.length;
  const buf = Buffer.allocUnsafe(size);

  let at = 0;
  buf.writeUInt8(kind, at);
  at += 1;
  at = writeLenPrefixed(buf, at, collBytes);
  at = writeLenPrefixed(buf, at, keyBytes);
  at = writeLenPrefixed(buf, at, value);
  return buf;
}

/** One public-history mutation in a framed batch. */
export interface HistoryBatchEntry {
  operationId: Buffer;
  intent: Buffer;
  key: string;
  value: Buffer;
  isDelete: boolean;
}

/** Bytes one batch entry occupies once framed, key and value included. */
export function framedHistoryBatchEntryBytes(entry: HistoryBatchEntry): number {
  return (
    OP_ID_BYTES +
    INTENT_BYTES +
    LENGTH_BYTES + Buffer.byteLength(entry.key, 'utf-8') +
    FLAG_BYTES +
    LENGTH_BYTES + entry.value.length
  );
}

/**
 * Frame a batch of public-history mutations for `ImportHistoryBatch`.
 *
 * `count`, then per entry: 32 raw operation-ID bytes, 32 raw intent bytes,
 * `keyLen | key | flag | valueLen | value`. Operation ID and intent are raw
 * (not length-delimited) because both are fixed 32-byte digests.
 *
 * @param entries Mutations, each for a distinct key with a distinct operation
 *   ID — guaranteed by the caller taking one version per key per round, and
 *   re-checked by the contract.
 */
export function frameHistoryBatch(entries: HistoryBatchEntry[]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.allocUnsafe(LENGTH_BYTES);
  count.writeUInt32BE(entries.length, 0);
  parts.push(count);

  for (const entry of entries) {
    const framed = Buffer.allocUnsafe(framedHistoryBatchEntryBytes(entry));
    let at = 0;
    at += entry.operationId.copy(framed, at);
    at += entry.intent.copy(framed, at);
    at = writeLenPrefixed(framed, at, Buffer.from(entry.key, 'utf-8'));
    framed.writeUInt8(entry.isDelete ? BATCH_ENTRY_DELETE : BATCH_ENTRY_WRITE, at);
    at += FLAG_BYTES;
    at = writeLenPrefixed(framed, at, entry.value);
    parts.push(framed);
  }

  return Buffer.concat(parts);
}

/** Write `bytes` length-prefixed at `at`, returning the next offset. */
function writeLenPrefixed(buf: Buffer, at: number, bytes: Buffer): number {
  buf.writeUInt32BE(bytes.length, at);
  const next = at + LENGTH_BYTES;
  bytes.copy(buf, next);
  return next + bytes.length;
}

/**
 * Interpret a `GetHistoryImportReceipt` answer as a stored intent commitment.
 *
 * The contract returns a JSON object with `exists` and, when present, a
 * lowercase-hex `intentDigest`. A missing receipt or malformed answer is
 * treated as "no readable receipt" — safe, because the caller then preserves
 * the original failure rather than claiming success.
 *
 * @returns The 32 receipt bytes, or `null` when absent or unreadable.
 */
export function parseReceipt(answer: Uint8Array): Buffer | null {
  const text = Buffer.from(answer).toString('utf-8').trim();
  if (text.length === 0) return null;

  try {
    const receipt = JSON.parse(text) as {
      exists?: unknown;
      intentDigest?: unknown;
    };
    if (receipt.exists !== true) return null;
    if (
      typeof receipt.intentDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.intentDigest)
    ) {
      return null;
    }
    return Buffer.from(receipt.intentDigest, 'hex');
  } catch {
    return null;
  }
}

/**
 * Read the plan digest returned by `GetHistoryImportPlan`.
 *
 * A malformed answer is not evidence that initialization succeeded, so callers
 * preserve the original submit failure when this returns `null`.
 */
export function parsePlan(answer: Uint8Array): string | null {
  const text = Buffer.from(answer).toString('utf-8').trim();
  if (text.length === 0) return null;

  try {
    const plan = JSON.parse(text) as { planDigest?: unknown };
    return typeof plan.planDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(plan.planDigest)
      ? plan.planDigest
      : null;
  } catch {
    return null;
  }
}
