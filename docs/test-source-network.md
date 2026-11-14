# Build a test source network on Amazon Managed Blockchain

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

How to build a multi-member AMB Hyperledger Fabric network of your own to test the toolkit against. Extraction reads
from AMB peers through the AMB API, so a realistic test needs a real AMB network. Build a new one rather than reuse
someone else's: a ledger you designed and loaded yourself, with your own chaincode and data, tests cases the toolkit's
authors have not already seen.

Use a test account only. Everything here is synthetic.

## What you build

| Piece | Choice |
|---|---|
| Network | AMB Hyperledger Fabric 2.2, Standard edition, voting threshold 50% |
| Members | Three (`MemberA`, `MemberB`, `MemberC`); a Standard network takes up to five |
| Peers | One per member, each in its own Availability Zone. Use a non-burstable type (`bc.m5.large` or larger): burstable peers run out of CPU credit under sustained load and fall behind the orderer, and extraction then waits for them. Give one member LevelDB and the others CouchDB |
| Access | One AMB interface endpoint in your VPC, and one host in the same VPC with SSM access and no inbound rules |
| Admin passwords | Generated into AWS Secrets Manager, one secret per member, never printed |

Pricing: [Amazon Managed Blockchain pricing](https://aws.amazon.com/managed-blockchain/pricing/hyperledger/) (per
member hour, per peer hour, storage). Building takes about an hour of mostly waiting.

## 0. Variables

```bash
export AWS_REGION=us-east-1
export NET=amb-review-test                      # network name, also the secrets prefix
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export PEER_TYPE=bc.m5.large
export ZONES=(us-east-1a us-east-1b us-east-1c) # one per member
```

## 1. Admin passwords

AMB requires 8-32 characters with an upper-case letter, a lower-case letter and a digit, and none of `' " \ / @` or
space. Generate each straight into a file readable only by you, and hand Secrets Manager the file, so the password
never appears in a command line (`ps` shows other users every argument):

```bash
old_umask=$(umask); umask 077
for m in MemberA MemberB MemberC; do
  python3 -c "import json,secrets,string;a=string.ascii_letters+string.digits
while True:
  p=''.join(secrets.choice(a) for _ in range(24))
  if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p): break
print(json.dumps({'username':'admin','password':p}))" > /tmp/admin-secret.json
  aws secretsmanager create-secret --name "$NET/$m/admin" \
    --secret-string file:///tmp/admin-secret.json --query Name --output text
  rm -f /tmp/admin-secret.json
done
umask "$old_umask"
```

## 2. Network and first member

The first member is created with the network. Its password goes in an input file readable only by you, deleted after:

```bash
umask 077
python3 - <<'P' > /tmp/create-network.json
import json, os, subprocess
pw = json.loads(subprocess.check_output(['aws','secretsmanager','get-secret-value','--secret-id',f"{os.environ['NET']}/MemberA/admin",'--query','SecretString','--output','text']))['password']
print(json.dumps({
  'Name': os.environ['NET'], 'Framework': 'HYPERLEDGER_FABRIC', 'FrameworkVersion': '2.2',
  'FrameworkConfiguration': {'Fabric': {'Edition': 'STANDARD'}},
  'VotingPolicy': {'ApprovalThresholdPolicy': {'ThresholdPercentage': 50, 'ProposalDurationInHours': 24, 'ThresholdComparator': 'GREATER_THAN'}},
  'MemberConfiguration': {'Name': 'MemberA', 'FrameworkConfiguration': {'Fabric': {'AdminUsername': 'admin', 'AdminPassword': pw}}}}))
P
read NID M_A < <(aws managedblockchain create-network --cli-input-json file:///tmp/create-network.json \
  --query '[NetworkId,MemberId]' --output text)
rm -f /tmp/create-network.json; umask 022
echo "network $NID, first member $M_A"
```

Wait for both to be `AVAILABLE` (about 30 minutes):

```bash
until [ "$(aws managedblockchain get-network --network-id $NID --query Network.Status --output text)" = AVAILABLE ]; do sleep 60; done
until [ "$(aws managedblockchain get-member --network-id $NID --member-id $M_A --query Member.Status --output text)" = AVAILABLE ]; do sleep 30; done
```

## 3. More members

Invite the account once per extra member, in **one** proposal (with one member, its YES passes it; later proposals
need a majority of all members):

```bash
PID=$(aws managedblockchain create-proposal --network-id $NID --member-id $M_A \
  --actions "{\"Invitations\":[{\"Principal\":\"$ACCOUNT\"},{\"Principal\":\"$ACCOUNT\"}]}" --query ProposalId --output text)
aws managedblockchain vote-on-proposal --network-id $NID --proposal-id $PID --voter-member-id $M_A --vote YES
sleep 30
aws managedblockchain list-invitations --query "Invitations[?NetworkSummary.Id=='$NID' && Status=='PENDING'].InvitationId" --output text
```

