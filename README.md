# AMB Fabric migration tools

Sample tools for moving ledger data off Amazon Managed Blockchain (AMB) Hyperledger Fabric (1.2, 1.4 and 2.2): extract
each channel's state, history and private data, check it, and load it into another Fabric network, PostgreSQL or
DynamoDB, or re-send the original transactions block by block to a new Fabric network.

## Disclaimer

**This is sample code, not an official AWS migration tool or service.** It is provided as is, without warranty of any
kind, and is not supported by AWS or by Amazon Managed Blockchain. It is meant to show one way a migration can be done
and to be adapted to your own network. You are responsible for testing it against a copy of your own data, for
checking every result before you rely on it, and for the security of the hosts, credentials and data you use it with.
Extraction output and block archives contain your ledger data in plain text: protect them accordingly.

## Which tool do I need?

| You want to | Use | Guide |
|---|---|---|
| Find out what a network holds: channels, chaincodes, collections, heights | `amb-migrate discover` | [HOWTO](docs/HOWTO.md) |
| Copy a channel's data off AMB | `amb-migrate extract` (Tier 1 state, 2 + metadata, 3 + full history and private data) | [HOWTO](docs/HOWTO.md), [decision guide](docs/decision-guide.md) |
| Check an extraction is complete and consistent | `amb-migrate validate` | [HOWTO](docs/HOWTO.md) |
| Combine several members' extractions (each member sees only its own private data) | `amb-migrate merge` | [Migration guide](docs/migration-guide.md) |
| Keep the cutover window short | `extract --extend`, then `replay --since extension` | [Cutover rehearsal](docs/cutover-rehearsal-runbook.md) |
| Load the data into another Fabric network, PostgreSQL or DynamoDB | `amb-migrate generate-replay-config`, `advise-replay`, `check-chaincode`, `replay` | [Replay config reference](docs/replay-config-reference.md) |
| Prove the destination holds what the source held | `amb-migrate verify` | [HOWTO](docs/HOWTO.md) |
| Keep the original transaction IDs, signers, history and block numbers on a new Fabric network | `fabric-rebroadcast`, from the block archive `extract --save-blocks` writes | [Re-broadcast](docs/rebroadcast.md) |

