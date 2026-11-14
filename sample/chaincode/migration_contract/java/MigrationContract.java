package com.ambmigration;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.Gson;

import org.hyperledger.fabric.contract.Context;
import org.hyperledger.fabric.contract.ContractInterface;
import org.hyperledger.fabric.contract.annotation.Contract;
import org.hyperledger.fabric.contract.annotation.Transaction;
import org.hyperledger.fabric.shim.ChaincodeStub;
import org.hyperledger.fabric.shim.ledger.KeyModification;
import org.hyperledger.fabric.shim.ledger.KeyValue;
import org.hyperledger.fabric.shim.ledger.QueryResultsIterator;
import org.hyperledger.fabric.shim.ledger.QueryResultsIteratorWithMetadata;

/**
 * MigrationContract provides the functions required by the
 * the migration toolkit's replay and verify commands. Register it
 * alongside your existing contract and set WRITER_MSP_IDS below — no
 * changes to your application logic:
 *
 * <pre>
 *   ChaincodeServerProperties props = ...;
 *   ContractRouter router = new ContractRouter(new String[]{},
 *       MyContract.class, MigrationContract.class);
 * </pre>
 *
 * After migration, remove the registration and upgrade.
 *
 * <p>No value crosses the boundary as a String. Values written here
 * arrive as transient data, and values read back are returned
 * base64-encoded. Both are because the Java serializer builds
 * {@code new String(bytes, UTF_8)} for a String parameter and encodes a
 * returned String the same way, so any byte sequence that is not valid
 * UTF-8 would be silently replaced with U+FFFD in either direction.
 * See ../README.md for the full wire contract.
 *
 * <p>Deliberately not annotated {@code @Default}. Registered beside the
 * customer's contract, a second {@code @Default} either stops the
 * chaincode from starting or makes this contract the package default,
 * routing their application's un-namespaced calls here instead of into
 * their business logic.
 */
@Contract(name = "MigrationContract")
public class MigrationContract implements ContractInterface {

    /**
     * The MSP IDs allowed to write through this contract.
     *
     * <p>Set this before packaging. Every write function refuses an MSP
     * that is not named here, and the empty list this file ships with
     * refuses all of them, because this contract is a deliberate bypass
     * of the application's own invariants — PutState writes any key with
     * any value — and the organizations running the migration are the
     * only ones that should hold it. Naming them in the source rather
     * than in state or an environment variable makes the list part of the
     * package every org approves through the chaincode lifecycle, so it
     * cannot be widened by whoever can reach the peer.
     *
     * <p>Name every MSP whose identity submits, not only the one that
     * owns the endorsing peer: a member replaying the private collections
     * it can read signs with its own MSP while submitting through a
     * gateway that may belong to another org
     * ({@code chaincode.collectionIdentities} in the replay config).
     */
    private static final List<String> WRITER_MSP_IDS = List.of();

    /**
     * How many value bytes GetKeyHistory accumulates before it refuses
     * to answer.
     *
     * <p>Fabric has no paginated history API. {@code getHistoryForKey}
     * returns one iterator over every version of a key and there is no
     * offset to resume from, so a very deep history has to be returned
     * whole or refused. Returned whole, it eventually crosses the peer's
     * gRPC message limit (100 MB by default) and reaches the operator as
     * a transport error naming no key; refused here, it names the key.
     *
     * <p>Truncating to a page is the one thing this must not do. Verify
     * compares the whole sequence, so a prefix that compared equal would
     * be reported as a match for a history nothing checked past the cut.
     *
     * <p>The bound is on value bytes rather than on a version count
     * because that is what the message limit measures. The base64
     * response is about four thirds of it, plus roughly thirty bytes of
     * JSON per entry.
     */
    private static final long MAX_HISTORY_VALUE_BYTES = 8L * 1024 * 1024;

    /**
     * How large a framed batch PutStateBatch will accept, in bytes.
     *
     * <p>A batch is one transaction, so its write set reaches the orderer
     * as one envelope and is refused whole if it is larger than the
     * channel's AbsoluteMaxBytes — 10 MiB in Fabric's default
     * configtx.yaml, and less on a channel whose operator tightened it.
     * This is a fifth of that default: a batch is a throughput
     * optimisation, and sailing close to a limit that rejects the whole
     * transaction would trade a bounded gain for an unbounded failure.
     *
     * <p>The bound is on the framed blob rather than on value bytes alone
     * because the blob is what travels, and it is one comparison to make
     * before anything is parsed.
     */
    private static final int MAX_BATCH_BYTES = 2 * 1024 * 1024;

    /**
     * Framing widths. These must match src/replay/state-batch.ts, which
     * is the only encoder.
     */
    private static final int BATCH_HEADER_BYTES = 4;
    private static final int BATCH_LENGTH_BYTES = 4;
    /** What an entry costs besides its key and value. */
    private static final int BATCH_ENTRY_OTHER_BYTES =
        BATCH_LENGTH_BYTES + 1 + BATCH_LENGTH_BYTES;

    /** Per-entry flag values. */
    private static final int BATCH_WRITE = 0;
    private static final int BATCH_DELETE = 1;

    /** The resilient history-import protocol version this contract implements. */
    private static final String HISTORY_PROTOCOL_VERSION = "idempotent-v1";

