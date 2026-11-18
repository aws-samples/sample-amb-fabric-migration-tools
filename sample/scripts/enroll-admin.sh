#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Enroll the member admin identity via the AMB Fabric CA.
#
# This creates the admin MSP directory with signed certificates that are
# used for all subsequent operations (channel creation, chaincode lifecycle,
# transaction submission).
#
# The admin username and password are set when creating the AMB member in
# the console or via the CreateMember API.
#
# Prerequisites:
#   - setup-cloudshell.sh has been run (Fabric tools + TLS cert installed)
#   - The environment is loaded, with ADMIN_USERNAME and ADMIN_PASSWORD set
#
# This script reads the environment and never loads it: source resolve-network.sh
# or env.sh yourself first. That is what makes a per-invocation override work —
#
#   MEMBER_ID=m-OTHER MSP_PATH=$HOME/admin-msp-org2 ./enroll-admin.sh
#
# — which sourcing env.sh from in here would silently undo.
#
# Usage:
#   source sample/scripts/env.sh
#   ./sample/scripts/enroll-admin.sh
#
set -euo pipefail

for var in NETWORK_ID MEMBER_ID REGION ADMIN_USERNAME ADMIN_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

TLS_CERT="${TLS_CA_CERT:-$HOME/managedblockchain-tls-chain.pem}"
ADMIN_MSP="${MSP_PATH:-$HOME/admin-msp}"

if [ ! -f "$TLS_CERT" ]; then
  echo "ERROR: TLS CA cert not found at $TLS_CERT" >&2
  echo "Run setup-cloudshell.sh first." >&2
  exit 1
fi

# ── Resolve CA endpoint ──
echo "=== Resolving CA endpoint ==="
CA_ENDPOINT=$(aws managedblockchain get-member \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --region "$REGION" \
  --query 'Member.FrameworkAttributes.Fabric.CaEndpoint' \
  --output text)

echo "  CA: $CA_ENDPOINT"

# ── Check if already enrolled ──
if [ -f "$ADMIN_MSP/signcerts/cert.pem" ]; then
  echo ""
  echo "Admin MSP already exists at $ADMIN_MSP"
  echo "To re-enroll, remove the directory first: rm -rf $ADMIN_MSP"

  # Verify the cert is still valid
  EXPIRY=$(openssl x509 -enddate -noout -in "$ADMIN_MSP/signcerts/cert.pem" 2>/dev/null | cut -d= -f2)
  if [ -n "$EXPIRY" ]; then
    echo "  Certificate expires: $EXPIRY"
  fi

  # Ensure ADMIN_CERT and ADMIN_KEY are exported even on re-runs
  export ADMIN_CERT="$ADMIN_MSP/signcerts/cert.pem"
  export ADMIN_KEY="$(ls "$ADMIN_MSP/keystore/"*_sk 2>/dev/null | head -1)"
  echo "  ADMIN_CERT=$ADMIN_CERT"
  echo "  ADMIN_KEY=$ADMIN_KEY"
  exit 0
fi

# ── Enroll admin ──
echo ""
echo "=== Enrolling admin identity ==="
echo "  Username: $ADMIN_USERNAME"
echo "  MSP dir:  $ADMIN_MSP"

# The URL carries the password, so it goes in the environment (FABRIC_CA_CLIENT_URL, read by fabric-ca-client)
# rather than on the command line, which every user on the host can read in the process list.
FABRIC_CA_CLIENT_URL="https://${ADMIN_USERNAME}:${ADMIN_PASSWORD}@${CA_ENDPOINT}" fabric-ca-client enroll \
  --tls.certfiles "$TLS_CERT" \
  -M "$ADMIN_MSP"

# ── Copy signcerts to admincerts ──
# Required by Fabric — the admin identity must be in the admincerts directory
# for the peer to recognize it as an admin.
echo ""
echo "=== Setting up admincerts ==="
cp -r "$ADMIN_MSP/signcerts" "$ADMIN_MSP/admincerts"

# ── Verify enrollment ──
echo ""
echo "=== Verifying enrollment ==="

if [ -f "$ADMIN_MSP/signcerts/cert.pem" ]; then
  SUBJECT=$(openssl x509 -subject -noout -in "$ADMIN_MSP/signcerts/cert.pem" 2>/dev/null)
  EXPIRY=$(openssl x509 -enddate -noout -in "$ADMIN_MSP/signcerts/cert.pem" 2>/dev/null | cut -d= -f2)
  echo "  Subject:  $SUBJECT"
  echo "  Expires:  $EXPIRY"
else
  echo "  ERROR: cert.pem not found after enrollment" >&2
  exit 1
fi

if [ -f "$ADMIN_MSP/keystore/"*"_sk" ] 2>/dev/null; then
  echo "  Key:      $(ls "$ADMIN_MSP/keystore/"*_sk | head -1)"
else
  echo "  Key:      $(ls "$ADMIN_MSP/keystore/" | head -1)"
fi

echo ""
echo "MSP directory structure:"
find "$ADMIN_MSP" -type f | sort | sed "s|$HOME|~|g" | sed 's/^/  /'

# ── Export ADMIN_CERT and ADMIN_KEY for downstream scripts ──
export ADMIN_CERT="$ADMIN_MSP/signcerts/cert.pem"
export ADMIN_KEY="$(ls "$ADMIN_MSP/keystore/"*_sk 2>/dev/null | head -1)"

for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  grep -q 'ADMIN_CERT' "$rc" 2>/dev/null || cat >> "$rc" << ADMINEOF

# Admin identity (set by enroll-admin.sh)
export ADMIN_CERT="$ADMIN_CERT"
export ADMIN_KEY="$ADMIN_KEY"
ADMINEOF
done

echo ""
echo "✓ Admin enrolled successfully"
echo "  MSP_PATH=$ADMIN_MSP"
echo "  ADMIN_CERT=$ADMIN_CERT"
echo "  ADMIN_KEY=$ADMIN_KEY"
echo ""
echo "Next: ./sample/scripts/create-channel.sh"
