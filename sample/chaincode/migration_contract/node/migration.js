'use strict';

const { Contract } = require('fabric-contract-api');

/**
 * The MSP IDs allowed to write through this contract.
 *
 * Set this before packaging. Every write function refuses an MSP that is not
 * named here, and the empty list this file ships with refuses all of them,
 * because this contract is a deliberate bypass of the application's own
 * invariants — PutState writes any key with any value — and the organizations
 * running the migration are the only ones that should hold it. Naming them in
 * the source rather than in state or an environment variable makes the list
 * part of the package every org approves through the chaincode lifecycle, so
 * it cannot be widened by whoever can reach the peer.
 *
 * Name every MSP whose identity submits, not only the one that owns the
 * endorsing peer: a member replaying the private collections it can read signs
 * with its own MSP while submitting through a gateway that may belong to
 * another org (chaincode.collectionIdentities in the replay config).
 */
const WRITER_MSP_IDS = [];

/**
 * How many value bytes GetKeyHistory accumulates before it refuses to answer.
 *
 * Fabric has no paginated history API. getHistoryForKey returns one iterator
 * over every version of a key and there is no offset to resume from, so a very
 * deep history has to be returned whole or refused. Returned whole, it
 * eventually crosses the peer's gRPC message limit (100 MB by default) and
 * reaches the operator as a transport error naming no key; refused here, it
 * names the key.
 *
 * Truncating to a page is the one thing this must not do. Verify compares the
 * whole sequence, so a prefix that compared equal would be reported as a match
 * for a history nothing checked past the cut.
 *
 * The bound is on value bytes rather than on a version count because that is
 * what the message limit measures. The base64 response is about four thirds of
 * it, plus roughly thirty bytes of JSON per entry.
 */
const MAX_HISTORY_VALUE_BYTES = 8 * 1024 * 1024;

/**
 * How large a framed batch PutStateBatch will accept, in bytes.
 *
 * A batch is one transaction, so its write set reaches the orderer as one
 * envelope and is refused whole if it is larger than the channel's
 * AbsoluteMaxBytes — 10 MiB in Fabric's default configtx.yaml, and less on a
 * channel whose operator tightened it. This is a fifth of that default: a batch
 * is a throughput optimisation, and sailing close to a limit that rejects the
 * whole transaction would trade a bounded gain for an unbounded failure.
 *
 * The bound is on the framed blob rather than on value bytes alone because the
 * blob is what travels, and it is one comparison to make before anything is
 * parsed.
 */
const MAX_BATCH_BYTES = 2 * 1024 * 1024;

/** Framing widths. These must match src/replay/state-batch.ts, the encoder. */
const BATCH_HEADER_BYTES = 4;
const BATCH_LENGTH_BYTES = 4;
/** What an entry costs besides its key and value. */
const BATCH_ENTRY_OTHER_BYTES = BATCH_LENGTH_BYTES + 1 + BATCH_LENGTH_BYTES;

/** Per-entry flag values. */
const BATCH_WRITE = 0;
const BATCH_DELETE = 1;

/**
 * Refuse a write from an MSP WRITER_MSP_IDS does not name.
 *
 * Reads are deliberately not gated: they cannot change the ledger, a private
 * read is already bounded by the collection policy, and verify may
 * legitimately run as an identity that is not allowed to write.
 */
function requireWriter(ctx) {
  const mspId = ctx.clientIdentity.getMSPID();
  if (WRITER_MSP_IDS.includes(mspId)) {
    return;
  }
  if (WRITER_MSP_IDS.length === 0) {
    throw new Error(
      `${mspId} may not write migration data: WRITER_MSP_IDS is empty, so ` +
      'every write is refused. Set it in migration.js to the MSP IDs the ' +
      'migration submits as, then package and commit the chaincode'
    );
  }
  throw new Error(
    `${mspId} may not write migration data; WRITER_MSP_IDS names ` +
    `${WRITER_MSP_IDS.join(', ')}. Add it there, then package and commit ` +
    'the chaincode'
  );
}

/**
 * Read one entry from the transaction's transient map.
 *
 * An absent entry is an error rather than an empty write: the replay adapter
 * always sends one, so a missing entry means the caller and this contract
 * disagree about the wire contract, and writing an empty value would record
 * that disagreement in the ledger as data.
 */
