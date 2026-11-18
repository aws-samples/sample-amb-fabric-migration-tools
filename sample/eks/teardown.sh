#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Remove the fabric-eks test environment. Run from the laptop with AWS_PROFILE set. Irreversible: ledgers are deleted.
set -euo pipefail
export AWS_REGION=${AWS_REGION:?set AWS_REGION to the cluster region}
ACCT=$(aws sts get-caller-identity --query Account --output text)
ZONE_ID=${FABRIC_EKS_ZONE_ID:?set FABRIC_EKS_ZONE_ID to the exact private hosted-zone ID created for this test}
read -r -p "Delete cluster fabric-eks, its VPC, the devbox, private zone $ZONE_ID and bucket fabric-eks-$ACCT-$AWS_REGION in $AWS_REGION? [type yes] " a; [ "$a" = yes ]
# 1. In-cluster load balancer first (it holds ENIs in the VPC): delete the Istio gateway service from the devbox, or:
#    DEVBOX_ID=... ./dbx.sh - <<< 'export PATH=$HOME/bin:$PATH; helm uninstall istio-ingressgateway -n istio-system'
# 2. Private zone records, then the zone
VPC_ID=$(aws eks describe-cluster --name fabric-eks --region "$AWS_REGION" \
  --query cluster.resourcesVpcConfig.vpcId --output text)
read -r ZONE_NAME PRIVATE_ZONE < <(aws route53 get-hosted-zone --id "$ZONE_ID" \
  --query '[HostedZone.Name,HostedZone.Config.PrivateZone]' --output text)
[ "$ZONE_NAME" = fab.internal. ] && [ "$PRIVATE_ZONE" = True ] || {
  echo "$ZONE_ID is not the private fab.internal. zone" >&2
  exit 1
}
ZONE_VPC=$(aws route53 get-hosted-zone --id "$ZONE_ID" \
  --query "VPCs[?VPCId=='$VPC_ID'].VPCId | [0]" --output text)
[ "$ZONE_VPC" = "$VPC_ID" ] || {
  echo "$ZONE_ID is not associated with cluster VPC $VPC_ID" >&2
  exit 1
}
aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Type=='A']" --output json | \
  python3 -c "import json,sys; r=json.load(sys.stdin); print(json.dumps({'Changes':[{'Action':'DELETE','ResourceRecordSet':x} for x in r]}))" > /tmp/del.json
[ "$(python3 -c "import json; print(len(json.load(open('/tmp/del.json'))['Changes']))")" -eq 0 ] || \
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch file:///tmp/del.json >/dev/null
aws route53 delete-hosted-zone --id "$ZONE_ID" >/dev/null
rm -f /tmp/del.json
# 3. Devbox stack (its role holds the cluster access entry, removed with the cluster)
aws cloudformation delete-stack --stack-name fabric-eks-devbox && aws cloudformation wait stack-delete-complete --stack-name fabric-eks-devbox
# 4. Cluster, node group, VPC (eksctl stacks)
eksctl delete cluster --name fabric-eks --region "$AWS_REGION" --wait
# 5. Bucket (archive copies and tool source)
aws s3 rb "s3://fabric-eks-$ACCT-$AWS_REGION" --force
echo "removed"
