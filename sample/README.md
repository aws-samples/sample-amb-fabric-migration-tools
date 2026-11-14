# Sample Chaincode & Test Data

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Scripts and chaincode for testing the full extraction/migration pipeline against a live Amazon Managed Blockchain network. Source-side scripts are designed to run from **AWS CloudShell** or an EC2 instance in the AMB VPC — no Docker required. Destination-side scripts (replay + verify) require Docker and Docker Compose.

## What's included

```
sample/
├── chaincode/
│   ├── migration_contract/         # Migration contract library (add to your chaincode)
│   │   ├── README.md               # The wire contract, and why no value is a string
│   │   ├── go/migration.go         # Go (fabric-contract-api-go)
│   │   ├── node/migration.js       # Node.js (fabric-contract-api)
│   │   └── java/MigrationContract.java  # Java (fabric-chaincode-shim)
│   ├── sample_assets/
│   │   ├── sample_assets.go        # Asset management chaincode (Go)
│   │   ├── migration/migration.go  # Copied from migration_contract/go/ at build time
│   │   ├── go.mod
│   │   ├── collections_config.json # orgPrivateData + tempPrivateData
│   │   └── vendor/                 # Created by vendor-deps.sh
│   └── trade_registry/
│       ├── trade_registry.go       # Trade management chaincode (Go)
│       ├── migration/migration.go  # Copied from migration_contract/go/ at build time
│       ├── go.mod
│       ├── collections_config.json # counterpartyDetails
│       └── vendor/                 # Created by vendor-deps.sh
└── scripts/
    ├── resolve-network.sh        # Auto-discover IDs/endpoints from network name
    ├── env.sh.example            # Manual alternative — template for env vars
    ├── setup-cloudshell.sh       # Install Fabric tools + TLS cert on CloudShell
    ├── enroll-admin.sh           # Enroll admin identity via Fabric CA
    ├── create-channel.sh         # Create channel + join peer (idempotent)
    ├── configure-anchor-peer.sh  # Set up anchor peer (required for private data)
    ├── vendor-deps.sh            # Vendor Go deps for offline AMB deployment
    ├── deploy-chaincode.sh       # Package, install, approve, commit (idempotent)
    ├── populate-data.sh          # Populate sample_assets test data
    ├── populate-trade-data.sh    # Populate trade_registry test data
    ├── run-full-test.sh          # Full end-to-end: bootstrap → deploy → extract
    └── destination/
        ├── setup-test-network.sh   # Stand up Fabric 2.5 test-network + deploy chaincode
        ├── run-migration-test.sh   # Replay extracted data + verify
        ├── verify-replay.sh        # Wrapper around the maintained CLI verify command
        └── teardown-test-network.sh # Clean up Docker containers
```

## Prerequisites

Before running scripts, you need an AMB network and member created in the AWS console (or via CLI). Specifically:

- An AMB Hyperledger Fabric network (note the **network name** or **Network ID**)
- A member in that network (note the **admin username/password** you set during creation)
- A peer node in that member
- AWS CloudShell open in the same region, or an EC2 instance in the same VPC

On the machine that runs the scripts:
- **Node.js 22+ and npm**, and `npm install` done — the scripts drive the CLI through
  `npx ts-node`, so a clone with no `node_modules` fails at the extraction step, after
  the whole network bootstrap has already run
- **`jq`** and **`openssl`** — `enroll-admin.sh`, `configure-anchor-peer.sh`,
  `deploy-chaincode.sh` and every destination script shell out to them. CloudShell has
  both; a bare EC2 AMI generally has `openssl` and not `jq` (`sudo yum install -y jq`)

For destination-side replay testing, you also need:
- **Docker** and **Docker Compose** plugin
- **Go 1.20+** (for chaincode vendoring)
- At least **t3.medium** (4 GB RAM) — the test-network runs ~7 containers

You do **not** need to find or note the Member ID, Node ID, or endpoints — the scripts auto-discover these from the AWS API.

## Quick start (CloudShell)

```bash
# 1. Clone the repo into CloudShell and install its dependencies
git clone <your-repo-url>
cd sample-amb-fabric-migration-tools
npm install && npm run build

# 2. Run everything — just pass your network name and admin credentials:
./sample/scripts/run-full-test.sh \
  --network-name "my-fabric-network" \
  --admin-username admin \
  --admin-password 'MyP@ssw0rd'
```

