#!/usr/bin/env bash
#
# Record every member of an AMB network, with its peer, for the rest of the
# multi-member harness.
#
# Writes $MM_HOME/network.env, $MM_HOME/members.list and one
# $MM_HOME/members/<name>.env per member that owns an AVAILABLE peer node.
# All of it comes from the AMB API; nothing is assumed about port numbers,
# which differ per member.
#
# Usage:
#   ./init.sh --network-name <network-name> [--region us-east-1]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"

NETWORK_NAME=""
REGION="${REGION:-us-east-1}"
while [ $# -gt 0 ]; do
  case "$1" in
    --network-name) NETWORK_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) mm_die "unknown option $1" ;;
  esac
done
[ -n "$NETWORK_NAME" ] || mm_die "--network-name is required"

NETWORK_ID=$(aws managedblockchain list-networks --region "$REGION" \
  --name "$NETWORK_NAME" --status AVAILABLE \
  --query 'Networks[0].Id' --output text)
[ "$NETWORK_ID" != "None" ] || mm_die "no AVAILABLE network named $NETWORK_NAME in $REGION"

ORDERER_ENDPOINT=$(aws managedblockchain get-network --region "$REGION" \
  --network-id "$NETWORK_ID" \
  --query 'Network.FrameworkAttributes.Fabric.OrderingServiceEndpoint' --output text)

mkdir -p "$MM_HOME/members"
cat > "$MM_HOME/network.env" <<EOF
NETWORK_NAME=$NETWORK_NAME
NETWORK_ID=$NETWORK_ID
REGION=$REGION
ORDERER_ENDPOINT=$ORDERER_ENDPOINT
EOF

: > "$MM_HOME/members.list"
# Sorted by name so every host and every rerun agrees on member order, which is
# what the collection templates' Org1MSP/Org2MSP/Org3MSP positions refer to.
aws managedblockchain list-members --region "$REGION" --network-id "$NETWORK_ID" \
  --status AVAILABLE --query 'Members[?IsOwned].[Name,Id]' --output text | sort |
while read -r name member_id; do
  node_id=$(aws managedblockchain list-nodes --region "$REGION" \
    --network-id "$NETWORK_ID" --member-id "$member_id" --status AVAILABLE \
    --query 'Nodes[0].Id' --output text)
  if [ "$node_id" = "None" ]; then
    echo "  skipping $name ($member_id): no AVAILABLE peer node" >&2
    continue
  fi
  peer=$(aws managedblockchain get-node --region "$REGION" --network-id "$NETWORK_ID" \
    --member-id "$member_id" --node-id "$node_id" \
    --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' --output text)
  ca=$(aws managedblockchain get-member --region "$REGION" --network-id "$NETWORK_ID" \
    --member-id "$member_id" \
    --query 'Member.FrameworkAttributes.Fabric.CaEndpoint' --output text)
  cat > "$MM_HOME/members/$name.env" <<EOF
MEMBER_NAME=$name
MEMBER_ID=$member_id
NODE_ID=$node_id
PEER_ENDPOINT=$peer
CA_ENDPOINT=$ca
EOF
  echo "$name" >> "$MM_HOME/members.list"
  echo "  $name  $member_id  $node_id  $peer"
done

echo "Network $NETWORK_NAME ($NETWORK_ID): $(wc -l < "$MM_HOME/members.list") member(s) recorded under $MM_HOME"
