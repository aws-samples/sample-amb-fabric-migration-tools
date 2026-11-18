#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Vendor Go dependencies for both chaincodes so they can be deployed to
# AMB peers, which have no internet access.
#
# AMB (and most production Fabric deployments) build chaincode inside the
# peer container, which has no outbound network access. Go chaincode must
# include a vendor/ directory with all dependencies pre-downloaded.
#
# This script runs `go mod tidy` + `go mod vendor` for:
#   - sample/chaincode/sample_assets/
#
# Prerequisites:
#   - Go 1.20+ installed (https://go.dev/dl/)
#
# Usage:
#   ./sample/scripts/vendor-deps.sh
#
set -euo pipefail

if ! command -v go &>/dev/null; then
  echo "ERROR: Go is not installed. Install Go 1.20+ from https://go.dev/dl/" >&2
  exit 1
fi

echo "Go version: $(go version)"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MIGRATION_SOURCE="$PROJECT_ROOT/sample/chaincode/migration_contract/go/migration.go"

# Vendor each chaincode module
for CC_DIR in \
  "$PROJECT_ROOT/sample/chaincode/sample_assets" \
  "$PROJECT_ROOT/sample/chaincode/trade_registry" \
  "$PROJECT_ROOT/sample/chaincode/consortium_ledger"; do

  CC_NAME="$(basename "$CC_DIR")"
  echo "=== Vendoring: $CC_NAME ==="
  echo "  Directory: $CC_DIR"

  if [ ! -f "$CC_DIR/go.mod" ]; then
    echo "  ERROR: go.mod not found, skipping" >&2
    continue
  fi

  # The chaincode imports migration/, so the file has to be in place before
  # `go mod tidy` resolves imports. Copied rather than checked in: Fabric
  # packages the chaincode directory whole, so it cannot live outside, and a
  # per-package copy in version control is one that drifts from the contract
  # the replay adapter calls. deploy-chaincode.sh copies it again.
  mkdir -p "$CC_DIR/migration"
  cp "$MIGRATION_SOURCE" "$CC_DIR/migration/migration.go"
  echo "  Copied migration contract from migration_contract/go/"

  pushd "$CC_DIR" > /dev/null

  echo "  Running go mod tidy..."
  go mod tidy

  echo "  Running go mod vendor..."
  go mod vendor

  # Verify vendor directory was created
  if [ -d vendor ]; then
    VENDOR_SIZE=$(du -sh vendor | cut -f1)
    VENDOR_MODULES=$(find vendor -name 'go.mod' -o -name '*.go' | head -1 | xargs dirname 2>/dev/null || echo "")
    echo "  Vendor directory: $VENDOR_SIZE"
    echo "  Modules vendored:"
    ls vendor/ 2>/dev/null | head -20 | sed 's/^/    /'
  else
    echo "  WARNING: vendor directory was not created" >&2
  fi

  popd > /dev/null
  echo ""
done

echo "Done. Chaincode is ready for offline deployment to AMB."
echo ""
echo "Important: commit the vendor/ directories to version control."
echo "The peer container will use these vendored dependencies during"
echo "chaincode build — it cannot download them at install time."
