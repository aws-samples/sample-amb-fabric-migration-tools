# Migration Guide: AMB Hyperledger Fabric to Destination Platform

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This guide walks through the end-to-end migration of an Amazon Managed Blockchain (Hyperledger Fabric) network. It covers a realistic scenario: a multi-member network with multiple channels and private data collections.

**Related docs:** [IAM permissions](iam-permissions.md) | [Fabric version support](fabric-version-support.md) | [HOWTO (EC2 setup)](HOWTO.md) | [Live-test infrastructure runbook](live-test-runbook.md) | [Replay config reference](replay-config-reference.md)

## Scenario

You operate an AMB Hyperledger Fabric 2.2 network with:

- **Two members**: OrgA (your organization) and OrgB (a partner)
- **Four channels**:
  - `trade-public` — both orgs, public marketplace data
  - `trade-settlement` — both orgs, settlement records
  - `orgA-internal` — OrgA only, internal records
  - `orgB-internal` — OrgB only, visible to OrgB's peer
- **Private data collections** with mixed membership:
  - `sharedAppraisals` — both orgs authorized (on `trade-public`)
  - `orgAConfidential` — OrgA only (on `trade-settlement`)
  - `orgBConfidential` — OrgB only (on `trade-settlement`)
  - `tempNotes` — OrgA only, `blockToLive=500` (on `trade-public`)

You want to extract everything your organization can access and migrate it to a destination platform.

## Migration pipeline

```
  Phase 1          Phase 2          Phase 3            Phase 4            Phase 5          Phase 6
  DISCOVER         EXTRACT          VALIDATE           PLAN REPLAY        REPLAY           VERIFY

  Query peer       Walk blocks      Check NDJSON       Generate and       Write to         Compare
  for channels,    from genesis,    integrity,         review replay      destination      source vs
  chaincodes,      reconstruct      block coverage,    config: adapter,   (Fabric, PG,     destination
  collections,     state, extract   duplicates,        channels,          or DynamoDB)     state
  ledger height    private data     ordering           chaincodes

  manifest.json    NDJSON files     pass/fail          replay-config      populated        match/diff
                   per channel      report             .json              destination      report

  ───── discover   ───── extract    ───── validate     ── generate-       ───── replay     ───── verify
                                                       replay-config
```

Each phase is a separate CLI command designed to be run independently with
review between steps. This is not a same-day process — expect to pause between
extraction and replay to review results, choose a destination architecture,
and configure the replay deliberately.

---

## Phase 1: Discovery

Discovery queries your AMB peer to inventory the network. It produces a `manifest.json` that drives all subsequent phases.

### What it does

1. Resolves AMB endpoints via AWS API (`managedblockchain:GetNetwork/GetMember/GetNode`)
2. Builds a Fabric connection profile with your peer, orderer, and CA endpoints
3. Enrolls your admin identity from the MSP directory
4. Queries `cscc.GetChannels` to list all channels your peer has joined
5. Queries `_lifecycle.QueryChaincodeDefinitions` per channel for installed chaincodes
6. Queries `_lifecycle.QueryChaincodeDefinition` per chaincode for collection configs
7. Queries ledger height per channel via `qscc.GetChainInfo`

### What you learn

- All channels visible to your peer (you will see `trade-public`, `trade-settlement`, and `orgA-internal` — but NOT `orgB-internal` unless your peer has joined it)
- All chaincodes and their versions per channel
- All private data collections with `blockToLive` values (tells you which collections are at risk of purging)
- Ledger heights (drives time and storage estimates)

### Running it

```bash
amb-migrate discover \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --output-dir ./extraction-output
```

Use `--bootstrap-channel <name>` to seed auto-discovery, or `--channels <names...>` to specify channels explicitly. `--region` defaults to `us-east-1`.

### Output: manifest.json

```json
{
  "networkId": "n-XXXXXXXX",
  "memberId": "m-XXXXXXXX",
  "region": "us-east-1",
  "stateDb": "CouchDB",
  "fabricVersion": "2.2",
  "extractedAt": "2026-04-08T...",
  "channels": [
    {
      "channelId": "trade-public",
      "ledgerHeight": 4200,
      "chaincodes": [
        {
          "name": "marketplace",
          "version": "1.0",
          "collections": [
            { "name": "sharedAppraisals", "blockToLive": 0 },
            { "name": "tempNotes", "blockToLive": 500 }
          ]
        }
      ]
    },
    {
      "channelId": "trade-settlement",
      "ledgerHeight": 1800,
      "chaincodes": [...]
    },
    {
      "channelId": "orgA-internal",
      "ledgerHeight": 950,
      "chaincodes": [...]
    }
  ]
}
```

### Decision point: purge risk

Review collections with `blockToLive > 0`. The `tempNotes` collection has `blockToLive=500` — if more than 500 blocks have been committed since data was written to this collection, the peer has already purged the actual values. Only hashes remain on the peer. This is a Fabric-level constraint, not a tool limitation.

**Action:** If ephemeral data matters, extract immediately. Every new block brings older private data closer to purging.

---

## Phase 2: Extraction

Extraction walks every block on every channel from genesis to the current ledger height, reconstructing state and collecting history along the way.

### What it does

For each channel:
1. **Block walk** — Fetches blocks sequentially from block 0 to ledger height
2. **Hash chain verification**: validates `SHA-256(ASN.1 DER(BlockHeader))` linkage from genesis, and each block's transactions against its header's `data_hash`
3. **State reconstruction** — Replays all write sets (PutState/DelState) to reconstruct current state without deploying any chaincode
4. **Private data delivery** — Uses `DeliverWithPrivateData` gRPC to get actual private data values for authorized collections
5. **History and metadata** — Collects per-transaction metadata (Tier 2) and full write-set history (Tier 3)

Only transactions that committed are extracted. Fabric records the outcome of
every transaction in a block's `TRANSACTIONS_FILTER` metadata, and extraction
reads it to drop the ones that failed validation — endorsement-policy failures,
MVCC read conflicts, and the rest. **If that filter cannot be read, extraction
aborts.** Committed and failed transactions would otherwise be indistinguishable,
and replaying a failed one writes a value the source ledger never held. The error
names the block; capture it with `capture-fixtures` for diagnosis.

### Extraction tiers

Choose a tier based on what you need at the destination:

| Tier | What you get | When to use |
|------|-------------|-------------|
| 1 | Current state snapshot (public + private) | Migrating to a new system that only needs current data |
| 2 | Tier 1 + block metadata (txId, timestamp, creator, keys touched) | Need an audit trail of who did what and when |
| 3 | Tier 2 + full write-set history (every version of every key) | Need complete lineage, forensic analysis, or regulatory archive |

