# Migration Guidance: Amazon Managed Blockchain Hyperledger Fabric

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This guide describes how to plan and execute a migration from an Amazon Managed Blockchain (AMB) Hyperledger Fabric network to a new destination. It is intentionally tool-neutral and applies whether the migration uses an approved migration service or a process you build yourself.

A migration utility can automate block retrieval, state reconstruction, file handling, replay, and comparison. It cannot decide what the data means, establish authority to disclose private data, recreate the destination's governance model, or prove that an application still behaves correctly. Those decisions belong in the migration plan and must be approved by the data owners and participating organizations.

> **Important:** This guide assumes a logical migration. The source is read, its data is represented as portable records, and those records are loaded into a destination. A logical replay creates new destination transactions; it is not a byte-for-byte continuation of the source ledger. If the requirement is to preserve the original block chain and cryptographic transaction history exactly, treat that as a separate feasibility question and do not assume that a logical extraction/replay can meet it.

## 1. Understand what is being migrated

### 1.1 AMB and Hyperledger Fabric in migration terms

An AMB Hyperledger Fabric network is a permissioned network with multiple members. A member is comparable to an organization in standard Fabric terminology. Each member operates one or more peers. Eligible endorsing peers endorse transactions, peers maintain ledgers for the channels they join, and peers provide access to chaincode and state.

A client does not normally connect to an AMB peer over the public internet. Client applications and migration hosts need an appropriate private network path, such as an interface VPC endpoint, and must authenticate with Fabric credentials accepted by the member and channel. Plan the migration host, IAM access, network routes, TLS trust, and credential handling as part of the source-access work.

**Migration mechanism:** Extraction is performed programmatically through a Hyperledger Fabric client SDK or client library. The migration service uses Fabric client APIs over the source network connection to authenticate with MSP credentials, discover channels and configuration, retrieve blocks and transaction metadata, and obtain public state and authorized private data. It does not read peer filesystem databases directly. This is an SDK/client-based process, not a direct filesystem or state-database export.

When the destination is Fabric, replay is also performed programmatically through a Fabric client SDK or client library. The migration service submits proposals and transactions to destination peers and the ordering service, then waits for commit and validation events. These are new destination transactions, not copied source blocks. When the destination is a database or archive, the Fabric client is used for extraction and the loaded records are written through the destination's native APIs.

Fabric separates responsibilities that are often combined in a conventional database:

- **Network and membership:** members, organizations, certificate authorities, membership service providers (MSPs), peers, orderers, and trust roots.
- **Channel:** a private communication and governance domain. Each channel has its own ledger. Data on one channel does not automatically appear on another channel.
- **Blockchain:** the append-only sequence of blocks and transactions for a channel, including transaction metadata and validation results.
- **World state:** the current key-value state derived from valid transactions in the blockchain.
- **Chaincode namespace:** the state namespace associated with a chaincode deployment on a channel.
- **Private data collection:** values held only by authorized peers, with hashes recorded on the channel ledger for validation and evidence.

These layers have different migration methods and different completeness guarantees. “The ledger” is therefore not a single export file with one obvious destination schema.

> **Version gate:** Treat the source Fabric framework version as a migration constraint, not as descriptive metadata. AMB framework generations do not expose identical client interfaces or private-data retrieval behavior. Before promising private plaintext migration, verify the exact source version, the selected Fabric client SDK, and the peer capabilities with the applicable AMB and Hyperledger Fabric documentation and a dry run.

### 1.2 Current state, history, and evidence are different deliverables

Before extracting anything, decide which of the following the destination must provide:

| Requirement | What to preserve | Typical destination use |
|---|---|---|
| Current state | The latest non-deleted value for each in-scope public and private key at a defined cutoff | Continue an application from its current position or populate a new operational store |
| State plus audit metadata | Current state plus source channel, chaincode, transaction ID, timestamp, creator certificate details, validation status, and source location | Audit, compliance, incident investigation, and operational traceability |
| Full public history | Every relevant public write and delete in source order, including enough metadata to distinguish valid and invalid transactions | Historical queries, lineage, forensic analysis, or replay of application-visible history |
| Private-data history | Historical private values while they remain available on an authorized peer, plus hashes and retention evidence | Confidential lineage or regulated records |
| Raw ledger evidence | Source blocks, configuration blocks, hashes, and extraction checksums in immutable storage | Independent archival or a requirement to prove the original ledger structure |

A current-state snapshot is not a historical archive. A transaction metadata record is not the original transaction. A private-data hash proves or supports integrity checking, but it cannot reconstruct a purged plaintext value.

When preserving history, decide how to treat:

- Valid transactions that changed world state.
- Invalid transactions that appear in blocks but did not update world state.
- Deletes and tombstones.
- Configuration blocks and chaincode-definition changes.
- Repeated writes of the same key.
- Private values that were deleted by chaincode versus values that were purged from the private database.

