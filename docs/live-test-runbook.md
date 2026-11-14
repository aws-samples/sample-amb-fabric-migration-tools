# Live AMB Extraction and Fabric 2.5 Replay Test Runbook

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This runbook provisions a disposable EC2/SSM host with private access to an
Amazon Managed Blockchain (AMB) Hyperledger Fabric network, runs a Tier 3
extraction and validation, starts the open-source Fabric 2.5 test-network on the
same host, replays current state, verifies it, captures evidence, and tears down
every resource created for the test.

The procedure is non-destructive to the AMB network: it calls read-only AMB
control-plane APIs and Fabric query/delivery APIs. Provisioning the endpoint,
IAM role, EC2 instance, optional secret, and optional transfer bucket changes
AWS infrastructure and incurs temporary cost.

> **Safety boundary:** Use a test account/network. Review every ID before a
> create or delete command. Never delete a VPC, subnet, security group, endpoint,
> IAM role, bucket, secret, or instance that this run did not create. A source
> private-data extraction reads confidential values; control who can access the
> host, output directory, logs, and evidence.

## 1. Variables and naming

Run AWS CLI commands from an authenticated operator workstation. Set every value
explicitly; do not rely on a default region or account.

```bash
export AWS_PROFILE=<profile>
export REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity \
  --profile "$AWS_PROFILE" --query Account --output text)

export NETWORK_ID=n-XXXXXXXXXXXXXXXXXXXXXXXXXX
export MEMBER_ID=m-XXXXXXXXXXXXXXXXXXXXXXXXXX
export NODE_ID=nd-XXXXXXXXXXXXXXXXXXXXXXXXXX

export VPC_ID=vpc-xxxxxxxx
export SUBNET_ID=subnet-xxxxxxxx  # Prefer the node's AZ
export SG_ID=sg-xxxxxxxx          # May be pre-existing; record ownership

export RUN_ID=amb-migration-live-test-$(date +%Y%m%d%H%M%S)
export ROLE_NAME="${RUN_ID}-role"
export PROFILE_NAME="${RUN_ID}-profile"
export INSTANCE_NAME="$RUN_ID"
export SECRET_NAME="amb-migration-live-test/admin-enrollment-secret"

export ENDPOINT_SERVICE=$(aws managedblockchain get-network \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --network-id "$NETWORK_ID" \
  --query 'Network.VpcEndpointServiceName' --output text)

echo "account=$ACCOUNT_ID region=$REGION"
echo "network=$NETWORK_ID member=$MEMBER_ID node=$NODE_ID"
echo "vpc=$VPC_ID subnet=$SUBNET_ID sg=$SG_ID"
echo "endpoint-service=$ENDPOINT_SERVICE"
```

Confirm that the network, owned member, node, VPC, subnet, and security group are
all in the intended account and region:

```bash
aws managedblockchain get-network --profile "$AWS_PROFILE" --region "$REGION" \
  --network-id "$NETWORK_ID"
aws managedblockchain get-member --profile "$AWS_PROFILE" --region "$REGION" \
  --network-id "$NETWORK_ID" --member-id "$MEMBER_ID"
aws managedblockchain get-node --profile "$AWS_PROFILE" --region "$REGION" \
  --network-id "$NETWORK_ID" --member-id "$MEMBER_ID" --node-id "$NODE_ID"
aws ec2 describe-subnets --profile "$AWS_PROFILE" --region "$REGION" \
  --subnet-ids "$SUBNET_ID" \
  --query 'Subnets[0].{VpcId:VpcId,AZ:AvailabilityZone,PublicIp:MapPublicIpOnLaunch}'
aws ec2 describe-security-groups --profile "$AWS_PROFILE" --region "$REGION" \
  --group-ids "$SG_ID"
```

Record whether `SG_ID`, `VPC_ID`, and `SUBNET_ID` are pre-existing. This runbook
never deletes them.

## 2. Network access

### 2.1 Security group

Attach the same test security group to the extraction instance and AMB interface
endpoint. It must allow:

- Instance egress to TCP 30001–30004 through the endpoint.
- Endpoint ingress from the instance security group on TCP 30001–30004. A
  self-referencing rule is the simplest test-only configuration.
- HTTPS egress for SSM and dependency downloads.
- No inbound SSH is required for Session Manager.

If an approved group does not already exist, create and mark one as owned by this
run. Skip these commands when using a pre-existing group:

