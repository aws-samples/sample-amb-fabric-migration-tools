#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Auto-discover AMB network configuration and export environment variables.
#
# Given just a network name (or network ID) and admin credentials, this script
# resolves everything else via the AWS Managed Blockchain API:
#
#   NETWORK_ID  ← from network name lookup (or pass directly)
#   MEMBER_ID   ← --member-id, --member-name, else first AVAILABLE member
#   NODE_ID     ← --node-id, else first AVAILABLE peer node for that member
#   MSP_ID      ← same as MEMBER_ID on AMB
#   REGION      ← current AWS CLI region
#   PEER_ENDPOINT, ORDERER_ENDPOINT, CA_ENDPOINT ← from node/member metadata
#
# The only values you must provide:
#   - Network name or NETWORK_ID
#   - ADMIN_USERNAME and ADMIN_PASSWORD (set during member creation, not retrievable via API)
#   - CHANNEL_NAME (defaults to "mychannel")
#
# Usage — source this script so variables are exported to your shell:
#
#   # By network name:
#   source sample/scripts/resolve-network.sh --network-name "my-fabric-network"
#
#   # By network ID:
#   source sample/scripts/resolve-network.sh --network-id n-XXXXXXXXXX
#
#   # With all options (--admin-password is for disposable test networks; it
#   # lands in shell history, so otherwise export ADMIN_PASSWORD instead):
#   source sample/scripts/resolve-network.sh \
#     --network-name "my-fabric-network" \
#     --admin-username admin \
#     --admin-password 'MyP@ssw0rd' \
#     --channel mychannel \
#     --region us-east-1
#
#   # Then run any other script — env vars are already set:
#   ./sample/scripts/enroll-admin.sh
#
# A network with more than one member needs --member-name or --member-id to say
# which one, and --msp-path to keep the second member's identity out of the
# first's directory. Without them a re-source silently lands back on the first
# AVAILABLE member, still holding the first member's admin MSP:
#
#   source sample/scripts/resolve-network.sh --network-id n-XXXXXXXXXX \
#     --member-name org2 --msp-path "$HOME/admin-msp-org2"
#

# Don't use set -e when sourced — we want to keep the shell alive on errors.
# Instead, use explicit error checks.

# ── Parse arguments ──
_RESOLVE_NETWORK_NAME=""
_RESOLVE_NETWORK_ID=""
_RESOLVE_REGION=""
_RESOLVE_CHANNEL=""
_RESOLVE_ADMIN_USER=""
_RESOLVE_ADMIN_PASS=""
_RESOLVE_MEMBER_ID=""
_RESOLVE_MEMBER_NAME=""
_RESOLVE_NODE_ID=""
_RESOLVE_MSP_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network-name)  _RESOLVE_NETWORK_NAME="$2"; shift 2 ;;
    --network-id)    _RESOLVE_NETWORK_ID="$2"; shift 2 ;;
    --region)        _RESOLVE_REGION="$2"; shift 2 ;;
    --channel)       _RESOLVE_CHANNEL="$2"; shift 2 ;;
    --admin-username) _RESOLVE_ADMIN_USER="$2"; shift 2 ;;
    --admin-password) _RESOLVE_ADMIN_PASS="$2"; shift 2 ;;
    --member-id)     _RESOLVE_MEMBER_ID="$2"; shift 2 ;;
    --member-name)   _RESOLVE_MEMBER_NAME="$2"; shift 2 ;;
    --node-id)       _RESOLVE_NODE_ID="$2"; shift 2 ;;
    --msp-path)      _RESOLVE_MSP_PATH="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: source resolve-network.sh --network-name <name> [--admin-username <user>] [--admin-password <pass>] [--channel <ch>] [--region <r>] [--member-name <name> | --member-id <m-...>] [--node-id <nd-...>] [--msp-path <dir>]" >&2
      return 1 2>/dev/null || exit 1
      ;;
  esac
done

