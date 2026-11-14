/**
 * The framing that carries many public writes into one `PutStateBatch` call.
 *
 * Tier-3 history replay submits one Fabric transaction per version, and a
 * transaction costs an endorsement round trip plus an ordering and commit wait
 * whatever it carries — so a ledger with millions of versions cannot be
 * replayed one version at a time in any window an operator would accept. A
 * batch amortises that cost across every key in it.
 *
 * Everything travels in a single transient entry rather than as arguments or as
 * one transient entry per record. Values cannot be arguments at all: the Node
 * and Java contract shims UTF-8-decode a `String` argument, so a value that is
 * not valid UTF-8 would reach the destination ledger as U+FFFD. One entry per
 * record would work, but then the number of writes in a batch is the size of a
 * map the contract has to walk in the order the client meant rather than the
 * order the map iterates, and nothing in the transient map says how many
 * entries to expect. One length-delimited blob says what it holds.
 *
 * A key is length-delimited here rather than sent as an argument beside its
 * value's transient entry, which is what the single-record `PutState` does.
 * That is framing, not fidelity: an extraction record's key came out of a JSON
 * document as a string, so both paths hand the destination the same UTF-8
 * bytes.
 *
 * Lengths are unsigned 32-bit big-endian — the one width and order all three
 * contract languages read without a library (`encoding/binary.BigEndian`,
 * `Buffer.readUInt32BE`, and the default order of a Java `ByteBuffer`).
 *
 * A delete carries an explicit flag rather than a zero-length value. A
 * tombstone and a write of the empty value are different ledger facts — verify
 * compares `isDelete` for exactly that reason — so the encoding cannot make
 * them the same three bytes.
 *
 * The wire contract is `sample/chaincode/migration_contract/README.md`, and the
 * three implementations that parse what this writes are the three files beside
 * it. This is the only encoder.
 */

/** Transient entry name a framed batch travels under. */
export const PUBLIC_BATCH_TRANSIENT = 'public_batch';

/**
 * Transient entry one collection's private batch travels under, for
 * `ImportPrivateDataBatch(collection)`. Same framing as the public batch.
 */
export const PRIVATE_BATCH_TRANSIENT = 'private_batch';

/** Width of the entry count and of each length field. */
const LENGTH_BYTES = 4;

/** Width of the per-entry write/delete flag. */
const FLAG_BYTES = 1;

/** What a batch costs besides its entries: the entry count. */
export const BATCH_HEADER_BYTES = LENGTH_BYTES;

/** What an entry costs besides its key and value: two lengths and the flag. */
export const BATCH_ENTRY_HEADER_BYTES = LENGTH_BYTES + FLAG_BYTES + LENGTH_BYTES;

/** Flag value for a write. */
export const BATCH_WRITE = 0;

/** Flag value for a tombstone, whose value must be empty. */
export const BATCH_DELETE = 1;

/**
 * Largest framed batch a destination will accept, in bytes.
 *
 * A batch is one transaction, so its write set travels to the orderer as one
 * envelope and is refused whole if it is larger than the channel's
 * `AbsoluteMaxBytes` — 10 MiB in Fabric's default `configtx.yaml`, and lower on
 * a channel whose operator tightened it. This is a fifth of that default: a
 * batch is a throughput optimisation, and sailing close to a limit that rejects
 * the whole transaction would trade a bounded gain for an unbounded failure.
 *
 * The bound is on the framed blob rather than on value bytes alone because the
 * blob is what travels, and it is one comparison the contract can make before
 * it parses anything.
 *
 * A record whose own framed size exceeds this is not split — a value cannot be
 * written in pieces — so the adapter submits it through the single-record
 * `PutState`, which carries one value in one transient entry and has no bound
 * here to clear.
 */
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;

/** One public write or tombstone in a batch. */
export interface StateBatchEntry {
  /** Ledger key, as the destination will hold it. */
  key: string;
  /** Value bytes. Empty for a tombstone, which carries no value. */
  value: Buffer;
  /** Whether this entry deletes the key rather than writing it. */
  isDelete: boolean;
}

/** Bytes one entry adds to a framed batch, key and value included. */
export function framedBatchEntryBytes(entry: StateBatchEntry): number {
  return (
    BATCH_ENTRY_HEADER_BYTES +
    Buffer.byteLength(entry.key, 'utf-8') +
    entry.value.length
  );
}

/**
 * Frame one entry: `keyLen | key | flag | valueLen | value`.
 *
 * The flag sits between the key and the value rather than in a header of its
 * own so that a parser reads each entry in one forward pass, without holding a
 * position it has to come back to.
 */
function frameEntry(entry: StateBatchEntry): Buffer {
  const key = Buffer.from(entry.key, 'utf-8');
  const framed = Buffer.allocUnsafe(framedBatchEntryBytes(entry));

  framed.writeUInt32BE(key.length, 0);
  key.copy(framed, LENGTH_BYTES);

  const flagAt = LENGTH_BYTES + key.length;
  framed.writeUInt8(entry.isDelete ? BATCH_DELETE : BATCH_WRITE, flagAt);
  framed.writeUInt32BE(entry.value.length, flagAt + FLAG_BYTES);
  entry.value.copy(framed, BATCH_ENTRY_HEADER_BYTES + key.length);

  return framed;
}

/**
 * Frame a batch of public writes for one `PutStateBatch` transaction.
 *
 * @param entries Writes and tombstones, each for a distinct key. Two versions
 *   of one key must not share a batch: a transaction's write set holds one
 *   value per key, so the earlier version would be dropped and the
 *   destination's history would be one version short. The destination refuses a
 *   batch that names a key twice rather than accepting that silently.
 */
export function frameStateBatch(entries: StateBatchEntry[]): Buffer {
  const count = Buffer.allocUnsafe(BATCH_HEADER_BYTES);
  count.writeUInt32BE(entries.length, 0);

  return Buffer.concat([count, ...entries.map(frameEntry)]);
}