```bash
export SG_ID=$(aws ec2 create-security-group \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --vpc-id "$VPC_ID" \
  --group-name "$RUN_ID" \
  --description 'Disposable AMB extractor live test' \
  --query GroupId --output text)
export CREATED_SG=true

aws ec2 authorize-security-group-ingress \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --group-id "$SG_ID" \
  --ip-permissions \
    "IpProtocol=tcp,FromPort=30001,ToPort=30004,UserIdGroupPairs=[{GroupId=$SG_ID}]"
aws ec2 create-tags --profile "$AWS_PROFILE" --region "$REGION" \
  --resources "$SG_ID" \
  --tags Key=Name,Value="$RUN_ID" Key=Purpose,Value=DisposableAMBExtractorTest
```

### 2.2 AMB interface endpoint

First check whether an approved endpoint for this exact network already exists:

```bash
aws ec2 describe-vpc-endpoints \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" \
            Name=service-name,Values="$ENDPOINT_SERVICE" \
  --query 'VpcEndpoints[].{Id:VpcEndpointId,State:State,PrivateDns:PrivateDnsEnabled}'
```

Reuse a pre-existing endpoint only with its owner's approval. Otherwise create a
single-AZ disposable endpoint in the test subnet:

```bash
export VPC_ENDPOINT_ID=$(aws ec2 create-vpc-endpoint \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --vpc-id "$VPC_ID" \
  --vpc-endpoint-type Interface \
  --service-name "$ENDPOINT_SERVICE" \
  --subnet-ids "$SUBNET_ID" \
  --security-group-ids "$SG_ID" \
  --private-dns-enabled \
  --tag-specifications \
    "ResourceType=vpc-endpoint,Tags=[{Key=Name,Value=$RUN_ID},{Key=Purpose,Value=DisposableAMBExtractorTest}]" \
  --query 'VpcEndpoint.VpcEndpointId' --output text)
export CREATED_VPC_ENDPOINT=true

# The AWS CLI has no VPC endpoint waiter, so poll; usually 1-3 minutes, at most 10 here.
for _ in $(seq 1 40); do
  VPCE_STATE=$(aws ec2 describe-vpc-endpoints \
    --profile "$AWS_PROFILE" --region "$REGION" \
    --vpc-endpoint-ids "$VPC_ENDPOINT_ID" \
    --query 'VpcEndpoints[0].State' --output text)
  case "$VPCE_STATE" in
    available|failed|rejected|deleted|expired) break ;;
  esac
  sleep 15
done
[ "$VPCE_STATE" = available ] || echo "STOP: endpoint $VPC_ENDPOINT_ID is $VPCE_STATE; do not continue with section 3" >&2
```

Private DNS is required so the AMB peer, event, CA, and orderer hostnames resolve
to the endpoint ENI from the instance.

## 3. Credential handling

A Fabric admin MSP is a signing credential: its `keystore` private key can submit
transactions and config updates allowed by that identity. Never put an enrollment
password, private key, MSP archive, or decoded secret value in a command argument,
Git file, user data, shell history, ticket, SSM output, or source-transfer archive.

Choose one signing-identity source. **Option C is preferred for repeated tests**:
it avoids repeated enrollment while granting a disposable host only the already
approved signer it needs.

### Option A: Existing MSP

Securely copy an archive whose extracted layout contains `signcerts/` and
`keystore/` to the test host. Set `MSP_PATH` to it in every SSM session and do
not grant the instance access to an enrollment secret:

```bash
export MSP_PATH=/secure/path/to/admin-msp
```

The discover and extract commands below consume this environment fallback; you
can pass `--msp-path "$MSP_PATH"` explicitly instead.

### Option B: One-time enrollment password in Secrets Manager

Use this only to establish a new admin identity when no approved MSP archive
already exists. Create the secret through an approved secure workflow. If using
the CLI, put the password in a temporary mode-600 file rather than the command
line:

```bash
umask 077
read -rsp 'Original AMB member admin password: ' CA_PASSWORD; echo
jq -n --arg password "$CA_PASSWORD" '{password:$password}' > /tmp/amb-admin-secret.json
unset CA_PASSWORD

aws secretsmanager create-secret \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --name "$SECRET_NAME" \
  --description 'Temporary AMB extractor live-test enrollment secret' \
  --secret-string file:///tmp/amb-admin-secret.json
shred -u /tmp/amb-admin-secret.json 2>/dev/null || rm -f /tmp/amb-admin-secret.json

export SECRET_ARN=$(aws secretsmanager describe-secret \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --secret-id "$SECRET_NAME" --query ARN --output text)
```

