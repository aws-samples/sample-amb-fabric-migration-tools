#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Create a channel among any number of members, join every member's peer, and
# set every member's anchor peer.
#
# The first member named creates the channel alone, and every other member is
# then added by a channel config update signed by a majority of the members
# already on it — the way a consortium grows in production. AMB does not accept a
# channel creation transaction that names more than one member (the orderer
# reports the creator's org missing from the read set), so this is also the
# only path that works. Each member's org definition comes from its shared
# artifacts ($MM_HOME/share/<member>, written by enroll.sh), and every member
# joins its own peer as itself. Anchor peers are what let one member's peer disseminate
# private data to another's, so a channel without them extracts with values
# missing from every collection a member did not endorse into itself.
#
# Idempotent: an existing channel is joined rather than recreated, a joined
# peer is left alone, and configure-anchor-peer.sh skips a configured anchor.
#
# Usage:
#   ./channel.sh channel-a MemberA MemberB MemberC
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
mm_network

CHANNEL="${1:?channel name required}"; shift
[ $# -ge 1 ] || mm_die "name at least one member"
MEMBERS=("$@")
CREATOR="${MEMBERS[0]}"

# One member's organization definition, from the artifacts it shared.
org_yaml() {
  local name="$1" msp
  msp=$(mm_msp_id "$name")
  cat <<ORG
    - &$name
        Name: $msp
        ID: $msp
        SkipAsForeign: false
        Policies:
            Readers: {Type: Signature, Rule: "OR('$msp.member')"}
            Writers: {Type: Signature, Rule: "OR('$msp.member')"}
            Admins:  {Type: Signature, Rule: "OR('$msp.admin')"}
        MSPDir: $MM_HOME/share/$name
ORG
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mm_use "$CREATOR"
if peer channel fetch oldest "$WORK/genesis.block" -c "$CHANNEL" \
     -o "$ORDERER_ENDPOINT" --cafile "$TLS_CA_CERT" --tls >/dev/null 2>&1; then
  echo "  channel $CHANNEL exists"
else
  echo "  creating $CHANNEL as $CREATOR"
  {
    echo "Organizations:"
    org_yaml "$CREATOR"
    cat <<'BODY'
Capabilities:
    Channel: &ChannelCapabilities {V2_0: true}
    Application: &ApplicationCapabilities {V2_0: true}
Channel: &ChannelDefaults
    Policies:
        Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
        Admins:  {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
    Capabilities: *ChannelCapabilities
Application: &ApplicationDefaults
    Organizations:
    Policies:
        LifecycleEndorsement: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Endorsement: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
        Admins:  {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
    Capabilities: *ApplicationCapabilities
Profiles:
    MultiMember:
        <<: *ChannelDefaults
        Consortium: AWSSystemConsortium
        Application:
            <<: *ApplicationDefaults
            Organizations:
BODY
    echo "                - *$CREATOR"
  } > "$WORK/configtx.yaml"

  configtxgen -outputCreateChannelTx "$WORK/$CHANNEL.tx" -profile MultiMember \
    -channelID "$CHANNEL" --configPath "$WORK" >/dev/null 2>&1
  peer channel create -c "$CHANNEL" -f "$WORK/$CHANNEL.tx" \
    -o "$ORDERER_ENDPOINT" --cafile "$TLS_CA_CERT" --tls \
    --outputBlock "$WORK/genesis.block" >/dev/null 2>&1 || mm_die "creating $CHANNEL failed"
fi

# ── Add every other member by config update ──
ON_CHANNEL=("$CREATOR")
for name in "${MEMBERS[@]:1}"; do
  msp=$(mm_msp_id "$name")
  mm_use "$CREATOR"
  peer channel fetch config "$WORK/config.pb" -c "$CHANNEL" -o "$ORDERER_ENDPOINT" \
    --cafile "$TLS_CA_CERT" --tls >/dev/null 2>&1 || mm_die "fetching $CHANNEL config failed"
  configtxlator proto_decode --type common.Block --input "$WORK/config.pb" |
    jq '.data.data[0].payload.data.config' > "$WORK/config.json"
  # Members already in the config count toward the majority for the next add.
  ON_CHANNEL=()
  for m in "${MEMBERS[@]}"; do
    if jq -e --arg k "$(mm_msp_id "$m")" '.channel_group.groups.Application.groups[$k]' "$WORK/config.json" >/dev/null; then
      ON_CHANNEL+=("$m")
    fi
  done
  if printf '%s\n' "${ON_CHANNEL[@]}" | grep -qx "$name"; then
    echo "  $name already on $CHANNEL"
    continue
  fi

  { echo "Organizations:"; org_yaml "$name"; } > "$WORK/configtx.yaml"
  configtxgen -printOrg "$msp" --configPath "$WORK" > "$WORK/org.json" 2>/dev/null ||
    mm_die "configtxgen -printOrg for $name failed"
  jq --arg k "$msp" --slurpfile org "$WORK/org.json" \
    '.channel_group.groups.Application.groups[$k] = $org[0]' "$WORK/config.json" > "$WORK/modified.json"
  configtxlator proto_encode --type common.Config --input "$WORK/config.json" --output "$WORK/a.pb"
  configtxlator proto_encode --type common.Config --input "$WORK/modified.json" --output "$WORK/b.pb"
  configtxlator compute_update --channel_id "$CHANNEL" --original "$WORK/a.pb" --updated "$WORK/b.pb" \
    --output "$WORK/update.pb"
  configtxlator proto_decode --type common.ConfigUpdate --input "$WORK/update.pb" |
    jq --arg ch "$CHANNEL" '{payload:{header:{channel_header:{channel_id:$ch,type:2}},data:{config_update:.}}}' |
    configtxlator proto_encode --type common.Envelope --output "$WORK/envelope.pb"

  # MAJORITY Admins of the members already there: a strict majority signs.
  need=$(( ${#ON_CHANNEL[@]} / 2 + 1 ))
  signers=("${ON_CHANNEL[@]:0:$need}")
  for signer in "${signers[@]:0:$((need - 1))}"; do
    mm_use "$signer"
    peer channel signconfigtx -f "$WORK/envelope.pb" >/dev/null 2>&1 || mm_die "$signer could not sign the $name addition"
  done
  mm_use "${signers[$((need - 1))]}"
  peer channel update -f "$WORK/envelope.pb" -c "$CHANNEL" -o "$ORDERER_ENDPOINT" \
    --cafile "$TLS_CA_CERT" --tls >/dev/null 2>&1 || mm_die "adding $name to $CHANNEL failed"
  # The next addition reads the config to count signers, so it must see this
  # one committed first: read too early, it signs as though the member just
  # added were not there, and the update fails the majority it now needs.
  for _ in $(seq 1 30); do
    peer channel fetch config "$WORK/config.pb" -c "$CHANNEL" -o "$ORDERER_ENDPOINT" \
      --cafile "$TLS_CA_CERT" --tls >/dev/null 2>&1 &&
      configtxlator proto_decode --type common.Block --input "$WORK/config.pb" |
      jq -e --arg k "$msp" '.data.data[0].payload.data.config.channel_group.groups.Application.groups[$k]' >/dev/null &&
      break
    sleep 2
  done
  echo "  added $name to $CHANNEL (signed by ${signers[*]})"
done

for name in "${MEMBERS[@]}"; do
  mm_use "$name"
  if peer channel list 2>/dev/null | grep -qx "$CHANNEL"; then
    echo "  $name already joined $CHANNEL"
  else
    mm_retry 6 peer channel fetch oldest "$WORK/genesis.block" -c "$CHANNEL" \
      -o "$ORDERER_ENDPOINT" --cafile "$TLS_CA_CERT" --tls >/dev/null 2>&1 ||
      mm_die "$name could not fetch the $CHANNEL genesis block"
    mm_retry 6 peer channel join -b "$WORK/genesis.block" >/dev/null 2>&1 ||
      mm_die "$name could not join $CHANNEL"
    echo "  $name joined $CHANNEL"
  fi
done

for name in "${MEMBERS[@]}"; do
  mm_use "$name"
  CHANNEL_NAME="$CHANNEL" bash "$MM_SCRIPTS_DIR/configure-anchor-peer.sh" >"$WORK/anchor-$name.log" 2>&1 ||
    { cat "$WORK/anchor-$name.log" >&2; mm_die "$name anchor peer update on $CHANNEL failed"; }
  echo "  $name anchor peer set on $CHANNEL"
done