function transientValue(ctx, name) {
  const value = ctx.stub.getTransient().get(name);
  if (!value) {
    throw new Error(`${name} not found in transient data`);
  }
  return value;
}

/**
 * Decode a framed batch, refusing anything it cannot read exactly.
 *
 * Every refusal names the entry it stopped at: a framing disagreement is a bug
 * in the client or in this contract, and the entry index is what locates it.
 * Nothing is written until the whole batch has parsed, so a blob that runs out
 * halfway leaves the destination holding none of it rather than a prefix the
 * client counted as failed.
 */
function parseBatch(framed) {
  if (framed.length > MAX_BATCH_BYTES) {
    throw new Error(
      `batch of ${framed.length} bytes exceeds the ${MAX_BATCH_BYTES}-byte ` +
      'limit, so it may be too large to order; lower chaincode.writeBatchSize'
    );
  }
  if (framed.length < BATCH_HEADER_BYTES) {
    throw new Error(
      `batch of ${framed.length} bytes is shorter than its ` +
      `${BATCH_HEADER_BYTES}-byte entry count`
    );
  }

  const count = framed.readUInt32BE(0);
  if (count === 0) {
    throw new Error(
      'batch declares no entries, which would report success for records ' +
      'that never landed'
    );
  }
  const capacity = Math.floor(
    (framed.length - BATCH_HEADER_BYTES) / BATCH_ENTRY_OTHER_BYTES
  );
  if (count > capacity) {
    throw new Error(
      `batch declares ${count} entries, which cannot fit in ${framed.length} ` +
      'bytes'
    );
  }

  const entries = [];
  const seen = new Set();
  let pos = BATCH_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const { entry, next } = parseBatchEntry(framed, pos, i);
    if (seen.has(entry.key)) {
      throw new Error(
        `batch names key ${entry.key} twice, at entry ${i}; a transaction ` +
        'records one version per key, so two versions of one key cannot ' +
        'share a batch'
      );
    }
    seen.add(entry.key);
    entries.push(entry);
    pos = next;
  }

  if (pos !== framed.length) {
    throw new Error(
      `batch has ${framed.length - pos} bytes left over after its ` +
      `${count} entries`
    );
  }
  return entries;
}

/** Read the entry at pos, returning it and where the next one begins. */
function parseBatchEntry(framed, pos, index) {
  const key = takeBatchField(framed, pos, index, 'key');
  if (key.next >= framed.length) {
    throw new Error(`entry ${index} ends before its write/delete flag`);
  }
  const flag = framed[key.next];
  const value = takeBatchField(framed, key.next + 1, index, 'value');

  if (flag === BATCH_WRITE) {
    return {
      entry: { key: key.field.toString('utf8'), value: value.field },
      next: value.next,
    };
  }
  if (flag === BATCH_DELETE) {
    // A tombstone and a write of the empty value are different ledger facts,
    // so a delete carrying a value is a framing disagreement rather than a
    // value to drop.
    if (value.field.length > 0) {
      throw new Error(
        `entry ${index} is a delete carrying ${value.field.length} value bytes`
      );
    }
    return {
      entry: { key: key.field.toString('utf8'), isDelete: true },
      next: value.next,
    };
  }
  throw new Error(
    `entry ${index} has flag ${flag}, which is neither a write ` +
    `(${BATCH_WRITE}) nor a delete (${BATCH_DELETE})`
  );
}

/**
 * Read one length-delimited field, returning it and where the next begins. A
 * length the blob cannot hold is refused rather than truncated, which is what a
 * Buffer slice would do silently.
 */
function takeBatchField(framed, pos, index, name) {
  if (pos + BATCH_LENGTH_BYTES > framed.length) {
    throw new Error(`entry ${index} ends before its ${name} length`);
  }
  const size = framed.readUInt32BE(pos);
  const start = pos + BATCH_LENGTH_BYTES;
  if (size > framed.length - start) {
    throw new Error(
      `entry ${index} declares a ${size}-byte ${name} but only ` +
      `${framed.length - start} bytes remain`
    );
  }
  return { field: framed.subarray(start, start + size), next: start + size };
}

