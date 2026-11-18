#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Deploy one chaincode to one channel as a multi-org definition: every member
# installs it on its own peer and approves it for its own org, then the first
# member commits.
#
# Collection templates name orgs by position: Org1MSP, Org2MSP and Org3MSP
# render to the first, second and third member named here, and OR(ALL_ORGS) to
# every member. The rendered config is part of the definition, so every member
# approves the identical file. A placeholder with no member to render to is
# refused, because Fabric commits a policy naming an unknown MSP happily and
# then rejects every write to that collection.
#
# Idempotent: an installed package is reused, an approval already recorded is
# not repeated, and a committed definition at this sequence is left alone.
#
# Usage:
#   ./deploy.sh <channel> <chaincode> <sequence> <member>...
#   ./deploy.sh channel-a consortium_ledger 1 MemberA MemberB MemberC
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
mm_network

CHANNEL="${1:?channel}"; CC="${2:?chaincode}"; SEQ="${3:?sequence}"; shift 3
[ $# -ge 1 ] || mm_die "name at least one member"
MEMBERS=("$@")
VERSION="${MM_CC_VERSION:-1.0}"   # a new version packages changed code under a new label
LABEL="${CC}_${VERSION}"
# MM_CC_PATH: your own chaincode directory instead of sample/chaincode/<name>. MM_CC_LANG: golang (default), node, java.
CC_PATH="${MM_CC_PATH:-$MM_PROJECT_ROOT/sample/chaincode/$CC}"
CC_LANG="${MM_CC_LANG:-golang}"
[ -d "$CC_PATH" ] || mm_die "chaincode directory $CC_PATH not found"
# AMB peers build Go chaincode without network access, so its modules must be vendored.
[ "$CC_LANG" != golang ] || [ -d "$CC_PATH/vendor" ] ||
  mm_die "$CC_PATH/vendor missing — run go mod vendor there (sample/scripts/vendor-deps.sh for the samples)"

mkdir -p "$MM_HOME/deploy"
COLLECTIONS="$MM_HOME/deploy/$CHANNEL-$CC-collections.json"
COLL_ARGS=()
if [ -f "$CC_PATH/collections_config.json" ]; then
  msps=()
  for name in "${MEMBERS[@]}"; do msps+=("$(mm_msp_id "$name")"); done
  all=$(printf "'%s.member'," "${msps[@]}"); all="${all%,}"
  sed_args=(-e "s/ALL_ORGS/$all/g")
  for i in "${!msps[@]}"; do sed_args+=(-e "s/Org$((i + 1))MSP/${msps[$i]}/g"); done
  sed "${sed_args[@]}" "$CC_PATH/collections_config.json" > "$COLLECTIONS"
  if grep -qE 'Org[0-9]MSP|ALL_ORGS' "$COLLECTIONS"; then
    grep -nE 'Org[0-9]MSP|ALL_ORGS' "$COLLECTIONS" >&2
    mm_die "$CC's collection template names more orgs than $CHANNEL has (${MEMBERS[*]})"
  fi
  COLL_ARGS=(--collections-config "$COLLECTIONS")
fi

# The bundled samples import the migration contract, so it is copied fresh into them. A source network does not need
# it: extraction reads blocks. Your own chaincode is packaged as it is.
if [ -z "${MM_CC_PATH:-}" ]; then
  mkdir -p "$CC_PATH/migration"
  cp "$MM_PROJECT_ROOT/sample/chaincode/migration_contract/go/migration.go" "$CC_PATH/migration/"
fi

mm_use "${MEMBERS[0]}"
PKG="$MM_HOME/deploy/$LABEL.tar.gz"
[ -f "$PKG" ] || peer lifecycle chaincode package "$PKG" --path "$CC_PATH" --lang "$CC_LANG" --label "$LABEL"

committed=$(peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC" -O json 2>/dev/null | jq -r '.sequence // 0' || echo 0)

for name in "${MEMBERS[@]}"; do
  mm_use "$name"
  pkg_id=$(peer lifecycle chaincode queryinstalled -O json 2>/dev/null |
    jq -r --arg l "$LABEL" '.installed_chaincodes[]? | select(.label==$l) | .package_id' | head -1)
  if [ -z "$pkg_id" ]; then
    echo "  $name: installing $LABEL (the peer builds Go chaincode; this takes a few minutes)"
    peer lifecycle chaincode install "$PKG" >/dev/null 2>&1 || mm_die "$name: install of $LABEL failed"
    pkg_id=$(peer lifecycle chaincode queryinstalled -O json |
      jq -r --arg l "$LABEL" '.installed_chaincodes[] | select(.label==$l) | .package_id' | head -1)
  fi
  approved=$(peer lifecycle chaincode queryapproved -C "$CHANNEL" -n "$CC" --sequence "$SEQ" -O json 2>/dev/null |
    jq -r '.source.Type.LocalPackage.package_id // empty' || true)
  if [ "$approved" = "$pkg_id" ]; then
    echo "  $name: already approved $CC seq $SEQ on $CHANNEL"
    continue
  fi
  # Retried: a peer that just joined an existing channel replays it from the
  # genesis block, and until it reaches the config block that added its own
  # org it refuses that org's proposals ("access denied: creator org").
  mm_retry 18 peer lifecycle chaincode approveformyorg -C "$CHANNEL" -n "$CC" -v "$VERSION" \
    --package-id "$pkg_id" --sequence "$SEQ" "${COLL_ARGS[@]}" \
    -o "$ORDERER_ENDPOINT" --tls --cafile "$TLS_CA_CERT" --waitForEvent >/dev/null 2>&1 ||
    mm_die "$name: approveformyorg for $CC on $CHANNEL failed"
  echo "  $name: approved $CC seq $SEQ on $CHANNEL"
done

mm_use "${MEMBERS[0]}"
if [ "$committed" -ge "$SEQ" ]; then
  echo "  $CC already committed on $CHANNEL at sequence $committed"
else
  peer lifecycle chaincode checkcommitreadiness -C "$CHANNEL" -n "$CC" -v "$VERSION" \
    --sequence "$SEQ" "${COLL_ARGS[@]}" -O json | jq -c .approvals
  peer lifecycle chaincode commit -C "$CHANNEL" -n "$CC" -v "$VERSION" --sequence "$SEQ" \
    "${COLL_ARGS[@]}" -o "$ORDERER_ENDPOINT" --tls --cafile "$TLS_CA_CERT" --waitForEvent >/dev/null 2>&1 ||
    mm_die "commit of $CC on $CHANNEL failed"
  echo "  committed $CC seq $SEQ on $CHANNEL"
fi