if [ -z "$_RESOLVE_NETWORK_NAME" ] && [ -z "$_RESOLVE_NETWORK_ID" ]; then
  echo "ERROR: Provide --network-name or --network-id" >&2
  return 1 2>/dev/null || exit 1
fi

if [ -n "$_RESOLVE_MEMBER_ID" ] && [ -n "$_RESOLVE_MEMBER_NAME" ]; then
  echo "ERROR: Provide --member-id or --member-name, not both" >&2
  return 1 2>/dev/null || exit 1
fi

# ── Resolve region ──
if [ -n "$_RESOLVE_REGION" ]; then
  export REGION="$_RESOLVE_REGION"
elif [ -z "${REGION:-}" ]; then
  REGION=$(aws configure get region 2>/dev/null || echo "")
  if [ -z "$REGION" ]; then
    REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
  fi
  if [ -z "$REGION" ]; then
    echo "ERROR: Could not determine AWS region. Set --region, AWS_DEFAULT_REGION, or aws configure set region." >&2
    return 1 2>/dev/null || exit 1
  fi
  export REGION
fi

echo "Region: $REGION"

# ── Resolve Network ID from name ──
if [ -n "$_RESOLVE_NETWORK_ID" ]; then
  export NETWORK_ID="$_RESOLVE_NETWORK_ID"
  echo "Network ID: $NETWORK_ID (provided)"
else
  echo "Looking up network by name: $_RESOLVE_NETWORK_NAME ..."

  NETWORK_ID=$(aws managedblockchain list-networks \
    --region "$REGION" \
    --query "Networks[?Name=='${_RESOLVE_NETWORK_NAME}' && Status=='AVAILABLE'].Id | [0]" \
    --output text 2>/dev/null)

  if [ -z "$NETWORK_ID" ] || [ "$NETWORK_ID" = "None" ]; then
    echo "ERROR: No AVAILABLE network found with name '$_RESOLVE_NETWORK_NAME'" >&2
    echo ""
    echo "Available networks:" >&2
    aws managedblockchain list-networks \
      --region "$REGION" \
      --query "Networks[].{Name:Name, Id:Id, Status:Status}" \
      --output table 2>/dev/null
    return 1 2>/dev/null || exit 1
  fi

  export NETWORK_ID
  echo "Network ID: $NETWORK_ID"
fi

# ── Resolve Member ID ──
# Printed on every failure below, because "which member did you mean" is the
# question all three of them are really asking.
_resolve_show_members() {
  echo "Members in $NETWORK_ID:" >&2
  aws managedblockchain list-members \
    --network-id "$NETWORK_ID" \
    --region "$REGION" \
    --query "Members[].{Name:Name, Id:Id, Status:Status}" \
    --output table 2>/dev/null
}

if [ -n "$_RESOLVE_MEMBER_ID" ]; then
  MEMBER_ID="$_RESOLVE_MEMBER_ID"
elif [ -n "$_RESOLVE_MEMBER_NAME" ]; then
  echo "Looking up member by name: $_RESOLVE_MEMBER_NAME ..."

  MEMBER_ID=$(aws managedblockchain list-members \
    --network-id "$NETWORK_ID" \
    --region "$REGION" \
    --query "Members[?Name=='${_RESOLVE_MEMBER_NAME}' && Status=='AVAILABLE'].Id | [0]" \
    --output text 2>/dev/null)

  if [ -z "$MEMBER_ID" ] || [ "$MEMBER_ID" = "None" ]; then
    echo "ERROR: No AVAILABLE member named '$_RESOLVE_MEMBER_NAME' in network $NETWORK_ID" >&2
    _resolve_show_members
    unset -f _resolve_show_members
    return 1 2>/dev/null || exit 1
  fi
