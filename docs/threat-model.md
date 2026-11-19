# Threat model

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This is a short threat model for `amb-migrate` and `fabric-rebroadcast`. It says what the tools protect, where they
trust something else, and which controls are left to you. It is a starting point for your own review, not a
substitute for one: you run the tools, on your hosts, against your networks.

## What the tools are

Command-line clients that run on a migration host you control. They open no listening port and run no service.
They read from an AMB Hyperledger Fabric peer over the member's network connection, and write files and, during
replay or re-broadcast, transactions to a destination you name. They run for the length of a migration and are then
removed.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| MSP signing keys (member admin, migration identities) | MSP directory, `./wallet/`, files named in the replay config or destination descriptor | Anyone holding one can sign as that org on the source or the destination |
| CA enrollment password | `CA_ENROLLMENT_SECRET`, `ADMIN_PASSWORD` in the environment | Issues new identities for the member |
| Private-data plaintext | `private-*-state.ndjson` and `private-*-history.ndjson` in the extraction output; merged output | Readable only by a collection's member orgs at the source; the migration must keep that boundary |
| Public ledger data | The rest of the extraction output, and the block archive (`--save-blocks`) | Business data of every member of the channel |
| History-import HMAC key | The file `historyImport.keyPath` names | Lets a replay resume without duplicating history; a different key changes every operation ID |
| Destination ledger | The destination network | After cutover, it is the system of record |

## Trust boundaries

1. **Source peer (AMB-managed).** The tools trust the member's own AMB peer for transaction validity and for which
   blocks make up the chain. [Known limitations: trust in the source peer](known-limitations.md#trust-in-the-source-peer)
   lists what is checked and what is taken on its word.
2. **Migration host.** Everything the tools write is on this host: keys, extraction output, archives, checkpoints.
   The tools assume only its operators can read it.
3. **Destination.** The tools authenticate the destination through TLS and the CA its connection profile or
   descriptor names. They write to it through the migration contract or, for re-broadcast, through its orderers.
4. **Other members.** In a multi-member migration each member extracts from its own peer and keeps its own private
   data. What crosses between members is a decision of the members, not of the tools.

## Threats and controls

| Threat | Control in the tools | Left to you |
|---|---|---|
| Keys, plaintext or archives read by another user on the migration host | Every file and directory `amb-migrate` creates is owner-only (`0700`/`0600`) whatever the umask; the block archive and enrolled keys too; `*.block`, `*.pem`, `*.key`, `wallet/`, `replay-config.json` are git-ignored | A dedicated host or account, disk encryption, deleting extraction output and keys when the migration is done |
| Credentials in shell history or logs | The CA password is read from the environment only, and the history-import key from a file only, never from the command line or the config. No log line carries a private key, password or the history-import key: logs name file paths, MSP IDs, ledger keys and counts. `enroll-admin.sh` passes the password to `fabric-ca-client` in the environment, not its command line | Fetching secrets from a secret store ([HOWTO](HOWTO.md)); `--admin-password` only on disposable test networks |
| Connecting to the wrong source, or reading through a man in the middle | Source connections require TLS against the AMB TLS chain, over the member's private network connection | Network access to the AMB endpoint only from the migration host ([IAM permissions](iam-permissions.md)) |
| A source peer serving a chain that is not the network's | Each block's `data_hash` and the hash chain from block 0 are checked; multi-member runs compare members' outputs (`merge`) and final header hashes | Orderer signatures are not checked. For evidence after AMB shuts down, verify them against an independently anchored genesis block |
| Writing to the wrong destination | Replay and verify refuse a destination whose genesis blocks differ from `destinationFingerprint` ([binding a config](replay-config-reference.md#binding-a-config-to-one-destination-destinationfingerprint)); re-broadcast checks the channel name, and on resume the destination's genesis block against its run state | Setting the fingerprint for every run that matters (it is optional) |
| Talking to an impostor destination | A TLS endpoint without a named CA is refused rather than checked against system roots; plaintext gRPC only with `--allow-insecure`; PostgreSQL beyond loopback only with certificate-verified TLS ([TLS](replay-config-reference.md#tls)) | Keeping CA files and connection profiles under change control |
| Old source identities acting on a re-broadcast destination | None: the destination keeps each org's AMB CA root so the original signatures validate | Removing the AMB roots and AMB-issued admin certificates from each org's MSP after cutover ([close the migration path](rebroadcast.md#close-the-migration-path)) |
| Unauthorised writes through the migration contract | The contract refuses every MSP not in its writer list, which ships empty and is approved with the chaincode package | Removing the contract and revoking the migration identities before application traffic is switched ([cutover runbook, step 11](cutover-rehearsal-runbook.md#the-window)) |
| Private plaintext read through the migration contract | None in the contract: its read functions are not gated, so a verify can run as any member | The same removal at cutover; network access to the destination limited to the migration host until then |
| A tampered or substituted archive sent by re-broadcast | `run` checks sealed digests, data hashes and the hash chain before contacting the destination, and resumes only from the archive it started with (or that archive extended) | Protecting the archive like the extraction output; the digest list is not signed |
| Private data crossing between members | Each member verifies its own share through its own peer; `verify` needs only that member's output, and names the other members still to verify | Agreeing between members who may hold whose output, especially for merged output and managed-provider destinations |
| A silently incomplete migration | `validate`, `verify` and `fabric-rebroadcast verify` check every key rather than sampling; `fabric-rebroadcast verify` fails when a collection the member can read has a key with no value supplied | Recording accepted loss (`blockToLive` purges, `--accept-unchecked`) in writing with the data owners |
| Ledger values in reports shared outside the team | Logs carry ledger keys but not values. `amb-migrate verify` mismatch reports quote values unless `--redact-values`; `fabric-rebroadcast` prints hashes, not values, unless `--show-values` | Using those for any output that leaves the operators |
| Tampered downloads during host setup | `setup-cloudshell.sh` checks pinned SHA-256 digests; the patched orderer image is pinned by digest | Pinning anything else you add to the host |

## Residual risks

- **Orderer signatures are not verified** on archived blocks, and transaction validity is taken from the source peer
  ([known limitations](known-limitations.md#trust-in-the-source-peer)).
- **The block archive and extraction output are not signed.** Their digests detect corruption, not a rewrite by someone
  who can write the directory.
- **Network isolation of the destination is not enforced.** The tools cannot see it; the migration contract must not
  outlive the migration.
- **The patched orderer** (`ORDERER_MIGRATION_SKIP_EXPIRATION`, cut markers) and Fabric's own
  `General.Authentication.NoExpirationChecks` relax checks a stock orderer makes. Use them only on a fresh destination
  during the migration window.
- **Dependencies** are third-party npm packages, pinned by lockfile and checked by `npm audit` in
  [`scripts/review-check.sh`](../scripts/review-check.sh); keep them current when you adopt the code.