    /** Composite-key object types for the plan and receipt records. */
    private static final String HISTORY_PLAN_OBJECT_TYPE =
        "fabric-amb-extractor-history-plan-v1";
    private static final String HISTORY_RECEIPT_OBJECT_TYPE =
        "fabric-amb-extractor-history-receipt-v1";

    /**
     * Length of an operation ID, an intent commitment and a plan digest
     * alike — all 32-byte outputs (HMAC-SHA256, HMAC-SHA256 and SHA-256).
     * Function arguments carry them as 64 lowercase hex characters; the batch
     * blob carries the operation ID and intent as raw bytes.
     */
    private static final int DIGEST_BYTES = 32;

    /**
     * Transient keys the two history submit functions read their payload from.
     */
    private static final String HISTORY_ENTRY_TRANSIENT = "history_entry";
    private static final String HISTORY_BATCH_TRANSIENT = "public_history_batch";

    /** Single-entry envelope kinds. */
    private static final int ENVELOPE_PUBLIC_WRITE = 0;
    private static final int ENVELOPE_PUBLIC_DELETE = 1;
    private static final int ENVELOPE_PRIVATE_WRITE = 2;
    private static final int ENVELOPE_PRIVATE_DELETE = 3;

    private final Gson gson = new Gson();

    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void PutState(final Context ctx,
                         final String key) {
        requireWriter(ctx);
        ctx.getStub().putState(key, transientValue(ctx, "public_value"));
    }

    /**
     * Write many public keys in one transaction.
     *
     * <p>A transaction costs an endorsement round trip plus an ordering
     * and commit wait whatever it carries, so a tier-3 history replay
     * that submits one transaction per version does not finish in any
     * window an operator would accept. This amortises that cost across
     * every key in the batch.
     *
     * <p>The batch arrives as transient data under {@code public_batch},
     * framed as described in ../README.md: a uint32 entry count, then per
     * entry a uint32 key length, the key, a one-byte flag (0 write, 1
     * delete), a uint32 value length and the value, all unsigned
     * big-endian. Values travel as bytes here for the reason PutState's
     * do — a String argument would be UTF-8-decoded by the serializer —
     * and the keys travel with them because one length-delimited blob
     * says how many writes it holds, where a transient entry per record
     * does not.
     *
     * <p>Two versions of one key must not share a batch, and
     * {@code parseBatch} refuses one that does: a transaction's write set
     * holds one value per key, so the earlier version would be dropped
     * and the destination's history would be a version short of the
     * source's.
     */
    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void PutStateBatch(final Context ctx) {
        requireWriter(ctx);
        List<BatchEntry> entries =
            parseBatch(transientValue(ctx, "public_batch"));
        for (BatchEntry entry : entries) {
            if (entry.isDelete) {
                ctx.getStub().delState(entry.key);
            } else {
                ctx.getStub().putState(entry.key, entry.value);
            }
        }
    }

