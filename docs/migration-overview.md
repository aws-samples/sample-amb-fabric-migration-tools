# AMB Hyperledger Fabric Migration

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

## Why Migrate

Amazon Managed Blockchain (AMB) Hyperledger Fabric networks store ledger data on managed peers that are only accessible through the Fabric SDK while the network is active. This sample toolkit extracts this data into portable NDJSON files and replays it into a destination of your choice — another Fabric network, PostgreSQL, or DynamoDB.

## Migration Paths

The tool supports three extraction tiers. Each tier is a strict superset of the previous one.

### Tier 1 — Current State

A point-in-time snapshot of every key-value pair on the ledger. Includes both public state and private data values for collections the extracting member is authorized to read.

**Output:** public-state.ndjson, private-CHAINCODE-COLLECTION-state.ndjson

**Use when:** The destination only needs current data — no audit trail or historical versions required.

### Tier 2 — State with Audit Trail

Everything in Tier 1, plus per-transaction block metadata: transaction ID, timestamp, chaincode ID, keys written and deleted, and the signing identity of each transaction creator.

**Additional output:** block-metadata.ndjson, identities.ndjson

**Use when:** Regulatory or compliance requirements demand transaction-level provenance (who changed what, when).

### Tier 3 — Full History

Everything in Tier 2, plus the complete write-set history — every value ever written to every key, not just the latest. Also extracts private data hashes from the block's hashed read-write sets, which prove data integrity even after private data has been purged.

**Additional output:** public-history.ndjson, private-CHAINCODE-COLLECTION-history.ndjson, private-CHAINCODE-COLLECTION-hashes.ndjson

**Use when:** The destination needs complete lineage, forensic analysis capability, or a full regulatory archive.

### Choosing a Tier

- **Tier 1 — Current State:** Fastest. Produces latest key-value pairs only.
- **Tier 2 — State + Audit:** Moderate speed. Adds transaction metadata and identities.
- **Tier 3 — Full History:** Slowest (walks every block). Complete ledger reconstruction.

Higher tiers require proportionally more time and storage because the tool must process every block rather than just reconstructing final state.

## Migration Phases

A migration runs in six phases. Each phase produces a file-based output that
feeds the next. Each phase is a standalone CLI command, designed to be run
independently with review and planning between steps. This is not a same-day
process — expect to pause between extraction and replay to review results,
choose a destination, and configure the replay.

### Phase 1 — Discover

Connects to the AMB peer and inventories the network: channels, chaincodes,
private data collection policies, ledger heights, and Fabric version
capabilities. Produces a `manifest.json` that drives all subsequent phases.

**Command:** `discover`

**Review before continuing:** Check the manifest for channel count, chaincode
topology, collection policies (especially `blockToLive` for purge risk), and
ledger heights. This informs your tier selection and time estimates.

### Phase 2 — Extract

Walks every block on selected channels from genesis to ledger tip. Verifies the
SHA-256 hash chain, reconstructs state from write sets, and collects private
data via the `DeliverWithPrivateData` gRPC endpoint. Emits typed NDJSON records
based on the chosen tier.

Extraction is checkpointed per channel — if interrupted, re-running the command
resumes from the last completed block.

**Command:** `extract`

### Phase 3 — Validate

Runs automated integrity checks against the extraction output: NDJSON format
correctness, duplicate key detection, block completeness (no gaps), monotonic
record ordering, history completeness, and private data hash-vs-value
cross-checks. Reports pass/fail per check with details.

**Command:** `validate`

**Do not proceed to replay until validation passes.** Fix any failures and
re-extract if needed.

### Phase 4 — Plan replay

Generate a replay configuration from the extraction output. The
`generate-replay-config` command reads the manifest and walks you through
adapter selection, channel mapping, collection mapping, and chaincode function
mapping.

**Command:** `generate-replay-config`

