#!/usr/bin/env bash
#
# Bootstrap AWS CloudShell for Hyperledger Fabric on AMB.
#
# CloudShell doesn't have Docker or Fabric tools pre-installed. This script:
#   1. Downloads Hyperledger Fabric binaries (peer, configtxgen, configtxlator)
#   2. Downloads Fabric CA client (fabric-ca-client)
#   3. Optionally installs Go (for vendoring chaincode dependencies)
#   4. Downloads the AMB TLS CA certificate chain
#   5. Verifies connectivity to the AMB peer
#
# Everything is installed to $HOME, which persists across CloudShell sessions
# (up to 1GB). The Fabric binaries are ~80MB total.
#
# Prerequisites:
#   - AWS CloudShell session in the same region as your AMB network
#   - The environment is loaded (resolve-network.sh, or env.sh from env.sh.example)
#
# This script reads the environment and never loads it: source resolve-network.sh
# or env.sh yourself first. run-full-test.sh resolves the network from the AWS API
# before calling this, and sourcing env.sh from in here would let a stale one
# point the connectivity check at a different network than the rest of the run.
#
# Usage:
#   source sample/scripts/env.sh
#   ./sample/scripts/setup-cloudshell.sh
#
set -euo pipefail

for var in REGION NETWORK_ID MEMBER_ID NODE_ID; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set. Load the environment first, either" >&2
    echo "  source sample/scripts/resolve-network.sh --network-name <name>" >&2
    echo "or copy env.sh.example to env.sh, fill it in, and source that." >&2
    exit 1
  fi
done

FABRIC_VERSION="2.2.15"
FABRIC_CA_VERSION="1.5.12"
INSTALL_DIR="${FABRIC_BIN:-$HOME/fabric-tools/bin}"
GO_VERSION="1.21.13"

# SHA-256 of each linux-amd64 tarball above; change them with the versions.
# Go's is the one go.dev publishes. Neither Hyperledger release publishes a
# digest for these assets, so theirs record the release tarballs as fetched
# when they were pinned.
FABRIC_SHA256="ba6554e1b33de9b10c0d3ee1aeb4ca34b3ecc4b9f00756e8a2298325d9ee0760"
FABRIC_CA_SHA256="ae8a1c7bceda924dd4fe9ae1aef3738ecd8c00f624ba20eb323d1889690eadf5"
GO_SHA256="502fc16d5910562461e6a6631fb6377de2322aad7304bf2bcd23500ba9dab4a7"

# Download a tarball, check it, and only then unpack it.
fetch_verified() {
  local url="$1" sha="$2" dest="$3" tmp
  tmp=$(mktemp)
  curl -sSfL -o "$tmp" "$url"
  if ! echo "$sha  $tmp" | sha256sum -c --status -; then
    rm -f "$tmp"
    echo "ERROR: $url does not match its pinned SHA-256 ($sha). Nothing was installed." >&2
    exit 1
  fi
  tar xzf "$tmp" -C "$dest"
  rm -f "$tmp"
}

echo "═══════════════════════════════════════════════════════════"
echo " CloudShell Setup for AMB Hyperledger Fabric"
echo "═══════════════════════════════════════════════════════════"
echo " Region:    $REGION"
echo " Network:   $NETWORK_ID"
echo " Member:    $MEMBER_ID"
echo " Node:      $NODE_ID"
echo " Install:   $INSTALL_DIR"
echo "═══════════════════════════════════════════════════════════"
echo ""

mkdir -p "$INSTALL_DIR"

# ── Step 1: Download Fabric binaries ──
if [ -f "$INSTALL_DIR/peer" ] && "$INSTALL_DIR/peer" version &>/dev/null; then
  echo "=== Step 1: Fabric tools already installed ==="
  "$INSTALL_DIR/peer" version 2>&1 | head -3
