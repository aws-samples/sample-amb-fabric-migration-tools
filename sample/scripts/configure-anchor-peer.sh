#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Configure an anchor peer on an Amazon Managed Blockchain channel.
#
# Anchor peers are required for cross-org gossip discovery. Without an anchor
# peer configured, other members' peers cannot discover your org's peers,
# which breaks:
#   - Private data collection dissemination
#   - Service discovery (used by fabric-gateway for endorsement routing)
#   - Cross-org chaincode invocation
#
# This script automates the channel config update process described in:
# https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/hyperledger-anchor-peers.html
#
# It uses configtxlator (included in Fabric tools) to:
#   1. Fetch the current channel config block
#   2. Decode protobuf → JSON
#   3. Inject the AnchorPeers value for your org
#   4. Compute the config delta
#   5. Wrap in an envelope and submit the update
#
# Prerequisites:
#   - peer and configtxlator binaries on PATH (from Fabric tools)
#   - jq installed
#   - Same env vars as deploy-chaincode.sh
#
# Usage:
#   export NETWORK_ID=n-XXXXXXXXXX
#   export MEMBER_ID=m-XXXXXXXXXX
#   export NODE_ID=nd-XXXXXXXXXX
#   export CHANNEL_NAME=mychannel
#   export REGION=us-east-1
#   export MSP_ID=m-XXXXXXXXXX
#   export TLS_CA_CERT=/path/to/managedblockchain-tls-chain.pem
#   export MSP_PATH=/path/to/admin-msp
#
#   ./configure-anchor-peer.sh
#
set -euo pipefail

# ── Validate required env vars ──
for var in NETWORK_ID MEMBER_ID NODE_ID CHANNEL_NAME REGION MSP_ID TLS_CA_CERT MSP_PATH; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

# ── Check required tools ──
for cmd in peer configtxlator jq aws; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed or not on PATH" >&2
    exit 1
  fi
done

# ── Resolve AMB peer endpoint ──
PEER_ENDPOINT=$(aws managedblockchain get-node \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' \
  --output text)

# AMB peer endpoint format: nd-XXXX.m-XXXX.n-XXXX.managedblockchain.<region>.amazonaws.com:30003
# Anchor peer host = endpoint without the port
PEER_HOST="${PEER_ENDPOINT%%:*}"
PEER_PORT="${PEER_ENDPOINT##*:}"
ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

echo "Peer endpoint: $PEER_ENDPOINT"
echo "Anchor peer:   $PEER_HOST:$PEER_PORT"
echo "Orderer:       $ORDERER_ENDPOINT"

# ── Fabric environment ──
export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
export CORE_PEER_LOCALMSPID="$MSP_ID"
export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"

# ── Working directory ──
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
echo "Working directory: $WORK_DIR"
echo ""

# ── Step 1: Fetch current channel config ──
echo "=== Step 1: Fetching channel config block ==="
peer channel fetch config "$WORK_DIR/config_block.pb" \
  -c "$CHANNEL_NAME" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls

# ── Step 2: Decode protobuf to JSON ──
echo ""
echo "=== Step 2: Decoding config block ==="
configtxlator proto_decode \
  --input "$WORK_DIR/config_block.pb" \
  --type common.Block \
  --output "$WORK_DIR/config_block.json"

# Extract the config object from the block
jq '.data.data[0].payload.data.config' "$WORK_DIR/config_block.json" > "$WORK_DIR/config.json"

# ── Step 3: Check if anchor peer is already configured ──
echo ""
echo "=== Step 3: Checking existing anchor peer config ==="

EXISTING_ANCHOR=$(jq -r \
  ".channel_group.groups.Application.groups[\"$MSP_ID\"].values.AnchorPeers // empty" \
  "$WORK_DIR/config.json")

if [ -n "$EXISTING_ANCHOR" ]; then
  EXISTING_HOST=$(echo "$EXISTING_ANCHOR" | jq -r '.value.anchor_peers[0].host // empty')
  EXISTING_PORT=$(echo "$EXISTING_ANCHOR" | jq -r '.value.anchor_peers[0].port // empty')
  if [ "$EXISTING_HOST" = "$PEER_HOST" ] && [ "$EXISTING_PORT" = "$PEER_PORT" ]; then
    echo "Anchor peer already configured for $MSP_ID: $EXISTING_HOST:$EXISTING_PORT"
    echo "Nothing to do."
    exit 0
  fi
  echo "Updating existing anchor peer from $EXISTING_HOST:$EXISTING_PORT to $PEER_HOST:$PEER_PORT"
else
  echo "No anchor peer configured for $MSP_ID — adding $PEER_HOST:$PEER_PORT"
fi

# ── Step 4: Inject anchor peer into config ──
echo ""
echo "=== Step 4: Adding anchor peer to config ==="

jq ".channel_group.groups.Application.groups[\"$MSP_ID\"].values += {
  \"AnchorPeers\": {
    \"mod_policy\": \"Admins\",
    \"value\": {
      \"anchor_peers\": [{
        \"host\": \"$PEER_HOST\",
        \"port\": $PEER_PORT
      }]
    },
    \"version\": \"0\"
  }
}" "$WORK_DIR/config.json" > "$WORK_DIR/modified_config.json"

# Verify the modification
echo "Verifying modification..."
jq ".channel_group.groups.Application.groups[\"$MSP_ID\"].values.AnchorPeers.value.anchor_peers" \
  "$WORK_DIR/modified_config.json"

# ── Step 5: Encode both configs and compute delta ──
echo ""
echo "=== Step 5: Computing config update delta ==="

configtxlator proto_encode \
  --input "$WORK_DIR/config.json" \
  --type common.Config \
  --output "$WORK_DIR/config.pb"

configtxlator proto_encode \
  --input "$WORK_DIR/modified_config.json" \
  --type common.Config \
  --output "$WORK_DIR/modified_config.pb"

configtxlator compute_update \
  --channel_id "$CHANNEL_NAME" \
  --original "$WORK_DIR/config.pb" \
  --updated "$WORK_DIR/modified_config.pb" \
  --output "$WORK_DIR/config_update.pb"

# ── Step 6: Decode update, wrap in envelope, re-encode ──
echo ""
echo "=== Step 6: Building config update envelope ==="

configtxlator proto_decode \
  --input "$WORK_DIR/config_update.pb" \
  --type common.ConfigUpdate \
  --output "$WORK_DIR/config_update.json"

# Wrap the config update in a proper transaction envelope
jq -n --arg channel "$CHANNEL_NAME" --slurpfile update "$WORK_DIR/config_update.json" '{
  "payload": {
    "header": {
      "channel_header": {
        "channel_id": $channel,
        "type": 2
      }
    },
    "data": {
      "config_update": $update[0]
    }
  }
}' > "$WORK_DIR/config_update_envelope.json"

configtxlator proto_encode \
  --input "$WORK_DIR/config_update_envelope.json" \
  --type common.Envelope \
  --output "$WORK_DIR/config_update_envelope.pb"

# ── Step 7: Submit the channel config update ──
echo ""
echo "=== Step 7: Submitting anchor peer update ==="

peer channel update \
  -f "$WORK_DIR/config_update_envelope.pb" \
  -c "$CHANNEL_NAME" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls

echo ""
echo "✓ Anchor peer configured for $MSP_ID on channel '$CHANNEL_NAME'"
echo "  Host: $PEER_HOST"
echo "  Port: $PEER_PORT"
echo ""
echo "Other members can now discover this org's peers via gossip."
echo "This is required for private data collection dissemination."