If the secret already exists, set `SECRET_ARN` with only the `describe-secret`
command. Do not automatically delete a pre-existing secret during teardown.

### Option C: Retained enrolled MSP archive in Secrets Manager

For a test host that will be reused, enroll once through Option B, then archive
only the resulting `msp/` directory (its trust material, signing certificate,
and private key) in a **separate** secret. The enrollment password can issue new
certificates for the registered admin identity; the archive secret supplies only
the chosen certificate and key. Re-enrollment does not change channel
configuration, but whether a new certificate has admin authority depends on the
channel MSP's Node OU or `admincerts` configuration and any certificate-specific
policies. It also changes the identity recorded in audit data.

Use a dedicated secret name owned by the credential owner, not a run ID. For a
long-lived or production-equivalent signer, create the secret with a customer
managed KMS key and document its owner and rotation policy. The host then needs
`kms:Decrypt` on that key in addition to secret access. An AWS-managed Secrets
Manager key is acceptable only for a disposable test credential where that is an
explicit risk decision.

The host role receives `secretsmanager:GetSecretValue` on the archive secret
only, plus `kms:Decrypt` on its customer managed key when applicable. It must not
receive `PutSecretValue`, and after the archive exists it no longer needs access
to the enrollment-password secret. A separate approved bootstrap/rotation
principal may write a replacement archive, then validates it on a fresh host
before the old identity is retired.

The archive secret is JSON of this form; `archive` is base64-encoded `tar.gz`
whose top-level directory is `msp`. The complete `SecretString`, including base64
overhead, must not exceed Secrets Manager's 65,536-byte limit:

```json
{
  "format": "tar.gz-base64",
  "memberId": "m-...",
  "mspId": "m-...",
  "sha256": "<sha256 of decoded archive>",
  "archive": "<base64 tar.gz>"
}
```

Before generating the host policy in §4, set the archive ARN on the operator
workstation. If the secret uses a customer managed KMS key, set its key ARN too;
otherwise leave the key variable unset:

```bash
export MSP_ARCHIVE_SECRET_ARN=<archive-secret-arn>
export MSP_ARCHIVE_KMS_KEY_ARN=<customer-managed-kms-key-arn> # if applicable
```

After launching the host and setting the §7 resource identifiers, repeat the
archive-secret ARN inside the SSM session. Materialize the MSP only in that
signing session, verify its format and digest before extraction, and remove it
when the session exits:

```bash
umask 077
export MSP_ARCHIVE_SECRET_ARN=<archive-secret-arn>
export MSP_ROOT=$(mktemp -d)
export MSP_ARCHIVE_PATH="$MSP_ROOT/admin-msp.tgz"
trap 'rm -rf "$MSP_ROOT"' EXIT

ARCHIVE_JSON=$(aws secretsmanager get-secret-value \
  --region "$REGION" --secret-id "$MSP_ARCHIVE_SECRET_ARN" \
  --query SecretString --output text)
ARCHIVE_FORMAT=$(jq -er .format <<<"$ARCHIVE_JSON")
ARCHIVE_MEMBER_ID=$(jq -er .memberId <<<"$ARCHIVE_JSON")
ARCHIVE_SHA=$(jq -er \
  '.sha256 | select(type == "string" and test("^[0-9a-f]{64}$"))' \
  <<<"$ARCHIVE_JSON")

if [ "$ARCHIVE_FORMAT" != tar.gz-base64 ] || \
   [ "$ARCHIVE_MEMBER_ID" != "$MEMBER_ID" ]; then
  echo "ERROR: MSP archive metadata does not match this run" >&2
  exit 1
fi

jq -er '.archive | select(type == "string" and length > 0)' \
  <<<"$ARCHIVE_JSON" | base64 -d > "$MSP_ARCHIVE_PATH"
printf '%s  %s\n' "$ARCHIVE_SHA" "$MSP_ARCHIVE_PATH" | \
  sha256sum -c - || exit 1

ARCHIVE_FILES=$(tar -tzf "$MSP_ARCHIVE_PATH")
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$ARCHIVE_FILES" || \
   grep -Evq '^msp(/|$)' <<<"$ARCHIVE_FILES" || \
   ! grep -Eq '^msp/signcerts/cert\.pem$' <<<"$ARCHIVE_FILES" || \
   ! grep -Eq '^msp/keystore/[^/]+$' <<<"$ARCHIVE_FILES"; then
  echo "ERROR: MSP archive has an unsafe or incomplete layout" >&2
  exit 1
fi

tar -xzf "$MSP_ARCHIVE_PATH" -C "$MSP_ROOT" || exit 1
rm -f "$MSP_ARCHIVE_PATH"
unset ARCHIVE_JSON ARCHIVE_FORMAT ARCHIVE_MEMBER_ID ARCHIVE_SHA ARCHIVE_FILES
export MSP_PATH="$MSP_ROOT/msp"
```

