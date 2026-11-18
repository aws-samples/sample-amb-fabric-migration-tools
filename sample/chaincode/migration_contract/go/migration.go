// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

package migration

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// writerMSPIDs are the MSP IDs allowed to write through this contract.
//
// Set this before packaging. Every write function refuses an MSP that is
// not named here, and the empty list this file ships with refuses all of
// them, because this contract is a deliberate bypass of the application's
// own invariants — PutState writes any key with any value — and the
// organizations running the migration are the only ones that should hold
// it. Naming them in the source rather than in state or an environment
// variable makes the list part of the package every org approves through
// the chaincode lifecycle, so it cannot be widened by whoever can reach
// the peer.
//
// Name every MSP whose identity submits, not only the one that owns the
// endorsing peer: a member replaying the private collections it can read
// signs with its own MSP while submitting through a gateway that may
// belong to another org (chaincode.collectionIdentities in the replay
// config).
var writerMSPIDs = []string{}

// requireWriter refuses a write from an MSP writerMSPIDs does not name.
//
// Reads are deliberately not gated: they cannot change the ledger, a
// private read is already bounded by the collection policy, and verify
// may legitimately run as an identity that is not allowed to write.
func requireWriter(ctx contractapi.TransactionContextInterface) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to read the submitting MSP ID: %w", err)
	}
	for _, allowed := range writerMSPIDs {
		if mspID == allowed {
			return nil
		}
	}

	if len(writerMSPIDs) == 0 {
		return fmt.Errorf(
			"%s may not write migration data: writerMSPIDs is empty, so "+
				"every write is refused. Set it in migration.go to the MSP "+
				"IDs the migration submits as, then package and commit the "+
				"chaincode",
			mspID,
		)
	}
	return fmt.Errorf(
		"%s may not write migration data; writerMSPIDs names %s. Add it "+
			"there, then package and commit the chaincode",
		mspID, strings.Join(writerMSPIDs, ", "),
	)
}

// MigrationContract provides the functions required by the
// the migration toolkit's replay and verify commands. Add it to your
// existing chaincode package and set writerMSPIDs above — no changes to
// your application logic:
//
//   chaincode, _ := contractapi.NewChaincode(&MyContract{}, &migration.MigrationContract{})
//
// After migration, remove the import and upgrade the chaincode.
type MigrationContract struct {
	contractapi.Contract
}

// PutState writes an arbitrary key-value pair to the public ledger.
// Used by the replay adapter for public state and history records.
//
// The value arrives as transient data under "public_value", not as a
// transaction argument. Transient data is bytes on the wire, so the
// exact source ledger bytes reach PutState in every contract-api
// language; a string argument would be UTF-8-decoded by the Node and
// Java shims first, and any byte sequence that is not valid UTF-8
// would be written here as U+FFFD.
func (m *MigrationContract) PutState(
	ctx contractapi.TransactionContextInterface,
	key string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	value, err := transientValue(ctx, "public_value")
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, value)
}

// maxBatchBytes bounds the framed batch PutStateBatch will accept.
//
// A batch is one transaction, so its write set reaches the orderer as
// one envelope and is refused whole if it is larger than the channel's
// AbsoluteMaxBytes — 10 MiB in Fabric's default configtx.yaml, and less
// on a channel whose operator tightened it. This is a fifth of that
// default: a batch is a throughput optimisation, and sailing close to a
// limit that rejects the whole transaction would trade a bounded gain
// for an unbounded failure.
//
// The bound is on the framed blob rather than on value bytes alone
// because the blob is what travels, and it is one comparison to make
// before anything is parsed.
const maxBatchBytes = 2 * 1024 * 1024

// Framing widths. These must match src/replay/state-batch.ts, which is
// the only encoder.
const (
	batchHeaderBytes = 4
	batchLengthBytes = 4
	// What an entry costs besides its key and value.
	batchEntryOtherBytes = batchLengthBytes + 1 + batchLengthBytes
)

// Per-entry flag values.
const (
	batchWrite  = 0
	batchDelete = 1
)

// PutStateBatch writes many public keys in one transaction.
//
// A transaction costs an endorsement round trip plus an ordering and
// commit wait whatever it carries, so a tier-3 history replay that
// submits one transaction per version does not finish in any window an
// operator would accept. This amortises that cost across every key in
// the batch.
//
// The batch arrives as transient data under "public_batch", framed as
// described in ../README.md: a uint32 entry count, then per entry a
// uint32 key length, the key, a one-byte flag (0 write, 1 delete), a
// uint32 value length and the value, all unsigned big-endian. Values
// travel as bytes here for the reason PutState's does — a String
// argument would be UTF-8-decoded by the Node and Java shims — and the
// keys travel with them because one length-delimited blob says how many
// writes it holds, where a transient entry per record does not.
//
// Two versions of one key must not share a batch, and parseBatch
// refuses one that does: a transaction's write set holds one value per
// key, so the earlier version would be dropped and the destination's
// history would be a version short of the source's.
func (m *MigrationContract) PutStateBatch(
	ctx contractapi.TransactionContextInterface,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	framed, err := transientValue(ctx, "public_batch")
	if err != nil {
		return err
	}
	entries, err := parseBatch(framed)
	if err != nil {
		return err
	}

	stub := ctx.GetStub()
	for _, entry := range entries {
		if entry.isDelete {
			if err := stub.DelState(entry.key); err != nil {
				return fmt.Errorf("failed to delete %s: %w", entry.key, err)
			}
			continue
		}
		if err := stub.PutState(entry.key, entry.value); err != nil {
			return fmt.Errorf("failed to write %s: %w", entry.key, err)
		}
	}
	return nil
}