For a database or archive, it is often appropriate to retain both valid and invalid transaction metadata while applying only valid state changes to the operational tables. For a replay into Fabric, only state changes that should exist at the destination should be submitted.

### 1.3 Extraction artifact format

The extraction should produce a portable, self-describing artifact bundle. Exact filenames may vary by migration service, but the bundle should separate the manifest, current state, history, private-data evidence, coverage results, and integrity records. NDJSON is a practical format for large record streams because each line is an independent JSON object that can be streamed, counted, checked, and transferred without loading the entire export into memory.

An illustrative bundle might look like this:

```text
migration-export/
  manifest.json
  channels/
    orders/
      channel-metadata.json
      public-state.ndjson
      public-history.ndjson
      transaction-metadata.ndjson
      private/
        Org1Private/
          state.ndjson
          history.ndjson
          hashes.ndjson
        SharedPrivate/
          state.ndjson
          history.ndjson
          hashes.ndjson
  identities.ndjson
  private-data-coverage.ndjson
  extraction-report.json
  checksums.sha256
```

The names and directory layout are illustrative. The format contract is the information they contain. The manifest should identify the source network, member and peer, Fabric framework version, client SDK and version, extraction timestamp, per-channel cutoff height and block hash, channel and chaincode scope, collection definitions, and artifact format version.

Example `manifest.json`:

```json
{
  "formatVersion": "1.0",
  "source": {
    "networkId": "source-network",
    "memberId": "source-member",
    "peerId": "source-peer",
    "fabricFrameworkVersion": "2.x",
    "region": "source-region"
  },
  "client": {
    "type": "fabric-sdk",
    "name": "approved-client-library",
    "version": "client-version"
  },
  "channels": [
    {
      "name": "orders",
      "cutoff": {
        "blockNumber": 4200,
        "blockHash": "sha256:cutoff-block-hash"
      },
      "chaincodes": ["assetcc"],
      "collections": ["Org1Private", "SharedPrivate"]
    }
  ],
  "extraction": {
    "tier": "state-and-history",
    "startedAt": "2026-01-01T12:00:00Z",
    "completedAt": "2026-01-01T12:30:00Z"
  }
}
```

Each NDJSON stream should use a documented schema and one record per line. For example, a current public-state record might be:

```json
{"recordType":"public_state","channel":"orders","chaincode":"assetcc","key":"asset-123","valueEncoding":"base64","value":"eyJpZCI6ImFzc2V0LTEyMyJ9","lastWrite":{"blockNumber":4200,"txIndex":3,"txId":"source-tx-123"}}
```

A public-history stream can preserve each version, including deletes and source transaction metadata:

```json
{"recordType":"public_history","channel":"orders","chaincode":"assetcc","key":"asset-123","blockNumber":4198,"txIndex":2,"txId":"source-tx-117","timestamp":"2026-01-01T11:58:00Z","creator":{"mspId":"Org1MSP","certificateFingerprint":"sha256:creator-fingerprint"},"validationCode":"VALID","isDelete":false,"valueEncoding":"base64","value":"eyJpZCI6ImFzc2V0LTEyMyJ9"}
{"recordType":"public_history","channel":"orders","chaincode":"assetcc","key":"asset-123","blockNumber":4200,"txIndex":3,"txId":"source-tx-123","timestamp":"2026-01-01T12:00:00Z","creator":{"mspId":"Org1MSP","certificateFingerprint":"sha256:creator-fingerprint"},"validationCode":"VALID","isDelete":true,"value":null}
```

A private-state record should identify the channel, chaincode, collection, key, value encoding, and source location:

```json
{"recordType":"private_state","channel":"orders","chaincode":"assetcc","collection":"Org1Private","key":"asset-123","valueEncoding":"base64","value":"c2Vuc2l0aXZlLXZhbHVl","lastWrite":{"blockNumber":4199,"txIndex":1,"txId":"source-tx-121"}}
```

Private-data hashes and availability should be represented separately from plaintext values. This allows a merged export to show what was available from each member without pretending that a hash-only record contains the value:

```json
{"recordType":"private_hash","channel":"orders","chaincode":"assetcc","collection":"Org2Private","keyHash":"sha256:key-hash","valueHash":"sha256:value-hash","sourceBlock":4180,"availability":"hash_only","reason":"unauthorized_to_extractor"}
{"recordType":"private_coverage","channel":"orders","chaincode":"assetcc","collection":"Org2Private","status":"hash_only","reason":"unauthorized_to_extractor","expectedContributor":"Org2MSP"}
```

The artifact contract should also require:

- A stable schema or format version.
- A source ordering rule for history and metadata records, normally channel, block number, transaction index, and transaction ID.
- Explicit validation status for transactions, rather than treating every transaction in a block as a state change.
- An encoding such as base64 for arbitrary ledger bytes. Values must not be silently converted to text.
- A distinct explanation for every missing private value, including unauthorized access, normal deletion, automatic purge, explicit purge, unavailable peer data, or an unexplained gap.
- Checksums for the manifest and every data file. A simple checksum file may contain entries such as:

