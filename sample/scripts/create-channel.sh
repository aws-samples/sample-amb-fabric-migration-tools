#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Create a channel on AMB and join the peer to it.
#
# This script:
#   1. Generates a configtx.yaml for the member
#   2. Runs configtxgen to create the channel creation transaction
#   3. Submits the channel creation to the orderer
#   4. Fetches the genesis block
#   5. Joins the peer to the channel
#
# Already joined, or the channel already exists? Both are detected and the script
# exits successfully, so a second member joins an existing channel by running it
# with that member's environment.
#
# Two members: set MSP_ID_2 and MSP_PATH_2 and the generated configtx carries both
# organizations, so a channel created here can hold private data collections whose
# policy names either or both. Leave them unset for a single-member channel.
#
# Prerequisites:
#   - setup-cloudshell.sh has been run
#   - enroll-admin.sh has been run (for every member named in the config)
#   - The environment is loaded
#
# This script reads the environment and never loads it: source resolve-network.sh
# or env.sh yourself first. That is what makes a per-invocation override work —
# run-full-test.sh relies on `CHANNEL_NAME=tradechannel bash create-channel.sh`,
# and sourcing env.sh from in here would silently create mychannel twice.
#
# Usage:
#   source sample/scripts/env.sh
#   ./sample/scripts/create-channel.sh
#
set -euo pipefail

for var in NETWORK_ID MEMBER_ID NODE_ID CHANNEL_NAME REGION MSP_ID TLS_CA_CERT MSP_PATH; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