// ---------------------------------------------------------------------------
// Resilient idempotent Tier 3 history import (protocol idempotent-v1)
//
// The functions above replay a record by writing it. Replayed twice — after a
// submit that timed out but committed, or a restart from a stale checkpoint —
// they write it twice, and the destination's history is a version longer than
// the source's. The functions below close that: every history mutation is
// paired with a receipt keyed by an operation ID over the immutable source
// identity, and the receipt is read (into the transaction's read set, so the
// pairing is enforced under MVCC) and written in the same transaction as the
// mutation. A record already applied under the same intent is a no-op; one
// whose operation ID reappears with a different intent is refused rather than
// silently overwritten. The operation ID and the intent commitment are HMACs
// the client computes under a key this contract never sees; the contract
// stores the intent as an opaque 32-byte receipt and compares it on re-submit.
// ---------------------------------------------------------------------------

/** The resilient history-import protocol version this contract implements. */
const HISTORY_PROTOCOL_VERSION = 'idempotent-v1';

/** Composite-key object types for the plan and receipt records. */
const HISTORY_PLAN_OBJECT_TYPE = 'fabric-amb-extractor-history-plan-v1';
const HISTORY_RECEIPT_OBJECT_TYPE = 'fabric-amb-extractor-history-receipt-v1';

/**
 * Length of an operation ID, an intent commitment and a plan digest alike —
 * all 32-byte outputs (HMAC-SHA256, HMAC-SHA256 and SHA-256). Function
 * arguments carry them as 64 lowercase hex characters; the batch blob carries
 * the operation ID and intent as raw bytes.
 */
const DIGEST_BYTES = 32;

/** Transient keys the two history submit functions read their payload from. */
const HISTORY_ENTRY_TRANSIENT = 'history_entry';
const HISTORY_BATCH_TRANSIENT = 'public_history_batch';

/** Single-entry envelope kinds. */
const ENVELOPE_PUBLIC_WRITE = 0;
const ENVELOPE_PUBLIC_DELETE = 1;
const ENVELOPE_PRIVATE_WRITE = 2;
const ENVELOPE_PRIVATE_DELETE = 3;

/** Whether s is entirely lowercase hexadecimal. */
function isLowerHex(s) {
  return /^[0-9a-f]*$/.test(s);
}

/** Refuse a scope that is not 32-64 lowercase hex characters. */
function validateScope(scope) {
  if (scope.length < 32 || scope.length > 64 || !isLowerHex(scope)) {
    throw new Error(
      `scope must be 32-64 lowercase hex characters, got ${scope.length}`
    );
  }
}

/** Refuse a digest argument that is not exactly DIGEST_BYTES as lowercase hex. */
function validateHexDigest(name, s) {
  if (s.length !== 2 * DIGEST_BYTES || !isLowerHex(s)) {
    throw new Error(
      `${name} must be ${2 * DIGEST_BYTES} lowercase hex characters`
    );
  }
}

/** Validate and decode a DIGEST_BYTES-long lowercase hex digest to a Buffer. */
function decodeDigest(name, s) {
  validateHexDigest(name, s);
  return Buffer.from(s, 'hex');
}

/**
 * Read one uint32-length-delimited field from the history envelope, returning
 * it and where the next begins. A length the blob cannot hold is refused
 * rather than truncated.
 */
function takeEnvelopeField(framed, pos, name) {
  if (pos + BATCH_LENGTH_BYTES > framed.length) {
    throw new Error(`history entry ends before its ${name} length`);
  }
  const size = framed.readUInt32BE(pos);
  const start = pos + BATCH_LENGTH_BYTES;
  if (size > framed.length - start) {
    throw new Error(
      `history entry declares a ${size}-byte ${name} but only ` +
      `${framed.length - start} bytes remain`
    );
  }
  return { field: framed.subarray(start, start + size), next: start + size };
}

/**
 * Decode the single-entry envelope, refusing anything it cannot read exactly.
 * The collection, key and value are length-delimited bytes and never
 * transaction arguments: a private collection name and key would otherwise
 * reach the public transaction arguments, and a value passed as a string
 * argument would be UTF-8-mangled, the reason PutState takes its value as
 * transient data too.
 */