```text
<sha256-hex>  manifest.json
<sha256-hex>  channels/orders/public-state.ndjson
<sha256-hex>  channels/orders/public-history.ndjson
<sha256-hex>  channels/orders/private/Org1Private/state.ndjson
```

- No private keys, passwords, or other migration credentials in the artifact bundle.

An artifact bundle is an input to replay and validation. It is not automatically a complete copy of the source ledger. The manifest, coverage report, checksums, and validation results are part of the migration evidence and should be retained with the data they describe.

## 2. Decisions to make before migration

Record these decisions in writing. A migration should not begin with an extraction command; it should begin with an agreed definition of what “migrated” means.

### Decision 1: Where will the data land?

Choose the destination based on the workload that must exist after cutover, not on the fact that the source happened to be a blockchain.

| Destination | Appropriate when | Main work and trade-offs |
|---|---|---|
| Another Fabric network | The business still needs chaincode execution, channel-based governance, endorsement, and private collections | Build the destination network, recreate channels and policies, deploy compatible chaincode, map members and collections, then replay as new transactions. Source block and transaction identity do not continue automatically. |
| Relational database | The primary need is queryability, reporting, joins, integration, or a complete audit archive | Design a schema for state, history, metadata, identities, hashes, and deletes. Reimplement application rules and access control outside Fabric. |
| Key-value or document database | The workload is dominated by key lookups, high-scale application reads, or managed serverless access | Define partitioning, indexes, history access patterns, binary-value encoding, and authorization. Do not assume a key-value schema preserves chaincode semantics. |
| Object storage or immutable archive | The primary requirement is retention, evidence, or later analysis rather than immediate application serving | Preserve source artifacts, manifests, checksums, configuration, and access controls. Add an index or query layer if operators must search the archive. |
| A new application data model | The migration is also a business-process redesign | Treat it as a transformation project. Define source-to-target mappings, invariants, reconciliation rules, and a business owner for every discarded or transformed field. |

The destination may be a combination, such as an operational database plus an immutable source archive. That is often the safest choice when applications need current state but auditors need original evidence.

Do not assume that a second AMB network, a self-managed Fabric network, or a particular database is automatically compatible with a chosen utility. Confirm the destination's Fabric version, client protocol, private-data capabilities, network reachability, limits, and operational model before committing to it.

### Decision 2: How much data must be retained?

Use the smallest scope that satisfies legal, audit, operational, and business requirements, but make the choice explicitly:

- **Current state only:** fastest and least expensive, but it cannot answer how a value got to its current state.
- **Current state plus audit metadata:** preserves source transaction references and creator information as data, but not the source transaction's cryptographic authority at the destination.
- **Full history:** preserves every available version and delete in source order. This usually requires walking the source ledger from its beginning and produces substantially more data.
- **Raw source archive:** required when you must independently inspect the original blocks or demonstrate that the extracted records came from a particular source ledger.

A full-history decision must include private data. Public history may remain on the blockchain while private values have already been removed from an authorized peer. For an explicitly defined collection, `blockToLive` is measured in committed blocks: it can automatically purge a private value after the configured number of blocks. Setting it to zero prevents that automatic collection-level purge, but does not make data immune to explicit deletion, explicit purge, peer loss, or other loss. Do not assume that a migration window suspends the source's purge behavior; confirm the source service's supported controls. Once a value has been purged, its hash does not make the plaintext recoverable.

A normal private-data delete removes the value from current state but may leave historical private data available on the peer until a purge process removes it. An explicit purge is different: it is intended to remove private data more completely. The migration plan must distinguish current-state deletion, historical deletion, automatic retention expiry, and explicit purge.

### Decision 3: Which channels, chaincodes, namespaces, and collections are in scope?

Inventory scope at each level:

1. Fabric network and member.
2. Channel.
3. Chaincode deployment on that channel.
4. Public state namespace.
5. Explicit private collections and implicit organization-specific collections.
6. Keys, values, history, deletes, metadata, and configuration changes.

A channel is a separate ledger. Several channels must not be collapsed into one destination ledger merely because they use similar chaincode or key names. If consolidation is intentional, it is a data transformation with explicit namespace, key-collision, policy, and audit rules, not a routine replay setting.

For every excluded item, record why it is excluded and whether the destination must retain a manifest showing that it was intentionally excluded. Common scope choices include:

- All channels versus selected channels.
- All chaincodes versus selected application namespaces.
- Public state only versus public plus private state.
- Current keys only versus deleted keys and historical versions.
- Explicit collections only versus implicit organization collections.
- Source configuration and transaction metadata versus application data only.

Capture not only chaincode- and collection-level endorsement policies, but also any state-based or key-level endorsement policies that affect individual records. A destination with the right values but weaker or different key-level authorization is not an equivalent migration.

