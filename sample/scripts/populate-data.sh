#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Populate the sample_assets chaincode with test data that exercises every
# extraction path in this toolkit:
#
#   ✓ Public state creates (PutState)
#   ✓ Public state updates/overwrites (only latest in public_state, all in history)
#   ✓ Public state deletes (absent from public_state, isDelete=true in history)
#   ✓ Ownership transfers (read-modify-write pattern)
#   ✓ Composite key index entries (color~id)
#   ✓ Private data creates (PutPrivateData via transient)
#   ✓ Private data updates (overwrite in persistent collection)
#   ✓ Private data deletes (DelPrivateData)
#   ✓ Ephemeral private data (blockToLive=100 → purge risk)
#   ✓ Multiple private collections (orgPrivateData + tempPrivateData)
#   ✓ Multiple transactions per block (if ordering batches them)
#
# Prerequisites:
#   - Same env vars as deploy-chaincode.sh
#   - sample_assets chaincode deployed and committed
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
#   ./populate-data.sh
#
set -euo pipefail

# ── Validate required env vars ──
for var in NETWORK_ID MEMBER_ID NODE_ID CHANNEL_NAME REGION MSP_ID TLS_CA_CERT MSP_PATH; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

# ── Resolve AMB endpoints ──
PEER_ENDPOINT=$(aws managedblockchain get-node \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' \
  --output text)

# AMB orderer has its own hostname
ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
export CORE_PEER_LOCALMSPID="$MSP_ID"
export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"

CC="sample_assets"
CH="$CHANNEL_NAME"
TLS_ARGS="--tls --cafile $TLS_CA_CERT --orderer $ORDERER_ENDPOINT"

invoke() {
  local func="$1"
  shift
  echo "  → $func $*"
  peer chaincode invoke \
    -C "$CH" -n "$CC" \
    -c "{\"function\":\"$func\",\"Args\":[$(printf '"%s"' "$1"; shift; for arg in "$@"; do printf ',"%s"' "$arg"; done)]}" \
    $TLS_ARGS \
    --waitForEvent 2>&1 | tail -1 || true
}

invoke_transient() {
  local func="$1"
  local transient_key="$2"
  local transient_value="$3"
  echo "  → $func (transient: $transient_key)"
  # Transient data must be base64 encoded
  local b64_value
  b64_value=$(echo -n "$transient_value" | base64 | tr -d '\n')
  peer chaincode invoke \
    -C "$CH" -n "$CC" \
    -c "{\"function\":\"$func\",\"Args\":[]}" \
    --transient "{\"$transient_key\":\"$b64_value\"}" \
    $TLS_ARGS \
    --waitForEvent 2>&1 | tail -1 || true
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Populating sample data on channel: $CH"
echo " Chaincode: $CC"
echo " Peer: $PEER_ENDPOINT"
echo "═══════════════════════════════════════════════════════════"

# ────────────────────────────────────────────
# Phase 1: Create assets (public state + composite keys)
# ────────────────────────────────────────────
echo ""
echo "── Phase 1: Creating assets ──"

invoke CreateAsset "asset001" "Alice" "1000" "red" "10"
invoke CreateAsset "asset002" "Bob" "2000" "blue" "20"
invoke CreateAsset "asset003" "Charlie" "3000" "red" "30"
invoke CreateAsset "asset004" "Alice" "4000" "green" "15"
invoke CreateAsset "asset005" "Bob" "5000" "blue" "25"
invoke CreateAsset "asset006" "Diana" "1500" "red" "12"
invoke CreateAsset "asset007" "Eve" "2500" "green" "18"
invoke CreateAsset "asset008" "Frank" "3500" "blue" "22"

echo "  Created 8 assets"

# ────────────────────────────────────────────
# Phase 2: Update assets (state overwrites → history trail)
# ────────────────────────────────────────────
echo ""
echo "── Phase 2: Updating assets (creates history versions) ──"

invoke UpdateAsset "asset001" "Alice" "1100" "red" "10"
invoke UpdateAsset "asset001" "Alice" "1200" "red" "11"
invoke UpdateAsset "asset002" "Bob" "2200" "blue" "21"
invoke UpdateAsset "asset005" "Bob" "5500" "blue" "26"

echo "  Updated 4 assets (asset001 has 3 versions total)"

# ────────────────────────────────────────────
# Phase 3: Transfer ownership (read-modify-write)
# ────────────────────────────────────────────
echo ""
echo "── Phase 3: Transferring ownership ──"

invoke TransferAsset "asset003" "Diana"
invoke TransferAsset "asset004" "Charlie"
invoke TransferAsset "asset006" "Alice"

echo "  Transferred 3 assets"

# ────────────────────────────────────────────
# Phase 4: Delete assets (exercises DelState)
# ────────────────────────────────────────────
echo ""
echo "── Phase 4: Deleting assets ──"

invoke DeleteAsset "asset007"
invoke DeleteAsset "asset008"

echo "  Deleted 2 assets (asset007, asset008)"
echo "  These will appear in history with isDelete=true"
echo "  but will NOT appear in current state"

# ────────────────────────────────────────────
# Phase 5: Private data — persistent collection (orgPrivateData)
# ────────────────────────────────────────────
echo ""
echo "── Phase 5: Creating private appraisals (persistent collection) ──"

invoke_transient CreateAppraisal "appraisal" \
  '{"assetId":"asset001","appraisedValue":15000,"appraiser":"Expert A","notes":"Excellent condition, rare color variant"}'

invoke_transient CreateAppraisal "appraisal" \
  '{"assetId":"asset002","appraisedValue":22000,"appraiser":"Expert B","notes":"Standard quality, good provenance"}'

invoke_transient CreateAppraisal "appraisal" \
  '{"assetId":"asset003","appraisedValue":35000,"appraiser":"Expert A","notes":"Premium grade, recently transferred"}'

invoke_transient CreateAppraisal "appraisal" \
  '{"assetId":"asset005","appraisedValue":55000,"appraiser":"Expert C","notes":"High value, updated multiple times"}'

echo "  Created 4 private appraisals in orgPrivateData"

# ────────────────────────────────────────────
# Phase 6: Private data — update and delete
# ────────────────────────────────────────────
echo ""
echo "── Phase 6: Updating and deleting private data ──"

# Update an appraisal (overwrite in private collection)
invoke_transient UpdateAppraisal "appraisal" \
  '{"assetId":"asset001","appraisedValue":16000,"appraiser":"Expert A","notes":"Revised upward after market analysis"}'

echo "  Updated appraisal for asset001 (creates private history)"

# Delete an appraisal (exercises DelPrivateData)
invoke DeleteAppraisal "asset003"

echo "  Deleted appraisal for asset003 (will show isDelete=true in private history)"

# ────────────────────────────────────────────
# Phase 7: Ephemeral private data (tempPrivateData, blockToLive=100)
# ────────────────────────────────────────────
echo ""
echo "── Phase 7: Creating ephemeral notes (blockToLive=100) ──"

invoke_transient CreateTempNote "note" \
  '{"assetId":"asset001","note":"Inspection scheduled for next week"}'

invoke_transient CreateTempNote "note" \
  '{"assetId":"asset002","note":"Buyer interested, follow up Monday"}'

invoke_transient CreateTempNote "note" \
  '{"assetId":"asset004","note":"Pending transfer approval from legal"}'

echo "  Created 3 temp notes in tempPrivateData"
echo "  These will be auto-purged after ~100 blocks"
echo "  After purging, only hashes remain (exercises hash extraction)"

# ────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Population complete!"
echo ""
echo " Expected extraction results:"
echo "   Public state:  6 live assets (8 created - 2 deleted)"
echo "                  + composite key index entries"
echo "   Public history: ~20 entries (creates + updates + transfers + deletes)"
echo "   Block metadata: one record per transaction"
echo "   Private state (orgPrivateData): 3 appraisals (4 created - 1 deleted)"
echo "   Private state (tempPrivateData): 3 temp notes"
echo "   Private history: ~7 entries (creates + update + delete)"
echo "   Identities: 1 (your admin identity)"
echo ""
echo " Purge risk assessment should flag:"
echo "   tempPrivateData (blockToLive=100) → HIGH risk"
echo ""
echo " Next steps:"
echo "   1. Run: node dist/cli/index.js discover --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --msp-path $MSP_PATH"
echo "   2. Run: node dist/cli/index.js extract --manifest ./extraction-output/manifest.json --tier 3 --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --msp-path $MSP_PATH"
echo "   3. Run: node dist/cli/index.js validate --input-dir ./extraction-output"
echo "═══════════════════════════════════════════════════════════"