function parseHistoryEnvelope(framed) {
  if (framed.length < 1) {
    throw new Error('history entry envelope is empty');
  }
  const kind = framed[0];
  if (
    kind !== ENVELOPE_PUBLIC_WRITE && kind !== ENVELOPE_PUBLIC_DELETE &&
    kind !== ENVELOPE_PRIVATE_WRITE && kind !== ENVELOPE_PRIVATE_DELETE
  ) {
    throw new Error(
      `history entry kind ${kind} is not one of public write ` +
      `(${ENVELOPE_PUBLIC_WRITE}), public delete (${ENVELOPE_PUBLIC_DELETE}), ` +
      `private write (${ENVELOPE_PRIVATE_WRITE}) or private delete ` +
      `(${ENVELOPE_PRIVATE_DELETE})`
    );
  }

  const collection = takeEnvelopeField(framed, 1, 'collection');
  const key = takeEnvelopeField(framed, collection.next, 'key');
  const value = takeEnvelopeField(framed, key.next, 'value');
  if (value.next !== framed.length) {
    throw new Error(
      `history entry has ${framed.length - value.next} bytes left over after ` +
      'its fields'
    );
  }

  const isPrivate =
    kind === ENVELOPE_PRIVATE_WRITE || kind === ENVELOPE_PRIVATE_DELETE;
  const isDelete =
    kind === ENVELOPE_PUBLIC_DELETE || kind === ENVELOPE_PRIVATE_DELETE;
  if (key.field.length === 0) {
    throw new Error('history entry has an empty key');
  }
  if (isPrivate) {
    if (collection.field.length === 0) {
      throw new Error(
        `history entry kind ${kind} is private but names no collection`
      );
    }
  } else if (collection.field.length > 0) {
    throw new Error(
      `history entry kind ${kind} is public but carries a ` +
      `${collection.field.length}-byte collection`
    );
  }
  if (isDelete && value.field.length > 0) {
    throw new Error(
      `history entry kind ${kind} is a delete carrying ` +
      `${value.field.length} value bytes`
    );
  }
  return {
    kind,
    collection: collection.field.toString('utf8'),
    key: key.field.toString('utf8'),
    value: value.field,
    isPrivate,
    isDelete,
  };
}

/**
 * Read one public history batch entry at pos, returning it and where the next
 * one begins. Each entry begins with 32 raw operation-ID bytes and 32 raw
 * intent bytes, then a uint32-delimited key, a one-byte flag (0 write, 1
 * delete) and a uint32-delimited value (empty for a delete).
 */
function parseHistoryBatchEntry(framed, pos, index) {
  if (pos + 2 * DIGEST_BYTES > framed.length) {
    throw new Error(`entry ${index} ends before its operation ID and intent`);
  }
  const operationId =
    framed.subarray(pos, pos + DIGEST_BYTES).toString('hex');
  const intent = Buffer.from(
    framed.subarray(pos + DIGEST_BYTES, pos + 2 * DIGEST_BYTES)
  );
  const key = takeBatchField(framed, pos + 2 * DIGEST_BYTES, index, 'key');
  if (key.next >= framed.length) {
    throw new Error(`entry ${index} ends before its write/delete flag`);
  }
  const flag = framed[key.next];
  const value = takeBatchField(framed, key.next + 1, index, 'value');
  if (key.field.length === 0) {
    throw new Error(`entry ${index} has an empty key`);
  }

  if (flag === BATCH_WRITE) {
    return {
      entry: {
        operationId,
        intent,
        key: key.field.toString('utf8'),
        value: value.field,
        isDelete: false,
      },
      next: value.next,
    };
  }
  if (flag === BATCH_DELETE) {
    if (value.field.length > 0) {
      throw new Error(
        `entry ${index} is a delete carrying ${value.field.length} value bytes`
      );
    }
    return {
      entry: {
        operationId,
        intent,
        key: key.field.toString('utf8'),
        value: Buffer.alloc(0),
        isDelete: true,
      },
      next: value.next,
    };
  }
  throw new Error(
    `entry ${index} has flag ${flag}, which is neither a write ` +
    `(${BATCH_WRITE}) nor a delete (${BATCH_DELETE})`
  );
}

/**
 * Decode the public history batch, refusing anything it cannot read exactly.
 * The batch is public only — private data is never batched, for the disclosure
 * reason PutStateBatch documents — so it carries no collection.
 */
