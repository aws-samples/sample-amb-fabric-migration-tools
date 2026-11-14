# Self-assessment questionnaire

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Questions to answer about your own network before running this toolkit.
The first four sections are the most critical: they determine what is
technically possible and how long extraction takes.

## 1. Network & Environment

- Which **AWS region** is your AMB network deployed in?
- How many **Fabric networks** are you migrating? (one or several?)
- What **Fabric version** is your network running? (1.2, 1.4, 2.0–2.3, 2.4+)
  This determines private data support and Gateway vs. legacy SDK mode.
- Is the network **still active**, or has it been decommissioned / scheduled
  for shutdown? What is the deadline?

## 2. Network Topology

- How many **organizations** (members) are in the network? Will each org run
  the tool independently, or is one org coordinating?
- How many **channels** exist? Do you need to migrate all of them, or a subset?
- How many **chaincodes** are deployed per channel?
- What **state database** does your peer use — CouchDB or LevelDB?

## 3. Data Characteristics

- How tall is your **ledger**? (approximate block height per channel) — Affects
  extraction time for Tier 2/3.
- How large are your **typical values**? (< 1 KB, 1–10 KB, > 10 KB) — Affects
  batch tuning.
- Do you use **private data collections**? If so:
  - How many collections?
  - Do any have a `blockToLive` purge policy? If yes, extraction is
    time-sensitive — every new block brings older private data closer to
    permanent deletion.
  - Are there collections your org is **not authorized** to read? The owning
    org must extract the values; you will only get hashes.
  - For a Fabric → Fabric migration, **can each owning org give you a
    destination identity and a peer of its own?** A destination collection
    admits writes only from the orgs its policy names, so replaying another
    org's collection needs that org's certificate, key and peer — a peer that
    is not a collection member cannot store the private data it endorses.

## 4. Migration Tier

Each tier is a strict superset of the previous one. The tradeoff is
speed/storage vs. data completeness.

| Tier | Name | What you get |
|------|------|-------------|
| 1 | Current State | Point-in-time snapshot of every live key-value pair (fastest) |
| 2 | State + Audit Trail | Tier 1 plus per-transaction block metadata, signing identities |
| 3 | Full History | Tier 2 plus every value ever written to every key from genesis (slowest) |

Use these to narrow the choice:

- Do you **only need the current state** of each key? → Tier 1
- Does anyone need to answer **"who submitted transaction Y?"** → Tier 2+
- Does anyone need to answer **"what was the value of key X at time T?"** or
  **"show me every change to key X"?** → Tier 3
- Are there **compliance or regulatory requirements** driving the migration?
  These often mandate Tier 2 or 3.

## 5. Migration Destination

Where should the data land?

- **Another Fabric network** — Preserves chaincode execution semantics. Data
  is replayed as transactions. Requires a destination network already
  provisioned with channels and chaincode that accepts `PutState` /
  `ImportPrivateData` calls.
- **PostgreSQL** — Best for analytics, SQL querying, full-text search.
  Preserves all data including private data hashes.
- **DynamoDB** — Best for serverless / staying in AWS. Preserves the same data,
  across one table per record type.

Follow-up:

- Do you also need **chaincode logic translated** to another platform? This toolkit
  migrates data, not chaincode logic; porting the chaincode is separate work.

## 6. Fabric-to-Fabric Details

Skip this section if the destination is PostgreSQL or DynamoDB.

- Do you have the **source code for every chaincode** deployed on the source
  network? AMB does not provide a way to download installed chaincode packages.
  The tool ships a migration contract you add to your existing chaincode
  package (one file, one import, one list of writer MSP IDs) — no
  modifications to your application logic.
- Which **destination MSP IDs will the replay submit as**? The migration
  contract refuses a write from any MSP its writer list does not name, and
  ships with that list empty, so the answer has to be in the chaincode package
  each org approves. It is every member whose private collections you replay,
  not only the org whose peer you submit through.
- Is the destination network **already provisioned**? (channels created,
  chaincode deployed with the migration contract included and its writer list
  set)
- Have you **recreated channel policies** on the destination? The tool
  migrates data, not network configuration. Endorsement policies, ACLs,
  reader/writer policies, and collection policies must be configured
  manually on the destination. Destination topology often differs from
  source (different members, MSP IDs, org structure), so AMB policies
  rarely translate directly.
- What **language** is your chaincode written in? (Go, Node.js, or Java)
  The migration contract is provided in all three.
  If the destination is a managed Fabric service, check which chaincode
  languages its deployment accepts, as some accept only a subset.
- **Channel mapping**: what is each source channel's destination channel
  name? Each needs its own — several source channels cannot share one, since
  a destination channel is a single ledger.
- Do you need **history replay**? (Tier 3 only — each historical write
  becomes a separate transaction so `GetHistoryForKey` works at the
  destination)

## 6b. Preserving transaction history (re-broadcast)

Answer these if you want the same transaction IDs, signers, history and block
numbers at the destination, which the block-level re-broadcast tool preserves.
See [Re-broadcast](rebroadcast.md) for how each answer shapes the migration.
Skip the section for PostgreSQL or DynamoDB destinations.

- Can the destination reuse the **same channel names and MSP IDs** as the
  source? Re-broadcast replays each channel under its own name, with one org per
  source member using the same MSP ID.
- Is the destination a **self-managed Fabric 2.5 network** (Raft orderers,
  channel participation), and can you keep it empty until the run and the tip
  phase finish?
- Are you allowed to run a **patched orderer during the migration window** only,
  to send ahead of `BatchTimeout` and to accept signers whose certificates have
  since expired?
- Have any **signer certificates expired**? Peers ignore expiry, but a stock
  orderer rejects an expired signer at ingress, so expired signers need the
  expiry bypass.
- Which **admins can sign config updates**, and are their admin certificates
  still valid? Mirrored config blocks must be signed by the destination's
  admins, so a member that has left the network is a planning problem.
- Do you have the **chaincode source** for every chaincode, to redeploy at the
  tip with the migration contract added? AMB does not export chaincode packages.

## 7. Prerequisites & Readiness

- Do you have an **EC2 instance in the same VPC** as the AMB network? Peers
  are only reachable via VPC endpoints on ports 30001–30004.
- Do you have **enrolled admin MSP credentials**? (signcerts + keystore from
  `fabric-ca-client enroll`)
- Do you have the **AMB TLS CA certificate** downloaded from S3?
- Do you have the required **IAM permissions**?
  - `managedblockchain:Get*`, `managedblockchain:List*`, S3 access for the
    TLS cert
  - DynamoDB: `CreateTable`, `BatchWriteItem`, `UpdateItem` (if applicable)
- Can you **quiesce the network** (stop submitting transactions) during
  extraction? The tool captures a point-in-time snapshot — concurrent writes
  risk inconsistency.

## 8. Operational Constraints

- What is your **timeline**? Extraction time scales with ledger height and
  tier: Tier 1 is minutes, Tier 3 on a tall ledger could be hours.
- **Memory constraints** on the extraction host? Large ledgers may need
  LevelDB-backed state accumulation (auto-promotes at 512 MB by default, shared
  across channels extracted in parallel).
- **Disk** on the extraction host? Promotion spills the whole reconstructed state
  to a directory — `--state-data-dir`, which defaults to the system temp
  directory and so to the root volume.
- Do you need **identity attribution preserved**? Currently replay submits as
  one admin identity per organization (`collectionIdentities` picks the org, so
  another org's collection is writable), never as the identity that originally
  wrote the key — identity-mapped replay is not built.
