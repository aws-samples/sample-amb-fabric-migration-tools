#!/usr/bin/env bash
#
# Deploy a chaincode to an Amazon Managed Blockchain network.
#
# Idempotent: if the chaincode is already committed at the requested
# sequence, the script exits successfully without redeploying.
#
# Prerequisites:
#   - AWS CLI configured with appropriate IAM permissions
#   - Fabric CLI tools (peer) available on PATH
#   - Environment variables set (see below)
#   - TLS CA cert downloaded from AMB
#
# Usage:
#   # Deploy with defaults (sample_assets on $CHANNEL_NAME):
#   ./deploy-chaincode.sh
#
#   # Deploy a specific chaincode to a specific channel:
#   ./deploy-chaincode.sh \
#     --name trade_registry \
#     --path /path/to/trade_registry \
#     --channel tradechannel \
#     --version 1.0 \
#     --sequence 1
#
# Required env vars:
#   NETWORK_ID, MEMBER_ID, NODE_ID, REGION, MSP_ID,
#   TLS_CA_CERT, MSP_PATH
#
# Optional:
#   MSP_ID_2 — the second member of a two-member channel. A collections_config
#   naming Org2MSP needs it; without it the deploy is refused rather than
#   committing a collection policy that names an MSP the channel does not have.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Parse arguments (with backward-compatible defaults) ──
CC_NAME=""
CC_PATH=""
CC_CHANNEL=""
CC_VERSION="1.0"
CC_SEQUENCE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)     CC_NAME="$2";    shift 2 ;;
    --path)     CC_PATH="$2";    shift 2 ;;
    --channel)  CC_CHANNEL="$2"; shift 2 ;;
    --version)  CC_VERSION="$2"; shift 2 ;;
    --sequence) CC_SEQUENCE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

CC_NAME="${CC_NAME:-sample_assets}"
CC_PATH="${CC_PATH:-$(cd "$SCRIPT_DIR/../chaincode/$CC_NAME" && pwd)}"
CC_CHANNEL="${CC_CHANNEL:-$CHANNEL_NAME}"

# ── Validate required env vars ──
for var in NETWORK_ID MEMBER_ID NODE_ID REGION MSP_ID TLS_CA_CERT MSP_PATH; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set" >&2
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

ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

echo "═══════════════════════════════════════════════════════════"
echo " Deploying chaincode"
echo "   Name:     $CC_NAME"
echo "   Channel:  $CC_CHANNEL"
echo "   Version:  $CC_VERSION"
echo "   Sequence: $CC_SEQUENCE"
echo "   Path:     $CC_PATH"
echo "   Peer:     $PEER_ENDPOINT"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Fabric environment ──
export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
export CORE_PEER_LOCALMSPID="$MSP_ID"
export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"

COLLECTIONS_SOURCE="$CC_PATH/collections_config.json"
# Rendered beside the package rather than over the source: the checked-in file
# is a template naming Org1MSP (and Org2MSP on a two-member channel), and
# rewriting it in place both dirties the working tree and pins the policy to
# whichever member deployed first, which is wrong for every member after them.
COLLECTIONS_CONFIG="${TMPDIR:-/tmp}/${CC_NAME}-collections_config.json"
COLLECTIONS_ARG=""
if [ -f "$COLLECTIONS_SOURCE" ]; then
  COLLECTIONS_ARG="--collections-config $COLLECTIONS_CONFIG"
fi

PACKAGE_FILE="${TMPDIR:-/tmp}/${CC_NAME}.tar.gz"

# ── Idempotency: check if already committed at this sequence ──
echo "=== Checking if chaincode is already committed ==="
COMMITTED_SEQ=$(peer lifecycle chaincode querycommitted \
  --channelID "$CC_CHANNEL" \
  --name "$CC_NAME" \
  --output json 2>/dev/null \
  | jq -r '.sequence // 0' 2>/dev/null || echo "0")

if [ "$COMMITTED_SEQ" -ge "$CC_SEQUENCE" ] 2>/dev/null; then
  echo "  '$CC_NAME' already committed on '$CC_CHANNEL' at sequence $COMMITTED_SEQ (requested: $CC_SEQUENCE)"
  echo "  Nothing to do."
  exit 0
fi

echo "  Not yet committed (current: $COMMITTED_SEQ, target: $CC_SEQUENCE)"
echo ""

# ── Verify vendored dependencies ──
if [ ! -d "$CC_PATH/vendor" ]; then
  echo "ERROR: vendor/ directory not found in $CC_PATH" >&2
  echo "Run ./sample/scripts/vendor-deps.sh first (requires Go 1.20+)" >&2
  exit 1
fi

# ── Refresh the migration contract ──
# Fabric packages the chaincode directory whole, so the contract the replay
# adapter calls has to be inside it. Copied here rather than checked in per
# package, and copied again on every deploy, because the copy vendor-deps.sh
# made may predate an edit to the contract and a stale one fails at the first
# public write with an error that names the key, not the cause.
#
# Copied with its writer list empty, so this deployment refuses migration
# writes. That is correct here: this is the source network, which is populated
# through the application contract and never receives replayed data. The
# destination's list is rendered in by
# sample/scripts/destination/setup-test-network.sh.
MIGRATION_SOURCE="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION_SOURCE="$MIGRATION_SOURCE/sample/chaincode/migration_contract/go/migration.go"
if [ ! -f "$MIGRATION_SOURCE" ]; then
  echo "ERROR: migration contract not found at $MIGRATION_SOURCE" >&2
  exit 1