// batchEntry is one parsed write or tombstone.
type batchEntry struct {
	key      string
	value    []byte
	isDelete bool
}

// parseBatch decodes a framed batch, refusing anything it cannot read
// exactly.
//
// Every refusal names the entry it stopped at: a framing disagreement
// is a bug in the client or in this contract, and the entry index is
// what locates it. Nothing is written until the whole batch has parsed,
// so a blob that runs out halfway leaves the destination holding none
// of it rather than a prefix the client counted as failed.
func parseBatch(framed []byte) ([]batchEntry, error) {
	if len(framed) > maxBatchBytes {
		return nil, fmt.Errorf(
			"batch of %d bytes exceeds the %d-byte limit, so it may be too "+
				"large to order; lower chaincode.writeBatchSize",
			len(framed), maxBatchBytes,
		)
	}
	if len(framed) < batchHeaderBytes {
		return nil, fmt.Errorf(
			"batch of %d bytes is shorter than its %d-byte entry count",
			len(framed), batchHeaderBytes,
		)
	}

	count := int64(binary.BigEndian.Uint32(framed[:batchHeaderBytes]))
	if count == 0 {
		return nil, errors.New(
			"batch declares no entries, which would report success for " +
				"records that never landed",
		)
	}
	if count > int64(len(framed)-batchHeaderBytes)/batchEntryOtherBytes {
		return nil, fmt.Errorf(
			"batch declares %d entries, which cannot fit in %d bytes",
			count, len(framed),
		)
	}

	entries := make([]batchEntry, 0, count)
	seen := make(map[string]struct{}, count)
	pos := batchHeaderBytes
	for i := int64(0); i < count; i++ {
		entry, next, err := parseBatchEntry(framed, pos, i)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[entry.key]; duplicate {
			return nil, fmt.Errorf(
				"batch names key %s twice, at entry %d; a transaction records "+
					"one version per key, so two versions of one key cannot "+
					"share a batch",
				entry.key, i,
			)
		}
		seen[entry.key] = struct{}{}
		entries = append(entries, entry)
		pos = next
	}

	if pos != len(framed) {
		return nil, fmt.Errorf(
			"batch has %d bytes left over after its %d entries",
			len(framed)-pos, count,
		)
	}
	return entries, nil
}

// parseBatchEntry reads the entry at pos, returning it and where the
// next one begins.
func parseBatchEntry(
	framed []byte, pos int, index int64,
) (batchEntry, int, error) {
	key, afterKey, err := takeBatchField(framed, pos, index, "key")
	if err != nil {
		return batchEntry{}, 0, err
	}
	if afterKey >= len(framed) {
		return batchEntry{}, 0, fmt.Errorf(
			"entry %d ends before its write/delete flag", index,
		)
	}
	flag := framed[afterKey]
	value, next, err := takeBatchField(framed, afterKey+1, index, "value")
	if err != nil {
		return batchEntry{}, 0, err
	}

	switch flag {
	case batchWrite:
		return batchEntry{key: string(key), value: value}, next, nil
	case batchDelete:
		// A tombstone and a write of the empty value are different
		// ledger facts, so a delete carrying a value is a framing
		// disagreement rather than a value to drop.
		if len(value) > 0 {
			return batchEntry{}, 0, fmt.Errorf(
				"entry %d is a delete carrying %d value bytes",
				index, len(value),
			)
		}
		return batchEntry{key: string(key), isDelete: true}, next, nil
	}
	return batchEntry{}, 0, fmt.Errorf(
		"entry %d has flag %d, which is neither a write (%d) nor a "+
			"delete (%d)",
		index, flag, batchWrite, batchDelete,
	)
}

// takeBatchField reads one length-delimited field, returning it and
// where the next begins. Lengths are compared in int64 so that a length
// this blob cannot hold is refused rather than sliced.
func takeBatchField(
	framed []byte, pos int, index int64, name string,
) ([]byte, int, error) {
	if pos+batchLengthBytes > len(framed) {
		return nil, 0, fmt.Errorf(
			"entry %d ends before its %s length", index, name,
		)
	}
	size := int64(binary.BigEndian.Uint32(framed[pos : pos+batchLengthBytes]))
	start := pos + batchLengthBytes
	if size > int64(len(framed)-start) {
		return nil, 0, fmt.Errorf(
			"entry %d declares a %d-byte %s but only %d bytes remain",
			index, size, name, len(framed)-start,
		)
	}
	return framed[start : start+int(size)], start + int(size), nil
}

// ImportPrivateDataBatch writes many keys of one private data collection
// in one transaction.
//
// The batch arrives as transient data under "private_batch", in exactly
// the framing PutStateBatch reads, and is parsed by the same parseBatch,
// so it is refused for the same malformations — including a key named
// twice. One collection per call is the whole point of the shape:
// transient data reaches every endorsing peer, and a batch confined to
// one collection is endorsed by the same peers, and discloses its values
// to the same members, as a single ImportPrivateData would.
func (m *MigrationContract) ImportPrivateDataBatch(
	ctx contractapi.TransactionContextInterface,
	collection string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	framed, err := transientValue(ctx, "private_batch")
	if err != nil {
		return err
	}
	entries, err := parseBatch(framed)
	if err != nil {
		return err
	}

	stub := ctx.GetStub()
	for _, entry := range entries {
		if entry.isDelete {
			if err := stub.DelPrivateData(collection, entry.key); err != nil {
				return fmt.Errorf("failed to delete %s/%s: %w", collection, entry.key, err)
			}
			continue
		}
		if err := stub.PutPrivateData(collection, entry.key, entry.value); err != nil {
			return fmt.Errorf("failed to write %s/%s: %w", collection, entry.key, err)
		}
	}
	return nil
}