A source discovery pass should capture the current inventory and the ledger height of every in-scope channel. It should also identify configuration changes that matter historically: member changes, policy changes, chaincode upgrades, collection membership changes, collection retention settings, and changes to key-level endorsement policies.

### Decision 4: How will multiple members contribute private data?

On a shared channel, public blocks and public state are generally visible to every participating peer, but a private collection's plaintext is distributed only to authorized organizations' peers. A member that is not authorized may see the collection's hash evidence without seeing its value. A peer that was authorized may still lack older values because of purge, peer availability, gossip/reconciliation history, or retention limits. A hash-only result is therefore an extraction-visibility result, not automatically an accepted loss: another authorized member may still be able to provide the plaintext.

Choose one of these models:

- **Single-member extraction:** sufficient when the selected member can access all data in scope, or when other members' private values are intentionally excluded.
- **Coordinated per-member extraction:** each member extracts the collections it is authorized to provide; the outputs are reconciled into one migration dataset.
- **Member-owned destinations:** each organization sends its private data to a destination it controls, while a shared destination receives only the data that all participants have approved.

The coordinated model requires explicit agreements about:

- Which organization may receive another organization's plaintext.
- How private artifacts are encrypted, transferred, retained, and deleted.
- Which member is responsible for each collection.
- Whether the destination should contain one shared collection or separate destination collections.
- Which source and destination identities may submit or read each collection.

Do not represent hashes-only output as a complete private-data migration. It is a valid result only when the data owner has deliberately chosen an evidence-only outcome or has documented the value as unavailable and accepted the loss. Classify the reason precisely: unauthorized to the extracting identity, never written, normally deleted, automatically purged, explicitly purged, unavailable from the selected peer, or unexplained. These outcomes have different remediation paths.

### Decision 5: What identity and provenance must the destination preserve?

Fabric identities are X.509 certificates interpreted through MSP rules. The source certificate that appears in transaction metadata is not the same thing as a destination credential trusted by a new network. A source private key is not contained in the ledger and must not be copied or shared merely to make a migration convenient.

Choose what the destination needs:

- **Source identity as metadata:** preserve the source certificate fields, MSP ID, certificate fingerprint or serial, creator identity, source transaction ID, timestamp, channel, block, and transaction position in an audit record.
- **Mapped business identity:** map source users or organizations to destination users, roles, or service principals. Document one-to-many and many-to-one mappings and the resulting loss of precision.
- **New transaction signer:** submit replay transactions using destination credentials. This is normal for logical replay, but the destination records the migration identity as the signer unless source attribution is separately stored.
- **Source cryptographic provenance:** a much stronger requirement. It may require a destination that trusts the source MSP, a special ledger-level migration mechanism, or retention of the source ledger rather than ordinary replay. Obtain a specific design and security review before promising it.

If application authorization depends on creator attributes, test the mapped identities and policies at the destination. Do not infer that a value is safe merely because its source certificate is present in an exported metadata file.

## 3. Why Hyperledger Fabric migrations are difficult

### 3.1 One network has multiple visibility boundaries

A migration operator's view is determined by the member, peer, channel, chaincode, collection policy, and identity used for the query. There may be no single peer that can export every plaintext value. A complete multi-party migration is therefore a coordination and data-governance exercise, not only a technical extraction.

### 3.2 The blockchain and world state answer different questions

The world state answers “what is the current value?” The blockchain answers “what transactions led here?” Reconstructing current state from the blockchain requires applying valid write sets in order, handling deletes, and respecting transaction validation flags. Copying a database's current-state rows does not preserve the source transaction log.

### 3.3 Private data is asymmetric and time-sensitive

The channel ledger carries hashes for private data, while authorized peers hold plaintext in private databases. A hash can validate a value if the value is obtained elsewhere; it cannot recover a value that is missing. Collection membership can also change over time, so the current collection policy may not fully describe who held historical values.

`blockToLive` makes the timing operationally important: ongoing blocks can move old values beyond their retention horizon. For at-risk collections, discover and dry-run extraction early, coordinate with data owners, and perform the final extraction during an agreed freeze window.

### 3.4 Governance is part of the application

Channel configuration, MSPs, ACLs, endorsement policies, writer/reader rules, collection distribution policies, collection-level endorsement policies, and chaincode definitions determine what data can be read or written and by whom. These are not interchangeable with application rows. A destination may contain all expected values and still be unusable or unsafe if its governance configuration is wrong.

### 3.5 Logical replay changes provenance

When records are submitted to a destination, the destination ordering service creates new blocks and the destination peers validate new transactions. Source block numbers, transaction IDs, signatures, timestamps, and creator context do not become destination facts simply because the source values are replayed. Preserve those fields as explicit metadata when required, and ensure downstream applications do not confuse source metadata with destination transaction provenance.

### 3.6 Chaincode defines meaning that is not visible in a key-value dump