else
  # No member asked for: the first AVAILABLE one is a convenience for a
  # single-member network, not a stable choice once there are two.
  echo "Looking up members ..."

  MEMBER_ID=$(aws managedblockchain list-members \
    --network-id "$NETWORK_ID" \
    --region "$REGION" \
    --query "Members[?Status=='AVAILABLE'].Id | [0]" \
    --output text 2>/dev/null)

  if [ -z "$MEMBER_ID" ] || [ "$MEMBER_ID" = "None" ]; then
    echo "ERROR: No AVAILABLE member found in network $NETWORK_ID" >&2
    return 1 2>/dev/null || exit 1
  fi

  _RESOLVE_MEMBER_COUNT=$(aws managedblockchain list-members \
    --network-id "$NETWORK_ID" \
    --region "$REGION" \
    --query "length(Members[?Status=='AVAILABLE'])" \
    --output text 2>/dev/null)
  if [ -n "$_RESOLVE_MEMBER_COUNT" ] && [ "$_RESOLVE_MEMBER_COUNT" != "1" ]; then
    echo "  NOTE: $_RESOLVE_MEMBER_COUNT AVAILABLE members — took the first."
    echo "        Pass --member-name or --member-id to choose, and --msp-path to"
    echo "        keep that member's admin identity in its own directory."
  fi
fi

# One call confirms the member exists, is usable, and gives its name. A typo in
# --member-id would otherwise surface as a TLS or MSP error several steps later.
_RESOLVE_MEMBER_INFO=$(aws managedblockchain get-member \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --region "$REGION" \
  --query "Member.[Name,Status]" \
  --output text 2>/dev/null)

if [ -z "$_RESOLVE_MEMBER_INFO" ]; then
  echo "ERROR: Member $MEMBER_ID not found in network $NETWORK_ID" >&2
  _resolve_show_members
  unset -f _resolve_show_members
  return 1 2>/dev/null || exit 1
fi

MEMBER_NAME="${_RESOLVE_MEMBER_INFO%%[[:space:]]*}"
_RESOLVE_MEMBER_STATUS="${_RESOLVE_MEMBER_INFO##*[[:space:]]}"

if [ "$_RESOLVE_MEMBER_STATUS" != "AVAILABLE" ]; then
  echo "ERROR: Member $MEMBER_ID ($MEMBER_NAME) is $_RESOLVE_MEMBER_STATUS, not AVAILABLE" >&2
  _resolve_show_members
  unset -f _resolve_show_members
  return 1 2>/dev/null || exit 1
fi

unset -f _resolve_show_members

export MEMBER_ID
echo "Member ID: $MEMBER_ID ($MEMBER_NAME)"

# ── MSP ID (same as Member ID on AMB) ──
export MSP_ID="$MEMBER_ID"

# ── Resolve Node ID ──
if [ -n "$_RESOLVE_NODE_ID" ]; then
  NODE_ID="$_RESOLVE_NODE_ID"
else
  echo "Looking up peer nodes ..."

  NODE_ID=$(aws managedblockchain list-nodes \
    --network-id "$NETWORK_ID" \
    --member-id "$MEMBER_ID" \
    --region "$REGION" \
    --query "Nodes[?Status=='AVAILABLE'].Id | [0]" \
    --output text 2>/dev/null)

  if [ -z "$NODE_ID" ] || [ "$NODE_ID" = "None" ]; then
    echo "ERROR: No AVAILABLE peer node found for member $MEMBER_ID ($MEMBER_NAME)" >&2
    echo "Create a peer node for this member in the AMB console first." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

export NODE_ID
echo "Node ID: $NODE_ID"

# ── Resolve endpoints ──
echo "Resolving endpoints ..."

PEER_ENDPOINT=$(aws managedblockchain get-node \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --query "Node.FrameworkAttributes.Fabric.PeerEndpoint" \
  --output text 2>/dev/null)

# GetNode is scoped to the member, so a --node-id belonging to the other member
# fails here rather than pointing this environment at a peer it cannot sign for.
if [ -z "$PEER_ENDPOINT" ] || [ "$PEER_ENDPOINT" = "None" ]; then
  echo "ERROR: No peer endpoint for node $NODE_ID under member $MEMBER_ID ($MEMBER_NAME)" >&2
  echo "Nodes belonging to this member:" >&2
  aws managedblockchain list-nodes \
    --network-id "$NETWORK_ID" \
    --member-id "$MEMBER_ID" \
    --region "$REGION" \
    --query "Nodes[].{Id:Id, Status:Status}" \
    --output table 2>/dev/null
  return 1 2>/dev/null || exit 1
