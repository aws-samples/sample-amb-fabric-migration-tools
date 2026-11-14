# How to run the AMB Fabric migration tools

End-to-end guide for extracting state from a Hyperledger Fabric 2.2 network on Amazon Managed Blockchain (AMB).

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

> **Note on CLI invocation:** This guide runs commands as `amb-migrate`, which `npm run build && npm link` puts on your `PATH`. Without `npm link`, run `node dist/cli/index.js` with the same arguments.

> **Provisioning and teardown:** For a disposable AWS endpoint/SSM host, secure secret handling, live extraction evidence, local Fabric 2.5 replay, and dependency-ordered cleanup, use the [live-test infrastructure runbook](live-test-runbook.md).
## Prerequisites

- An AMB Fabric 2.2 network with at least one member and one peer node (CouchDB or LevelDB)
- The admin username and password you set when creating the AMB member
- An EC2 instance (Amazon Linux 2023) in a VPC with:
  - An **AMB VPC endpoint** (`com.amazonaws.<region>.managedblockchain.<network-id>`) for peer/CA/orderer access
  - **SSM VPC endpoints** (`ssm`, `ssmmessages`, `ec2messages`) for Session Manager access (or internet access)
  - A security group allowing instance egress and AMB endpoint ingress from the instance security group on ports 30001-30004; SSM uses outbound HTTPS (443) to its endpoints or the internet
  - An IAM instance profile with `AmazonSSMManagedInstanceCore` and `managedblockchain:Get*` permissions

### EC2 instance setup

Launch an instance in the same VPC/subnet as your AMB VPC endpoint:

```bash
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.small \
  --subnet-id <SUBNET_WITH_AMB_ENDPOINT> \
  --security-group-ids <SG_ID> \
  --iam-instance-profile Name=<SSM_INSTANCE_PROFILE> \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=fabric-extractor}]' \
  --query "Instances[0].InstanceId" \
  --output text
```

Connect via SSM Session Manager (wait ~2 minutes after launch):

```bash
aws ssm start-session --target <INSTANCE_ID> --region <REGION>
```

### Install system dependencies (AL2023)

```bash
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version   # should be 22+
git --version
```

### Create Fabric core.yaml

The `peer` CLI requires a `core.yaml` config file. Create a minimal one:

```bash
mkdir -p ~/fabric-config
echo -e "peer:\n  tls:\n    enabled: true" > ~/fabric-config/core.yaml
export FABRIC_CFG_PATH=~/fabric-config
echo 'export FABRIC_CFG_PATH=~/fabric-config' >> ~/.bashrc
```

---

## Phase 1: Environment Setup

### 1.1 Clone the repo

```bash
git clone https://github.com/aws-samples/sample-amb-fabric-migration-tools.git
cd sample-amb-fabric-migration-tools
```


### 1.2 Install Node.js dependencies

```bash
npm install
```

### 1.3 Resolve your network configuration

This discovers your network/member/node IDs and endpoints from the AWS API. Read the member admin's password into
the environment rather than typing it on the command line, where it would land in shell history. For example, from
AWS Secrets Manager:

```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD="$(aws secretsmanager get-secret-value \
  --secret-id "<your admin password secret>" --query SecretString --output text)"

source sample/scripts/resolve-network.sh \
  --network-name "your-network-name"
```

`--admin-password` also exists, for disposable test networks only.

This exports all required environment variables (`NETWORK_ID`, `MEMBER_ID`, `NODE_ID`, `REGION`, `MSP_ID`, `CHANNEL_NAME`, `PEER_ENDPOINT`, etc.) into your shell session.

If you already know your IDs, you can pass `--network-id n-XXXXXXXXXX` instead of `--network-name`.

### 1.4 Install Fabric tools and download TLS certificate

```bash
bash sample/scripts/setup-cloudshell.sh
source ~/.bash_profile
```

> The script is named `setup-cloudshell.sh` but works identically on EC2. It installs tools to `$HOME` which persists across reboots on EC2.

This installs:
- Fabric CLI binaries (`peer`, `configtxgen`, `fabric-ca-client`) to `~/fabric-tools/bin`
- Go (for vendoring chaincode dependencies)
- AMB TLS CA certificate from `s3://<region>.managedblockchain/etc/managedblockchain-tls-chain.pem`