fi
mkdir -p "$CC_PATH/migration"
cp "$MIGRATION_SOURCE" "$CC_PATH/migration/migration.go"

# ── Render collection policies for this channel's MSP IDs ──
if [ -f "$COLLECTIONS_SOURCE" ]; then
  # Only a template that actually names Org2MSP cares who MSP_ID_2 is, so a
  # single-org config is not refused over a variable it never reads. While the
  # second member is the acting one, MSP_ID and MSP_ID_2 are legitimately equal.
  if grep -q "Org2MSP" "$COLLECTIONS_SOURCE" && [ "${MSP_ID_2:-}" = "$MSP_ID" ]; then
    echo "ERROR: MSP_ID_2 is the same member as MSP_ID ($MSP_ID)." >&2
    echo "  Org1MSP and Org2MSP would both render to it, quietly turning a" >&2
    echo "  two-org collection policy into a single-org one. Deploy as the other" >&2
    echo "  member, or set MSP_ID_2 to it." >&2
    exit 1
  fi

  SED_ARGS=(-e "s/Org1MSP/${MSP_ID}/g")
  if [ -n "${MSP_ID_2:-}" ]; then
    SED_ARGS+=(-e "s/Org2MSP/${MSP_ID_2}/g")
  fi
  sed "${SED_ARGS[@]}" "$COLLECTIONS_SOURCE" > "$COLLECTIONS_CONFIG"
  echo "Rendered Org1MSP -> $MSP_ID${MSP_ID_2:+, Org2MSP -> $MSP_ID_2} into $COLLECTIONS_CONFIG"

  # A placeholder that survives names an MSP no channel has, and Fabric commits
  # that definition happily: the collection ends up with a policy no identity
  # satisfies, so every write to it fails endorsement and the cause is a word in
  # a JSON file nobody reads twice. Cheaper to refuse it here.
  if grep -q "Org[0-9]MSP" "$COLLECTIONS_CONFIG"; then
    echo "ERROR: unresolved MSP placeholder in $COLLECTIONS_SOURCE" >&2
    grep -n "Org[0-9]MSP" "$COLLECTIONS_CONFIG" >&2
    echo "  Org1MSP renders from MSP_ID and Org2MSP from MSP_ID_2. Any other name" >&2
    echo "  is a typo: set the missing variable, or fix the name in the template." >&2
    exit 1
  fi
fi

# ── Check if already installed (install is peer-wide, not per-channel) ──
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled \
  --output json 2>/dev/null \
  | jq -r ".installed_chaincodes[] | select(.label==\"${CC_NAME}_${CC_VERSION}\") | .package_id" \
  2>/dev/null || echo "")

if [ -n "$PACKAGE_ID" ]; then
  echo "=== Chaincode already installed on peer ==="
  echo "  Package ID: $PACKAGE_ID"
  echo "  Skipping package + install."
else
  echo ""
  echo "=== Packaging chaincode ==="
  peer lifecycle chaincode package "$PACKAGE_FILE" \
    --path "$CC_PATH" \
    --lang golang \
    --label "${CC_NAME}_${CC_VERSION}"

  echo "Package: $PACKAGE_FILE"

  echo ""
  echo "=== Installing chaincode on peer ==="
  peer lifecycle chaincode install "$PACKAGE_FILE"

  PACKAGE_ID=$(peer lifecycle chaincode queryinstalled \
    --output json | jq -r ".installed_chaincodes[] | select(.label==\"${CC_NAME}_${CC_VERSION}\") | .package_id")

  if [ -z "$PACKAGE_ID" ]; then
    echo "ERROR: Could not find installed package ID" >&2
    exit 1
  fi

  echo "Package ID: $PACKAGE_ID"
fi

echo ""
echo "=== Approving chaincode for org ==="
peer lifecycle chaincode approveformyorg \
  --channelID "$CC_CHANNEL" \
  --name "$CC_NAME" \
  --version "$CC_VERSION" \
  --package-id "$PACKAGE_ID" \
  --sequence "$CC_SEQUENCE" \
  $COLLECTIONS_ARG \
  --tls \
  --cafile "$TLS_CA_CERT" \
  --orderer "$ORDERER_ENDPOINT"

echo ""
echo "=== Checking commit readiness ==="
peer lifecycle chaincode checkcommitreadiness \
  --channelID "$CC_CHANNEL" \
  --name "$CC_NAME" \
  --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" \
  $COLLECTIONS_ARG \
  --output json

echo ""
echo "=== Committing chaincode definition ==="
peer lifecycle chaincode commit \
  --channelID "$CC_CHANNEL" \
  --name "$CC_NAME" \
  --version "$CC_VERSION" \
  --sequence "$CC_SEQUENCE" \
  $COLLECTIONS_ARG \
  --tls \
  --cafile "$TLS_CA_CERT" \
  --orderer "$ORDERER_ENDPOINT"

echo ""
echo "=== Verifying deployment ==="
peer lifecycle chaincode querycommitted \
  --channelID "$CC_CHANNEL" \
  --name "$CC_NAME" \
  --output json

echo ""
echo "  '$CC_NAME' deployed to channel '$CC_CHANNEL'"