### Running it

Set the V8 heap ceiling first — it can only be set as the process starts, and
`extract` refuses to walk a block unless the ceiling is twice `--memory-limit`
(512 MB by default). `docs/tuning.md` sizes both against the host.

```bash
# 8192 MiB of heap suits a 16 GiB host; halve it on 8 GiB
export NODE_OPTIONS=--max-old-space-size=8192

# Extract all channels at once (the extractor resolves the correct
# network context per channel via gateway.getNetwork(channelId))
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --output-dir ./extraction-output

# Or extract specific channels:
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --channels trade-public trade-settlement \
  --output-dir ./extraction-output

# For parallel extraction of independent channels:
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --concurrency 3 \
  --output-dir ./extraction-output
```

### Output files

```
extraction-output/
  manifest.json
  channel-trade-public/
    public-state.ndjson              # Current key-value state
    public-history.ndjson            # Every write to every key (Tier 3)
    block-metadata.ndjson            # Per-tx audit records (Tier 2+)
    private-marketplace-sharedAppraisals-state.ndjson   # Values (OrgA authorized)
    private-marketplace-sharedAppraisals-hashes.ndjson  # Hashes
    private-marketplace-sharedAppraisals-history.ndjson # Write history (Tier 3)
    private-marketplace-tempNotes-state.ndjson          # Values (if not purged)
    private-marketplace-tempNotes-hashes.ndjson         # Hashes (always available)
    private-marketplace-tempNotes-history.ndjson
    metadata.json
    checkpoints/
  channel-trade-settlement/
    public-state.ndjson
    private-settlement-orgAConfidential-state.ndjson  # Values (OrgA authorized)
    private-settlement-orgAConfidential-hashes.ndjson
    private-settlement-orgBConfidential-hashes.ndjson # Hashes ONLY (OrgA not authorized)
    ...
  channel-orgA-internal/
    public-state.ndjson
    ...
  identities.ndjson                  # Shared: all signing identities seen
```

### What you can and cannot extract

| Data type | OrgA's extraction |
|-----------|------------------|
| Public state (all 3 channels) | Full key-value pairs |
| `sharedAppraisals` (both orgs in policy) | Full values + hashes |
| `orgAConfidential` (OrgA in policy) | Full values + hashes |
| `orgBConfidential` (OrgA NOT in policy) | **Hashes only** — values never sent to OrgA's peer |
| `tempNotes` (OrgA in policy, `blockToLive=500`) | Values if not purged; hashes always |
| Block metadata and history | Full for all channels |