That's it. The script auto-discovers your Network ID, Member ID, Node ID, and all endpoints via the Managed Blockchain API, then runs the full pipeline.

You can also pass `--network-id n-XXXXXXXXXX` instead of `--network-name` if you already know it.

That single command will:

1. **Install Fabric tools** — downloads `peer`, `configtxgen`, `configtxlator`, `fabric-ca-client` to `~/fabric-tools/bin` (persists across CloudShell sessions)
2. **Install Go** — for vendoring chaincode dependencies
3. **Download TLS cert** — AMB's managed TLS CA chain from S3
4. **Enroll admin** — registers with the Fabric CA using your admin credentials, creates `~/admin-msp/`
5. **Create channels** — creates `mychannel` and `tradechannel`, joins peer to both
6. **Configure anchor peers** — channel config update on both channels
7. **Vendor Go deps** — `go mod vendor` for both chaincodes
8. **Deploy chaincodes** — `sample_assets` on mychannel, `trade_registry` on both channels
9. **Populate data** — ~50 transactions across both chaincodes and channels
10. **Discover + extract** — runs the extractor at all three tiers across all channels
11. **Capture fixtures** — saves raw block data for offline test replay

Steps 5 through 8 are idempotent: each checks for what it is about to create and skips it, so re-running against an existing network leaves existing channels, anchor peers and committed chaincodes alone. **Step 9 is not.** `populate-data.sh` re-submits every invoke unconditionally — the `CreateAsset` calls fail endorsement on an asset that already exists and commit nothing, but the updates, transfers and deletes succeed again, adding history versions and advancing both channels' ledger heights. A second run therefore has a taller ledger to extract than the first, so step 10 refuses to extract into `test-output/tier*/` directories an earlier run filled — appending the new blocks to them would put two ledger heights in one snapshot. Move or delete `test-output/`, or pass `--skip-populate` to leave the ledger where it is and resume the existing extraction. See [Running a command twice](../docs/HOWTO.md#running-a-command-twice).

**Where the output lands.** `run-full-test.sh` extracts three times, one directory per
tier — `test-output/tier1/`, `test-output/tier2/`, `test-output/tier3/`, each holding a
`channel-<name>/` subdirectory per channel — with the manifest under
`test-output/discovery/` and block fixtures under `test/fixtures/`. It writes nothing to
`extraction-output/`; that is the default for `extract` run by hand, which is why the
step-by-step below uses it and the destination test takes a tier directory instead.

## Step-by-step (manual)

If you prefer to run each step individually:

```bash
# Auto-resolve env vars (or: source sample/scripts/env.sh)
source sample/scripts/resolve-network.sh --network-name "my-network" \
  --admin-username admin --admin-password 'MyP@ss'

# Bootstrap (one-time)
./sample/scripts/setup-cloudshell.sh                   # Fabric tools + TLS cert + Go
./sample/scripts/enroll-admin.sh                       # Admin identity via CA
CHANNEL_NAME=mychannel ./sample/scripts/create-channel.sh          # Create mychannel
CHANNEL_NAME=tradechannel ./sample/scripts/create-channel.sh       # Create tradechannel
CHANNEL_NAME=mychannel ./sample/scripts/configure-anchor-peer.sh   # Anchor peer
CHANNEL_NAME=tradechannel ./sample/scripts/configure-anchor-peer.sh

# Deploy chaincodes (idempotent — skips if already committed)
./sample/scripts/vendor-deps.sh
./sample/scripts/deploy-chaincode.sh --name sample_assets --channel mychannel
./sample/scripts/deploy-chaincode.sh --name trade_registry --channel mychannel
./sample/scripts/deploy-chaincode.sh --name trade_registry --channel tradechannel

# Populate test data
CHANNEL_NAME=mychannel ./sample/scripts/populate-data.sh           # sample_assets
./sample/scripts/populate-trade-data.sh --channel mychannel        # trade_registry
./sample/scripts/populate-trade-data.sh --channel tradechannel     # trade_registry

# Extract (all channels)
amb-migrate discover \
  --network-id $NETWORK_ID --member-id $MEMBER_ID \
  --node-id $NODE_ID --msp-path $MSP_PATH \
  --output-dir ./extraction-output

amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID --member-id $MEMBER_ID \
  --node-id $NODE_ID --msp-path $MSP_PATH \
  --channels mychannel tradechannel
```

