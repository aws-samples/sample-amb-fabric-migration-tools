#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Verify a replay using the same replay config and implementation as the CLI.
#
# This wrapper intentionally contains no chaincode-specific query logic. The old
# sample hardcoded sample_assets/ReadAsset for every namespace, treated '~' as a
# composite-key delimiter, and reported private reads as OK without comparing
# values. Delegating keeps multi-channel routing, binary values, private data,
# history, extra-key sweeps, and exit codes identical to `amb-migrate verify`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INPUT_DIR=""
CONFIG=""
CHANNELS=()

usage() {
  cat >&2 <<'USAGE'
Usage: verify-replay.sh --input-dir <path> --config <replay-config.json> [--channels <name...>]

The config must be the same config used for replay. Exit codes are the verify
CLI contract: 0 match, 1 mismatch/missing/extra, 2 query errors or nothing checked.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input-dir) INPUT_DIR=${2:-}; shift 2 ;;
    --config) CONFIG=${2:-}; shift 2 ;;
    --channels)
      shift
      while [[ $# -gt 0 && $1 != --* ]]; do CHANNELS+=("$1"); shift; done
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z $INPUT_DIR || -z $CONFIG ]]; then
  usage
  exit 2
fi

if [[ ! -f "$ROOT_DIR/dist/cli/index.js" ]]; then
  echo "dist/cli/index.js is missing; run npm run build first" >&2
  exit 2
fi

args=(verify --input-dir "$INPUT_DIR" --config "$CONFIG")
if [[ ${#CHANNELS[@]} -gt 0 ]]; then args+=(--channels "${CHANNELS[@]}"); fi
exec node "$ROOT_DIR/dist/cli/index.js" "${args[@]}"