Run `discover` or `extract` with that `MSP_PATH` and **do not** set
`CA_ENROLLMENT_SECRET`. The `trap` removes the private key on normal session
exit; after an abrupt disconnect, terminate the disposable host or reconnect and
remove `MSP_ROOT`. Retain the archive secret through general test-infrastructure
teardown unless its credential owner explicitly approves deletion; it is an
identity lifecycle decision, not ordinary disposable-resource cleanup.

### Optional: Temporary source-transfer bucket

Skip this section when the instance can clone the exact reviewed ref. To test an
uncommitted local tree, create a dedicated encrypted transfer object before
creating the host role:

```bash
export TRANSFER_BUCKET="amb-xtr-${ACCOUNT_ID}-$(date +%s)"
export TRANSFER_KEY=amb-migration-tools-source.tgz
export CREATED_TRANSFER_BUCKET=true

if [ "$REGION" = us-east-1 ]; then
  aws s3api create-bucket --profile "$AWS_PROFILE" --region "$REGION" \
    --bucket "$TRANSFER_BUCKET"
else
  aws s3api create-bucket --profile "$AWS_PROFILE" --region "$REGION" \
    --bucket "$TRANSFER_BUCKET" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

# Run from the repository root. .gitignore exclusions keep node_modules,
# extraction output, wallets, MSPs, and local secrets out of this archive.
git ls-files -co --exclude-standard -z | \
  tar --null -T - -czf /tmp/amb-migration-tools-source.tgz

aws s3api put-object --profile "$AWS_PROFILE" --region "$REGION" \
  --bucket "$TRANSFER_BUCKET" --key "$TRANSFER_KEY" \
  --body /tmp/amb-migration-tools-source.tgz \
  --server-side-encryption AES256
rm -f /tmp/amb-migration-tools-source.tgz

export TRANSFER_OBJECT_ARN="arn:aws:s3:::$TRANSFER_BUCKET/$TRANSFER_KEY"
```

Inspect the archive file list before upload if the workspace can contain
confidential data. The bucket and object are temporary and are deleted in §10.

## 4. Dedicated IAM role and instance profile

The host needs SSM access, exact AMB read operations, the regional TLS-chain
object, and optionally either the one-time enrollment secret or the retained MSP
archive. It does not need AMB write permissions.

```bash
cat > /tmp/ec2-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role --profile "$AWS_PROFILE" \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/ec2-trust.json \
  --description 'Disposable Fabric AMB extractor live-test role' \
  --tags Key=Purpose,Value=DisposableAMBExtractorTest
rm -f /tmp/ec2-trust.json

aws iam attach-role-policy --profile "$AWS_PROFILE" \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
```

Generate a least-privilege inline policy. The network ARN has an empty account
field; member and node ARNs use the account ID. `SECRET_ARN` adds Option B;
`MSP_ARCHIVE_SECRET_ARN` and optional `MSP_ARCHIVE_KMS_KEY_ARN` add Option C.
Do not set both secret options unless this host is intentionally performing the
one-time enrollment bootstrap before switching to the retained archive.