**Replay or re-broadcast?** Replay writes keys and values as new transactions: it works for any destination and lets
you rename channels and orgs, but the destination's history carries the migration's transaction IDs. Re-broadcast
re-sends the original signed transactions, so transaction IDs, signers, invalid transactions and `GetHistoryForKey`
are identical, but only to Fabric 2.5 with the same channel names and MSP IDs. The full comparison is in
[Re-broadcast](docs/rebroadcast.md#replay-or-re-broadcast). Decide before extracting: re-broadcast also needs the
block archive, from `extract --save-blocks` on one member's run. What each path needs from extraction is in the
[decision guide](docs/decision-guide.md#fabric-destinations-replay-or-re-broadcast).

## Start here

1. Read [Known limitations](docs/known-limitations.md) and [AMB constraints](docs/amb-constraints.md): what the tools
   and AMB cannot do.
2. Plan with the [decision guide](docs/decision-guide.md), the [self-assessment questionnaire](docs/discovery-questionnaire.md)
   and the [migration planning guide](docs/migration-planning-guide.md).
3. Follow the [HOWTO](docs/HOWTO.md) end to end on a test network: host setup, discover, extract, validate, replay,
   verify. The [migration guide](docs/migration-guide.md) covers networks with several members.
4. Rehearse the cutover with the [cutover rehearsal runbook](docs/cutover-rehearsal-runbook.md).

## Documentation

| Doc | Contents |
|-----|----------|
| **[HOWTO](docs/HOWTO.md)** | Step by step: EC2 setup, extraction, replay, verification, troubleshooting, exit codes, environment variables |
| **[Migration guide](docs/migration-guide.md)** | End-to-end walkthrough for multi-member networks: private data coordination, merge, destination verification |
| **[Migration overview](docs/migration-overview.md)** | Concepts: tiers, phases, adapters, and the migration contract a Fabric destination needs |
| **[Decision guide](docs/decision-guide.md)** | Decision trees for tier, destination, scope, and multi-org coordination |
| **[Self-assessment questionnaire](docs/discovery-questionnaire.md)** | What to find out about your network before you start |
| **[Migration planning guide](docs/migration-planning-guide.md)** | Tool-neutral planning, governance, cutover, and acceptance guidance |
| **[Replay config reference](docs/replay-config-reference.md)** | Every replay and verify setting, per destination |
| **[Re-broadcast](docs/rebroadcast.md)** | Block-level migration to Fabric 2.5 that keeps the original transactions; replay vs re-broadcast |
| **[Cutover rehearsal runbook](docs/cutover-rehearsal-runbook.md)** | Extract while the source runs, extend to the final height in a short freeze, replay what changed, verify |
| **[Tuning](docs/tuning.md)** | Heap, concurrency and host sizing for extraction, replay and re-broadcast |
| **[AMB constraints](docs/amb-constraints.md)** | What AMB does not provide for a migration, and the levers you control |
| **[Fabric version support](docs/fabric-version-support.md)** | What each AMB source version yields and which Fabric versions can be a destination |
| **[IAM permissions](docs/iam-permissions.md)** | Minimum IAM policies for each phase |
| **[Known limitations](docs/known-limitations.md)** | What is not built or not yet tested |
| **[Threat model](docs/threat-model.md)** | Assets, trust boundaries, threats with the controls in the tools and those left to you, residual risks |

For testers and contributors:

| Doc | Contents |
|-----|----------|
| **[Testing and reviewing](docs/testing.md)** | `scripts/review-check.sh` (no network needed), then tests against AMB at increasing scope; a security-review reading list |
| **[Build a test source network](docs/test-source-network.md)** | Create a multi-member AMB Fabric network with your own chaincode and synthetic data |
| **[Live-test infrastructure runbook](docs/live-test-runbook.md)** | A disposable AMB endpoint and SSM host, Tier 3 extraction, Fabric 2.5 replay, teardown |
| **[Multi-member test runbook](docs/multi-member-live-test-runbook.md)** | Extract every member of a multi-member network, merge, replay to a remote destination |
| **[Fabric on EKS runbook](docs/eks-fabric-runbook.md)** | A Fabric 2.5 destination on Amazon EKS for re-broadcast or replay tests |

## Prerequisites

- **Node.js 22+** and npm
- **AWS credentials** — see **[IAM permissions](docs/iam-permissions.md)** for minimum policies
- **EC2 instance** in the same VPC as your AMB network (peer endpoints are VPC-internal)
- **Admin MSP** enrolled via Fabric CA (`fabric-ca-client enroll`)
- **Chaincode source code** (Fabric-to-Fabric only) — the replay tool submits transactions to existing chaincode on the destination; it does not deploy chaincode. You must have the source for every chaincode, add the tool-provided migration contract (one file, one import, one list of writer MSP IDs — no application logic changes), and commit it **under the same name the source used**, on every destination channel that source channel maps to, before replay. A chaincode name is its state namespace on both networks and nothing in the config renames one; replay refuses before its first write over a destination chaincode that is missing or whose migration contract does not answer. AMB does not provide a way to download installed chaincode packages. See the [destination chaincode checklist](docs/migration-overview.md#destination-chaincode-checklist) for the full redeploy procedure and [Migration contract setup](docs/migration-overview.md#migration-contract-setup).

### AMB network access

AMB peers are accessible only through VPC Interface Endpoints. Your EC2 instance must:
- Be in the same VPC (or a peered VPC) as the AMB network
- Have the AMB TLS CA certificate: `aws s3 cp s3://<region>.managedblockchain/etc/managedblockchain-tls-chain.pem ~/managedblockchain-tls-chain.pem` — the bucket name carries the AMB network's region and there is no global one, so a copied `us-east-1` fails with `NoSuchBucket` outside it
- Have an enrolled admin identity with signcerts and keystore under an MSP directory

### MSP keystore

The MSP keystore directory may contain multiple private keys if you've enrolled more than once. The toolkit picks the first key, which may not match the signing cert. Ensure only the correct key remains:

```bash
# Find which key matches your cert
CERT_HASH=$(openssl x509 -in $MSP_PATH/signcerts/*.pem -pubkey -noout | openssl md5)
for key in $MSP_PATH/keystore/*; do
  KEY_HASH=$(openssl ec -in "$key" -pubout 2>/dev/null | openssl md5)
  echo "$key: $KEY_HASH $([ "$KEY_HASH" = "$CERT_HASH" ] && echo MATCH)"
done

# Delete non-matching keys
```

## Installation

```bash
git clone https://github.com/aws-samples/sample-amb-fabric-migration-tools.git
cd sample-amb-fabric-migration-tools
npm ci
npm run build
npm link        # puts amb-migrate on your PATH
```

If `npm link` fails with `EACCES`, npm's global directory is not writable by you: run
`npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to `PATH`, and run `npm link` again.

## Quick start

### 1. Set up environment

```bash
# Auto-discover network IDs, endpoints, and set all env vars
source sample/scripts/resolve-network.sh --network-name "my-fabric-network"
```

Or set manually:
```bash
export NETWORK_ID=n-XXXXXXXX
export MEMBER_ID=m-XXXXXXXX
export NODE_ID=nd-XXXXXXXX
export REGION=us-east-1          # the network's region
export MSP_PATH=~/admin-msp
```

The first four are read by nothing but the shell — every command takes them as flags, and the examples
below pass them that way. `--region` defaults to `us-east-1`, so leaving it off fails for a network in any
other region. `MSP_PATH` is the tool's own: it is the fallback for `--msp-path`, so exporting
it makes the flag optional. `$TLS_CA_CERT` is the other one worth knowing about and most runs never need
it, because the cert downloaded to `~/managedblockchain-tls-chain.pem` above is already on the search
path. See [Environment variables](docs/HOWTO.md#environment-variables) for all seven, and for
`capture-fixtures`, which has no credential flags at all and can be given an identity no other way.

### 2. Discover

Auto-discovers channels, chaincodes, collections, and ledger heights. Writes `manifest.json`.

```bash
amb-migrate discover \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --output-dir ./extraction-output
```

Channels are auto-discovered via `cscc.GetChannels`. Use `--bootstrap-channel mychannel` to provide a known channel for the cscc query, or `--channels mychannel anotherchannel` to skip discovery and specify channels explicitly.

### 3. Extract

```bash
# The heap ceiling can only be set as the process starts, and extraction
# refuses to run unless it is twice --memory-limit (docs/tuning.md#heap-size)
export NODE_OPTIONS=--max-old-space-size=8192

amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --output-dir ./extraction-output
```

This performs:
- Block walk from genesis to ledger height with hash chain verification (ASN.1 DER encoded block header hashes), and each block's transactions checked against its header's `data_hash`
- State reconstruction from write sets (no chaincode deployment needed)
- Block metadata and history extraction (Tier 2+)
- Private data extraction via `DeliverWithPrivateData` (actual values for authorized collections, hashes for unauthorized)

Output files per channel:
```
extraction-output/
  manifest.json
  channel-mychannel/
    public-state.ndjson          # Current key-value state per chaincode
    public-history.ndjson        # Every write (Tier 3)
    block-metadata.ndjson        # Per-tx metadata (Tier 2+)
    private-<cc>-<coll>-state.ndjson  # Private data values (if accessible)
    private-<cc>-<coll>-hashes.ndjson # Private data hashes (always available)
    private-<cc>-<coll>-history.ndjson # Private data write history (Tier 3)
    metadata.json                # Channel summary, including source nodeId/MSP
    checkpoints/                 # Resumable progress
```

Optional: add `--save-blocks <dir>` to also keep every raw block (`<dir>/<channel>/blocks/<N>.block`, a `sha256sum`-checkable `blocks.sha256` and a `manifest.json`), or `--save-blocks <dir> --blocks-only` to write only that archive. It changes nothing in the extraction output; it is the input of the [re-broadcast](docs/rebroadcast.md), which keeps the original transactions at a Fabric 2.4/2.5 destination. The blocks hold ledger values, so treat the directory like the extraction output.

The extraction output can hold private-data plaintext, so `amb-migrate` creates every directory and file owner-only
(`0700` and `0600`), whatever the shell's umask. Files that already exist keep their mode.

#### Several channels on several cores

One process parses and hash-checks blocks on one core, whatever `--concurrency` is. `--processes N` extracts each
channel in a child process of its own, at most N at once, into the same output directory, and writes
`identities.ndjson` once every channel has finished. It replaces `--concurrency`, divides `--memory-limit` between the
children, and gives each child the heap `NODE_OPTIONS` sets, so size the host for N heaps. A failed channel is named
and the command exits 1; re-running it resumes that channel and walks nothing for the others. It cannot be combined
with `--extend` yet.

#### Extending an extraction to a later height

To keep cutover downtime short, extract while the source is still taking writes, then stop the writes and extend
that extraction to the new tip. The extension reads only the blocks added since the first pass:

```bash
# 1. While the source is live: discover and extract as above (this can take hours).
# 2. Stop writes to the source, then record the new heights in the same output directory:
amb-migrate discover ... --output-dir ./extraction-output
# 3. Walk only the blocks above the extraction's height:
amb-migrate extract --extend \
  --manifest ./extraction-output/manifest.json --tier 3 \
  --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --msp-path $MSP_PATH \
  --output-dir ./extraction-output
```

To replay only what an extension added, run `replay --since extension`: it replays the records at or above the
earlier height and deletes at the destination the keys deleted since ([cutover rehearsal runbook](docs/cutover-rehearsal-runbook.md), step 9).

`--extend` seeds the public and private current state, and the identity registry, from the files already in the
directory. It checks the peer still serves the block the first pass ended on, appends history, metadata and hashes,
and replaces the state files. The result is one complete extraction at the new height, which `validate`, `merge`,
`replay` and `verify` read like any other. It can be repeated, for example once more just before the final pass,
to keep that last one small. An interrupted extension is finished by re-running the same command: a journal
(`extend-journal.json`) records where every file stood, and other runs refuse the directory until then. Without
`--extend`, a completed directory whose manifest height has grown is refused, because a plain run would append
partial state to it. One difference from a fresh extraction is expected: private values purged by `blockToLive`
after the first pass are still in the extended one. The extension works in place, so copy the directory first
(`cp -a`, or a volume snapshot) if the earlier pass must be kept as it was.

### 4. Validate

```bash
amb-migrate validate --input-dir ./extraction-output
```

Checks: manifest integrity, NDJSON format, duplicate keys (public and private state), block completeness, record ordering (public history, block metadata, private history, private hashes), history completeness (public and private), private data hash-vs-value cross-check, channel metadata presence, and identities.

### 5. Generate replay config

```bash
amb-migrate generate-replay-config \
  --input-dir ./extraction-output
```

Reads the manifest and prompts for adapter selection, channel mapping, chaincode function mapping, and connection details. Saves the config to `<input-dir>/replay-config.json`. Review and edit as needed before replaying.

### 6. Replay

#### To another Fabric network (chaincode adapter)

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter chaincode \
  --config replay-config.json
```

The replay config specifies connection profile, identity, and function mappings:
```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "/path/to/admin/cert.pem",
    "keyPath": "/path/to/admin/key_sk",
    "channel": "mychannel",
    "keyMapping": {
      "mychannel": { "sample_assets": "PutState" }
    },
    "concurrency": 10
  }
}
```

Public state is replayed via the `keyMapping` function (default: `PutState`), looked up by **source channel** and then chaincode — a chaincode name is only unique within a channel, so the same name on two channels can be replayed through two different functions. Name the contract as well as the function (`"SampleAssets:StoreAsset"`) to submit on a contract other than the migration contract. Public deletes have their own map, `deleteMapping` (default: `DeleteState`), keyed identically and read only when `replayHistory` is on: a delete takes the key alone and carries no transient data, so it cannot go through the write function. Set it whenever `keyMapping` names another contract, or that deployment's writes and deletes land on two different ones. Private state always uses `ImportPrivateData`, which receives the collection and key as arguments and the value as transient data, and private deletes `DeletePrivateData`.

`channel` above is the single-destination form and fits this config because the extraction holds one source channel. A run covering more than one needs `channelMapping`, a destination channel per source channel, and is refused otherwise: one destination for several source channels merges them onto one ledger, where two channels' copies of a shared key overwrite each other silently.

These functions are provided by the **migration contract** — a single file you add to your existing chaincode package. Its write functions refuse any MSP the file's writer list does not name, and it ships with that list empty, so set it to the MSP IDs the replay submits as — all of them, including each `collectionIdentities` entry's — before packaging. See [Migration contract setup](docs/migration-overview.md#migration-contract-setup).

A destination collection admits writes only from the orgs its policy names, so private data another org owns needs an identity of that org: add that org's certificate, key and peer once under `orgIdentities`. Its `_implicit_org_<MSPID>` collection is then written as that org, and any other collection it owns takes a `collectionIdentities` entry naming just its MSP ID. Implicit collections are the exception that needs no other org's key: their policy is on who *endorses*, so `chaincode.ownerEndorsement: true` lets one member write every org's implicit collection with the owner's peer endorsing — see [ownerEndorsement](docs/replay-config-reference.md#writing-other-orgs-implicit-collections-without-their-keys-ownerendorsement). Replay checks every collection it is about to write before its first write and refuses the run listing each one that would reject its writes. See [Per-collection identities](docs/replay-config-reference.md#per-collection-identities-collectionidentities).

Replay reproduces keys and values, not the transactions that wrote them. Every replayed write is a new transaction, so the destination's `GetHistoryForKey` carries the migration's `txId`, timestamp and creator MSP — and without `replayHistory: true` it carries one entry per key, none of the source's earlier versions having been written at all. `embedSourceMetadata` recovers the source `blockNumber`, `txId` and `timestamp` inside history values that are JSON objects. `verify` compares keys, values and delete flags, so it passes either way: an application that reads history or `GetTxID` has to be checked against a dry-run destination separately. See [History and provenance fidelity](docs/replay-config-reference.md#history-and-provenance-fidelity).

By default a Tier 3 history replay is one-shot: a failed one cannot be resumed and needs a destination reset, because re-sending an ordinary write appends a duplicate history entry. Add `chaincode.historyImport` (`{ "mode": "idempotent-v1", "scope": "<32–64 hex>", "keyPath": "./history-import.key" }`, valid only with `replayHistory: true`) to make it **resilient and idempotent**: history mutations go through the migration contract's receipt-backed protocol, so a failed run re-runs safely from its checkpoint with no reset. Each mutation carries a deterministic **operation ID** (an HMAC over its immutable source coordinates only) and a separate **intent commitment** (an HMAC over the exact destination write); the contract records a receipt per operation in the same transaction as the write, so a re-submitted mutation is a no-op rather than a duplicate. Generate the key with `openssl rand -out history-import.key 32` and retain it and the scope for every retry. On a completed run, each source history record yields exactly one valid application-key mutation at the destination (under Fabric's transaction-validation and MVCC assumptions); private historical versions still cannot be read back, though receipts prove each import transaction was applied. See [Resilient idempotent history replay](docs/replay-config-reference.md#resilient-idempotent-history-replay-historyimport).

A collection name belongs to the destination chaincode's definition, not to the data, so `collectionMapping` names the destination collection each source collection is written into — and `verify` reads it back from there. Required for every `_implicit_org_<MSPID>` collection: Fabric names the per-organization collection every 2.x chaincode gets after the org that owns it, so the source name exists nowhere on a destination whose MSP IDs differ. One `mspMapping` entry per member (source MSP → destination MSP) covers that member's implicit collection on every chaincode, and `generate-replay-config` writes it. See [Collection routing](docs/replay-config-reference.md#collection-routing-collectionmapping).

#### To PostgreSQL

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter postgresql \
  --config pg-config.json
```

Config:
```json
{
  "adapter": "postgresql",
  "inputDir": "./extraction-output",
  "postgresql": {
    "connectionString": "postgresql://user:pass@host:5432/fabric_migration?sslmode=verify-full"
  }
}
```

Creates five tables: `fabric_state` (public + private state, distinguished by `collection` column), `fabric_history`, `fabric_private_hashes`, `fabric_identities`, `fabric_block_metadata`. All writes use upsert semantics, so re-running a PostgreSQL replay converges on the same rows. That is a property of this adapter, not of replay in general — see [Re-running a replay](docs/replay-config-reference.md#re-running-a-replay) for what a second run costs at each destination.

Composite keys are stored as `b64:<base64>` and non-UTF-8 values are base64-encoded with a `value_encoding`
marker, because `TEXT` and `JSONB` both reject U+0000. Queries that read `value` must account for it — see
[Key and value encoding](docs/replay-config-reference.md#key-and-value-encoding).

#### Reading the replay outcome

Replay exits **0** only if every record reached the destination, and **1** if any did not. Check the exit code
— a single failed key means the destination is incomplete.

The **chaincode** adapter records failures per key and keeps going, writing `replay-failures.ndjson` to the
input directory: one JSON object per failing key, with `chaincode`, `collection` for private data, `key`,
`error`, and `skippedAfter` — the writes to that key abandoned behind the failure. The report therefore has
fewer lines than `Records failed` counts records, by exactly the sum of `skippedAfter`.

The **PostgreSQL and DynamoDB** adapters write no failure report: a batch either commits or raises, and a
raise aborts the command with the driver's error rather than being collected into a list.

Either way replay **retains** `replay-checkpoint-<adapter>.json` frozen at the last fully successful batch, so
re-running the same command retries from there. Each adapter has its own checkpoint file, so replaying one
extraction to two destinations does not have them overwriting each other's progress. Do not delete the
checkpoint unless you intend to replay from the beginning.

Channels absent from `channelMapping` are skipped with a warning and named in the summary under
`Channels skipped` — the run still exits 0, so read that line. `verify` refuses them instead, having no
destination channel to read those records back from. See
[docs/migration-guide.md](docs/migration-guide.md) for the Tier 3 history-replay caveat on retries.

### 7. Verify

Verify that the destination contains the same data as the extraction by querying each key and comparing values.

```bash
amb-migrate verify \
  --input-dir ./extraction-output \
  --config replay-config.json
```

The verify command reads connection details from the same replay config the replay used, whichever adapter that was — it dispatches on the config's `adapter` field, exactly as `replay` does. For a chaincode destination, add `readFunctions` and `privateReadFunctions` to the `chaincode` section:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./dest-connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "/path/to/admin/cert.pem",
    "keyPath": "/path/to/admin/key_sk",
    "channel": "mychannel",
    "keyMapping": {
      "mychannel": { "sample_assets": "PutState" }
    },
    "readFunctions": {
      "mychannel": { "sample_assets": "MigrationContract:ReadState" }
    },
    "privateReadFunctions": {
      "mychannel": { "sample_assets": "MigrationContract:ReadPrivateData" }
    },
    "concurrency": 10
  }
}
```

For each key in the extracted state files, the verify command calls `evaluateTransaction` on the destination chaincode and compares the returned value (with JSON normalization to handle key-order differences). Composite keys (containing `\0`) are internal chaincode indexes and are skipped — they're only relevant for database destinations (PostgreSQL, DynamoDB) where they're stored as raw key-value pairs.

All four function maps are keyed by source channel and then chaincode, so a chaincode deployed on two
channels takes an entry under each. Every chaincode with extracted state must have a mapped read
function on its own channel; an unmapped one is a hard error before the destination is contacted, not a
silent skip. Name the contract as well as the function: an unqualified name resolves to the migration
contract, whose results are base64-decoded, so an application's own read function needs
`SampleAssets:ReadAsset` form.

Exit codes: 0 = all checked records matched, 1 = mismatches, missing keys, or extra destination keys, 2 =
query errors *or nothing was checked at all*. A run where every record was skipped exits 2 — an empty
verification is not a passing one. See [docs/migration-guide.md](docs/migration-guide.md) for the skip
reasons.

Verify also sweeps the other way, reporting every public key the destination holds that no extracted record
accounts for as `[EXTRA]`: one query or scan per channel against PostgreSQL and DynamoDB, and one
`ListKeys` walk per chaincode namespace against Fabric. Private state is not swept, because in a
multi-member migration a collection absent from one member's extraction can still belong at the
destination. A chaincode namespace is swept only where its `readFunctions` entry names the migration
contract — otherwise it is reported `no-key-listing` among the skips rather than swept.

#### PostgreSQL target

`verify` covers this destination too: give it a config whose `adapter` is `postgresql` and it compares
every extracted key, and the public history behind it, against the tables — `postgresql.connectionString`
is all it needs, since there is no chaincode to map read functions onto. The queries below are for the
tables it does not read; see
[Verification strategies by adapter](#verification-strategies-by-adapter) for which those are.

```sql
-- Compare state counts
SELECT chaincode, COUNT(*) FROM fabric_state WHERE channel = 'mychannel' GROUP BY chaincode;

-- Verify history ordering (block numbers should be monotonically increasing per key)
SELECT channel, chaincode, key
FROM (
  SELECT *, lag(block_number) OVER (
    PARTITION BY channel, chaincode, key ORDER BY block_number
  ) AS prev_block
  FROM fabric_history
) t
WHERE prev_block IS NOT NULL AND block_number < prev_block;
-- Should return 0 rows

-- Verify block completeness
SELECT channel, MIN(block_number), MAX(block_number), COUNT(DISTINCT block_number)
FROM fabric_block_metadata GROUP BY channel;

-- Check private data hash coverage
SELECT channel, collection, COUNT(*) FROM fabric_private_hashes GROUP BY channel, collection;
```

## Verification strategies by adapter

Each replay adapter preserves different aspects of the source ledger. The verification approach depends on what the adapter stores.

### Chaincode adapter (Fabric-to-Fabric)

**What's preserved:** Current public state and current private state — and, with `replayHistory: true`, every source version of every key in source order, so the destination's `GetHistoryForKey` answers with the whole sequence rather than one entry. Private history is replayed the same way; Fabric exposes no API to read it back.

**What's not preserved:** Block numbers and ordering, per-transaction identities, private data hashes — and the *provenance* of history even where every value is there: each replayed write is the migration's own transaction, so every `GetHistoryForKey` entry carries the migration's `txId`, timestamp and creator MSP. The destination gets a fresh ledger whose blocks are the migration's own import transactions, each carrying up to `writeBatchSize` keys. With the default `replayHistory: false` the earlier versions are not at the destination in any form. See [History and provenance fidelity](docs/replay-config-reference.md#history-and-provenance-fidelity) for the choice this is.

**Verification approach:**
1. **`verify` command** — Automatically queries each public and private key from the destination chaincode via `evaluateTransaction` and compares values with JSON normalization
2. **Key count** — Total keys on destination should equal non-deleted keys in extraction
3. **Private data** — The `verify` command compares private state if `privateReadFunctions` is configured. The destination chaincode needs a read function (e.g. `ReadPrivateData(collection, key)`) that returns the value. A collection the verifying identity is not a member of is compared against the destination's own private-data hash instead, through `ReadPrivateDataHash` — the hash is public channel data, so it is readable where the value is not
4. **Composite keys** — Skipped by default (`skipCompositeKeys`): a read function takes one key argument, so a key containing U+0000 cannot be queried individually. Replay writes them like any other public key, so they are at the destination regardless

### PostgreSQL adapter

**What's preserved:** Everything — full state, history, block metadata, identities, private data hashes.

**What `verify` checks at a PostgreSQL destination:** the same three passes it makes against DynamoDB.
1. **Every extracted key** — one `SELECT` from `fabric_state` per record in `public-state.ndjson` and the
   `private-*-state.ndjson` files, comparing the stored value and its encoding against the source
2. **Keys the source does not have** — one `SELECT` per channel over `fabric_state`, reporting public keys
   the destination holds that no extracted record accounts for
3. **History** — where the extraction has a `public-history.ndjson`, one `SELECT` per key over
   `fabric_history`, comparing the full sequence of values in canonical source order (`block_number`, `tx_index`, `tx_id`) against the extracted
   history

It needs nothing in the config but `postgresql.connectionString`: there is no chaincode to call, so no
read functions to map. Private history, block metadata, identities and private hashes are replayed but
**not** verified — `fabric_history` is read with `collection IS NULL`, and the other three tables are not
read at all. That is what the SQL below is for.

**Additional SQL checks.** Queries 4–6 cover the three tables `verify` does not read, and 7 is a property
no single run can establish. Queries 1–3 restate in counts what `verify` compared value by value; run them
when a count is easier to eyeball than a per-key pass.
1. **State integrity** — Row count in `fabric_state` should match line count in `public-state.ndjson`
2. **History completeness** — Row count in `fabric_history` should match `public-history.ndjson`
3. **Canonical ordering** — For each key, `block_number` values in `fabric_history` should be monotonically non-decreasing. This verifies that the chain ordering from the source ledger is preserved:
   ```sql
   SELECT channel, chaincode, key
   FROM (
     SELECT *, lag(block_number) OVER (PARTITION BY channel, chaincode, key ORDER BY block_number) AS prev_block
     FROM fabric_history
   ) t
   WHERE prev_block IS NOT NULL AND block_number < prev_block;
   -- Should return 0 rows
   ```
4. **Block completeness** — `fabric_block_metadata` should have continuous block numbers from 0 to ledger height - 1 with no gaps:
   ```sql
   SELECT channel, COUNT(DISTINCT block_number) AS blocks,
          MIN(block_number) AS first, MAX(block_number) AS last
   FROM fabric_block_metadata GROUP BY channel;
   ```
5. **Identity coverage** — every creator named in `fabric_block_metadata` should have a row in `fabric_identities`, and no identity should claim more transactions than block metadata attributes to it:
   ```sql
   -- Creators with no identity row
   SELECT DISTINCT m.creator_msp_id, m.creator_cn
   FROM fabric_block_metadata m
   LEFT JOIN fabric_identities i
     ON i.msp_id = m.creator_msp_id AND i.common_name = m.creator_cn
   WHERE i.msp_id IS NULL;
   -- Should return 0 rows

   -- Identities claiming more transactions than were recorded for them
   SELECT i.msp_id, i.common_name, i.tx_count, COUNT(m.tx_id) AS recorded
   FROM fabric_identities i
   LEFT JOIN fabric_block_metadata m
     ON m.creator_msp_id = i.msp_id AND m.creator_cn = i.common_name
   GROUP BY i.msp_id, i.common_name, i.tx_count
   HAVING i.tx_count > COUNT(m.tx_id);
   -- Should return 0 rows
   ```
   `tx_count` is a bound, not an equality. It is the largest figure any single export reported — the replay takes `GREATEST` rather than summing, so replaying two members' exports of the same channel cannot inflate it — while `fabric_block_metadata` holds the deduplicated union of everything replayed. `fabric_block_metadata` also records no certificate fingerprint, so a rotated certificate contributes two `fabric_identities` rows but one `creator_cn` in block metadata.
6. **Private data hashes** — `fabric_private_hashes` row count should match the sum of all `private-*-hashes.ndjson` files
7. **Idempotency** — record the row counts, re-run the same replay, and compare: PostgreSQL's upserts leave both counts and values unchanged. Do not carry the result over to a chaincode destination, where a second run resubmits every record — see [Re-running a replay](docs/replay-config-reference.md#re-running-a-replay)

### DynamoDB adapter

**What's preserved:** Current state (public + private), history, block metadata, identities, private data
hashes. Only `stateTable` is required in the config — a record type whose table name is omitted is not
replayed, so configure every table for the tier you are migrating.

Key schemas. Block numbers are zero-padded to 12 digits and transaction indexes to 4, so lexicographic sort
key order is ledger order:
- **State**: PK = `channel#chaincode#collection#key` (empty collection for public state), no sort key
- **History**: PK = `channel#chaincode#key`, SK = `block#txIndex#txId`, plus a trailing `#collection` for
  private history. Public and private history for one key therefore share a partition, and a query has to
  filter on the `collection` attribute to see one without the other
- **Metadata**: PK = `channel#block`, SK = `txIndex#txId`
- **Identities**: PK = `mspId#certFingerprint`
- **Private hashes**: PK = `channel#chaincode#collection#key`, SK = `block#txIndex#txId`

**The ledger key is in the state table's partition key, deliberately.** DynamoDB caps a single partition key
value at roughly 1 000 writes per second whatever the table's capacity, so a partition key naming only the
channel and chaincode capped an entire chaincode's state replay at that rate — a ceiling neither
`PAY_PER_REQUEST` nor larger batches can lift. One partition per key removes it, at the cost of any ordered
range over a namespace: a `Query` requires its items to share a partition key, which is the thing being
avoided. Point reads by key, and `Scan` with a `begins_with` filter, are what the state table supports. (A
composite key was never range-queryable anyway — it contains U+0000, so it is stored base64-encoded.)

**What `verify` checks at a DynamoDB destination:**
1. **Every extracted key** — one `GetItem` per record in `public-state.ndjson` and the
   `private-*-state.ndjson` files, comparing the stored value and its encoding against the source
2. **Keys the source does not have** — one `Scan` per channel over the state table, reporting public keys
   present at the destination and absent from the extraction, which is how a stale earlier run is caught
3. **History** — with `historyTable` configured, one `Query` per key, comparing the full sequence of values
   in ledger order against the extracted history

Private history and private hashes are written but not verified — see
[Phase 6: Verification](docs/migration-guide.md#phase-6-verification).

## Architecture

```
                AMB Fabric (1.2 / 1.4 / 2.2)
                         |
                    [VPC Endpoint]
                         |
    discover ──> manifest.json
                         |
    extract  ──> NDJSON files (public state, history, private data, hashes, metadata)
                         |
    validate ──> integrity checks (ordering, completeness, duplicates, hashes)
                         |
         ┌───────────────┼───────────────┐
         |               |               |
    [chaincode]    [postgresql]     [dynamodb]
   Fabric 2.4+     Relational DB    Serverless
         |               |               |
      verify         verify          verify
```

`verify` reads all three destinations from the same replay config. At a database destination it compares
state and public history and leaves four things unread — private history, block metadata, identities,
private hashes — which is what the SQL and `Scan` recipes under
[Verification strategies by adapter](#verification-strategies-by-adapter) are for.

## Extraction internals

### Block hash chain verification

Every block's `previous_hash` is verified against the SHA-256 hash of the prior block's ASN.1 DER encoded header (`BlockHeaderHash` in Go's `protoutil`). This matches the Fabric peer's own verification:

```
previous_hash = SHA-256(ASN1_DER(SEQUENCE {
  INTEGER block_number,
  OCTET_STRING previous_hash,
  OCTET_STRING data_hash
}))
```

The hash chain alone links headers, not transactions: a header covers its block's transactions only through `data_hash`. So every block's envelopes are also hashed, as Fabric does (`BlockDataHash`: SHA-256 over the envelope bytes joined in order), and a block whose transactions do not match its header stops the walk. The check always runs.

A transaction the peer marked valid but the extractor cannot decode or parse also stops the walk, naming the block and transaction. Skipping it would leave its writes out of the reconstructed state. Transactions marked invalid are still skipped, and each keeps its position, so validation codes stay aligned with their transactions.

Orderer signatures on blocks are not verified, and transaction validity is taken from the peer. What that means, and what limits it, is in [Known limitations: trust in the source peer](docs/known-limitations.md#trust-in-the-source-peer).

### Private data extraction

Private data is extracted via the peer's `DeliverWithPrivateData` gRPC endpoint using `fabric-common`'s `EventService` with `blockType: 'private'`. The peer delivers:
- **Actual values** for collections the connected org is authorized to see
- **Nothing** for unauthorized collections (hashes are extracted separately from the block's hashed rwsets)

No helper chaincode deployment is required for extraction.

### State reconstruction

Public state is reconstructed by replaying all block write sets from genesis. This correctly attributes state to the originating chaincode namespace and handles deletes. The state accumulator starts in-memory and promotes to LevelDB when memory pressure exceeds the configured threshold.

### Checkpoint and resume

Block walk progress is checkpointed per channel. If extraction is interrupted, the public block walk resumes from the last safe durability point; if state was not flushed, it resets and re-walks the channel. Private current state cannot resume from a block cursor because its accumulator is in memory, so each private-data attempt truncates private state/history and re-delivers the channel from block 0. A private delivery failure is fatal rather than a hashes-only success.

## Troubleshooting

### "access denied" from peer

Verify your MSP keystore has only one private key and it matches the signing cert. See [MSP keystore](#msp-keystore) above.

### `Channel name should match Regex`

This occurs when using `fabric-common` with an empty channel name. The toolkit handles this internally for system chaincode queries (`cscc.GetChannels`) by building proposals manually with an empty `channel_id`.

### Block hash chain integrity failure

If hash verification fails at block N, the block data may be corrupted or the ASN.1 encoding doesn't match. Run the diagnostic script:
```bash
node scripts/check-hash-chain.js
```

### DeliverWithPrivateData hangs or fails

Some managed Fabric deployments may have limited gRPC endpoint support. The toolkit uses a 30-second timeout and fails the extraction if private delivery was enabled but did not complete; it does not publish a hashes-only success for a partial private-data pass. Fix connectivity/support and re-run, which truncates private state/history and re-delivers from block 0.

### Empty public-state.ndjson on re-run

This happens when a previous run checkpointed block walk progress but crashed before flushing. The toolkit now auto-detects this and resets the checkpoint. If you still see it, delete checkpoints manually:
```bash
rm -rf extraction-output/channel-*/checkpoints
```

### `UNIMPLEMENTED` during discovery

AMB Fabric 2.2 doesn't support the Gateway gRPC service. The default SDK mode is `legacy` (no probe), so this only occurs if you explicitly set `--fabric-mode auto` or `--fabric-mode gateway`.

For additional troubleshooting (SSM connectivity, enrollment, EC2 setup), see the [HOWTO troubleshooting section](docs/HOWTO.md#troubleshooting).

## CLI reference

| Command | Description |
|---------|------------|
| `discover` | Auto-discover channels, chaincodes, collections; write manifest |
| `extract` | Extract ledger data at specified tier |
| `merge` | Combine per-member extractions into one directory, with a cross-member private data coverage matrix |
| `validate` | Verify extraction output integrity (NDJSON format, duplicates, ordering, completeness, hashes) |
| `generate-replay-config` | Generate replay-config.json from extraction output |
| `replay` | Replay extracted data to a destination (chaincode, PostgreSQL, or DynamoDB) |
| `verify` | Compare destination state against extracted data — chaincode queries, SQL, or DynamoDB reads, whichever the config's adapter is |
| `fingerprint-destination` | Print each destination channel's genesis-block hash, to bind a chaincode replay config to that ledger (`chaincode.destinationFingerprint`) |
| `advise-replay` | Recommend replay settings (concurrency, channel concurrency, batch sizes, heap) and estimate duration from the extraction; flag config problems replay would refuse. Read-only, shapes only |
| `check-chaincode` | Check a chaincode source tree is ready for the destination: name, migration contract revision and writer list, registration, dependencies, collection config, CouchDB indexes |
| `status` | Show extraction progress and record counts |
| `migrate` | Interactive wizard (for testing — runs all phases in one session) |
| `capture-fixtures` | Capture raw blocks from a live peer for test fixtures |

Run any command with `--help` for full option details. `npm link` (see [Installation](#installation)) puts
`amb-migrate` on your `PATH`; without it, run `node dist/cli/index.js <command>` from the repository.

The separate re-broadcast tool, `fabric-rebroadcast`, has its own commands: see [`rebroadcast/README.md`](rebroadcast/README.md).

Every command exits 0 on success and 1 on failure, and `verify` alone has a third
code — see [Exit codes](docs/HOWTO.md#exit-codes) for what a non-zero exit means
per command, and [Environment variables](docs/HOWTO.md#environment-variables) for
the seven the commands read.

## License

This sample is licensed under the MIT No Attribution License (MIT-0). See [`LICENSE`](LICENSE).

### Third-party code

[`rebroadcast/orderer-patch/`](rebroadcast/orderer-patch/) modifies Hyperledger Fabric v2.5.14 and is licensed
separately under the Apache License, Version 2.0 ([`LICENSE`](rebroadcast/orderer-patch/LICENSE) and
[`NOTICE`](rebroadcast/orderer-patch/NOTICE) in that directory). The MIT-0 license does not apply to it.

The npm and Go dependencies are fetched by their package managers, not distributed here. Those not under MIT,
Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause or 0BSD are listed, with their licenses and upstream sources, in
[`THIRD-PARTY-LICENSES`](THIRD-PARTY-LICENSES).