else
  echo "=== Step 1: Downloading Fabric $FABRIC_VERSION binaries ==="
  FABRIC_URL="https://github.com/hyperledger/fabric/releases/download/v${FABRIC_VERSION}/hyperledger-fabric-linux-amd64-${FABRIC_VERSION}.tar.gz"
  echo "  URL: $FABRIC_URL"

  fetch_verified "$FABRIC_URL" "$FABRIC_SHA256" "$(dirname "$INSTALL_DIR")"
  chmod +x "$INSTALL_DIR"/*

  echo "  Installed: peer, configtxgen, configtxlator, orderer, osnadmin, discover"
  "$INSTALL_DIR/peer" version 2>&1 | head -3
fi
echo ""

# ── Step 2: Download Fabric CA client ──
if [ -f "$INSTALL_DIR/fabric-ca-client" ] && "$INSTALL_DIR/fabric-ca-client" version &>/dev/null; then
  echo "=== Step 2: Fabric CA client already installed ==="
  "$INSTALL_DIR/fabric-ca-client" version 2>&1 | head -2
else
  echo "=== Step 2: Downloading Fabric CA $FABRIC_CA_VERSION ==="
  CA_URL="https://github.com/hyperledger/fabric-ca/releases/download/v${FABRIC_CA_VERSION}/hyperledger-fabric-ca-linux-amd64-${FABRIC_CA_VERSION}.tar.gz"
  echo "  URL: $CA_URL"

  fetch_verified "$CA_URL" "$FABRIC_CA_SHA256" "$(dirname "$INSTALL_DIR")"
  chmod +x "$INSTALL_DIR/fabric-ca-client" "$INSTALL_DIR/fabric-ca-server" 2>/dev/null || true

  echo "  Installed: fabric-ca-client"
  "$INSTALL_DIR/fabric-ca-client" version 2>&1 | head -2
fi
echo ""

# ── Step 3: Optionally install Go (for vendoring chaincode deps) ──
if command -v go &>/dev/null; then
  echo "=== Step 3: Go already installed ==="
  go version
elif [ "${INSTALL_GO:-true}" = "true" ]; then
  echo "=== Step 3: Installing Go $GO_VERSION ==="
  GO_URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
  echo "  URL: $GO_URL"

  fetch_verified "$GO_URL" "$GO_SHA256" "$HOME"
  export GOROOT="$HOME/go"
  export GOPATH="$HOME/gopath"
  export PATH="$GOROOT/bin:$GOPATH/bin:$PATH"
  mkdir -p "$GOPATH"

  # Persist for future sessions (.bashrc for interactive shells, .profile for SSM/sh)
  for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    grep -q 'GOROOT' "$rc" 2>/dev/null || cat >> "$rc" << 'GOEOF'

# Go (installed by setup-cloudshell.sh)
export GOROOT="$HOME/go"
export GOPATH="$HOME/gopath"
export PATH="$GOROOT/bin:$GOPATH/bin:$PATH"
GOEOF
  done

  echo "  Installed: $(go version)"
else
  echo "=== Step 3: Skipping Go (INSTALL_GO=false) ==="
  echo "  Vendor deps locally and push vendor/ to this environment."
fi
echo ""

# ── Step 4: Download AMB TLS CA certificate ──
TLS_CERT="${TLS_CA_CERT:-$HOME/managedblockchain-tls-chain.pem}"
if [ -f "$TLS_CERT" ]; then
  echo "=== Step 4: TLS CA cert already exists ==="
  echo "  Path: $TLS_CERT"
else
  echo "=== Step 4: Downloading AMB TLS CA certificate ==="
  aws s3 cp "s3://${REGION}.managedblockchain/etc/managedblockchain-tls-chain.pem" "$TLS_CERT"
  echo "  Saved: $TLS_CERT"
fi
echo ""

# ── Step 5: Resolve and verify AMB endpoints ──
echo "=== Step 5: Resolving AMB endpoints ==="

PEER_ENDPOINT=$(aws managedblockchain get-node \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --node-id "$NODE_ID" \
  --region "$REGION" \
  --query 'Node.FrameworkAttributes.Fabric.PeerEndpoint' \
  --output text)

PEER_HOST="${PEER_ENDPOINT%%:*}"
ORDERER_ENDPOINT="orderer.${NETWORK_ID}.managedblockchain.${REGION}.amazonaws.com:30001"

CA_ENDPOINT=$(aws managedblockchain get-member \
  --network-id "$NETWORK_ID" \
  --member-id "$MEMBER_ID" \
  --region "$REGION" \
  --query 'Member.FrameworkAttributes.Fabric.CaEndpoint' \
  --output text)

echo "  Peer:    $PEER_ENDPOINT"
echo "  Orderer: $ORDERER_ENDPOINT"
echo "  CA:      $CA_ENDPOINT"
echo ""

# Test TLS connectivity to peer
echo "  Testing TLS to peer..."
if openssl s_client -connect "$PEER_ENDPOINT" -CAfile "$TLS_CERT" </dev/null 2>/dev/null | grep -q "Verify return code: 0"; then
  echo "  TLS handshake: OK"
else
  echo "  WARNING: TLS handshake could not be verified (peer may not be running)"
fi
echo ""

# ── Step 6: Add Fabric tools to PATH ──
export PATH="$INSTALL_DIR:$PATH"
for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  grep -q 'fabric-tools' "$rc" 2>/dev/null || cat >> "$rc" << PATHEOF

# Fabric tools (installed by setup-cloudshell.sh)
export PATH="$INSTALL_DIR:\$PATH"
export TLS_CA_CERT="$TLS_CERT"
PATHEOF
done

echo "═══════════════════════════════════════════════════════════"
echo " CloudShell setup complete!"
echo ""
echo " Tools installed:"
echo "   peer              $(peer version 2>&1 | grep Version | awk '{print $2}' || echo 'n/a')"
echo "   configtxgen       $(configtxgen -version 2>&1 | grep Version | awk '{print $2}' || echo 'n/a')"
echo "   configtxlator     ✓"
echo "   fabric-ca-client  $(fabric-ca-client version 2>&1 | grep Version | awk '{print $2}' || echo 'n/a')"
if command -v go &>/dev/null; then
echo "   go                $(go version | awk '{print $3}')"
fi
echo ""
echo " Endpoints:"
echo "   PEER_ENDPOINT=$PEER_ENDPOINT"
echo "   ORDERER=$ORDERER_ENDPOINT"
echo "   CA_ENDPOINT=$CA_ENDPOINT"
echo ""
echo " Next: ./sample/scripts/enroll-admin.sh"
echo "═══════════════════════════════════════════════════════════"