```bash
jq -n \
  --arg region "$REGION" \
  --arg account "$ACCOUNT_ID" \
  --arg network "$NETWORK_ID" \
  --arg member "$MEMBER_ID" \
  --arg node "$NODE_ID" \
  --arg secret "${SECRET_ARN:-}" \
  --arg archiveSecret "${MSP_ARCHIVE_SECRET_ARN:-}" \
  --arg archiveKmsKey "${MSP_ARCHIVE_KMS_KEY_ARN:-}" \
  --arg transfer "${TRANSFER_OBJECT_ARN:-}" \
  '{
    Version:"2012-10-17",
    Statement: ([
      {
        Sid:"ReadAmb",
        Effect:"Allow",
        Action:[
          "managedblockchain:GetNetwork",
          "managedblockchain:GetMember",
          "managedblockchain:GetNode"
        ],
        Resource:[
          "arn:aws:managedblockchain:\($region)::networks/\($network)",
          "arn:aws:managedblockchain:\($region):\($account):members/\($member)",
          "arn:aws:managedblockchain:\($region):\($account):nodes/\($node)"
        ]
      },
      {
        Sid:"ReadTlsChain",
        Effect:"Allow",
        Action:"s3:GetObject",
        Resource:"arn:aws:s3:::\($region).managedblockchain/etc/managedblockchain-tls-chain.pem"
      }
    ] + (if $transfer == "" then [] else [{
      Sid:"ReadSourceArtifact",
      Effect:"Allow",
      Action:"s3:GetObject",
      Resource:$transfer
    }] end) + (if $secret == "" then [] else [{
      Sid:"ReadEnrollmentSecret",
      Effect:"Allow",
      Action:"secretsmanager:GetSecretValue",
      Resource:$secret
    }] end) + (if $archiveSecret == "" then [] else [{
      Sid:"ReadDedicatedMspArchive",
      Effect:"Allow",
      Action:"secretsmanager:GetSecretValue",
      Resource:$archiveSecret
    }] end) + (if $archiveKmsKey == "" then [] else [{
      Sid:"DecryptDedicatedMspArchive",
      Effect:"Allow",
      Action:"kms:Decrypt",
      Resource:$archiveKmsKey,
      Condition:{
        StringEquals:{
          "kms:ViaService":"secretsmanager.\($region).amazonaws.com"
        }
      }
    }] end))
  }' > /tmp/host-policy.json

aws iam put-role-policy --profile "$AWS_PROFILE" \
  --role-name "$ROLE_NAME" \
  --policy-name FabricAmbExtractorLiveTest \
  --policy-document file:///tmp/host-policy.json
rm -f /tmp/host-policy.json

aws iam create-instance-profile --profile "$AWS_PROFILE" \
  --instance-profile-name "$PROFILE_NAME" \
  --tags Key=Purpose,Value=DisposableAMBExtractorTest
aws iam add-role-to-instance-profile --profile "$AWS_PROFILE" \
  --instance-profile-name "$PROFILE_NAME" \
  --role-name "$ROLE_NAME"
```

Allow a short IAM propagation interval before launching the instance.

## 5. Launch the disposable extraction host

Resolve the current Amazon Linux 2023 x86_64 AMI and launch at least a
`t3.medium`. The local Fabric destination uses multiple peers, CAs, CouchDB
containers, and chaincode containers; allocate at least 20 GiB of encrypted root
storage.

```bash
export AMI_ID=$(aws ssm get-parameter \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)

export INSTANCE_ID=$(aws ec2 run-instances \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type t3.medium \
  --count 1 \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile Name="$PROFILE_NAME" \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
  --block-device-mappings \
    'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Purpose,Value=DisposableAMBExtractorTest}]" \
  --query 'Instances[0].InstanceId' --output text)

aws ec2 wait instance-status-ok --profile "$AWS_PROFILE" --region "$REGION" \
  --instance-ids "$INSTANCE_ID"
```

The launch example assumes a public test subnet and explicitly associates a
public IP for outbound SSM and dependency downloads; it opens no inbound SSH.
Omit `--associate-public-ip-address` in a private subnet. A private subnet needs
`ssm`, `ssmmessages`, and `ec2messages` interface endpoints (plus a path to
download dependencies), or equivalent approved egress.

Wait until SSM reports `Online`:

```bash
aws ssm describe-instance-information \
  --profile "$AWS_PROFILE" --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID"
aws ssm start-session --profile "$AWS_PROFILE" --region "$REGION" \
  --target "$INSTANCE_ID"
```

## 6. Bootstrap the host

Run inside the SSM session:

```bash
sudo dnf install -y git jq openssl tar gzip docker golang
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

# Install a supported Node.js LTS. The project requires Node 22+.
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
node --version

sudo mkdir -p /usr/local/lib/docker/cli-plugins
export COMPOSE_VERSION=v5.5.1
sudo curl -fsSL \
  "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

Start a new SSM session after changing Docker group membership. Clone a reviewed
commit/branch using a credential helper, SSH agent, or other approved Git
credential mechanism; do not embed a PAT in the URL or shell history.

```bash
export REPO_DIR="$HOME/sample-amb-fabric-migration-tools"
git clone <reviewed-repository-url> "$REPO_DIR"
cd "$REPO_DIR"
git checkout <reviewed-ref>
npm ci
npm run build
```

### Testing uncommitted local changes

If §3 created a transfer object, set its URI explicitly in the SSM session and
extract it into a dedicated directory:

```bash
export TRANSFER_URI=s3://<transfer-bucket>/amb-migration-tools-source.tgz
export REPO_DIR=/opt/sample-amb-fabric-migration-tools
sudo mkdir -p "$REPO_DIR"
sudo chown "$USER":"$USER" "$REPO_DIR"
aws s3 cp "$TRANSFER_URI" /tmp/amb-migration-tools-source.tgz
tar -xzf /tmp/amb-migration-tools-source.tgz \
  -C "$REPO_DIR"