function parseHistoryBatch(framed) {
  if (framed.length > MAX_BATCH_BYTES) {
    throw new Error(
      `history batch of ${framed.length} bytes exceeds the ` +
      `${MAX_BATCH_BYTES}-byte limit; lower chaincode.writeBatchSize`
    );
  }
  if (framed.length < BATCH_HEADER_BYTES) {
    throw new Error(
      `history batch of ${framed.length} bytes is shorter than its ` +
      `${BATCH_HEADER_BYTES}-byte entry count`
    );
  }
  const count = framed.readUInt32BE(0);
  if (count === 0) {
    throw new Error(
      'history batch declares no entries, which would report success for ' +
      'records that never landed'
    );
  }
  // Each entry costs at least the two digests, the two lengths and the flag,
  // with an empty key and value.
  const minEntryBytes =
    2 * DIGEST_BYTES + BATCH_LENGTH_BYTES + 1 + BATCH_LENGTH_BYTES;
  const capacity = Math.floor(
    (framed.length - BATCH_HEADER_BYTES) / minEntryBytes
  );
  if (count > capacity) {
    throw new Error(
      `history batch declares ${count} entries, which cannot fit in ` +
      `${framed.length} bytes`
    );
  }

  const entries = [];
  const seenKeys = new Set();
  const seenOps = new Set();
  let pos = BATCH_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const { entry, next } = parseHistoryBatchEntry(framed, pos, i);
    if (seenKeys.has(entry.key)) {
      throw new Error(
        `history batch names key ${entry.key} twice, at entry ${i}; a ` +
        'transaction records one version per key, so two versions of one key ' +
        'cannot share a batch'
      );
    }
    if (seenOps.has(entry.operationId)) {
      throw new Error(
        `history batch names operation ${entry.operationId} twice, at ` +
        `entry ${i}`
      );
    }
    seenKeys.add(entry.key);
    seenOps.add(entry.operationId);
    entries.push(entry);
    pos = next;
  }
  if (pos !== framed.length) {
    throw new Error(
      `history batch has ${framed.length - pos} bytes left over after its ` +
      `${count} entries`
    );
  }
  return entries;
}

/**
 * Read the plan for a scope and refuse unless it exists and matches
 * planDigest. The read puts the plan key in the transaction's read set, so an
 * import is bound under MVCC to the plan version it verified against.
 */
async function requirePlan(ctx, scope, planDigest) {
  validateScope(scope);
  const digest = decodeDigest('planDigest', planDigest);
  const planKey =
    ctx.stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, [scope]);
  const existing = await ctx.stub.getState(planKey);
  if (!existing || existing.length === 0) {
    throw new Error(
      `scope ${scope} has no history import plan; call ` +
      'InitializeHistoryImport before importing'
    );
  }
  if (!existing.equals(digest)) {
    throw new Error(
      `the plan digest for scope ${scope} does not match the stored plan; a ` +
      'changed plan under the same scope is refused'
    );
  }
}

/**
 * Apply one history mutation exactly once.
 *
 * It reads the receipt for (scope, operationId) first — which places the
 * receipt key in the read set and so binds the outcome to that key's version
 * under MVCC — and then: an existing receipt whose bytes equal this intent is
 * a no-op; one whose bytes differ is refused; and no receipt applies the
 * mutation and writes the 32-byte intent receipt, both in this one
 * transaction, so the ledger never holds one without the other.
 */
async function applyHistoryMutation(ctx, scope, operationId, intent, mutate) {
  const receiptKey = ctx.stub.createCompositeKey(
    HISTORY_RECEIPT_OBJECT_TYPE, [scope, operationId]
  );
  const existing = await ctx.stub.getState(receiptKey);
  if (existing && existing.length > 0) {
    if (existing.equals(intent)) {
      return;
    }
    throw new Error(
      `operation ${operationId} under scope ${scope} already has a receipt ` +
      'recording a different intent; refusing to overwrite it'
    );
  }
  await mutate();
  await ctx.stub.putState(receiptKey, intent);
}

/**
 * MigrationContract provides the functions required by the
 * the migration toolkit's replay and verify commands. Add it to your
 * existing chaincode package and set WRITER_MSP_IDS above — no changes to your
 * application logic:
 *
 *   module.exports.contracts = [MyContract, MigrationContract];
 *
 * After migration, remove the export and upgrade the chaincode.
 *
 * No value crosses the boundary as a string. Values written here arrive as
 * transient data, and values read back are returned base64-encoded. Both are
 * because this shim UTF-8-decodes transaction arguments before the contract
 * sees them (`fabric-shim` stores `entry.toString('utf8')`) and re-encodes a
 * returned String the same way, so any byte sequence that is not valid UTF-8
 * would be silently replaced with U+FFFD in either direction. See
 * ../README.md for the full wire contract.
 */