// ImportPrivateData writes a key to a private data collection.
// The value is passed as transient data under "private_value" to
// keep it off the public ledger.
func (m *MigrationContract) ImportPrivateData(
	ctx contractapi.TransactionContextInterface,
	collection string,
	key string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	value, err := transientValue(ctx, "private_value")
	if err != nil {
		return err
	}
	return ctx.GetStub().PutPrivateData(collection, key, value)
}

// transientValue reads one entry from the transaction's transient map.
//
// An absent entry is an error rather than an empty write: the replay
// adapter always sends one, so a missing entry means the caller and
// this contract disagree about the wire contract, and writing an empty
// value would record that disagreement in the ledger as data.
func transientValue(
	ctx contractapi.TransactionContextInterface,
	name string,
) ([]byte, error) {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("failed to get transient data: %w", err)
	}

	value, ok := transient[name]
	if !ok {
		return nil, fmt.Errorf("%s not found in transient data", name)
	}
	return value, nil
}

// DeleteState removes a key from the public ledger. Used by the
// replay adapter to replay delete operations from history.
func (m *MigrationContract) DeleteState(
	ctx contractapi.TransactionContextInterface,
	key string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	return ctx.GetStub().DelState(key)
}

// DeletePrivateData removes a key from a private data collection.
// Used by the replay adapter to replay private delete operations.
func (m *MigrationContract) DeletePrivateData(
	ctx contractapi.TransactionContextInterface,
	collection string,
	key string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	return ctx.GetStub().DelPrivateData(collection, key)
}

// maxHistoryValueBytes bounds what GetKeyHistory accumulates before it
// refuses to answer.
//
// Fabric has no paginated history API. GetHistoryForKey returns one
// iterator over every version of a key and there is no offset to resume
// from, so a very deep history has to be returned whole or refused.
// Returned whole, it eventually crosses the peer's gRPC message limit
// (100 MB by default) and reaches the operator as a transport error
// naming no key; refused here, it names the key.
//
// Truncating to a page is the one thing this must not do. Verify
// compares the whole sequence, so a prefix that compared equal would be
// reported as a match for a history nothing checked past the cut.
//
// The bound is on value bytes rather than on a version count because
// that is what the message limit measures. The base64 response is about
// four thirds of it, plus roughly thirty bytes of JSON per entry.
const maxHistoryValueBytes = 8 * 1024 * 1024

// GetKeyHistory returns the full write history for a key as a JSON
// array of {"value":"<base64>","isDelete":bool} objects, in the order
// GetHistoryForKey yields them — newest-first on CouchDB, oldest-first
// on LevelDB. Verify orders it by the destination's state database
// before comparing. Required for Tier 3 history verification.
//
// Values are base64 for the same reason ReadState's are. Declaring the
// field as []byte is what produces that: encoding/json base64-encodes
// a []byte field, unconditionally and for text as much as for binary,
// so there is one encoding to decode rather than a guess per entry.
func (m *MigrationContract) GetKeyHistory(
	ctx contractapi.TransactionContextInterface,
	key string,
) (string, error) {
	iter, err := ctx.GetStub().GetHistoryForKey(key)
	if err != nil {
		return "", fmt.Errorf(
			"failed to get history for %s: %w", key, err,
		)
	}
	defer iter.Close()

	type entry struct {
		Value    []byte `json:"value"`
		IsDelete bool   `json:"isDelete"`
	}
	var entries []entry
	total := 0
	for iter.HasNext() {
		mod, err := iter.Next()
		if err != nil {
			return "", fmt.Errorf("history iterator error: %w", err)
		}
		// A delete carries no value. Marshalled as a nil []byte it
		// would emit null, so it is normalised to the empty string
		// every other language's encoder produces.
		value := mod.Value
		if value == nil {
			value = []byte{}
		}
		total += len(value)
		if total > maxHistoryValueBytes {
			return "", fmt.Errorf(
				"history for %s exceeds %d value bytes at version %d, so "+
					"it cannot be returned in one response. Fabric has no "+
					"paginated history API to fetch the rest with, so this "+
					"key has to be checked against the destination by hand",
				key, maxHistoryValueBytes, len(entries)+1,
			)
		}
		entries = append(entries, entry{
			Value:    value,
			IsDelete: mod.IsDelete,
		})
	}
	if entries == nil {
		entries = []entry{}
	}
	result, err := json.Marshal(entries)
	if err != nil {
		return "", fmt.Errorf("failed to marshal history: %w", err)
	}
	return string(result), nil
}