    /**
     * Writes many keys of one private data collection in one transaction.
     *
     * <p>The batch arrives as transient data under {@code private_batch}, in
     * the framing {@code PutStateBatch} reads, and goes through the same
     * {@code parseBatch}. One collection per call keeps the endorsers, and so
     * the members the values are disclosed to, the same as for a single
     * {@code ImportPrivateData}.
     */
    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void ImportPrivateDataBatch(final Context ctx,
                                       final String collection) {
        requireWriter(ctx);
        List<BatchEntry> entries =
            parseBatch(transientValue(ctx, "private_batch"));
        for (BatchEntry entry : entries) {
            if (entry.isDelete) {
                ctx.getStub().delPrivateData(collection, entry.key);
            } else {
                ctx.getStub().putPrivateData(collection, entry.key, entry.value);
            }
        }
    }

    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void ImportPrivateData(final Context ctx,
                                  final String collection,
                                  final String key) {
        requireWriter(ctx);
        ctx.getStub().putPrivateData(
            collection, key, transientValue(ctx, "private_value")
        );
    }

    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void DeleteState(final Context ctx,
                            final String key) {
        requireWriter(ctx);
        ctx.getStub().delState(key);
    }

    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void DeletePrivateData(final Context ctx,
                                  final String collection,
                                  final String key) {
        requireWriter(ctx);
        ctx.getStub().delPrivateData(collection, key);
    }

    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String GetKeyHistory(final Context ctx,
                                final String key) {
        QueryResultsIterator<KeyModification> history =
            ctx.getStub().getHistoryForKey(key);

        List<Map<String, Object>> entries = new ArrayList<>();
        long total = 0;
        boolean overrun = false;
        for (KeyModification mod : history) {
            byte[] value = mod.getValue();
            total += value == null ? 0 : value.length;
            if (total > MAX_HISTORY_VALUE_BYTES) {
                overrun = true;
                break;
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("value", encode(value));
            entry.put("isDelete", mod.isDeleted());
            entries.add(entry);
        }

        try {
            history.close();
        } catch (Exception e) {
            throw new RuntimeException(
                "failed to close history iterator", e
            );
        }

        if (overrun) {
            throw new RuntimeException(
                "history for " + key + " exceeds " + MAX_HISTORY_VALUE_BYTES
                + " value bytes at version " + (entries.size() + 1)
                + ", so it cannot be returned in one response. Fabric has no "
                + "paginated history API to fetch the rest with, so this key "
                + "has to be checked against the destination by hand"
            );
        }

        return gson.toJson(entries);
    }

    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String ReadState(final Context ctx,
                            final String key) {
        byte[] data = ctx.getStub().getState(key);
        if (data == null || data.length == 0) {
            throw new RuntimeException(
                "key " + key + " does not exist"
            );
        }
        return encode(data);
    }

    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String ReadPrivateData(final Context ctx,
                                  final String collection,
                                  final String key) {
        byte[] data = ctx.getStub().getPrivateData(
            collection, key
        );
        if (data == null || data.length == 0) {
            throw new RuntimeException(
                "private data " + collection + "/" + key +
                " does not exist"
            );
        }
        return encode(data);
    }

    /**
     * The destination's own SHA-256 hash of a private key's value,
     * base64. It answers for a collection the caller cannot read.
     *
     * <p>A private-data hash is public channel data: Fabric writes it
     * into the block's {@code collection_hashed_rwset}, every peer
     * commits it, and the peer applies the collection's read policy to
     * {@code getPrivateData} but not to this. So a caller that is not a
     * collection member — or whose gateway peer belongs to an org that
     * is not — gets the hash where {@code getPrivateData} gets nothing.
     *
     * <p>That is exactly the case verify has in a multi-member
     * migration. See ../README.md — without it every key of a collection
     * the verifying identity cannot read is reported missing, over data
     * that is present and correct.
     */
    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String ReadPrivateDataHash(final Context ctx,
                                      final String collection,
                                      final String key) {
        byte[] hash = ctx.getStub().getPrivateDataHash(
            collection, key
        );
        if (hash == null || hash.length == 0) {
            throw new RuntimeException(
                "private data " + collection + "/" + key +
                " does not exist"
            );
        }
        return encode(hash);
    }

    /**
     * One page of this chaincode's public keys, as
     * {"keys":["&lt;base64&gt;",...],"bookmark":"..."}.
     *
     * <p>See ../README.md — keys are base64 for the reason values are, only
     * keys are returned but the range query still carries every value to the
     * chaincode, and keys created with Fabric's composite-key API are outside
     * an unbounded range query.
     */
    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String ListKeys(final Context ctx,
                           final int pageSize,
                           final String bookmark) {
        QueryResultsIteratorWithMetadata<KeyValue> results =
            ctx.getStub().getStateByRangeWithPagination(
                "", "", pageSize, bookmark
            );

        List<String> keys = new ArrayList<>();
        for (KeyValue kv : results) {
            keys.add(encode(kv.getKey().getBytes(StandardCharsets.UTF_8)));
        }
        String nextBookmark = results.getMetadata().getBookmark();

        try {
            results.close();
        } catch (Exception e) {
            throw new RuntimeException(
                "failed to close key iterator", e
            );
        }

        Map<String, Object> page = new LinkedHashMap<>();
        page.put("keys", keys);
        page.put("bookmark", nextBookmark);
        return gson.toJson(page);
    }

    /**
     * Refuse a write from an MSP {@link #WRITER_MSP_IDS} does not name.
     *
     * <p>Reads are deliberately not gated: they cannot change the ledger,
     * a private read is already bounded by the collection policy, and
     * verify may legitimately run as an identity that is not allowed to
     * write.
     */
    private static void requireWriter(final Context ctx) {
        String mspId = ctx.getClientIdentity().getMSPID();
        if (WRITER_MSP_IDS.contains(mspId)) {
            return;
        }

        if (WRITER_MSP_IDS.isEmpty()) {
            throw new RuntimeException(
                mspId + " may not write migration data: WRITER_MSP_IDS is "
                + "empty, so every write is refused. Set it in "
                + "MigrationContract.java to the MSP IDs the migration "
                + "submits as, then package and commit the chaincode"
            );
        }
        throw new RuntimeException(
            mspId + " may not write migration data; WRITER_MSP_IDS names "
            + String.join(", ", WRITER_MSP_IDS) + ". Add it there, then "
            + "package and commit the chaincode"
        );
    }

    /**
     * Read one entry from the transaction's transient map.
     *
     * <p>An absent entry is an error rather than an empty write: the
     * replay adapter always sends one, so a missing entry means the
     * caller and this contract disagree about the wire contract, and
     * writing an empty value would record that disagreement in the
     * ledger as data.
     */
    private static byte[] transientValue(final Context ctx,
                                         final String name) {
        Map<String, byte[]> entries = ctx.getStub().getTransient();
        byte[] value = entries.get(name);
        if (value == null) {
            throw new RuntimeException(
                name + " not found in transient data"
            );
        }
        return value;
    }

    /** One parsed write or tombstone from a framed batch. */
    private static final class BatchEntry {
        private final String key;
        private final byte[] value;
        private final boolean isDelete;

        BatchEntry(final String key, final byte[] value,
                   final boolean isDelete) {
            this.key = key;
            this.value = value;
            this.isDelete = isDelete;
        }
    }

    /**
     * A forward cursor over a framed batch.
     *
     * <p>Java has no multiple return, so the position lives here rather
     * than being handed back by every read — which also means a read that
     * refuses cannot leave the position half-advanced.
     */
    private static final class BatchCursor {
        private final byte[] framed;
        private int pos;

        BatchCursor(final byte[] framed, final int pos) {
            this.framed = framed;
            this.pos = pos;
        }

        /**
         * The next length-delimited field. A length the blob cannot hold
         * is refused rather than clamped to what is left.
         */
        private byte[] take(final String name, final long index) {
            if (pos + BATCH_LENGTH_BYTES > framed.length) {
                throw new RuntimeException(
                    "entry " + index + " ends before its " + name + " length"
                );
            }
            long size = readUint32(framed, pos);
            int start = pos + BATCH_LENGTH_BYTES;
            if (size > framed.length - start) {
                throw new RuntimeException(
                    "entry " + index + " declares a " + size + "-byte " + name
                    + " but only " + (framed.length - start) + " bytes remain"
                );
            }
            pos = start + (int) size;
            return Arrays.copyOfRange(framed, start, pos);
        }

        /** The write/delete flag between an entry's key and its value. */
        private int takeFlag(final long index) {
            if (pos >= framed.length) {
                throw new RuntimeException(
                    "entry " + index + " ends before its write/delete flag"
                );
            }
            return framed[pos++] & 0xff;
        }
    }

    /**
     * Decode a framed batch, refusing anything it cannot read exactly.
     *
     * <p>Every refusal names the entry it stopped at: a framing
     * disagreement is a bug in the client or in this contract, and the
     * entry index is what locates it. Nothing is written until the whole
     * batch has parsed, so a blob that runs out halfway leaves the
     * destination holding none of it rather than a prefix the client
     * counted as failed.
     */
    private static List<BatchEntry> parseBatch(final byte[] framed) {
        if (framed.length > MAX_BATCH_BYTES) {
            throw new RuntimeException(
                "batch of " + framed.length + " bytes exceeds the "
                + MAX_BATCH_BYTES + "-byte limit, so it may be too large to "
                + "order; lower chaincode.writeBatchSize"
            );
        }
        if (framed.length < BATCH_HEADER_BYTES) {
            throw new RuntimeException(
                "batch of " + framed.length + " bytes is shorter than its "
                + BATCH_HEADER_BYTES + "-byte entry count"
            );
        }

        long count = readUint32(framed, 0);
        if (count == 0) {
            throw new RuntimeException(
                "batch declares no entries, which would report success for "
                + "records that never landed"
            );
        }
        long capacity =
            (framed.length - BATCH_HEADER_BYTES) / BATCH_ENTRY_OTHER_BYTES;
        if (count > capacity) {
            throw new RuntimeException(
                "batch declares " + count + " entries, which cannot fit in "
                + framed.length + " bytes"
            );
        }

        List<BatchEntry> entries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        BatchCursor cursor = new BatchCursor(framed, BATCH_HEADER_BYTES);
        for (long i = 0; i < count; i++) {
            BatchEntry entry = parseBatchEntry(cursor, i);
            if (!seen.add(entry.key)) {
                throw new RuntimeException(
                    "batch names key " + entry.key + " twice, at entry " + i
                    + "; a transaction records one version per key, so two "
                    + "versions of one key cannot share a batch"
                );
            }
            entries.add(entry);
        }

        if (cursor.pos != framed.length) {
            throw new RuntimeException(
                "batch has " + (framed.length - cursor.pos)
                + " bytes left over after its " + count + " entries"
            );
        }
        return entries;
    }

    /** Read one entry, leaving the cursor where the next one begins. */
    private static BatchEntry parseBatchEntry(final BatchCursor cursor,
                                              final long index) {
        String key = new String(
            cursor.take("key", index), StandardCharsets.UTF_8
        );
        int flag = cursor.takeFlag(index);
        byte[] value = cursor.take("value", index);

        if (flag == BATCH_WRITE) {
            return new BatchEntry(key, value, false);
        }
        if (flag == BATCH_DELETE) {
            // A tombstone and a write of the empty value are different
            // ledger facts, so a delete carrying a value is a framing
            // disagreement rather than a value to drop.
            if (value.length > 0) {
                throw new RuntimeException(
                    "entry " + index + " is a delete carrying " + value.length
                    + " value bytes"
                );
            }
            return new BatchEntry(key, value, true);
        }
        throw new RuntimeException(
            "entry " + index + " has flag " + flag + ", which is neither a "
            + "write (" + BATCH_WRITE + ") nor a delete (" + BATCH_DELETE + ")"
        );
    }

    /**
     * A big-endian unsigned 32-bit length, as a long. Java has no
     * unsigned int, so a length above 2^31 read into an int would be
     * negative and pass a bounds check it should fail.
     */
    private static long readUint32(final byte[] framed, final int pos) {
        return ((long) (framed[pos] & 0xff) << 24)
            | ((long) (framed[pos + 1] & 0xff) << 16)
            | ((long) (framed[pos + 2] & 0xff) << 8)
            | (framed[pos + 3] & 0xff);
    }

    /** Base64 for the return path. A delete's null value encodes as "". */
    private static String encode(final byte[] data) {
        if (data == null) {
            return "";
        }
        return Base64.getEncoder().encodeToString(data);
    }

    // -----------------------------------------------------------------------
    // Resilient idempotent Tier 3 history import (protocol idempotent-v1)
    //
    // The functions above replay a record by writing it. Replayed twice —
    // after a submit that timed out but committed, or a restart from a stale
    // checkpoint — they write it twice, and the destination's history is a
    // version longer than the source's. The functions below close that: every
    // history mutation is paired with a receipt keyed by an operation ID over
    // the immutable source identity, and the receipt is read (into the
    // transaction's read set, so the pairing is enforced under MVCC) and
    // written in the same transaction as the mutation. A record already
    // applied under the same intent is a no-op; one whose operation ID
    // reappears with a different intent is refused rather than silently
    // overwritten. The operation ID and the intent commitment are HMACs the
    // client computes under a key this contract never sees; the contract
    // stores the intent as an opaque 32-byte receipt and compares it on
    // re-submit.
    // -----------------------------------------------------------------------

    /**
     * Record the plan digest a scope's history import runs under, or confirm
     * an existing one matches.
     *
     * <p>The plan digest binds everything a run must not change midway —
     * protocol version, scope, the key commitment, the ordered input file
     * hashes, the source network, channel and collection routing,
     * embedSourceMetadata and the migration contract — into one SHA-256 the
     * client computes. Operational batch size is not part of the plan because
     * changing it does not alter any record's destination intent. This stores
     * it under the scope; every subsequent import reads it back and refuses if
     * the digest it carries disagrees. Re-initialising with the same digest is
     * a no-op, so a restarted run may call it again safely; a different digest
     * because its writes would mix with the first plan's under the same
     * receipts. A new plan needs a new scope.
     */
    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void InitializeHistoryImport(final Context ctx,
                                        final String scope,
                                        final String planDigest) {
        requireWriter(ctx);
        validateScope(scope);
        byte[] digest = decodeDigest("planDigest", planDigest);
        ChaincodeStub stub = ctx.getStub();
        String planKey =
            stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, scope).toString();
        byte[] existing = stub.getState(planKey);
        if (existing != null && existing.length > 0) {
            if (Arrays.equals(existing, digest)) {
                return;
            }
            throw new RuntimeException(
                "scope " + scope + " already has a history import plan with a "
                + "different digest; a changed plan under the same scope is "
                + "refused. Use a new scope for a new plan"
            );
        }
        stub.putState(planKey, digest);
    }

