# Migration Decision Guide

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This guide walks through the critical decisions in a Fabric AMB migration,
in the order they should be made. Each section explains the tradeoffs and
gives a recommendation path.

## 1. Data Depth: Choosing a Migration Tier

The tier determines how much of the ledger's history you extract. Each tier
is a strict superset of the previous one — more data, more time, more
storage.

```
Do you need the complete write history of every key?
(every value ever written, from genesis)
│
├─ YES ──────────────────────────────────── Tier 3: Full History
│
└─ NO
   │
   Do you need an audit trail?
   (who signed each transaction, when, via which chaincode)
   │
   ├─ YES ──────────────────────────────── Tier 2: State + Audit Trail
   │
   └─ NO ───────────────────────────────── Tier 1: Current State
```

### What each tier produces

| Tier | Output files | Use case |
|------|-------------|----------|
| 1 | `public-state.ndjson`, `private-<chaincode>-<collection>-state.ndjson` | App only needs current values. No audit requirements. |
| 2 | Tier 1 + `block-metadata.ndjson`, `identities.ndjson` | Regulatory/compliance: who changed what, when. |
| 3 | Tier 2 + `public-history.ndjson`, `private-<chaincode>-<collection>-history.ndjson`, `private-<chaincode>-<collection>-hashes.ndjson` | Forensic analysis, full lineage, "value of key X at time T" queries. |

### Deciding factors

- **Compliance or regulatory mandate** — If auditors need transaction-level
  provenance, Tier 2 is the minimum. If they need full value history, Tier 3.
- **Extraction time** — Tier 1 reads current state only. Tiers 2 and 3 walk
  every block from genesis. On a tall ledger (hundreds of thousands of
  blocks), Tier 3 can take hours.
- **Storage** — Tier 3 output can be an order of magnitude larger than Tier 1
  for ledgers with high write volume per key.
