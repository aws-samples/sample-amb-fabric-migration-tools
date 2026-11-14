# Migration contract

The functions `replay` and `verify` call on the destination chaincode. One file
per language, copied into your existing chaincode package, registered beside
your own contract, and edited in one place — the list of MSP IDs allowed to
write, which is empty in every shipped copy and refuses every write until you
set it. See
[Migration contract setup](../../../docs/migration-overview.md#migration-contract-setup)
for the registration snippets and [Who may write](#who-may-write) for the list.
After migration is verified, remove the registration and upgrade the chaincode.

| File | What the destination package must have on its compile path |
|---|---|
| `go/migration.go` | `fabric-contract-api-go`, v1 line |
| `node/migration.js` | `fabric-contract-api` |
| `java/MigrationContract.java` | `fabric-chaincode-shim`, `org.hyperledger.fabric:fabric-protos`, and `com.google.code.gson:gson` beside it |

The Go copy imports `fabric-contract-api-go/contractapi`, which is the v1 line;
v2 publishes the same package under `/v2/contractapi` and the import will not
resolve against it.

Gson and `fabric-protos` are neither optional nor transitive. Every dependency
`fabric-chaincode-shim` publishes is runtime-scoped, so a package that declares
only the shim cannot compile this file: it imports `com.google.gson.Gson` to
serialize the two JSON-returning functions, and its paginated range query's
public return type exposes `QueryResponseMetadata` from `fabric-protos`. Go and
Node.js use their standard library for JSON; Java is the one copy that needs
these two explicit dependencies in its destination package.

All three implement the same wire contract. The three files are the only place
it is implemented; `src/replay/adapters/chaincode-adapter.ts` and
`src/verification/verify-runner.ts` are the only callers.
`scripts/compile-migration-stubs.sh` builds the Go and Java copies against the
versions above, and CI runs it.

## Functions

| Function | Type | Arguments | Transient | Returns |
|---|---|---|---|---|
| `PutState` | submit | `key` | `public_value` | — |
| `PutStateBatch` | submit | — | `public_batch` | — |
| `ImportPrivateData` | submit | `collection`, `key` | `private_value` | — |
| `ImportPrivateDataBatch` | submit | `collection` | `private_batch` | — |
| `DeleteState` | submit | `key` | — | — |
| `DeletePrivateData` | submit | `collection`, `key` | — | — |
| `ReadState` | evaluate | `key` | — | base64 |
| `ReadPrivateData` | evaluate | `collection`, `key` | — | base64 |
| `ReadPrivateDataHash` | evaluate | `collection`, `key` | — | base64 |
| `GetKeyHistory` | evaluate | `key` | — | JSON, base64 values |
| `ListKeys` | evaluate | `pageSize`, `bookmark` | — | JSON, base64 keys |
| `InitializeHistoryImport` | submit | `scope`, `planDigest` | — | — |
| `ImportHistory` | submit | `scope`, `planDigest`, `operationId`, `intentDigest` | `history_entry` | — |
| `ImportHistoryBatch` | submit | `scope`, `planDigest` | `public_history_batch` | — |
| `GetHistoryImportPlan` | evaluate | `scope` | — | JSON |
| `GetHistoryImportReceipt` | evaluate | `scope`, `operationId` | — | JSON |
| `HistoryImportProtocol` | evaluate | — | — | JSON |

The last six implement the resilient idempotent history-import protocol
(`idempotent-v1`) and are reached only when the replay config sets
`chaincode.historyImport`; the first ten cover every other run. See
[Resilient idempotent history import](#resilient-idempotent-history-import-idempotent-v1).

Which of them a run reaches depends on its shape, so a contract that carried one
migration can be missing what the next one needs:

| Run | Submitted by `replay` | Evaluated by `verify` |
|---|---|---|
| Tier 1 or 2, or Tier 3 with the default `replayHistory: false` | `PutStateBatch`; `PutState` for a value over the batch cap or a deployment opted out of batching; `ImportPrivateDataBatch`, or `ImportPrivateData` for a lone key, where there are collections | `ReadState`; `ReadPrivateData`, or `ReadPrivateDataHash` where this identity cannot read the value; `ListKeys` for the extra-key sweep |
| Tier 3 with `replayHistory: true` | the same, **plus `DeleteState` for every public tombstone and `DeletePrivateData` for every private one** | the same, plus `GetKeyHistory` where `historyReadFunctions` names it |
| Tier 3 with `replayHistory: true` **and `historyImport`** | `HistoryImportProtocol` (pre-flight), then `InitializeHistoryImport`, `ImportHistory` and `ImportHistoryBatch` **instead of** the plain write/delete/batch functions for history; `GetHistoryImportReceipt` on a failed submit. Current-state functions are still used for a Tier 3 run's state files only if `replayHistory` were off, which it is not here | the same as the row above — `verify` is unchanged by `historyImport` |

The two delete functions are reached only through a history record. A current-state
replay submits neither, so a contract without them replays a Tier 1 or Tier 2
migration and verifies clean, and stops being sufficient the day someone turns
`replayHistory` on. Replay's pre-flight does not close that gap either: it evaluates
`ListKeys` and submits nothing, so the first tombstone in the file is what discovers
the function is missing.

`GetKeyHistory` returns a JSON array of
`{"value":"<base64>","isDelete":<bool>}`, in the order
`GetHistoryForKey` yields — newest-first on CouchDB, oldest-first on LevelDB.
Verify orders it using the destination's state database before comparing. A
delete carries no value and encodes as `""`.

Both fields are compared. `isDelete` is not decoration: a tombstone and a write
of the empty value hold the same value, so a history function that returns only
values reports a match for a source delete the destination turned into a live
key holding `""`. Any function put in `historyReadFunctions` in place of this one
has to return the flag — a function that omits it reports every deleted key as a
mismatch, which is the only honest answer verify can give.

**A history too deep to return is refused, not truncated.** All three stop at
8 MiB of accumulated value bytes and fail naming the key and the version they
stopped at. Fabric has no paginated history API — `GetHistoryForKey` returns one
iterator over every version of a key and there is no offset to resume from — so
the alternatives are worse in both directions. Returned whole, a deep enough
history crosses the peer's gRPC message limit (100 MB by default) and reaches you
as a transport error naming no key. Returned as a prefix, it would compare equal
and be reported as a match for a history nothing checked past the cut. A key that
hits the bound has to be compared by hand, and the refusal is what tells you
which one. The three caps are held equal by `test/migration-contract.test.ts`: a
destination must answer or refuse the same key whichever file was packaged.

## Who may write

Every submit function refuses a caller whose MSP is not named in one list at the
top of the file:

| File | Declaration |
|---|---|
| `go/migration.go` | `var writerMSPIDs = []string{}` |
| `node/migration.js` | `const WRITER_MSP_IDS = [];` |
| `java/MigrationContract.java` | `private static final List<String> WRITER_MSP_IDS = List.of();` |

**It ships empty, which refuses everything.** A migration contract is a
deliberate bypass of the application's own invariants — `PutState` writes any
key with any value, `DeleteState` removes any key — so a copy that arrived
working for whoever reached it first would be the wrong default. The first
replayed key fails with the MSP that submitted it and the name of the list to
add it to.

**Name every MSP whose identity submits, not just the peer's org.** A member
replaying the private collections it can read signs with its own MSP while
submitting through a gateway that may belong to another org — that is what
`chaincode.collectionIdentities` configures — and the chaincode definition is
one per channel, not one per peer, so the list has to hold every writing member
of the migration.

**In the source, not in state or the environment.** The list travels in the
package each organization approves through the chaincode lifecycle, so widening
it takes a new chaincode definition and the channel's approvals. A list held in
state would be writable by whoever can already write, and an environment
variable would be invisible to the orgs approving the package.

Reads are not gated. They cannot change the ledger, a private read is already
bounded by the collection policy, and `verify` may legitimately run as an
identity that must not write.

This is not a replacement for the chaincode's endorsement policy, which still
decides whose endorsement commits a transaction. It closes the other half: with
`OR('Org1MSP.member','Org2MSP.member')` on the destination chaincode — the
common two-org policy — any client of either org can otherwise call `PutState`
directly for as long as the contract is deployed.

## Batched public writes

`PutStateBatch` writes many public keys in one transaction. A transaction costs
an endorsement round trip plus an ordering and commit wait whatever it carries,
so a deep history replayed one version per transaction does not finish inside a
migration window. Replay submits it for public state and public history, up to
`chaincode.writeBatchSize` keys at a time.

The whole batch travels as one transient entry, `public_batch`, and the function
takes no arguments. Keys travel in the blob beside their values because one
length-delimited blob says how many writes it holds, where a transient entry per
record does not — and the keys and values would then have to be matched up by a
naming convention on the map.

| Field | Width | Meaning |
|---|---|---|
| count | 4 | number of entries that follow |
| keyLen | 4 | length of `key` |
| key | keyLen | the ledger key, UTF-8 |
| flag | 1 | `0` write, `1` delete |
| valueLen | 4 | length of `value` |
| value | valueLen | the ledger value, raw bytes |

The last five fields repeat `count` times, with no separator or padding. Every
integer is **unsigned 32-bit big-endian** — the one width and byte order all
three languages read without a library (`encoding/binary.BigEndian`,
`Buffer.readUInt32BE`, `ByteBuffer`'s default order). Lengths are byte counts,
not character counts: a key of six UTF-16 code units occupies twelve bytes and
declares twelve.

Length-prefixed bytes rather than JSON, because a ledger value is an arbitrary
byte string and JSON would need every value base64-encoded — a third more bytes
against a size cap, and three encoders to agree on instead of three integer
reads. The reasoning is [Why no value is a string](#why-no-value-is-a-string);
the batch is the same problem with a count in front of it.

**A batch is capped at 2 MiB and split, not truncated.** Fabric's default
`AbsoluteMaxBytes` is 10 MiB and an oversized transaction is rejected whole, so
the encoder starts a new batch before the blob would cross a fifth of that
default, and the contract refuses one that arrives over it. The bound is on the
framed blob because the blob is what travels, and comparing it costs one
comparison before anything is parsed. `writeBatchSize` is therefore a ceiling on
keys, not a promise: a round of large values is split into several transactions
below it.

**A batch of one is not a batch.** Replay submits a single key through `PutState`
or `DeleteState` instead, which is what keeps a value larger than the cap
working: it never has to fit in a batch, and is bounded only by what the orderer
takes. The contract's cap applies to `PutStateBatch` alone.

**Two versions of one key cannot share a batch, and one that names a key twice is
refused.** A transaction's write set holds one value per key, so the earlier
version would be dropped — silently, and invisibly afterwards, since the
destination's `GetHistoryForKey` would simply be one version short. Replay never
builds such a batch (it takes one version per key per round), and the contract
refuses it anyway, naming the key and the entry: this is the failure mode that
cannot be found by verifying the result.

Everything else about a malformed blob is refused too, and for the same reason —
a blob the parser cannot consume exactly is a disagreement about this wire
contract, not data to salvage. A blob shorter than its count, a count of zero, a
count too large to fit in the bytes present, an entry that runs off the end, a
flag that is neither value, a delete carrying value bytes, and bytes left over
after the last entry each fail naming the entry. All three implementations refuse
in that order, which `test/migration-contract.test.ts` holds them to.

**Private data is batched one collection at a time.** `ImportPrivateDataBatch(collection)`
reads the same framing from the transient entry `private_batch` and goes through
the same parser, so every refusal above applies to it too. Transient data reaches
every endorsing peer of the transaction, so one transaction carrying two
collections' values would hand each endorser the values of a collection it may
not be a member of — the disclosure private data exists to prevent. A batch
confined to one collection is endorsed by, and discloses to, exactly the peers a
single `ImportPrivateData` would, and is submitted by that collection's identity.
Private batching is not used under `historyImport`, whose receipts are per
mutation; that path still submits one `ImportHistory` per private version.

A `keyMapping` or `deleteMapping` entry pointing anywhere but this contract's own
`PutState` and `DeleteState` also opts its chaincode out: the function it names is
the application's own, takes `PutState`'s shape at most, and nothing can assume it
reads this framing. Naming `PutState` or `DeleteState` explicitly is the same
configuration as naming nothing, and batches the same way.

## Listing keys

`ListKeys` returns `{"keys":["<base64>",...],"bookmark":"..."}` — one page of the
keys in this chaincode's public namespace, as an unbounded range query. Pass a
returned bookmark back for the next page; an empty bookmark is the last one.
`verify` calls it to sweep in the other direction, asking whether the
destination holds public keys the extraction does not account for.

Keys are base64 for the reason values are: a ledger key is a byte string, and
each language's JSON encoder mangles the bytes that are not valid UTF-8 rather
than refusing them, so a plain key would be *compared* as something the
destination does not hold.

Two limits are properties of Fabric, not choices made here.

**Only keys are returned, but every value still moves.** There is no keys-only
range query in the chaincode API, so the peer sends each value to the chaincode
whichever way this function reports. `pageSize` is what bounds that traffic;
verify sends 500.

**Keys created with `CreateCompositeKey` are not returned.** They begin with
U+0000, and Fabric substitutes U+0001 for an empty start key, so an unbounded
range query begins after them. This is the same convention that makes
`GetStateByPartialCompositeKey` a separate call. Verify's forward pass already
skips composite keys by default, so neither direction covers them; the
destination chaincode is expected to rebuild its own indexes.

## Private data verify cannot read

`ReadPrivateDataHash` returns the destination's own SHA-256 of a private key's
value, base64. It answers for a collection the caller is not a member of.

`verify` connects one identity, and a merged multi-member extraction holds
collections that identity cannot read. It fails in two different ways: the
gateway peer's org is not a collection member, so the peer holds no private data
and `ReadPrivateData` reports the key absent; or the collection sets
`memberOnlyRead` and the client's MSP is not in its read policy, so the peer
refuses outright. Either way the value is unavailable for a reason that says
nothing about whether the data is there.

A private-data hash, in contrast, is public channel data. Fabric writes it into
the block's `collection_hashed_rwset`, every peer on the channel commits it, and
the peer applies the collection's read policy to `GetPrivateData` but not to
`GetPrivateDataHash`. The hash is readable exactly where the value is not.

`verify` reads the value first and falls back to the hash only when that fails,
and only through a `privateReadFunctions` entry naming this contract. A hash
equal to the SHA-256 of the extracted value is reported as a match whose detail
says the value was unreadable and by which MSP; one that differs is a mismatch
carrying both hashes. Without this, every key of every collection the verifying
identity cannot read was reported missing — a loss report over data that is
present and correct.

### There is no private-history read

Fabric exposes no private-data history API. `GetHistoryForKey` covers public
state only, and none of `GetPrivateData`, `GetPrivateDataHash` or the private
range and rich queries carries a version, so there is no function this contract
could offer that would answer for a replayed private history, and no
configuration setting that changes it. `verify` reports one
`no-private-history-api` skip per `(chaincode, collection)` whose history was
replayed, so the gap is in the report rather than silent: the current value of
each of those keys is verified, the versions behind it are not.

## Why no value is a string

**Writes arrive as transient data. Reads return base64.** Neither direction
passes a value as a `String`, in either direction, in any language.

A Fabric ledger value is an arbitrary byte string. Chaincode usually writes
JSON, but nothing stops it writing protobuf, gzip, or a raw hash, and a real
source ledger contains values that are not valid UTF-8.

The Go contract API hands a `string` argument to the chaincode as the bytes that
arrived, so `[]byte(arg)` is lossless. The Node and Java APIs do not:

- `fabric-shim` stores each argument as `entry.toString('utf8')`
- the Java serializer builds `new String(bytes, UTF_8)` for a `String` parameter

Both replace any byte sequence that is not valid UTF-8 with U+FFFD, so a binary
value passed as an argument would be *written to the destination ledger* as
replacement characters. The corruption is silent and permanent.

Transient data is `bytes` on the wire and is delivered raw — `[]byte`, `Buffer`,
`byte[]` — by all three APIs, so it is the only channel that carries a value
intact. Private values already travelled this way to keep them off the public
ledger; public values travel this way for byte fidelity.

There is no transient channel on a *return* value, and the same two shims
re-encode a returned `String` as UTF-8. Base64 solves that instead: byte safety
becomes a property of the encoding rather than of each shim's serializer, and it
is identical in all three languages. Without it, a correctly replayed binary
value would fail verification and the mismatch report would point at the
destination ledger and be wrong.

In Go, declaring `GetKeyHistory`'s entry field as `[]byte` is what produces the
base64: `encoding/json` encodes a `[]byte` field that way unconditionally, for
text as much as for binary. That is deliberate — one encoding to decode, rather
than a guess per entry.

## Missing transient data is an error

A write whose transient entry is absent fails rather than writing an empty
value. The replay adapter always sends one, so a missing entry means the caller
and the contract disagree about this wire contract; writing an empty value would
record that disagreement in the ledger as data.

## Verify and your own read functions

`verify` decodes base64 only for functions on the migration contract. An
unqualified name in `readFunctions`, `privateReadFunctions` or
`historyReadFunctions` resolves to the migration contract, so name your own
application's read functions with their contract — `SampleAssets:ReadAsset` —
and their results are compared as raw bytes. Getting this wrong produces an
actionable error, not a mismatch report.

That same entry decides whether the key sweep runs. `ListKeys` has no
configurable stand-in — a paginated range query over a whole namespace is not a
shape an application's read function has — so `verify` calls it only on the
chaincodes whose `readFunctions` entry names this contract, which is the one
thing in the config that says this contract is deployed. A chaincode read
through the application's own contract has its sweep reported as skipped,
`no-key-listing`, rather than a call that may not land.

`keyMapping` takes the same `Contract:Function` syntax, which is how a public
write reaches an application's own function instead of `PutState`. That function
has to take this contract's wire contract, because replay does not change shape
for it: one argument, the key, and the value in the transient map under
`public_value`. An application function that expects the value as its second
argument receives no value at all.

Public deletes are configured separately, through `deleteMapping`, and default to
`DeleteState`. The two are not one map because a delete is not a write with an
empty value: the delete function takes the key alone and carries no transient
data, so `keyMapping`'s function submitted for a tombstone would write an empty
value where the source deleted the key. A `keyMapping` pointing at your own
contract wants a `deleteMapping` beside it — that write function is usually there
because it maintains something besides the key, and `DeleteState` removes the key
without it.

## What is not annotated

The Java contract carries `@Contract(name = "MigrationContract")` but
deliberately **not** `@Default`. Registered beside an application contract that is
already `@Default`, a second `@Default` either stops the chaincode from starting
or makes this contract the package default and routes their application's
un-namespaced calls here. The Go and Node APIs have no equivalent annotation;
the contract name comes from the struct name and the `super()` argument.

## Resilient idempotent history import (idempotent-v1)

The functions above replay a record by writing it. Replayed twice — after a
submit that timed out but committed, or a restart from a stale checkpoint — they
write it twice, and the destination's history is a version longer than the
source's. These six functions close that: every history mutation is paired with a
**receipt** keyed by an **operation ID** over the immutable source identity, and
the receipt is read (into the transaction's read set, so the pairing is enforced
under MVCC) and written in the *same* transaction as the mutation. Fabric commits
both or neither. A record already applied under the same intent is a no-op; one
whose operation ID reappears with a different intent is refused rather than
silently overwritten.

Only the destination half lives in these files. The operation ID and the intent
commitment are HMACs the client computes under a key this contract never sees
(`chaincode.historyImport.keyPath`); the contract stores the intent as an opaque
32-byte receipt and compares its bytes on re-submit. The plan digest is likewise
opaque — a SHA-256 the client computes over the run's bound inputs. The wire
formats below match `src/replay/history-import/protocol.ts`, the only client
encoder.

### State the contract keeps

Per **scope** (32–64 lowercase hex, chosen by the client), under two reserved
composite-key object types:

| Object type | Key | Value |
|---|---|---|
| `fabric-amb-extractor-history-plan-v1` | `[scope]` | the 32-byte plan digest |
| `fabric-amb-extractor-history-receipt-v1` | `[scope, operationId]` | the 32-byte intent commitment |

Both are composite keys, so they begin with U+0000. An unbounded range query
starts at U+0001, so `ListKeys` never returns them and `verify`'s extra-key sweep
never sees them. They must survive for as long as a replay or resume of the scope
is possible — they are the migration's idempotency evidence.

### The six functions

- **`InitializeHistoryImport(scope, planDigest)`** — submit. Records the plan
  digest under the scope, or confirms an existing one matches. Re-initialising
  with the same digest is a no-op; a *different* digest under a scope that already
  has one is refused (a changed plan needs a new scope). Both arguments are
  validated: `scope` is 32–64 lowercase hex, `planDigest` is exactly 64 lowercase
  hex characters.
- **`ImportHistory(scope, planDigest, operationId, intentDigest)`** + transient
  `history_entry` — submit. Applies one public or private, write or delete,
  mutation exactly once. `requirePlan` reads the plan into the read set (binding
  the import to the verified plan version under MVCC), then `applyHistoryMutation`
  checks the receipt and applies + records atomically. `operationId` and
  `intentDigest` are 64 lowercase hex characters.
- **`ImportHistoryBatch(scope, planDigest)`** + transient `public_history_batch` —
  submit. Applies many **public** history mutations in one transaction, each
  through the same receipt check, so a batch overlapping an already-applied one
  applies only its new entries. Private data is never batched (the disclosure
  reason `PutStateBatch` documents).
- **`GetHistoryImportPlan(scope)`** — evaluate. Returns
  `{"scope":"…","protocol":"idempotent-v1","planDigest":"<hex>"}`, or an error if
  the scope has no plan. Not gated by the writer list.
- **`GetHistoryImportReceipt(scope, operationId)`** — evaluate. Returns
  `{"scope":"…","operationId":"…","exists":true,"intentDigest":"<hex>"}` or the
  same object with `"exists":false` and no `intentDigest`. The client reads it to
  resolve a failed submit: a matching intent means the mutation landed, a
  differing intent is a hard failure, an absent receipt leaves the original
  failure to stand. Not gated.
- **`HistoryImportProtocol()`** — evaluate. Returns a descriptor the client probes
  before its first write:
  `{"protocol":"idempotent-v1","digestBytes":32,"planObjectType":"…","receiptObjectType":"…","entryTransient":"history_entry","batchTransient":"public_history_batch","maxBatchBytes":2097152}`.
  A contract predating the protocol has no such function and the run is refused up
  front. Not gated.

### `history_entry` framing (single mutation)

Delivered as transient data, not arguments — a private collection name and key
would otherwise reach the public transaction arguments, and a value passed as a
string argument would be UTF-8-mangled by the Node and Java shims (the reason
`PutState` takes its value as transient too):

| Field | Width | Meaning |
|---|---|---|
| kind | 1 | `0` public write, `1` public delete, `2` private write, `3` private delete |
| collectionLen | 4 | length of `collection` (0 for public) |
| collection | collectionLen | destination collection, UTF-8 (empty for public) |
| keyLen | 4 | length of `key` |
| key | keyLen | the ledger key, UTF-8 |
| valueLen | 4 | length of `value` |
| value | valueLen | the ledger value, raw bytes (empty for a delete) |

Every integer is unsigned 32-bit big-endian. A public kind carrying a collection,
a private kind naming none, a delete carrying value bytes, an empty key, or bytes
left over are each refused.

### `public_history_batch` framing

Public only. Like `PutStateBatch`'s blob, but each entry is prefixed with the
32-byte operation ID and 32-byte intent (raw, not length-delimited, since both
are fixed-width digests):

| Field | Width | Meaning |
|---|---|---|
| count | 4 | number of entries that follow |
| operationId | 32 | raw HMAC-SHA256 operation ID |
| intent | 32 | raw HMAC-SHA256 intent commitment |
| keyLen | 4 | length of `key` |
| key | keyLen | the ledger key, UTF-8 |
| flag | 1 | `0` write, `1` delete |
| valueLen | 4 | length of `value` |
| value | valueLen | the ledger value, raw bytes (empty for a delete) |

The last six fields repeat `count` times. The batch is capped at **2 MiB** and
refused (not truncated) over it; a batch that names one key twice, one operation
twice, declares zero entries, cannot fit its count, runs off the end, carries a
bad flag, or has bytes left over is each refused naming the entry. The client sizes
a batch so the extra 64 bytes per entry stay under the cap.

### What this does and does not guarantee

On a **completed** import, each source history record produces **exactly one valid
application-key mutation** at the destination, under Fabric's normal
transaction-validation and MVCC assumptions — a per-record property of a finished
run, not a global exactly-once claim over the transport. It does **not** preserve
provenance (every entry still carries the migration's own `txId`, timestamp and
creator), and it does **not** make private historical versions readable — Fabric
has no private-data history API, so `verify` still reports `no-private-history-api`
for each replayed private collection. The receipts prove the import transactions
were applied; the versions themselves remain unverifiable.

## Testing

Neither the client half nor the wire contract can be exercised without a live
Fabric network, so the halves are covered separately:

- The client half — transient framing, base64 decode, commit-status handling —
  is covered by `test/replay-adapter.test.ts` and `test/verify-runner.test.ts`.
  `test/state-batch.test.ts` pins the batch framing by its bytes rather than by a
  round trip, since the encoder is the only implementation of it this repo runs.
- `test/migration-contract.test.ts` reads the three sources and holds them to
  one wire contract: the same functions declared in each, the writer check on
  every submit function and on no read function, the shipped list empty, the
  history bound declared, compared against, and the same size in all three, and
  the batch framing widths, flag values and size cap declared identically. It
  also runs the Node contract against a stub context — the guard refusing before
  the stub is touched, the hash read answering for an MSP that may not write, the
  history bound refusing at the version it names, and its batch parser reading
  back what the encoder framed and refusing each way a blob can be malformed —
  which is the only one of the three this repo can execute.
- The three files are compiled only by the sample deployment in `sample/`, which
  is where they are also run against a destination network.