**Review before continuing:** Edit the generated `replay-config.json` as
needed. Verify channel and collection mappings, check that destination
infrastructure (Fabric network, PostgreSQL instance, or DynamoDB tables) is
ready, and confirm credentials. For Fabric-to-Fabric migrations, ensure the
destination chaincode is deployed and implements the required functions.

### Phase 5 — Replay

Streams extraction records into the selected destination adapter. Replay is
checkpointed — an interrupted replay resumes from the last committed batch.

**Command:** `replay`

### Phase 6 — Verify

For chaincode destinations, compares every key in the extraction output against
the destination ledger and reports mismatches. For database destinations,
verification is done via SQL queries against the replay tables.

**Command:** `verify`

### Testing with the wizard

The `migrate` command runs all phases in a single interactive session. It is
useful for testing connectivity and validating the pipeline end-to-end on a
small network, but is not the recommended path for production migrations. For
production, run each phase independently with review between steps.

## Destination Adapters

The replay layer uses a pluggable adapter model. Each adapter implements schema creation and batch record writing. The orchestrator streams records from extraction output in batches and dispatches them to the selected adapter with checkpoint-based resumability.

### PostgreSQL

Creates five tables automatically (fabric_state, fabric_history, fabric_block_metadata, fabric_identities, fabric_private_hashes). Handles all seven record types. All writes use upsert semantics, so re-running a PostgreSQL replay converges on the same rows — see [Re-running a replay](replay-config-reference.md#re-running-a-replay), where the other two destinations differ.

**Best for:** Analytics, reporting, SQL-based querying of ledger data, or integration with existing relational infrastructure.

**Preserves:** All extracted data including full history, block metadata, identities, and private data hashes.

### DynamoDB

Creates up to five tables (state table is required; history, metadata, identity, and private-hash tables are optional). Uses composite keys designed for common access patterns (e.g., lookup by channel/chaincode/key for state, lookup by key/txId for history).

**Best for:** Serverless architectures, high-throughput read access to ledger data, or staying within the AWS ecosystem.

**Preserves:** State, history, block metadata, and identities. Optional private data hash table.

### Chaincode (Fabric-to-Fabric)

Submits transactions to a destination Hyperledger Fabric network, which must be **2.4 or later with the Gateway service enabled** — `replay` and `verify` connect through `@hyperledger/fabric-gateway` and have no legacy-SDK path, so a 2.0–2.3 destination cannot be reached at all, and neither can another AMB network. See [Fabric version support](fabric-version-support.md#destination-a-fabric-destination-must-be-24-or-later). Public writes are batched — up to `writeBatchSize` distinct keys per transaction, 500 by default, through `PutStateBatch` — since a transaction costs an endorsement round trip plus an ordering and commit wait whatever it carries. Public state can instead be written by a configurable chaincode function per deployment (default: PutState); a function on the application's own contract opts that deployment out of batching. Private state is written via ImportPrivateData using transient data, one key per transaction. Supports channel mapping (source to destination) and key-partitioned concurrency.

**Best for:** Migrating to a self-managed Fabric network or another managed Fabric service.

**Preserves:** Current public and private state. With `replayHistory: true`, the full write-set history is also replayed — each historical write becomes a destination write in block order, so the destination's native GetHistoryForKey reflects the original sequence. A batch carries at most one version of any one key, because a transaction's write set holds one value per key, so a key's versions are always separate transactions in order. Block metadata and identities are not replayed — the destination creates its own independent block sequence.

**Does not preserve transaction provenance.** Every replayed write is a new transaction, so the destination's `GetHistoryForKey` reports the migration's `txId`, timestamp and creator MSP rather than the source transaction's — and with the default `replayHistory: false` it reports one entry per key, the migration's own write, with none of the source's earlier versions at the destination at all. `embedSourceMetadata` recovers the source `blockNumber`, `txId` and `timestamp` inside the value, for history records that are JSON objects. `verify` compares keys, values and delete flags only, so a passing `verify` says nothing about any of this: an application that reads history, or `GetTxID`, has to be checked separately before cutover. See [History and provenance fidelity](replay-config-reference.md#history-and-provenance-fidelity).

**Destination chaincode setup:** The tool ships a `MigrationContract` — a single file you add to your existing chaincode package. It provides `PutState`, `PutStateBatch`, `ImportPrivateData`, `DeleteState`, `DeletePrivateData`, `ReadState`, `ReadPrivateData`, `ReadPrivateDataHash`, `GetKeyHistory`, and `ListKeys`. No modifications to your application logic; one edit inside the file itself, naming the MSP IDs allowed to write through it. See [Migration contract setup](#migration-contract-setup) for integration instructions in Go, Node.js, and Java.

## Prerequisites

### Runtime Environment

- **Node.js 22 or higher**
- **VPC network access to the AMB peer.** The tool must run on an EC2 instance (or equivalent compute) in the same VPC as the AMB network, or in a peered VPC. AMB peer endpoints are only accessible through VPC Interface Endpoints, not over the public internet.

### AWS IAM Permissions

The tool uses the standard AWS credential provider chain (environment variables, instance profile, SSO).

[IAM permissions](iam-permissions.md) carries the policies, one per phase, and is the
only place the action lists are written down — this page had its own copy and it went
stale. Discovery and extraction need Managed Blockchain reads and one S3 object; a
DynamoDB destination needs write actions for `replay` and three read actions for
`verify`.

### AMB Network

- An active VPC Endpoint for the AMB network (com.amazonaws.REGION.managedblockchain.NETWORK_ID) with ports 30001–30004 open
- The AMB TLS CA certificate, downloaded via: aws s3 cp s3://REGION.managedblockchain/etc/managedblockchain-tls-chain.pem ~/managedblockchain-tls-chain.pem
- An enrolled Fabric admin identity — an MSP directory containing signcerts/cert.pem and keystore/*_sk, generated via fabric-ca-client enroll

### Destination-Specific

- **PostgreSQL:** A reachable PostgreSQL instance and connection string. Tables are created automatically.
- **DynamoDB:** AWS credentials with DynamoDB permissions. Tables are created automatically.
- **Fabric network:** **Fabric 2.4 or later with the Gateway service enabled** — a 2.0–2.3 peer and another AMB network cannot be reached at all ([why](fabric-version-support.md#destination-a-fabric-destination-must-be-24-or-later)). Plus a provisioned destination network with channels created, channel policies configured, a connection profile, MSP credentials for a submitting identity, and **deployed chaincode on every channel being replayed**. The tool migrates data, not network configuration — channel policies (endorsement policies, ACLs, reader/writer policies, collection policies) must be recreated manually on the destination. The replay tool submits transactions to existing chaincode — it does not package, install, or deploy chaincode. You must have the source chaincode available and deploy it to the destination before replay.

### Chaincode Setup (Fabric-to-Fabric)

The replay tool writes data by calling chaincode functions (`PutStateBatch`, `PutState`, `ImportPrivateData`) on the destination network. These functions are not part of standard application chaincode — Fabric's stub `PutState` is an internal API, not callable from the client SDK.

The tool ships a **migration contract** (`sample/chaincode/migration_contract/`) that provides all required functions. You add one file to your existing chaincode package and register it alongside your application contract. No modifications to your business logic.

**What you need:**

- The **source chaincode source code** (Go, Node.js, or Java) for every chaincode discovered in the manifest. AMB does not provide a way to download installed chaincode packages — you must have the source in your own repository or build system.
- **Copy the migration contract file** into each chaincode package, register it (one import, one line change), and set the MSP IDs allowed to write through it — the shipped list is empty and refuses every write. See [Migration contract setup](#migration-contract-setup) for language-specific instructions.
- The chaincode must be **packaged, installed, approved, and committed** on the destination network via the standard Fabric lifecycle (`peer lifecycle chaincode` commands) before running replay.
- After migration is complete and verified, **remove the migration contract import** and upgrade the chaincode to restore the original package.

**If you don't have the source code:**

- Replay itself needs only a chaincode committed under the same name carrying the migration contract, so the data can reach the destination ledger and pass `verify` before the application logic exists. Nothing at the destination will be able to read those keys through its own functions until it does.
- For chaincodes where you cannot deploy equivalent code, use PostgreSQL or DynamoDB as the destination — these adapters don't require chaincode.

## Best Practices

**Run discovery first and review the manifest.** Understanding channel count, chaincode topology, collection policies, and ledger heights informs tier selection and time estimates before committing to a full extraction.

**Start with Tier 1.** Extract current state first to validate connectivity, credentials, and output format end-to-end. Upgrade to Tier 2 or 3 once the baseline works.

**Assess private data purge risk early.** Collections with a blockToLive policy have a finite retention window. Every new block committed to the channel brings older private data closer to permanent purging. If at-risk collections exist, prioritize extracting those channels first.

**Co-locate the tool with the peer.** Extraction speed is bound by network round-trip time to the peer since blocks are fetched sequentially per channel. Running on an EC2 instance in the same VPC minimizes latency.

**Always validate before replay.** The validation phase catches structural issues (gaps, duplicates, format errors, ordering violations) that would silently corrupt the destination.

**Quiesce the network before extraction.** The tool captures a point-in-time snapshot. Transactions committed during extraction may or may not be included depending on timing. For a consistent cutover: stop submitting transactions, wait for the ledger to settle, then extract.

**Replay to a staging destination first.** Test against a non-production database or network before touching production. DynamoDB supports a local endpoint override for development; PostgreSQL replay targets a throwaway database trivially.

**Use checkpoint resumability for what it is.** Both extraction and replay are checkpointed, so re-running an **interrupted** command resumes from the last checkpoint instead of restarting. Resumable is not the same as repeatable, and two cases are not covered. A replay that *finished* deletes its checkpoint, so re-running it starts from the first record again — which a PostgreSQL or DynamoDB destination absorbs as upserts, and a Fabric destination does not: with `replayHistory: true` it appends every version a second time. And an extraction whose manifest a later `discover` refreshed walks the new blocks and appends them to the files the first run wrote, leaving one directory holding two ledger heights. Before re-running either, read [Re-running a replay](replay-config-reference.md#re-running-a-replay) and [Running a command twice](HOWTO.md#running-a-command-twice).

**Verify after chaincode replay.** The "verify" command queries every key on the destination ledger and compares it against the extraction output, with JSON normalization to handle key-ordering differences. Run this before declaring the migration complete.

**Coordinate timing in multi-member networks.** Each member runs extraction independently against its own peer, and no AMB API exposes another member's private data — a collection your MSP is not in the policy for arrives as hashes only until that member hands over their extraction directory. Combine the directories with `merge`, which is also what makes the timing requirement exact: every member has to extract a shared channel at the **same** ledger height, not a similar one. `merge` refuses a height mismatch rather than pair one member's private data with another member's public state, so agree the height and quiesce before anyone starts. See [multi-org coordination](decision-guide.md#4-multi-org-coordination) for the two strategies and [3.5 Merge per-member extractions](HOWTO.md#35-merge-per-member-extractions-multi-org-networks-only) for the command.

## Destination Chaincode Checklist

A Fabric → Fabric migration redeploys your **existing** chaincode on
the destination with one file — the migration contract — added beside the
application contract. No application logic changes. This is the complete list
of what that redeploy has to get right; each item links to the detail. Confirmed
end to end on a three-member AMB 2.2 → Fabric 2.5 run
([Tuning](tuning.md)).

**Before packaging**

1. **Have the source code** for every chaincode in the manifest. AMB cannot
   export an installed chaincode package.
2. **Destination is Fabric 2.4 or later with the Gateway service enabled.**
   `replay` and `verify` connect only through the Gateway client; another AMB
   network cannot be a destination ([version support](fabric-version-support.md)).
3. **Add the migration contract** in the chaincode's language and register it
   beside the application contract ([setup](#migration-contract-setup)). The Go
   copy needs `fabric-contract-api-go` v1; the Java copy needs Gson and
   `fabric-protos` declared beside the shim. Chaincode written against the
   low-level shim with its own `Invoke` router has no contract registry, so the
   migration functions must be routed by hand.
4. **Set the writer list** (`writerMSPIDs` / `WRITER_MSP_IDS`) to every
   **destination** MSP replay signs as — the top-level identity and each
   `orgIdentities` / `collectionIdentities` org. It ships empty and refuses
   every write ([who may write](../sample/chaincode/migration_contract/README.md#who-may-write)).
5. **Package the CouchDB indexes** (`META-INF/statedb/couchdb/indexes`) the
   application's rich queries depend on, as for any deployment. Replay does not
   create them.

**Chaincode definition**

6. **Commit under the identical chaincode name** on every destination channel
   its source channel maps to. The name is the state namespace and nothing
   renames it; replay refuses before the first write if a chaincode is missing
   or its migration contract does not answer
   ([pre-flight](replay-config-reference.md#destination-chaincode-pre-flight)).
7. **Collection config names destination MSPs.** Rewrite every explicit
   collection policy for the destination's org IDs, and keep the collection
   names (or map them with `collectionMapping`). Implicit `_implicit_org_<MSPID>`
   collections need no definition — route them with one `mspMapping` entry per
   member ([routing](replay-config-reference.md#per-member-shorthand-mspmapping-orgidentities)).
8. **Choose each purging collection's `blockToLive` before the first commit.**
   Fabric refuses to change it later, so it cannot be lowered for the migration
   and restored at cutover. With the production value, the destination can purge
   replayed private data before `verify` runs
   ([options](replay-config-reference.md#destination-blocktolive-during-migration)).
9. **Endorsement policy** is your production one. Replay submits
   through the Gateway service, which gathers the endorsements the policy needs
   from other orgs' peers via service discovery — so every destination org needs
   anchor peers configured. Measured with `OR`, majority (`OutOf`) and `AND`
   over every channel member: all replay with 0 failures, the multi-org
   policies about 7% slower. **Under any policy one org cannot meet alone, give
   every explicit collection its own `endorsementPolicy` naming its members.**
   Without one, a collection with fewer members than the chaincode policy needs
   cannot be written through the Gateway at all — the policy needs peers
   outside the collection and the Gateway will not send them the private value —
   and that holds for the destination application as much as for replay.
   Replay's endorsement probe refuses such a destination before its first write
   ([endorsement pre-flight](replay-config-reference.md#destination-endorsement-pre-flight)).
   Implicit collections already carry a policy of their own.

**After replay**

10. **Run `verify`**, then have the application team read pre-migration values
    through **their own** contract functions against the dry-run destination.
11. **Cutover:** upgrade the chaincode to a definition without the migration
    contract registered (and with production `blockToLive`), so no one can write
    arbitrary keys through it afterwards.

**What the redeploy does not carry**

- **Transaction provenance.** Every replayed write is a destination
  transaction, so `GetHistoryForKey`, `GetTxID`, timestamps and creator MSPs are
  the migration's. With `replayHistory: true` every source *value* is in each
  key's history, in order, but none of its source metadata
  ([history fidelity](replay-config-reference.md#history-and-provenance-fidelity)).
- **Chaincode events** from the source ledger are not re-emitted.
- **Logic keyed on who wrote a value** — for example, a check that the caller's
  MSP matches an owner recorded at creation — sees destination identities. The
  application team must confirm nothing depends on source identities; `verify`
  cannot, since it compares keys and values only.

## Migration Contract Setup

The migration contract is a single file that you add to your existing chaincode
package. It registers alongside your application contract and provides the
functions the replay and verify commands need. Your application logic is
untouched — the migration contract operates on the same state namespace because
it's part of the same chaincode package.

**The destination needs the same chaincodes, under the same names.** A chaincode
name *is* its state namespace on both networks, and nothing in this tool renames
one: a key extracted from `marketplace` is written back into `marketplace`. So
every chaincode the extraction carries data for has to be committed on each
destination channel its source channel is mapped to, under the identical name,
carrying the migration contract. Collection names are the one part that may
differ — `chaincode.collectionMapping` routes a source collection to the
destination collection its data belongs in, and is mandatory for
`_implicit_org_<MSPID>`, whose name embeds an MSP ID the destination network does
not have.

`replay` establishes both before its first write: it reads each destination
channel's committed chaincode definitions, asks each chaincode's migration
contract for one page of keys, and refuses the whole run naming every chaincode
to commit and every contract to register. See
[Destination chaincode pre-flight](replay-config-reference.md#destination-chaincode-pre-flight).
Without that check a destination missing the chaincode fails on every record with
a peer-side error that names no cause.

**Set the writer list before packaging.** Each copy ships with an empty list of
MSP IDs and refuses every write until you name the organizations the migration
submits as — `writerMSPIDs` in Go, `WRITER_MSP_IDS` in Node.js and Java, at the
top of the file. Name every writing member, not only the org whose peer you
submit through: one chaincode definition serves the whole channel, and a member
replaying its own private collections signs with its own MSP. See
[Who may write](../sample/chaincode/migration_contract/README.md#who-may-write).

After migration is complete and verified, remove the import and upgrade the
chaincode to restore the original package.

The migration contract provides:

| Function | Used by | Purpose |
|----------|---------|---------|
| `PutState(key)` | replay | Write public state (value via transient data) |
| `PutStateBatch()` | replay | Write many public keys in one transaction (keys and values via transient data) |
| `ImportPrivateData(collection, key)` | replay | Write private state (value via transient data) |
| `ImportPrivateDataBatch(collection)` | replay | Write many keys of one collection in one transaction (keys and values via transient data) |
| `DeleteState(key)` | replay | Replay delete operations from history |
| `DeletePrivateData(collection, key)` | replay | Replay private delete operations |
| `ReadState(key)` | verify | Public state verification (returns base64) |
| `ReadPrivateData(collection, key)` | verify | Private data verification (returns base64) |
| `ReadPrivateDataHash(collection, key)` | verify | The destination's own SHA-256 of a private value, for a collection this identity cannot read (returns base64) |
| `GetKeyHistory(key)` | verify | Tier 3 history verification (returns base64 values) |
| `ListKeys(pageSize, bookmark)` | verify | One page of the namespace's public keys, for the sweep that finds keys the extraction does not account for (returns base64 keys) |
| `InitializeHistoryImport(scope, planDigest)` | replay | Resilient history: record/confirm the run's plan under a scope |
| `ImportHistory(scope, planDigest, operationId, intentDigest)` | replay | Resilient history: apply one public/private mutation exactly once (envelope via transient data) |
| `ImportHistoryBatch(scope, planDigest)` | replay | Resilient history: apply many public mutations in one transaction, each exactly once (batch via transient data) |
| `GetHistoryImportPlan(scope)` | replay | Resilient history: read the plan digest stored for a scope |
| `GetHistoryImportReceipt(scope, operationId)` | replay | Resilient history: reconcile a failed submit against the stored receipt |
| `HistoryImportProtocol()` | replay | Resilient history: pre-flight probe of the protocol version the contract implements |

The last six implement the resilient idempotent history-import protocol and are
reached only when the replay config sets `chaincode.historyImport`. They let a
failed or interrupted Tier 3 history replay be re-run safely, with no destination
reset — each mutation carries a deterministic operation ID and intent commitment,
and the contract records a receipt per operation so a re-submitted mutation is a
no-op rather than a duplicate history entry. See
[Resilient idempotent history replay](replay-config-reference.md#resilient-idempotent-history-replay-historyimport)
and the [wire contract](../sample/chaincode/migration_contract/README.md#resilient-idempotent-history-import-idempotent-v1).

No value crosses the boundary as a string: writes carry theirs as transient
data and reads return base64. A ledger value is an arbitrary byte string, and
the Node and Java contract APIs UTF-8-decode `String` arguments and return
values, which would write any byte sequence that is not valid UTF-8 to the
destination ledger as U+FFFD. See
[the wire contract](../sample/chaincode/migration_contract/README.md) for the
full rationale.

### Go (fabric-contract-api-go)

1. Copy `sample/chaincode/migration_contract/go/migration.go` into a
   `migration/` subdirectory of your chaincode package.

2. Name the writers at the top of the copied file:

```go
var writerMSPIDs = []string{"Org1MSP", "Org2MSP"}
```

3. Register the contract in `main()`:

```go
import "your-module/migration"

func main() {
    chaincode, err := contractapi.NewChaincode(
        &MyContract{},
        &migration.MigrationContract{},
    )
    // ...
}
```

### Node.js (fabric-contract-api)

1. Copy `sample/chaincode/migration_contract/node/migration.js` into your
   chaincode package directory.

2. Name the writers at the top of the copied file:

```javascript
const WRITER_MSP_IDS = ['Org1MSP', 'Org2MSP'];
```

3. Export both contracts:

```javascript
const { MigrationContract } = require('./migration');

module.exports.contracts = [MyContract, MigrationContract];
```

### Java (fabric-chaincode-shim)

1. Copy `sample/chaincode/migration_contract/java/MigrationContract.java` into
   your chaincode source tree, and add Gson and Fabric's protobuf classes to
   the package's dependencies alongside the shim. Every dependency
   `fabric-chaincode-shim` publishes is runtime-scoped, so the shim puts
   neither this file's `com.google.gson.Gson` import nor the
   `QueryResponseMetadata` type exposed by its paginated range query on your
   compile path:

```gradle
implementation 'org.hyperledger.fabric-chaincode-java:fabric-chaincode-shim:2.5.5'
implementation 'org.hyperledger.fabric:fabric-protos:0.3.3'
implementation 'com.google.code.gson:gson:2.14.0'
```

2. Name the writers in the copied class:

```java
private static final List<String> WRITER_MSP_IDS = List.of("Org1MSP", "Org2MSP");
```

3. Register both contracts in your chaincode server or router configuration.

### Replay configuration

The replay config's `keyMapping` maps a source channel, then a chaincode on it,
to the function the replay adapter calls. With the migration contract
registered, the defaults work without changes:

```json
{
  "chaincode": {
    "keyMapping": {
      "my_channel": { "my_chaincode": "PutState" }
    }
  }
}
```

The outer key is the source channel because a chaincode name is only unique
within a channel — the same name on two channels is two deployments, and each
takes its own entry. A function name may carry its contract
(`"MyContract:Store"`); an unqualified one is a migration contract function.

`deleteMapping` is the same map for public deletes, defaulting to `DeleteState`
and read only when `replayHistory` is on. Set it for every deployment whose
`keyMapping` names another contract: a delete takes the key alone and carries no
transient data, so it cannot go through the write function, and the migration
contract's `DeleteState` removes the key without whatever that write function
maintains alongside it.

For Tier 3 history verification, add `historyReadFunctions`:

```json
{
  "chaincode": {
    "replayHistory": true,
    "historyReadFunctions": {
      "my_channel": { "my_chaincode": "MigrationContract:GetKeyHistory" }
    }
  }
}
```