class MigrationContract extends Contract {
  constructor() {
    super('MigrationContract');
  }

  async PutState(ctx, key) {
    requireWriter(ctx);
    await ctx.stub.putState(key, transientValue(ctx, 'public_value'));
  }

  /**
   * Write many public keys in one transaction.
   *
   * A transaction costs an endorsement round trip plus an ordering and commit
   * wait whatever it carries, so a tier-3 history replay that submits one
   * transaction per version does not finish in any window an operator would
   * accept. This amortises that cost across every key in the batch.
   *
   * The batch arrives as transient data under "public_batch", framed as
   * described in ../README.md: a uint32 entry count, then per entry a uint32
   * key length, the key, a one-byte flag (0 write, 1 delete), a uint32 value
   * length and the value, all unsigned big-endian. Values travel as bytes here
   * for the reason PutState's does — a String argument would be UTF-8-decoded
   * by this shim — and the keys travel with them because one length-delimited
   * blob says how many writes it holds, where a transient entry per record does
   * not.
   *
   * Two versions of one key must not share a batch, and parseBatch refuses one
   * that does: a transaction's write set holds one value per key, so the earlier
   * version would be dropped and the destination's history would be a version
   * short of the source's.
   */
  async PutStateBatch(ctx) {
    requireWriter(ctx);
    const entries = parseBatch(transientValue(ctx, 'public_batch'));
    for (const entry of entries) {
      if (entry.isDelete) {
        await ctx.stub.deleteState(entry.key);
      } else {
        await ctx.stub.putState(entry.key, entry.value);
      }
    }
  }

  /**
   * Write many keys of one private data collection in one transaction.
   *
   * The batch arrives as transient data under "private_batch", in the framing
   * PutStateBatch reads, and goes through the same parseBatch. One collection
   * per call keeps the endorsers — and so the members the values are disclosed
   * to — the same as for a single ImportPrivateData.
   */
  async ImportPrivateDataBatch(ctx, collection) {
    requireWriter(ctx);
    const entries = parseBatch(transientValue(ctx, 'private_batch'));
    for (const entry of entries) {
      if (entry.isDelete) {
        await ctx.stub.deletePrivateData(collection, entry.key);
      } else {
        await ctx.stub.putPrivateData(collection, entry.key, entry.value);
      }
    }
  }

  async ImportPrivateData(ctx, collection, key) {
    requireWriter(ctx);
    await ctx.stub.putPrivateData(
      collection, key, transientValue(ctx, 'private_value')
    );
  }

  async DeleteState(ctx, key) {
    requireWriter(ctx);
    await ctx.stub.deleteState(key);
  }

  async DeletePrivateData(ctx, collection, key) {
    requireWriter(ctx);
    await ctx.stub.deletePrivateData(collection, key);
  }

  async GetKeyHistory(ctx, key) {
    const iterator = await ctx.stub.getHistoryForKey(key);
    const entries = [];
    let total = 0;
    let overrun = false;
    while (true) {
      const res = await iterator.next();
      if (res.value) {
        total += res.value.value.length;
        if (total > MAX_HISTORY_VALUE_BYTES) {
          overrun = true;
          break;
        }
        entries.push({
          value: res.value.value.toString('base64'),
          isDelete: res.value.isDelete,
        });
      }
      if (res.done) break;
    }
    await iterator.close();
    if (overrun) {
      throw new Error(
        `history for ${key} exceeds ${MAX_HISTORY_VALUE_BYTES} value bytes ` +
        `at version ${entries.length + 1}, so it cannot be returned in one ` +
        'response. Fabric has no paginated history API to fetch the rest ' +
        'with, so this key has to be checked against the destination by hand'
      );
    }
    return JSON.stringify(entries);
  }

  async ReadState(ctx, key) {
    const data = await ctx.stub.getState(key);
    if (!data || data.length === 0) {
      throw new Error(`key ${key} does not exist`);
    }
    return data.toString('base64');
  }