# ── Resolve endpoints ──
PEER_ENDPOINT=$(aws managedblockchain get-node \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' \
  --output text)

ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

echo "═══════════════════════════════════════════════════════════"
echo " Creating channel: $CHANNEL_NAME"
echo " Peer:    $PEER_ENDPOINT"
echo " Orderer: $ORDERER_ENDPOINT"
echo " MSP ID:  $MSP_ID"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Fabric environment ──
export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
export CORE_PEER_LOCALMSPID="$MSP_ID"
export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"

# ── Working directory ──
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# ── Step 1: Check if channel already exists ──
echo "=== Step 1: Checking if channel exists ==="
if peer channel fetch newest "$WORK_DIR/check.block" \
  -c "$CHANNEL_NAME" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls 2>/dev/null; then
  echo "  Channel '$CHANNEL_NAME' already exists."
  echo ""
  echo "  Checking if peer has joined..."
  CHANNELS=$(peer channel list 2>&1 || true)
  if echo "$CHANNELS" | grep -q "$CHANNEL_NAME"; then
    echo "  Peer is already a member of '$CHANNEL_NAME'."
    echo "  Nothing to do."
    exit 0
  else
    echo "  Peer has NOT joined. Fetching genesis block and joining..."
    # Skip to the join step
    peer channel fetch oldest "$WORK_DIR/${CHANNEL_NAME}.block" \
      -c "$CHANNEL_NAME" \
      -o "$ORDERER_ENDPOINT" \
      --cafile "$TLS_CA_CERT" \
      --tls

    peer channel join \
      -b "$WORK_DIR/${CHANNEL_NAME}.block" \
      -o "$ORDERER_ENDPOINT" \
      --cafile "$TLS_CA_CERT" \
      --tls

    echo ""
    echo "✓ Peer joined channel '$CHANNEL_NAME'"
    exit 0
  fi
fi

echo "  Channel does not exist yet — creating."
echo ""

# ── Step 2: Generate configtx.yaml ──
echo "=== Step 2: Generating configtx.yaml ==="

# ── Second organization (optional) ──
# Validated here rather than at the top of the script, because the join paths
# above need none of it: a second member joining a channel this script already
# created must not be turned away over the config it is not about to generate.
#
# Both halves or neither: an MSP ID with no directory would generate a configtx
# that configtxgen rejects with a path error, several steps away from the cause.
if [ -n "${MSP_ID_2:-}" ] || [ -n "${MSP_PATH_2:-}" ]; then
  if [ -z "${MSP_ID_2:-}" ] || [ -z "${MSP_PATH_2:-}" ]; then
    echo "ERROR: set both MSP_ID_2 and MSP_PATH_2, or neither" >&2
    exit 1
  fi
  if [ ! -d "$MSP_PATH_2" ]; then
    echo "ERROR: MSP_PATH_2 ($MSP_PATH_2) is not a directory." >&2
    echo "  Enroll the second member's admin first:" >&2
    echo "    MEMBER_ID=$MSP_ID_2 MSP_PATH=$MSP_PATH_2 ./enroll-admin.sh" >&2
    exit 1
  fi
  if [ "$MSP_ID_2" = "$MSP_ID" ]; then
    echo "ERROR: MSP_ID_2 is the same member as MSP_ID ($MSP_ID)." >&2
    echo "  Both organizations in the generated config would be this one member." >&2
    exit 1
  fi
fi

# Built as text and interpolated into the template below, so the single-member
# config parses to exactly the structure it always did when MSP_ID_2 is unset —
# the only textual difference is the blank line each empty placeholder leaves.
ORG2_DEFINITION=""
ORG2_PROFILE_ENTRY=""
PROFILE_NAME="OneOrgChannel"
if [ -n "${MSP_ID_2:-}" ]; then
  PROFILE_NAME="TwoOrgChannel"
  ORG2_PROFILE_ENTRY="                - <<: *Org2"
  ORG2_DEFINITION=$(cat << ORG2EOF
    - &Org2
        Name: ${MSP_ID_2}
        ID: ${MSP_ID_2}
        SkipAsForeign: false
        Policies: &Org2Policies
            Readers:
                Type: Signature
                Rule: "OR('${MSP_ID_2}.member')"
            Writers:
                Type: Signature
                Rule: "OR('${MSP_ID_2}.member')"
            Admins:
                Type: Signature
                Rule: "OR('${MSP_ID_2}.admin')"
        MSPDir: ${MSP_PATH_2}
ORG2EOF
)
  echo "  Second organization: $MSP_ID_2 (MSPDir $MSP_PATH_2)"
fi

# Note: In configtx.yaml, the org Name and ID must match the MSP ID.
# The policy rules reference the org by its ID (e.g., 'MSP_ID.member').
# MSPDir points to the enrolled admin MSP directory.
cat > "$WORK_DIR/configtx.yaml" << CONFIGEOF
################################################################################
#   Organizations
################################################################################
Organizations:
    - &Org1
        Name: ${MSP_ID}
        ID: ${MSP_ID}
        SkipAsForeign: false
        Policies: &Org1Policies
            Readers:
                Type: Signature
                Rule: "OR('${MSP_ID}.member')"
            Writers:
                Type: Signature
                Rule: "OR('${MSP_ID}.member')"
            Admins:
                Type: Signature
                Rule: "OR('${MSP_ID}.admin')"
        MSPDir: ${MSP_PATH}
${ORG2_DEFINITION}

################################################################################
#   Capabilities
################################################################################
Capabilities:
    Channel: &ChannelCapabilities
        V2_0: true
    Orderer: &OrdererCapabilities
        V2_0: true
    Application: &ApplicationCapabilities
        V2_0: true

################################################################################
#   Channel
################################################################################
Channel: &ChannelDefaults
    Policies:
        Readers:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Writers:
            Type: ImplicitMeta
            Rule: "ANY Writers"
        Admins:
            Type: ImplicitMeta
            Rule: "MAJORITY Admins"
    Capabilities:
        <<: *ChannelCapabilities

################################################################################
#   Application
################################################################################
Application: &ApplicationDefaults
    Organizations:
    Policies: &ApplicationDefaultPolicies
        LifecycleEndorsement:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Endorsement:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Readers:
            Type: ImplicitMeta
            Rule: "ANY Readers"
        Writers:
            Type: ImplicitMeta
            Rule: "ANY Writers"
        Admins:
            Type: ImplicitMeta
            Rule: "MAJORITY Admins"
    Capabilities:
        <<: *ApplicationCapabilities

################################################################################
#   Profiles
################################################################################
Profiles:
    ${PROFILE_NAME}:
        <<: *ChannelDefaults
        Consortium: AWSSystemConsortium
        Application:
            <<: *ApplicationDefaults
            Organizations:
                - <<: *Org1
${ORG2_PROFILE_ENTRY}
CONFIGEOF

echo "  Generated: $WORK_DIR/configtx.yaml"

# ── Step 3: Generate channel creation transaction ──
echo ""
echo "=== Step 3: Generating channel creation transaction ==="

configtxgen \
  -outputCreateChannelTx "$WORK_DIR/${CHANNEL_NAME}.pb" \
  -profile "$PROFILE_NAME" \
  -channelID "$CHANNEL_NAME" \
  --configPath "$WORK_DIR"

echo "  Generated: $WORK_DIR/${CHANNEL_NAME}.pb"

# ── Step 4: Create the channel ──
echo ""
echo "=== Step 4: Creating channel ==="

peer channel create \
  -c "$CHANNEL_NAME" \
  -f "$WORK_DIR/${CHANNEL_NAME}.pb" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls

echo "  Channel '$CHANNEL_NAME' created"

# ── Step 5: Fetch the genesis block ──
echo ""
echo "=== Step 5: Fetching genesis block ==="

# The create command may output the block to the current directory;
# also fetch explicitly to be sure.
peer channel fetch oldest "$WORK_DIR/${CHANNEL_NAME}.block" \
  -c "$CHANNEL_NAME" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls

echo "  Genesis block: $WORK_DIR/${CHANNEL_NAME}.block"

# ── Step 6: Join peer to channel ──
echo ""
echo "=== Step 6: Joining peer to channel ==="

peer channel join \
  -b "$WORK_DIR/${CHANNEL_NAME}.block" \
  -o "$ORDERER_ENDPOINT" \
  --cafile "$TLS_CA_CERT" \
  --tls

# ── Verify ──
echo ""
echo "=== Verifying ==="
peer channel list

echo ""
echo "✓ Channel '$CHANNEL_NAME' created and peer joined"
echo ""
echo "Next: ./sample/scripts/configure-anchor-peer.sh"