Chaincode may enforce invariants, calculate derived fields, maintain composite-key indexes, emit events, validate transient data, or coordinate private collections. A raw state write can bypass those behaviors. Composite keys and index records may be useful data, stale implementation artifacts, or both; decide whether to preserve them, rebuild them, or transform them. If a destination remains Fabric, deploy and test compatible chaincode before replay. If it becomes a database, reimplement the required business rules and query behavior in the destination application.

### 3.7 Source and destination versions differ

AMB networks may use different Fabric framework generations, and the destination may use a different Fabric version or a non-Fabric store. Capabilities such as private-data retrieval, chaincode lifecycle behavior, gateway/client protocols, collection features, and message limits vary by version and deployment. Test the exact source and destination combination; do not infer compatibility from product names alone.

### 3.8 Off-ledger dependencies are easy to omit

The ledger may reference documents in object storage, application databases, certificates, external identity systems, event streams, search indexes, or integration queues. Inventory and migrate those dependencies separately. A successful ledger comparison does not prove that an application can retrieve every referenced object or resume every integration.

## 4. Recommended migration procedure

The phases below are gates. A later phase should not silently compensate for a failed earlier phase.

### Phase 0: Establish ownership, scope, and success criteria

**Goal:** obtain a signed migration charter.

Identify the business sponsor, source member owners, data owners for every private collection, destination owner, application owners, security/privacy reviewers, and cutover authority. Define the destination, channels and namespaces in scope, data depth, private-data treatment, identity policy, cutover model, retention period, and rollback plan.

Produce:

- Migration decision record.
- RACI across all participating organizations.
- Initial risk register and dependency list.
- Acceptance criteria and evidence requirements.
- List of excluded channels, chaincodes, collections, and data types.

Do not proceed if a private collection has no accountable data owner or if the destination cannot satisfy the required data-retention and access-control obligations.

### Phase 1: Discover and inventory the source

**Goal:** establish what exists and what can actually be extracted.

For every source member and in-scope channel, inventory:

- Network, member, peer, region, and Fabric framework version.
- Channel membership and channel configuration.
- Ledger height and a proposed cutoff block for each channel, including the block/header hash used to identify the cutoff.
- Chaincode names, versions, definitions, lifecycle model, and source/package availability.
- Public namespaces and private collections, including collection policies, member-only rules, endorsement policies, and `blockToLive`.
- Source state database and any query/index assumptions.
- Historical configuration changes and member/collection changes.
- Off-ledger references and application integrations.
- Source access path, certificates, MSP material, IAM permissions, TLS trust, and host capacity.

For each channel, record its height independently. Channels do not necessarily advance at the same rate, so a single network-wide block number is not a valid cutoff for every channel.

Perform a small, non-destructive dry run before the final window. Confirm that the intended peer can retrieve public blocks, public state, transaction metadata, and authorized private values. Record collections that return values, hashes only, or no evidence, and investigate every unexpected result.

### Phase 2: Prepare the destination in parallel

**Goal:** make the destination ready to receive data without yet declaring it production-ready.

For a Fabric destination:

- Create the destination network, members, peers, channels, and channel configuration.
- Define the destination MSP and certificate authority trust model.
- Translate, rather than blindly copy, membership, ACL, writer/reader, chaincode-level, collection-level, and state-based/key-level endorsement and modification policies.
- Obtain the source chaincode source/package, dependencies, deployment definitions, and any approved reimplementation needed for the destination. If the original execution logic is unavailable, obtain explicit approval for the replacement behavior before treating Fabric-to-Fabric migration as feasible.
- Deploy and test compatible chaincode under the intended destination namespace before replay.
- Recreate explicit private collection definitions. For implicit organization-specific collections, provision the destination organizations and map source ownership to destination organization identities; do not treat implicit collections as ordinary explicit definitions. They do not have the same explicit `blockToLive`, `memberOnlyRead`, or `memberOnlyWrite` settings, and they do not inherit source MSP names automatically.
- Provide a controlled import path that can write the required state without bypassing destination authorization.
- Confirm that applications can read the imported state and that private values remain private.

Any collection mapping must preserve or intentionally narrow the source privacy boundary. Do not place a source collection's plaintext into a destination collection readable by a broader set of organizations without explicit data-owner approval and a documented policy decision.

For a database or archive:

- Define tables, documents, or objects for current state, history, deletes, transaction metadata, identities, private hashes, and raw source artifacts as required.
- Specify binary-value and key encoding; do not assume all ledger bytes are valid text.
- Define indexes and query patterns before loading data.
- Define row-level, collection-level, or object-level authorization for private data.
- Decide how source channel, chaincode namespace, collection, and source identity are represented.
- Test backup, restore, encryption, retention, and audit logging.

Use a staging destination. It should be isolated from production applications and easy to reset, particularly if historical replay produces append-only destination transactions.

### Phase 3: Freeze or define the extraction boundary

**Goal:** establish a reproducible source snapshot.