    /**
     * Apply one Tier 3 history record — public or private, write or delete —
     * exactly once under its scope.
     *
     * <p>The mutation travels as one transient envelope under
     * {@code history_entry}, framed as ../README.md describes: a one-byte
     * kind, then a uint32-delimited collection (empty for public), key and
     * value (empty for a delete). {@code operationId} and {@code intentDigest}
     * are 64 lowercase hex characters, opaque to this contract: the
     * {@code operationId} identifies the immutable source record and keys the
     * receipt, and the {@code intentDigest} is stored as the receipt and
     * compared on re-submit.
     */
    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void ImportHistory(final Context ctx,
                              final String scope,
                              final String planDigest,
                              final String operationId,
                              final String intentDigest) {
        requireWriter(ctx);
        requirePlan(ctx, scope, planDigest);
        validateHexDigest("operationId", operationId);
        byte[] intent = decodeDigest("intentDigest", intentDigest);
        HistoryEntry entry =
            parseHistoryEnvelope(transientValue(ctx, HISTORY_ENTRY_TRANSIENT));
        ChaincodeStub stub = ctx.getStub();
        applyHistoryMutation(ctx, scope, operationId, intent, () -> {
            switch (entry.kind) {
                case ENVELOPE_PUBLIC_WRITE:
                    stub.putState(entry.key, entry.value);
                    break;
                case ENVELOPE_PUBLIC_DELETE:
                    stub.delState(entry.key);
                    break;
                case ENVELOPE_PRIVATE_WRITE:
                    stub.putPrivateData(
                        entry.collection, entry.key, entry.value
                    );
                    break;
                case ENVELOPE_PRIVATE_DELETE:
                    stub.delPrivateData(entry.collection, entry.key);
                    break;
                default:
                    // parseHistoryEnvelope has already refused any other kind.
                    throw new RuntimeException(
                        "unreachable history entry kind " + entry.kind
                    );
            }
        });
    }