Create one member per invitation ID, the same way as the first (password from its secret, input file mode 0600,
deleted after):

```bash
set -- $(aws managedblockchain list-invitations --query "Invitations[?NetworkSummary.Id=='$NID' && Status=='PENDING'].InvitationId" --output text)
for m in MemberB MemberC; do inv=$1; shift; umask 077
  python3 - "$m" <<'P' > /tmp/create-member.json
import json, os, subprocess, sys
pw = json.loads(subprocess.check_output(['aws','secretsmanager','get-secret-value','--secret-id',f"{os.environ['NET']}/{sys.argv[1]}/admin",'--query','SecretString','--output','text']))['password']
print(json.dumps({'MemberConfiguration': {'Name': sys.argv[1], 'FrameworkConfiguration': {'Fabric': {'AdminUsername': 'admin', 'AdminPassword': pw}}}}))
P
  aws managedblockchain create-member --network-id $NID --invitation-id $inv \
    --cli-input-json file:///tmp/create-member.json --query MemberId --output text
  rm -f /tmp/create-member.json; umask 022
done
```

Wait until every member is `AVAILABLE` (about 10 minutes each, in parallel):

```bash
aws managedblockchain list-members --network-id $NID --query 'Members[].[Name,Id,Status]' --output table
```

## 4. Peers

One per member, in different zones; one with LevelDB:

```bash
i=0
for row in $(aws managedblockchain list-members --network-id $NID --query 'Members[].[Name,Id]' --output text | tr '\t' ':'); do
  name=${row%%:*}; id=${row##*:}; db=CouchDB; [ $name = MemberC ] && db=LevelDB
  aws managedblockchain create-node --network-id $NID --member-id $id \
    --node-configuration "{\"InstanceType\":\"$PEER_TYPE\",\"AvailabilityZone\":\"${ZONES[$i]}\",\"StateDB\":\"$db\"}" \
    --query NodeId --output text
  i=$((i+1))
done
```

About 10 minutes. Check with `aws managedblockchain list-nodes --network-id $NID --member-id <id>`.

## 5. Endpoint and host

Follow the [live-test infrastructure runbook](live-test-runbook.md), sections 2 to 6, with this network's ID: it
creates the interface endpoint for the network's `VpcEndpointServiceName` (private DNS on), the security groups
(the endpoint admits TCP 30001-30020 from the host's group; members' CAs and peers use different ports in that range),
a least-privilege IAM role and the host. Give the role `secretsmanager:GetSecretValue` on `$NET/*` and read access to
this network, its members and nodes. To reuse an existing host, add an inline policy to its role with
`managedblockchain:GetNetwork`, `ListMembers`, `ListNodes` on `arn:aws:managedblockchain:<region>::networks/<id>`,
`GetMember` and `GetNode` on the account's members and nodes, `ListNetworks` on `*` (it has no resource type, and
`init.sh` uses it to find the network by name), and `secretsmanager:GetSecretValue` on `$NET/*`. The complete policy
is in [IAM permissions](iam-permissions.md).

## 6. Hand off to the harness

On the host, from `sample/scripts/multi-member/` (Fabric 2.2 client binaries on `PATH`, see the
[multi-member runbook](multi-member-live-test-runbook.md), section 3):

```bash
./init.sh --network-name $NET                  # writes ~/mm: network.env, members.list, members/*.env
MM_SECRET_PREFIX=$NET ./enroll.sh              # each member's admin MSP, from its secret
```

Then create channels and deploy chaincode, as below. If the first `channel.sh` fails on `peer channel create` right
after the endpoint was created, wait a few minutes for its DNS and re-run it: the harness scripts are idempotent.

## 7. Your chaincode and your data

Design the ledger to differ from the toolkit's own test data. The toolkit's samples are under `sample/chaincode/`;
writing your own is the better test.

**Channels.** For example one channel with all three members and one with two:

```bash
./channel.sh shared MemberA MemberB MemberC
./channel.sh pair   MemberA MemberC
```

**Chaincode.** `deploy.sh` packages a chaincode directory, installs it on every member's peer,
has each member approve it, and commits it:

```bash
MM_CC_PATH=/path/to/your/chaincode ./deploy.sh shared yourcc 1 MemberA MemberB MemberC
```

