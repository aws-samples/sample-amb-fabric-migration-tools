#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Member kit: everything one non-lead member of a multi-member migration runs,
# against its own peer, as its own identity, and hands to the lead.
#
# The lead member extracts every channel in full. Public data is identical on
# every peer, so each other member extracts only what no one else can: its own
# private data. This script runs, in one pass:
#
#   1. discover   — the member's channels, at the heights the lead announced
#   2. extract    — --private-only, Tier 3
#   3. validate   — the member's own output, before it leaves the member
#   4. package    — <member>-kit.tgz with a SHA-256 beside it
#
# The heights are not optional. Every member must extract the same ledger, so
# the lead quiesces the network, reads each channel's height, and sends them
# out; a member whose peer is at a different height stops here rather than at
# merge. A member that is still catching up just runs it again a minute later.
#
# The kit holds the member's private values in plaintext. Move it the way the
# consortium moves that data; this script does not encrypt it.
#
# Usage (run as the member, with its own MSP and peer):
#   ./member-kit.sh --member <name> --heights channel-a=1372,channel-b=1366 \
#     --out-dir ~/kit
#
# <name> is a member in $MM_HOME/members.list; its peer, IDs and MSP come from
# mm_use. A real member's equivalent is its own --network-id/--member-id/
# --node-id/--msp-path, which is all mm_use sets.
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"

MEMBER="" HEIGHTS="" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --member) MEMBER="$2"; shift 2 ;;
    --heights) HEIGHTS="$2"; shift 2 ;;
    --out-dir) OUT="$2"; shift 2 ;;
    *) mm_die "unknown option $1" ;;
  esac
done
[ -n "$MEMBER" ] || mm_die "--member is required"
[ -n "$HEIGHTS" ] || mm_die "--heights is required (channel=height,..., as the lead announced them)"
[ -n "$OUT" ] || mm_die "--out-dir is required"
# Owner-only: the extraction, logs and archive hold plaintext private data.
umask 077
mkdir -p "$OUT"
chmod 700 "$OUT"

mm_use "$MEMBER"
CLI=(node "$MM_PROJECT_ROOT/dist/cli/index.js")
[ -f "$MM_PROJECT_ROOT/dist/cli/index.js" ] || mm_die "build the toolkit first (npm run build)"
DIR="$OUT/$MEMBER"
[ ! -e "$DIR" ] || mm_die "$DIR exists — an extraction appends, so start from an empty directory"

declare -A WANT
for pair in ${HEIGHTS//,/ }; do
  [[ "$pair" =~ ^([A-Za-z0-9.-]+)=([0-9]+)$ ]] || mm_die "bad --heights entry '$pair' (want channel=height)"
  WANT[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
done

common=(--network-id "$NETWORK_ID" --member-id "$MEMBER_ID" --node-id "$NODE_ID" --msp-path "$MSP_PATH" --region "$REGION")

echo "── $MEMBER: discover ${!WANT[*]}"
"${CLI[@]}" discover "${common[@]}" --channels "${!WANT[@]}" --output-dir "$DIR" >"$OUT/$MEMBER-discover.log" 2>&1 ||
  { tail -5 "$OUT/$MEMBER-discover.log" >&2; mm_die "discover failed (log: $OUT/$MEMBER-discover.log)"; }

# The one check merge would otherwise make much later, after the member has
# sent a kit extracted at the wrong height.
bad=""
for ch in "${!WANT[@]}"; do
  got=$(jq -r --arg c "$ch" '.channels[] | select(.channelId == $c) | .ledgerHeight' "$DIR/manifest.json")
  [ "$got" = "${WANT[$ch]}" ] || bad+=" $ch: peer at ${got:-?}, lead announced ${WANT[$ch]};"
done
if [ -n "$bad" ]; then
  rm -rf "$DIR"
  mm_die "heights disagree —$bad wait for the peer to catch up (or for the lead to quiesce) and rerun"
fi

echo "── $MEMBER: extract --private-only"
"${CLI[@]}" extract --manifest "$DIR/manifest.json" --tier 3 --private-only \
  "${common[@]}" --output-dir "$DIR" --concurrency "${#WANT[@]}" >"$OUT/$MEMBER-extract.log" 2>&1 ||
  { tail -5 "$OUT/$MEMBER-extract.log" >&2; mm_die "extract failed (log: $OUT/$MEMBER-extract.log)"; }

echo "── $MEMBER: validate"
"${CLI[@]}" validate --input-dir "$DIR" >"$OUT/$MEMBER-validate.log" 2>&1 ||
  { grep -E "FAIL" "$OUT/$MEMBER-validate.log" >&2 || true; mm_die "validate failed (log: $OUT/$MEMBER-validate.log)"; }

rm -rf "$DIR"/channel-*/checkpoints
tar -czf "$OUT/$MEMBER-kit.tgz" -C "$OUT" "$MEMBER"
(cd "$OUT" && sha256sum "$MEMBER-kit.tgz" > "$MEMBER-kit.tgz.sha256")

values=$(cat "$DIR"/channel-*/private-*-state.ndjson 2>/dev/null | wc -l | tr -d ' ')
echo "Kit ready: $OUT/$MEMBER-kit.tgz ($(du -h "$OUT/$MEMBER-kit.tgz" | cut -f1), $values private values)"
echo "  sha256: $(cut -d' ' -f1 "$OUT/$MEMBER-kit.tgz.sha256")"
echo "  Send both files through the consortium's encrypted, authenticated private-data channel."