rm -f /tmp/amb-migration-tools-source.tgz
cd "$REPO_DIR"
npm ci
npm run build
```

The archive must exclude `.git`, `node_modules`, `dist`, coverage, credentials,
MSPs, wallets, extraction output, and confidential data. The dedicated role grants
only `s3:GetObject` on this one object. Delete the object and bucket in §10. Do
not send project code or credentials to a third-party endpoint.

## 7. TLS and admin identity

Inside the host, set the resource identifiers again; exports from the operator
workstation do not cross an SSM session:

```bash
export REGION=us-east-1
export NETWORK_ID=n-XXXXXXXXXXXXXXXXXXXXXXXXXX
export MEMBER_ID=m-XXXXXXXXXXXXXXXXXXXXXXXXXX
export NODE_ID=nd-XXXXXXXXXXXXXXXXXXXXXXXXXX
export SECRET_NAME=amb-migration-live-test/admin-enrollment-secret
export REPO_DIR=<absolute-reviewed-repo-directory>
```

Then download the TLS chain and test the private endpoint:

```bash
cd "$REPO_DIR"
aws s3 cp \
  "s3://$REGION.managedblockchain/etc/managedblockchain-tls-chain.pem" \
  ./managedblockchain-tls-chain.pem
export TLS_CA_CERT="$PWD/managedblockchain-tls-chain.pem"

# Confirm DNS resolves through the interface endpoint and TLS verifies.
export PEER_HOST=$(aws managedblockchain get-node \
  --region "$REGION" --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" --node-id "$NODE_ID" \
  --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' --output text | cut -d: -f1)
getent hosts "$PEER_HOST"
openssl s_client -connect "$PEER_HOST:30003" -servername "$PEER_HOST" \
  -CAfile "$TLS_CA_CERT" </dev/null 2>&1 | \
  grep -E 'subject=|issuer=|Verify return code'
```

For Secrets Manager enrollment, retrieve the value without printing it, run
`discover`, then unset it. This example expects `{"password":"..."}`:

```bash
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --region "$REGION" --secret-id "$SECRET_NAME" \
  --query SecretString --output text)
export CA_ENROLLMENT_SECRET=$(jq -r '.password' <<<"$SECRET_JSON")
unset SECRET_JSON

mkdir -p ~/fabric-amb-live-output
amb-migrate discover \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --output-dir ~/fabric-amb-live-output \
  --fabric-mode legacy

unset CA_ENROLLMENT_SECRET
```

`discover` caches the enrolled identity under `wallet/<member-id>/`; later
commands can reuse it. If using an existing MSP, pass `--msp-path "$MSP_PATH"`
instead and do not set `CA_ENROLLMENT_SECRET`.

Stop if enrollment, config-block decoding, channel discovery, chaincode or
collection discovery, implicit-collection synthesis, or ledger-height lookup
fails. Do not manually remove a failed channel or private collection to make the
run pass.

## 8. Tier 3 extraction and source validation

A 2 GiB V8 ceiling safely contains the default 512 MB accumulator budget on a
4 GiB host. Adjust both values using [tuning.md](tuning.md#heap-size) for larger
ledgers.

```bash
cd "$REPO_DIR"
export NODE_OPTIONS=--max-old-space-size=2048
export TLS_CA_CERT="$PWD/managedblockchain-tls-chain.pem"

amb-migrate extract \
  --manifest ~/fabric-amb-live-output/manifest.json \
  --tier 3 \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --output-dir ~/fabric-amb-live-output \
  --concurrency 1 \
  --memory-limit 512

amb-migrate validate \
  --input-dir ~/fabric-amb-live-output | tee ~/source-validation.txt