**To get `orgBConfidential` values:** OrgB must run the tool independently against their peer and share the output, then combine the two with [`merge`](#multi-member-coordination). No AMB API exposes another member's private data, so per-member extraction plus a merge is the only route — see [AMB constraints](amb-constraints.md).

### Checkpoint and resume

A peer that goes away for less than three minutes is not an interruption: every read is retried against a three-minute budget, so a routine AMB peer restart is waited out and the walk carries on ([retries](tuning.md#retries)). Longer than that, the run ends with `Retry budget exhausted` and resumes as below.

If extraction is interrupted (network timeout, instance restart), re-run the same command. The public block walk resumes from its last safe checkpoint; if its current state was not flushed, it resets and re-walks the channel. Private current state has no durable accumulator, so every private-data attempt truncates its state/history outputs and re-delivers from block 0. A private delivery error fails the channel instead of being accepted as hashes-only output.

The block walk makes progress durable every 100 blocks: it fsyncs the NDJSON files and then writes the checkpoint, in that order, so the checkpoint never names records the disk does not have. A walk that ends by itself — completing or failing — writes a final checkpoint on the way out, so only a `kill -9` or a power loss can lose progress, and at most 100 blocks of it. Those blocks are re-walked rather than skipped, which is the safe direction: current state is written only once the walk finishes, so a rerun after a killed walk finds an empty state file and re-derives the channel from block 0 as described above.

---

## Phase 3: Validation

Validation checks the structural integrity of the extraction output before you commit to replaying it.

### What it checks

- Manifest is present and parseable
- Every `.ndjson` file has valid JSON on every line with a `_type` discriminant
- No duplicate keys in `public-state.ndjson` or `private-*-state.ndjson` (warns but does not fail)
- Block coverage: classification runs through the larger of the manifest ledger height and the highest extracted block. Gaps listed in `metadata.json.blocksWithoutMetadata` are expected config/fully-invalid blocks; every unexplained interior or tail gap FAILs. Missing or unparseable `metadata.json` also FAILs, because without it the extraction cannot account for a gap
- Record ordering: `blockNumber` monotonically non-decreasing with non-decreasing `txIndex` within the same block — checked for public history, block metadata, private hashes, and private history
- History completeness: blocks with writes in `block-metadata.ndjson` must have corresponding entries in `public-history.ndjson`
- Private history completeness: blocks in `private-*-hashes.ndjson` must have corresponding entries in `private-*-history.ndjson`
- Private data hash-vs-value cross-check: SHA-256 of extracted private values verified against the hash file
- Private value coverage: every key hash in `private-*-hashes.ndjson` must either have a plaintext value or an explanation — `expected-deleted` (last write was a delete), `expected-unauthorized` (the extracting MSP is not in the collection policy), or `expected-purged` (older than `blockToLive`). Anything else is `unexplained` and FAILs — unless the reason cannot be established at all (no extracting MSP ID recorded anywhere, or the manifest has no collection config for that chaincode), in which case it warns instead and tells you to re-run `discover`
- Per-channel `metadata.json` presence and parseability
- `identities.ndjson` presence (required for Tier 2+)

### Running it

```bash
amb-migrate validate --input-dir ./extraction-output
```

Exits 1 if any check FAILs, 0 otherwise. WARN results do not fail the run but each one means a check could
not reach a verdict — read them rather than treating a 0 exit as a clean bill of health.

### Example output

```
Channel: trade-public
  [PASS] NDJSON (public-state.ndjson): 2,847 valid records
  [PASS] NDJSON (public-history.ndjson): 18,432 valid records
  [PASS] Duplicates (trade-public/public-state): No duplicate keys
  [PASS] Block completeness (trade-public): Blocks 0..4199 covered (100.0% of ledger height 4200) — 3 block(s) hold no metadata by design (config or fully-invalidated blocks)
  [PASS] Record ordering (trade-public/public-history): 18,432 records in correct block/tx order
  [PASS] Record ordering (trade-public/block-metadata): 4,200 records in correct block/tx order
  [PASS] Record ordering (trade-public/private-marketplace-sharedAppraisals-history): 312 records in correct block/tx order
  [PASS] History completeness (trade-public): History covers all 4,198 blocks from metadata
  [PASS] Private history completeness (trade-public/marketplace/sharedAppraisals): Private history covers all 156 blocks from hashes
  [PASS] Private data hashes (trade-public/marketplace/sharedAppraisals): 156 records verified
  [PASS] Private value coverage (trade-public/marketplace/sharedAppraisals): 140/156 private keys have values, 16 accounted for
         12 expected-deleted (deleted before extraction); 4 expected-purged (purged by blockToLive)
  [PASS] Channel metadata (trade-public): metadata.json present

  23/23 passed, 0 failed, 1 warnings, 0 skipped
```

### What it does NOT check

- Cross-channel consistency (e.g. a key referenced from one channel existing on another)
- Semantic value correctness (validates structure and ordering, not business logic)

### After validation passes

Do not proceed directly to replay. Take time to:

1. **Review the extraction output.** Check record counts, channel coverage, and
   private data completeness. For multi-org migrations, coordinate with other
   orgs and merge extraction outputs before proceeding (see
   [Multi-member coordination](#multi-member-coordination)).

2. **Choose your destination.** See the
   [decision guide](decision-guide.md) for tradeoffs between Fabric,
   PostgreSQL, and DynamoDB.

3. **Generate a replay config.** The `generate-replay-config` command reads
   your manifest and walks you through adapter selection, channel mapping,
   and chaincode function mapping:

   ```bash
   amb-migrate generate-replay-config \
     --input-dir ./extraction-output
   ```

4. **Review and edit `replay-config.json`.** Verify channel mappings match
   your destination topology. For Fabric-to-Fabric, confirm the destination
   chaincode is deployed with the migration contract included, and that its
   writer list names the MSP IDs replay submits as — a contract packaged with
   the shipped empty list refuses every write.
   For PostgreSQL/DynamoDB, confirm connectivity.

5. **Replay to a staging destination first.** Test against a non-production
   database or network before touching production.

---

## Phase 4: Plan Replay

Generate and review the replay configuration before committing to a replay run.

### Running it

```bash
amb-migrate generate-replay-config \
  --input-dir ./extraction-output
```

The command reads `manifest.json`, shows the discovered channels and chaincodes,
and prompts for:

- **Adapter** — postgresql, dynamodb, or chaincode
- **Channel mapping** (chaincode adapter) — defaults to identity mapping (each
  source channel maps to the same name on the destination). You can override to
  rename them individually. Naming one destination twice is refused on the spot
  and asked again: two source channels on one destination channel merge onto one
  ledger.
- **Chaincode function mapping** (chaincode adapter) — defaults to `PutState`
  for every chaincode. You can override per chaincode.
- **Connection details** — adapter-specific (connection string, table names,
  connection profile, MSP credentials, etc.)
- **Read functions** (chaincode adapter) — used by the `verify` command to
  query replayed state

The config is saved to `<input-dir>/replay-config.json` (or a custom path via
`--output`).

### Common things to check before replay

- **Chaincode deployed on destination, under the same name.** For
  Fabric-to-Fabric, the replay tool submits transactions to existing chaincode —
  it does not deploy chaincode. You must have the source chaincode available, add
  the migration contract (one file, one import, one list of writer MSP IDs — no
  application logic changes), and commit it on every destination channel the
  source channel maps to, via the standard Fabric lifecycle, before running
  replay. The name has to match the source's: a chaincode name is its state
  namespace on both networks and nothing in the config renames one. Replay reads
  each destination channel's committed definitions and probes each chaincode's
  migration contract before its first write, refusing the run over any chaincode
  that is not there or whose contract does not answer.
  AMB does not provide a way to download installed chaincode packages — you
  must have the source in your own repository. See
  [migration-overview.md](migration-overview.md#migration-contract-setup)
  for language-specific instructions.
- **Channel mapping completeness.** Compare `channelMapping` keys against the
  manifest's channel list. Missing channels are skipped during replay, with a
  warning and a summary line but a zero exit code. Give each one its own
  destination value too: two source channels sharing a destination is refused,
  because it merges them onto one ledger.
- **Destination infrastructure.** PostgreSQL instance reachable? DynamoDB
  permissions in place? Fabric network channels created with appropriate
  policies? The tool migrates data, not network configuration — endorsement
  policies, ACLs, reader/writer policies, and collection policies must be
  recreated manually on the destination.
- **Private data coverage.** If you need data from collections your org cannot
  access, merge outputs from the authorized org first — and give each of those
  collections a `chaincode.collectionIdentities` entry, since the destination
  collection admits writes only from the orgs its policy names. Replay refuses
  before its first write if one is missing.
- **Collection names at the destination.** A collection name belongs to the
  destination chaincode's definition, not to the data. Every
  `_implicit_org_<MSPID>` collection needs a `chaincode.collectionMapping` entry:
  the name embeds the MSP ID of the org that owns it on the *source*, so it
  exists nowhere on a destination whose MSP IDs differ. Map it to itself if they
  are the same. Replay refuses before its first write if one is missing, and
  refuses two source collections mapped onto one destination collection.
- **Identity attribution.** Replay submits as one admin identity per
  organization — `collectionIdentities` chooses the org, never the identity that
  originally wrote the key, so the destination attributes every key to an admin.
  Identity-mapped replay is not built.
- **Staging first.** Replay to a staging destination before production. DynamoDB
  supports a local endpoint override for development; PostgreSQL replay targets
  a throwaway database trivially.

---

## Phase 5: Replay

Replay writes the extracted data into a destination system. The adapter you choose determines what gets preserved. Use the `replay-config.json` generated in Phase 4.

### Choosing an adapter

| Adapter | Destination | What's preserved | What's lost |
|---------|------------|-----------------|-------------|
| `chaincode` | Another Fabric network, **2.4+ with the Gateway service** ([why](fabric-version-support.md#destination-a-fabric-destination-must-be-24-or-later)) | Current public + private state; with `replayHistory: true`: full write-set history | Block metadata, identities, and the source's transaction provenance — every replayed write is the migration's own transaction ([detail](replay-config-reference.md#history-and-provenance-fidelity)) |
| `postgresql` | PostgreSQL database | Everything: state, history, metadata, identities, hashes | Chaincode execution semantics (it's a database, not a ledger) |
| `dynamodb` | DynamoDB | State (public + private), history, block metadata, identities | Private data hashes, chaincode execution semantics |

### Chaincode adapter (Fabric-to-Fabric)

Submits transactions to the destination network, batching public writes: up to `writeBatchSize` distinct keys per `PutStateBatch` transaction, 500 by default, because a transaction costs an endorsement round trip plus an ordering and commit wait whatever it carries. Public state can instead use a configurable function (`keyMapping`, default `PutState`), and public deletes their own (`deleteMapping`, default `DeleteState`) — an entry naming a function on the application's own contract opts that deployment out of batching, since nothing can assume that function reads the batch framing. Private state uses `ImportPrivateData` with transient data, and private deletes `DeletePrivateData`; neither is configurable. With `replayHistory: true`, Tier 3 history records are also replayed in block order so the destination's `GetHistoryForKey` reflects the original sequence.

**Prerequisite: deploy chaincode with migration contract, under the source's name.** The replay tool submits transactions to existing chaincode — it does not package, install, or deploy chaincode. Add the tool-provided migration contract to each chaincode package (one file, one import, one list of writer MSP IDs — no application logic changes), then commit it under the same name the source used, on every destination channel that source channel maps to, via the standard Fabric lifecycle. A chaincode name is its state namespace and nothing in the config renames one, so replay refuses before its first write over a destination chaincode that is missing or whose migration contract does not answer — see [Destination chaincode pre-flight](replay-config-reference.md#destination-chaincode-pre-flight). See [migration-overview.md](migration-overview.md#migration-contract-setup) for language-specific instructions. After migration, remove the import and upgrade.

**Name the writers before packaging.** Every write function on the shipped contract refuses every MSP, because the list of MSP IDs allowed to write is empty in each copy — a contract that arrived working for whoever reached it first would be the wrong default for a function that writes any key with any value. Set `writerMSPIDs` (Go) or `WRITER_MSP_IDS` (Node.js, Java) at the top of the copied file to every member the migration submits as, not only the org whose peer you submit through: one chaincode definition serves the whole channel, and a member replaying its own private collections signs with its own MSP. See [Who may write](../sample/chaincode/migration_contract/README.md#who-may-write).

**Single channel** — use `channel` when the run covers one source channel, whether the extraction holds one or `--channels` narrows it to one:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./dest-connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "/path/to/admin/cert.pem",
    "keyPath": "/path/to/admin/key_sk",
    "channel": "trade-public",
    "keyMapping": {
      "trade-public": { "marketplace": "PutState" }
    },
    "concurrency": 10
  }
}
```

**Multi-channel** — use `channelMapping` to route each source channel to its destination:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./dest-connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "/path/to/admin/cert.pem",
    "keyPath": "/path/to/admin/key_sk",
    "channelMapping": {
      "trade-public": "trade-public",
      "trade-settlement": "settlement-v2",
      "orgA-internal": "orgA-internal"
    },
    "keyMapping": {
      "trade-public": { "marketplace": "PutState" },
      "trade-settlement": { "marketplace": "ImportSettlement" },
      "orgA-internal": { "ledger": "SampleAssets:ImportLedgerEntry" }
    },
    "concurrency": 10
  }
}
```

- `channelMapping` is required once a run covers more than one source channel, and the two forms cannot both
  be set. A single `channel` for eight source channels is not a migration of eight channels: it is one
  destination ledger holding whichever channel's copy of each shared key was written last, reported as a
  clean run. Both that and a `channelMapping` naming one destination for two source channels in scope are
  refused before the destination is connected to.
- Source channels not in the map are skipped with a warning and named in the replay summary under
  `Channels skipped`. The run still exits 0, so read that line — a typo in a channel name silently
  migrates nothing for that channel. `verify` refuses such a channel instead of skipping it, since it has
  no destination channel to read those records back from.
- To ensure all channels migrate, check the manifest's channel list against your mapping before running replay.
- `keyMapping`'s outer key is the **source** channel, the same name `channelMapping` maps from. Here
  `marketplace` is deployed on two channels and takes a different function on each, which is why the map is
  keyed by both: a chaincode name is only unique within a channel. A typo in `keyMapping` does not fail the
  run — every deployment under the misspelled channel falls back to `PutState` — so replay warns and names
  any source channel the map covers but the run does not replay.
- `deleteMapping` is the same map for public deletes, keyed identically, defaulting to `DeleteState`, and
  read only when `replayHistory` is on — a tombstone reaches the destination only through a history record.
  Set it for every deployment whose `keyMapping` names another contract, like `orgA-internal`'s
  `SampleAssets:ImportLedgerEntry` above. A write on the application's own function is usually there because
  that function maintains something besides the key; `MigrationContract:DeleteState` removes the key and
  leaves the rest referring to it. Replay warns and names each such deployment with no delete beside it.

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter chaincode \
  --config replay-config.json
```

**What gets replayed:**
- `public_state` records via `PutStateBatch`, many keys per transaction — or `PutState` for a mapped function, a `writeBatchSize` of 1, or a batch that came down to one key
- `private_state` records via `ImportPrivateData` with transient data, one key per transaction
- Composite index keys are replayed like any other key. Nothing in the adapter looks at a key's bytes — it
  selects records by `_type` — so the source's index entries land at the destination whether or not its
  chaincode would rebuild them. It is `verify` that skips them, by default: see `skipCompositeKeys` below
- Records where you only have hashes (unauthorized collections) are skipped — there is no value to write
- Records sharing the same `(chaincode, key)` are replayed in separate transactions, in order — a transaction's write set holds one value per key, so two versions of one key cannot share a batch; independent keys share a batch, and batches run in parallel up to the `concurrency` limit

**Checkpointing.** Replay progress is checkpointed to disk after each batch. If interrupted, re-running the same command resumes from the last completed batch rather than restarting. The checkpoint is cleared on successful completion — and deliberately *retained* when records failed (see below).

### Reading the replay outcome

| Exit code | Meaning |
|-----------|---------|
| 0 | Every record reached the destination |
| 1 | At least one record did not — the destination is incomplete |

Do not treat replay as done without checking the exit code. A single failed key means the destination is
missing data, and the summary prints the count:

```
Replay summary:

  Records replayed: 12,486
  Records failed:   3
  Channels skipped: orgB-internal (no channelMapping entry)

3 record(s) did not reach the destination. One line per failing key, with the writes abandoned after it in "skippedAfter": ./extraction-output/replay-failures.ndjson
The replay checkpoint has been retained — fix the cause and re-run the same command to retry the failed records.
```

**`replay-failures.ndjson`** is written to the input directory by the **chaincode adapter only**, one JSON
object per failing key:

```json
{"channel":"trade-public","chaincode":"trade","collection":"sharedAppraisals","key":"asset-4471","mspId":"Org2MSP","error":"Failed to submit private state for sharedAppraisals:asset-4471 to trade:ImportPrivateData: ENDORSEMENT_POLICY_FAILURE ...","skippedAfter":2}
```

`collection` is present only for private-data failures. `error` carries two halves: what was attempted —
which record, and the `chaincode/Contract:function` it was submitted to — and then the peer's reason. Both
are needed to act on it: "DeleteState not found" says the destination contract is wrong, and only the target
says which `keyMapping` or `deleteMapping` entry named it. Because failures are recorded per
`(chaincode, collection, key)`, one bad key does not abort the run — the remaining keys still replay, so a
single report tells you everything that needs retrying, and a collection your identity cannot write does not
take the writable collections' copies of the same key down with it. Writes to one key in one collection are
ordered and interdependent, so a failure stops that queue;
`skippedAfter` counts the writes abandoned behind it. That is why the report has fewer lines than `Records
failed` reports records — the difference is exactly the sum of the `skippedAfter` values.

The **PostgreSQL and DynamoDB adapters write no failure report**, because they have no partial-failure mode: a
batch either commits or raises, and a raise aborts the command with the driver's error rather than being
collected into a list. PostgreSQL rolls the failing batch back; DynamoDB retries throttled items and then
raises, so a batch can be left partly written. In both cases the checkpoint is not advanced and the fix is to
address the cause and re-run.

**The retained checkpoint is the retry mechanism.** On failure the checkpoint is frozen at the last fully
successful batch rather than advanced, so re-running the same command re-processes the failed records.
Each adapter keeps its own file, `replay-checkpoint-<adapter>.json`, and checkpoint version 2 persists the exact ordered input file set. Private files are sorted before the list is built; adding, removing, or reordering a file makes resume refuse rather than skip new data or duplicate completed history. Replay one extraction to two destinations without their progress overwriting each other. Do not delete it unless you intend to
replay from the beginning.

Re-processing replays the *whole* batch that contained the failure, including the records in it that had
already succeeded. For state records that is harmless — `PutState` on the same key is last-write-wins.

**Tier 3 history replay is not resumable — unless `chaincode.historyImport` is
set.** By default, history is replayed as a sequence of ordinary writes, so every
record appends a new entry to the destination's `GetHistoryForKey`. There is no
key to overwrite and no transaction to roll back: once a history file has partly
landed, the entries already written cannot be distinguished from the ones still
owed, and re-submitting the batch appends duplicates in the wrong order.

So when a history record fails, replay stops rather than carrying on:

- The file stops at the end of the failing batch. Remaining history files in the run are skipped.
- `replay-checkpoint-<adapter>.json` is marked `dirtyFile: "<channel>/<file>"`, and that marker survives the
  process.
- The summary reports `historyAborted`, and the next run **refuses to start** with an error naming the file
  and the recovery steps.

Recovery is always the same, and it is not a retry:

1. Fix the cause listed in `replay-failures.ndjson`.
2. Reset the destination channel's state *and* history for the affected chaincode.
3. Delete `replay-checkpoint-<adapter>.json`.
4. Replay from the beginning.

Reducing `--batch-size` narrows the window but does not make history replay resumable — a single failed
record is already unrepairable. Size batches for throughput, not for recovery.

**Resilient idempotent history replay makes it resumable.** Set
`chaincode.historyImport` (chaincode adapter, Tier 3) and a failed history file
still stops — to preserve key order — but writes **no** `dirtyFile` marker and
needs **no** destination reset. Every history mutation carries a deterministic
operation ID over its immutable source coordinates and an intent commitment over
its exact destination write, and the destination migration contract records a
receipt per operation in the same transaction as the write. Re-running the same
command therefore re-sends only what did not land and treats an already-applied
record as a no-op, so recovery is just "fix the cause and re-run" — no reset, no
checkpoint deletion. `writeBatchSize` may be lowered before the retry; it is not
bound into the run's plan. The one hard stop is a receipt whose recorded intent
differs from the re-run's, which aborts rather than overwriting. On a completed
run, each source record yields exactly one valid application-key mutation at the
destination (under Fabric's transaction-validation and MVCC assumptions). See
[Resilient idempotent history replay](replay-config-reference.md#resilient-idempotent-history-replay-historyimport).

### PostgreSQL adapter

Replays all channels in a single pass into 5 tables:

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter postgresql \
  --config pg-config.json
```

`--adapter` is required and it wins: `replay` overwrites the config's `adapter`
field with the flag. `verify` has no such flag and reads the field, so a config
saying `postgresql` replayed with `--adapter chaincode` writes to Fabric and is
then verified against PostgreSQL. Keep the two the same.

```json
{
  "adapter": "postgresql",
  "inputDir": "./extraction-output",
  "postgresql": {
    "connectionString": "postgresql://user:pass@host:5432/fabric_migration?sslmode=verify-full"
  }
}
```

Tables created:

| Table | Contents |
|-------|----------|
| `fabric_state` | Current public + private state |
| `fabric_history` | All write-set versions |
| `fabric_block_metadata` | Per-transaction audit |
| `fabric_identities` | Signing identities |
| `fabric_private_hashes` | Private data hashes |

Each table's uniqueness key is in
[replay-config-reference.md](replay-config-reference.md#tables-created), which is
the one place they are written down — a second copy here is what let four of the
five drift out of step with the adapter.

All writes use `ON CONFLICT ... DO UPDATE` or `DO NOTHING`, so re-running a
PostgreSQL replay converges on the same rows rather than duplicating them. What a
second run costs at the other two destinations is different, and worth reading
before you start one:
[Re-running a replay](replay-config-reference.md#re-running-a-replay).

Two escapes keep arbitrary ledger bytes storable in `TEXT` and `JSONB` columns,
both of which reject U+0000:

- **Composite keys** are stored as `b64:<base64 of the key's UTF-8 bytes>`.
  Ordinary keys are stored verbatim.
- **Values that are not UTF-8, or that contain U+0000 in either literal or
  `\u0000`-escaped form**, are base64-encoded and flagged in a `value_encoding`
  column on `fabric_state` and `fabric_history`.

Any query that reads `value` must exclude `value_encoding = 'base64'` rows or
decode them. See
[replay-config-reference.md](replay-config-reference.md#key-and-value-encoding).

---

## Phase 6: Verification

Verification confirms the destination contains the same data as the source extraction. The approach depends on the adapter.

### Chaincode target (Fabric-to-Fabric)

The `verify` command connects to the destination network and queries each key, comparing values with JSON normalization. It uses the same replay config as the chaincode adapter — just add `readFunctions` and `privateReadFunctions` to the `chaincode` section.

```bash
amb-migrate verify \
  --input-dir ./extraction-output \
  --config replay-config.json
```

Add these fields to your existing replay config's `chaincode` section:

```json
{
  "readFunctions": {
    "trade-public": { "marketplace": "MigrationContract:ReadState" },
    "trade-settlement": { "marketplace": "MigrationContract:ReadState" }
  },
  "privateReadFunctions": {
    "trade-public": { "marketplace": "MigrationContract:ReadPrivateData" }
  }
}
```

Both maps are keyed the same way as `keyMapping`: source channel, then a chaincode on that channel. Here
`marketplace` is deployed on two channels, so it needs a public read function under each; only
`trade-public` declares a collection, so only it needs a private one.

**Verify-specific fields in `chaincode` section:**

| Field | Required | Description |
|-------|----------|-------------|
| `readFunctions` | Yes (for verify) | Source channel → chaincode → the destination function that reads public state by key |
| `privateReadFunctions` | No | Source channel → chaincode → the destination function that reads private state by `(collection, key)` |
| `skipCompositeKeys` | No | Skip keys containing `\0` (default: `true`) — composite keys are internal chaincode indexes, not queryable via read functions |

**What it checks:**
- For each key in `public-state.ndjson`: calls `evaluateTransaction(readFn, key)` and compares the returned value
- For each key in `private-*-state.ndjson`: calls `evaluateTransaction(privateFn, collection, key)` and compares
- A private value this identity cannot read falls back to `MigrationContract:ReadPrivateDataHash`, which
  compares the destination's own SHA-256 of the value against the extracted bytes. `verify` connects one
  identity, and a merged multi-member extraction holds collections it is not a member of; a private-data
  hash is public channel data, so it is readable where the value is not. A hash match is reported as a
  match whose detail says the value was unreadable and by which MSP, a difference as a mismatch carrying
  both hashes. Only through a `privateReadFunctions` entry naming the migration contract — see
  [Private data verify cannot read](../sample/chaincode/migration_contract/README.md#private-data-verify-cannot-read)
- JSON normalization handles key-ordering differences (e.g. `{"a":1,"b":2}` matches `{"b":2,"a":1}`)
- Composite keys (containing `\0`) are skipped by default
- Before connecting to the destination, every chaincode with extracted state must have a mapped read
  function **on its own channel**. A missing `readFunctions` / `privateReadFunctions` /
  `historyReadFunctions` entry is a hard error naming each unmapped `channel/chaincode` pair, not a silent
  skip. A chaincode on two channels mapped under only one leaves the other unverified. `--channels`
  narrows what coverage requires.
- `--channels` names that are not in `manifest.json` are rejected, with the manifest's channels listed.

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | Every record that was checked matched |
| 1 | Mismatches, missing keys, or extra destination keys |
| 2 | Query errors, or nothing was checked at all (every record skipped, or no state files in scope) |

A run where everything was skipped exits 2, not 0 — an empty verification is not a passing one. The
summary prints the skip count and, per reason, which chaincodes were affected:

| Skip reason | Meaning |
|-------------|---------|
| `composite-key` | Key contains `\0`. A read function takes one key argument, so these cannot be queried individually — confirm the destination chaincode rebuilds its own indexes. |
| `no-read-function` | No `readFunctions` entry for that channel and namespace. Namespaces absent from the manifest (`lscc`, `_lifecycle`) show up in reconstructed state; map them if they hold application data. |
| `no-private-read-function` | Private state was replayed but not verified. |
| `no-history-read-function` | Replayed history was not verified. |
| `no-key-listing` | That chaincode namespace was not swept for extra keys, because its `readFunctions` entry names your own contract rather than the migration contract. |
| `no-private-history-api` | A collection's replayed private history cannot be read back. Fabric exposes no private-data history API, so no destination contract can answer for it and no config setting changes this — the current values of those keys were verified, the versions behind them were not. One skip per `(chaincode, collection)`. |

With `--output json` the same counts appear as `summary.skipsByReason`, keyed by reason, and the affected
namespaces as `summary.skipTargets`.

**Output formats:** `--output table` (default, human-readable) or `--output json` (NDJSON, for CI: one
JSON object per line, one line per entry, then a final `{"summary": {...}}` line — a run's entries are
never all held at once, so there is no whole-run document to close).

**Destination chaincode requirements:** The migration contract provides `ReadState`, `ReadPrivateData`,
`ReadPrivateDataHash` and `GetKeyHistory`, and its results are base64-decoded before comparison — a ledger value is an
arbitrary byte string, and the Node and Java contract APIs would UTF-8-mangle a returned `String`. See
[the wire contract](../sample/chaincode/migration_contract/README.md).

An existing application read function works too, as long as it returns the raw value for a key and its
name carries its contract: `"SampleAssets:ReadAsset"`. An unqualified name resolves to the migration
contract, so verify would base64-decode the result and error. That error names the fix.

### History verification (Tier 3)

When `historyReadFunctions` is configured, the verify command also checks the full write-set history for each key. For every unique key in `public-history.ndjson`, it calls the configured history function on the destination and compares the returned sequence element-by-element against the extracted history.

Add `replayHistory` and `historyReadFunctions` to your config's `chaincode` section:

```json
{
  "replayHistory": true,
  "historyReadFunctions": {
    "trade-public": { "marketplace": "MigrationContract:GetKeyHistory" },
    "trade-settlement": { "marketplace": "MigrationContract:GetKeyHistory" }
  }
}
```

The migration contract's `GetKeyHistory` function handles this automatically. See [migration-overview.md](migration-overview.md#migration-contract-setup) for setup instructions.

`replayHistory: true` is also what makes deletes reachable — a key the source deleted appears only in its
history — so this is the point at which `deleteMapping` matters for any deployment whose `keyMapping` names
a contract other than the migration contract.

History verification checks:
- History entry count matches (expected vs actual)
- Value at each position matches (with JSON normalization)
- `isDelete` at each position matches
- Composite keys (containing `\0`) are skipped

It reads no `txId`, timestamp or creator on either side, because a replayed write is a new transaction and
those necessarily differ — so a history that verifies element-for-element is still attributed to the
migration rather than to the source. [History and provenance
fidelity](replay-config-reference.md#history-and-provenance-fidelity) is what an application team needs to
see before reading anything into a passing run.

The `isDelete` check is why a history read function has to return the flag. A tombstone and a write of the
empty value hold the same value, so comparing values alone reports a match for a source delete that replay
turned into `PutState(key, "")` — a key that is live at the destination and must not be, and that range and
rich queries return. A function that omits the flag reports every deleted key as a mismatch reading
`expected <delete>, got <empty>`: verify cannot tell a destination that did not delete from a read function
that does not say so, and neither is a match. Keys that were never deleted are unaffected.

Private history is not verifiable at a Fabric destination, and the run says so rather than passing over it.
Fabric exposes no private-data history API — `GetHistoryForKey` covers public state only, and none of
`GetPrivateData`, `GetPrivateDataHash` or the private range and rich queries carries a version — so no
destination contract could answer for it. Each `(chaincode, collection)` whose history was replayed is
reported as one `no-private-history-api` skip: the current value of those keys is verified, the versions
behind it are not. This holds with or without `historyImport`: resilient replay makes the import safely
re-runnable and its per-operation **receipts** prove each import transaction was applied, but a receipt is
not a read path — it does not let `verify` compare the private historical values, which remain unreadable
for the same Fabric reason.

`GetKeyHistory` refuses a key whose history exceeds 8 MiB of accumulated value bytes rather than truncating
it, naming the key and the version it stopped at. There is no paginated history API to fetch the rest with,
so such a key has to be compared by hand — and a truncated sequence that compared equal would be reported
as a match for a history nothing checked past the cut. Returning it whole instead would eventually cross the
peer's gRPC message limit and arrive as a transport error naming no key.

### Extra destination keys

Every check above is one-directional: it asks whether each extracted key arrived, never whether anything
else is there. A destination that was not empty before replay, a source delete replayed as a write, or a
`keyMapping` function that stored under a different key all leave keys behind that the extraction does not
account for — and each of those runs reports success.

So every adapter also sweeps the other way, once per channel in scope: one `fabric_state` query, one `Scan`
filtered to the channel's partitions, or one `ListKeys` walk per chaincode namespace. Public keys the
destination holds that no extracted record accounts for are reported as `extra` and exit 1.

```
  [EXTRA] leftover-asset (marketplace)

  312 match, 0 mismatch, 0 missing, 0 error, 1 extra

  Extra (at the destination, not in the extraction):
    1 × public keys at the destination that no extracted record accounts for. ...
```

Three deliberate limits:

- **Public state only.** One member's extraction is not the whole collection set — each member replays the
  collections it can read into the same destination, so a collection absent from this extraction can still
  belong there. Sweeping private state would report the other members' data as junk.
- **A chaincode destination is swept namespace by namespace.** A range query reaches one chaincode's
  namespace at a time, so verify asks once per chaincode the manifest names. The two databases are asked
  for the whole channel instead, which is why only they can find a key under a chaincode the extraction
  never named.
- **A chaincode namespace is swept only where the migration contract is deployed.** Its `readFunctions`
  entry is what says so. Point that entry at your own contract and the namespace is reported
  `no-key-listing` among the skips — `ListKeys` has no configurable stand-in, because a paginated range
  query over a whole namespace is not a shape an application read function has.

Composite keys are swept by the databases even though they are never compared: replay wrote them, so they
are at the destination, and a source set without them would report every one as extra. `ListKeys` does not
return them — they begin with U+0000, and Fabric starts an unbounded range query after it — so on a Fabric
destination the indexes the destination chaincode rebuilds are outside the sweep in both directions.

### Database targets (PostgreSQL and DynamoDB)

`verify` covers both, and takes the same config the replay took — it dispatches on the config's `adapter`
field exactly as `replay` does, so there is nothing extra to write. `postgresql.connectionString` is
enough for one; `dynamodb.stateTable` and `region` for the other, plus `historyTable` if the history is to
be checked. No read functions, because there is no chaincode to call.

| What it compares | PostgreSQL | DynamoDB |
|---|---|---|
| Every public and private key in the state files | one `SELECT` from `fabric_state` per record, value and encoding both | one `GetItem` from `stateTable` per record, value and encoding both |
| Keys the destination holds and the extraction does not | one `SELECT` per channel over `fabric_state` | one paginated `Scan` per channel, filtered `begins_with(pk, "<channel>#")` |
| Public history, where the extraction has it | one `SELECT` per key over `fabric_history`, compared in canonical source order (`block_number`, `tx_index`, `tx_id`) | one `Query` per key over `historyTable`, compared in sort-key order, which the zero-padded `block#txIndex#txId` makes ledger order. Missing `historyTable` is refused when history artifacts exist |

Exit codes are the three above: 0, 1 on a mismatch, missing or extra key, 2 on errors or on nothing
checked. None of the skip reasons arise at a database destination — a composite key is compared like any
other key, since it is stored encoded rather than queried through a function, and there are no read
functions to be missing. So an exit 2 here means the state files were not there or held nothing in scope.

**What it does not read:** private history, block metadata, identities, private hashes. All four are
replayed; none is verified. `fabric_history` is read with `collection IS NULL`, so a private history
record's absence at the destination looks like nothing at all, and the other three tables are never
queried. Check them with the queries below — a `verify` that exits 0 against a Tier 2 or Tier 3 database
destination has said nothing about the two tables that carry the audit trail.

```sql
-- State record counts should match NDJSON line counts
SELECT channel, chaincode, COUNT(*) FROM fabric_state GROUP BY channel, chaincode;

-- History ordering: block numbers must be non-decreasing per key
SELECT channel, chaincode, key
FROM (
  SELECT *, lag(block_number) OVER (
    PARTITION BY channel, chaincode, key ORDER BY block_number
  ) AS prev_block
  FROM fabric_history
) t
WHERE prev_block IS NOT NULL AND block_number < prev_block;
-- Should return 0 rows

-- Block completeness: no gaps
SELECT channel,
       COUNT(DISTINCT block_number) AS blocks,
       MIN(block_number) AS first,
       MAX(block_number) AS last,
       MAX(block_number) - MIN(block_number) + 1 AS expected
FROM fabric_block_metadata
GROUP BY channel;

-- Identity coverage: every creator in block metadata has an identity row
SELECT DISTINCT m.creator_msp_id, m.creator_cn
FROM fabric_block_metadata m
LEFT JOIN fabric_identities i
  ON i.msp_id = m.creator_msp_id AND i.common_name = m.creator_cn
WHERE i.msp_id IS NULL;
-- Should return 0 rows

-- tx_count is a bound, not an equality: replay takes GREATEST across exports
-- rather than summing, and block metadata carries no certificate fingerprint,
-- so a rotated cert is two identity rows but one creator_cn. Only the
-- direction is invariant.
SELECT i.msp_id, i.common_name, i.tx_count, COUNT(m.tx_id) AS recorded
FROM fabric_identities i
LEFT JOIN fabric_block_metadata m
  ON m.creator_msp_id = i.msp_id AND m.creator_cn = i.common_name
GROUP BY i.msp_id, i.common_name, i.tx_count
HAVING i.tx_count > COUNT(m.tx_id);
-- Should return 0 rows
```

Idempotency is not one of these queries — it takes two runs, not one. Record the
row counts above, re-run the same replay, and compare: PostgreSQL's upserts leave
both the counts and the values unchanged. Do not carry that result over to a
chaincode destination, where the same second run resubmits every record. See
[Re-running a replay](replay-config-reference.md#re-running-a-replay).

---

## Multi-member coordination

For a 2-member network, each org runs the full pipeline independently. The key coordination points:

### Before extraction

1. **Agree on one ledger height, not a similar one.** If OrgA extracts `trade-settlement` at block 4200 and OrgB at 4500, OrgB has 300 blocks of state OrgA does not — and `merge` refuses that pair outright (step 4) rather than pair one member's private data with another member's public state. It compares the height of every channel more than one member extracted, so there is no rounding to be had. Quiesce first so the height stops moving, then agree it, then extract. For shared channels one member's extraction covers the public data; private data needs every member whose collections are in scope.

2. **Assess purge risk.** Collections with `blockToLive > 0` are time-sensitive. If `tempNotes` has `blockToLive=500`, every new committed block brings older data closer to purging. Extract before it's lost.

### After extraction

   **Lead-run extraction: only one member walks the ledger.** One member — the lead — extracts every channel in full. Every other member runs `extract --private-only`, which skips the public block walk and delivers only that member's private values (`DeliverWithPrivateData`), so its part takes seconds and its output is the size of its private data. `sample/scripts/multi-member/member-kit.sh` is that member's whole job: discover at the heights the lead announced (refusing if its peer disagrees), extract `--private-only`, validate, and package a kit with a SHA-256. A private-only directory records `scope: "private-only"` in each channel's `metadata.json`, carries no hashes, and is merge input only — `replay` refuses it, and `merge` refuses a channel no member extracted in full. Its values are checked against the lead's hashes at merge exactly like a full member's. A collection the member was entitled to and delivered nothing for is reported `indeterminate` in its own metadata, because without hashes it cannot tell "never written" from "missing"; `merge` resolves that from the lead's hashes into `never-written`, `purge-window` or `unexplained`.

3. **Exchange extraction directories.** OrgA has `orgAConfidential` values; OrgB has `orgBConfidential` values. If the migration requires both, the orgs must agree to share their extraction outputs. Exchange whole directories, not individual files: `merge` reads each member's `manifest.json` and `channel-*/metadata.json` to check the two extractions are comparable and to report what each member could see.

4. **Merge extractions.**
   ```bash
   amb-migrate merge \
     --input-dirs orgA-output orgB-output \
     --output-dir merged
   ```

   The merge sort-merges private history and hashes on `(blockNumber, txIndex)`, dedupes on `(blockNumber, txIndex, chaincode, collection, key)`, and writes canonical `private-<chaincode>-<collection>-*.ndjson` filenames that replay picks up. Public state, public history and block metadata are identical on every peer of a channel, so they are copied from one member — but only after `merge` has confirmed the members' copies agree, and it refuses to merge members at different ledger heights.

   `merge` prints a **cross-member coverage matrix**: one row per `(chaincode, collection)` naming which members contributed values, which contributed only hashes, and why anything is missing. Read this before replaying — it is the artifact the go/no-go call is made from. It exits non-zero when two members hold different values for one key, or when a collection's absence has no established cause (`unexplained` or `indeterminate`). Neither is loss a data owner can accept, because neither says what was lost.

   A member whose peer joined the channel late never received the private values written before it joined, so on its own it fails `validate` ("no value and no explanation", "missing from private history"). `merge` judges each member with the others in view: a gap another member's extraction fills is accounted for (`held-by-other-member`), and the merged directory is validated whole afterwards, so a value or history block **no** member holds still stops the merge and removes the manifest. Run `validate` on a late joiner alone and it still reports the gap; that is expected.

   The full report is written to `merged/merge-report.json`.

### At the destination

5. **Validate and replay the merged output.** Run `validate --input-dir merged`, then replay `merged` — not the per-member directories, which each hold only their own private data. `validate` reads `mergedFrom` from the merged manifest, so a key missing from a collection *some* contributing MSP was entitled to reads as `unexplained` rather than being excused.

6. **Give each member's collections a destination collection.** A merged 2.x directory carries one `_implicit_org_<MSPID>` per contributing member, and each of those names a *source* MSP ID. Add one `chaincode.mspMapping` entry per member, naming the destination MSP that member becomes. Each entry routes that member's implicit collection on every chaincode and channel. Use a `chaincode.collectionMapping` entry instead for a collection that belongs in a collection the destination chaincode declares, and see [Per-member shorthand](replay-config-reference.md#per-member-shorthand-mspmapping-orgidentities). Replay refuses before its first write if one is missing, and refuses two of them mapped onto one destination collection.

7. **Give each member's collections a destination identity.** Each destination collection admits writes only from the orgs its policy names — one admin identity would have most of that private data denied at endorsement. Add a `chaincode.orgIdentities` entry per destination org, with its credentials and a peer of that org: each org's implicit collection is then written as that org, and a declared collection the org owns takes a one-word `collectionIdentities` entry naming its MSP ID; see [replay-config-reference.md](replay-config-reference.md#per-collection-identities-collectionidentities). Both maps are keyed by the **destination** — collection name or MSP ID — since that is the policy that decides the write. Replay refuses before its first write if one is missing, so this cannot be discovered halfway through a migration.

   **One operator for all members.** Where the consortium agrees that one member runs the destination side, that member does not need the other orgs' keys for their implicit collections: with `chaincode.ownerEndorsement: true` it submits those writes itself and names the owning org as endorser, which is what an implicit collection's policy requires. It still needs an identity of each org for any declared collection with `memberOnlyWrite` that it is not a member of. See [ownerEndorsement](replay-config-reference.md#writing-other-orgs-implicit-collections-without-their-keys-ownerendorsement), including what it moves to the consortium's agreement.

---

## What this tool does NOT do

- **Migrate running chaincode.** The tool extracts data, not execution logic. You must port your chaincode to the destination platform separately.

- **Preserve block structure at the destination.** A Fabric-to-Fabric replay creates new blocks on the destination with new block numbers and new transaction IDs. The original block ordering is captured in `block-metadata.ndjson` for audit purposes, but the destination ledger has its own independent block sequence.

- **Handle in-flight transactions.** The extraction is a point-in-time snapshot. Transactions committed after extraction starts but before it finishes may or may not be captured, depending on when the block walk reaches those blocks. For consistency: stop submitting transactions, wait for the ledger to quiesce, then extract.

- **Migrate Fabric channel configuration.** Channel policies, consortium definitions, and MSP configurations are not extracted. The destination Fabric network must be configured independently.

- **Run continuously.** This is a one-shot migration tool, not a replication service. For ongoing sync, consider Fabric's native peer channel join or a CDC pattern.