  async ReadPrivateData(ctx, collection, key) {
    const data = await ctx.stub.getPrivateData(
      collection, key
    );
    if (!data || data.length === 0) {
      throw new Error(
        `private data ${collection}/${key} does not exist`
      );
    }
    return data.toString('base64');
  }

  /**
   * The destination's own SHA-256 hash of a private key's value, base64. It
   * answers for a collection the caller cannot read.
   *
   * A private-data hash is public channel data: Fabric writes it into the
   * block's collection_hashed_rwset, every peer commits it, and the peer
   * applies the collection's read policy to getPrivateData but not to this. So
   * a caller that is not a collection member — or whose gateway peer belongs to
   * an org that is not — gets the hash where getPrivateData gets nothing.
   *
   * That is exactly the case verify has in a multi-member migration. See
   * ../README.md — without it every key of a collection the verifying identity
   * cannot read is reported missing, over data that is present and correct.
   */
  async ReadPrivateDataHash(ctx, collection, key) {
    const hash = await ctx.stub.getPrivateDataHash(collection, key);
    if (!hash || hash.length === 0) {
      throw new Error(
        `private data ${collection}/${key} does not exist`
      );
    }
    return hash.toString('base64');
  }

  /**
   * One page of this chaincode's public keys, as
   * {"keys":["<base64>",...],"bookmark":"..."}. See ../README.md — keys are
   * base64 for the reason values are, only keys are returned but the range
   * query still carries every value to the chaincode, and keys created with
   * Fabric's composite-key API are outside an unbounded range query.
   */
  async ListKeys(ctx, pageSize, bookmark) {
    const { iterator, metadata } =
      await ctx.stub.getStateByRangeWithPagination(
        '', '', parseInt(pageSize, 10), bookmark
      );
    const keys = [];
    while (true) {
      const res = await iterator.next();
      if (res.value) {
        keys.push(Buffer.from(res.value.key, 'utf8').toString('base64'));
      }
      if (res.done) break;
    }
    await iterator.close();
    return JSON.stringify({ keys, bookmark: metadata.bookmark });
  }

