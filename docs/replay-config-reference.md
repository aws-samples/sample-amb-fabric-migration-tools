# Replay Configuration Reference

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

The replay config (`replay-config.json`) controls how extracted data is written to a destination. It is used by the `replay` and `verify` commands.

**Where does it come from?**

- The `migrate` wizard generates it automatically and saves it to `<output-dir>/replay-config.json`.
- When running commands individually (`discover` → `extract` → `replay` → `verify`), you create it manually. This document is the definitive reference for doing so.

## Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adapter` | `"chaincode"` \| `"postgresql"` \| `"dynamodb"` | Yes | Destination adapter |
| `inputDir` | string | Yes | Path to extraction output directory |
| `channels` | string[] | No | Limit replay to specific channels. Default: all channels in inputDir |
| `batchSize` | number | No | Records per batch. Default: 500 |
| `timeouts` | object | No | gRPC timeouts for chaincode adapter (ignored by postgresql/dynamodb) |
| `timeouts.requestMs` | number | No | Deadline for evaluate/endorse/submit calls (ms). Default: 30000 |
| `timeouts.commitMs` | number | No | Deadline for commit-status checks (ms). Default: 60000 |
| `timeouts.connectMs` | number | No | gRPC wait-for-ready / connect timeout (ms). Default: 15000 |

Only one adapter section (`chaincode`, `postgresql`, or `dynamodb`) is used — it must match the `adapter` field.

`adapter` is required because `verify` has no `--adapter` flag: the field is the
only way to tell it which destination to read. `replay` does have the flag, and
takes it in preference — it overwrites the field on load — so the two commands
disagree silently if the config and the flag name different adapters. Set the
field to the adapter you will pass on the command line.

---

## Chaincode adapter

For Fabric-to-Fabric migration. Submits transactions to the destination network.

### Connection profile

The `connectionProfilePath` must point to a standard Fabric connection profile JSON. This is the same format used by the Fabric SDKs.

The connection profile's `tlsCACerts` can specify the CA certificate as either:

- `"path"` — a file path to the PEM certificate
- `"pem"` — the certificate inline as a PEM string

Both forms are supported. The Fabric test-network generates profiles with inline `pem`; AMB and most production deployments use `path`.

### Identity

The submitting identity is a standard Fabric X.509 identity:

- `certPath` — path to the PEM-encoded signing certificate
- `keyPath` — path to the PEM-encoded private key file (not a directory — if your MSP keystore contains a single `*_sk` file, provide the full path to that file)
- `mspId` — the MSP ID of the submitting organization

This identity writes every record that no `collectionIdentities` entry claims.

### Per-collection identities (`collectionIdentities`)

A private data collection admits writes from the orgs its policy names. One admin identity replaying five members' collections has four fifths of that data denied at endorsement, so each collection that another org owns needs an identity of that org:

```json
"collectionIdentities": {
  "_implicit_org_Org2MSP": {
    "mspId": "Org2MSP",
    "certPath": "./wallet/org2-admin.pem",
    "keyPath": "./wallet/org2-admin-key.pem",
    "connectionProfilePath": "./org2-connection-profile.json"
  }
}
```

Keyed by **destination collection name**. Every entry needs `mspId`, `certPath` and `keyPath`; an incomplete entry is refused rather than falling back to the top-level identity, which would write the collection as the wrong org.

`connectionProfilePath` is optional but usually necessary. The peer matters as much as the identity: a peer whose org is not a collection member cannot store the private data it endorses, so an Org2 identity submitting through an Org1 peer can have its transaction succeed and its private data go nowhere. Point each entry at a peer of its own org. Entries that share all four fields share one connection, so five collections owned by one org cost one gateway, not five.

An entry naming a collection this run has no data for is warned about — almost always a typo, whose effect is that the collection it was meant to cover is written by the default identity after all.

#### One collection name, different owners per channel (`channelCollectionIdentities`)

`collectionIdentities` is keyed by collection name alone. That fits implicit collections and a chaincode committed with one collection config everywhere, but a chaincode deployed on several channels usually renders its collection policies per channel: a shared collection can belong to Org1/Org2 on one channel and to Org4/Org5 on another. A name-keyed entry can route only one of those, so give the others a per-channel entry:

```json
"collectionIdentities": { "sharedPair": "Org2MSP" },
"channelCollectionIdentities": {
  "channel-b": { "sharedPair": "Org4MSP", "orgPrivate": "Org4MSP" }
}
```

Keyed by **destination channel**, then destination collection, because the policy that decides a write is the destination channel's. On that channel an entry wins over `collectionIdentities` and over the identity `orgIdentities` derives for an implicit collection; every other channel is unaffected. Values take the same two forms — an MSP ID reference or a full identity — and are refused on the same grounds. The pre-flight checks each `(destination channel, collection)` against the identity resolved for that channel, and an entry this run writes nothing to is warned about, most often because a source channel name was used where the destination one belongs.

### Collection routing (`collectionMapping`)

A collection name belongs to the destination's chaincode definition, not to the data, so the name the source used need not exist there. `collectionMapping` gives each source collection the destination collection its private data is written into:

```json
"collectionMapping": {
  "_implicit_org_Org2MSP": "_implicit_org_DestOrg2MSP",
  "sharedAppraisals": "sharedAppraisals"
}
```

Keyed by **source collection name** — the `collection` field of the records in the channel's `private-*.ndjson` files. A collection with no entry is written under its own name. `replay` writes through this map and `verify` reads back through it, so both reach the same collection.

**Mandatory for every `_implicit_org_<MSPID>` collection carrying data.** Fabric names the per-organization collection every 2.x chaincode gets after the MSP that owns it, and a destination network's MSP IDs are not the source's. Submitted verbatim, every private write of such a collection fails at the destination on the name alone, so `replay` refuses before its first write:

```
1 implicit collection(s) have no chaincode.collectionMapping entry:
_implicit_org_Org2MSP. An implicit collection is named after the MSP ID that owns
it, and the destination network's MSP IDs are not the source's, so submitting the
source name writes into a collection that does not exist there. Map each one to the
destination collection its data belongs in — e.g.
{ "_implicit_org_Org2MSP": "_implicit_org_<destination MSP ID>" }, or map the owning
member once in chaincode.mspMapping — e.g. { "Org2MSP": "<destination MSP ID>" } —
which covers its implicit collection on every chaincode. Map it to itself if the
destination really does use the same MSP ID.
```

Map it to itself where the destination does reuse the source MSP IDs. The entry is still required: written out, it is a decision rather than an unnoticed coincidence.

A collection a chaincode declares needs no entry — it is named the same on every network that commits that chaincode.

Two source collections cannot share one destination collection. A collection is one keyspace within its chaincode namespace, so the two collections' copies of a shared key overwrite each other there and the survivor is whichever file replayed last. That is refused before the first write, and it is refused on the *resolved* destinations: `{"colA": "colB"}` is the same merge when `colB` carries data too.

Like `channelMapping`, the map is scoped to what the run replays. A collision between collections this run leaves out is not refused, and neither is a missing entry for an implicit collection whose file holds no records.

Two names, two purposes: `collectionMapping` is keyed by the source name, `collectionIdentities` by the destination name. The identity that writes a collection is chosen by the policy that admits it, and that is the destination collection's.

### Per-member shorthand (`mspMapping`, `orgIdentities`)

On Fabric 2.x every member of a channel owns one `_implicit_org_<MSPID>` collection, so an N-member migration needs N `collectionMapping` entries and N `collectionIdentities` entries, each restating one fact about one org — which destination MSP it becomes, and what that MSP signs with — and every collection the chaincode declares that another org owns repeats that org's credentials once more. Two org-level maps state each fact once:

```json
"mspMapping": {
  "m-ABC123": "Org1MSP",
  "m-DEF456": "Org2MSP"
},
"orgIdentities": {
  "Org2MSP": {
    "certPath": "./wallet/org2-admin.pem",
    "keyPath": "./wallet/org2-admin-key.pem",
    "connectionProfilePath": "./org2-connection-profile.json"
  }
},
"collectionIdentities": {
  "sharedAppraisals": "Org2MSP"
}
```

- **`mspMapping`** — source MSP ID → destination MSP ID, one entry per migrating member. Each entry routes `_implicit_org_<source>` to `_implicit_org_<destination>` on every chaincode and channel, which satisfies the mandatory-entry refusal above. Two members mapped to one destination MSP are still refused as a merge, and a member missing from the map leaves its implicit collection unmapped and refused, so a typo is not silent.
- **`orgIdentities`** — destination MSP ID → `certPath`, `keyPath` and optional `connectionProfilePath`. Each org's `_implicit_org_<MSPID>` is written as that org with no `collectionIdentities` entry. Both `certPath` and `keyPath` are required.
- **MSP ID references** — a `collectionIdentities` value may be an MSP ID instead of a full identity: an `orgIdentities` key, or the top-level `mspId`. A reference to any other MSP is refused before anything connects.

Explicit `collectionMapping` and `collectionIdentities` entries always win over derived ones. `replay` and `verify` expand both shorthands before reading either map, so everything downstream — the routing refusals, the pre-flights, the history-import plan digest — sees the same effective maps a hand-written config would produce. The unused-identity warning only covers entries you wrote yourself, because a derived entry cannot be a typo.

`generate-replay-config` writes this form: it asks for a destination MSP per member and credentials for each destination org other than the top-level one, and you can leave an org's certificate blank to add later. Replay refuses until that org has an identity, or until `ownerEndorsement` is on.

### Writing other orgs' implicit collections without their keys (`ownerEndorsement`)

A write to `_implicit_org_<MSPID>` has to be **endorsed by a peer of `<MSPID>`** — that is the collection's implicit endorsement policy — and nothing checks the **submitter**, because implicit collections leave `memberOnlyWrite` off. So one identity can write every org's implicit collection, provided each write is endorsed by the owner's peer. With

```json
"ownerEndorsement": true
```

