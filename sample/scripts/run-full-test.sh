#!/usr/bin/env bash
#
# End-to-end test cycle: full bootstrap -> deploy -> populate -> extract.
#
# Deploys two chaincodes across two channels to test multi-channel
# and multi-chaincode extraction:
#
#   mychannel:    sample_assets + trade_registry
#   tradechannel: trade_registry
#
# Idempotent: re-running against an existing network only adds what's
# missing. Existing channels, chaincodes, and data are left untouched.
#
# Steps:
#   1. Install Fabric tools (if on CloudShell)
#   2. Enroll admin identity
#   3. Create channels + join peer (mychannel, tradechannel)
#   4. Configure anchor peer on both channels
#   5. Vendor Go deps (if Go available and vendor/ missing)
#   6. Deploy chaincodes (sample_assets on mychannel,
#      trade_registry on mychannel + tradechannel)
#   7. Populate test data on all chaincode/channel combos
#   8. Run discovery
#   9. Run extraction at all three tiers
#  10. Capture fixture data for offline tests
#  11. Run offline tests with captured fixtures
#
# Prerequisites:
#   - An AMB network with a member and peer node created
#   - Admin username/password (set during member creation)
#
# Usage:
#   # Auto-discover everything from network name:
#   ./sample/scripts/run-full-test.sh --network-name "my-network" \
#     --admin-username admin --admin-password 'MyP@ss'
#
#   # Or from network ID:
#   ./sample/scripts/run-full-test.sh --network-id n-XXXXXXXXXX \
#     --admin-username admin --admin-password 'MyP@ss'
#
#   # Or use env.sh:
#   source sample/scripts/env.sh
#   ./sample/scripts/run-full-test.sh
#
#   # Flags:
#   #   --member-name <name>     Which member to run as, on a network with more
#   #                            than one. Pair it with --msp-path so each
#   #                            member's admin identity has its own directory.
#   #                            --member-id, --node-id and --msp-path are also
#   #                            passed through to resolve-network.sh.
#   #   --skip-bootstrap         Skip tool install/enroll/channel (re-runs)
#   #   --skip-populate          Skip data population, leaving the ledger where
#   #                            it is. Without it a re-run grows the ledger,
#   #                            and step 9 then refuses to extract into tier
#   #                            directories an earlier run already filled.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/test-output"
FIXTURES_DIR="$PROJECT_ROOT/test/fixtures"

CHANNEL_1="mychannel"
CHANNEL_2="tradechannel"

# The extraction steps run the CLI through `npx ts-node`, which is the last thing
# this script does. Checked here so a clone with no dependencies fails now rather
# than after the channels, chaincodes and test data are all in place.
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  echo "ERROR: $PROJECT_ROOT/node_modules is missing." >&2
  echo "Run 'npm install' in $PROJECT_ROOT first." >&2
  exit 1
fi

# ── Parse flags ──
SKIP_BOOTSTRAP=false
SKIP_POPULATE=false
RESOLVE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-bootstrap) SKIP_BOOTSTRAP=true; shift ;;
    --skip-populate)  SKIP_POPULATE=true; shift ;;
    --network-name|--network-id|--region|--channel|--admin-username|--admin-password|\
    --member-name|--member-id|--node-id|--msp-path)
      RESOLVE_ARGS+=("$1" "$2"); shift 2 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Load env: resolve from CLI args, or fall back to env.sh ──