## Why Go chaincode with vendored deps

AMB peers build chaincode inside containers that have **no internet access**. Node.js chaincode requires bundling `node_modules` and the peer's Node.js runtime may not match yours. Go with vendored deps is the most reliable:

- `go mod vendor` captures all transitive deps into `vendor/`
- The peer's Go builder uses `vendor/` automatically (no `GOPROXY` needed)
- Self-contained and reproducible

## Anchor peer setup

The `configure-anchor-peer.sh` script automates the [AWS-documented](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/hyperledger-anchor-peers.html) channel config update:

1. Fetches current channel config block from the orderer
2. Decodes protobuf to JSON via `configtxlator`
3. Injects `AnchorPeers` for your org (auto-detects peer host/port from AMB API)
4. Computes the config delta and wraps in a transaction envelope
5. Submits the update to the orderer

Anchor peers are required for:
- **Private data dissemination** — without one, `PutPrivateData` won't replicate across orgs
- **Service discovery** — `fabric-gateway` uses gossip to find endorsing peers
- **Cross-org chaincode invocation** — endorsement policies requiring multiple orgs

The script is idempotent — it checks if already configured and skips if so.

## Deployment matrix

| Channel | Chaincode | Tests |
|---|---|---|
| mychannel | sample_assets + trade_registry | Multi-chaincode per channel |
| tradechannel | trade_registry | Single chaincode, second channel |

## Chaincode operations

### sample_assets (mychannel)

| Operation | Fabric API | Extraction path |
|---|---|---|
| CreateAsset | PutState | public_state, public_history |
| UpdateAsset | PutState (overwrite) | Only latest in public_state, all in history |
| TransferAsset | GetState + PutState | Read-modify-write, ownership change |
| DeleteAsset | DelState | Absent from public_state, isDelete=true in history |
| CreateAppraisal | PutPrivateData (orgPrivateData) | private_state, private_history |
| UpdateAppraisal | PutPrivateData (overwrite) | Private history trail |
| DeleteAppraisal | DelPrivateData | isDelete=true in private_history |
| CreateTempNote | PutPrivateData (tempPrivateData) | Ephemeral data, purge risk |
| Composite keys | CreateCompositeKey + PutState | color~id index entries |

### trade_registry (mychannel + tradechannel)

| Operation | Fabric API | Extraction path |
|---|---|---|
| RegisterTrade | PutState | public_state, public_history (key format: TRD-\<id\>) |
| UpdateTrade | GetState + PutState | Quantity/price amendments, history trail |
| CloseTrade | PutState + DelState + PutState | Status transition, composite key rotation |
| CancelTrade | DelState | Absent from public_state, isDelete=true in history |
| SetCounterpartyInfo | PutPrivateData (counterpartyDetails) | private_state, private_history |
| DeleteCounterpartyInfo | DelPrivateData | isDelete=true in private_history |
| Composite keys | CreateCompositeKey + PutState | status~id index entries |

Both chaincodes import the migration contract via `migration/migration.go`, which adds `PutState`, `ImportPrivateData`, `DeleteState`, `DeletePrivateData`, `ReadState`, `ReadPrivateData`, `ReadPrivateDataHash`, `GetKeyHistory`, and `ListKeys` — used by the replay and verify commands. That file is not checked in per package: `vendor-deps.sh` and `deploy-chaincode.sh` copy it from `chaincode/migration_contract/go/`, so there is one copy to keep in step with the replay adapter. See [the wire contract](chaincode/migration_contract/README.md) for the arguments each function takes and why no value crosses the boundary as a string.

Its write functions refuse every MSP the contract's `writerMSPIDs` list does not name, and the checked-in copy ships that list empty. The source network keeps it empty — nothing is replayed into AMB, and its data arrives through `sample_assets` and `trade_registry` themselves — while `setup-test-network.sh` renders `Org1MSP` and `Org2MSP` into the copy it deploys to the destination. The generated default replay submits as Org1; Org2 is used only if you enable the documented optional `org2OnlyData` route with `collectionMapping` and an Org2 `collectionIdentities` entry. See [Who may write](chaincode/migration_contract/README.md#who-may-write).