// ReadState returns the value of a public key, base64-encoded, without
// any key transformation. Used by the verify command when the
// application's read function applies key prefixes or formatting.
//
// Base64 on the return path is not symmetry with the write path's
// transient data — there is no transient channel on a return value.
// It is because a return value's byte safety would otherwise depend on
// each shim's serializer: the Node and Java shims re-encode a returned
// String as UTF-8, so a binary value would fail verification even when
// the destination ledger holds the correct bytes, and the mismatch
// report would point at the ledger and be wrong. Base64 makes byte
// safety a property of the encoding instead, identical in all three
// languages.
func (m *MigrationContract) ReadState(
	ctx contractapi.TransactionContextInterface,
	key string,
) (string, error) {
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", fmt.Errorf("failed to read %s: %w", key, err)
	}
	if data == nil {
		return "", fmt.Errorf("key %s does not exist", key)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ReadPrivateData returns the value of a key from a private data
// collection, base64-encoded. Used by the verify command to compare
// extracted values against the destination.
func (m *MigrationContract) ReadPrivateData(
	ctx contractapi.TransactionContextInterface,
	collection string,
	key string,
) (string, error) {
	data, err := ctx.GetStub().GetPrivateData(collection, key)
	if err != nil {
		return "", fmt.Errorf(
			"failed to read %s/%s: %w", collection, key, err,
		)
	}
	if data == nil {
		return "", fmt.Errorf(
			"private data %s/%s does not exist", collection, key,
		)
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ReadPrivateDataHash returns the destination's own SHA-256 hash of a
// private key's value, base64-encoded. It answers for a collection the
// caller cannot read.
//
// A private-data hash is public channel data: Fabric writes it into the
// block's collection_hashed_rwset, every peer commits it, and the peer
// applies the collection's read policy to GetPrivateData but not to
// this. So a caller that is not a collection member — or whose gateway
// peer belongs to an org that is not — gets the hash where
// GetPrivateData gets nothing.
//
// That is exactly the case verify has in a multi-member migration. It
// connects one identity, a merged extraction holds collections that
// identity is not a member of, and without this every one of their keys
// is reported missing: a false loss report over data that is present
// and correct. A hash comparison is the same evidence Fabric itself
// relies on for a non-member — it proves the destination holds the
// identical bytes without disclosing them.
//
// Base64 rather than hex only because every other read on this contract
// returns base64, so the client has one decoder rather than two.
func (m *MigrationContract) ReadPrivateDataHash(
	ctx contractapi.TransactionContextInterface,
	collection string,
	key string,
) (string, error) {
	hash, err := ctx.GetStub().GetPrivateDataHash(collection, key)
	if err != nil {
		return "", fmt.Errorf(
			"failed to read the hash of %s/%s: %w", collection, key, err,
		)
	}
	if len(hash) == 0 {
		return "", fmt.Errorf(
			"private data %s/%s does not exist", collection, key,
		)
	}
	return base64.StdEncoding.EncodeToString(hash), nil
}

// ListKeys returns one page of the keys in this chaincode's public
// namespace as a JSON {"keys":["<base64>",...],"bookmark":"..."} object.
// Pass a returned bookmark back to fetch the next page; an empty
// bookmark means the last one. Used by the verify command's reverse
// sweep, which asks whether the destination holds public keys the
// extraction does not account for.
//
// Keys are base64 for the reason values are. A ledger key is a byte
// string that is usually text but need not be, and encoding/json
// replaces any byte sequence that is not valid UTF-8 with U+FFFD, so a
// marshalled key would be compared — and reported to the operator — as
// something the destination does not hold.
//
// Only keys are returned, but the range query carries every value from
// the peer to the chaincode, so pageSize bounds that traffic and not
// just the size of this response.
//
// Keys created with Fabric's composite-key API are not returned. They
// begin with U+0000 and an unbounded range query starts at U+0001, which
// is Fabric's own convention rather than a choice made here.
func (m *MigrationContract) ListKeys(
	ctx contractapi.TransactionContextInterface,
	pageSize int32,
	bookmark string,
) (string, error) {
	iter, metadata, err := ctx.GetStub().GetStateByRangeWithPagination(
		"", "", pageSize, bookmark,
	)
	if err != nil {
		return "", fmt.Errorf("failed to list keys: %w", err)
	}
	defer iter.Close()

	keys := []string{}
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return "", fmt.Errorf("key iterator error: %w", err)
		}
		keys = append(
			keys, base64.StdEncoding.EncodeToString([]byte(kv.Key)),
		)
	}

	page := struct {
		Keys     []string `json:"keys"`
		Bookmark string   `json:"bookmark"`
	}{Keys: keys, Bookmark: metadata.Bookmark}
	result, err := json.Marshal(page)
	if err != nil {
		return "", fmt.Errorf("failed to marshal keys: %w", err)
	}
	return string(result), nil
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
// silently overwritten.
//
// Only the destination contract lives here. The operation ID and the intent
// commitment are HMACs the client computes under a key this contract never
// sees; the contract stores the intent as an opaque 32-byte receipt and
// compares it on re-submit. The plan digest is likewise opaque: the contract
// stores it under the scope and refuses an import that carries a different
// one, so a plan that changed midway cannot replay under the first plan's
// receipts.
// ---------------------------------------------------------------------------

const (
	// historyProtocolVersion is the protocol this contract implements. It is
	// the mode name the replay config's historyImport block carries, and
	// HistoryImportProtocol reports it so a client can confirm the deployed
	// contract speaks the same protocol before it submits.
	historyProtocolVersion = "idempotent-v1"

	// Composite-key object types. A plan is keyed by scope alone; a receipt
	// by scope and operation ID, so every operation under a scope has its own
	// receipt and a re-submitted one finds it.
	historyPlanObjectType    = "fabric-amb-extractor-history-plan-v1"
	historyReceiptObjectType = "fabric-amb-extractor-history-receipt-v1"

	// digestBytes is the length of an operation ID, an intent commitment and
	// a plan digest alike — all 32-byte outputs (HMAC-SHA256, HMAC-SHA256 and
	// SHA-256). Function arguments carry them as 64 lowercase hex characters;
	// the batch blob carries the operation ID and intent as raw bytes.
	digestBytes = 32

	// Transient keys the two submit functions read their payload from.
	historyEntryTransient = "history_entry"
	historyBatchTransient = "public_history_batch"
)

// History entry envelope kinds. The single-entry ImportHistory envelope
// begins with one of these bytes.
const (
	envelopePublicWrite   = 0
	envelopePublicDelete  = 1
	envelopePrivateWrite  = 2
	envelopePrivateDelete = 3
)

// isLowerHex reports whether s is entirely lowercase hexadecimal.
func isLowerHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// validateScope refuses a scope that is not 32-64 lowercase hex characters.
func validateScope(scope string) error {
	if len(scope) < 32 || len(scope) > 64 || !isLowerHex(scope) {
		return fmt.Errorf(
			"scope must be 32-64 lowercase hex characters, got %d", len(scope),
		)
	}
	return nil
}

// validateHexDigest refuses a digest argument that is not exactly digestBytes
// as lowercase hex.
func validateHexDigest(name, s string) error {
	if len(s) != 2*digestBytes || !isLowerHex(s) {
		return fmt.Errorf(
			"%s must be %d lowercase hex characters", name, 2*digestBytes,
		)
	}
	return nil
}

// decodeDigest validates and decodes a digestBytes-long lowercase hex digest.
func decodeDigest(name, s string) ([]byte, error) {
	if err := validateHexDigest(name, s); err != nil {
		return nil, err
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("failed to decode %s: %w", name, err)
	}
	return b, nil
}

// InitializeHistoryImport records the plan digest a scope's history import
// runs under, or confirms an existing one matches.
//
// The plan digest binds everything a run must not change midway — protocol
// version, scope, the key commitment, the ordered input file hashes, the
// source network, channel and collection routing, embedSourceMetadata and the
// migration contract — into one SHA-256 the client computes. Operational batch
// size is not part of the plan, because changing it does not change any record's
// destination intent and is a safe way to recover from an oversized batch. This
// stores the digest under the scope; every subsequent import reads it back and
// digest it carries disagrees. Re-initialising with the same digest is a
// no-op, so a restarted run may call it again safely; a different digest under
// a scope that already has one is refused, because its writes would mix with
// the first plan's under the same receipts. A new plan needs a new scope.
func (m *MigrationContract) InitializeHistoryImport(
	ctx contractapi.TransactionContextInterface,
	scope string,
	planDigest string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	if err := validateScope(scope); err != nil {
		return err
	}
	digest, err := decodeDigest("planDigest", planDigest)
	if err != nil {
		return err
	}

	stub := ctx.GetStub()
	planKey, err := stub.CreateCompositeKey(
		historyPlanObjectType, []string{scope},
	)
	if err != nil {
		return fmt.Errorf(
			"failed to build the plan key for scope %s: %w", scope, err,
		)
	}
	existing, err := stub.GetState(planKey)
	if err != nil {
		return fmt.Errorf("failed to read the plan for scope %s: %w", scope, err)
	}
	if existing != nil {
		if bytes.Equal(existing, digest) {
			return nil
		}
		return fmt.Errorf(
			"scope %s already has a history import plan with a different "+
				"digest; a changed plan under the same scope is refused. Use "+
				"a new scope for a new plan", scope,
		)
	}
	return stub.PutState(planKey, digest)
}

// requirePlan reads the plan for a scope and refuses unless it exists and
// matches planDigest. The read puts the plan key in the transaction's read
// set, so an import is bound under MVCC to the plan version it verified
// against.
func requirePlan(
	ctx contractapi.TransactionContextInterface,
	scope string,
	planDigest string,
) error {
	if err := validateScope(scope); err != nil {
		return err
	}
	digest, err := decodeDigest("planDigest", planDigest)
	if err != nil {
		return err
	}
	stub := ctx.GetStub()
	planKey, err := stub.CreateCompositeKey(
		historyPlanObjectType, []string{scope},
	)
	if err != nil {
		return fmt.Errorf(
			"failed to build the plan key for scope %s: %w", scope, err,
		)
	}
	existing, err := stub.GetState(planKey)
	if err != nil {
		return fmt.Errorf("failed to read the plan for scope %s: %w", scope, err)
	}
	if existing == nil {
		return fmt.Errorf(
			"scope %s has no history import plan; call InitializeHistoryImport "+
				"before importing", scope,
		)
	}
	if !bytes.Equal(existing, digest) {
		return fmt.Errorf(
			"the plan digest for scope %s does not match the stored plan; a "+
				"changed plan under the same scope is refused", scope,
		)
	}
	return nil
}

// applyHistoryMutation applies one history mutation exactly once.
//
// It reads the receipt for (scope, operationID) first — which places the
// receipt key in the read set and so binds the outcome to that key's version
// under MVCC — and then:
//
//   - an existing receipt whose bytes equal this intent is a no-op: the
//     mutation already landed under this exact intent, so re-submitting it
//     changes nothing and reports success;
//   - an existing receipt whose bytes differ is refused: the same operation
//     ID has already been applied with a different destination intent, a plan
//     or data disagreement the import must not paper over;
//   - no receipt applies the mutation and writes the 32-byte intent receipt,
//     both in this one transaction, so the ledger never holds the mutation
//     without its receipt or the receipt without its mutation.
func applyHistoryMutation(
	ctx contractapi.TransactionContextInterface,
	scope string,
	operationID string,
	intent []byte,
	mutate func() error,
) error {
	stub := ctx.GetStub()
	receiptKey, err := stub.CreateCompositeKey(
		historyReceiptObjectType, []string{scope, operationID},
	)
	if err != nil {
		return fmt.Errorf(
			"failed to build the receipt key for operation %s: %w",
			operationID, err,
		)
	}
	existing, err := stub.GetState(receiptKey)
	if err != nil {
		return fmt.Errorf(
			"failed to read the receipt for operation %s: %w", operationID, err,
		)
	}
	if existing != nil {
		if bytes.Equal(existing, intent) {
			return nil
		}
		return fmt.Errorf(
			"operation %s under scope %s already has a receipt recording a "+
				"different intent; refusing to overwrite it", operationID, scope,
		)
	}
	if err := mutate(); err != nil {
		return err
	}
	return stub.PutState(receiptKey, intent)
}

// historyEntry is one parsed single-entry envelope.
type historyEntry struct {
	kind       byte
	collection string
	key        string
	value      []byte
}

// takeEnvelopeField reads one uint32-length-delimited field from the history
// envelope, returning it and where the next field begins. A length the blob
// cannot hold is refused rather than sliced.
func takeEnvelopeField(
	framed []byte, pos int, name string,
) ([]byte, int, error) {
	if pos+batchLengthBytes > len(framed) {
		return nil, 0, fmt.Errorf(
			"history entry ends before its %s length", name,
		)
	}
	size := int64(binary.BigEndian.Uint32(framed[pos : pos+batchLengthBytes]))
	start := pos + batchLengthBytes
	if size > int64(len(framed)-start) {
		return nil, 0, fmt.Errorf(
			"history entry declares a %d-byte %s but only %d bytes remain",
			size, name, len(framed)-start,
		)
	}
	return framed[start : start+int(size)], start + int(size), nil
}

// parseHistoryEnvelope decodes the single-entry envelope, refusing anything it
// cannot read exactly. The collection, key and value are length-delimited
// bytes and never transaction arguments: a private collection name and key
// would otherwise reach the public transaction arguments, and a value passed
// as a string argument would be UTF-8-mangled, the reason PutState takes its
// value as transient data too.
func parseHistoryEnvelope(framed []byte) (historyEntry, error) {
	if len(framed) < 1 {
		return historyEntry{}, errors.New("history entry envelope is empty")
	}
	kind := framed[0]
	switch kind {
	case envelopePublicWrite, envelopePublicDelete,
		envelopePrivateWrite, envelopePrivateDelete:
	default:
		return historyEntry{}, fmt.Errorf(
			"history entry kind %d is not one of public write (%d), public "+
				"delete (%d), private write (%d) or private delete (%d)",
			kind, envelopePublicWrite, envelopePublicDelete,
			envelopePrivateWrite, envelopePrivateDelete,
		)
	}

	pos := 1
	collection, pos, err := takeEnvelopeField(framed, pos, "collection")
	if err != nil {
		return historyEntry{}, err
	}
	key, pos, err := takeEnvelopeField(framed, pos, "key")
	if err != nil {
		return historyEntry{}, err
	}
	value, pos, err := takeEnvelopeField(framed, pos, "value")
	if err != nil {
		return historyEntry{}, err
	}
	if pos != len(framed) {
		return historyEntry{}, fmt.Errorf(
			"history entry has %d bytes left over after its fields",
			len(framed)-pos,
		)
	}

	private := kind == envelopePrivateWrite || kind == envelopePrivateDelete
	isDelete := kind == envelopePublicDelete || kind == envelopePrivateDelete
	if len(key) == 0 {
		return historyEntry{}, errors.New("history entry has an empty key")
	}
	if private {
		if len(collection) == 0 {
			return historyEntry{}, fmt.Errorf(
				"history entry kind %d is private but names no collection", kind,
			)
		}
	} else if len(collection) > 0 {
		return historyEntry{}, fmt.Errorf(
			"history entry kind %d is public but carries a %d-byte collection",
			kind, len(collection),
		)
	}
	if isDelete && len(value) > 0 {
		return historyEntry{}, fmt.Errorf(
			"history entry kind %d is a delete carrying %d value bytes",
			kind, len(value),
		)
	}
	return historyEntry{
		kind:       kind,
		collection: string(collection),
		key:        string(key),
		value:      value,
	}, nil
}

// ImportHistory applies one Tier 3 history record — public or private, write
// or delete — exactly once under its scope.
//
// The mutation travels as one transient envelope under "history_entry", framed
// as ../README.md describes: a one-byte kind, then a uint32-delimited
// collection (empty for public), key and value (empty for a delete).
// operationID and intentDigest are 64 lowercase hex characters, opaque to this
// contract: the operationID identifies the immutable source record and keys
// the receipt, and the intentDigest is stored as the receipt and compared on
// re-submit.
func (m *MigrationContract) ImportHistory(
	ctx contractapi.TransactionContextInterface,
	scope string,
	planDigest string,
	operationID string,
	intentDigest string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	if err := requirePlan(ctx, scope, planDigest); err != nil {
		return err
	}
	if err := validateHexDigest("operationId", operationID); err != nil {
		return err
	}
	intent, err := decodeDigest("intentDigest", intentDigest)
	if err != nil {
		return err
	}
	envelope, err := transientValue(ctx, historyEntryTransient)
	if err != nil {
		return err
	}
	entry, err := parseHistoryEnvelope(envelope)
	if err != nil {
		return err
	}

	stub := ctx.GetStub()
	return applyHistoryMutation(ctx, scope, operationID, intent, func() error {
		switch entry.kind {
		case envelopePublicWrite:
			return stub.PutState(entry.key, entry.value)
		case envelopePublicDelete:
			return stub.DelState(entry.key)
		case envelopePrivateWrite:
			return stub.PutPrivateData(entry.collection, entry.key, entry.value)
		case envelopePrivateDelete:
			return stub.DelPrivateData(entry.collection, entry.key)
		}
		// parseHistoryEnvelope has already refused any other kind.
		return fmt.Errorf("unreachable history entry kind %d", entry.kind)
	})
}

// historyBatchEntry is one parsed public history record from a framed batch.
type historyBatchEntry struct {
	operationID string
	intent      []byte
	key         string
	value       []byte
	isDelete    bool
}

// parseHistoryBatch decodes the public history batch, refusing anything it
// cannot read exactly. The batch is public only — private data is never
// batched, for the disclosure reason PutStateBatch documents — so it carries
// no collection. Each entry begins with 32 raw operation-ID bytes and 32 raw
// intent bytes, then a uint32-delimited key, a one-byte flag (0 write, 1
// delete) and a uint32-delimited value (empty for a delete).
func parseHistoryBatch(framed []byte) ([]historyBatchEntry, error) {
	if len(framed) > maxBatchBytes {
		return nil, fmt.Errorf(
			"history batch of %d bytes exceeds the %d-byte limit; lower "+
				"chaincode.writeBatchSize", len(framed), maxBatchBytes,
		)
	}
	if len(framed) < batchHeaderBytes {
		return nil, fmt.Errorf(
			"history batch of %d bytes is shorter than its %d-byte entry count",
			len(framed), batchHeaderBytes,
		)
	}
	count := int64(binary.BigEndian.Uint32(framed[:batchHeaderBytes]))
	if count == 0 {
		return nil, errors.New(
			"history batch declares no entries, which would report success " +
				"for records that never landed",
		)
	}
	// Each entry costs at least the two digests, the two lengths and the flag,
	// with an empty key and value.
	minEntryBytes := int64(2*digestBytes + batchLengthBytes + 1 + batchLengthBytes)
	if count > int64(len(framed)-batchHeaderBytes)/minEntryBytes {
		return nil, fmt.Errorf(
			"history batch declares %d entries, which cannot fit in %d bytes",
			count, len(framed),
		)
	}

	entries := make([]historyBatchEntry, 0, count)
	seenKeys := make(map[string]struct{}, count)
	seenOps := make(map[string]struct{}, count)
	pos := batchHeaderBytes
	for i := int64(0); i < count; i++ {
		entry, next, err := parseHistoryBatchEntry(framed, pos, i)
		if err != nil {
			return nil, err
		}
		if _, dup := seenKeys[entry.key]; dup {
			return nil, fmt.Errorf(
				"history batch names key %s twice, at entry %d; a transaction "+
					"records one version per key, so two versions of one key "+
					"cannot share a batch", entry.key, i,
			)
		}
		if _, dup := seenOps[entry.operationID]; dup {
			return nil, fmt.Errorf(
				"history batch names operation %s twice, at entry %d",
				entry.operationID, i,
			)
		}
		seenKeys[entry.key] = struct{}{}
		seenOps[entry.operationID] = struct{}{}
		entries = append(entries, entry)
		pos = next
	}
	if pos != len(framed) {
		return nil, fmt.Errorf(
			"history batch has %d bytes left over after its %d entries",
			len(framed)-pos, count,
		)
	}
	return entries, nil
}

// parseHistoryBatchEntry reads the entry at pos, returning it and where the
// next one begins.
func parseHistoryBatchEntry(
	framed []byte, pos int, index int64,
) (historyBatchEntry, int, error) {
	if pos+2*digestBytes > len(framed) {
		return historyBatchEntry{}, 0, fmt.Errorf(
			"entry %d ends before its operation ID and intent", index,
		)
	}
	operationID := hex.EncodeToString(framed[pos : pos+digestBytes])
	intent := make([]byte, digestBytes)
	copy(intent, framed[pos+digestBytes:pos+2*digestBytes])
	pos += 2 * digestBytes

	key, afterKey, err := takeBatchField(framed, pos, index, "key")
	if err != nil {
		return historyBatchEntry{}, 0, err
	}
	if afterKey >= len(framed) {
		return historyBatchEntry{}, 0, fmt.Errorf(
			"entry %d ends before its write/delete flag", index,
		)
	}
	flag := framed[afterKey]
	value, next, err := takeBatchField(framed, afterKey+1, index, "value")
	if err != nil {
		return historyBatchEntry{}, 0, err
	}
	if len(key) == 0 {
		return historyBatchEntry{}, 0, fmt.Errorf(
			"entry %d has an empty key", index,
		)
	}

	switch flag {
	case batchWrite:
		return historyBatchEntry{
			operationID: operationID, intent: intent,
			key: string(key), value: value,
		}, next, nil
	case batchDelete:
		if len(value) > 0 {
			return historyBatchEntry{}, 0, fmt.Errorf(
				"entry %d is a delete carrying %d value bytes",
				index, len(value),
			)
		}
		return historyBatchEntry{
			operationID: operationID, intent: intent,
			key: string(key), isDelete: true,
		}, next, nil
	}
	return historyBatchEntry{}, 0, fmt.Errorf(
		"entry %d has flag %d, which is neither a write (%d) nor a delete (%d)",
		index, flag, batchWrite, batchDelete,
	)
}

// ImportHistoryBatch applies many public history records in one transaction,
// each exactly once under its scope.
//
// The batch travels as one transient blob under "public_history_batch". Every
// entry is applied through the same receipt check ImportHistory uses, so a
// batch that overlaps an already-applied one applies only its new entries and
// reports the rest as the no-ops they are.
func (m *MigrationContract) ImportHistoryBatch(
	ctx contractapi.TransactionContextInterface,
	scope string,
	planDigest string,
) error {
	if err := requireWriter(ctx); err != nil {
		return err
	}
	if err := requirePlan(ctx, scope, planDigest); err != nil {
		return err
	}
	framed, err := transientValue(ctx, historyBatchTransient)
	if err != nil {
		return err
	}
	entries, err := parseHistoryBatch(framed)
	if err != nil {
		return err
	}

	stub := ctx.GetStub()
	for _, entry := range entries {
		e := entry
		if err := applyHistoryMutation(
			ctx, scope, e.operationID, e.intent, func() error {
				if e.isDelete {
					return stub.DelState(e.key)
				}
				return stub.PutState(e.key, e.value)
			},
		); err != nil {
			return err
		}
	}
	return nil
}

// GetHistoryImportPlan returns the plan digest recorded for a scope, as
// {"scope":"...","protocol":"idempotent-v1","planDigest":"<hex>"}. It is a
// read, so it is not gated by writerMSPIDs.
func (m *MigrationContract) GetHistoryImportPlan(
	ctx contractapi.TransactionContextInterface,
	scope string,
) (string, error) {
	if err := validateScope(scope); err != nil {
		return "", err
	}
	stub := ctx.GetStub()
	planKey, err := stub.CreateCompositeKey(
		historyPlanObjectType, []string{scope},
	)
	if err != nil {
		return "", fmt.Errorf(
			"failed to build the plan key for scope %s: %w", scope, err,
		)
	}
	existing, err := stub.GetState(planKey)
	if err != nil {
		return "", fmt.Errorf(
			"failed to read the plan for scope %s: %w", scope, err,
		)
	}
	if existing == nil {
		return "", fmt.Errorf("scope %s has no history import plan", scope)
	}
	plan := struct {
		Scope      string `json:"scope"`
		Protocol   string `json:"protocol"`
		PlanDigest string `json:"planDigest"`
	}{
		Scope:      scope,
		Protocol:   historyProtocolVersion,
		PlanDigest: hex.EncodeToString(existing),
	}
	result, err := json.Marshal(plan)
	if err != nil {
		return "", fmt.Errorf("failed to marshal the plan: %w", err)
	}
	return string(result), nil
}

// GetHistoryImportReceipt reports whether an operation has a receipt under a
// scope and, if so, the intent it recorded, as
// {"scope":"...","operationId":"...","exists":true,"intentDigest":"<hex>"} or
// the same object with "exists":false and no intent. The adapter reads it to
// resolve a submit or commit-status error safely: a receipt whose intent
// matches means the mutation landed, a receipt whose intent differs is a hard
// failure, and an absent receipt leaves the original failure to stand. It is a
// read, so it is not gated by writerMSPIDs.
func (m *MigrationContract) GetHistoryImportReceipt(
	ctx contractapi.TransactionContextInterface,
	scope string,
	operationID string,
) (string, error) {
	if err := validateScope(scope); err != nil {
		return "", err
	}
	if err := validateHexDigest("operationId", operationID); err != nil {
		return "", err
	}
	stub := ctx.GetStub()
	receiptKey, err := stub.CreateCompositeKey(
		historyReceiptObjectType, []string{scope, operationID},
	)
	if err != nil {
		return "", fmt.Errorf(
			"failed to build the receipt key for operation %s: %w",
			operationID, err,
		)
	}
	existing, err := stub.GetState(receiptKey)
	if err != nil {
		return "", fmt.Errorf(
			"failed to read the receipt for operation %s: %w", operationID, err,
		)
	}
	receipt := struct {
		Scope        string `json:"scope"`
		OperationID  string `json:"operationId"`
		Exists       bool   `json:"exists"`
		IntentDigest string `json:"intentDigest,omitempty"`
	}{Scope: scope, OperationID: operationID, Exists: existing != nil}
	if existing != nil {
		receipt.IntentDigest = hex.EncodeToString(existing)
	}
	result, err := json.Marshal(receipt)
	if err != nil {
		return "", fmt.Errorf("failed to marshal the receipt: %w", err)
	}
	return string(result), nil
}

// HistoryImportProtocol describes the protocol this contract implements so a
// client can confirm the deployed contract speaks it before submitting. It is
// a read, so it is not gated by writerMSPIDs.
func (m *MigrationContract) HistoryImportProtocol(
	ctx contractapi.TransactionContextInterface,
) (string, error) {
	descriptor := struct {
		Protocol          string `json:"protocol"`
		DigestBytes       int    `json:"digestBytes"`
		PlanObjectType    string `json:"planObjectType"`
		ReceiptObjectType string `json:"receiptObjectType"`
		EntryTransient    string `json:"entryTransient"`
		BatchTransient    string `json:"batchTransient"`
		MaxBatchBytes     int    `json:"maxBatchBytes"`
	}{
		Protocol:          historyProtocolVersion,
		DigestBytes:       digestBytes,
		PlanObjectType:    historyPlanObjectType,
		ReceiptObjectType: historyReceiptObjectType,
		EntryTransient:    historyEntryTransient,
		BatchTransient:    historyBatchTransient,
		MaxBatchBytes:     maxBatchBytes,
	}
	result, err := json.Marshal(descriptor)
	if err != nil {
		return "", fmt.Errorf(
			"failed to marshal the protocol descriptor: %w", err,
		)
	}
	return string(result), nil
}