if [ ${#RESOLVE_ARGS[@]} -gt 0 ]; then
  echo "--- Resolving network configuration from AWS API ---"
  source "$SCRIPT_DIR/resolve-network.sh" "${RESOLVE_ARGS[@]}"
  echo ""
elif [ -f "$SCRIPT_DIR/env.sh" ]; then
  source "$SCRIPT_DIR/env.sh"
fi

for var in NETWORK_ID MEMBER_ID NODE_ID REGION MSP_ID; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set." >&2
    echo "Either pass --network-name or --network-id, or create env.sh from env.sh.example." >&2
    exit 1
  fi
done

echo "========================================================"
echo " AMB Fabric migration tools: Full Integration Test"
echo "========================================================"
echo " Network:    $NETWORK_ID"
echo " Member:     $MEMBER_ID"
echo " Node:       $NODE_ID"
echo " Region:     $REGION"
echo " Channels:   $CHANNEL_1, $CHANNEL_2"
echo " Chaincodes: sample_assets ($CHANNEL_1)"
echo "             trade_registry ($CHANNEL_1, $CHANNEL_2)"
echo " Output:     $OUTPUT_DIR"
echo " Fixtures:   $FIXTURES_DIR"
echo " Bootstrap:  $(if $SKIP_BOOTSTRAP; then echo 'SKIP'; else echo 'YES'; fi)"
echo " Populate:   $(if $SKIP_POPULATE; then echo 'SKIP'; else echo 'YES'; fi)"
echo "========================================================"
echo ""

if ! $SKIP_BOOTSTRAP; then
  # ── Step 1: CloudShell setup (Fabric tools + TLS cert) ──
  echo "--- Step 1: CloudShell setup ---"
  if ! command -v peer &>/dev/null; then
    bash "$SCRIPT_DIR/setup-cloudshell.sh"
    # It exports these in its own process and appends them to the shell rc files;
    # neither reaches this one. Step 5 needs `go`, or it stops the run after the
    # channels and anchor peers are already configured.
    export PATH="${FABRIC_BIN:-$HOME/fabric-tools/bin}:$HOME/go/bin:$HOME/gopath/bin:$PATH"
  else
    echo "  Fabric tools already on PATH: $(which peer)"
  fi
  echo ""

  # ── Step 2: Enroll admin ──
  echo "--- Step 2: Enroll admin identity ---"
  bash "$SCRIPT_DIR/enroll-admin.sh"
  echo ""

  # ── Step 3: Create channels + join peer ──
  echo "--- Step 3a: Create channel $CHANNEL_1 ---"
  CHANNEL_NAME="$CHANNEL_1" bash "$SCRIPT_DIR/create-channel.sh"
  echo ""

  echo "--- Step 3b: Create channel $CHANNEL_2 ---"
  CHANNEL_NAME="$CHANNEL_2" bash "$SCRIPT_DIR/create-channel.sh"
  echo ""

  # ── Step 4: Configure anchor peer on both channels ──
  echo "--- Step 4a: Configure anchor peer on $CHANNEL_1 ---"
  CHANNEL_NAME="$CHANNEL_1" bash "$SCRIPT_DIR/configure-anchor-peer.sh"
  echo ""

  echo "--- Step 4b: Configure anchor peer on $CHANNEL_2 ---"
  CHANNEL_NAME="$CHANNEL_2" bash "$SCRIPT_DIR/configure-anchor-peer.sh"
  echo ""
else
  echo "--- Skipping bootstrap (--skip-bootstrap) ---"
  echo ""
fi

# ── Step 5: Verify vendored deps, vendor if possible ──
echo "--- Step 5: Checking vendored Go dependencies ---"
VENDOR_OK=true
for CC_DIR in \
  "$PROJECT_ROOT/sample/chaincode/sample_assets" \
  "$PROJECT_ROOT/sample/chaincode/trade_registry"; do
  if [ ! -d "$CC_DIR/vendor" ]; then
    echo "  MISSING: $CC_DIR/vendor/"
    VENDOR_OK=false
  else
    echo "  OK: $(basename "$CC_DIR")/vendor/"
  fi
done

if ! $VENDOR_OK; then
  if command -v go &>/dev/null; then
    echo ""
    echo "  Go found -- vendoring dependencies..."
    bash "$SCRIPT_DIR/vendor-deps.sh"
  else
    echo ""
    echo "ERROR: vendor/ directories missing and Go is not installed." >&2
    echo "Either install Go and run vendor-deps.sh, or vendor locally and push." >&2
    exit 1
  fi
fi
echo ""

# ── Step 6: Deploy chaincodes ──
# deploy-chaincode.sh renders the collection policy for whichever member is
# deploying, into a file beside the package. There is deliberately no step that
# rewrites the checked-in collections_config.json: substituting in place dirties
# the operator's clone and pins the policy to the first member who ran, which is
# wrong for every member after them.

# sample_assets -> mychannel only
echo "--- Step 6a: Deploy sample_assets on $CHANNEL_1 ---"
bash "$SCRIPT_DIR/deploy-chaincode.sh" \
  --name sample_assets \
  --channel "$CHANNEL_1"
echo ""

# trade_registry -> mychannel
echo "--- Step 6b: Deploy trade_registry on $CHANNEL_1 ---"
bash "$SCRIPT_DIR/deploy-chaincode.sh" \
  --name trade_registry \
  --channel "$CHANNEL_1"
echo ""

# trade_registry -> tradechannel
echo "--- Step 6c: Deploy trade_registry on $CHANNEL_2 ---"
bash "$SCRIPT_DIR/deploy-chaincode.sh" \
  --name trade_registry \
  --channel "$CHANNEL_2"
echo ""

# ── Step 7: Populate data ──
if ! $SKIP_POPULATE; then
  echo "--- Step 7a: Populate sample_assets on $CHANNEL_1 ---"
  CHANNEL_NAME="$CHANNEL_1" bash "$SCRIPT_DIR/populate-data.sh"
  echo ""

  echo "--- Step 7b: Populate trade_registry on $CHANNEL_1 ---"
  bash "$SCRIPT_DIR/populate-trade-data.sh" --channel "$CHANNEL_1"
  echo ""

  echo "--- Step 7c: Populate trade_registry on $CHANNEL_2 ---"
  bash "$SCRIPT_DIR/populate-trade-data.sh" --channel "$CHANNEL_2"
  echo ""
else
  echo "--- Skipping data population (--skip-populate) ---"
  echo ""
fi

# ── Step 8: Run discovery ──
echo "--- Step 8: Discover network ---"
DISCOVERY_DIR="$OUTPUT_DIR/discovery"
mkdir -p "$DISCOVERY_DIR"

npx ts-node "$PROJECT_ROOT/src/cli/index.ts" discover \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --output-dir "$DISCOVERY_DIR"

echo "  Manifest: $DISCOVERY_DIR/manifest.json"
echo ""

# ── Step 9: Extract at each tier (all channels) ──
ALL_CHANNELS="$CHANNEL_1 $CHANNEL_2"

for TIER in 1 2 3; do
  echo "--- Step 9.$TIER: Extract at Tier $TIER ---"
  EXTRACT_DIR="$OUTPUT_DIR/tier${TIER}"

  # Step 7 advanced both ledgers. Extraction resumes from its checkpoint and its
  # NDJSON output appends, so extracting into a directory an earlier run filled
  # walks only the blocks since then and writes the two heights into one
  # snapshot: keys touched in between get a second record, and a key the new
  # blocks deleted keeps the earlier run's record and still looks alive. `merge`
  # refuses this same hazard; refuse it here rather than write a directory that
  # validates with a warning at worst and is wrong. With --skip-populate the
  # ledger has not moved and resuming is exactly right, so the check is skipped.
  #
  # A `channel-*` directory is what an extraction leaves; anything else in here
  # is not one, so a stray .DS_Store must not stop the run.
  if ! $SKIP_POPULATE && compgen -G "$EXTRACT_DIR/channel-*" > /dev/null; then
    echo "ERROR: $EXTRACT_DIR already holds an extraction." >&2
    echo "Step 7 has advanced the ledger since it was written, so this run" >&2
    echo "would append its blocks to that snapshot instead of replacing it." >&2
    echo "Move or delete $OUTPUT_DIR and run again, or pass --skip-populate" >&2
    echo "to leave the ledger where it is and resume the existing extraction." >&2
    exit 1
  fi

  mkdir -p "$EXTRACT_DIR"

  npx ts-node "$PROJECT_ROOT/src/cli/index.ts" extract \
    --manifest "$DISCOVERY_DIR/manifest.json" \
    --tier "$TIER" \
    --network-id "$NETWORK_ID" \
    --member-id "$MEMBER_ID" \
    --node-id "$NODE_ID" \
    --channels $ALL_CHANNELS \
    --output-dir "$EXTRACT_DIR"

  echo "  Output: $EXTRACT_DIR/"

  for CH in $ALL_CHANNELS; do
    if [ -d "$EXTRACT_DIR/channel-$CH" ]; then
      echo "  Files (channel-$CH):"
      ls -la "$EXTRACT_DIR/channel-$CH/" 2>/dev/null \
        | grep -v "^total" \
        | awk '{print "    " $NF " (" $5 " bytes)"}'
    fi
  done
  echo ""
done

# ── Step 10: Capture fixtures for offline tests ──
echo "--- Step 10: Capture fixtures ---"
mkdir -p "$FIXTURES_DIR"

for CH in $ALL_CHANNELS; do
  echo "  Capturing fixtures for channel: $CH"
  npx ts-node "$PROJECT_ROOT/src/cli/index.ts" capture-fixtures \
    --network-id "$NETWORK_ID" \
    --member-id "$MEMBER_ID" \
    --node-id "$NODE_ID" \
    --channel "$CH" \
    --region "$REGION" \
    --output-dir "$FIXTURES_DIR"
done

echo ""

# ── Step 11: Run offline tests with captured fixtures ──
echo "--- Step 11: Run offline tests ---"
cd "$PROJECT_ROOT"
npx jest test/e2e-live-fixtures.test.ts --verbose

echo ""
echo "========================================================"
echo " Integration test complete!"
echo ""
echo " Deployment matrix:"
echo "   $CHANNEL_1:    sample_assets, trade_registry"
echo "   $CHANNEL_2: trade_registry"
echo ""
echo " Artifacts:"
echo "   Discovery: $DISCOVERY_DIR/"
echo "   Tier 1:    $OUTPUT_DIR/tier1/"
echo "   Tier 2:    $OUTPUT_DIR/tier2/"
echo "   Tier 3:    $OUTPUT_DIR/tier3/"
echo "   Fixtures:  $FIXTURES_DIR/"
echo ""
echo " Validation checklist:"
echo "   -- mychannel / sample_assets --"
echo "   [ ] 6 public_state records (8 - 2 deleted)"
echo "   [ ] block_metadata with keysWritten/keysDeleted"
echo "   [ ] public_history with isDelete=true for asset007, asset008"
echo "   [ ] orgPrivateData: 3 appraisals"
echo "   [ ] tempPrivateData: 3 notes"
echo ""
echo "   -- mychannel / trade_registry --"
echo "   [ ] 5 live trades (6 - 1 cancelled)"
echo "   [ ] public_history with isDelete=true for trade 1006"
echo "   [ ] counterpartyDetails: 3 records"
echo ""
echo "   -- tradechannel / trade_registry --"
echo "   [ ] 5 live trades (independent from mychannel)"
echo "   [ ] counterpartyDetails: 3 records"
echo ""
echo "   -- Cross-cutting --"
echo "   [ ] Hash chain integrity: VALID (both channels)"
echo "   [ ] Identity records present for both channels"
echo "   [ ] Offline fixture tests: PASS"
echo "========================================================"
