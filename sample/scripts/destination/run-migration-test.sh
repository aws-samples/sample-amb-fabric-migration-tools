#!/usr/bin/env bash
#
# End-to-end migration test: AMB source → local Fabric 2.5 destination.
#
# This script orchestrates the full migration:
#   1. Set up the destination test-network (Fabric 2.5, CouchDB)
#      with both channels and all chaincodes
#   2. Replay extracted data to the destination
#   3. Verify replayed state matches the extracted NDJSON
#   4. Print comparison report
#
# Prerequisites:
#   - Extraction has already been run against the AMB source
#     (./extraction-output/ exists with NDJSON files)
#   - Docker and Docker Compose installed
#   - Go 1.20+ installed
#   - Node.js 22+ and npm (for the extractor CLI)
#
# Usage:
#   ./sample/scripts/destination/run-migration-test.sh \
#     --input-dir ./extraction-output
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

INPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input-dir) INPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$INPUT_DIR" ]; then
  echo "Usage: run-migration-test.sh --input-dir <path>" >&2
  echo "" >&2
  echo "Run the source extraction first:" >&2
  echo "  ./sample/scripts/run-full-test.sh --network-name 'my-network' ..." >&2
  exit 1
fi

# Verify both channel directories exist
for CH in mychannel tradechannel; do
  if [ ! -d "$INPUT_DIR/channel-$CH" ]; then
    echo "ERROR: $INPUT_DIR/channel-$CH/ not found" >&2
    echo "Check --input-dir matches your extraction output." >&2
    exit 1
  fi
done

echo "═══════════════════════════════════════════════════════════"
echo " End-to-End Migration Test"
echo " Source:      AMB 2.2 (extracted NDJSON)"
echo " Destination: Fabric 2.5 test-network (local)"
echo "═══════════════════════════════════════════════════════════"
echo " Input:    $INPUT_DIR"
echo " Channels: mychannel, tradechannel"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Count source records ──
for CH in mychannel tradechannel; do
  STATE_FILE="$INPUT_DIR/channel-$CH/public-state.ndjson"
  COUNT=$(wc -l < "$STATE_FILE" | tr -d ' ')
  echo "Source ($CH): $COUNT public state records"
done
echo ""

# ── Step 1: Set up destination ──
echo "━━━ Step 1: Setting up destination test-network ━━━"
bash "$SCRIPT_DIR/setup-test-network.sh"
echo ""

DEST_CONFIG="$PROJECT_ROOT/sample/destination-config/replay-config.json"

TMP_CONFIG=$(mktemp)
jq --arg dir "$INPUT_DIR" '.inputDir = $dir' "$DEST_CONFIG" > "$TMP_CONFIG"
mv "$TMP_CONFIG" "$DEST_CONFIG"

# ── Step 2: Replay ──
echo "━━━ Step 2: Replaying extracted data to destination ━━━"
echo ""
echo "  Config: $DEST_CONFIG"
echo "  Input:  $INPUT_DIR"
echo ""

cd "$PROJECT_ROOT"
npx ts-node src/cli/index.ts replay \
  --input-dir "$INPUT_DIR" \
  --adapter chaincode \
  --config "$DEST_CONFIG"

echo ""

# ── Step 3: Verify ──
echo "━━━ Step 3: Verifying replayed state ━━━"
echo ""

npx ts-node src/cli/index.ts verify \
  --input-dir "$INPUT_DIR" \
  --config "$DEST_CONFIG"

echo ""
echo "━━━ Migration test complete ━━━"
echo ""
echo "The destination test-network is still running."
echo "You can inspect it with:"
echo "  export PATH=\"\$HOME/fabric-samples/bin:\$PATH\""
echo "  peer chaincode query -C mychannel -n sample_assets -c '{\"function\":\"ReadAsset\",\"Args\":[\"asset001\"]}'"
echo "  peer chaincode query -C mychannel -n trade_registry -c '{\"function\":\"ReadTrade\",\"Args\":[\"TRD-1001\"]}'"
echo "  peer chaincode query -C tradechannel -n trade_registry -c '{\"function\":\"ReadTrade\",\"Args\":[\"TRD-1001\"]}'"
echo ""
echo "To tear down:"
echo "  ./sample/scripts/destination/teardown-test-network.sh"
