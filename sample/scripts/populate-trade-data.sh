#!/usr/bin/env bash
#
# Populate the trade_registry chaincode with test data.
#
# Exercises the same extraction paths as populate-data.sh but with
# a different domain:
#
#   - Public state creates (RegisterTrade)
#   - Public state updates (UpdateTrade — price/quantity amendments)
#   - Public state status transitions (CloseTrade — OPEN -> SETTLED)
#   - Public state deletes (CancelTrade)
#   - Composite key index entries (status~id)
#   - Private data creates (SetCounterpartyInfo via transient)
#   - Private data deletes (DeleteCounterpartyInfo)
#
# Usage:
#   # Populate on default channel ($CHANNEL_NAME):
#   ./populate-trade-data.sh
#
#   # Populate on a specific channel:
#   ./populate-trade-data.sh --channel tradechannel
#
set -euo pipefail

# ── Parse arguments ──
TARGET_CHANNEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) TARGET_CHANNEL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Validate required env vars ──
for var in NETWORK_ID MEMBER_ID NODE_ID REGION MSP_ID TLS_CA_CERT MSP_PATH; do
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

ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
export CORE_PEER_LOCALMSPID="$MSP_ID"
export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"

CC="trade_registry"
CH="${TARGET_CHANNEL:-$CHANNEL_NAME}"
TLS_ARGS="--tls --cafile $TLS_CA_CERT --orderer $ORDERER_ENDPOINT"

invoke() {
  local func="$1"
  shift
  echo "  -> $func $*"
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
  echo "  -> $func (transient: $transient_key)"
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
echo "========================================================"
echo " Populating trade data on channel: $CH"
echo " Chaincode: $CC"
echo " Peer: $PEER_ENDPOINT"
echo "========================================================"

# ────────────────────────────────────────────
# Phase 1: Register trades
# ────────────────────────────────────────────
echo ""
echo "-- Phase 1: Registering trades --"

invoke RegisterTrade "1001" "Acme Corp"  "Globex Inc"   "WHEAT"  "500"  "12500"
invoke RegisterTrade "1002" "Initech"    "Umbrella Ltd" "CORN"   "1000" "28000"
invoke RegisterTrade "1003" "Globex Inc" "Acme Corp"    "RICE"   "750"  "18750"
invoke RegisterTrade "1004" "Umbrella Ltd" "Initech"    "WHEAT"  "300"  "7500"
invoke RegisterTrade "1005" "Acme Corp"  "Initech"      "CORN"   "200"  "5600"
invoke RegisterTrade "1006" "Globex Inc" "Umbrella Ltd" "RICE"   "400"  "10000"

echo "  Registered 6 trades"

# ────────────────────────────────────────────
# Phase 2: Amend trades (price/quantity updates)
# ────────────────────────────────────────────
echo ""
echo "-- Phase 2: Amending trades (creates history versions) --"

invoke UpdateTrade "1001" "550"  "13750"
invoke UpdateTrade "1001" "600"  "15000"
invoke UpdateTrade "1002" "1100" "30800"

echo "  Amended 3 trades (1001 has 3 versions total)"

# ────────────────────────────────────────────
# Phase 3: Settle trades (status transition)
# ────────────────────────────────────────────
echo ""
echo "-- Phase 3: Settling trades --"

invoke CloseTrade "1003"
invoke CloseTrade "1004"

echo "  Settled 2 trades (deletes OPEN index, adds SETTLED index)"

# ────────────────────────────────────────────
# Phase 4: Cancel trades (exercises DelState)
# ────────────────────────────────────────────
echo ""
echo "-- Phase 4: Cancelling trades --"

invoke CancelTrade "1006"

echo "  Cancelled 1 trade (1006)"
echo "  Will appear in history with isDelete=true"
echo "  but NOT in current state"

# ────────────────────────────────────────────
# Phase 5: Private counterparty details
# ────────────────────────────────────────────
echo ""
echo "-- Phase 5: Setting counterparty details (private data) --"

invoke_transient SetCounterpartyInfo "counterparty" \
  '{"tradeId":"1001","account":"ACME-9821","routing":"021000021","contact":"treasury@acme.com"}'

invoke_transient SetCounterpartyInfo "counterparty" \
  '{"tradeId":"1002","account":"INIT-4455","routing":"021000089","contact":"settlements@initech.com"}'

invoke_transient SetCounterpartyInfo "counterparty" \
  '{"tradeId":"1003","account":"GLOB-7712","routing":"021000021","contact":"ops@globex.com"}'

invoke_transient SetCounterpartyInfo "counterparty" \
  '{"tradeId":"1005","account":"ACME-9821","routing":"021000021","contact":"treasury@acme.com"}'

echo "  Created 4 counterparty records in counterpartyDetails"

# ────────────────────────────────────────────
# Phase 6: Delete private data
# ────────────────────────────────────────────
echo ""
echo "-- Phase 6: Deleting counterparty details --"

invoke DeleteCounterpartyInfo "1003"

echo "  Deleted counterparty info for trade 1003"
echo "  Will show isDelete=true in private history"

# ────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────
echo ""
echo "========================================================"
echo " Trade population complete on channel: $CH"
echo ""
echo " Expected extraction results for trade_registry:"
echo "   Public state:  5 live trades (6 registered - 1 cancelled)"
echo "                  + composite key index entries (status~id)"
echo "   Public history: ~15 entries (registers + amendments + settles + cancel)"
echo "   Private state (counterpartyDetails): 3 records (4 created - 1 deleted)"
echo "   Private history: ~5 entries (creates + delete)"
echo "   Identities: 1 (your admin identity)"
echo "========================================================"