## Private data collections

| Chaincode | Collection | blockToLive | Purpose |
|---|---|---|---|
| sample_assets | `orgPrivateData` | 0 (never purged) | Persistent private appraisals |
| sample_assets | `tempPrivateData` | 100 | Ephemeral notes (auto-purged, exercises hash extraction) |
| trade_registry | `counterpartyDetails` | 0 (never purged) | Confidential settlement instructions |

## Expected extraction results

After populating both chaincodes, a Tier 3 extraction should produce:

### channel-mychannel (sample_assets + trade_registry)

- **public-state.ndjson**: ~22 keys (6 assets + 6 asset composite keys + 5 trades + 5 trade composite keys)
- **public-history.ndjson**: ~100 entries across both chaincodes
- **block-metadata.ndjson**: one record per transaction, 100% block coverage
- **private-sample_assets-orgPrivateData-state.ndjson**: 3 appraisals
- **private-sample_assets-orgPrivateData-hashes.ndjson**: ~12 hash records
- **private-sample_assets-tempPrivateData-state.ndjson**: 3 temp notes
- **private-sample_assets-tempPrivateData-hashes.ndjson**: ~3 hash records
- **private-trade_registry-counterpartyDetails-state.ndjson**: 3 counterparty records
- **identities.ndjson**: 1 identity (admin)

### channel-tradechannel (trade_registry only)

- **public-state.ndjson**: ~10 keys (5 trades + 5 composite keys)
- **public-history.ndjson**: ~15 entries
- **block-metadata.ndjson**: one record per transaction
- **private-trade_registry-counterpartyDetails-state.ndjson**: 3 counterparty records
- **identities.ndjson**: 1 identity (admin)

The `PurgeAssessor` flags `tempPrivateData` (mychannel only) with blockToLive=100.

Validation should pass all checks with 0 warnings on both channels.

## Adapting the collection policy

Both `collections_config.json` files are templates: they name `Org1MSP`, and `deploy-chaincode.sh` renders that to `$MSP_ID` in a copy beside the package. **The checked-in file is never modified** — substituting in place dirties your clone and pins the policy to whichever member deployed first, which is wrong for every member after them.

Nothing to run by hand. To change the shape of a policy, edit the template and keep the placeholders:

```json
"policy": "OR('Org1MSP.member')"
"policy": "OR('Org1MSP.member','Org2MSP.member')"
"policy": "OR('Org2MSP.member')"
```

`Org1MSP` renders from `$MSP_ID` — whichever member is deploying. `Org2MSP` renders from `$MSP_ID_2`, so a two-org policy needs that set to the other member; the deploy is refused if it is unset or is the same member as `$MSP_ID`. Any other name (`Org3MSP`, a typo) is refused too, because a placeholder that survives names an MSP the channel does not have: Fabric commits that definition happily and then every write to the collection fails endorsement.

## Replaying to a destination network

After extracting from AMB, replay the data to a local Fabric 2.5 test-network.
For a disposable AMB endpoint, SSM host, secure enrollment secret, evidence capture,
and AWS teardown around this script, follow the
[live-test infrastructure runbook](../docs/live-test-runbook.md).

### Prerequisites for destination testing

On the machine running the destination test (can be the same EC2, but needs Docker):

```bash
# Install Docker + Compose plugin
sudo yum install -y docker
sudo systemctl start docker && sudo systemctl enable docker
sudo usermod -aG docker $USER
# Install compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
# Install Go, and jq if the AMI has none — every destination script uses it
sudo yum install -y golang jq
# Start a NEW session for group changes to take effect
```

Use at least a **t3.medium** (4 GB RAM). The test-network runs 7+ containers; t3.micro will OOM.

### Run the full test

```bash
# One command — sets up test-network, replays, and verifies:
./sample/scripts/destination/run-migration-test.sh \
  --input-dir ./test-output/tier1
```

Pass whichever directory holds the extraction you want to replay: `test-output/tier1`
after `run-full-test.sh`, or `extraction-output` after running `extract` by hand. Any
tier works — the config below replays and verifies current state only, so tier 2's and
tier 3's extra records are read and skipped rather than rejected. `run-migration-test.sh`
checks that both `channel-<name>/` directories exist before it starts anything, so a
wrong path costs a second, not a container bootstrap.

