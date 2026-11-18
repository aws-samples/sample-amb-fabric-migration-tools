#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Tear down the destination test-network and clean up.
#
set -euo pipefail

FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$HOME/fabric-samples}"
TEST_NETWORK_DIR="$FABRIC_SAMPLES_DIR/test-network"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GENERATED_MARKER_DIR="$PROJECT_ROOT/sample/destination-config/.live-test-generated"

if [ -d "$TEST_NETWORK_DIR" ]; then
  echo "Tearing down test-network..."
  pushd "$TEST_NETWORK_DIR" > /dev/null
  ./network.sh down
  popd > /dev/null
else
  echo "test-network not found at $TEST_NETWORK_DIR; cleaning generated local artifacts"
fi
for cc in sample_assets trade_registry; do
  if [ -f "$GENERATED_MARKER_DIR/$cc-migration" ]; then
    rm -rf "$PROJECT_ROOT/sample/chaincode/$cc/migration"
  fi
  if [ -f "$GENERATED_MARKER_DIR/$cc-vendor" ]; then
    rm -rf "$PROJECT_ROOT/sample/chaincode/$cc/vendor"
  fi
done
rm -rf "$GENERATED_MARKER_DIR"

rm -rf \
  "$FABRIC_SAMPLES_DIR/chaincode-deploy-sample_assets" \
  "$FABRIC_SAMPLES_DIR/chaincode-deploy-trade_registry"
rm -f \
  "$PROJECT_ROOT/sample/destination-config/connection-profile.json" \
  "$PROJECT_ROOT/sample/destination-config/replay-config.json"

echo "Removed test-created dependency copies, chaincode deployment copies, and replay configs"
echo "Done."
