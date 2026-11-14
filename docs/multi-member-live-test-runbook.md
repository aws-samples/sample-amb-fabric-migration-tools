# Multi-Member Live Test Runbook

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

How to rebuild the three-member AMB live test, measure a migration end to end,
and repeat the destination experiments (separate hardware, orderer block time,
added network latency). Measured results are summarized in
[Tuning](tuning.md).
The single-member procedure, including credential options and the IAM policy
in full, is [live-test-runbook.md](live-test-runbook.md); this page covers what
is different with several members and a remote destination.

Everything here creates billable AWS resources. Check the AMB and EC2 pricing
pages before starting, and tear down with §8 when finished.

## 1. Shape of the test

| Piece | What it is | Where |
|---|---|---|
| Source | AMB Fabric 2.2 network, Standard edition, N members (three in this example), one `bc.t3.medium` CouchDB peer each, each in its own AZ | AMB, us-east-1 |
| Replay host | EC2 `t3.xlarge`, same VPC as an AMB interface endpoint with private DNS. Runs every member's extraction, the merge, replay and verify | AZ a |
| Destination host | EC2 `c6i.2xlarge` running a generated Fabric 2.5.11 network: one Raft orderer, one peer and CouchDB per source member, any number of members | AZ b |
| Harness | `sample/scripts/multi-member/` | both hosts |
| Load chaincode | `sample/chaincode/consortium_ledger/` (plus `sample_assets`, `trade_registry`) | source and destination |

The harness has also run with five members (the Standard edition maximum) in eu-west-1: `bc.m5.large` peers, two on
LevelDB and three on CouchDB, a fifth member added to a channel after it had data (`channel.sh` again, the update
signed by a majority, `deploy.sh` at the next sequence with an added collection), per-member extraction, a five-way
merge (no `unexplained` or `indeterminate` row), and replay to PostgreSQL with `verify` clean.

Channels and members come from `populate-plan.json`: `channel-a` (all three
members), `channel-b` (first two), `channel-c` (first and third). Collection
templates name orgs by position (`Org1MSP`, `Org2MSP`, `Org3MSP`, `ALL_ORGS`)
and are rendered per channel at deploy time.

## 2. AMB members and peers

Run from an operator workstation with the network owner's credentials.

1. **Invite the extra members.** One proposal inviting the account once per new
   member, voted YES by the existing member. With one existing member a single
   vote passes it; add members in one proposal, because each later proposal
   needs a majority of all existing members.

   ```bash
   aws managedblockchain create-proposal --network-id $NID --member-id $M1 \
     --actions '{"Invitations":[{"Principal":"'$ACCT'"},{"Principal":"'$ACCT'"}]}'
   aws managedblockchain vote-on-proposal --network-id $NID --proposal-id $PID \
     --voter-member-id $M1 --vote YES
   ```

2. **Create each member** from its invitation, with an admin password that is
   generated and stored straight into Secrets Manager at
   `amb-migration-live-test/<MemberName>/admin` as
   `{"username":"admin","password":"..."}`. Never print it. Members take
   ~10 minutes to become `AVAILABLE`.
3. **Create one peer per member**, `bc.t3.medium`, `StateDB: CouchDB`, each in a
   different AZ. ~7 minutes each, in parallel.

A Standard network takes at most five members. Growing an existing test
network: invite in one proposal (a majority of the current members votes),
then `init.sh`, `enroll.sh`, `channel.sh <channel> <all members>` to add the new
members to an existing channel, and `deploy.sh` at the next sequence so each
collection template re-renders for the larger membership. A freshly joined
peer refuses its own org's proposals until it has replayed the channel up to
the config block that added it; `deploy.sh` retries the approval for that.

Each member's CA and peer listen on a different port (30002, 30003, … and
30005, 30007, …). The harness reads endpoints from the AMB API; the security
group has to admit the whole range — §3 uses 30001–30020.

## 3. Hosts and network

1. **Security group for the replay host and endpoint:** self-referencing TCP
   30001–30020.
2. **AMB interface endpoint** for the network's `VpcEndpointServiceName`, private
   DNS on, in the replay host's subnet, with that group.