```

Do not continue unless validation exits 0 and every warning is understood and
accepted. For a clean sample run, require zero failures and zero warnings.

Capture concise evidence without copying secret values or private ledger values
into logs:

```bash
jq '{networkId,memberId,nodeId,ambFrameworkVersion,stateDb,mspId,
     channels:[.channels[]|{channelId,ledgerHeight,
       chaincodes:(.chaincodes|map({name,version,
         collections:(.collections|map({name,implicit,blockToLive}))}))}]}' \
  ~/fabric-amb-live-output/manifest.json > ~/manifest-summary.json

jq -s 'map({channelId,tier,nodeId,ledgerHeight,blocksWithoutMetadata,
  privateDataCoverage,outputFiles})' \
  ~/fabric-amb-live-output/channel-*/metadata.json \
  > ~/metadata-summary.json

find ~/fabric-amb-live-output -type f -name '*.ndjson' -print0 | sort -z | \
  while IFS= read -r -d '' file; do
    printf '%7s %s\n' "$(wc -l < "$file")" \
      "${file#"$HOME/fabric-amb-live-output/"}"
  done > ~/record-counts.txt
```

Store evidence in an approved location before terminating the host. Do not copy
raw extraction data unless its owners approved that destination.

## 9. Fabric 2.5 destination replay test

The checked-in script clones the open-source `fabric-samples` repository,
downloads Fabric **2.5.11** and Fabric CA 1.5.12 binaries/images, starts the
Org1/Org2 test-network with CouchDB, creates `mychannel` and `tradechannel`,
deploys `sample_assets` and both `trade_registry` channel definitions with the
migration contract, generates replay configuration, replays current state, and
runs destination verification.

> **Sample-topology prerequisite:** The one-command script applies only when the
> source extraction contains `mychannel` and `tradechannel` with the
> `sample_assets`/`trade_registry` deployment matrix produced by this repository's
> sample setup. For another AMB network, prepare destination channels and
> same-named chaincode packages yourself, then build a replay config from that
> extraction; do not run this script and assume it models an arbitrary source.

```bash
cd "$REPO_DIR"
export FABRIC_SAMPLES_DIR="$HOME/fabric-samples"
export GOPATH="${GOPATH:-$HOME/go}"
export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}"
mkdir -p "$GOMODCACHE" "$GOCACHE"

./sample/scripts/destination/run-migration-test.sh \
  --input-dir "$HOME/fabric-amb-live-output" | \
  tee "$HOME/fabric-25-migration-test.txt"
```

A successful run must report:

- `Records failed: 0`.
- Zero mismatch, missing, query error, and extra destination records.
- Every skip reason and affected namespace explicitly listed. The sample's
  U+0000 composite keys are replayed but intentionally skipped by one-key
  verification.

The sample config replays **current state**, even when the input is Tier 3. It
does not test Fabric history replay. Private history cannot be queried back from
a Fabric destination because Fabric exposes no private-history API.

Inspect host capacity during the run:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
df -h /
free -h
```

Stop and resize the disposable host instead of allowing an OOM or full root
volume to corrupt evidence.

## 10. Teardown

### 10.1 Local Fabric network

Run on the host even after a failed replay:

```bash
cd "$REPO_DIR"
export FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$HOME/fabric-samples}"
./sample/scripts/destination/teardown-test-network.sh

docker ps -a --format '{{.Names}}' | \
  grep -E 'peer0|orderer|couchdb|ca_org|ca_orderer|dev-peer' || true
```

The final command should return no Fabric containers. The teardown script also
removes generated chaincode images, network volumes, deployment-package copies,
generated destination connection/replay configs, and migration/vendor directories
that setup marked as created by this test. Pre-existing vendor caches are retained.

### 10.2 AWS resources

Run from the operator workstation. Copy approved evidence first. Terminate the
instance before deleting its role/profile and endpoint.

