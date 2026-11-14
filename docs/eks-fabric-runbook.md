# Runbook: self-managed Fabric 2.5 on EKS as a re-broadcast destination

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

How the self-managed test destination was built, how to run a re-broadcast into it, and how to remove it. Scripts are in
[`sample/eks/`](../sample/eks/). Everything below was run on a test network in us-east-1, unless marked **Untested**.

## What gets built

| Piece | Choice | Why |
|---|---|---|
| Cluster | EKS 1.35 (built on 1.34, upgraded in place), 4 × `m6i.xlarge` in private subnets over 3 AZs, gp3 volumes (EBS CSI) | Workers are separate EC2 hosts, so this also covers EC2 |
| Fabric | 2.5.14 (LTS) via `hlf-operator` 1.14.0 (Hyperledger Bevel's Fabric operator, chart `kfs/hlf-operator`) | Actively released; Fabric 2.5 and 3.x; channel-participation orderers; chaincode as a service |
| Orderers | 3 Raft nodes, org `DstOrdererMSP`, **one per AZ** | Killing one actually tests failover |
| Orgs | One per source org (`SOURCE_MSP_IDS`; five and two have been run) with its **AMB MSP ID** (`m-…`), each its own CA, 1 peer, CouchDB | Re-broadcast keeps MSP IDs |
| Ingress | Istio gateway (SNI routing, TLS passthrough) behind an **internal** NLB; Route 53 private zone `*.fab.internal` → NLB | Mutual TLS stays end to end; nothing reachable from the internet |
| Operator host | `fabric-eks-devbox`, `c6i.xlarge`, private subnet, **SSM only** (no inbound rules, no public IP) | Runs `kubectl`, `peer`, `osnadmin` and `fabric-rebroadcast` inside the VPC |
| API access | EKS public endpoint limited to the operator's /32, plus the private endpoint; devbox has an EKS access entry (cluster admin) | |

Resources created directly by these scripts use the tag `project=fabric-eks` where the tool supports it. Pricing: [AWS Pricing Calculator](https://calculator.aws/).

## 1. Cluster (laptop, ~20 min)

```bash
export AWS_PROFILE=<your-profile> AWS_REGION=us-east-1     # any region with three AZs
# Render the region and your egress IP (the only address the public API endpoint admits) into a copy:
sed -e "s/us-east-1/$AWS_REGION/g" -e "s|<operator-ip>|$(curl -s https://checkip.amazonaws.com)|" \
  sample/eks/cluster.yaml > /tmp/cluster.yaml
eksctl create cluster -f /tmp/cluster.yaml --kubeconfig ~/.kube/fabric-eks
eksctl create addon -f /tmp/cluster.yaml                # see gotcha 1; harmless if the add-on exists
aws eks describe-addon --cluster-name fabric-eks --addon-name aws-ebs-csi-driver --query addon.status
```

## 2. Devbox, bucket, DNS (laptop)

```bash
VPC=$(aws eks describe-cluster --name fabric-eks --query cluster.resourcesVpcConfig.vpcId --output text)
SUBNET=<a private subnet of the eksctl-fabric-eks-cluster stack>      # MapPublicIpOnLaunch = False
B=fabric-eks-<account>-$AWS_REGION
aws s3api create-bucket --bucket $B $([ "$AWS_REGION" = us-east-1 ] || echo --create-bucket-configuration LocationConstraint=$AWS_REGION) \
  && aws s3api put-public-access-block --bucket $B \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws cloudformation create-stack --stack-name fabric-eks-devbox --template-body file://sample/eks/devbox.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameters ParameterKey=VpcId,ParameterValue=$VPC \
  ParameterKey=SubnetId,ParameterValue=$SUBNET ParameterKey=BucketName,ParameterValue=$B
# devbox → API and ingress: 443 from the devbox SG only, on the cluster SG
aws ec2 authorize-security-group-ingress --group-id <clusterSecurityGroupId> \
  --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,UserIdGroupPairs=[{GroupId=<devbox SG>}]'
aws eks create-access-entry --cluster-name fabric-eks --principal-arn <devbox RoleArn>
aws eks associate-access-policy --cluster-name fabric-eks --principal-arn <devbox RoleArn> \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster
```

Commands on the devbox go through `sample/eks/dbx.sh` (SSM `RunShellScript`; `DEVBOX_ID=<InstanceId> dbx.sh script.sh`).
Devbox tools, version-checked and checksum-verified: `kubectl` 1.34.1, `helm` 4.3.1, `kubectl-hlf` 1.14.0,
Fabric 2.5.14 binaries, Node 22.20.0, then `aws eks update-kubeconfig --name fabric-eks`. `sample/eks/devbox-tools.sh` does
all of it (run it on the devbox with `AWS_REGION` set).

## 3. Storage, Istio, operator (devbox)

`sample/eks/platform.sh` does this step:

- StorageClass `gp3` (`ebs.csi.aws.com`, encrypted, `WaitForFirstConsumer`, and EBS tag
  `KubernetesCluster=fabric-eks`) as the default; `gp2` un-defaulted.
- Istio 1.30.6 from the Helm charts: `istio/base`, `istio/istiod`, then `istio/gateway` as `istio-ingressgateway` with
  `type: LoadBalancer` and the annotations `aws-load-balancer-type: nlb`, `aws-load-balancer-internal: "true"`, cross-zone on,
  port 443 → 8443, and `loadBalancerSourceRanges` set to the VPC CIDR. Without it the in-tree cloud provider opens the
  gateway's NodePorts to `0.0.0.0/0` on the node security group.
- `helm install hlf-operator kfs/hlf-operator --version 1.14.0`.

Then, from the laptop, check the NLB is `internal` (`aws elbv2 describe-load-balancers`) and create the Route 53 private zone
`fab.internal` on the cluster VPC with the record `*.fab.internal` ALIAS → the NLB. Record the exact hosted-zone ID as
`FABRIC_EKS_ZONE_ID`; teardown requires it and verifies both the name and cluster VPC before deleting anything. Pods and
the devbox resolve every Fabric host to the NLB; Istio routes by SNI.

## 4. Fabric (devbox): `deploy-fabric.sh`, then `artifacts.sh`

Both scripts read the source members' MSP IDs from `SOURCE_MSP_IDS` (space-separated, for example the AMB member IDs).
`deploy-fabric.sh` is safe to rerun after a partial setup: registrar secrets are generated once into
`~/fabric-eks/secrets`, mode 0600. Use a dedicated, single-user SSM devbox: `kubectl-hlf` accepts its generated,
test-only enrollment secrets only as command arguments.

1. CAs `ord-ca`, `org1-ca` … `org<N>-ca`, one per MSP ID in `SOURCE_MSP_IDS`.
2. Orderers `orderer0..2` (`--hosts orderer<N>.fab.internal`, `--admin-hosts admin-orderer<N>.fab.internal`), each pinned to
   its AZ by `spec.affinity` right after creation (gotcha 2).
3. Peers `org<N>-peer0` with `--mspid` = the source MSP ID, CouchDB.
4. Admin identities per org and for the orderer org, signing (`ca`) and TLS (`tlsca`).

`artifacts.sh` collects what the tool needs into `~/fabric-eks/out` (keys 0600):
- MSP dirs and CA/TLS CA certificates per org (NodeOUs on);
- `template.block`: a `configtxgen` block whose Orderer group is these 3 consenters (`genesisTemplate` in the descriptor);
- `dest-eks.json`: self-managed profile, `orderer.endpoints` = the 3 orderers, one peer per org (read as that org's admin),
  `ordererOrg` admin, each org's signer in `ceremony` mode (`SIGNER_MODE=local` puts keys in the descriptor instead),
  `BATCH_TIMEOUT` default 500 ms.

## 5. Channel (devbox)

```bash
RB=fabric-rebroadcast   # run `npm link` in rebroadcast/ to install this on PATH
cd ~/fabric-eks/out
$RB check-archive ~/archive --channel channel-a
$RB plan ~/archive --channel channel-a --dest dest-eks.json --offline
$RB genesis ~/archive --channel channel-a --dest dest-eks.json --out genesis-channel-a.block
for n in 0 1 2; do osnadmin channel join --channelID channel-a --config-block genesis-channel-a.block \
  -o admin-orderer$n.fab.internal:443 --ca-file ord/tlsca.pem --client-cert ord/admin-tls.pem --client-key ord/admin-tls.key; done
# each org, as its admin. Absolute paths: peer resolves relative ones against FABRIC_CFG_PATH, not the working directory.
#   CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID=<msp> CORE_PEER_ADDRESS=peer0-org<N>.fab.internal:443
#   CORE_PEER_TLS_ROOTCERT_FILE=$PWD/org<N>/tlsca.pem CORE_PEER_MSPCONFIGPATH=$PWD/org<N>/msp  peer channel join -b genesis-channel-a.block
$RB plan ~/archive --channel channel-a --dest dest-eks.json        # orderers: 3 × height 1
```

An orderer can answer `SERVICE_UNAVAILABLE` for a few seconds after it joins, while Raft elects a leader; `plan` again.

## 6. Signing ceremony and run (devbox)

```bash
$RB sign-config export ~/archive --channel channel-a --dest dest-eks.json --out bundle
# each member, on a COPY of the bundle, with only its own key (rebroadcast/docs/signing-kit.md):
$RB sign-config sign <copy> --msp <msp> --cert org<N>/msp/signcerts/cert.pem --key org<N>/msp/keystore/key.pem --yes
$RB sign-config import bundle <copies>/signatures
$RB sign-config verify bundle --configtxlator "$(command -v configtxlator)"     # complete: all 9 updates fully signed
setsid nohup $RB run ~/archive --channel channel-a --dest dest-eks.json --bundle bundle > run.log 2>&1 < /dev/null &
$RB compare ~/archive --channel channel-a --dest dest-eks.json                 # via the orderers
$RB compare ~/archive --channel channel-a --dest dest-eks.json --via <0..4>    # via each org's peer
```

**Measured on a test network: a 2,074-block, five-org channel:**
- Ceremony: 9 updates, 29 signatures, five separate copies; verified complete.
- `run`: 2,073 blocks (2,064 transaction, 9 config) in 1,105 s; per transaction block p50 519 ms, p95 607 ms, max 636 ms;
  ingest p50 4 ms; 0 feed reconnects. A single-host run measured p50 516 ms.
- `compare` via the orderers: every transaction block matches.
- `compare` via each peer: every block the peer had committed matched, but **the peers committed slowly** (gotcha 4).

**Measured in eu-west-1, a two-org network** (AMB Fabric 2.2 source, channels of 196 and 34 blocks, private data,
MVCC-invalid transactions, an org added to one channel after it had data), with the peer pull threshold set (gotcha 4):
- `run`: 195 and 33 blocks; per transaction block p50 521 ms, p95 522 ms; 0 feed reconnects.
- `compare` via the orderers and via both peers right after `run`: every block matches, validation codes and commit hash
  included. The peers had committed every block by then.
- A peer whose org joined the channel in a later config block refuses that org until it has committed that block:
  `compare --via` it reports `Behind` (exit 13) until then.

## 7. Tip phase (devbox)

Chaincode as a service, one Deployment serving every peer and channel:

1. Build the chaincode with the migration contract (writer list: the source MSP IDs, which the destination keeps) and the
   server `main` the sample chaincodes have (`CHAINCODE_SERVER_ADDRESS`, `CHAINCODE_ID`); push the image to a registry the
   nodes can pull from (ECR: the node role has `AmazonEC2ContainerRegistryReadOnly`).
2. Package it as `ccaas`: `metadata.json` `{"type":"ccaas","label":"<label>"}` and `code.tar.gz` holding `connection.json`
   `{"address":"<service>.default.svc.cluster.local:7052","dial_timeout":"10s","tls_required":false}`. The package ID is
   `<label>:<sha256 of the package>`.
3. Run the image as a `Deployment` with `CHAINCODE_SERVER_ADDRESS=0.0.0.0:7052` and `CHAINCODE_ID=<package ID>`, behind a
   `ClusterIP` Service (nothing published).
4. As each org's admin: `peer lifecycle chaincode install` the package; then the `approveformyorg` and `commit` that
   `tip chaincode-check … --write-collections <dir>` prints, at the next sequence, with the collection files it writes.
   `tip chaincode-check` then reports `READY … migration contract answers`.
5. `tip import-private … --private <member output> --peers <its own peer> --yes`, once per org and channel.
6. `verify … --peer <its own peer> --private <member output>`, once per member and channel. A member whose peer joined a
   channel late lacks the private values written before it joined: hand it only that collection's
   `private-<cc>-<coll>-state.ndjson` from another reader, beside its own output ([re-broadcast](rebroadcast.md)).

Measured on the two-org network above: `import-private` wrote every live value (both channels, both orgs); `verify` as each
member through its own peer: ALL MATCH, every key's state and history, every source delete absent, no extra or missing key,
every private value equal to the hash in the blocks; `blockToLive`-purged keys counted as purged at source.

## 8. Orderer-kill drill (devbox)

Start a `run` in the background (`setsid nohup … &`), then kill orderers by their pod label (`release=orderer<N>`; the
pods carry no `app=orderer<N>` label):

```bash
kubectl delete pod -l release=orderer0 --wait=false                              # one orderer, its AZ's only one
kubectl delete pod -l 'release in (orderer0,orderer1,orderer2)' --wait=false     # all three
```

Measured on a two-org channel topped up from 307 to 607 blocks (`extract --save-blocks <dir> --blocks-only` into the
same archive), timeout mode, stock orderers:
- One orderer killed (orderer0, eu-west-1a): the delivery feed failed over to orderer1; no block was delayed beyond its
  BatchTimeout.
- All three killed 50 s later: the send of the next block failed over round the three orderers until they were back,
  waited 10 s for anything still queued, found nothing of the block cut, and sent it once more. The run went on by itself:
  300 blocks in 202 s, worst block 46 s, 8 feed reconnects, exit 0.
- `compare` via the orderers and via both peers: all 607 blocks match, validation codes and commit hash included. A
  re-run found nothing pending and sent nothing.

## Expired signers

A stock orderer refuses a transaction whose signer certificate has expired. To reproduce it on AMB, whose CA issues
10-year certificates, a test channel was given an extra root CA in one member's MSP definition (a channel config update
signed by that member: an AMB channel creation takes the org definitions from AMB's consortium, not from the
`configtx.yaml` given), and transactions were signed by a 15-minute certificate from it before it expired.

- `plan`: `BLOCKING [E6-expired-signers] 10 transactions were signed by certificates expired by …`.
- `run` on the stock orderer: `STOP (exit 3): block 15: envelope 0 (tx …) refused: BAD_REQUEST broadcast client identity
  expired`. Nothing of that block is written.
- Switch to the patched orderer for the migration window, re-run, and switch back:

  ```bash
  # build: rebroadcast/orderer-patch/ (Fabric v2.5.14 + the patch, CGO_ENABLED=0 go build ./cmd/orderer, that Dockerfile)
  ./orderer-image.sh patched <registry>/<repository> <tag>@sha256:<digest>   # ORDERER_MIGRATION_SKIP_EXPIRATION=true
  $RB plan …                                      # every orderer answers again
  $RB run … --bundle …                            # resumes at the refused block
  ./orderer-image.sh stock
  ```

  Measured: the run resumed at block 15 and sent the remaining 20 blocks, the 10 expired-signer transactions among them;
  `compare` via the orderers and the peer matched every block, validation codes included (the peers do not check signer
  expiry when they validate). `orderer-image.sh` waits for the operator to roll the change out (gotcha 11).

## Five orgs and private-data reconciliation

Orgs can be added to a running cluster: re-run `deploy-fabric.sh` and `artifacts.sh` with every MSP ID in `SOURCE_MSP_IDS`
(existing CAs, orderers and peers are kept). Five orgs with their CAs, peers and CouchDB fit on the 4 `m6i.xlarge` nodes
(under 10% CPU at rest).

Measured on a five-member AMB channel (two LevelDB and three CouchDB peers; one member added after the channel had
data; collections for all five, a pair, a triple, a single org with `blockToLive`, and one added at sequence 2):
- Ceremony: 9 config updates, 31 signatures, five separate copies; the update that added the fifth org needed all five.
- `run`: 114 blocks in 55 s; `compare` via the orderers and each of the 5 peers: every block matches.
- Tip: the ccaas package installed on 5 peers, approved by 5 orgs at the next sequence, committed through 5 peers.
  The migration contract's writer list must name **every** org that runs `import-private`; `tip chaincode-check`
  reports `migration contract answers` either way, so a missing org shows only as `may not write migration data` at
  its import. With chaincode as a service, a rebuilt image (same package ID) replaces the server without a lifecycle
  change.
- **Reconciliation:** org2's peer pod was deleted, and org1 ran `import-private` (collections `all` and `pairAB`, both
  shared with org2) while it was down. Back up, org2's peer logged `Reconciliation cycle finished successfully` for
  channel five, and `verify` as org2 through its own peer, before org2 imported anything, found every value of both
  collections (50/50 and 20/20). Org2's own `import-private` then found them already present.
- `verify` as each of the five members through its own peer: ALL MATCH (the late-joining member with the other
  readers' values for the collection it joined late, as above).

## Cut-markers mode

The patched orderer cuts a block at each cut marker only with `ORDERER_MIGRATION_CUT_MARKERS=true`
(`orderer-image.sh patched` sets it with the expiry switch). Then run with a copy of the descriptor whose orderer mode is
`cut-markers`:

```bash
jq '.orderer.mode = "cut-markers"' dest-eks.json > dest-markers.json
$RB run ~/archive --channel channel-a --dest dest-markers.json --bundle bundle
./orderer-image.sh stock                      # after the run: the patched orderer is for the migration window only
```

Measured, resuming a channel at 607 of 907 blocks (each a single transaction): 300 blocks in 2.2 s, per block p50 3 ms,
p95 32 ms (timeout mode on the same channel: p50 517 ms); `compare` via the orderers and both peers: all 907 match. The
peers commit behind the send rate at first (one was at 867 when `compare` reached it, exit 13 until it caught up).

A second 300-block top-up (to 1,207) with `orderer0` deleted 0.7 s into the send: the run still completed (exit 0, no
feed reconnect) and `compare` matched all 1,207 blocks. `kubectl delete pod` stops a pod gracefully and after a delay,
so a 2-second send finished first.

**Still untested:** a send failure in `cut-markers` mode on EKS: it needs a run long enough, or a harder kill
(`kubectl delete pod --grace-period=0 --force`, or killing the orderer process), to land during a send. The unit test
`cut-markers mode does not recover a failed send: exit 4` covers it. Also untested: ledgers beyond a few thousand
blocks on EKS.

## Gotchas found

1. **`eksctl create cluster` skipped the `aws-ebs-csi-driver` add-on** listed in `cluster.yaml` (no error). Every PVC stays
   `Pending` ("waiting for a volume to be created by ebs.csi.aws.com") and CAs never start. Fix: `eksctl create addon -f cluster.yaml`.
   (eksctl 0.231.0 installed the add-on with the cluster; the extra step is harmless.)
2. **`hlf-operator` ignores `spec.nodeSelector` on orderers** (the field validates but never reaches the Deployment), so all three
   landed in one AZ. `spec.affinity` works, but only in the spec the resource is **created** with: the operator schedules the
   first pod at once, the gp3 volume binds in that pod's zone and cannot move, and a `kubectl patch` right after creation
   lost that race for two of three orderers. `deploy-fabric.sh` now generates the resource (`kubectl hlf ordnode create
   --output`), adds the affinity, and applies it. To fix after the fact: delete the orderer and its PVC, re-run the script.
3. `kubectl hlf` has no `version` subcommand; check the binary with `--help`.
4. **Peers commit far slower than the orderers cut** (about 0.5 s per block at the orderer; peers were still 400–500 blocks behind
   ~90 minutes after the run ended). Cause: the peers waited to pull private data no destination peer has. With
   `CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD=0s` ([prerequisites](rebroadcast.md#prerequisites)), which
   `deploy-fabric.sh` now sets in each peer's spec, both peers had committed every block when `compare` ran right after
   `run`. Restore the default after the tip phase.
5. **Upgrading Kubernetes in place** (1.34 → 1.35): EKS upgrade insights all passing; then
   `aws eks update-cluster-version` (7 min), `update-addon` for `kube-proxy` and `coredns` to the 1.35 defaults
   (`vpc-cni`, `aws-ebs-csi-driver` and `eks-pod-identity-agent` defaults were unchanged), then
   `aws eks update-nodegroup-version` (rolling, `maxUnavailable: 1`). Pods move to the new nodes and reattach their
   EBS volumes, which are bound to an AZ: the node group spans the same three subnets, so each volume finds a node.
6. Inside a script with `set -o pipefail`, `cmd | head -1` kills `cmd` with SIGPIPE and stops the script (it hid four of five
   ceremony signings on the first attempt).
7. **`kubectl-hlf` 1.14.0 writes fields the 1.14.0 chart's CRDs do not define** (`spec.credentialStore`, `spec.traefik`, …).
   `kubectl hlf … create` only warns; `kubectl apply` of its `--output` is refused under strict validation, so apply it with
   `--validate=warn`. The fields are dropped either way.
8. **The cloud provider opens the ingress NodePorts to `0.0.0.0/0`** on the node security group for a `LoadBalancer` Service
   with no `loadBalancerSourceRanges`, even behind an internal NLB on private nodes. `platform.sh` sets the range to the VPC
   CIDR; the rules then name only that CIDR.
9. **The peer CLI resolves a relative `CORE_PEER_MSPCONFIGPATH` against `FABRIC_CFG_PATH`**, so `org<N>/msp` from
    `~/fabric-eks/out` fails with "cannot init crypto". Use absolute paths (step 5).
10. **`hlf-operator` applies a `FabricOrdererNode` change asynchronously.** `kubectl rollout status` straight after
    `kubectl patch` returned while the Deployment still had the old image, so a `run` started then met restarting
    orderers (it stopped cleanly with exit 11), and a quick revert raced the same way. Wait until the Deployment shows
    the new image, then for the rollout and for `plan` to see every orderer: `orderer-image.sh` does the first two.
11. **A run refused on the block after a config block could not be resumed** (exit 6, "written by a run from a different
    archive"): the state file records a mirrored config block's destination data hash, and the resume check compared it
    with the source's. Fixed in `rebroadcast/src/run/run.ts`; found here when the stock orderer refused the first
    expired-signer block, right after a config block.
12. **`cut-markers` mode crashed with every org signing by ceremony** (`TypeError: Cannot read properties of undefined
    (reading 'creator')`, before anything was sent): markers were signed by the first local org signer, and a ceremony
    descriptor has none. They are now signed by the orderer reader when no org key is local. Fixed in
    `rebroadcast/src/run/run.ts`, with a test.

## Teardown

`AWS_REGION=<region> FABRIC_EKS_ZONE_ID=<exact-private-zone-id> sample/eks/teardown.sh` (asks for `yes`; irreversible): delete the Istio gateway service first (its NLB
holds VPC ENIs), then the private zone, the devbox stack, the cluster and VPC (`eksctl delete cluster`), and the bucket. Delete
an image repository you created for the tip-phase chaincode or the patched orderer separately.