Or step by step:

```bash
# 1. Stand up Fabric 2.5 test-network with both channels and all chaincodes.
#    This is also what generates sample/destination-config/replay-config.json
#    and connection-profile.json — neither is committed.
./sample/scripts/destination/setup-test-network.sh

# 2. Replay extracted state to the destination (all channels)
amb-migrate replay \
  --input-dir ./test-output/tier1 \
  --adapter chaincode \
  --config ./sample/destination-config/replay-config.json

# 3. Verify every key matches across all channels
amb-migrate verify \
  --input-dir ./test-output/tier1 \
  --config ./sample/destination-config/replay-config.json

# 4. Clean up when done
./sample/scripts/destination/teardown-test-network.sh
```

### What gets replayed

The replay only writes **current state** (Tier 1 data):
- `public_state` records → `PutStateBatch()` on the destination chaincode, up to `writeBatchSize` keys and their values in one transient blob — or `PutState(key)` when a batch comes down to one key
- `private_state` records → `ImportPrivateData(collection, key)`, value as transient data, one key per transaction

History, block metadata, and identities are **not replayed** — they're audit artifacts from the source. The destination gets a fresh ledger whose blocks are the migration's own import transactions.

### Verification details

The verify command queries each key from the destination chaincode and compares against extracted NDJSON:
- **Regular keys** — compared via `MigrationContract:ReadState`, base64-decoded, with JSON normalization
- **Composite index keys** — skipped by default (`skipCompositeKeys`), because a read function takes one key
  argument and cannot be handed a key with a NUL in it. Replay wrote them like any other key, so they are at
  the destination; verification is what passes over them. The `~` in this sample's `color~id` and `status~id`
  entries is part of the object type the chaincode hands `CreateCompositeKey` — the separator it inserts is
  U+0000, so a key is composite by containing that, not a tilde
- **Private data** — verified via `MigrationContract:ReadPrivateData`, base64-decoded; a collection the
  verifying identity cannot read falls back to `MigrationContract:ReadPrivateDataHash` and compares the
  destination's own SHA-256 of the value, which is public channel data even where the value is not. The
  config `setup-test-network.sh` writes does not reach that path: `org2OnlyData` is the collection Org1
  cannot read, and no source collection is routed into it. To exercise it, add a
  `chaincode.collectionMapping` entry sending one source collection there and a
  `chaincode.collectionIdentities` entry naming an Org2 identity — without the second, the pre-flight
  refuses the run, because `org2OnlyData` sets `memberOnlyWrite` and Org1 is not a member of it
- **Private history** — reported as one `no-private-history-api` skip per collection. Fabric exposes no
  private-data history API, so nothing at a Fabric destination can read it back

Pointing `readFunctions` at the application's own read function instead works, but the name has to carry its contract — `SampleAssets:ReadAsset` — because an unqualified name resolves to the migration contract and its result is base64-decoded.

The destination test-network deploys the full source matrix, under the source's own
chaincode names — a chaincode name is its state namespace on both networks and nothing in the
config renames one, so replay refuses the run over any destination chaincode that is missing:
- **mychannel**: sample_assets + trade_registry
- **tradechannel**: trade_registry

`trade_registry` is therefore two deployments, and every function map is keyed by source channel and then
chaincode — so it takes an entry under `mychannel` *and* one under `tradechannel`. Mapping it once leaves
the other channel's records unverified, which `verify` refuses to start on. `setup-test-network.sh` writes
the config that way already.

### Known issues

- **CouchDB startup race** — On smaller instances, the peer may exit before CouchDB is ready. The setup script now waits for CouchDB health and restarts crashed peers automatically.
- **Go checksum mismatch** — If `go mod vendor` fails with a checksum error, clear the cache: `go clean -modcache && GONOSUMCHECK=* GOFLAGS=-mod=mod go mod tidy && go mod vendor`

### 2.2 → 2.5 compatibility

The version gap between AMB (Fabric 2.2) and the destination (2.5) doesn't affect state migration:
- NDJSON records are version-agnostic key-value pairs
- The chaincode API (`PutState`, `PutPrivateData`) is identical across 2.2-2.5
- The `fabric-gateway` SDK works with both versions
- Channel capabilities (V2_0) are shared across the range