```bash
aws ec2 terminate-instances --profile "$AWS_PROFILE" --region "$REGION" \
  --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --profile "$AWS_PROFILE" --region "$REGION" \
  --instance-ids "$INSTANCE_ID"

if [ "${CREATED_VPC_ENDPOINT:-false}" = true ]; then
  aws ec2 delete-vpc-endpoints --profile "$AWS_PROFILE" --region "$REGION" \
    --vpc-endpoint-ids "$VPC_ENDPOINT_ID"

  # Interface endpoint deletion is asynchronous. Wait until its ENI releases
  # the security group; there is no EC2 endpoint-deleted waiter.
  for ((attempt=1; attempt<=60; attempt++)); do
    if ! aws ec2 describe-vpc-endpoints \
      --profile "$AWS_PROFILE" --region "$REGION" \
      --vpc-endpoint-ids "$VPC_ENDPOINT_ID" >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
  if aws ec2 describe-vpc-endpoints \
    --profile "$AWS_PROFILE" --region "$REGION" \
    --vpc-endpoint-ids "$VPC_ENDPOINT_ID" >/dev/null 2>&1; then
    echo "ERROR: endpoint $VPC_ENDPOINT_ID still exists; keep its security group" >&2
    exit 1
  fi
fi

aws iam remove-role-from-instance-profile --profile "$AWS_PROFILE" \
  --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"
aws iam delete-instance-profile --profile "$AWS_PROFILE" \
  --instance-profile-name "$PROFILE_NAME"
aws iam detach-role-policy --profile "$AWS_PROFILE" \
  --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role-policy --profile "$AWS_PROFILE" \
  --role-name "$ROLE_NAME" --policy-name FabricAmbExtractorLiveTest
aws iam delete-role --profile "$AWS_PROFILE" --role-name "$ROLE_NAME"
```

If a temporary source-transfer bucket was created, empty it before deleting it:

```bash
if [ "${CREATED_TRANSFER_BUCKET:-false}" = true ] && \
   [ -n "${TRANSFER_BUCKET:-}" ]; then
  aws s3 rm "s3://$TRANSFER_BUCKET" --recursive --profile "$AWS_PROFILE"
  aws s3api delete-bucket --profile "$AWS_PROFILE" --region "$REGION" \
    --bucket "$TRANSFER_BUCKET"
fi
```

Delete the security group only when `CREATED_SG=true`; never delete an approved
pre-existing group:

```bash
if [ "${CREATED_SG:-false}" = true ]; then
  aws ec2 delete-security-group --profile "$AWS_PROFILE" --region "$REGION" \
    --group-id "$SG_ID"
fi
```

A secret created specifically for this test is still a separate destructive
decision. Keep it by default. If the credential owner explicitly approves
removal, schedule deletion with a recovery window rather than forcing immediate
deletion:

```bash
# Run only with explicit credential-owner approval.
aws secretsmanager delete-secret --profile "$AWS_PROFILE" --region "$REGION" \
  --secret-id "$SECRET_NAME" --recovery-window-in-days 7
```

### 10.3 Verify cleanup

```bash
aws ec2 describe-instances --profile "$AWS_PROFILE" --region "$REGION" \
  --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name'

# A created endpoint should eventually return InvalidVpcEndpointId.NotFound.
if [ "${CREATED_VPC_ENDPOINT:-false}" = true ]; then
  aws ec2 describe-vpc-endpoints --profile "$AWS_PROFILE" --region "$REGION" \
    --vpc-endpoint-ids "$VPC_ENDPOINT_ID"
fi

# Dedicated role/profile lookups should return NoSuchEntity.
aws iam get-role --profile "$AWS_PROFILE" --role-name "$ROLE_NAME"
aws iam get-instance-profile --profile "$AWS_PROFILE" \
  --instance-profile-name "$PROFILE_NAME"
```

Record which pre-existing resources and secrets were intentionally retained.
The test is not finished until temporary containers, EC2 storage, endpoint ENIs,
transfer objects, and dedicated IAM resources are gone or have an explicit
owner and expiration date.

## 11. Acceptance evidence checklist

- [ ] AWS account, region, network, member, node, VPC, subnet, and security group recorded.
- [ ] Endpoint private DNS and peer TLS verified.
- [ ] Reviewed source revision recorded.
- [ ] Admin credential retrieved without appearing in logs or shell history.
- [ ] Discovery lists every in-scope channel, chaincode, and collection.
- [ ] Manifest and channel metadata record the exact source `nodeId`.
- [ ] All expected blocks pass hash-chain verification.
- [ ] Private delivery completes for every in-scope channel.
- [ ] Source `validate` exits 0; warnings are zero or individually accepted.
- [ ] Fabric 2.5 setup deploys the complete source chaincode/channel matrix.
- [ ] Replay reports zero failed records and no skipped channel.
- [ ] Verify reports zero mismatch, missing, error, and extra records.
- [ ] Every verification skip is explicit and reviewed.
- [ ] Evidence summaries stored in an approved location.
- [ ] Local Fabric containers/images/volumes removed.
- [ ] Disposable EC2, endpoint, transfer bucket/object, IAM role/profile removed.
- [ ] Pre-existing VPC/subnet/security group/secret retained unless separately approved for deletion.