  /**
   * Record the plan digest a scope's history import runs under, or confirm an
   * existing one matches.
   *
   * The plan digest binds everything a run must not change midway — protocol
   * version, scope, the key commitment, the ordered input file hashes, the
   * source network, channel and collection routing, embedSourceMetadata and
   * the migration contract — into one SHA-256 the client computes. Operational
   * batch size is not part of the plan because changing it does not alter any
   * record's destination intent. This stores it under the scope; every
   * refuses if the digest it carries disagrees. Re-initialising with the same
   * digest is a no-op, so a restarted run may call it again safely; a
   * different digest under a scope that already has one is refused, because
   * its writes would mix with the first plan's under the same receipts. A new
   * plan needs a new scope.
   */
  async InitializeHistoryImport(ctx, scope, planDigest) {
    requireWriter(ctx);
    validateScope(scope);
    const digest = decodeDigest('planDigest', planDigest);
    const planKey =
      ctx.stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, [scope]);
    const existing = await ctx.stub.getState(planKey);
    if (existing && existing.length > 0) {
      if (existing.equals(digest)) {
        return;
      }
      throw new Error(
        `scope ${scope} already has a history import plan with a different ` +
        'digest; a changed plan under the same scope is refused. Use a new ' +
        'scope for a new plan'
      );
    }
    await ctx.stub.putState(planKey, digest);
  }

  /**
   * Apply one Tier 3 history record — public or private, write or delete —
   * exactly once under its scope.
   *
   * The mutation travels as one transient envelope under "history_entry",
   * framed as ../README.md describes: a one-byte kind, then a uint32-delimited
   * collection (empty for public), key and value (empty for a delete).
   * operationId and intentDigest are 64 lowercase hex characters, opaque to
   * this contract: the operationId identifies the immutable source record and
   * keys the receipt, and the intentDigest is stored as the receipt and
   * compared on re-submit.
   */
  async ImportHistory(ctx, scope, planDigest, operationId, intentDigest) {
    requireWriter(ctx);
    await requirePlan(ctx, scope, planDigest);
    validateHexDigest('operationId', operationId);
    const intent = decodeDigest('intentDigest', intentDigest);
    const entry = parseHistoryEnvelope(
      transientValue(ctx, HISTORY_ENTRY_TRANSIENT)
    );
    await applyHistoryMutation(ctx, scope, operationId, intent, async () => {
      switch (entry.kind) {
        case ENVELOPE_PUBLIC_WRITE:
          await ctx.stub.putState(entry.key, entry.value);
          break;
        case ENVELOPE_PUBLIC_DELETE:
          await ctx.stub.deleteState(entry.key);
          break;
        case ENVELOPE_PRIVATE_WRITE:
          await ctx.stub.putPrivateData(
            entry.collection, entry.key, entry.value
          );
          break;
        case ENVELOPE_PRIVATE_DELETE:
          await ctx.stub.deletePrivateData(entry.collection, entry.key);
          break;
        default:
          // parseHistoryEnvelope has already refused any other kind.
          throw new Error(`unreachable history entry kind ${entry.kind}`);
      }
    });
  }

  /**
   * Apply many public history records in one transaction, each exactly once
   * under its scope.
   *
   * The batch travels as one transient blob under "public_history_batch".
   * Every entry is applied through the same receipt check ImportHistory uses,
   * so a batch that overlaps an already-applied one applies only its new
   * entries and reports the rest as the no-ops they are.
   */
  async ImportHistoryBatch(ctx, scope, planDigest) {
    requireWriter(ctx);
    await requirePlan(ctx, scope, planDigest);
    const entries = parseHistoryBatch(
      transientValue(ctx, HISTORY_BATCH_TRANSIENT)
    );
    for (const entry of entries) {
      await applyHistoryMutation(
        ctx, scope, entry.operationId, entry.intent, async () => {
          if (entry.isDelete) {
            await ctx.stub.deleteState(entry.key);
          } else {
            await ctx.stub.putState(entry.key, entry.value);
          }
        }
      );
    }
  }

  /**
   * The plan digest recorded for a scope, as
   * {"scope":"...","protocol":"idempotent-v1","planDigest":"<hex>"}. A read, so
   * it is not gated by WRITER_MSP_IDS.
   */
  async GetHistoryImportPlan(ctx, scope) {
    validateScope(scope);
    const planKey =
      ctx.stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, [scope]);
    const existing = await ctx.stub.getState(planKey);
    if (!existing || existing.length === 0) {
      throw new Error(`scope ${scope} has no history import plan`);
    }
    return JSON.stringify({
      scope,
      protocol: HISTORY_PROTOCOL_VERSION,
      planDigest: existing.toString('hex'),
    });
  }

  /**
   * Whether an operation has a receipt under a scope and, if so, the intent it
   * recorded, as
   * {"scope":"...","operationId":"...","exists":true,"intentDigest":"<hex>"}
   * or the same object with "exists":false and no intent. The adapter reads it
   * to resolve a submit or commit-status error safely: a receipt whose intent
   * matches means the mutation landed, a receipt whose intent differs is a
   * hard failure, and an absent receipt leaves the original failure to stand.
   * A read, so it is not gated by WRITER_MSP_IDS.
   */
  async GetHistoryImportReceipt(ctx, scope, operationId) {
    validateScope(scope);
    validateHexDigest('operationId', operationId);
    const receiptKey = ctx.stub.createCompositeKey(
      HISTORY_RECEIPT_OBJECT_TYPE, [scope, operationId]
    );
    const existing = await ctx.stub.getState(receiptKey);
    const exists = !!(existing && existing.length > 0);
    const receipt = { scope, operationId, exists };
    if (exists) {
      receipt.intentDigest = existing.toString('hex');
    }
    return JSON.stringify(receipt);
  }

  /**
   * Describe the protocol this contract implements so a client can confirm the
   * deployed contract speaks it before submitting. A read, so it is not gated
   * by WRITER_MSP_IDS.
   */
  async HistoryImportProtocol(ctx) {
    return JSON.stringify({
      protocol: HISTORY_PROTOCOL_VERSION,
      digestBytes: DIGEST_BYTES,
      planObjectType: HISTORY_PLAN_OBJECT_TYPE,
      receiptObjectType: HISTORY_RECEIPT_OBJECT_TYPE,
      entryTransient: HISTORY_ENTRY_TRANSIENT,
      batchTransient: HISTORY_BATCH_TRANSIENT,
      maxBatchBytes: MAX_BATCH_BYTES,
    });
  }
}

module.exports = { MigrationContract };