- **Destination capabilities** — PostgreSQL and DynamoDB can store all tier
  levels, source transaction IDs and timestamps included. For Fabric-to-Fabric,
  Tier 3 with `replayHistory: true` replays each historical write as a separate
  transaction so `GetHistoryForKey` works at the destination — but each of those
  transactions is the migration's, so the history it returns carries the
  migration's `txId`, timestamp and creator MSP. If the application reads that
  metadata rather than the values, no tier recovers it at a Fabric destination:
  see [History and provenance
  fidelity](replay-config-reference.md#history-and-provenance-fidelity).

### Private data and purge urgency

If your network uses private data collections with a `blockToLive` purge
policy, tier selection interacts with extraction timing:

```
Do any collections have blockToLive > 0?
│
├─ NO ── No urgency. Private data is retained indefinitely.
│
└─ YES
   │
   Is the ledger height well below blockToLive?
   (e.g., blockToLive=10000 and ledger is at block 3000)
   │
   ├─ YES ── Low risk. No data has been purged yet.
   │         Still extract sooner rather than later.
   │
   └─ NO
      │
      Is the ledger height more than 2× blockToLive?
      │
      ├─ YES ── HIGH risk. Most historical private data
      │         is already purged. Only hashes remain for
      │         purged blocks. Extract immediately. Quiesce
      │         the network first — every new block purges more.
      │
      └─ NO ─── Medium risk. Some data may be purged.
                Extract soon. Prioritize collections with
                the lowest blockToLive values.
```

**Key rule:** If any collection has `blockToLive > 0` and the network is
still committing blocks, **quiesce first, then extract**. Every new block
committed brings older private data one block closer to permanent deletion.

For Tier 3 migrations, purged private data values are gone — only their
SHA-256 hashes survive. You can still prove the data existed and verify
integrity, but the values themselves are unrecoverable.

## 2. Destination: Where Should the Data Land?

```
Do you need to keep running chaincode
against the migrated data?
│
├─ YES ──────────────────────────────────── Fabric 2.4+
│                                            (2.0–2.3 cannot be reached)
└─ NO
   │
   Do you need SQL queries, joins, or
   full-text search over the data?
   │
   ├─ YES ──────────────────────────────── PostgreSQL
   │
   └─ NO
      │
      Do you need to preserve private
      data hashes for integrity proofs?
      │
      ├─ YES ──────────────────────────── PostgreSQL
      │
      └─ NO
         │
         Are you staying in AWS /
         building serverless?
         │
         ├─ YES ──────────────────────── DynamoDB
         │
         └─ NO ───────────────────────── PostgreSQL
```

### Comparison

| | Fabric | PostgreSQL | DynamoDB |
|---|--------|-----------|----------|
| **Preserves chaincode semantics** | Yes — data replayed as transactions | No | No |
| **Public state** | Full | Full | Full |
| **Private data values** | Full (authorized collections) | Full | Full |
| **Private data hashes** | No (not a native concept) | Yes (`fabric_private_hashes` table) | No |
| **Block metadata** | No (destination creates own blocks) | Yes (`fabric_block_metadata` table) | Yes (optional table) |
| **Identities** | No (submitted under admin; identity-mapped replay is not built) | Yes (`fabric_identities` table) | Yes (optional table) |
| **History (Tier 3)** | Yes, via `replayHistory: true` — destination's `GetHistoryForKey` works, but every entry is attributed to the migration, not the source transaction, and the default `replayHistory: false` leaves one entry per key ([provenance](replay-config-reference.md#history-and-provenance-fidelity)) | Yes (`fabric_history` table) | Yes (optional table) |
| **Query model** | Chaincode + CouchDB/LevelDB | SQL | Key-value + GSIs |
| **Idempotent replay** | State only (a replayed write is last-write-wins, batched or not). **Not** with `replayHistory: true` — every re-run appends another `GetHistoryForKey` entry, so a failed history replay needs a destination reset ([what a second run does](replay-config-reference.md#re-running-a-replay)) | Yes (`ON CONFLICT DO UPDATE`) | Yes (a `PutRequest` replaces the whole item) |
| **Best for** | Continuing blockchain operations | Analytics, reporting, compliance archive | Serverless apps, staying in AWS |

### Destination-specific considerations

**Fabric:** Requires **Fabric 2.4 or later with the Gateway service enabled**.
`replay` and `verify` connect through `@hyperledger/fabric-gateway` and have no
legacy-SDK path, so a 2.0–2.3 destination cannot be reached at all — and neither
can another AMB network, whose framework versions top out at 2.2. If the
destination has to be 2.2, the Fabric branch of the tree above is closed and the
choice is PostgreSQL or DynamoDB. See
[Fabric version support](fabric-version-support.md#destination-a-fabric-destination-must-be-24-or-later).
Also requires a provisioned network with channels,
channel policies, and chaincode already deployed. The tool migrates data,
not network configuration — endorsement policies, ACLs, reader/writer
policies, and collection policies must be recreated manually on the
destination. Add the tool-provided migration contract to each chaincode
package before deploying, and name the MSP IDs allowed to write in it — it
ships refusing every write. Original block numbers, transaction IDs, and
block structure are not preserved — the destination creates its own
independent ledger.

For a long **Tier 3 history** migration to a Fabric destination, enable
`chaincode.historyImport` (resilient idempotent replay). Without it a history
replay is one-shot — any failure marks the checkpoint dirty and forces a
destination reset — which is impractical over a deep history. With it, a failed
run re-runs safely from its checkpoint with no reset, because the migration
contract records a per-operation receipt and treats an already-applied record as
a no-op. It requires the destination contract to implement the `idempotent-v1`
protocol and a retained HMAC key plus scope. See
[Resilient idempotent history replay](replay-config-reference.md#resilient-idempotent-history-replay-historyimport).

**PostgreSQL:** Requires only a connection string. Tables are created
automatically. Best option when you need the most complete data preservation
(all five tables) or plan to run analytical queries.

**DynamoDB:** Requires table name decisions at configuration time. Tables are
created automatically with PAY_PER_REQUEST billing. Only the state table is
required; history, metadata, identity, and private-hash tables are optional,
and a record type whose table is omitted is not replayed at all.

### Fabric destinations: replay or re-broadcast

A Fabric destination can be reached two ways, and the choice decides what the
extraction has to produce, so make it before the first extraction.

- **Replay** (`amb-migrate replay`) writes the extracted keys and values as new
  transactions. It reaches any destination above, and channels and orgs can be
  renamed, merged or split. Destination history carries the migration's
  transaction IDs, timestamps and creator.
- **Re-broadcast** (`fabric-rebroadcast`) re-sends the source's original signed
  transactions, block by block. Transaction IDs, signers, invalid transactions,
  block numbers and `GetHistoryForKey` stay identical. The destination must be
  Fabric 2.5, empty, with the same channel names and MSP IDs.

Choose re-broadcast when applications or auditors rely on the original
transaction IDs, signers or key history, and the names can stay. Otherwise
choose replay. The full comparison is in
[Re-broadcast](rebroadcast.md#replay-or-re-broadcast).

What each path needs from extraction:

| | Replay | Re-broadcast |
|---|---|---|
| Each member, against its own peer | `extract --tier <1, 2 or 3>`, the tier from [section 1](#1-data-depth-choosing-a-migration-tier) and the destination | `extract --tier 3`. Any tier writes the private values re-broadcast imports; Tier 3 adds the private-hash files that `validate` and the coverage report check them against |
| Block archive | Not used | One member adds `--save-blocks <archive>` to the same run. It holds every block of every channel from block 0. The blocks are the same for every member, so one archive is enough |
| Several members | `merge` the members' directories, then replay from the merged one | No merge needed. Each member runs `tip import-private` and then `verify --private` with its own output, through its own peer (on a managed-provider destination, the operator gives every member's output). Verify fails a member's run if a collection that member can read has a key with no value supplied, and it names the other members who still have to verify |
| Final top-up after the freeze | `extract --extend` per member, `merge` again, `replay --since extension` | `extract --save-blocks <archive> --blocks-only` into the same archive, then `run` again; and `extract --extend` per member, for private values written since the first pass |

So for re-broadcast, the member that keeps the archive gets everything in one
run:

```bash
amb-migrate extract --manifest ./extraction-output/manifest.json --tier 3 \
  --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --msp-path $MSP_PATH \
  --output-dir ./extraction-output --save-blocks ./archive
```

That run also holds everything replay needs, so replay stays open as a
fallback. `--save-blocks` cannot be added to an extraction that has already
been made: start a new output directory, or build the archive alone with
`--save-blocks <archive> --blocks-only`.

## 3. Scope: Channels, Chaincodes, and Identity

### Which channels to include

```
How many channels does the network have?
│
├─ ONE ── Include it. No decision needed.
│
└─ MULTIPLE
   │
   Does every channel contain data you need?
   │
   ├─ YES ── Extract all. Use channelMapping at replay
   │         to route each source channel to its destination.
   │
   └─ NO
      │
      Can you identify the subset now?
      │
      ├─ YES ── Pass --channels to extract only those.
      │         Saves time proportional to excluded
      │         channels' block heights.
      │
      └─ NO ─── Extract all. You can selectively replay
                later — channels not in channelMapping
                are skipped with a warning and named in
                the replay summary under "Channels
                skipped". The run still exits 0.
```

**Channel mapping at replay (Fabric destination only):**

When replaying to Fabric, one source channel goes to one destination channel.
There is no choice to make about that — collapsing several into one is refused,
because a destination channel is a single ledger and two channels' copies of a
shared key would overwrite each other there with nothing reported. What is left
to configure is the names:

- **Channel mapping** (`channelMapping`): each source channel maps to a named
  destination channel, and no two in the run may name the same one. Source
  channels not in the map are skipped by `replay` and refused by `verify`.
- **Single channel** (`channel`): the shorthand for a run covering exactly one
  source channel — the whole extraction, or a `--channels`-narrowed rerun.
  Refused for more than one.

```json
{
  "channelMapping": {
    "trade-public": "trade-public",
    "trade-settlement": "settlement-v2"
  }
}
```

For PostgreSQL and DynamoDB, channel identity is preserved as a column/attribute
on every record — no mapping decision needed.

### Which chaincodes to include

Extraction captures data for every chaincode discovered on the selected
channels. There is no chaincode-level filter at extraction time.

At replay, chaincode scope matters for Fabric destinations. The replay tool
submits transactions to existing chaincode — it does not deploy chaincode. What
it requires is a chaincode already committed at the destination under the same
name, exposing the migration contract's functions. Having your own source is how
you normally get there, by adding one file to it, but it is not what the tool
checks for.

The tool ships a **migration contract** — a single file you add to your
existing chaincode package. It provides `PutState`, `PutStateBatch`,
`ImportPrivateData`, and other functions the replay tool needs. No modifications to your
application logic; the one edit is to the file itself, naming the MSP IDs
allowed to write, which is empty in the shipped copy and refuses everything
until you set it.

```
Are you replaying to Fabric?
│
├─ NO ── All chaincode data is replayed as records.
│        No chaincode-level decisions needed.
│
└─ YES
   │
   Do you have the source code for every
   chaincode in the manifest?
   │
   ├─ YES
   │  │
   │  1. Add the migration contract to each
   │     chaincode package (one file, one import),
   │     naming the MSP IDs allowed to write.
   │  2. Deploy to destination channels.
   │  3. Configure readFunctions and
   │     privateReadFunctions per channel and
   │     chaincode for post-replay verification.
   │  4. After migration, remove the migration
   │     contract import and upgrade.
   │
   └─ NO
      │
      AMB does not provide a way to download
      installed chaincode packages.
      │
      ├─ Replay needs only a chaincode of the
      │  same name carrying the migration
      │  contract. The data reaches the
      │  destination ledger and verify passes;
      │  no application function can read it
      │  until the logic is recreated.
      │
      └─ For chaincodes where you cannot
         obtain or recreate the source,
         use PostgreSQL or DynamoDB
         as the destination instead.
```

See
[Destination chaincode pre-flight](replay-config-reference.md#destination-chaincode-pre-flight)
for what the destination must have committed before replay.

### Identity attribution

```
Does the destination need to reflect who originally
wrote each key? (e.g., for access control, audit)
│
├─ NO ── Use default single-admin replay.
│        All transactions submitted under one identity.
│
└─ YES
   │
   Is the destination Fabric?
   │
   ├─ NO ── PostgreSQL and DynamoDB store creator
   │        metadata (mspId, commonName, fingerprint)
   │        as columns/attributes. No credential
   │        mapping needed — identity is data.
   │
   └─ YES
      │
      Per-key identity attribution is not
      implemented. Two things you can do:
      │
      ├─ PER-COLLECTION, not per-key: a private
      │  collection can be written by an identity
      │  of the org that owns it, via
      │  chaincode.collectionIdentities. Public
      │  state and every key within a collection
      │  still come from one admin.
      │
      └─ PROCEED with single-admin replay.
         Creator metadata is preserved in
         extraction records, so a re-replay
         could re-attribute it if the feature
         is ever built.
```

There is no `generate-identity-map` command and no `--identity-map` flag;
identity-mapped replay is not built. Choosing to wait on it is choosing to wait on unscheduled work.

## 4. Multi-Org Coordination

In multi-member networks, each org's peer only holds private data for
collections where that org is in the collection policy. Public data is
identical across all peers on the same channel.

```
How many orgs are in the network?
│
├─ ONE ── No coordination needed. You have access
│         to all data. Proceed to extraction.
│
└─ MULTIPLE
   │
   Does the migration need private data from
   collections your org cannot access?
   │
   ├─ NO ── Single-org extraction is sufficient.
   │        You get full public state and full
   │        private data for your authorized
   │        collections. Unauthorized collections
   │        yield hashes only (enough for integrity
   │        proofs but not values).
   │
   └─ YES
      │
      Choose a coordination strategy:
      │
      ├─ A) CENTRALIZED: One org extracts,
      │     others share private data files.
      │
      └─ B) DISTRIBUTED: Each org extracts
            independently, then merge.
```

### Strategy A: Centralized extraction

One designated org runs the full pipeline. Other orgs share their private
data by running extraction for their authorized collections and handing over
the NDJSON files.

| Advantage | Disadvantage |
|-----------|-------------|
| Single extraction run for all public data and block metadata | Requires trust: other orgs must share confidential collection data with the coordinating org |
| Simpler merge — one base extraction, others contribute private files only | Coordinating org sees private data it was not originally authorized to access |
| Easier to ensure consistent ledger height across all data | Other orgs must still run the tool to extract their private collections |
| One replay config, one replay run | Single point of failure — if the coordinator's extraction fails, everyone waits |

**When to use:** The orgs have high mutual trust, one org is clearly the
migration lead, and minimizing operational complexity matters more than data
isolation.

### Strategy B: Distributed extraction

Each org runs the full pipeline independently against its own peer, then
the outputs are merged.

| Advantage | Disadvantage |
|-----------|-------------|
| Each org controls its own data — no sharing of raw private values required until merge time | Must coordinate extraction timing to align ledger heights |
| No single point of failure | Extra merge step, and every org must have extracted at the same ledger height for it to run |
| Each org can validate its own extraction independently | Public data and block metadata are extracted redundantly (identical from any peer) |
| Natural audit trail — each org's extraction is independently verifiable | More total extraction time and storage |

**When to use:** Orgs have limited trust, data sovereignty matters, or each
org wants independent verification before sharing.

### Merge procedure (either strategy)

1. **Align timing.** All orgs should extract at the same ledger height. If
   OrgA extracts at block 4200 and OrgB at block 4500, OrgB has 300 blocks of
   state OrgA does not.
2. **Quiesce the network** before any org begins extraction.
3. **Exchange extraction directories.** Share whole output directories, not
   individual collection files — `merge` reads each member's manifest and
   channel metadata to establish that the extractions are comparable.
4. **Merge** into one directory:
   ```bash
   amb-migrate merge \
     --input-dirs orgA-output orgB-output \
     --output-dir merged
   ```
   Private history and hashes are sort-merged on `(blockNumber, txIndex)` and
   deduped on `(blockNumber, txIndex, chaincode, collection, key)`. Public state,
   public history and block metadata are copied from one member — they are
   identical on every peer of a channel, and `merge` verifies that before
   copying rather than assuming it.
5. **Read the coverage matrix** `merge` prints: one row per
   `(chaincode, collection)` naming which members contributed values and why
   anything is missing. `merge` exits non-zero on a value conflict between
   members, or on a collection whose absence nothing explains.
6. **Validate and replay** the merged directory — not the per-member ones,
   which each hold only their own private data.
7. **Give each org's collections a destination identity.** A merged directory
   carries collections several orgs own, and a destination collection admits
   writes only from the orgs its policy names — one admin identity would have
   most of that private data denied at endorsement. Add a
   `chaincode.collectionIdentities` entry per collection, naming that org's
   certificate, key and a peer of that org. Replay refuses before its first
   write if one is missing, so a Fabric → Fabric merge cannot get halfway
   through and stop.