- Go chaincode needs its dependencies vendored (`go mod vendor`) because AMB peers build it without network access.
  **AMB 2.2 builds Go chaincode with an old Go toolchain**, so current module versions fail to build on the peer
  (`//go:build comment without // +build comment`). Pin what the bundled samples pin, `go 1.14` and
  `github.com/hyperledger/fabric-contract-api-go v1.1.1` (copy `sample/chaincode/trade_registry/go.mod`), then
  `go mod tidy && go mod vendor`. For Node or Java set `MM_CC_LANG=node` or `java`.
- Private data collections go in `collections_config.json` beside the chaincode. Name orgs by position (`Org1MSP` is
  the first member named on the command line, `OR(ALL_ORGS)` all of them); `deploy.sh` renders them.
- Include at least one collection with `blockToLive > 0`, one only some members belong to, and writes to the implicit
  per-org collections.
- Your chaincode needs no changes on the source: extraction reads blocks, not chaincode. The migration contract is
  only needed on a Fabric destination ([Migration contract setup](migration-overview.md#migration-contract-setup)).

**Data.** Write it with your own client, the `peer` CLI, or `sample/scripts/multi-member/load-generator.js` with a plan
of your own (copy `populate-plan.json`; it names channels, members, key counts, value sizes, rounds). Cover:
- keys rewritten many times, keys deleted and rewritten, keys deleted for good;
- composite keys, binary and non-UTF-8 values, a value over 100 KB;
- private writes by different members to the same collection;
- a member added to a channel after it has data (`channel.sh` again with the extra member, then `deploy.sh` at the next
  sequence);
- an invalid transaction (two transactions reading and writing one key in the same block).

Keep the write rate within what the peers commit: watch each peer's height against the orderer's
(`peer channel getinfo` for each member, `peer channel fetch newest` from the orderer). A peer that falls far behind
can also miss private data, which `validate` then reports.

## 8. Extract, merge and replay

Follow the [multi-member test runbook](multi-member-live-test-runbook.md), section 5, for each member's `discover`,
`extract` and `validate`, then `merge`. Name each member's channels with `--channels`. Members may run different state
databases.

To replay into a Fabric 2.5 destination on the host, `destination.sh` builds one org per member and commits your
chaincode. Give it a copy of your chaincode with the migration contract added (the destination needs it, the source
does not):

1. In the copy, import `<your module>/migration` and register it beside your contract, for Go
   `contractapi.NewChaincode(&YourContract{}, &migration.MigrationContract{})`. `destination.sh` copies the contract
   file in and renders its writer list; see [the migration contract](../sample/chaincode/migration_contract/README.md)
   for Node and Java.
2. Vendor it: copy `sample/chaincode/migration_contract/go/migration.go` to `migration/`, then `go mod tidy && go mod vendor`.
3. Put it in a directory named after the chaincode, under a root directory, and write a plan naming each channel's
   members **in the order `channel.sh` was given them** (collection templates are positional) and its chaincodes:

   ```json
   { "channels": [
     { "name": "shared", "members": ["MemberA", "MemberB", "MemberC"], "chaincodes": ["yourcc"] },
     { "name": "pair",   "members": ["MemberA", "MemberC", "MemberB"], "chaincodes": ["yourcc"] } ] }
   ```

4. Build, check, rebuild, replay and verify:

   ```bash
   MM_CC_ROOT=~/dest-cc ./destination.sh --plan plan.json --input-dir ~/mm/out/merged
   ./destination-check.sh --plan plan.json        # writes test keys, so rebuild after it
   MM_CC_ROOT=~/dest-cc ./destination.sh --plan plan.json --input-dir ~/mm/out/merged
   amb-migrate replay --input-dir ~/mm/out/merged --adapter chaincode --config ~/mm/destination/replay-config.json
   amb-migrate verify --input-dir ~/mm/out/merged --config ~/mm/destination/replay-config.json
   ```

For PostgreSQL, see [Testing and reviewing](testing.md), level 2. The rest of levels 2 and 3 apply to this network too.

## 9. Teardown

Order matters: peers before members, and the last member deletes the network.

```bash
for m in $(aws managedblockchain list-members --network-id $NID --query 'Members[?Status==`AVAILABLE`].Id' --output text); do
  for n in $(aws managedblockchain list-nodes --network-id $NID --member-id $m --query 'Nodes[?Status==`AVAILABLE`].Id' --output text); do
    aws managedblockchain delete-node --network-id $NID --member-id $m --node-id $n; done; done
# wait until every node is DELETED, then:
for m in $(aws managedblockchain list-members --network-id $NID --query 'Members[?Status==`AVAILABLE`].Id' --output text); do
  aws managedblockchain delete-member --network-id $NID --member-id $m; done
for m in MemberA MemberB MemberC; do aws secretsmanager delete-secret --secret-id "$NET/$m/admin" --recovery-window-in-days 7; done
```

Then the endpoint, security groups, host and role, as in the live-test runbook, section 10.