fi

CA_ENDPOINT=$(aws managedblockchain get-member \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --region "$REGION" \
  --query "Member.FrameworkAttributes.Fabric.CaEndpoint" \
  --output text 2>/dev/null)

ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

export PEER_ENDPOINT
export ORDERER_ENDPOINT
export CA_ENDPOINT

echo "Peer:    $PEER_ENDPOINT"
echo "Orderer: $ORDERER_ENDPOINT"
echo "CA:      $CA_ENDPOINT"

# ── Channel name ──
export CHANNEL_NAME="${_RESOLVE_CHANNEL:-${CHANNEL_NAME:-mychannel}}"
echo "Channel: $CHANNEL_NAME"

# ── Admin credentials ──
if [ -n "$_RESOLVE_ADMIN_USER" ]; then
  export ADMIN_USERNAME="$_RESOLVE_ADMIN_USER"
fi
if [ -n "$_RESOLVE_ADMIN_PASS" ]; then
  export ADMIN_PASSWORD="$_RESOLVE_ADMIN_PASS"
fi

if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo ""
  echo "WARNING: ADMIN_USERNAME and/or ADMIN_PASSWORD not set."
  echo "These are needed for enroll-admin.sh. Set them with:"
  echo "  export ADMIN_USERNAME=admin"
  echo "  export ADMIN_PASSWORD='your-password'"
fi

# ── Paths ──
export FABRIC_BIN="${FABRIC_BIN:-$HOME/fabric-tools/bin}"
export TLS_CA_CERT="${TLS_CA_CERT:-$HOME/managedblockchain-tls-chain.pem}"
export PATH="$FABRIC_BIN:$PATH"

# --msp-path overrides an inherited MSP_PATH, unlike the defaults above. Sourcing
# this script again for a second member would otherwise keep pointing at the
# first member's admin directory, and that mismatch does not surface until the
# peer rejects the signing identity.
if [ -n "$_RESOLVE_MSP_PATH" ]; then
  export MSP_PATH="$_RESOLVE_MSP_PATH"
else
  export MSP_PATH="${MSP_PATH:-$HOME/admin-msp}"
fi

if [ ! -d "$MSP_PATH" ]; then
  echo ""
  echo "NOTE: $MSP_PATH does not exist yet — enroll this member's admin:"
  echo "  ./sample/scripts/enroll-admin.sh"
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Environment configured"
echo "═══════════════════════════════════════════════════════════"
echo "  NETWORK_ID=$NETWORK_ID"
echo "  MEMBER_ID=$MEMBER_ID"
echo "  NODE_ID=$NODE_ID"
echo "  MSP_ID=$MSP_ID"
echo "  REGION=$REGION"
echo "  CHANNEL_NAME=$CHANNEL_NAME"
echo "  PEER_ENDPOINT=$PEER_ENDPOINT"
echo "  ORDERER_ENDPOINT=$ORDERER_ENDPOINT"
echo "  CA_ENDPOINT=$CA_ENDPOINT"
echo "  TLS_CA_CERT=$TLS_CA_CERT"
echo "  MSP_PATH=$MSP_PATH"
echo "═══════════════════════════════════════════════════════════"

# Clean up internal variables
unset _RESOLVE_NETWORK_NAME _RESOLVE_NETWORK_ID _RESOLVE_REGION
unset _RESOLVE_CHANNEL _RESOLVE_ADMIN_USER _RESOLVE_ADMIN_PASS
unset _RESOLVE_MEMBER_ID _RESOLVE_MEMBER_NAME _RESOLVE_NODE_ID _RESOLVE_MSP_PATH
unset _RESOLVE_MEMBER_COUNT _RESOLVE_MEMBER_INFO _RESOLVE_MEMBER_STATUS