For a planned cutover:

1. Pause application submits, scheduled jobs, integration consumers, and administrative changes that can append to in-scope channels.
2. Allow in-flight transactions to finish or explicitly identify them as excluded.
3. Confirm that each in-scope channel has stopped advancing.
4. Have every participating member observe and record the agreed cutoff height and block/header hash for each shared channel.
5. Record the time, source peer, source member, and operational approvals.

If a freeze is not possible, define a change boundary and a delta/reconciliation strategy before extraction. Do not describe a moving extraction as a point-in-time snapshot.

For collections with a finite retention horizon, prioritize extraction before the final freeze and keep the final window as short as practical. A dry run does not replace the final extraction at the agreed cutoff.

### Phase 4: Extract source data

**Goal:** produce complete, integrity-checkable migration artifacts.

Use a programmatic Hyperledger Fabric client SDK or client library for this phase. The client connects to the source peers through the approved network path, authenticates with the extracting member's MSP credentials, and calls the Fabric APIs needed to retrieve blocks, configuration, transaction metadata, world state, and authorized private data. Do not copy the peer's underlying ledger or state database as a substitute for a Fabric client extraction.

Extract independently for each source member whose private data is in scope. The extraction should preserve, as applicable:

- Source manifest and tool/version information.
- Channel and chaincode inventory.
- Cutoff height, cutoff block/header hash, and extraction timestamp per channel.
- Validated public blocks or public transaction records.
- Current public state.
- Public write history and deletes.
- Block and transaction metadata, including validation status.
- Private values available to the extracting member.
- Private-data hashes for all records that can be observed on the channel ledger.
- Private history while values remain available.
- Source identity metadata and certificate fingerprints.
- Configuration and collection definitions, including the policy or membership state applicable when each private value was written where available.
- File/object checksums and extraction logs.

Keep the extraction artifacts immutable after they are accepted. If a rerun is required, write to a new output set and retain the relationship between attempts. Mixing outputs from different cutoff heights can create a dataset that is internally well-formed but logically inconsistent.

Protect plaintext private artifacts as sensitive data. Use approved encryption, least-privilege access, secure transfer, retention limits, and a deletion record. Do not place private keys or credentials in the extraction directory.

### Phase 5: Reconcile and merge member extractions when required

**Goal:** create one approved dataset whose public and private portions refer to the same source point in time.

A merge is required when the migration includes private values that no single extracting member can access. It is not required merely because the network has multiple members if the selected scope contains only data available from one member.

Use this sequence:

1. Compare the manifests before combining data. Confirm the same source network, channel, cutoff height and block/header hash, chaincode scope, relevant configuration, and compatible extraction method.
2. Confirm that all members extracted each shared channel at the same agreed height and identified the same cutoff block/header hash. If heights or hashes differ, stop. Re-extract at a common cutoff or implement an explicitly approved delta process.
3. Validate each member's extraction independently before sharing it.
4. Transfer complete, checksummed extraction sets through an approved channel. Avoid assembling an output from unexplained individual files.
5. Combine public state, public history, and block metadata only after confirming that member copies agree. These records should describe the same shared channel ledger.
6. Union private values and hashes by channel, chaincode, collection, key, block, and transaction position. Deduplicate identical contributions.
7. Treat conflicting values for the same source location as a migration blocker. Investigate peer divergence, mismatched cutoffs, corruption, or an incorrect collection interpretation.
8. Produce a coverage matrix showing, for every collection, which member supplied values, which records are hashes only, and why any value is absent.
9. Obtain data-owner approval for every accepted loss. “Unauthorized to this extractor” is not data loss; it means another authorized member must contribute the value or the collection is out of scope. “Purged,” “never written,” and “unexplained” are different outcomes and must not be merged into one status.
10. Validate the merged dataset again. Replay and final verification must use the merged output, not one member's partial directory.

Do not merge outputs pairwise without preserving the complete list of contributing members and source identities. A merged output must remain auditable: an operator should be able to determine which member supplied each private value and which member was expected to supply a missing value.

### Phase 6: Validate the extraction and approve replay

**Goal:** prove that the input is structurally complete enough to load.

At minimum, validate:

- Manifest and configuration files are present and parseable.
- Every record is well-formed and has an unambiguous type.
- No unexpected duplicate state keys exist.
- Public and private records are ordered by source block and transaction position where ordering is required.
- The extracted block range is complete, with documented exceptions for blocks that contain no applicable metadata.
- Valid and invalid transaction status is represented correctly.
- Public history accounts for the state transitions being replayed.
- Private hashes match extracted plaintext values where both exist.
- Every hash-only private record has an explicit reason: unauthorized view, never written, normal delete, automatic purge, explicit purge, unavailable peer data, or an approved evidence-only outcome.
- All in-scope channels, chaincodes, namespaces, and collections are represented.
- The merged coverage matrix has no unexplained gaps or unresolved conflicts.
- Checksums match the transferred artifacts.