    /**
     * Apply many public history records in one transaction, each exactly once
     * under its scope.
     *
     * <p>The batch travels as one transient blob under
     * {@code public_history_batch}. Every entry is applied through the same
     * receipt check ImportHistory uses, so a batch that overlaps an
     * already-applied one applies only its new entries and reports the rest as
     * the no-ops they are.
     */
    @Transaction(intent = Transaction.TYPE.SUBMIT)
    public void ImportHistoryBatch(final Context ctx,
                                   final String scope,
                                   final String planDigest) {
        requireWriter(ctx);
        requirePlan(ctx, scope, planDigest);
        List<HistoryBatchEntry> entries =
            parseHistoryBatch(transientValue(ctx, HISTORY_BATCH_TRANSIENT));
        ChaincodeStub stub = ctx.getStub();
        for (HistoryBatchEntry entry : entries) {
            applyHistoryMutation(
                ctx, scope, entry.operationId, entry.intent, () -> {
                    if (entry.isDelete) {
                        stub.delState(entry.key);
                    } else {
                        stub.putState(entry.key, entry.value);
                    }
                }
            );
        }
    }

    /**
     * The plan digest recorded for a scope, as
     * {"scope":"...","protocol":"idempotent-v1","planDigest":"&lt;hex&gt;"}. A
     * read, so it is not gated by {@link #WRITER_MSP_IDS}.
     */
    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String GetHistoryImportPlan(final Context ctx,
                                       final String scope) {
        validateScope(scope);
        ChaincodeStub stub = ctx.getStub();
        String planKey =
            stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, scope).toString();
        byte[] existing = stub.getState(planKey);
        if (existing == null || existing.length == 0) {
            throw new RuntimeException(
                "scope " + scope + " has no history import plan"
            );
        }
        Map<String, Object> plan = new LinkedHashMap<>();
        plan.put("scope", scope);
        plan.put("protocol", HISTORY_PROTOCOL_VERSION);
        plan.put("planDigest", bytesToHex(existing));
        return gson.toJson(plan);
    }

    /**
     * Whether an operation has a receipt under a scope and, if so, the intent
     * it recorded, as
     * {"scope":"...","operationId":"...","exists":true,"intentDigest":"&lt;hex&gt;"}
     * or the same object with {@code "exists":false} and no intent. The adapter
     * reads it to resolve a submit or commit-status error safely: a receipt
     * whose intent matches means the mutation landed, a receipt whose intent
     * differs is a hard failure, and an absent receipt leaves the original
     * failure to stand. A read, so it is not gated by {@link #WRITER_MSP_IDS}.
     */
    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String GetHistoryImportReceipt(final Context ctx,
                                          final String scope,
                                          final String operationId) {
        validateScope(scope);
        validateHexDigest("operationId", operationId);
        ChaincodeStub stub = ctx.getStub();
        String receiptKey = stub.createCompositeKey(
            HISTORY_RECEIPT_OBJECT_TYPE, scope, operationId
        ).toString();
        byte[] existing = stub.getState(receiptKey);
        boolean exists = existing != null && existing.length > 0;
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("scope", scope);
        receipt.put("operationId", operationId);
        receipt.put("exists", exists);
        if (exists) {
            receipt.put("intentDigest", bytesToHex(existing));
        }
        return gson.toJson(receipt);
    }

    /**
     * Describe the protocol this contract implements so a client can confirm
     * the deployed contract speaks it before submitting. A read, so it is not
     * gated by {@link #WRITER_MSP_IDS}.
     */
    @Transaction(intent = Transaction.TYPE.EVALUATE)
    public String HistoryImportProtocol(final Context ctx) {
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("protocol", HISTORY_PROTOCOL_VERSION);
        descriptor.put("digestBytes", DIGEST_BYTES);
        descriptor.put("planObjectType", HISTORY_PLAN_OBJECT_TYPE);
        descriptor.put("receiptObjectType", HISTORY_RECEIPT_OBJECT_TYPE);
        descriptor.put("entryTransient", HISTORY_ENTRY_TRANSIENT);
        descriptor.put("batchTransient", HISTORY_BATCH_TRANSIENT);
        descriptor.put("maxBatchBytes", MAX_BATCH_BYTES);
        return gson.toJson(descriptor);
    }

    /**
     * Read the plan for a scope and refuse unless it exists and matches
     * planDigest. The read puts the plan key in the transaction's read set, so
     * an import is bound under MVCC to the plan version it verified against.
     */
    private static void requirePlan(final Context ctx,
                                    final String scope,
                                    final String planDigest) {
        validateScope(scope);
        byte[] digest = decodeDigest("planDigest", planDigest);
        ChaincodeStub stub = ctx.getStub();
        String planKey =
            stub.createCompositeKey(HISTORY_PLAN_OBJECT_TYPE, scope).toString();
        byte[] existing = stub.getState(planKey);
        if (existing == null || existing.length == 0) {
            throw new RuntimeException(
                "scope " + scope + " has no history import plan; call "
                + "InitializeHistoryImport before importing"
            );
        }
        if (!Arrays.equals(existing, digest)) {
            throw new RuntimeException(
                "the plan digest for scope " + scope + " does not match the "
                + "stored plan; a changed plan under the same scope is refused"
            );
        }
    }

    /**
     * Apply one history mutation exactly once.
     *
     * <p>It reads the receipt for (scope, operationId) first — which places
     * the receipt key in the read set and so binds the outcome to that key's
     * version under MVCC — and then: an existing receipt whose bytes equal
     * this intent is a no-op; one whose bytes differ is refused; and no
     * receipt applies the mutation and writes the 32-byte intent receipt, both
     * in this one transaction, so the ledger never holds one without the
     * other.
     */
    private static void applyHistoryMutation(final Context ctx,
                                             final String scope,
                                             final String operationId,
                                             final byte[] intent,
                                             final Runnable mutate) {
        ChaincodeStub stub = ctx.getStub();
        String receiptKey = stub.createCompositeKey(
            HISTORY_RECEIPT_OBJECT_TYPE, scope, operationId
        ).toString();
        byte[] existing = stub.getState(receiptKey);
        if (existing != null && existing.length > 0) {
            if (Arrays.equals(existing, intent)) {
                return;
            }
            throw new RuntimeException(
                "operation " + operationId + " under scope " + scope
                + " already has a receipt recording a different intent; "
                + "refusing to overwrite it"
            );
        }
        mutate.run();
        stub.putState(receiptKey, intent);
    }

    /**
     * Decode the single-entry envelope, refusing anything it cannot read
     * exactly. The collection, key and value are length-delimited bytes and
     * never transaction arguments: a private collection name and key would
     * otherwise reach the public transaction arguments, and a value passed as
     * a string argument would be UTF-8-mangled, the reason PutState takes its
     * value as transient data too.
     */
    private static HistoryEntry parseHistoryEnvelope(final byte[] framed) {
        if (framed.length < 1) {
            throw new RuntimeException("history entry envelope is empty");
        }
        int kind = framed[0] & 0xff;
        if (kind != ENVELOPE_PUBLIC_WRITE && kind != ENVELOPE_PUBLIC_DELETE
            && kind != ENVELOPE_PRIVATE_WRITE
            && kind != ENVELOPE_PRIVATE_DELETE) {
            throw new RuntimeException(
                "history entry kind " + kind + " is not one of public write ("
                + ENVELOPE_PUBLIC_WRITE + "), public delete ("
                + ENVELOPE_PUBLIC_DELETE + "), private write ("
                + ENVELOPE_PRIVATE_WRITE + ") or private delete ("
                + ENVELOPE_PRIVATE_DELETE + ")"
            );
        }

        int pos = 1;
        byte[] collection = readField(framed, pos, "history entry", "collection");
        pos += BATCH_LENGTH_BYTES + collection.length;
        byte[] key = readField(framed, pos, "history entry", "key");
        pos += BATCH_LENGTH_BYTES + key.length;
        byte[] value = readField(framed, pos, "history entry", "value");
        pos += BATCH_LENGTH_BYTES + value.length;
        if (pos != framed.length) {
            throw new RuntimeException(
                "history entry has " + (framed.length - pos)
                + " bytes left over after its fields"
            );
        }

        boolean isPrivate = kind == ENVELOPE_PRIVATE_WRITE
            || kind == ENVELOPE_PRIVATE_DELETE;
        boolean isDelete = kind == ENVELOPE_PUBLIC_DELETE
            || kind == ENVELOPE_PRIVATE_DELETE;
        if (key.length == 0) {
            throw new RuntimeException("history entry has an empty key");
        }
        if (isPrivate) {
            if (collection.length == 0) {
                throw new RuntimeException(
                    "history entry kind " + kind
                    + " is private but names no collection"
                );
            }
        } else if (collection.length > 0) {
            throw new RuntimeException(
                "history entry kind " + kind + " is public but carries a "
                + collection.length + "-byte collection"
            );
        }
        if (isDelete && value.length > 0) {
            throw new RuntimeException(
                "history entry kind " + kind + " is a delete carrying "
                + value.length + " value bytes"
            );
        }
        return new HistoryEntry(
            kind, new String(collection, StandardCharsets.UTF_8),
            new String(key, StandardCharsets.UTF_8), value
        );
    }

    /**
     * Decode the public history batch, refusing anything it cannot read
     * exactly. The batch is public only — private data is never batched, for
     * the disclosure reason PutStateBatch documents — so it carries no
     * collection. Each entry begins with 32 raw operation-ID bytes and 32 raw
     * intent bytes, then a uint32-delimited key, a one-byte flag (0 write, 1
     * delete) and a uint32-delimited value (empty for a delete).
     */
    private static List<HistoryBatchEntry> parseHistoryBatch(
        final byte[] framed) {
        if (framed.length > MAX_BATCH_BYTES) {
            throw new RuntimeException(
                "history batch of " + framed.length + " bytes exceeds the "
                + MAX_BATCH_BYTES + "-byte limit; lower "
                + "chaincode.writeBatchSize"
            );
        }
        if (framed.length < BATCH_HEADER_BYTES) {
            throw new RuntimeException(
                "history batch of " + framed.length + " bytes is shorter than "
                + "its " + BATCH_HEADER_BYTES + "-byte entry count"
            );
        }
        long count = readUint32(framed, 0);
        if (count == 0) {
            throw new RuntimeException(
                "history batch declares no entries, which would report success "
                + "for records that never landed"
            );
        }
        // Each entry costs at least the two digests, the two lengths and the
        // flag, with an empty key and value.
        long minEntryBytes =
            2L * DIGEST_BYTES + BATCH_LENGTH_BYTES + 1 + BATCH_LENGTH_BYTES;
        if (count > (framed.length - BATCH_HEADER_BYTES) / minEntryBytes) {
            throw new RuntimeException(
                "history batch declares " + count + " entries, which cannot "
                + "fit in " + framed.length + " bytes"
            );
        }

        List<HistoryBatchEntry> entries = new ArrayList<>();
        Set<String> seenKeys = new HashSet<>();
        Set<String> seenOps = new HashSet<>();
        int pos = BATCH_HEADER_BYTES;
        for (long i = 0; i < count; i++) {
            HistoryBatchEntry entry = parseHistoryBatchEntry(framed, pos, i);
            if (!seenKeys.add(entry.key)) {
                throw new RuntimeException(
                    "history batch names key " + entry.key + " twice, at entry "
                    + i + "; a transaction records one version per key, so two "
                    + "versions of one key cannot share a batch"
                );
            }
            if (!seenOps.add(entry.operationId)) {
                throw new RuntimeException(
                    "history batch names operation " + entry.operationId
                    + " twice, at entry " + i
                );
            }
            entries.add(entry);
            pos = entry.next;
        }
        if (pos != framed.length) {
            throw new RuntimeException(
                "history batch has " + (framed.length - pos)
                + " bytes left over after its " + count + " entries"
            );
        }
        return entries;
    }

    /**
     * Read one public history batch entry at pos, recording where the next one
     * begins in the returned entry's {@code next}.
     */
    private static HistoryBatchEntry parseHistoryBatchEntry(final byte[] framed,
                                                            final int pos,
                                                            final long index) {
        if (pos + 2 * DIGEST_BYTES > framed.length) {
            throw new RuntimeException(
                "entry " + index + " ends before its operation ID and intent"
            );
        }
        String operationId =
            bytesToHex(Arrays.copyOfRange(framed, pos, pos + DIGEST_BYTES));
        byte[] intent =
            Arrays.copyOfRange(framed, pos + DIGEST_BYTES, pos + 2 * DIGEST_BYTES);
        int p = pos + 2 * DIGEST_BYTES;
        String context = "entry " + index;

        byte[] key = readField(framed, p, context, "key");
        p += BATCH_LENGTH_BYTES + key.length;
        if (p >= framed.length) {
            throw new RuntimeException(
                "entry " + index + " ends before its write/delete flag"
            );
        }
        int flag = framed[p] & 0xff;
        p += 1;
        byte[] value = readField(framed, p, context, "value");
        p += BATCH_LENGTH_BYTES + value.length;
        if (key.length == 0) {
            throw new RuntimeException("entry " + index + " has an empty key");
        }

        String keyStr = new String(key, StandardCharsets.UTF_8);
        if (flag == BATCH_WRITE) {
            return new HistoryBatchEntry(
                operationId, intent, keyStr, value, false, p
            );
        }
        if (flag == BATCH_DELETE) {
            if (value.length > 0) {
                throw new RuntimeException(
                    "entry " + index + " is a delete carrying " + value.length
                    + " value bytes"
                );
            }
            return new HistoryBatchEntry(
                operationId, intent, keyStr, new byte[0], true, p
            );
        }
        throw new RuntimeException(
            "entry " + index + " has flag " + flag + ", which is neither a "
            + "write (" + BATCH_WRITE + ") nor a delete (" + BATCH_DELETE + ")"
        );
    }

    /**
     * Read one uint32-length-delimited field, refusing a length the blob
     * cannot hold rather than clamping it. {@code context} names the entry for
     * the error message.
     */
    private static byte[] readField(final byte[] framed, final int pos,
                                    final String context, final String name) {
        if (pos + BATCH_LENGTH_BYTES > framed.length) {
            throw new RuntimeException(
                context + " ends before its " + name + " length"
            );
        }
        long size = readUint32(framed, pos);
        int start = pos + BATCH_LENGTH_BYTES;
        if (size > framed.length - start) {
            throw new RuntimeException(
                context + " declares a " + size + "-byte " + name + " but only "
                + (framed.length - start) + " bytes remain"
            );
        }
        return Arrays.copyOfRange(framed, start, start + (int) size);
    }

    /** Whether s is entirely lowercase hexadecimal. */
    private static boolean isLowerHex(final String s) {
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    /** Refuse a scope that is not 32-64 lowercase hex characters. */
    private static void validateScope(final String scope) {
        if (scope.length() < 32 || scope.length() > 64 || !isLowerHex(scope)) {
            throw new RuntimeException(
                "scope must be 32-64 lowercase hex characters, got "
                + scope.length()
            );
        }
    }

    /**
     * Refuse a digest argument that is not exactly DIGEST_BYTES as lowercase
     * hex.
     */
    private static void validateHexDigest(final String name, final String s) {
        if (s.length() != 2 * DIGEST_BYTES || !isLowerHex(s)) {
            throw new RuntimeException(
                name + " must be " + (2 * DIGEST_BYTES)
                + " lowercase hex characters"
            );
        }
    }

    /** Validate and decode a DIGEST_BYTES-long lowercase hex digest. */
    private static byte[] decodeDigest(final String name, final String s) {
        validateHexDigest(name, s);
        return hexToBytes(s);
    }

    /** Decode a lowercase hex string of even length to its bytes. */
    private static byte[] hexToBytes(final String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(
                s.substring(2 * i, 2 * i + 2), 16
            );
        }
        return out;
    }

    /** Encode bytes as lowercase hex. */
    private static String bytesToHex(final byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            sb.append(Character.forDigit((x >> 4) & 0xf, 16));
            sb.append(Character.forDigit(x & 0xf, 16));
        }
        return sb.toString();
    }

    /** One parsed single-entry envelope. */
    private static final class HistoryEntry {
        private final int kind;
        private final String collection;
        private final String key;
        private final byte[] value;

        HistoryEntry(final int kind, final String collection,
                     final String key, final byte[] value) {
            this.kind = kind;
            this.collection = collection;
            this.key = key;
            this.value = value;
        }
    }

    /**
     * One parsed public history record from a framed batch. {@code next}
     * records where the following entry begins, since Java has no multiple
     * return.
     */
    private static final class HistoryBatchEntry {
        private final String operationId;
        private final byte[] intent;
        private final String key;
        private final byte[] value;
        private final boolean isDelete;
        private final int next;

        HistoryBatchEntry(final String operationId, final byte[] intent,
                          final String key, final byte[] value,
                          final boolean isDelete, final int next) {
            this.operationId = operationId;
            this.intent = intent;
            this.key = key;
            this.value = value;
            this.isDelete = isDelete;
            this.next = next;
        }
    }
}