The `source ~/.bash_profile` ensures Go, Fabric tools, and `FABRIC_CFG_PATH` are available in the current session (especially important for SSM sessions which don't source `.bashrc` by default). On EC2 these persist across reboots.

### 1.5 Enroll admin identity

```bash
bash sample/scripts/enroll-admin.sh
```

Enrolls your admin certificate and private key via the AMB Fabric CA. Writes MSP to `~/admin-msp/`. If already enrolled, it reports the certificate expiry and exits.

---

## Phase 2: Network Setup (test data)

Skip this phase if you already have a channel with deployed chaincode and data.

### 2.1 Create a channel and join the peer

```bash
bash sample/scripts/create-channel.sh
```

Creates `mychannel` (or whatever `$CHANNEL_NAME` is set to), generates a channel config tx, submits it to the orderer, and joins your peer.

### 2.2 Configure anchor peer

```bash
bash sample/scripts/configure-anchor-peer.sh
```

Required for private data gossip to work.

### 2.3 Deploy sample chaincode

```bash
# Vendor Go dependencies (requires Go, installed by setup-cloudshell.sh)
bash sample/scripts/vendor-deps.sh

# Deploy sample_assets with private data collections
bash sample/scripts/deploy-chaincode.sh
```

The `sample_assets` chaincode has two private data collections:
- `orgPrivateData` — persistent (blockToLive=0), your org can read/write
- `tempPrivateData` — ephemeral (blockToLive=100), auto-purged after ~100 blocks

### 2.4 Populate test data

```bash
bash sample/scripts/populate-data.sh
```

Creates ~25 transactions covering:
- 8 asset creates (public state)
- 4 updates (creates history versions)
- 3 ownership transfers
- 2 deletes (exercises DelState)
- 4 private appraisals + 1 update + 1 delete (persistent private collection)
- 3 ephemeral notes (temporary private collection)

**Expected extraction results:**
| Data type | Expected count |
|---|---|
| Public state (live keys) | 6 (8 created minus 2 deleted) |
| Public history entries | ~20 |
| Private state (orgPrivateData) | 3 appraisals (4 minus 1 deleted) |
| Private state (tempPrivateData) | 3 notes |
| Private history entries | ~7 |

### 2.5 One-command alternative

Instead of steps 2.1-2.4 you can run everything in one shot, with `ADMIN_USERNAME` and `ADMIN_PASSWORD` set as in 1.3:

```bash
bash sample/scripts/run-full-test.sh \
  --network-name "your-network-name"
```

On re-runs add `--skip-bootstrap` (skips tool install, enrollment, and channel
creation) and `--skip-populate` (skips re-submitting the sample transactions,
which would otherwise grow both ledgers) — see
[Re-run extraction only](#re-run-extraction-only-skip-bootstrap). The script
writes into `test-output/`, and refuses to extract into tier directories an
earlier run filled unless the ledger has been left where it was.

---

## Phase 3: Extraction

Extraction is a two-step process: **discover** (learn the network topology) then **extract** (pull the data).

### 3.1 Discover

```bash
amb-migrate discover \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --msp-path $MSP_PATH \
  --bootstrap-channel $CHANNEL_NAME \
  --output-dir ./extraction-output
```

`--msp-path` is auto-resolved from the `$MSP_PATH` environment variable if not set (the `resolve-network.sh` script exports this). `--region` defaults to `us-east-1` and is not read from the manifest, so pass it to `extract` too when the network is in another region.

This queries the AMB API and the peer to produce `./extraction-output/manifest.json`, which contains:
- Channel list, ledger heights
- Chaincode names, versions
- Private data collection definitions (policies, blockToLive)

Use `--bootstrap-channel` to auto-discover all channels the peer has joined via `cscc`. Or use `--channels mychannel` to specify explicitly.

### 3.2 Extract

There are three extraction tiers. Choose based on what you need.

#### Tier 1 — Current State Snapshot

Extracts the latest value for every key across all chaincodes. Fastest option. Use when you only need to migrate current state to a new system.

```bash
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 1 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --output-dir ./extraction-output
```

**Output files:**
```
extraction-output/channel-mychannel/
  public-state.ndjson          # One record per live key
  private-<cc>-<coll>-state.ndjson  # One record per live private key (accessible collections only)
  metadata.json                # Channel extraction summary
```

`metadata.json` is the record of what this extraction could and could not
reach. Read it before replaying:

| Field | Meaning |
|---|---|
| `extractedByMspId` | MSP ID the extraction ran as. Collection policies are written in terms of MSP IDs, so this decides which collections yielded values |
| `privateDataCoverage` | One entry per `(chaincode, collection)`: `values` (plaintext captured), `hashes-only` (hashed rwsets only — not a member, or purged), or `absent` (nothing seen), plus `blockToLive`, `purgeRisk`, and `estimatedPurgedBlocks` |
| `blocksWithoutMetadata` | Blocks that legitimately produced no metadata records — config blocks, or blocks whose every transaction was invalidated. Tier 2+ only. `validate` uses this to tell an expected gap from a lost block |
| `outputFiles` | Cumulative record counts across every run that wrote into this directory |

A `hashes-only` or `absent` entry you cannot explain is a migration blocker,
not a warning. Resolve it before replay.

#### Tier 2 — Current State + Block Metadata (Audit Trail)

Everything in Tier 1, plus per-block metadata: transaction IDs, timestamps, which keys were written/deleted, and creator identity per transaction. Use when you need an audit trail alongside the state.

```bash
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 2 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --output-dir ./extraction-output
```

**Additional output files (on top of Tier 1):**
```
extraction-output/channel-mychannel/
  block-metadata.ndjson        # Per-block: txId, timestamp, keysWritten, keysDeleted, creator
  identities.part              # This channel's signers, committed with the channel
extraction-output/
  identities.ndjson            # Unique creator identities with tx counts, rebuilt from every channel's part
```

#### Tier 3 — Full History

Everything in Tier 2, plus every historical write for every key (public and private). Use for complete forensic migration or when the target system needs full provenance.

```bash
amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  --network-id $NETWORK_ID \
  --member-id $MEMBER_ID \
  --node-id $NODE_ID \
  --region $REGION \
  --output-dir ./extraction-output
```

**Additional output files (on top of Tier 2):**
```
extraction-output/channel-mychannel/
  public-history.ndjson              # Every write: key, value, txId, timestamp, isDelete
  private-<cc>-<coll>-history.ndjson # Every private write with txId and timestamp
  private-<cc>-<coll>-hashes.ndjson  # Hashes for inaccessible/purged private data
```

### 3.3 Extraction options

| Flag | Default | Description |
|---|---|---|
| `--tier <1\|2\|3>` | (required) | Extraction depth (see above) |
| `--strategy <s>` | `auto` | `auto` or `block-reconstruction` (no chaincode deployment needed) |
| `--channels <c...>` | all | Subset of channels from the manifest |
| `--concurrency <n>` | 1 | Parallel channel extraction (each channel is independent). Each channel reads the peer over two streams, its public walk and its private data, so this is up to 2n streams. For what it costs across many channels at once, see [Eight channels at once](tuning.md#eight-channels-at-once) |
| `--state-backend <b>` | `auto` | `memory` (fast, high RAM), `leveldb` (large ledgers), `auto` (starts in-memory, promotes to LevelDB at limit) |
| `--memory-limit <mb>` | 512 | MB threshold for auto-promoting to LevelDB, across **all** channels — each channel extracted in parallel gets an equal share, so `--memory-limit 512 --concurrency 8` promotes each of the eight at 64 MB. The run is refused unless V8's heap ceiling is twice this: raise it with `NODE_OPTIONS=--max-old-space-size=<mb>` before starting, which is the one setting no flag can change afterwards ([sizing](tuning.md#heap-size)) |
| `--state-data-dir <dir>` | system temp dir | Where the LevelDB spill goes, one subdirectory per channel. The default is the root volume on Amazon Linux — point this at a volume sized for the whole reconstructed state, or a promotion part-way through the walk fills `/` |
| `--batch-size <n>` | 100 | Block fetch pagination size |
| `--prefetch-buffer <n>` | 8 | Number of blocks to fetch ahead during block walk (0 to disable) |
| `--save-blocks <dir>` | off | Also write every raw block to `<dir>/<channel>/blocks/<N>.block`, with `blocks.sha256` (checkable with `sha256sum -c`) and a `manifest.json`, as the input of block-level migration ([re-broadcast](rebroadcast.md)). The extraction output is unchanged. The blocks carry ledger values: the directory and files are created owner-only, and `*.block` is git-ignored |
| `--blocks-only` | off | With `--save-blocks`: walk, verify the hash chain and write the archive, nothing else. No state, history, metadata, private data or identity file is produced and `--output-dir` is not written (`--tier` is required by the command and ignored). Safe to re-run: it continues at the first missing block |

### 3.4 Check extraction status

```bash
amb-migrate status --output-dir ./extraction-output
```

Shows per-channel progress: record counts, checkpoint state, ledger height coverage.

### 3.5 Merge per-member extractions (multi-org networks only)

Skip this on a single-member network.

A peer only holds the private data its own MSP is in the collection policy for,
and no AMB API exposes another member's private data. So on a multi-org network
each member runs Phase 3 against its own peer and the outputs are merged:

```bash
amb-migrate merge \
  --input-dirs ./orgA-output ./orgB-output \
  --output-dir ./merged-output
```

`--input-dirs` takes one directory per member — two at a minimum, no maximum. A
five-member channel is one command:

```bash
amb-migrate merge \
  --input-dirs ./orgA-output ./orgB-output ./orgC-output ./orgD-output ./orgE-output \
  --output-dir ./merged-output
```

**Merge every member in one pass, not pairwise.** `merge` refuses a merged
directory as an input to a second merge, because of what it would do: a merged manifest
carries `mergedFrom` in place of an `mspId`, and a member is only credited with the
MSP its own manifest records — so a merge that consumes a merged directory
contributes no MSP for any member inside it. `validate` tests a missing private
value against the MSPs the manifest names, so after a second merge the values the
first pass's members should have supplied are excused with *no extracting MSP is in
the collection policy* instead of being reported — the check goes quiet about
exactly the members whose coverage was rolled up. A three-member live test
reproduced this with exit 0 before the refusal was added. Members are identified by
`memberId` from their own manifests, falling back to the directory name, and the
same member passed twice is refused.

Private history and hashes are sort-merged on `(blockNumber, txIndex)` and
deduped on `(blockNumber, txIndex, chaincode, collection, key)`, so the merged
files stay in the ledger order replay and `validate` both require. Public state,
public history and block metadata are copied from one member — identical on every
peer of a channel — after `merge` confirms the members' copies agree.

`merge` refuses to run rather than produce a directory nobody can reason about.
It stops if the members disagree on `networkId` or `region`; if they
extracted a shared channel at different ledger heights (merging those would pair
one member's private data with another's public state); if the same member is
passed twice; if their public files disagree; or if the output directory is not
empty. A failed merge leaves no `manifest.json`, so a half-written directory is
rejected by every downstream command.

The output includes a **cross-member coverage matrix** — one row per
`(chaincode, collection)` naming which members contributed values, which
contributed only hashes, and why anything is missing:

```
  ch1 (height 4200)
    private state 812, history 1904, hashes 1904
    Private data coverage:
      trade/orgAConfidential: values from orgA
      trade/orgBConfidential: values from orgB
      trade/tempNotes: hashes-only (purge-window)
      trade/auditTrail: hashes-only (unexplained)  <-- needs attention
```

`merge` exits 1 when two members hold different values for one key, or when a
collection's absence has no established cause (`unexplained` or
`indeterminate`). Neither is loss a data owner can accept, because neither says
what was lost. Only `purge-window` is accepted loss. The full report, including
every conflicting key, is written to `merged-output/merge-report.json`.

Validate and replay the merged directory from here on — not the per-member ones,
which each hold only their own private data.

#### Sequencing the members onto one ledger height

**Nothing in the toolkit pins a height across members, and no command
coordinates them.** `discover` records each channel's `ledgerHeight` in the
manifest of the member that ran it, `extract` walks that member's channel to
`ledgerHeight - 1`, and `merge` compares the members' manifests after the fact and
refuses any channel whose members disagree:

```
Members extracted channel ch1 at different ledger heights: 4200 (./orgA-output);
4187 (./orgB-output). Re-extract the lagging members at the agreed height, or drop
them from the merge — merging heights would pair one member's private data with
another's public state.
```

So the agreed height is a procedure, not a setting. Per channel:

1. **Stop application submits.** Every peer of a channel converges on the same
   height once the last block commits; while blocks are still arriving, two
   members who run `discover` a minute apart get two heights and no later step
   can recover the difference. Nothing else in this list works without this one.
2. **Each member runs `discover`** against its own peer and reads the
   `ledgerHeight` its own `manifest.json` now holds for the channel.
3. **Compare the numbers before anyone extracts,** and publish the agreed one —
   by whatever channel the members already use for a change window. A member
   reporting a lower height has a peer that has not caught up yet: it re-runs
   `discover` until the number stops moving and matches. There is no
   `--end-block` on `extract`, so a height cannot be selected downwards — the
   members that are ahead have nothing to give up, and the run waits for the
   peers that are behind.
4. **Each member extracts** its own peer at that height, into its own output
   directory, and runs `validate` on it.
5. **Merge**, which re-checks the heights, `networkId` and `region`, and the
   members' public files against each other. Members may run different state
   databases: extraction reads blocks, so the records do not depend on it. The
   merged manifest says `CouchDB` if any member's peer ran it, so `check-chaincode` still
   asks for the CouchDB indexes, and keeps each member's own value in `mergedFrom`.

A member that extracted before the height was agreed re-extracts into a **fresh
output directory**, not the one it used. `extract` resumes from the checkpoints in
that directory and appends to the NDJSON files already there, so a second walk
leaves one directory holding two extractions taken at two heights — which
`validate` reports as duplicate keys. See
[Running a command twice](#running-a-command-twice).

The refusal's other option, **dropping the lagging member**, is worth thinking
about before taking. It succeeds, and it silently converts that member's private
collections from data you have into data nothing asks for: `mergedFrom` no longer
names its MSP, so `validate` finds no contributing MSP in those collections'
policies and excuses the missing values as an authorization gap rather than
failing on them. The merged directory is then complete by every check the toolkit
makes and short by one member's private data. Drop a member only where a data
owner has agreed in writing that its collections are out of scope.

### 3.6 Validate extraction output

```bash
amb-migrate validate --input-dir ./extraction-output
```

On a multi-org network point `--input-dir` at the merged directory. `validate`
reads `mergedFrom` from the merged manifest, so a missing private value is only
excused when *no* contributing MSP was in the collection policy — if one of them
was, another member should have supplied the value and the gap is `unexplained`.

Checks:
- NDJSON format validity (every line has a `_type` discriminant)
- Duplicate key detection (public and private state)
- Block completeness (Tier 2+ — see below)
- Record ordering (public history, block metadata, private history, private hashes)
- History completeness (public and private history vs block metadata/hashes)
- Private data hash-vs-value cross-check
- Private value coverage — every hashed private key either has a value or an explanation (see below)
- Channel metadata and identities presence

**Block completeness** compares the block numbers in `block-metadata.ndjson`
against `metadata.json`'s `blocksWithoutMetadata`. A gap on that list is
expected and passes; a gap outside it FAILs as an unexplained missing block. If
`metadata.json` predates that field, gaps downgrade to a WARN — the check cannot
tell the two cases apart, and says so.

**Private value coverage** takes every key hash in `private-<cc>-<coll>-hashes.ndjson`
and asks why no plaintext value accompanies it. Four verdicts:

| Verdict | Meaning |
|---|---|
| `expected-deleted` | The key's last write was a delete |
| `expected-unauthorized` | `extractedByMspId` is not in the collection policy — the peer never sent values |
| `expected-purged` | The write is older than `blockToLive` allows |
| `unexplained` | None of the above. **This FAILs** — data is missing and nothing accounts for it |

When the reason cannot be established at all — neither `metadata.json` nor
`manifest.json` records an extracting MSP ID, or the manifest holds no
collection config for that chaincode — the check cannot rule out an
authorization gap, so it WARNs instead of FAILing and tells you to re-run
`discover`.

`validate` exits 1 if any check FAILs, 0 otherwise. A WARN does not fail the run
but always means a check could not reach a verdict, so a 0 exit with warnings is
not a clean bill of health.

---

## Phase 4: Generate Replay Config

After validation passes, generate and review a replay config before committing
to a replay run.

```bash
amb-migrate generate-replay-config \
  --input-dir ./extraction-output
```

The command reads `manifest.json` and prompts for adapter selection, channel
mapping, chaincode function mapping, and connection details. Review the
generated `replay-config.json` before proceeding — verify channel mappings,
destination infrastructure readiness, and credentials.

### Assembling the config for many channels and chaincodes

The maps in a replay config are keyed by `(source channel, chaincode)`, so a
network with 8 channels and a few chaincodes each needs dozens of entries across
`keyMapping`, `readFunctions`, `privateReadFunctions` and `historyReadFunctions`.
Do not hand-write them. **The wizard's proposal comes from the manifest**, one
entry per channel and one per `(channel, chaincode)` deployment it records, so it
covers every deployment the extraction knows about — and its shape does not change
with the scale. It proposes each map whole and asks one question about it:

| Question | Accepting it writes | Answering `n` |
|---|---|---|
| `Use this channel mapping? [Y/n]` | `channelMapping`, each source channel to a destination channel of the same name (or `channel` when the manifest has exactly one) | Asks for a destination per source channel, refusing a name already taken by another channel |
| `Use this collection mapping? [Y/n]` — asked only when the manifest holds an `_implicit_org_<MSPID>` collection | `collectionMapping`, each implicit collection to its own name | Asks for a destination per collection, refusing a name twice, because two source collections in one destination collection overwrite each other's keys |
| `Use this chaincode mapping? [Y/n]` | `keyMapping`, every deployment to `PutState` | Asks per deployment, and asks for a paired delete function for any answer that names an application contract rather than the migration contract |
| `Use these verify functions? [Y/n]` | `readFunctions` → `MigrationContract:ReadState`, `historyReadFunctions` → `MigrationContract:GetKeyHistory`, and `privateReadFunctions` → `MigrationContract:ReadPrivateData` for every deployment the manifest records a collection for | Asks per deployment, per map |

Around those it asks for the connection details, `concurrency`, and whether to
replay Tier 3 history — that last one is the choice to make before the first write
and not after
([Running a history replay](replay-config-reference.md#running-a-history-replay)) —
and it closes by reminding you that the destination contract's writer list ships
empty and has to name the replaying MSP.

What still needs reading afterwards, in the generated file:

- **Destination channel and chaincode names.** The defaults assume the
  destination spells everything the way the source does. Chaincode names have to
  match — nothing renames a namespace — but channel names need not, and only you
  know which is which.
- **`collectionMapping`'s destinations, one per implicit collection.** An
  `_implicit_org_<MSPID>` collection is named after the *source* MSP, so accepting
  the default maps it to a collection name the destination network has no org for.
  This is the one map whose defaults are wrong by construction on any destination
  with different MSP IDs.
- **`privateReadFunctions` covers more deployments than hold private data.** On a
  Fabric 2.x source, `discover` synthesizes an implicit collection for every
  chaincode on the channel, so every deployment on that channel gets an entry
  whether anything was ever written privately through it. The entries are harmless
  — an unused one is never called — but the map is not a list of where private data
  is, and reading it as one is how a real gap gets missed.
- **Every manifest channel present in `channelMapping`.** A source channel left
  out is skipped by `replay` — which still exits 0 — and refused by `verify`.
- **`PutState` left alone where you meant it to be.** An explicit `PutState` is
  the same configuration as no entry at all and keeps batched writes on; a
  `keyMapping` entry naming your own contract turns them off for that deployment
  and needs a `deleteMapping` entry beside it once `replayHistory` is on.

The `replay-config.json` heredoc in
`sample/scripts/destination/setup-test-network.sh` is the repo's worked example of
the shape at more than one channel: two channels in `channelMapping`, a chaincode
deployed on both with an entry under each, and every read function carrying its
contract name.

---

## Phase 5: Replay

Replay loads extracted data into a target system. Three adapters are available: PostgreSQL, chaincode (Fabric-to-Fabric), and DynamoDB.

### 5.1 PostgreSQL replay

Create a config file `replay-config.json`:

```json
{
  "adapter": "postgresql",
  "inputDir": "./extraction-output",
  "postgresql": {
    "connectionString": "postgresql://user:password@host:5432/dbname?sslmode=verify-full"
  }
}
```

Run:

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter postgresql \
  --config replay-config.json
```

The PostgreSQL adapter creates tables and upserts all extracted records (public state, history, block metadata, private data, identities).

### 5.2 Chaincode replay (Fabric-to-Fabric)

Every chaincode the extraction holds records for has to be committed on each
destination channel its source channel maps to, **under the same name**. A
chaincode name is its state namespace on both networks and nothing here renames
one, so a destination that spells it differently is a different namespace and no
config entry bridges the two. Replay reads each destination channel's committed
definitions before its first write and refuses the run naming every chaincode
that is not there — see
[Destination chaincode pre-flight](replay-config-reference.md#destination-chaincode-pre-flight).

The destination chaincode has to carry the migration contract, and that contract
has to name the MSPs this run submits as — `writerMSPIDs` in the Go copy,
`WRITER_MSP_IDS` in the Node.js and Java ones. Each ships with the list empty and
refuses every write, so a chaincode packaged from an unedited copy fails on the
first key with `<MSP> may not write migration data`. The pre-flight catches a
contract that is not registered at all, but not one whose writer list is empty:
the list gates submits, and the pre-flight only reads. See
[Who may write](../sample/chaincode/migration_contract/README.md#who-may-write);
for the sample destination,
`sample/scripts/destination/setup-test-network.sh` renders `Org1MSP` and
`Org2MSP` into the copy it deploys, so this walkthrough needs no edit to it.

For replaying state into a new Fabric network via chaincode transactions:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./target-connection-profile.json",
    "mspId": "TargetOrgMSP",
    "certPath": "./wallet/admin.pem",
    "keyPath": "./wallet/admin-key.pem",
    "channel": "targetchannel",
    "keyMapping": {
      "mychannel": { "sample_assets": "PutState" }
    },
    "replayHistory": true,
    "concurrency": 5
  }
}
```

Set `replayHistory: true` to replay Tier 3 history records. Each historical write becomes a destination write in block order, so the destination's `GetHistoryForKey` reflects the original sequence — a key's own versions one transaction at a time, since a transaction's write set holds one value per key, batched across keys otherwise. Omit or set to `false` to replay only current state — which leaves the destination with one version per key and none of the source's earlier ones. Either way every replayed write is a new transaction, so the destination's history carries the migration's `txId`, timestamp and creator MSP rather than the source transaction's, and `verify` does not check that: [History and provenance fidelity](replay-config-reference.md#history-and-provenance-fidelity) is what to hand the application team before cutover. The choice is also one-way and the run effectively one-shot — read [Running a history replay](replay-config-reference.md#running-a-history-replay) before turning it on.

`channel` above is the single-destination form, and it covers this config because the extraction has one source channel. A run covering more than one needs [`channelMapping`](#multi-channel-replay-with-channelmapping) — one destination per source channel — and is refused otherwise.

Run:

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter chaincode \
  --config replay-config.json
```

`keyMapping` maps a **source channel** and then a chaincode on it to the target chaincode function that accepts key-value writes. The outer key is the source channel, not the destination one, because a chaincode name is only unique within a channel: `marketplace` on `orders-ch` and `marketplace` on `trades-ch` are two deployments and can take two different functions. A deployment absent from `keyMapping` — including every deployment on a channel the map does not name at all — uses the default function `PutState`. Give a function its contract (`"SampleAssets:StoreAsset"`) to submit it on a contract other than the migration contract; an unqualified name is a migration contract function. Either way the call has the same shape — one argument, the key, and the value in the transient map under `public_value` — so an application function mapped here has to accept that, not `(key, value)`.

`PutState` above is the default written out in full, and it is not a call per key: public writes on the migration contract are batched into `PutStateBatch` transactions of up to `writeBatchSize` distinct keys, 500 by default. Naming an application function instead — `"SampleAssets:StoreAsset"` — opts that deployment out, one transaction per write. `concurrency` controls how many transactions are in flight, so the two together are up to `concurrency × writeBatchSize` keys being written at once. Records sharing the same `(chaincode, collection, key)` are always replayed in separate transactions, in order, to preserve write ordering. The collection is part of that key, so a denial on one collection's `asset1` does not skip the writable collections' `asset1` behind it.

A rejected batch fails every key it carried, and with `replayHistory: true` that aborts the file — set `"writeBatchSize": 1` to trade the throughput back for one key per transaction and so one key per failure.

#### Deletes and `deleteMapping`

`deleteMapping` is the same map for public deletes — source channel, then chaincode, then the function a tombstone is replayed through — defaulting to `DeleteState` on the migration contract. It is read only when `replayHistory` is on, because a tombstone reaches the destination only through a `public_history` record; current-state replay has nothing to delete.

It is a separate map from `keyMapping` rather than the same one because a delete is not a write with an empty value. The write function takes the key as its one argument and the value in the transient map; the delete function takes the key alone and carries no transient data. Submitting the write function for a tombstone would write an empty value where the source deleted the key, leaving the destination holding a key the source ledger does not have.

**Set `deleteMapping` whenever `keyMapping` names a contract other than the migration contract.** A write pointed at your application's own function is usually pointed there because that function maintains something besides the key — a composite-key index, a counter, an event. `MigrationContract:DeleteState` removes the key and leaves that bookkeeping referring to it. Replay warns and names every deployment whose write left the migration contract with no delete named beside it; naming `DeleteState` explicitly silences it, because that is an answer — the key is all there is to remove.

Private deletes are not configurable. `ImportPrivateData` carries its value in the transient map under the migration contract's own wire convention and cannot be pointed elsewhere, so `DeletePrivateData` stays beside it rather than splitting a pair that has to move together.

#### Where each collection is written (`collectionMapping`)

A collection name belongs to the destination chaincode's definition, not to the data, so the name the source used need not exist there. `collectionMapping` gives each source collection its destination collection:

```json
"collectionMapping": {
  "_implicit_org_Org2MSP": "_implicit_org_DestOrg2MSP",
  "sharedAppraisals": "sharedAppraisals"
}
```

**An `_implicit_org_<MSPID>` collection has to be mapped.** Fabric names the per-organization collection every 2.x chaincode gets after the org that owns it, so the name carries a *source* MSP ID; a destination network's MSP IDs are not the source's, and the write fails there on the name alone. Replay refuses before its first write until every implicit collection carrying data has an entry — map it to itself if the destination reuses the source MSP IDs, which is still a decision worth writing down. A collection the chaincode declares needs no entry.

Two source collections cannot share one destination collection: a collection is one keyspace within its chaincode, so their copies of a shared key would overwrite each other there with nothing failing.

`verify` reads private data back through the same map, so a mapped collection is compared against the collection it was written to.

#### Private collections another org owns

A collection admits writes from the orgs its policy names, so one admin identity cannot replay five members' private data. Name an identity per **destination** collection — the policy that admits a write is the destination collection's, so a mapped collection is keyed here by the name `collectionMapping` sends it to:

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

Give each entry a peer of its own org: a peer whose org is not a collection member cannot store the private data it endorses, so an Org2 identity submitting through an Org1 peer can have its transaction succeed and its private data go nowhere.

Every `mspId` used here also has to be in the destination contract's writer list, `mspId` at the top level included. One chaincode definition serves the whole channel, so the list is not per-peer: it is every member the migration writes as.

Replay checks every collection it is about to write against the destination's committed chaincode definitions **before the first write**, and refuses the run listing each collection that would reject its writes and what to change. See [replay-config-reference.md](replay-config-reference.md#destination-collection-pre-flight) for what it does and does not refuse on.

#### Multi-channel replay with `channelMapping`

When migrating multiple channels, use `channelMapping` to route source channels to destination channels:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./target-connection-profile.json",
    "mspId": "TargetOrgMSP",
    "certPath": "./wallet/admin.pem",
    "keyPath": "./wallet/admin-key.pem",
    "channelMapping": {
      "source-channel-1": "dest-channel-1",
      "source-channel-2": "dest-channel-2"
    },
    "keyMapping": {
      "source-channel-1": { "marketplace": "ImportOrder" },
      "source-channel-2": { "marketplace": "SampleAssets:ImportTrade" }
    },
    "concurrency": 4
  }
}
```

- Use `channelMapping` whenever the run covers more than one source channel. `channel` (single string) is the shorthand for a run covering exactly one, and is refused for more — every source channel would be written to that one ledger, where two channels' copies of a shared key overwrite each other and the survivor is whichever file was replayed last. Eight channels would become one, and the run would report success.
- The same merge is refused when a `channelMapping` names one destination for two source channels in scope. Requiring the map is not enough on its own; the map has to be injective over the channels the run covers.
- Setting both `channel` and `channelMapping` is refused. `channelMapping` used to win silently, so a mistyped map key skipped a channel while `channel` sat there looking like a fallback.
- Source channels not present in the map are **skipped** by replay: logged as a warning, and named in the replay summary under `Channels skipped`. The run still exits 0, so check that line. `verify` refuses the same config rather than skipping — a channel it silently left out would read as verified.
- To ensure all channels are migrated, include every channel from the manifest in the map. Run `validate --input-dir ./extraction-output` and check the channel list against your mapping.
- `keyMapping` and `deleteMapping` are keyed by the **source** channel, the same name as `channelMapping`'s left-hand side. Replay warns and names any source channel either map covers but the run does not replay, because a misspelling there does not fail — every deployment under it quietly falls back to `PutState` and `DeleteState`.
- A `keyMapping` value naming another contract, like `"SampleAssets:ImportTrade"` above, needs a matching `deleteMapping` entry once `replayHistory` is on. Without one its deletes go to the migration contract while its writes go to the application's, and replay warns about the split.

### 5.3 DynamoDB replay

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

Only `stateTable` is required. Omit `historyTable`, `metadataTable`, `identityTable`, or `privateHashTable` to skip those record types during replay — a record type with no table name is silently not replayed, so name every table for the tier you are migrating.

Run:

```bash
amb-migrate replay \
  --input-dir ./extraction-output \
  --adapter dynamodb \
  --config dynamodb-config.json
```

The DynamoDB adapter creates tables (PAY_PER_REQUEST billing) and writes all extracted records. State, history, metadata, and private hashes use `BatchWriteItem`, 25 items to a request and up to 8 requests in flight; identities use `UpdateItem` with a guarded update per attribute. State keeps upsert semantics because a `PutRequest` replaces the whole item.

Identity aggregates are **not** accumulated. `firstSeenBlock` only moves earlier, `lastSeenBlock` and `txCount` only move later, each behind a `ConditionExpression`. Every member's export of a channel derives the same counts from the same public blocks, so adding them would inflate `txCount` once per member replayed. Replaying the same file twice is a no-op.

### 5.4 Reading the replay outcome

Every adapter prints a summary and sets an exit code:

| Exit code | Meaning |
|---|---|
| 0 | Every record reached the destination |
| 1 | At least one record did not. The destination is incomplete |

The two targets fail differently.

**Chaincode** collects per-key failures and keeps going. A failure stops that
key's queue — later writes to the same key depend on the earlier ones — while
other keys continue, so one run can report thousands of failures. On a non-zero
exit:

- **`<input-dir>/replay-failures.ndjson`** holds one line per failing key —
  `channel`, `chaincode`, `collection` (private data only), `key`, `mspId`, the
  error, and `skippedAfter`: how many further writes to that key were abandoned.
  This is the complete list, not a sample. The line count is smaller than
  `Records failed` by exactly the sum of `skippedAfter`. The error names the
  `chaincode/Contract:function` the record was submitted to and then the peer's
  reason for refusing it, so a failure caused by a `keyMapping` or
  `deleteMapping` entry says which entry.

**PostgreSQL and DynamoDB** have no partial-failure mode. A batch either commits
or raises, and a raise aborts the command with the driver's error — there is no
failure report, because there is no list of individually failed keys to write.
PostgreSQL rolls the batch back; DynamoDB retries throttled items and then
raises, so a batch can be partly written. Either way the checkpoint is not
advanced, so re-running the same command re-sends the batch: state upserts are
idempotent, history is not (see below).

For both targets:

- **`<input-dir>/replay-checkpoint-<adapter>.json` is retained.** It is not
  advanced past the batch that failed, so re-running the same command resumes
  from the last fully successful batch. Each adapter has its own file, so
  replaying the same extraction to two destinations does not have them
  overwriting each other's progress. Do not delete it unless you intend to
  replay from the beginning.

A clean run clears that adapter's checkpoint and writes no failure report.

**A Tier 3 history replay cannot be retried — unless `chaincode.historyImport` is
set.** By default, history is replayed as a sequence of ordinary writes, so each
record appends a new entry to the destination's `GetHistoryForKey`. There is
nothing to overwrite and nothing to roll back: once a history file has partly
landed, re-submitting the batch appends duplicates in the wrong order.

So, in the default mode, a failed history record stops the run instead of being
retried:

- The file stops at the end of the failing batch, and the remaining history
  files are skipped.
- `replay-checkpoint-<adapter>.json` gains a `dirtyFile` marker that survives the
  process.
- The summary reports `historyAborted`, and the next run **refuses to start**,
  printing the affected file and the recovery steps.

To recover: fix the cause in `replay-failures.ndjson`, reset the destination
channel's state and history for the affected chaincode, delete
`replay-checkpoint-<adapter>.json`, and replay from the beginning.
`--batch-size 1` does not help — one failed record is already unrepairable.

**Resilient idempotent history replay removes this constraint.** With
`chaincode.historyImport` configured (chaincode adapter, Tier 3), a failed history
file still stops — to preserve key order — but leaves **no** `dirtyFile` marker
and needs **no** destination reset. Each mutation carries a deterministic
operation ID and intent commitment, and the destination contract records a
receipt per operation, so re-running the same command re-sends only what did not
land and treats an already-applied record as a no-op. The one hard stop is a
receipt whose recorded intent differs from the re-run's, which aborts rather than
overwriting. See
[Resilient idempotent history replay](replay-config-reference.md#resilient-idempotent-history-replay-historyimport).

State-only replay (Tier 1/2, or Tier 3 with `replayHistory: false`) is
unaffected: `PutState` on the same key is last-write-wins, so re-running the
same command is a safe retry.

### 5.5 Resuming an interrupted run

Three checkpoint files, two lifecycles. `discover`, `merge`, `validate`, `verify`
and `status` keep none — each reads its inputs and can be re-run freely.

| File | Written by | Holds | Deleted |
|---|---|---|---|
| `<output-dir>/channel-<id>/checkpoints/<channel>-block-walk.json` | `extract` | The last block whose records are all on disk | Never |
| `<output-dir>/channel-<id>/checkpoints/state-reconstruction.complete` | `extract` | That the channel's extraction is committed: written last, after its output files, `identities.part` and `metadata.json` are on disk | Never |
| `<input-dir>/replay-checkpoint-<adapter>.json` | `replay` | `lastFile`, `recordsCompleted`, exact ordered `files`, and `dirtyFile` when a history file aborted | On a clean run |

**Replay resumes at a file and a record offset within it.** Progress is bound
to the exact ordered file list persisted in checkpoint version 2. Private files
are sorted before that list is built. Re-running the same command skips completed
files and re-sends the failed batch; adding, removing, or reordering any input
file is refused because positional resume against a changed set can silently skip
new data or duplicate completed history. Restore the original extraction, or
reset the destination and delete the checkpoint before replaying a changed set. Because the checkpoint is deleted on success, **nothing on disk
records which channels have already been replayed** — that list is the operator's,
and it is the reason to run a Tier 3 history replay one channel at a time with a
map naming only the channels still owed rather than widening a map as you go.

**A resilient history failure does not create a `dirtyFile`.** When
`chaincode.historyImport` is set from the start, a failed history file freezes the
checkpoint at its last successful batch but writes no dirty marker, so the next
run of the same command resumes — the destination contract's receipts make a
re-sent mutation idempotent. An existing `dirtyFile`, however, records a partial
legacy history attempt whose writes have no receipts; enabling `historyImport`
cannot repair it, and replay still refuses until that destination is reset. The
same-input-file guard applies in either mode: adding, removing, or reordering
input files between runs is refused because the file set is also bound into the
plan digest the destination holds. See
[Resilient idempotent history replay](replay-config-reference.md#resilient-idempotent-history-replay-historyimport).

**Extraction resumes per channel, not per block.** Reconstructed state is flushed
at the end of a channel's walk out of a transient accumulator, so a walk killed
part-way has nothing to keep. Each channel commits as soon as both of its passes
finish, whatever the other channels are doing: its signers are written to
`identities.part`, its files are synced, then `metadata.json` is written, then the
completion marker (`state-reconstruction.complete`). `identities.ndjson` is rebuilt from the
parts of every committed channel at the end of each successful run.

A re-run skips every committed channel without contacting the peer
(`Channel already extracted — skipping`; with `--save-blocks` it still checks that
the archive holds every block), which is what makes a
`--concurrency 8` or `--processes 8` run recoverable channel by channel. For a
channel without a marker it resets the checkpoint, truncates the files the walk
re-derives — `public-state.ndjson`, plus `block-metadata.ndjson` at Tier 2+, plus
`public-history.ndjson` and the private hash files at Tier 3 — and walks that
channel again from block 0:

```
State reconstruction did not complete — resetting checkpoint to re-walk
Truncated re-derived block-walk outputs
```

Nothing is saved within a channel, so there is no benefit to re-running an
interrupted walk sooner rather than later. Channels can also be extracted by
separate `--channels` runs into one directory; the registry then covers all of
them.

A channel that has `metadata.json` and a checkpoint at its height but no marker
is refused instead, with nothing changed: the run that wrote it died while
committing, or it came from another version of this tool. Move the directory
aside and extract into an empty one.

**Private-data delivery always re-derives its products from genesis.** Private
current state is accumulated in memory and written only when delivery finishes,
so no block cursor can safely resume it. Before each attempt the extractor
truncates `private-*-state.ndjson` and `private-*-history.ndjson`, then delivers
blocks from 0. If delivery fails, the channel fails and no `metadata.json` is
written; re-running performs the same clean full pass. Private hash files belong
to the public block walk and are not truncated by this reset.

This is intentionally different from public block-walk resume. Do not create,
copy, or rely on a `pvtdata-delivery` checkpoint from an older toolkit version;
the current extractor ignores that unsafe cursor and reconstructs the complete
private view.

**Resetting a destination** is the step "replay from the beginning" assumes, and
it costs a different amount at each target:

| Destination | How to reset |
|---|---|
| Fabric (chaincode) | **There is no reset.** A Fabric ledger is append-only, and deleting the keys leaves the deletes in the history a Tier 3 replay exists to reproduce. The only clean one is a new or recreated destination channel: create it, join the peers, commit the chaincode definitions again, and point `channelMapping` at it. Treat the destination channel as disposable until a history replay has passed `verify` |
| PostgreSQL | `TRUNCATE fabric_state, fabric_history, fabric_block_metadata, fabric_private_hashes;` for a whole database, or `DELETE FROM <table> WHERE channel = '<source channel>';` in those four for one channel. `fabric_identities` has no channel column and needs no reset — its writes only ever widen `firstSeenBlock`/`lastSeenBlock`/`tx_count`. The adapter re-creates any table it does not find |
| DynamoDB | Delete the tables named in the config and let the adapter re-create them; they are PAY_PER_REQUEST, so there is no capacity to plan. Deleting items instead costs a write per item |
| Sample test network | `sample/scripts/destination/teardown-test-network.sh` runs `network.sh down`, which takes the ledger with it, then `setup-test-network.sh` builds it again |

---

## Phase 6: Verify

Verification confirms the destination matches the extracted data. For chaincode (Fabric-to-Fabric) targets, the `verify` command queries each key and compares values.

### 6.1 Add verify fields to replay config

The verify command uses the same config as the chaincode replay adapter. Add `readFunctions`, `privateReadFunctions`, and (for Tier 3) `historyReadFunctions` to the `chaincode` section of your replay config:

```json
{
  "adapter": "chaincode",
  "inputDir": "./extraction-output",
  "chaincode": {
    "connectionProfilePath": "./target-connection-profile.json",
    "mspId": "TargetOrgMSP",
    "certPath": "./wallet/admin.pem",
    "keyPath": "./wallet/admin-key.pem",
    "channel": "mychannel",
    "keyMapping": {
      "mychannel": { "sample_assets": "PutState" }
    },
    "replayHistory": true,
    "readFunctions": {
      "mychannel": { "sample_assets": "MigrationContract:ReadState" }
    },
    "privateReadFunctions": {
      "mychannel": { "sample_assets": "MigrationContract:ReadPrivateData" }
    },
    "historyReadFunctions": {
      "mychannel": { "sample_assets": "MigrationContract:GetKeyHistory" }
    },
    "concurrency": 10
  }
}
```

If you used `generate-replay-config`, the config is already saved at `<output-dir>/replay-config.json` — add the `readFunctions`, `privateReadFunctions`, and `historyReadFunctions` fields for verification.

All three are keyed the same way as `keyMapping`: source channel, then a chaincode on that channel. `readFunctions` names a destination function that reads public state by key, `privateReadFunctions` one that reads private state by `(collection, key)`, and `historyReadFunctions` one that returns key history as a JSON array of `[{"value": "...", "isDelete": false}]`. The migration contract provides all three — see [migration-overview.md](migration-overview.md#migration-contract-setup) for setup instructions.

`isDelete` is compared, not just read past. A tombstone and a write of the empty value hold the same value, so a history function that omits the flag reports every deleted key as `history[n]: expected <delete>, got <empty>` — verify has no way to tell a destination that did not delete from a function that does not say so.

Each name carries its contract. That is not optional: an unqualified name resolves to the migration contract, whose results are base64-decoded, so pointing verify at your own application's read function needs `SampleAssets:ReadAsset` form. Getting it wrong produces an error naming the fix, not a mismatch report.

### 6.2 Run verification

```bash
amb-migrate verify \
  --input-dir ./extraction-output \
  --config replay-config.json
```

For each key in `public-state.ndjson` and `private-*-state.ndjson`, the verify command calls `evaluateTransaction` on the destination and compares values with JSON normalization (handles key-ordering differences).

**`--concurrency` (default 16) is how many destination queries are in flight.** Every compared key — and every key's history at Tier 3 — costs at least one round trip, so one at a time makes the destination's network latency the whole cost of the run: in the live multi-member test 12,060 entries took 100 s across AZs and 656 s with 50 ms added RTT. Entries are reported in source order whatever the setting, and the summary is identical. The same flag applies to PostgreSQL and DynamoDB destinations. Raise it for a remote destination; lower it if the destination's peers or database push back.

**`--redact-values` keeps ledger values out of the output.** A mismatch detail normally quotes up to 80 characters of the expected and actual values — private ones included. With this flag each is shown as a SHA-256 prefix and length instead; keys, statuses and counts are unchanged. Use it whenever the output is forwarded anywhere.

**A private value this identity cannot read is compared by hash instead.** Verify
connects one identity, and a merged multi-member extraction holds collections it
is not a member of — either the gateway peer's org is not in the collection
policy, so the value reads as absent, or `memberOnlyRead` refuses the client
outright. A private-data hash is public channel data, so `ReadPrivateDataHash`
answers where `ReadPrivateData` cannot: a hash equal to the SHA-256 of the
extracted value is reported as a match whose detail says the value was unreadable
and by which MSP, and a difference as a mismatch carrying both hashes. This
happens only for a `privateReadFunctions` entry naming the migration contract,
whose own function it is. Without it every key of every unreadable collection was
reported missing — over data that is present and correct.

**Every chaincode on every channel must have a read function mapped.** If one
does not, verify refuses to run — before connecting to the destination — and
names each missing `channel/chaincode` pair. An unmapped deployment's records
would otherwise be skipped and verify would report success for data it never
checked. Either add the missing entries or narrow the run with `--channels`. A
chaincode deployed on two channels needs an entry under each: mapping it once
leaves the other channel unverified. `privateReadFunctions` is required only for
deployments whose private state was actually extracted; `historyReadFunctions`
only if you set it at all.

`--channels` naming a channel that is not in the manifest is an error, not an
empty run.

Records that were not checked are reported in a **Skipped (not verified)**
section, broken down by reason with the affected chaincodes named:

| Reason | Meaning |
|---|---|
| `composite-key` | Key contains `\0`. A destination read function takes one key argument, so composite keys cannot be queried individually. Confirm your destination chaincode rebuilds its own indexes |
| `no-read-function` | No `readFunctions` entry for this channel and namespace. Namespaces absent from the manifest (`lscc`, `_lifecycle`) appear in reconstructed state; map them if they hold application data |
| `no-private-read-function` | Private state was replayed but not verified |
| `no-history-read-function` | Replayed history was not verified |
| `no-key-listing` | This chaincode namespace was not swept for extra keys, because its `readFunctions` entry names your own contract rather than the migration contract. See §6.3 |
| `no-private-history-api` | A collection's replayed private history cannot be read back. Fabric exposes no private-data history API, so no destination contract can answer for it and no config setting changes it — the current values of those keys were verified, the versions behind them were not. One skip per `(chaincode, collection)` |

### 6.3 Keys the destination holds and the extraction does not

The checks above are one-directional: they ask whether every extracted key
arrived, not whether anything else is there. All three adapters also sweep the
other way and report every public key at the destination that no extracted
record accounts for:

```
  [EXTRA] leftover-asset (sample_assets)

  312 match, 0 mismatch, 0 missing, 0 error, 1 extra
```

An extra key means one of three things: the destination was not empty before
replay, a source delete was replayed as a write (see `deleteMapping`), or a
mapped write function stored the value under a different key. All three exit 1 —
the destination holds data the source ledger did not.

Private state is **not** swept. One member's extraction is not the whole
collection set: in a multi-member migration each member replays the collections
it can read into the same destination, so a collection absent from this
extraction can still belong there, and sweeping it would report another member's
data as junk.

**What each adapter can see differs.** The two databases are asked for a whole
channel's public rows — one query, one filtered `Scan` — so a key under a
chaincode the extraction never named is found. A **chaincode** destination can
only be range-queried one namespace at a time, through the migration contract's
`ListKeys`, so it is asked once per chaincode the manifest names. A namespace
outside the manifest is not swept there, and nothing can tell verify it exists.

A chaincode namespace is swept only when its `readFunctions` entry names the
migration contract — the one thing in the config that says `ListKeys` is
deployed. Point it at your own contract instead and the namespace is reported
`no-key-listing` in the skip section rather than swept; `ListKeys` has no
configurable stand-in, because a paginated range query over a whole namespace is
not a shape an application read function has.

Composite keys are swept by the databases even though they are not compared:
replay wrote them, so they are at the destination, and leaving them out of the
source set would report every one as extra. `ListKeys` does not return them —
they begin with U+0000 and Fabric starts an unbounded range query after it — so a
Fabric destination's own indexes are outside the sweep in both directions.

A sweep that cannot run — a dropped connection, a denied `Scan`, a destination
without the migration contract — is one `ERROR` entry naming the channel (and for
a chaincode destination the namespace, `ch1/mycc`), not a lost run. The forward
results still print. The summary line names extras only when a sweep found some —
there is no printed `0 extra` to be mistaken for a namespace nobody swept.

### 6.4 Reading the verify outcome

The table writes control characters as escapes, so `grep` reads it as text: the
U+0000 separators in a composite key print as `\0`, any other as `\xNN`. A key
that itself contains a backslash reads the same as an escape there, so take exact
keys from `--output json`.

Add `--output json` for structured output suitable for CI pipelines. It is
NDJSON: one JSON object per line, one line per entry, and a last line
`{"summary": {...}}`. One object per line rather than one document over the run,
because a verify pass produces an entry per source key and a document that has to
be closed cannot be written as it goes — the summary is the line that closes it.
Skips are entries with `"status": "skip"` and are counted in
`summary.skipsByReason`, with the affected namespaces in `summary.skipTargets`;
extra keys are entries with `"status": "extra"`, counted in `summary.extra`.

Read it a line at a time — `jq -c 'select(.status == "mismatch")'` for the
findings, `tail -1 | jq .summary` for the counts.

| Exit code | Meaning |
|---|---|
| 0 | Every checked record matched |
| 1 | Mismatches, missing keys, or extra destination keys |
| 2 | Query errors, **or nothing was checked at all** |

Exit 2 on zero checked records is deliberate: `0 match, 0 mismatch, 0 missing,
0 error` with nothing swept means the run proved nothing, which is not a pass. A
run whose only finding is extra keys did check something and exits 1.

### 6.5 Verifying more than one channel

One `verify` run covers every channel in the manifest. `--channels` narrows it to a
subset, and a name that is not in the manifest is an error rather than an empty
run — so a typo cannot pass as a channel with nothing to check.

**Three refusals happen before the destination is connected to**, and all three
exist because a channel `verify` silently left out would read as a channel it
verified:

- A chaincode on an in-scope channel with no `readFunctions` entry, named as
  `channel/chaincode`.
- An in-scope channel with no `channelMapping` entry. Chaincode destinations only:
  the two databases store their rows under the **source** channel name, so
  multi-channel verification there needs no mapping at all.
- `--channels` naming a channel the manifest does not have.

Either widen the config or narrow the run — the messages say both. This is the
asymmetry that makes the pair worth running at eight channels: **`replay` skips a
source channel missing from `channelMapping` and still exits 0, while `verify`
refuses the same config.** A replay whose summary carried a `Channels skipped` line
is a replay whose config `verify` will not accept.

**The summary is network-wide, not per channel.** `match`, `mismatch`, `missing`,
`error`, `extra` and the skip breakdown are totals over every channel in the run,
so a single run answers "did the migration land" and not "which channel is short".
Two ways to get the per-channel answer:

```bash
# One run, entries tagged with their channel
amb-migrate verify --input-dir ./extraction-output \
  --config replay-config.json --output json > verify.ndjson
jq -r 'select(.status == "mismatch" or .status == "missing") | .channel' verify.ndjson | sort | uniq -c

# Or one run per channel, each with its own exit code to gate on
for ch in ch1 ch2 ch3; do
  amb-migrate verify --input-dir ./extraction-output \
    --config replay-config.json --channels "$ch" || echo "FAILED: $ch"
done
```

Per-channel runs cost one destination connection each and re-read the manifest each
time; they buy an exit code per channel, which is what a pipeline that gates
cutover channel by channel needs. Within a single run, remember that 1 outranks
2 — a run holding both a mismatch on one channel and query errors on another exits
1, and the errors are only visible in the output.

Two things that do not change with the channel count: **`verify` connects one
identity for the whole run**, so private collections that identity cannot read are
compared by hash on every channel alike (§6.2), and its heap holds one channel at a
time — the widest channel's public key set is what sizes the run
([tuning](tuning.md#what-else-lives-in-the-heap)).

---

## Testing with the interactive wizard

The `migrate` command runs all phases in a single interactive session. It is
useful for testing connectivity and validating the end-to-end pipeline on a
small network, but is not recommended for production migrations. For production,
run each phase independently with review between steps.

```bash
amb-migrate migrate --output-dir ./extraction-output
```

To skip the replay prompts and use an existing config:

```bash
amb-migrate migrate --config sample/destination-config/replay-config-postgresql.example.json
```

---

## Quick Reference

### Full automated test (one command)

With `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the environment (see 1.3):

```bash
bash sample/scripts/run-full-test.sh \
  --network-name "your-network-name"
```

### Re-run extraction only (skip bootstrap)

```bash
bash sample/scripts/run-full-test.sh \
  --network-name "your-network-name" \
  --skip-bootstrap --skip-populate
```

`--skip-bootstrap` alone skips only steps 1–4 — tool install, enrolment, channel
creation, anchor peers. Steps 5–7 still run, and step 7 submits every sample
transaction again, so both ledgers grow. Pass `--skip-populate` as well to
extract the ledger as it stands; without it the script refuses to extract into
the `test-output/tier*/` directories the previous run wrote, because appending a
taller ledger's blocks to them would merge two heights into one snapshot.

### Manual step-by-step

```bash
# Setup (once)
source sample/scripts/resolve-network.sh --network-name "my-network"   # ADMIN_USERNAME, ADMIN_PASSWORD from the environment (see 1.3)
bash sample/scripts/setup-cloudshell.sh
bash sample/scripts/enroll-admin.sh

# Network (once)
bash sample/scripts/create-channel.sh
bash sample/scripts/configure-anchor-peer.sh
bash sample/scripts/vendor-deps.sh
bash sample/scripts/deploy-chaincode.sh
bash sample/scripts/populate-data.sh

# Extract (see "Running a command twice" below before repeating these)
amb-migrate discover --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --bootstrap-channel $CHANNEL_NAME --output-dir ./extraction-output
amb-migrate extract --manifest ./extraction-output/manifest.json --tier 3 --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --output-dir ./extraction-output
amb-migrate validate --input-dir ./extraction-output

# Plan and replay
amb-migrate generate-replay-config --input-dir ./extraction-output
# Review and edit replay-config.json, then:
amb-migrate replay --input-dir ./extraction-output --adapter <adapter> --config ./extraction-output/replay-config.json
```

### Running a command twice

Only some of these commands are safe to repeat against the same directory, and
"checkpointed" does not mean "repeatable" — a checkpoint makes an *interrupted*
run resumable, which is a different property.

| Command | What a second run does |
|---|---|
| `discover` | Re-queries the network and overwrites `manifest.json`, `ledgerHeight` included. Harmless in itself; it is what makes a later `extract` walk blocks that were not there the first time |
| `extract` | Skips every channel it already committed and extracts the others again — per channel, not per block ([5.5](#55-resuming-an-interrupted-run)). Against the **same** `manifest.json` it reads nothing from the peer and leaves every file as it was ("Channel already extracted — skipping"). Against a manifest a later `discover` refreshed to a greater height it is refused: add `--extend` to continue to the new height, or extract into a new directory |
| `merge` | Refused. It checks that the output directory is empty first, because its NDJSON output appends too — the guard `extract` does not have |
| `validate` | Reads the extraction and writes nothing. Repeat freely |
| `generate-replay-config` | Overwrites `replay-config.json`, discarding the edits you made to it after the last run |
| `replay` | Depends on the adapter and on `replayHistory` — see [Re-running a replay](replay-config-reference.md#re-running-a-replay). A re-run after *success* is the case to check before you start it |
| `verify` | Reads the extraction and queries the destination. Writes nothing. Repeat freely |
| `status` | Reads the output directory. Writes nothing. Repeat freely |
| `migrate` | Every phase in one process, so it inherits both rows above: a fresh `discover` and then an `extract` into the same directory. On a source ledger still committing blocks, that is the appending case — quiesce first, or run the phases separately |

### Exit codes

Every command exits **0** on success and **1** on failure. `verify` is the only
one with a third code. A refusal prints the sentence saying what to change and
sets 1; output that is a stack trace instead is a bug in the tool rather than a
refusal.

`validate`, `replay` and `verify` are the three whose non-zero exit is a statement
about the *data* rather than about the command, which is what makes them the three
worth gating a pipeline on.

| Command | A non-zero exit means |
|---|---|
| `discover` | 1 — none of the `--channels` names could be verified on the peer, or `cscc.GetChannels` came back empty and neither `--bootstrap-channel` nor `--channels` was given |
| `extract` | 1 — an unrecognised `--tier`, `--strategy` or `--state-backend`, or a channel that failed mid-walk. Channels that finished are not walked again; see [5.5](#55-resuming-an-interrupted-run) for what the next run does with the checkpoint. A private-data delivery that failed is a **warning**, not this |
| `merge` | 1 — two members hold different values for one key, a collection is absent with nothing to explain it, or the output directory is not empty |
| `validate` | 1 — at least one check FAILed. A WARN never fails the run, the duplicate-key warning included |
| `generate-replay-config` | 1 — no `manifest.json` in `--input-dir` |
| `replay` | 1 — at least one record did not reach the destination, or the run refused before its first write. **0 does not mean every channel was replayed**: a source channel absent from `channelMapping` is skipped and the run still exits 0, so read the `Channels skipped` line |
| `verify` | 1 — mismatches, missing keys, or extra destination keys. 2 — `--config` does not exist, nothing was checked at all, or query errors were the only finding. 1 outranks 2, so a run holding both a mismatch and an error exits 1 |
| `status` | 1 — no `manifest.json` in `--output-dir` |
| `migrate` | 1 — the phase it stopped in failed. Every phase runs in one process, so which one is the last thing in the output |

`capture-fixtures` sets no code of its own: 0 if it finished, 1
if it refused.

### Environment variables

Seven variables the commands read, each a fallback for a flag or a default — so a
run that passes every flag needs none of them. `capture-fixtures` is the
exception: it has no credential flags at all, and these are the only way to give
it an identity.

| Variable | Read by | What it is |
|---|---|---|
| `MSP_PATH` | `discover`, `extract`, `capture-fixtures`, `migrate` | Fallback for `--msp-path`: the enrolled admin MSP directory, holding `signcerts/cert.pem` and one key under `keystore/`. Read twice over — as the signing identity, and as the client certificate for mutual TLS to the peer. A directory without that layout is not quietly ignored; loading the identity fails naming the path it looked in |
| `TLS_CA_CERT` | `discover`, `extract`, `capture-fixtures`, `migrate` | Fallback for `--tls-cert`, and second of four candidates: the flag, then this, then `~/managedblockchain-tls-chain.pem`, then `/tmp/managedblockchain-tls-chain.pem`. Downloading the cert into `$HOME` under that name, as [1.4](#14-install-fabric-tools-and-download-tls-certificate) does, is why most runs never set it |
| `CA_ENROLLMENT_SECRET` | `discover`, `extract`, `capture-fixtures`, `migrate` | The admin's CA password. There is no flag for it. Read only when there is no `--msp-path`, no `$MSP_PATH` and no cached identity at `./wallet/<member-id>/admin.json` — the tool then enrols `admin` against the member's CA rather than refusing. With an MSP directory it is never read |
| `LOG_LEVEL` | every command | pino's level, `info` by default. `debug` is where per-record and per-batch detail lives |
| `NODE_ENV` | every command | `production` or `test` turns `pino-pretty` off and prints one JSON object per line — what to set when capturing a long run's output to a file |
| `AWS_DEFAULT_REGION`, `AWS_REGION` | `migrate` | The region the wizard offers as its default, in that order, then `us-east-1`. Every other command takes `--region`, which defaults to `us-east-1` and reads neither |

AWS credentials themselves are not in this list: no command passes any to the AWS
SDK, so the SDK's own chain resolves them — `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`
and friends, or the instance role. See
[IAM permissions](iam-permissions.md) for what that identity has to be allowed to do.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `peer` command not found | Run `source ~/.bashrc` or `export PATH=~/fabric-tools/bin:$PATH` |
| TLS handshake failure | Ensure your EC2 instance is in a VPC/subnet with the AMB VPC endpoint, and the security group allows outbound on ports 30001-30004 |
| SSM `TargetNotConnected` | Ensure all 3 SSM VPC endpoints (`ssm`, `ssmmessages`, `ec2messages`) exist in the same VPC as the instance, the instance has an IAM profile with `AmazonSSMManagedInstanceCore`, and the endpoint security group allows inbound HTTPS (443) from the instance |
| Enrollment fails | Verify `ADMIN_USERNAME` and `ADMIN_PASSWORD` match what you set when creating the AMB member |
| Channel creation fails | Check the peer is AVAILABLE in the AMB console (`aws managedblockchain get-node ...`) |
| Chaincode install fails with "vendor/ not found" | Run `bash sample/scripts/vendor-deps.sh` (requires Go) |
| `UNIMPLEMENTED` during discovery | Expected — AMB Fabric 2.2 doesn't support the Gateway gRPC service. The default mode is already `legacy` (no probe). You would only see this if you explicitly set `--fabric-mode auto` or `--fabric-mode gateway`. |
| Private data returns empty | Your org may not be authorized for that collection. Check the collection policy in `collections_config.json`. Only collections your MSP is in the policy for will return values; others return hashes only. |
| `blockToLive` purge warning | Data in collections with `blockToLive > 0` is purged after that many blocks. Extract early. |
| `dnf install` fails on EC2 | Instance needs internet access (NAT gateway or public subnet) for package installation and npm install |
| Extraction aborts with "TRANSACTIONS_FILTER holds an unrecognised value" | The block's validation-code array could not be read, so committed and failed transactions cannot be told apart. Extraction refuses rather than replaying writes that never committed. Re-run `discover` to confirm the Fabric version, then `capture-fixtures` on that block for diagnosis |
| Extraction aborts with "TRANSACTIONS_FILTER holds N code(s)" | The filter is shorter than the block's transaction list — the same problem for the transactions it does not cover. Same steps as above |