3. **IAM role** for the hosts: `AmazonSSMManagedInstanceCore`, read on the AMB
   network/members/nodes, `s3:GetObject` on the regional TLS chain, read/write on
   a transfer bucket, and `secretsmanager:GetSecretValue` on the members' admin
   secrets. The destination host does not need the secrets; give it a separate
   role for anything longer-lived than a test.
4. **Replay host:** `t3.xlarge`, 60 GiB gp3, public subnet for SSM and package
   downloads, no inbound SSH.
5. **Destination host:** `c6i.2xlarge`, 60 GiB gp3, in a **different AZ**, with a
   security group admitting, from the replay host's group only, TCP 7050 (orderer)
   through `7051 + 2000·(N−1)` (the last org's peer) — 7050–11051 for three
   members, 7050–15051 for five. The orderer admin port, 7053, listens on
   loopback only.

Bootstrap both with Docker, the Compose plugin, Go and jq; the replay host also
needs Node 22 and the Fabric 2.2.15 binaries plus fabric-ca-client 1.5.x under
`~/fabric-2.2/bin`, and the TLS chain at `~/managedblockchain-tls-chain.pem`.
Transfer the repository with a tarball through the bucket (exclude `.git`,
`node_modules`, `dist`, MSPs, wallets and extraction output), then on each host:

```bash
npm ci && npm run build                     # replay host only
GOFLAGS=-mod=mod bash sample/scripts/vendor-deps.sh
```

## 4. Build the source network

On the replay host, from `sample/scripts/multi-member/`:

```bash
./init.sh --network-name <NETWORK_NAME>     # members, peers, endpoints from the AMB API → ~/mm
MM_SECRET_PREFIX=amb-migration-live-test ./enroll.sh

./channel.sh channel-a MemberA MemberB MemberC
./channel.sh channel-b MemberA MemberB
./channel.sh channel-c MemberA MemberC

./deploy.sh channel-a consortium_ledger 1 MemberA MemberB MemberC
./deploy.sh channel-b consortium_ledger 1 MemberA MemberB
./deploy.sh channel-c consortium_ledger 1 MemberA MemberC
./deploy.sh channel-a sample_assets     1 MemberA MemberB MemberC
./deploy.sh channel-b trade_registry    1 MemberA MemberB
./deploy.sh channel-c trade_registry    1 MemberA MemberC
```

`channel.sh` creates each channel as its first member and adds the others by
signed config updates: AMB does not accept a channel creation transaction naming more
than one member. Every script is idempotent.

Then load it (~55 minutes for the default plan, ~1,370 blocks per channel):

```bash
cd ~/repo
node sample/scripts/multi-member/load-generator.js \
  --plan sample/scripts/multi-member/populate-plan.json --concurrency 24
```

It must end with `broadcastFailed: 0`. Depth in blocks is set by how long the
load runs (AMB cuts a block every 2 s), so scale `rounds` and `roundPauseMs` in
the plan for a deeper ledger, and `keys` / `privateKeys` for a wider one.

## 5. Extract, validate, merge

Quiesce first — no submits until every member has extracted, so all agree on
one height. Each member extracts from its **own** peer with its own MSP:

```bash
mm_use MemberB                               # from lib.sh: loads one member
export NODE_OPTIONS=--max-old-space-size=3072
amb-migrate discover --network-id $NETWORK_ID --member-id $MEMBER_ID \
  --node-id $NODE_ID --region $REGION --msp-path $MSP_PATH --channels channel-a channel-b \
  --output-dir ~/mm/out/MemberB
amb-migrate extract --manifest ~/mm/out/MemberB/manifest.json --tier 3 \
  --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION \
  --msp-path $MSP_PATH --output-dir ~/mm/out/MemberB --concurrency 3 --memory-limit 1400
amb-migrate validate --input-dir ~/mm/out/MemberB
```

Name only the channels the member is on.

**Lead-run variant (member kits).** Only the lead extracts in full; every other
member sends a kit of its private data. The lead announces the heights it read
after quiescing, and each member runs, against its own peer:

```bash
./member-kit.sh --member MemberD --heights channel-a=1497,channel-d=111 --out-dir ~/kit
# → ~/kit/MemberD-kit.tgz + .sha256; refuses if the member's peer is at another height
```

The kit contains plaintext private data. Send both files through the consortium's
encrypted, authenticated private-data channel. The checksum detects corruption;
it does not authenticate the sender or protect the contents.

The lead checks each `.sha256`, unpacks the kits and merges them with its own
full extraction exactly as below. Pass criteria are the same; in addition,
merging two or more kits without a full extraction is refused (`No full extraction of …`; a single directory is
refused earlier, because a merge needs at least two) and replaying a kit directly is refused
(`… extracted with --private-only`).

Then merge **in one pass**:

```bash
amb-migrate merge --input-dirs ~/mm/out/MemberA ~/mm/out/MemberB ~/mm/out/MemberC \
  --output-dir ~/mm/out/merged
amb-migrate validate --input-dir ~/mm/out/merged
amb-migrate status --output-dir ~/mm/out/merged   # deepest key per history file
```

Pass criteria: every `validate` 0 failed; merge exit 0 with no `unexplained` or
`indeterminate` coverage row. One exception: a member whose peer joined a channel after it had data fails `validate`
on its own for the private values written before it joined ("no value and no explanation", "missing from private
history"). That is expected ([migration guide](migration-guide.md), merge step); the merged directory must still
validate with 0 failed.

**Optional checks:**

- *Kill and resume.* Start an extraction into a fresh directory, `kill -9` the
  **node** process (not a wrapper shell) mid-walk, rerun the same command, and
  `cmp` every `.ndjson` against an uninterrupted run. Pass: all identical.
- *Staged merge.* Merge two members, then merge that output with the third.
  Pass: the second merge is refused.

## 6. Build the destination

On the destination host, with `~/mm/network.env`, `members.list` and
`members/` copied from the replay host (they hold IDs and endpoints only):

```bash
cd ~/repo/sample/scripts/multi-member
MM_DEST_HOST=<destination private IP> MM_BATCH_TIMEOUT=200ms \
  ./destination.sh --plan populate-plan.json --input-dir ~/mm/out/merged
```

~2½ minutes for three orgs, ~4 for five. Every run tears down the previous
destination and builds an empty one: a Tier 3 history replay is one-shot, so
rebuild before every replay. It

- issues one peer org per source member with `cryptogen` (`Org1MSP`… in
  `members.list` order) and one orderer org;
- writes a `configtx.yaml` with one profile per plan channel naming exactly that
  channel's members and their anchor peers, and creates each channel through the
  orderer's channel participation API (no system channel), so a channel's
  membership is its genesis block;
- starts one Compose project, `mm-dest`: the orderer on 7050, and per org a peer
  on `7051 + 2000·(N−1)` with its own CouchDB, which is not published. The
  orderer and peers are published on `MM_DEST_HOST` only (`127.0.0.1` when it is
  unset), never on every interface, and each network gets a fresh CouchDB
  password passed through the environment. The password is not stored, so
  restart the destination by running `destination.sh` again, not one service
  with `docker compose up`;
- commits every chaincode under its source name with the migration contract's
  writer list rendered, and every collection with `blockToLive: 0` (set
  `MM_KEEP_BLOCK_TO_LIVE=1` to reproduce destination purging);
- writes `~/mm/destination/replay-config.json` with `mspMapping`,
  `orgIdentities`, `channelConcurrency` = number of channels, `concurrency` 32
  and `batchSize` 20000.

Everything it generates — crypto, channel blocks, Compose file, connection
profiles, replay config — is under `~/mm/destination/`. Measured on the
`c6i.2xlarge`, five orgs with their chaincode containers used 1.7 GiB in
total; memory is not what limits N on this instance size. The port layout
allows up to 29 orgs.

| Variable | Default | Effect |
|---|---|---|
| `MM_DEST_HOST` | `localhost` | Host address used by replay and by the destination's local peer CLI. The orderer and peer ports are published only on this address; TLS is checked against each node's own hostname |
| `MM_BATCH_TIMEOUT` | `2s` | Orderer `BatchTimeout` for every channel |
| `MM_MAX_MESSAGE_COUNT` | `10` | Orderer `MaxMessageCount` |
| `MM_FABRIC_HOME` | `~/fabric-2.5` | Fabric 2.5 binaries and `config/`; installed there if absent |
| `MM_ENDORSEMENT` | `or` | Chaincode endorsement policy over each channel's members: `or`, `majority` (`OutOf(n/2+1)`) or `and`. Under `majority`/`and` each explicit collection also gets its own `endorsementPolicy` of that kind over its members |
| `MM_NO_COLLECTION_ENDORSEMENT` | — | `1` omits the collection-level policies, to reproduce the refusal the [endorsement pre-flight](replay-config-reference.md#destination-endorsement-pre-flight) reports |

A host that ran an earlier fabric-samples test-network has to stop it first
(`~/fabric-samples/test-network/network.sh down`): the script refuses to start
while another container holds port 7050.

**Check it before replaying.** `destination-check.sh` has every member org, on
every channel, write a public key and a key in the first collection naming all
of that channel's members, endorsed by its own peer alone, and then every
member org read every other org's keys from its own peer. It also checks that
each peer is on exactly its plan channels. It writes `mm-check-*` keys, which
`verify` would report as `[EXTRA]` — so run it, then rebuild:

```bash
./destination-check.sh --plan populate-plan.json   # ~1 minute; exit 0 = every org works
./destination.sh --plan populate-plan.json --input-dir …
```

To try a member count the AMB network does not have, a synthetic `MM_HOME`
works: `members.list` plus one `members/<name>.env` per member carrying
`MEMBER_NAME`, `MEMBER_ID`, `NODE_ID`, `PEER_ENDPOINT` and `CA_ENDPOINT`
(only `MEMBER_ID` is used; the rest can be placeholders), and a plan naming
those members.

Ship the destination directory to the replay host, leaving out the chaincode
packages:

```bash
cd ~/mm && tar -czf /tmp/dest.tgz --exclude destination/build destination
```

On the replay host, unpack it under `~/remote/` and rewrite the one path prefix
in its JSON files:

```bash
mkdir -p ~/remote && tar -xzf dest.tgz -C ~/remote
sed -i "s|$HOME/mm/destination|$HOME/remote/destination|g" ~/remote/destination/*.json
```

These are throwaway `cryptogen` keys; do not reuse this transfer for real
credentials.

## 7. Replay and verify

```bash
rm -f ~/mm/out/merged/replay-checkpoint-*.json
export NODE_OPTIONS=--max-old-space-size=8192
time amb-migrate replay --input-dir ~/mm/out/merged --adapter chaincode \
  --config ~/remote/destination/replay-config.json
time amb-migrate verify --input-dir ~/mm/out/merged \
  --config ~/remote/destination/replay-config.json --concurrency 16
```

Pass: `Records failed: 0`, verify exit 0 with 0 mismatch, missing, error and
extra. Per-file completion times are in the replay log's `File replay complete`
lines.

**Added latency.** To model a destination at another site, delay only the
replay host's traffic to the destination, then remove it:

```bash
sudo dnf install -y iproute-tc
sudo tc qdisc add dev ens5 root handle 1: prio
sudo tc qdisc add dev ens5 parent 1:3 handle 30: netem delay 50ms
sudo tc filter add dev ens5 protocol ip parent 1:0 prio 3 u32 \
  match ip dst <destination IP>/32 flowid 1:3
# … replay / verify …
sudo tc qdisc del dev ens5 root
```

Confirm it took effect with a TCP connect timing to a peer port
(`bash -c "</dev/tcp/<ip>/7051"` under `date +%s%N`).

## 8. Teardown

In this order; deleting AMB members and nodes is irreversible.

1. Destination and replay hosts: `aws ec2 terminate-instances`.
2. AMB interface endpoint, then both security groups.
3. IAM: remove the role from the instance profile, delete the profile, the
   inline policy, the managed-policy attachment, then the role.
4. Transfer bucket: empty, then delete.
5. AMB peers (`delete-node`) and the invited members (`delete-member`), if the
   network is not being kept for another run. The founding member and the
   network are the owner's to remove.
6. The members' admin secrets in Secrets Manager, once the members are gone.