A clean structural result is necessary but not sufficient. Review record counts, oldest and newest block positions, collection coverage, deleted-key counts, value sizes, and sample records with a human owner. Record warnings separately from passes; a tool exit code should never be the only acceptance evidence.

### Phase 7: Replay or load into the destination

**Goal:** populate staging without losing the source-to-destination mapping.

Create and approve a mapping for every source object:

| Source object | Destination mapping to define |
|---|---|
| Channel | Destination channel, database partition, schema, or archive prefix |
| Chaincode deployment | Destination chaincode, application, table group, or namespace |
| Public key | Destination key encoding and collision behavior |
| Private collection | Destination collection/table/object prefix and access policy |
| Source identity | Destination identity, role, or metadata record |
| Delete | Destination tombstone/delete semantics |
| Historical version | Destination history table, event, or replay transaction policy |
| Composite/index key | Preserve, rebuild, or intentionally exclude with a documented reason |
| Binary value | Destination byte encoding and decode rules |

For a Fabric destination, replay must also use a programmatic Hyperledger Fabric client SDK or client library. The client submits proposals and transactions through the destination peers and ordering service, waits for commit and validation events, and records the result for each source record. It must not write directly to peer databases or rely on copied ledger files.

The destination chaincode must be available and tested before replay. A data import function or migration contract must enforce the destination's authorization model and must not accidentally expose application write paths. Deploying a migration helper temporarily may be appropriate, but its lifecycle, writer list, audit behavior, and removal/upgrade plan require security review.

For a non-Fabric destination, loading a value is not the same as executing the source chaincode. Decide whether the destination stores raw source values, normalized business objects, or both. Preserve source metadata in separate columns or attributes rather than overwriting it with destination-generated timestamps or identities.

Replay in batches with durable progress records, but understand the destination's retry semantics:

- Replaying current state can often be made idempotent with upserts or deterministic keys.
- Replaying history creates additional append-only records or transactions and may not be safely repeatable after a partial failure.
- If a final delta follows an initial replay, define the delta as records after the initial cutoff and prove that it is disjoint from the already loaded range. Do not replay the full history again unless the destination has been reset and the full-run behavior is intentional.
- A failed historical replay into Fabric may require resetting the staging destination rather than deleting a few records.
- Never silently skip failed records, unmapped channels, unavailable private values, or records that exceed destination limits.

Capture a replay report with source record identifier, destination identifier, status, error, retry count, and the final disposition of every record.

### Phase 8: Verify the destination

**Goal:** demonstrate that the destination is complete, private, usable, and fit for cutover.

Verification should be performed at several levels.

#### 8.1 Structural verification

Compare source artifacts with the destination for each in-scope channel, namespace, collection, and data tier:

- Counts of live keys, deleted keys, history entries, private values, and hashes.
- Minimum and maximum source block/transaction positions represented.
- Per-key current values and delete status.
- Per-key historical sequence and ordering.
- Source transaction metadata and identity records stored as metadata.
- Destination extras: keys or rows that have no source record. Separate expected destination-generated system records, chaincode-maintained indexes, and approved initialization data from unexplained extras.
- Destination omissions: source records that have no destination record.
- Checksums or cryptographic hashes for values where the representation is unchanged.

Do not compare source and destination block numbers as if they should match after logical replay. Compare source location metadata stored alongside the destination record and verify the destination's own transaction/event evidence separately.

#### 8.2 Private-data verification

For every collection:

- Confirm values are present for all records the approved scope says must be present.
- Confirm private values are readable only by intended destination identities.
- Confirm unauthorized identities cannot retrieve plaintext.
- Confirm hashes match the source evidence when the destination preserves hashes.
- Confirm collection membership, collection-level endorsement, member-only read/write behavior, and retention settings.
- Distinguish a missing value from a value that is intentionally not visible to the verifying identity.

A single administrator's successful read is not proof that multi-member private-data boundaries are correct. Test both permitted and denied identities.

#### 8.3 History and provenance verification

If history is in scope, compare the ordered values, writes, and deletes for every key and version that the destination claims to preserve. Sampling is appropriate for an early smoke test, but it is not evidence of complete-history migration; document every unsupported key, collection, version, or private-history limitation. Verify that:

- Source metadata is preserved in the archive or destination data model.
- Destination transaction IDs, timestamps, and creators are correctly labeled as destination facts.
- The application does not use destination transaction metadata as if it were source provenance.
- Invalid source transactions are not incorrectly represented as state-changing operations.
- Private history is called complete only where the values were actually available and retained.

If exact source block-chain preservation is required, verify the raw source archive independently. A passing key/value comparison does not satisfy that requirement.

#### 8.4 Application and semantic verification

Run business-level tests against staging:

- Read and write representative objects through the destination application.
- Exercise chaincode functions or replacement service APIs.
- Test business invariants, authorization, validation, derived fields, and cross-record relationships.
- Test composite-key and index-backed queries.
- Verify referenced external objects and integrations.
- Confirm event consumers, search indexes, reports, and downstream exports.
- Test restart, backup/restore, monitoring, alerting, and disaster recovery.

For a Fabric destination, also test endorsement, ordering, commit events, chaincode upgrades, private-data dissemination, and channel configuration changes. For a database destination, test transaction isolation, constraints, query plans, row-level access controls, and schema evolution.

#### 8.5 Cutover rehearsal

Perform at least one rehearsal using a representative data volume and the same destination configuration intended for production. Measure extraction, transfer, replay, verification, and rollback time. The rehearsal should expose destination limits, large values, private collections, historical hot spots, and application assumptions before the production window.

### Phase 9: Cut over and retain the source

**Goal:** switch users without losing the ability to investigate or recover.

1. Announce and enforce the final source freeze or delta boundary.
2. Capture the final extraction and repeat reconciliation if any member contributed private data.
3. Replay the final set into the destination.
4. Run the agreed structural, privacy, provenance, and application validation.
5. Obtain sign-off from the sponsor, data owners, participating members, security/privacy reviewers, and application owners.
6. Switch application endpoints, credentials, configuration, and integration routes.
7. Monitor the destination and compare expected business metrics with the source baseline.
8. Keep the source read-only for the agreed retention period.
9. Revoke temporary migration credentials and remove temporary import functions or helper configuration when approved.
10. Decommission the source only after the retention, audit, legal, and rollback conditions are satisfied.

## 5. Destination-specific considerations

### 5.1 Fabric-to-Fabric

A Fabric destination is appropriate only when you still need Fabric's transaction, endorsement, channel, and private-data semantics. It requires more than an empty network:

- Destination organizations, MSPs, CAs, peers, orderers, and channels.
- Channel configuration and governance policies translated to the destination members.
- Compatible chaincode source, package, dependencies, and deployment definitions.
- Collection definitions and destination member identities.
- A controlled import mechanism and a plan to remove or retire it.
- A mapping from source channels and chaincode deployments to destination channels and namespaces.

Replay should be treated as a new application of transactions. It can reproduce current values and, when deliberately implemented, application-visible history. It cannot make the destination blocks be the source blocks or make a destination signature become the source signature.

### 5.2 Fabric-to-database

A database destination usually offers easier querying and more complete storage of source metadata, but it does not execute Fabric chaincode or enforce Fabric policies. Design explicitly for:

- Current state and historical state as separate access patterns.
- Source channel and chaincode namespace columns/partitions.
- Collection and sensitivity labels.
- Source transaction and identity metadata.
- Private-data hashes and value encoding.
- Deletes and historical tombstones.
- Composite keys and application indexes.
- Database authorization and audit logging.

If the database becomes the system of record, the application team must own the replacement for chaincode validation, endorsement-dependent workflows, and private collection authorization.

### 5.3 Fabric-to-archive or data lake

An archive is useful when you need to preserve evidence without preserving the Fabric runtime. Store the extraction manifest, raw or normalized blocks where available, configuration records, state, history, private-data hashes, authorized private values, identities, checksums, and a clear catalog of inaccessible or purged data.

Use immutable retention controls and separate access paths for public records, private values, and credentials. An archive should state what it can prove and what it cannot: a hash-only private record is evidence of a source hash, not a copy of the private value.

## 6. Further reading

The following official references describe the Fabric and AMB concepts used in this guide:

- [AMB networks, members, and peer nodes](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/network-components.html)
- [AMB channels](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/hyperledger-work-with-channels.html)
- [AMB private data collections](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/managed-blockchain-hyperledger-create-pdc.html)
- [Hyperledger Fabric ledger](https://hyperledger-fabric.readthedocs.io/en/release-2.5/ledger/ledger.html)
- [Hyperledger Fabric private data](https://hyperledger-fabric.readthedocs.io/en/release-2.5/private-data/private-data.html)
- [Hyperledger Fabric private-data architecture and retention](https://hyperledger-fabric.readthedocs.io/en/release-2.5/private-data-arch.html)
- [Hyperledger Fabric identities and MSPs](https://hyperledger-fabric.readthedocs.io/en/release-2.5/identity/identity.html)
- [Hyperledger Fabric policies](https://hyperledger-fabric.readthedocs.io/en/release-2.5/policies/policies.html)
- [Hyperledger Fabric access control lists](https://hyperledger-fabric.readthedocs.io/en/release-2.5/access_control.html)
- [Hyperledger Fabric chaincode lifecycle](https://hyperledger-fabric.readthedocs.io/en/release-2.5/chaincode_lifecycle.html)
- [Hyperledger Fabric transaction flow](https://hyperledger-fabric.readthedocs.io/en/release-2.5/txflow.html)

Content in this guide is paraphrased from the linked references for compliance with licensing restrictions. Always verify source-version-specific behavior and current service limits before a production migration.