replay submits a write to another org's implicit collection as the top-level identity and names the owning org in the gateway's `endorsingOrganizations`, for single writes, batches, deletes and the resilient history protocol alike. The owner's peer endorses it and stores the value; the submitter's own peer never sees it. `orgIdentities` can then be left out entirely, and the operating member needs no other org's signing key.

Measured on a three-org test network: Org1MSP alone replayed all 161,923 records with 0 failures in 2:07, against 2:03 with every org's identity. Writes to `_implicit_org_Org2MSP` were VALID whenever an Org2MSP peer endorsed them and `ENDORSEMENT_POLICY_FAILURE` when only Org1MSP's peer did — which is why the endorser is named rather than left to the gateway.

What it needs and does not change:

- **Each owner's peer reachable by service discovery** from the top-level gateway — the owner's anchor peer in the channel config, and a network path to it. Checked before the first write by the [endorsement pre-flight](#destination-endorsement-pre-flight).
- **An identity configured for the owner still wins.** `orgIdentities` and `collectionIdentities` entries are used exactly as before.
- **Explicit collections are unaffected.** One with `memberOnlyWrite` checks the submitter, which no choice of endorser changes; the pre-flight still refuses it.
- **`verify` by the operating member** reads other orgs' implicit values only by hash — a match by hash is reported as a match, with that in its detail. To compare them by value, each org runs `verify` as itself, with `--channels` naming its own channels.

It is off by default because it moves a decision rather than removing one. The owning org signs nothing; its consent is the destination channel's policy and whatever agreement made this member the migration's operator, and the owner's peer endorses whatever the operator sends. Agree that before turning it on.

### Binding a config to one destination (`destinationFingerprint`)

A connection profile names a host, not a ledger. A config dry-run against a test
destination writes to production as soon as its profile is repointed, and a
destination rebuilt at the same address looks the same as the one it replaced.
`destinationFingerprint` binds the config to the ledgers themselves: each
destination channel's genesis block, which is created once and never changes.

```bash
amb-migrate fingerprint-destination --config replay-config.json
# {"destinationFingerprint": {"channel-a": "9f2c…", "channel-b": "41aa…"}}
```

Paste the map into the `chaincode` block. `replay` and `verify` then read every
destination channel's genesis block (`qscc GetBlockByNumber 0`) before anything
else and refuse — reading and writing nothing — if a channel is missing from the
map, will not answer, or has a different genesis block. The command is read-only.
Without the field nothing is checked and `replay` and `verify` log a warning; set it for any
run against a destination that matters.

The fingerprint guards against misconfiguration, not impersonation: the genesis
block is read from the peer being checked. TLS, against the CA the connection
profile names, is what authenticates the destination. A `grpcs://` endpoint
without `tlsCACerts` is refused rather than checked against system roots.

### Destination chaincode pre-flight

Every chaincode replay checks, before its first write, that each destination chaincode it is about to write into can take those writes. Two things have to hold:

- **The chaincode is committed on that destination channel, under the name the source used.** A chaincode name is its state namespace on both networks and nothing here renames one, so a destination that spells it differently is a different namespace. There is no chaincode-name map to bridge them: commit the chaincode under its source name, or route the source channel elsewhere with `channelMapping`.
- **Its migration contract answers.** One `ListKeys(1, "")` evaluate on the same gateway, identity and chaincode the first record would reach. `ListKeys` is the one migration-contract read that answers against any destination — `ReadState` needs a key that already exists and everything else is a submit — so an empty destination ledger answers it. The reply is checked, not just awaited: a contract that answered something other than a page of keys is not the migration contract, and the writes go to the same name.

Which chaincodes are in scope comes from the records on disk, not the manifest: the channel's public file is read to its end, plus every chaincode with private data in scope. A chaincode the manifest names but holds no records for needs no destination deployment.

```
2 destination chaincode(s) cannot take the writes this run would send them, so this
run is refusing to start:
  orders-ch/marketplace: no chaincode named marketplace is committed on dest-orders (it has 2: trade, registry)
  orders-ch/trade: trade is committed on dest-orders, but MigrationContract did not answer ListKeys there: chaincode response 500, Contract not found with name MigrationContract
For a chaincode the destination channel does not have, commit it there under the same
name the source used — a chaincode name is its state namespace and nothing here renames
one — or map the source channel elsewhere in chaincode.channelMapping.
For a chaincode whose migration contract did not answer, register the contract beside
the destination chaincode's own and re-commit it
(sample/chaincode/migration_contract/README.md), and check chaincode.migrationContract
if the destination registers it under another name. Where the destination's own contract
owns the writes instead, name its functions in chaincode.keyMapping and
chaincode.deleteMapping — which is possible only for a chaincode with no private data,
since a private write has no configurable function.
```

Every deployment is checked before anything is reported, so an eight-channel run gets the whole list rather than its first entry. A chaincode reached from two source channels mapped onto one destination is probed once and reported per source channel, since the source channel is what an operator acts on.

What it does **not** refuse on:

- **A deployment whose every write is mapped to an application contract.** `keyMapping` naming another contract — and `deleteMapping` too, once `replayHistory` is on — says the migration contract is not called for that chaincode, so it need not be registered there and nothing here knows a function to call on the contract that replaces it. Logged as unchecked. A deployment carrying private data is probed regardless: `ImportPrivateData` is not configurable.
- **A destination channel that will not answer a lifecycle query.** Which chaincodes are committed is then unestablished, which is logged; the contract probe still runs, and a contract that answers is the stronger evidence of the two.
- **The contract's writer list.** An evaluate is not gated by `writerMSPIDs`, which gates submits only, so a contract that answers here can still refuse the first write. That failure names the MSP, and every MSP the run submits as has to be in the list — see [Who may write](../sample/chaincode/migration_contract/README.md#who-may-write).
- **Which of the contract's functions exist.** `ListKeys` answering establishes that the migration contract is registered there, not that it is complete. Every write function is a submit and a probe cannot call one, so a contract missing `PutStateBatch`, `ImportPrivateData` or — with `replayHistory` on — `DeleteState` or `DeletePrivateData` passes here and fails at the first record that needs it.

### Destination collection pre-flight

Once every destination chaincode has answered, a chaincode replay carrying private data checks every `(chaincode, collection)` it is about to write against the destination's committed chaincode definitions, and refuses the whole run if any of them would reject their writes. Every check is against the **destination** collection name, since that is the name the peer sees:

```
3 destination collection(s) would reject every write from the identity configured
for them, so this run is refusing to start:
  ch1/trade/_implicit_org_Org2MSP: would be written as Org1MSP, but an implicit collection admits only Org2MSP
  ch1/trade/sharedAppraisals: would be written as Org1MSP, which the collection policy OR('Org2MSP.member') does not admit, and memberOnlyWrite is on
  ch1/trade/tempNotes → archivedNotes: trade on destch declares no collection archivedNotes (it declares 2: sharedAppraisals, publicNotes)
For a collection another org owns, add a chaincode.collectionIdentities entry naming
that org's MSP ID, certificate and key — and its connection profile, since a peer
that is not a collection member cannot store the private data it endorses.
For an implicit collection, chaincode.ownerEndorsement: true writes it as this
identity with the owning org's peers endorsing instead, which needs no credentials
of that org.
For a collection the destination does not declare, either commit the destination
chaincode with a collection config that includes it, or add a
chaincode.collectionMapping entry routing it to a collection the destination
already declares.
```

Every collection is checked before anything is reported, so a five-member migration gets the whole list rather than its first entry. A mapped collection is named `source → destination`, because neither name alone is enough: the source name finds the file and the config entry, the destination name is what the chaincode definition is searched for.

What it does **not** refuse on:

- **A destination that will not answer a lifecycle query.** Membership is then unestablished, which is logged, not fatal — the writes themselves establish it, and a failure now names the collection and the MSP that submitted it.
- **`memberOnlyWrite: false` with a non-member identity.** The peer does not check the submitter's org, so the write succeeds; it is logged because the values still have to reach an org that can store them.
- **A collection whose private file holds no records.** Nothing will be written, so there is nothing to be denied.
- **A collection `metadata.json` cannot attribute to a chaincode.** Logged as unchecked. Re-run `discover` if you expected it to be checked.
- **A destination collection with `blockToLive > 0`.** Warned about, once per collection, because the destination will purge what replay writes — see below.

#### Destination endorsement pre-flight

The checks above read policies. Last, before its first write, replay asks the destination itself: one `ImportPrivateData` per destination collection is **endorsed and never submitted**, over exactly the identity, peer and `ownerEndorsement` routing that collection's writes will use. Nothing is ordered or committed; the endorsing peers keep the probe value (key `fabric-amb-extractor-preflight`) in their transient stores until those purge it. (This identifier and the `fabric-amb-extractor-history-*` identifiers below keep an earlier project name for compatibility.) Any refusal stops the run with the whole list:

```
9 destination collection(s) refused a probe endorsement — nothing was submitted,
and the run is refusing to start:
  channel-a/app_ledger/orgPrivate on channel-a: 9 FAILED_PRECONDITION: requires
  endorsement from organisation(s) that are not in the distribution policy of the
  private data collection(s): [orgPrivate]; ...
A collection whose members cannot satisfy the chaincode's endorsement policy on their
own cannot be written through the Fabric Gateway: ... Give each such collection its own
endorsementPolicy in the destination collection config, naming its members ...
```

That one was measured on a five-org test network with an `AND` chaincode policy and no collection-level policies: before the probe, the first `orgPrivate` write failed 142 s into a Tier 3 history replay, after 148,502 records had been written, so the destination needed a reset. With the probe the same run is refused in 3 s with nothing written. It also catches endorsing peers that refuse the write — the migration contract's writer list, a submitter the collection does not admit — and owners' peers that `ownerEndorsement` cannot reach, quoting each peer's reason.

Public writes are not probed: their endorsement plan comes from the chaincode policy alone, which the Gateway satisfies from any channel member's peers.

#### Destination `blockToLive` during migration

A destination collection purges its private data `blockToLive` blocks after the block that wrote it, exactly as the source did. Replay writes every record as a new destination transaction and keeps committing blocks after it, so a value written early in the run can be past the destination's own horizon before the run ends. `verify` then reads nothing and reports the key `[MISSING]`, which looks like migration loss and is the destination doing what its definition says.

This happened in a three-member test: a `blockToLive: 40` collection was replayed early in each channel's private pass, hundreds of import blocks followed, and all 600 of its values were gone at the destination before `verify` ran — the only missing keys in a 161,923-record run.

Replay therefore logs a warning per destination collection with `blockToLive > 0`, naming the chaincode, collection, channel and window. It does not refuse: a run whose writes all land inside the window loses nothing, and a short window may be the intended production behaviour.

A collection's `blockToLive` cannot be changed once its definition is committed: Fabric's lifecycle refuses any later definition that changes it (`validateCollConfigsAgainstCommittedDef` in Fabric 2.5). So it cannot be lowered for the migration and raised again at cutover. Choose the destination value before the first commit:

- **The production value.** Values purge at the destination on the same rule as at the source, counted from their import. To have `verify` see them, keep the blocks committed between a value's import and its check below the window: replay purging collections at the end of the run, and run `verify` straight after. A key the destination purged before `verify` read it is reported `[MISSING]`; tell the data owners which collections that applies to before the run.
- **`blockToLive: 0`.** Nothing purges, so every value is checked. This is a lasting change to the collection's retention, not a migration setting, and the data owners have to approve it as such.

What the source had already purged is gone either way and is accounted for in the extraction's coverage report (`reason: purge-window`) and recorded for the data owner to accept in writing.

Implicit collections (`_implicit_org_<MSPID>`) are decided from the name alone — a write is valid only if their owner's peers endorse it — so a write as another org is refused without querying the destination at all, unless [`ownerEndorsement`](#writing-other-orgs-implicit-collections-without-their-keys-ownerendorsement) routes its endorsement to the owner. The name that decides it is the destination's: an implicit source collection mapped onto a collection the destination chaincode declares is bound by that collection's policy instead.

A public-only replay has no collections to check and skips this half. It still queries the destination, for the chaincode pre-flight above — both halves read the same committed definitions, once per destination channel.

### Channel routing

Provide **exactly one** of:

- `channelMapping` — a destination channel per source channel. Source channels not in the map are skipped by `replay`, with a warning and an entry in the summary's `skippedChannels`; `verify` refuses them instead, because a channel it silently left out reads as verified.
- `channel` — one destination channel, allowed only when the run covers a **single** source channel.

Setting both is refused: they answer the same question twice, and `channelMapping` used to win silently, so a mistyped map key skipped a channel while `channel` sat in the config looking like the fallback it never was.

Two source channels cannot share one destination channel, whether by `channel` or by a `channelMapping` that names the same destination twice. A destination channel is one ledger: the two channels' copies of a shared key overwrite each other there, the survivor is whichever file was replayed last, and nothing fails. An eight-channel migration configured that way produces one channel and a clean report. Both forms are refused before the destination is connected to.

Narrowing the run with `--channels` narrows what "in scope" means, so `channel` is usable one channel at a time:

```bash
amb-migrate replay --config replay-config.json --channels orders-ch
```

A `channelMapping` written for the whole migration stays valid for those narrowed reruns — a duplicate destination among channels the run leaves out is not refused, since those entries route nothing.

### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `connectionProfilePath` | string | Yes | — | Path to Fabric connection profile JSON |
| `mspId` | string | Yes | — | MSP ID for the submitting identity |
| `certPath` | string | Yes | — | Path to PEM-encoded X.509 certificate |
| `keyPath` | string | Yes | — | Path to PEM-encoded private key file |
| `collectionIdentities` | Record\<string, {mspId, certPath, keyPath, connectionProfilePath?} \| string\> | No | `{}` | Destination collection → the identity that writes it, or the MSP ID of an `orgIdentities` entry (or the top-level `mspId`). A full entry needs all three paths/IDs; `connectionProfilePath` defaults to the top-level one |
| `channelCollectionIdentities` | Record\<string, Record\<string, identity \| string\>\> | No | `{}` | Destination channel → destination collection → identity, overriding `collectionIdentities` and `orgIdentities` on that channel. See [One collection name, different owners per channel](#one-collection-name-different-owners-per-channel-channelcollectionidentities) |
| `collectionMapping` | Record\<string, string\> | Required for `_implicit_org_*` | — | Source → destination collection map. Mandatory for every `_implicit_org_<MSPID>` collection carrying data, since its name embeds the source MSP ID. Refused when two source collections in scope share a destination. `verify` reads back through it |
| `mspMapping` | Record\<string, string\> | No | — | Source MSP ID → destination MSP ID. Derives the `collectionMapping` entry for each member's `_implicit_org_<MSPID>`; explicit entries win. See [Per-member shorthand](#per-member-shorthand-mspmapping-orgidentities) |
| `orgIdentities` | Record\<string, {certPath, keyPath, connectionProfilePath?}\> | No | — | Destination MSP ID → that org's credentials. Writes each org's `_implicit_org_<MSPID>` as that org, and lets `collectionIdentities` refer to it by MSP ID |
| `ownerEndorsement` | boolean | No | `false` | Write other orgs' implicit collections as the top-level identity, endorsed by the owner's peers. See [Writing other orgs' implicit collections without their keys](#writing-other-orgs-implicit-collections-without-their-keys-ownerendorsement) |
| `destinationFingerprint` | Record\<string, string\> | No | — | Destination channel → SHA-256 of its genesis block, from `fingerprint-destination`. `replay` and `verify` refuse a destination that does not match. See [Binding a config to one destination](#binding-a-config-to-one-destination-destinationfingerprint) |
| `channel` | string | Exactly one of channel/channelMapping | — | Destination channel name. Refused when the run covers more than one source channel |
| `channelMapping` | Record\<string, string\> | Exactly one of channel/channelMapping | — | Source → destination channel map. Refused when two source channels in scope share a destination |
| `keyMapping` | Record\<string, Record\<string, string\>\> | No | `{}` | Source channel → chaincode → target function name, in `Function` or `Contract:Function` form. Default function: `PutState` on `migrationContract` |
| `deleteMapping` | Record\<string, Record\<string, string\>\> | No | `{}` | Source channel → chaincode → target function for a public delete, same syntax and keying. Default function: `DeleteState` on `migrationContract`. Read only when `replayHistory` is true |
| `migrationContract` | string | No | `"MigrationContract"` | Contract name registered in `NewChaincode()`. Used to namespace replay function calls |
| `concurrency` | number | No | 1 | Max concurrent transaction submissions (1–100) |
| `writeBatchSize` | number | No | 500 | Max writes carried in one `PutStateBatch` or `ImportPrivateDataBatch` transaction. `1` submits every write on its own. A ceiling on keys, not a promise: a batch is also split at 2 MiB of framed bytes, and is never wider than the distinct keys among `batchSize` records |
| `channelConcurrency` | number | No | 1 | Source channels replayed at once, each with its own checkpoint. See [Parallel channels](#parallel-channels-channelconcurrency) |
| `replayHistory` | boolean | No | false | Replay Tier 3 history records in block order |
| `historyImport` | `{mode, scope, keyPath}` | No | — | Opt in to resilient, idempotent Tier 3 history replay. Valid only with `replayHistory: true`. See [Resilient idempotent history replay](#resilient-idempotent-history-replay-historyimport) |
| `embedSourceMetadata` | boolean | No | false | Merge source block metadata into replayed history values (only applies when `replayHistory` is true). JSON object values get a nested `migrationMeta` field; every other value is submitted byte-for-byte |
| `allowInsecure` | boolean | No | false | Allow plaintext gRPC (`grpc://`) connections |

### Write function mapping (`keyMapping`)

Which function a public write is submitted as, keyed by the **source** channel and then the chaincode on it:

```json
"keyMapping": {
  "orders-ch": { "marketplace": "ImportOrder", "ledger": "PutState" },
  "trades-ch": { "marketplace": "SampleAssets:ImportTrade" }
}
```

Keyed by both because a chaincode name is only unique within a channel: `marketplace` on `orders-ch` and `marketplace` on `trades-ch` are two deployments of two different chaincodes, and each takes its own function. The outer key is the source channel — the same name on `channelMapping`'s left-hand side — because that is the name the extracted records carry.

A value may name its contract. `"ImportOrder"` is submitted on `migrationContract`; `"SampleAssets:ImportTrade"` is submitted as `ImportTrade` on the `SampleAssets` contract of the same chaincode, which is how a write reaches an application's own function. The split is on the first colon, so a function name may contain further colons.

A function on another contract still gets the migration contract's wire shape: one argument, the key, and the value in the transient map under `public_value`. Mapping to an application function that expects `(key, value)` positionally gives it no value at all — see [the wire contract](../sample/chaincode/migration_contract/README.md).

A deployment with no entry is written with `PutState` on `migrationContract`. That default is why a mistake here does not stop the run: a misspelled channel key matches no record, and every deployment under it silently falls back to `PutState`. Replay therefore warns and names any source channel `keyMapping` maps that the run does not replay — either misspelled, or left out of `channelMapping` and so skipped.

Private writes are not configurable: `ImportPrivateData` carries its value as transient data, so it must be the migration contract's, and `DeletePrivateData` stays beside it rather than splitting a pair that has to move together.

### Delete function mapping (`deleteMapping`)

Which function a public delete is submitted as, keyed and parsed exactly like `keyMapping`:

```json
"deleteMapping": {
  "orders-ch": { "marketplace": "SampleAssets:RemoveAsset", "ledger": "DeleteState" }
}
```

Its own map rather than `keyMapping`'s, because a delete is not a write with an empty value. The function takes the key as its only argument and carries no transient data, so the write function submitted for a tombstone writes where the source deleted — leaving a live key at the destination the source ledger does not have.

Only read when `replayHistory` is true. A tombstone reaches the destination only through a `public_history` record; a current-state replay carries no deletes at all.

**Set this whenever `keyMapping` names a contract other than `migrationContract`.** A write mapped to the application's own function is usually there because that function maintains something besides the key — a composite-key index, a counter, an event. With no `deleteMapping` entry the matching tombstone goes to `migrationContract`'s `DeleteState`, which removes the key and leaves the rest of that bookkeeping referring to it. Replay warns and names each `channel/chaincode` in that position; it does not refuse, because `DeleteState` does delete the key and whether anything else depended on it is a property of the destination chaincode the tool cannot see. Naming `DeleteState` explicitly silences the warning — that entry says the key is all there is to remove.

`generate-replay-config` asks for a delete function only for deployments whose write function names another contract, and writes no `deleteMapping` at all when every write is on the migration contract.

### Batched public writes (`writeBatchSize`)

Public writes on the migration contract are submitted many keys at a time, as `PutStateBatch` — 500 keys per transaction by default. A transaction costs an endorsement round trip plus an ordering and commit wait whatever it carries, and that cost, not the bytes, is what makes an eight-channel Tier 3 replay take weeks one write at a time.

Three things bound a batch below `writeBatchSize`, and none of them is an error:

- **One version per key.** A transaction's write set holds one value per key, so two versions of one key never share a batch. Replay batches across keys, one version each, and comes back for the next version in the next transaction — so a single hot key's history is submitted one write at a time whatever this is set to, and a batch is only ever as wide as the number of distinct keys in flight.
- **2 MiB of framed bytes.** Fabric's default `AbsoluteMaxBytes` is 10 MiB and an oversized transaction is rejected whole, so a round of large values is split into several transactions below the key ceiling. A single value larger than the cap is submitted on its own through `PutState`, which is bounded only by what the orderer accepts.
- **`keyMapping` and `deleteMapping`.** An entry naming a function other than the migration contract's own `PutState` and `DeleteState` opts its `(channel, chaincode)` out entirely: the function it names is the application's own, and nothing can assume it reads this framing. Those deployments are replayed one write per transaction. Naming `PutState` or `DeleteState` explicitly — which is what `generate-replay-config` writes — is the same configuration as naming nothing, and batches.

Private data is batched one destination collection at a time, through `ImportPrivateDataBatch(collection)` with the same framing and the same three bounds. Transient data reaches every endorsing peer, so one transaction carrying two collections' values would hand each endorser the values of a collection it may not be a member of; confined to one collection, a batch is endorsed by and disclosed to exactly the peers a single `ImportPrivateData` would be, and is signed by that collection's identity. Under `historyImport` private history is not batched, because its receipts are per mutation. **The destination contract must define `ImportPrivateDataBatch`**: a contract packaged before it was added fails the first private batch, and `writeBatchSize: 1` is the stopgap.

**`batchSize` bounds the width.** Replay reads `batchSize` records (default 500) at a time and batches the distinct keys among them, so with the default a batch never carries more than 500 keys however large `writeBatchSize` is, and a key-dense file batches far below it. Raising `batchSize` to tens of thousands doubled public throughput in a test run, at the cost of holding that many records in memory.

**A rejected batch fails every key it carried.** The failure report has one entry per key, each naming the batch and how much it held, so nothing looks replayed that was not — but a single bad value costs the whole transaction, and with `replayHistory` it aborts the file. `writeBatchSize` is therefore a throughput/blast-radius trade: `1` restores per-key isolation, at one transaction per write. A value that cannot be read at all is the exception — it fails its own key and the rest of the round goes on.

`concurrency` multiplies this rather than competing with it: it is transactions in flight, so the two together are up to `concurrency × writeBatchSize` keys being written at once.

**What no setting removes is the deepest key.** Each version of one key is its own transaction, committed before the next is sent, so a history replay takes at least the most-written key's version count times the destination's commit latency. `status` reports that key per history file; read it before promising a window.

### Parallel channels (`channelConcurrency`)

`chaincode.channelConcurrency` (default 1) replays that many source channels at once. Channels are separate destination ledgers: nothing orders a write on one against a write on another, so running them together changes no result, only the wall clock. Up to `channelConcurrency × concurrency` transactions are in flight across the run.

Above 1, each channel keeps its own checkpoint, `replay-checkpoint-chaincode-<channel>.json`, and its own failure state. A Tier 3 history failure on one channel marks that channel's checkpoint dirty and stops that channel's remaining history files; the other channels finish, and their checkpoints are cleared as each completes. Re-running then refuses on the dirty channel alone, naming it — reset that destination channel, delete its checkpoint, and re-run with `channelMapping` (or the config's `channels`) narrowed to that channel. The finished channels' checkpoints were cleared, so a re-run that still includes them replays them again — which for a history replay appends every version a second time.

The two modes keep progress in different files, so each refuses to start over the other's: resuming from the wrong file would start again from the first record. Finish an interrupted run with the `channelConcurrency` it started with.

### History and provenance fidelity

Replay reproduces keys and values. It cannot reproduce the transactions that
wrote them: every replayed write is a **new** transaction, submitted by an
identity this config names and ordered into the destination's own blocks. So the
destination's `GetHistoryForKey` reports the *migration's* `txId`, timestamp and
creator MSP on every entry it has, and a destination chaincode's own `GetTxID`,
`GetTxTimestamp` and `GetCreator` see the replay rather than the transaction
being replayed.

How much history the destination has at all is decided by `replayHistory`, which
selects the files replay reads — history or current state, never both:

| Config | The destination's `GetHistoryForKey` for a key with 40 source versions |
|---|---|
| `replayHistory: false` (the default) | **One** entry: replay's single write of the current value. The 39 earlier versions are not at the destination in any form |
| `replayHistory: true` | 40 entries — the source's values in source order, each carrying the migration's `txId`, timestamp and creator |
| `replayHistory: true` + `embedSourceMetadata: true` | the same 40, plus the source `blockNumber`, `txId` and `timestamp` *inside* each value that is a JSON object |

**`replayHistory: true` is also what makes the destination's delete functions
load-bearing.** A current-state replay submits no delete at all — `public-state.ndjson`
holds live keys and nothing else — so a destination contract with no `DeleteState` and
no `DeletePrivateData` carries a Tier 1 or Tier 2 migration without ever revealing it.
Turn history on and every source tombstone is submitted: the public one as whatever
[`deleteMapping`](#delete-function-mapping-deletemapping) names, `DeleteState` by
default, and the private one as `DeletePrivateData`, which is not configurable. The
[pre-flight](#destination-chaincode-pre-flight) does not catch a contract that lacks
them, because it probes `ListKeys` and submits nothing — so the failure arrives mid-run,
at the first deleted key, with every write before it committed and the file aborted
there. The three shipped contracts have both functions; a hand-written or trimmed one
has to.

`embedSourceMetadata` is the only route by which source provenance reaches a
Fabric destination, and it puts it inside the value rather than in the ledger
metadata, so a consumer has to know to read it there. It annotates history
records only: with `replayHistory: false` it does nothing whatever it is set to.
And it annotates only values that are JSON objects — see
[Source metadata attachment](#source-metadata-attachment-embedsourcemetadata) for
what happens to binary values, JSON scalars, arrays, and non-JSON text.

Nothing else carries provenance to a Fabric destination. `block-metadata.ndjson`
and `identities.ndjson` have no chaincode-adapter path at all, so the source's
per-transaction creator is unrecoverable there even with `embedSourceMetadata`
on. A PostgreSQL or DynamoDB destination keeps all of it — `fabric_history` is
keyed by the source `tx_id` and `fabric_block_metadata` and `fabric_identities`
carry the timestamps and creators — so this is a property of a Fabric
destination, not of the extraction.

**`verify` does not check any of it.** It compares keys, values and the
`isDelete` flag, and reads no `txId`, timestamp or creator on either side,
because those necessarily differ. A passing `verify` establishes that the
destination holds the right bytes under the right keys and says nothing about
provenance — so an application that reads `GetHistoryForKey`, or derives anything
from `GetTxID`, `GetTxTimestamp` or `GetCreator`, cannot be cut over on the
strength of one. Confirm with the application team what their code reads before
cutover, and treat the three rows above as the choice being made on their behalf.

### Running a history replay

`replayHistory` decides which files replay reads, and the choice is one-way.
Current-state replay reads `public-state.ndjson` and the channel's
`private-*-state.ndjson` files; history replay reads `public-history.ndjson` and
the `private-*-history.ndjson` files. The two sets are disjoint, no run adds the
earlier versions to a destination that already holds the current one, and nothing
at the destination merges two runs. Turning it on afterwards over the same keys
appends the whole source history *behind* the value already there: the current
value still converges, so the application still reads correctly, and `verify`
reports `history length: expected 40, got 41` on every key. The only repair is a
destination reset. **Decide before the first write.**

**Replay refuses to start one over existing data.** A history replay without
`historyImport`, on a channel with no checkpoint, first reads one page of each
destination namespace's public keys (`ListKeys`, page size 1) and refuses the
run if any namespace holds a key — the second-run case above, and the
rebuilt-at-the-same-address case, both caught before the first write. A channel
resuming from its own checkpoint is not checked, since its earlier writes are
expected to be there. Private collections cannot be listed and are not checked;
a namespace whose keys cannot be listed is logged as unchecked. Current-state
replay is not refused either: it overwrites rather than appends.

**What to settle up front.** A history replay is effectively one-shot when
`historyImport` is absent — the `dirtyFile` marker refuses to resume a failed one,
and a clean one deletes the checkpoint that carries the marker
([Re-running a replay](#re-running-a-replay)) — so the things another command
would otherwise discover by trying are worth establishing before the run
([Resilient idempotent history replay](#resilient-idempotent-history-replay-historyimport)
lifts the one-shot constraint):

- **The destination contract implements `DeleteState` and `DeletePrivateData`.**
  Nothing pre-flights them and no current-state replay reveals their absence, per
  [History and provenance fidelity](#history-and-provenance-fidelity). The three
  shipped contracts have both; read a hand-written one before the run rather than
  at the first source tombstone.
- **Every chaincode a history replay deletes keys in has the right delete
  function.** `DeleteState` is the default name only, configurable per chaincode
  through [`deleteMapping`](#delete-function-mapping-deletemapping); its private
  counterpart `DeletePrivateData` is not configurable at all, so an application
  contract that names it something else cannot take a history replay.
- **The destination channel is one you can afford to recreate.** A Fabric ledger
  is append-only: nothing in this toolkit deletes what a replay wrote, and
  recreating the channel is the only clean reset —
  [5.5 Resuming an interrupted run](HOWTO.md#55-resuming-an-interrupted-run) has
  the reset route for each destination type.
- **`writeBatchSize` is a blast radius here, not just throughput.** A rejected
  batch fails every key it carried and, in the default (append-only) mode, aborts
  the file and marks the checkpoint dirty. `1` restores per-key isolation at one
  transaction per write — see [Write Batch Size](tuning.md#write-batch-size-chaincode-replay).
  Under `historyImport` a rejected batch still stops the file, but the run stays
  resumable and `writeBatchSize` may be lowered before the retry.

**Rehearse with `replayHistory: false`, then reset.** A current-state replay of
the same config exercises everything the history run depends on except the
deletes: the connection and the identity, both pre-flights, every `keyMapping`
and `collectionMapping` entry, and the destination's endorsement policy under the
run's own write rate. It is also retryable, where the history run is not. Reset
the destination between the rehearsal and the run — a rehearsal left in place is
exactly the extra leading entry described above.

**One channel at a time is a config change, not a flag.** `replay` has no
`--channels`: its scope is `channelMapping`, and it walks the channels that map names
one after another. Because a clean run deletes the checkpoint, a second run with a
*wider* map replays the channels the first run already finished and doubles their
history. Each run's map therefore has to name **only the channels still owed** —
keep the full map somewhere and cut a copy down per run. `verify` does take
`--channels`, so each channel can be verified as its replay lands; see
[6.5 Verifying more than one channel](HOWTO.md#65-verifying-more-than-one-channel).

**The private half cannot be read back at all.** Fabric exposes no private-data
history API, so `verify` emits one `no-private-history-api` skip per
chaincode/collection and compares none of it. A history replay's private data is
checkable only as current state — the last version of each key — and its earlier
versions are write-only as far as this toolkit is concerned.

### Resilient idempotent history replay (`historyImport`)

Everything under [Running a history replay](#running-a-history-replay) describes
the **default** history replay: a failed one cannot be resumed, because a plain
`PutState`/`ImportPrivateData` re-sent after an ambiguous outcome appends a
duplicate `GetHistoryForKey` entry. `historyImport` opts a Tier 3 history replay
into a receipt-backed protocol (`idempotent-v1`) that removes that constraint —
a failed or interrupted run is safe to re-run from its checkpoint, with no
destination reset.

```json
"chaincode": {
  "...": "...",
  "replayHistory": true,
  "historyImport": {
    "mode": "idempotent-v1",
    "scope": "9f2c1ab34de5f60718293a4b5c6d7e8f",
    "keyPath": "./history-import.key"
  }
}
```

| Field | Value |
|---|---|
| `mode` | Must be `"idempotent-v1"` — the only protocol this build implements. |
| `scope` | 32–64 lowercase hex characters. Namespaces this migration's plan and receipts on the destination contract. |
| `keyPath` | Path to a file holding the HMAC key: **32 raw bytes or 64 hex characters**. Generate with `openssl rand -out history-import.key 32`. |

**Only valid with `replayHistory: true`**, and only when every public write and
delete goes through the migration contract. The protocol lives in `ImportHistory`
/ `ImportHistoryBatch`, so a `keyMapping` or `deleteMapping` entry naming an
application contract is refused before the run starts — an application function
carries no operation ID or intent commitment and cannot participate. Current-state
replay is untouched: the feature applies to history records only.

**Retain the key and the scope for every retry.** Every operation ID and intent
commitment is an HMAC under the key. A different key changes the plan's key
commitment, so the destination refuses it under the same scope; using both a new
key and a new scope would create new operation IDs and could import duplicates.
The key derives all idempotency and never leaves the client — the contract never
sees it. Store both the key file and the scope with the migration's control
evidence; losing either makes a resilient re-run impossible.

#### Operation ID, intent, plan, and receipt

Three commitments, all keyed by the HMAC key the client never sends:

- **Operation ID** — HMAC over the *immutable source identity* of a write:
  source network ID, source channel, block number, tx index, tx ID, chaincode,
  collection, key. It never depends on the destination value or routing, so the
  same source write has the same operation ID across runs, retries, and
  destinations. The contract keys a receipt by it.
- **Intent commitment** — a separately domain-separated HMAC over the *exact
  destination intent*: destination channel, chaincode, collection, key, delete
  flag, and the exact value bytes to be written (after any `embedSourceMetadata`
  merge). The contract stores it as the receipt, so a second run that resolves
  the same operation to a *different* value is caught as a mismatch rather than
  silently overwriting.
- **Plan digest** — a plain SHA-256 (it travels to the destination, so it must
  not expose the key) binding everything a run must not change midway: protocol
  version, scope, a *commitment* to the HMAC key, the exact ordered history input
  files by content hash, the source network, channel routing, collection routing,
  `embedSourceMetadata`, and the migration contract name. **`writeBatchSize` is
  deliberately not bound** — see below.

The contract stores, per scope, one plan digest and one receipt per operation, as
public state under reserved composite-key namespaces
(`fabric-amb-extractor-history-plan-v1`, `fabric-amb-extractor-history-receipt-v1`).
`InitializeHistoryImport` records the plan and refuses a *different* plan under a
scope that already has one — a changed plan needs a new scope. Every
`ImportHistory`/`ImportHistoryBatch` reads the receipt into the transaction's read
set and applies the mutation and writes the receipt **in the same transaction**,
so Fabric commits both or neither, and the read-set binding enforces the pairing
under MVCC. A re-submitted mutation whose receipt matches is a no-op; one whose
operation ID reappears with a different intent is refused.

The net guarantee, stated precisely: on a **completed** resilient replay, each
source history record produces **exactly one valid application-key mutation** at
the destination, under Fabric's normal transaction-validation and MVCC
assumptions. This is a per-record property of a finished run, not a global
exactly-once claim over the transport.

#### Private data privacy

In this protocol the private collection name, key, and value all travel as
**transient data**, inside the length-delimited `history_entry` envelope — not as
transaction arguments. The default path already sent private *values* as
transient; the resilient path additionally keeps the collection name and key out
of the public transaction arguments. Fabric still records its normal private-data
hashed write set (including collection metadata); this protocol adds no cleartext
private key or value to the public payload. The operation ID and intent are HMACs,
so the receipt state discloses neither source coordinates nor value.

#### Failure and resume semantics

A submit is tried **once**. There is no broad automatic retry loop. On a submit or
commit-status failure, the client reads the receipt(s) for the operation(s) **once**
and decides:

- **success** — the receipt exists and its intent matches this run's. The write
  already landed (this run or a prior one), so the failure is reported as success
  and the queue advances. This is what makes a re-run idempotent.
- **recoverable** — the receipt is absent or could not be read. The original
  failure is preserved: the key's queue fails and the checkpoint freezes, so a
  later run retries safely from the checkpoint.
- **mismatch** — the receipt exists but commits to a *different* intent. No re-run
  can reconcile this, so it is a hard failure that aborts the whole run.

A failed resilient history file still **stops** reading (so a later version of the
same key cannot land beyond a gap), but — unlike the default path — it does **not**
mark the checkpoint dirty or require a destination reset. The default
(non-`historyImport`) path still marks `dirtyFile` and refuses to resume. A
resilient failure therefore needs only "fix and re-run" when its checkpoint has
no dirty marker. An existing `dirtyFile` came from a partial legacy import whose
writes have no receipts, and remains a reset-required refusal even if
`historyImport` is enabled later.

Before the first write, `replay` probes each destination chaincode's
`HistoryImportProtocol` (a read) and refuses the run up front if the contract
predates the protocol, rather than failing on the first `ImportHistory`.

#### Receipt retention

Plans and receipts are migration control evidence. **Keep them for as long as a
replay or resume of this scope is possible** — deleting a scope's receipts and
re-running re-imports every record as a duplicate. They live under reserved
composite-key namespaces that begin with U+0000, so Fabric's unbounded range query
starts past them: they are excluded from `ListKeys`, and therefore from `verify`'s
extra-key sweep, automatically. Removing the contract registration does not
delete this state. This release provides no receipt-cleanup operation: retain it,
or treat any future explicit cleanup as an irreversible close of the scope after
which replay must never run again.

#### `writeBatchSize` is not plan-bound

Operational tuning is deliberately outside the plan digest. `writeBatchSize` may be
**changed safely between runs of the same scope** — for example lowered after an
oversized batch failed — without changing any imported record's destination intent,
so the receipts still match and re-initialization is a no-op. A resilient public
batch carries 64 extra bytes per entry (a 32-byte operation ID and a 32-byte
intent) over the legacy batch framing, which the adapter accounts for when sizing a
batch against the 2 MiB cap.

#### Limitations

- **Private historical versions are still unverifiable.** Fabric exposes no
  private-data history API, so `verify` still reports one `no-private-history-api`
  skip per replayed `(chaincode, collection)`. The receipts prove each import
  transaction was applied, but there is no read path to compare the versions
  themselves — see [History and provenance fidelity](#history-and-provenance-fidelity).
- **Public history verification is unchanged.** `verify` compares public history
  through `GetKeyHistory` exactly as without `historyImport`.
- **Provenance is still the migration's.** The protocol makes re-runs safe; it
  does not preserve the source `txId`, timestamp, or creator — every entry still
  carries the migration's own transaction identity.

### Source metadata attachment (`embedSourceMetadata`)

Off by default. Replay reproduces the source ledger, so what the destination
chaincode reads back is what the source chaincode wrote.

Turn it on when downstream consumers need to trace destination state back to the
source ledger. When Tier 3 history is replayed (`replayHistory: true`), the
destination's native block numbers, tx IDs, and timestamps describe the replay,
not the source; with `embedSourceMetadata: true`, source
`{blockNumber, txId, timestamp, isDelete}` is merged into each value as a nested
`migrationMeta` field:

```json
{"docType": "asset", "owner": "Alice", "migrationMeta": {"blockNumber": 5, "txId": "...", "timestamp": "...", "isDelete": false}}
```

The original fields are untouched, so typed chaincode reads (`ReadAsset` etc.)
and CouchDB rich queries on those fields keep working. The `verify` command
strips the overlay before comparing.

**Only JSON objects are annotated.** Binary values, JSON scalars, JSON arrays,
and non-JSON text have nowhere to put a nested field. Wrapping them in an
envelope would change their type at the destination, which is corruption rather
than annotation, so they are submitted byte-for-byte and the run logs a warning
once naming the first such value.

**When to leave it off.** Besides the default case, two situations make it
actively wrong:

1. **Strict schema validation on the destination.** Jackson (Java) with
   `FAIL_ON_UNKNOWN_PROPERTIES: true`, Go's
   `json.Decoder.DisallowUnknownFields()`, or JSON Schema with
   `additionalProperties: false` will fail to unmarshal a value carrying an
   unrecognized `migrationMeta` field.
2. **Byte-identical replay required.** If downstream consumers compare
   destination bytes to source NDJSON directly (external diff scripts,
   analytics pipelines that bypass `verify`), the overlay produces spurious
   mismatches on JSON-object values and none on the rest — an inconsistency
   that is harder to reason about than either extreme.

If a source value already has a top-level `migrationMeta` field, the merge
overwrites it and logs a warning. `migrationMeta` is a reserved name once this
option is used.

### Verification fields

These fields are used by the `verify` command and can be added to the same config:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `readFunctions` | Record\<string, Record\<string, string\>\> | For verify | — | Source channel → chaincode → read function for public state. Default from `generate-replay-config`: `"MigrationContract:ReadState"` |
| `privateReadFunctions` | Record\<string, Record\<string, string\>\> | No | — | Source channel → chaincode → read function for private state. Default: `"MigrationContract:ReadPrivateData"` |
| `historyReadFunctions` | Record\<string, Record\<string, string\>\> | No | — | Source channel → chaincode → history read function, returning `[{value, isDelete}]` — both fields are compared. Default: `"MigrationContract:GetKeyHistory"` |
| `skipCompositeKeys` | boolean | No | true | Skip composite keys (containing `\0`) during verification |
| `destinationStateDb` | `"CouchDB"` \| `"LevelDB"` | No | From manifest | State database of destination peer (affects history ordering in verify) |

All three read-function maps are keyed exactly like `keyMapping` — source channel, then a chaincode on that channel — so a chaincode deployed on more than one channel needs an entry under each. `verify` refuses to start unless every `(channel, chaincode)` pair with extracted state has a read function, naming each pair it is missing.

All three take `ContractName:Function` syntax. **Name your own application's read functions with their contract** — `"SampleAssets:ReadAsset"` — because an unqualified name resolves to the migration contract, whose results are base64-decoded before comparison. Verify errors with the fix in the message if a result is not base64, so a misconfiguration cannot be mistaken for a mismatch.

### Migration contract

The tool ships a migration contract that provides all functions the replay and verify commands need. Add it to your existing chaincode package — one file, one import, one list of writer MSP IDs, no application logic changes. See [migration-overview.md](migration-overview.md#migration-contract-setup) for language-specific instructions.

| Function | Signature | Used by |
|----------|-----------|---------|
| `PutState` | `(key: string)` + transient `public_value` | replay (public state, and every write when `writeBatchSize` is 1) |
| `PutStateBatch` | `()` + transient `public_batch` | replay (public state and history, batched) |
| `ImportPrivateData` | `(collection: string, key: string)` + transient `private_value` | replay (private state) |
| `DeleteState` | `(key: string)` | replay (history deletes, unless `deleteMapping` names another) |
| `DeletePrivateData` | `(collection: string, key: string)` | replay (private history deletes) |
| `ReadState` | `(key: string) → base64` | verify (public data) |
| `ReadPrivateData` | `(collection: string, key: string) → base64` | verify (private data) |
| `ReadPrivateDataHash` | `(collection: string, key: string) → base64` | verify (private data in a collection this identity cannot read) |
| `GetKeyHistory` | `(key: string) → [{value: base64, isDelete}]` | verify (Tier 3 history) |
| `ListKeys` | `(pageSize: string, bookmark: string) → {keys: base64[], bookmark}` | verify (the sweep for extra destination keys) |
| `InitializeHistoryImport` | `(scope, planDigest)` | replay (resilient history: records/confirms the plan) |
| `ImportHistory` | `(scope, planDigest, operationId, intentDigest)` + transient `history_entry` | replay (resilient history: one public/private mutation) |
| `ImportHistoryBatch` | `(scope, planDigest)` + transient `public_history_batch` | replay (resilient history: batched public mutations) |
| `GetHistoryImportPlan` | `(scope) → {scope, protocol, planDigest}` | replay (resilient history: read the stored plan) |
| `GetHistoryImportReceipt` | `(scope, operationId) → {scope, operationId, exists, intentDigest?}` | replay (resilient history: reconcile a failed submit) |
| `HistoryImportProtocol` | `() → {protocol, digestBytes, ...}` | replay (resilient history: pre-flight protocol probe) |

The last six are used only when [`historyImport`](#resilient-idempotent-history-replay-historyimport)
is configured; the first ten cover every non-resilient run. See the
[wire contract](../sample/chaincode/migration_contract/README.md) for the full
framing of the resilient functions.

No value crosses the boundary as a string. A ledger value is an arbitrary byte string, and the Node and Java contract APIs UTF-8-decode `String` arguments and return values, replacing anything that is not valid UTF-8 with U+FFFD. Writes therefore carry their value as transient data — `bytes` on the wire — and reads return base64. See [the wire contract](../sample/chaincode/migration_contract/README.md).

Every submit function refuses any MSP the contract's writer list does not name,
and that list is empty in every shipped copy, so a contract packaged unedited
refuses every replayed write. This covers `PutState`, `PutStateBatch`,
`ImportPrivateData`, `DeleteState`, `DeletePrivateData` and the three resilient
submit functions (`InitializeHistoryImport`, `ImportHistory`,
`ImportHistoryBatch`). `mspId` here is the identity replay signs with, and every
entry in `collectionIdentities` signs with its own — name all of them in the
contract, not just this one. The read functions (including
`GetHistoryImportPlan`, `GetHistoryImportReceipt` and `HistoryImportProtocol`)
are not gated. See [Who may write](../sample/chaincode/migration_contract/README.md#who-may-write).

### Complete example

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "/path/to/connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "/path/to/admin/signcerts/cert.pem",
    "keyPath": "/path/to/admin/keystore/abc123_sk",
    "channel": "mychannel",
    "concurrency": 4,
    "replayHistory": true,
    "keyMapping": {
      "mychannel": { "mycc": "PutState" }
    },
    "readFunctions": {
      "mychannel": { "mycc": "MigrationContract:ReadState" }
    },
    "privateReadFunctions": {
      "mychannel": { "mycc": "MigrationContract:ReadPrivateData" }
    },
    "historyReadFunctions": {
      "mychannel": { "mycc": "MigrationContract:GetKeyHistory" }
    }
  }
}
```

---

## PostgreSQL adapter

Writes all extracted data into relational tables. No Fabric network required.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connectionString` | string | Yes | PostgreSQL connection string |
| `allowInsecure` | boolean | No (default `false`) | Accept a non-local database without certificate-verified TLS. For test databases only |

### TLS

Replay and verify send ledger values, including private data, to the database. For any host other than `localhost`,
a loopback address or a Unix socket, `replay` and `verify` refuse a connection string that does not verify the
server's certificate and hostname. Use `sslmode=verify-full`, and add `sslrootcert=<path to CA bundle>` when the
server's certificate comes from a private CA (for Amazon RDS and Aurora, the
[RDS certificate bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)):

```
postgresql://migrator:<password>@db.example.internal:5432/fabric_migration?sslmode=verify-full&sslrootcert=/etc/ssl/rds-global-bundle.pem
```

`PGHOST` and `PGSSLMODE` are read as `pg` reads them. Write `verify-full` rather than `require`: the `pg` driver
treats `require` as `verify-full` today, but has announced that a future major version will follow libpq, where
`require` does not check the certificate. Keep the password out of the config file, for example by passing it in
`PGPASSWORD`.

### Tables created

This table is the only place these keys are written down; the guides link here
rather than repeat them.

| Table | Contents | Uniqueness key |
|-------|----------|----------------|
| `fabric_state` | Public + private current state | `(channel, chaincode, key, collection)` |
| `fabric_history` | All write-set versions, including `block_number` and `tx_index` source coordinates | `(channel, chaincode, key, tx_id, collection)` |
| `fabric_block_metadata` | Per-transaction audit trail | `(channel, block_number, tx_id)` |
| `fabric_identities` | Signing identities | `(msp_id, cert_fingerprint)` |
| `fabric_private_hashes` | Private data hashes | `(channel, chaincode, collection, key, tx_id)` |

Only `fabric_identities` declares its key as a `PRIMARY KEY`. The other four
enforce it with a unique index named `idx_<table>_unique`, so `\d` reports the
tuple above as an index — `fabric_history`, `fabric_private_hashes` and
`fabric_block_metadata` keep a separate `id BIGSERIAL PRIMARY KEY`, and
`fabric_state` has no primary key at all. Where `collection` appears in a key it
is indexed as `COALESCE(collection, '')`, because `NULL` never equals `NULL` and
public rows would otherwise duplicate on every re-run instead of conflicting.

Public data has `collection = NULL`. Private data has the collection name. Use `WHERE collection IS NULL` to query public data.

All writes are idempotent (`ON CONFLICT DO UPDATE` or `DO NOTHING`), so a second
replay into the same database converges rather than duplicating — see
[Re-running a replay](#re-running-a-replay).

### Key and value encoding

Fabric keys and values are arbitrary byte strings. PostgreSQL `TEXT` and `JSONB`
both reject U+0000 outright, and `JSONB` additionally rejects a surviving
`\u0000` escape inside a document. Two escapes keep every ledger byte storable.

**Keys.** Fabric's `CreateCompositeKey` uses U+0000 as its only separator, so
every composite key contains a byte `TEXT` cannot hold. Such keys are stored as
`b64:<base64 of the key's UTF-8 bytes>`. Ordinary keys are stored verbatim, so
they stay readable and matchable by prefix — with plain SQL here, and with a
`Scan` filter at a DynamoDB destination, whose state table holds each key on its
own partition and therefore has no ordered range to `Query`. A key that already
starts with the literal `b64:` is escaped too — that is what makes the mapping
reversible.

```sql
-- Composite keys, decoded back to the source form
SELECT convert_from(decode(substring(key from 5), 'base64'), 'UTF8')
  FROM fabric_state WHERE key LIKE 'b64:%';
```

The same escaping applies wherever a ledger key is stored, element by element:
`fabric_state.key`, `fabric_history.key`, and both `TEXT[]` columns on
`fabric_block_metadata` — `keys_written` and `keys_deleted`. A query looking for
a composite key in a block's write set has to escape the key it is searching for,
not the column:

```sql
-- Blocks that touched one composite key. The replace() strips the line breaks
-- PostgreSQL's encode() inserts every 76 characters; the stored form has none.
SELECT channel, block_number, tx_id FROM fabric_block_metadata
 WHERE 'b64:' || replace(encode(convert_to($1, 'UTF8'), 'base64'), E'\n', '')
       = ANY(keys_written);
```

`fabric_private_hashes.key` is the one exception: it holds a hex digest of the
private key, which contains no U+0000 and is left verbatim.

**Values.** `fabric_state` and `fabric_history` each carry a `value_encoding`
column alongside `value`:

| `value_encoding` | Meaning |
|---|---|
| `NULL` | `value` is the literal ledger value, as JSONB |
| `'base64'` | `value` is a JSON *string* holding base64 of the raw ledger bytes |

A value is base64-encoded when it is not valid UTF-8, when it contains U+0000,
when it embeds a `\u0000` escape — what Go's `json.Marshal` emits for a struct
field holding a composite key — or when it embeds an unpaired surrogate escape,
which is what `JSON.stringify` emits for a string cut mid-emoji. `JSONB` rejects
both escapes with `22P05, unsupported Unicode escape sequence` and takes the
whole insert with it. Base64 is always stored quoted, never parsed, so base64
that happens to be all digits does not land as a JSON number.

A text value that is not a valid JSON document is stored as a JSON *string*
holding it verbatim, with `value_encoding` left `NULL`. So is a document holding
a number too large for `numeric`, the type `JSONB` stores JSON numbers as:
`{"n":1e1000000}` parses as JSON but `jsonb_in` rejects it with `22003, value
overflows numeric format`. Both cases keep the text intact and readable as
`value #>> '{}'`.

```sql
-- Only rows whose value is meaningful to query as JSON
SELECT * FROM fabric_state WHERE value_encoding IS NULL;

-- Decode a binary value back to bytes
SELECT decode(value #>> '{}', 'base64') FROM fabric_state
  WHERE value_encoding = 'base64';
```

Any query that filters or joins on `value` must exclude
`value_encoding = 'base64'` rows, or it silently compares base64 text against
plaintext. The `verify` command applies both escapes on the way in and reverses
them on the way out, so its comparisons are against the source bytes.

The DynamoDB adapter uses the same key escaping and carries the marker as a
`valueEncoding` attribute.

### Example

```json
{
  "adapter": "postgresql",
  "inputDir": "./extraction-output",
  "postgresql": {
    "connectionString": "postgresql://user:pass@host:5432/fabric_migration?sslmode=verify-full"
  }
}
```

---

## DynamoDB adapter

Writes extracted data to DynamoDB tables. Tables are auto-created if they don't exist.

### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `region` | string | Yes | — | AWS region |
| `stateTable` | string | Yes | — | Table name for state records |
| `historyTable` | string | No | — | Table name for history records |
| `metadataTable` | string | No | — | Table name for block metadata |
| `identityTable` | string | No | — | Table name for identity records |
| `privateHashTable` | string | No | — | Table name for private hash records |
| `endpoint` | string | No | — | Endpoint override (for DynamoDB Local: `http://localhost:8000`) |

When `endpoint` is omitted, the AWS SDK uses standard credential resolution (instance profile, environment variables, etc.) to connect to real DynamoDB.

### Example

```json
{
  "adapter": "dynamodb",
  "inputDir": "./extraction-output",
  "dynamodb": {
    "region": "us-east-1",
    "stateTable": "fabric-state",
    "historyTable": "fabric-history",
    "metadataTable": "fabric-metadata",
    "identityTable": "fabric-identities",
    "privateHashTable": "fabric-private-hashes"
  }
}
```

---

## Re-running a replay

A replay's checkpoint is `<inputDir>/replay-checkpoint-<adapter>.json`. It is
retained when records fail, so re-running the same command retries them from the
last fully successful batch, and **deleted when a run finishes clean**, so
re-running after success starts from the first record again. Every record is
re-sent: no adapter reads the destination first to skip a record already there.

What that costs depends on the adapter and on `replayHistory`.

| Re-run of a run that | PostgreSQL / DynamoDB | Chaincode, `replayHistory: false` | Chaincode, `replayHistory: true` |
|---|---|---|---|
| **succeeded** | Converges. Every write is an upsert — `ON CONFLICT DO UPDATE`/`DO NOTHING` in PostgreSQL, a whole-item `PutRequest` in DynamoDB — and the identity aggregates only ever widen (`GREATEST`/`LEAST`, and a guarded update per attribute in DynamoDB), so row counts and values are unchanged | Converges *as state*. `PutState` on the same key is last-write-wins — but each re-run submits every key again, adding one more `GetHistoryForKey` entry per key at the destination | **Duplicates the destination's history.** A key with 40 source versions gets 40 more entries, in source order again after the first set. Nothing refuses this |
| **failed** | Resumes from the checkpoint. The batch that failed is re-sent whole | Resumes from the last fully successful batch, listed in `replay-failures.ndjson` | **Refused.** The checkpoint carries a `dirtyFile` marker and the next run stops rather than append entries out of order |

The asymmetry in the last column is the one to plan around: the `dirtyFile` guard
exists because a *partial* history replay cannot be resumed safely, and a clean
run deletes the checkpoint that carries it. So the guard covers the failure case
and not the success case, and a Tier-3 history replay is best treated as
one-shot — if you need to run it again, reset the destination channel's state and
history for the affected chaincodes first.

**`historyImport` changes the last column.** With
[resilient idempotent history replay](#resilient-idempotent-history-replay-historyimport)
enabled, a **failed** run resumes from its checkpoint like any other — no
`dirtyFile` marker, no reset — because a re-sent mutation whose receipt already
records it is a no-op. Re-running a run that **succeeded** still deletes the
checkpoint and re-sends every record, but the destination stays correct: each
record's receipt matches, so no duplicate history entry is written. The one hard
stop is a receipt whose stored intent differs from the re-run's, which aborts
rather than overwriting.

Both chaincode columns follow from
[History and provenance fidelity](#history-and-provenance-fidelity): a replayed
write is a new destination transaction, and re-sending one appends to the
destination's history rather than replacing anything in it. A PostgreSQL or
DynamoDB destination has no such effect because `fabric_history` and the history
table are keyed by the *source* `tx_id`, so the second run's rows conflict with
the first run's and update in place.

Two smaller effects of any re-run:

- `replay-failures.ndjson` is overwritten, not appended, and only when the run
  has failures — so a clean retry leaves the previous run's report on disk.
  Check its mtime, or the exit code, rather than its presence.
- `verify` and `validate` write nothing and can be re-run freely.

For the failure-and-recovery mechanics — reading the report, what a frozen
checkpoint means, and the recovery steps for an aborted history replay — see
[5.4 Reading the replay outcome](HOWTO.md#54-reading-the-replay-outcome).

---

## Common mistakes

| Problem | Cause | Fix |
|---------|-------|-----|
| `UNAVAILABLE: unable to verify the first certificate` | Connection profile uses inline `tlsCACerts.pem` but code only checked `.path` | Upgrade to latest version, or switch to a connection profile with `tlsCACerts.path` |
| `connectionProfilePath is required` | Missing chaincode section | Add full `chaincode` block with connection details |
| `totalReplayed: 0` but records were read | Missing `concurrency` field (pre-fix) | Add `"concurrency": 4` or upgrade to latest version which defaults to 1 |
| `keyPath` error: EISDIR | `keyPath` points to keystore directory | Set `keyPath` to the full path of the `*_sk` file inside the directory |
| Replay hangs after "checkpoint cleared" | PostgreSQL pool holding event loop open (pre-fix) | Upgrade to latest version, or Ctrl+C (replay completed successfully) |
| History not replayed | `replayHistory` not set or set to `false` | Add `"replayHistory": true` to the chaincode section |
| `destination chaincode(s) cannot take the writes this run would send them` | A chaincode the extraction holds records for is not committed on the destination channel under that name, or is committed without the migration contract registered beside it | Commit the chaincode there under the name the source used — nothing in the config renames one — or map the source channel elsewhere with `channelMapping`. For a contract that did not answer, register it in the destination package and re-commit, or set `chaincode.migrationContract` if the destination registers it under another name. The message names every chaincode and which of the two it is |
| `destination collection(s) would reject every write` | A collection another org owns, or one the destination chaincode does not declare | Add a `collectionIdentities` entry for that collection, or commit the destination chaincode with a collection config that includes it, or route it to a collection the destination already declares with `collectionMapping`. The message lists every collection and the remedy for each |
| `implicit collection(s) have no chaincode.collectionMapping entry` | A `_implicit_org_<MSPID>` collection carrying data with nothing saying where it goes. Its name is the *source* MSP ID's, and the destination's MSP IDs are not the source's | Add an `mspMapping` entry for the owning member, or a `collectionMapping` entry per collection the message names, pointing at the destination collection that data belongs in — `_implicit_org_<destination MSP ID>` for a per-org destination collection, or any collection the destination chaincode declares. Map it to itself if the destination reuses the source MSP IDs |
| `chaincode.collectionMapping sends more than one source collection to the same destination collection` | Two source collections in scope resolve to one destination — two entries with the same value, or one entry pointing at a collection that also carries data under its own name | Give each source collection its own destination collection. The message names the colliding sources |
| `[MISSING] … read from <collection>` | `verify` read a mapped collection back from its destination name and the key was not there. Either replay did not write it, or the mapping points at the wrong collection | Check the `collectionMapping` entry for that collection against the destination chaincode's collection config. The reported `collection` is the source name, so it matches the extraction's files; `read from` names where the read was actually addressed |
| Every key fails with `Org1MSP may not write migration data` | The destination chaincode was packaged with the migration contract's writer list left empty, or without the MSP the failure names. Each failed key carries the MSP it was refused for | Set `writerMSPIDs` (Go) or `WRITER_MSP_IDS` (Node.js, Java) in the copied contract file to every MSP the run submits as — `mspId` and each `collectionIdentities` entry's — then package and commit the chaincode again. The list is in the source rather than in state so that widening it takes the channel's approvals |
| Every public write fails naming `PutStateBatch` — `no such function`, or the contract not implementing it | The destination chaincode was packaged from a migration contract file without `PutStateBatch`. The pre-flight probe establishes only that the contract answers, by evaluating `ListKeys`; there is no way to test a submit without writing | Re-copy the current `sample/chaincode/migration_contract` file for your language and commit the chaincode again. `"writeBatchSize": 1` is the stopgap — it submits every write through `PutState` and `DeleteState` and calls `PutStateBatch` never |
| One bad value is reported as dozens of failed keys, each naming a `batch of N public writes` | Public writes are batched, and a transaction the destination rejects lands none of what it carried, so every key it held is reported. The error each entry carries names the batch and the peer's reason for refusing it | Fix the cause and re-run — the report lists every key to re-check, and none of them landed. `"writeBatchSize": 1` gives one key per transaction and so one key per failure, at one round trip per write |
| `batch names key <key> twice, at entry <n>` | The destination refused a batch holding two versions of one key, which would silently commit only the last of them. Replay does not build one — it takes one version per key per transaction — so this is a client and contract that disagree about the framing | Check that the destination's migration contract file and this toolkit are the same revision. Nothing in the config causes or fixes this |
| `collectionIdentities["x"] is missing keyPath` | Partial identity entry | Give every entry `mspId`, `certPath` and `keyPath` — a partial one would write the collection as the top-level identity |
| `collectionIdentities["x"] names "Org9MSP", which is neither a chaincode.orgIdentities entry nor the top-level mspId` | An MSP ID reference to an org with no credentials | Add that MSP to `orgIdentities`, or give the collection a full identity |
| `collectionIdentities names collections this run has no data for` | Collection name typo | Check the names against the `collection` field of the records in the channel's `private-*.ndjson` files |
| Every key written with `PutState` despite a `keyMapping` entry | `keyMapping`'s outer key is not a source channel the run replays — a typo, or a channel `channelMapping` leaves out. No entry under it matches any record, and the default applies | Replay warns `chaincode.keyMapping or chaincode.deleteMapping names source channels this run does not replay` and lists them. Check the names against `channelMapping`'s left-hand side |
| `chaincode.deleteMapping names no delete function for them` | A write mapped to an application contract whose delete is not mapped, so its tombstones go to `migrationContract`'s `DeleteState` | Add a `deleteMapping` entry for each `channel/chaincode` the warning names. Name `DeleteState` there if removing the key is all the destination needs |
| A key the source deleted is present at the destination, holding an empty value | `deleteMapping` points at a function that writes — the write function copied across, rather than the destination's delete | A delete function takes the key alone and reads no transient data. Point `deleteMapping` at one that deletes. `verify` reports these keys as `history[n]: expected <delete>, got <empty>` |
| Every deleted key reports `history[n]: expected <delete>, got <empty>` and the destination did delete them | The `historyReadFunctions` function returns `[{value}]` without `isDelete`, so verify reads every entry as a write | Return `isDelete` from the function. Verify cannot tell a destination that did not delete from a function that does not say so, so it reports the mismatch rather than assuming either |
| `verify` reports `[EXTRA]` keys the source never held | Every adapter sweeps the destination for public keys no extracted record accounts for. Either the destination was not empty before replay, or a delete was replayed as a write, or a `keyMapping` function stored the value under a different key | Reset the destination and replay from the beginning, or fix the mapping the extra keys point at. The sweep covers public state only, so extras from another member's private data are not reported |
| `destination key sweep failed: …` | The sweep was refused after the per-key checks ran — a dropped connection, an IAM policy that grants `GetItem` but not `Scan`, or a destination chaincode whose migration contract predates `ListKeys` | Grant `dynamodb:Scan` on the state table (PostgreSQL needs nothing beyond the `SELECT` it already had), or redeploy the destination chaincode with the current `sample/chaincode/migration_contract` file. The entry names what went unswept — a channel for the databases, `channel/chaincode` for Fabric. The forward results in the same run are still valid |
| `[MATCH] … value not readable by <MSP>; SHA-256 matches the destination's private-data hash` | That private value is in a collection the verifying identity is not a member of, so `ReadPrivateData` could not return it. The destination's own hash of the value was compared instead — a private-data hash is public channel data, and the peer applies the collection's read policy to the value but not to the hash | Nothing to fix. The hash equalling the SHA-256 of the extracted value is the same evidence Fabric gives a non-member. To compare the values themselves, run `verify` again as an identity that is a member of that collection |
| `[MISMATCH] … expected SHA-256 …, the destination's private-data hash is …` | Same path, and the two hashes differ: the destination holds different bytes under that key, or nothing that hashes to what was extracted | Re-replay that collection with the identity that owns it, then verify again. The value itself is unreadable from here, so the two hex strings are the whole comparison |
| `[SKIP] no-private-history-api` | A collection's private history was replayed and cannot be read back. Fabric exposes no private-data history API — `GetHistoryForKey` covers public state only | Nothing changes this, in any config. The current value of every key in that collection is verified; the versions behind it are not. The PostgreSQL and DynamoDB destinations store private history in a form that could be compared, but `verify` does not compare it there either |
| `history for <key> exceeds 8388608 value bytes at version <n>` | `GetKeyHistory` refuses a history too deep to return in one response rather than truncating it, since there is no paginated history API to fetch the rest with | Compare that key by hand — `GetHistoryForKey` on the destination against the key's records in `public-history.ndjson`. Every other key in the run is unaffected; only this one reports an error |
| `[SKIP] no-key-listing` on a chaincode destination | That namespace's `readFunctions` entry names your own contract, and only the migration contract has `ListKeys`, so nothing swept the namespace for extra keys | Point the entry at `MigrationContract:ReadState` to have the namespace swept, or accept the skip — it means the destination namespace has to be known-empty before replay instead |
| `Every chaincode on every channel must have a read function mapped` | A chaincode deployed on more than one channel mapped under only one of them. The message lists each `channel/chaincode` pair and which of the three maps is missing it | Add an entry under each channel the manifest deploys it on. `generate-replay-config` emits all of them |
| `chaincode.channel sends every source channel to "…"` | `channel` used for a run covering more than one source channel, which would merge them onto one ledger | Replace `channel` with a `channelMapping` entry per source channel, or narrow the run to one channel with `--channels` |
| `chaincode.channelMapping sends more than one source channel to the same destination channel` | Two entries in scope name the same destination — often a copy-paste of the destination name | Give each source channel its own destination channel. The message names the colliding sources |
| `chaincode.channel and chaincode.channelMapping are both set` | Both routing forms in one config | Delete `channel` and keep `channelMapping` |
| `Every channel being verified needs a destination` | `verify` run over a channel `channelMapping` has no entry for. It has no destination channel to read those records back from | Map the channel if it was replayed, or leave it out of the run with `--channels` |

## Validation checklist

Before running `replay`, verify your config:

1. **`inputDir` exists** and contains extraction output (check for `manifest.json`)
2. **`adapter` matches** the adapter section present in the config, and matches the `--adapter` you will pass to `replay` — the flag overrides the field, and `verify` reads the field
3. **Chaincode adapter:**
   - `connectionProfilePath` file exists and is valid JSON
   - `certPath` file exists (PEM certificate)
   - `keyPath` is a file (not a directory) and exists
   - Exactly one of `channel` and `channelMapping` is provided — `channel` only if the run covers a single source channel
   - No two source channels in scope share a destination channel
   - Every `keyMapping` and `deleteMapping` outer key is a **source** channel name from the manifest, spelled as `channelMapping` spells it
   - A chaincode deployed on more than one channel has an entry under each — in `keyMapping` and in the read-function maps
   - Every `keyMapping` entry naming a contract other than `migrationContract` has a `deleteMapping` entry beside it, if `replayHistory` is true
   - Destination chaincode is deployed with `PutState`, `PutStateBatch` and (if private data) `ImportPrivateData`, copied from the same revision of `sample/chaincode/migration_contract` as this toolkit
   - Every private collection another org owns has a `collectionIdentities` entry, or (for an implicit collection) an `orgIdentities` entry for its owner, pointing at a peer of that org — or `ownerEndorsement` is on and every owner's peer is discoverable
   - Every `_implicit_org_<MSPID>` collection carrying data has a `collectionMapping` entry or its owning member is in `mspMapping`, and no two source collections in scope share a destination collection
   - Every collection `collectionMapping` names on the right-hand side is declared by the destination chaincode, unless it is itself an `_implicit_org_<MSPID>` of a destination org
4. **PostgreSQL adapter:** connection string is reachable (`psql` can connect)
5. **DynamoDB adapter:** AWS credentials are available and IAM role allows `dynamodb:CreateTable`, `dynamodb:BatchWriteItem`, `dynamodb:UpdateItem`, and — for `verify` — `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`
