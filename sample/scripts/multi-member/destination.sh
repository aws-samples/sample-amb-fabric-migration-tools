#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Build a Fabric 2.5 destination that mirrors a multi-member source: one org
# per source member, the same channels with the same members, and every
# chaincode committed under its source name with the migration contract.
#
# Source member N (in $MM_HOME/members.list order) becomes Org<N>MSP, so the
# destination's MSP IDs differ from AMB's m-... IDs exactly as a real
# destination's would — which is what mspMapping and orgIdentities are for.
#
# Any number of members. The network is generated rather than taken from
# fabric-samples' test-network, whose Org1/Org2 layout plus the addOrg3 add-on
# stopped at three: cryptogen issues one peer org per member and one orderer
# org, configtx.yaml carries one profile per plan channel naming exactly that
# channel's members, and every channel is created through the orderer's
# channel participation API (no system channel), so a channel's membership is
# its genesis block rather than a sequence of config updates. One Raft
# orderer, and one peer with its own CouchDB per org, all in one Compose
# project on this host. Five orgs used 1.7 GiB in all, chaincode included.
#
# Everything — crypto, channel blocks, Compose file, connection profiles,
# replay-config.json — is written under $MM_HOME/destination/, so shipping
# that one directory gives the replay host every certificate and key it
# needs. Every run tears down the previous network and starts empty: a Tier 3
# history replay is one-shot.
#
# Ports: orderer 7050 (admin 7053); peer of Org<N> at 7051 + 2000·(N-1), so
# Org1–Org3 keep test-network's 7051/9051/11051. The orderer and peers are
# published on one host address only: 127.0.0.1, or MM_DEST_HOST when replay
# runs on another host. CouchDB is not published at all.
#
# Usage:
#   ./destination.sh --plan populate-plan.json --input-dir <merged-extraction>
#
# Optional environment:
#   MM_DEST_HOST          Address replay reaches the peers at (default localhost).
#                         Set it to this host's private IP when replay runs on
#                         another host; TLS is checked against each peer's own
#                         hostname, not this address. The orderer and peer ports
#                         are published on this address (127.0.0.1 by default),
#                         never on every interface.
#   MM_CC_ROOT            Directory of your own chaincodes, one subdirectory per plan
#                         chaincode name (default sample/chaincode). Each must import
#                         and register the migration contract; see
#                         sample/chaincode/migration_contract/README.md.
#   MM_BATCH_TIMEOUT      Orderer BatchTimeout for every channel (default 2s).
#                         Shorter cuts blocks sooner, so each round of a history
#                         replay commits sooner.
#   MM_MAX_MESSAGE_COUNT  Orderer MaxMessageCount (default 10).
#   MM_FABRIC_HOME        Where the Fabric 2.5 binaries and config are, or are
#                         installed to (default ~/fabric-2.5).
#   MM_KEEP_BLOCK_TO_LIVE 1 keeps the source collections' blockToLive (below).
#   MM_ENDORSEMENT        Chaincode endorsement policy over each channel's
#                         member peers: or (default, any one), majority
#                         (more than half) or and (every one). Under majority
#                         or and, each explicit collection is also given its
#                         own endorsementPolicy of the same kind over its own
#                         members: without one, a collection with fewer members
#                         than the chaincode policy needs cannot be written
#                         through the Gateway at all. Implicit collections
#                         always need only their owner's peer.
#   MM_NO_COLLECTION_ENDORSEMENT
#                         1 leaves collections without their own policy, to
#                         reproduce that refusal.
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PLAN="" INPUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --input-dir) INPUT_DIR="$2"; shift 2 ;;
    *) mm_die "unknown option $1" ;;
  esac
done
[ -f "$PLAN" ] || mm_die "--plan is required"
[ -n "$INPUT_DIR" ] || mm_die "--input-dir is required"

FABRIC_VERSION=2.5.11
FABRIC_HOME="${MM_FABRIC_HOME:-$HOME/fabric-2.5}"
DEST="$MM_HOME/destination"
NET="$DEST/network"
ORGS="$DEST/organizations"
PROJECT=mm-dest
mapfile -t SOURCE_MEMBERS < <(mm_members)
N=${#SOURCE_MEMBERS[@]}
[ "$N" -ge 1 ] || mm_die "$MM_HOME/members.list is empty"
# The last peer port has to stay below 65535.
[ "$N" -le 29 ] || mm_die "at most 29 orgs fit the port layout ($N members listed)"

dest_index() {  # source member name -> 1-based destination org number
  local i
  for i in "${!SOURCE_MEMBERS[@]}"; do
    [ "${SOURCE_MEMBERS[$i]}" = "$1" ] && { echo $((i + 1)); return; }
  done
  mm_die "member $1 is not in $MM_HOME/members.list"
}
case "${MM_ENDORSEMENT:-or}" in or|majority|and) ;; *) mm_die "MM_ENDORSEMENT must be or, majority or and (got $MM_ENDORSEMENT)" ;; esac
# Every plan member has to be a source member before anything is torn down.
for m in $(jq -r '[.channels[].members[]] | unique | .[]' "$PLAN"); do dest_index "$m" >/dev/null; done

peer_port() { echo $((7051 + 2000 * ($1 - 1))); }
# The one host address the orderer and peers are published on: loopback when replay runs here, the destination's
# own private address when it runs elsewhere. Publishing on every interface would put them on the host's public IP.
case "${MM_DEST_HOST:-localhost}" in
  localhost|127.0.0.1) PUBLISH_ADDR=127.0.0.1 ;;
  0.0.0.0|::|'[::]'|'*') mm_die "MM_DEST_HOST must be one address, not every interface" ;;
  *) PUBLISH_ADDR="$MM_DEST_HOST" ;;
esac
peer_tls() { echo "$ORGS/peerOrganizations/org$1.example.com/tlsca/tlsca.org$1.example.com-cert.pem"; }
ORDERER_CA="$ORGS/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORDERER_TLS="$ORGS/ordererOrganizations/example.com/orderers/orderer.example.com/tls"

# ── Fabric binaries and images ──
if [ ! -x "$FABRIC_HOME/bin/peer" ]; then
  mkdir -p "$FABRIC_HOME"
  (cd "$FABRIC_HOME" && curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh |
    bash -s -- docker binary -f "$FABRIC_VERSION" -c 1.5.12 >/dev/null) || mm_die "installing Fabric $FABRIC_VERSION failed"
fi
export PATH="$FABRIC_HOME/bin:$PATH" FABRIC_CFG_PATH="$FABRIC_HOME/config"
unset CORE_PEER_ADDRESS CORE_PEER_LOCALMSPID CORE_PEER_MSPCONFIGPATH CORE_PEER_TLS_ROOTCERT_FILE

# ── Tear down the previous network ──
# Chaincode containers are started by this project's peers, not by Compose.
# Remove only containers attached to this project's named network before
# Compose tries to remove that network.
mapfile -t chaincode_containers < <(docker ps -aq --filter "network=$PROJECT" --filter name=dev-peer)
[ "${#chaincode_containers[@]}" -eq 0 ] || docker rm -f "${chaincode_containers[@]}" >/dev/null
# By project name and its generated file. Compose still validates variable
# substitutions for `down`, though the password value is unused there.
if [ -f "$NET/compose.yaml" ]; then
  MM_COUCHDB_PASSWORD=unused docker compose -p "$PROJECT" -f "$NET/compose.yaml" \
    down -v --remove-orphans >/dev/null || mm_die "tearing down the previous destination failed"
else
  # Recover a project whose generated directory was removed. Labels keep this
  # scoped to mm-dest rather than touching another Fabric test network.
  mapfile -t old_containers < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
  [ "${#old_containers[@]}" -eq 0 ] || docker rm -f "${old_containers[@]}" >/dev/null
  mapfile -t old_volumes < <(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")
  [ "${#old_volumes[@]}" -eq 0 ] || docker volume rm "${old_volumes[@]}" >/dev/null
  docker network rm "$PROJECT" >/dev/null 2>&1 || true
fi
if docker ps --format '{{.Ports}}' | grep -q ':7050->'; then
  mm_die "port 7050 is in use by another container — stop it first (for an old test-network: ~/fabric-samples/test-network/network.sh down)"
fi
rm -rf "$NET" "$ORGS" "$DEST/build"
mkdir -p "$NET"

# ── Crypto ──
{
  cat <<EOF
OrdererOrgs:
  - Name: Orderer
    Domain: example.com
    EnableNodeOUs: true
    Specs:
      - Hostname: orderer
        SANS: [localhost, $PUBLISH_ADDR]
PeerOrgs:
EOF
  for o in $(seq 1 "$N"); do
    cat <<EOF
  - Name: Org$o
    Domain: org$o.example.com
    EnableNodeOUs: true
    Template: {Count: 1, SANS: [localhost, $PUBLISH_ADDR]}
    Users: {Count: 1}
EOF
  done
} > "$NET/crypto-config.yaml"
cryptogen generate --config "$NET/crypto-config.yaml" --output "$ORGS" >/dev/null || mm_die "cryptogen failed"

# ── Channel configuration ──
# One org definition per member and one profile per plan channel. A profile
# lists exactly that channel's orgs, so the genesis block is the membership.
{
  cat <<EOF
Organizations:
  - &OrdererOrg
    Name: OrdererOrg
    ID: OrdererMSP
    MSPDir: $ORGS/ordererOrganizations/example.com/msp
    Policies:
      Readers: {Type: Signature, Rule: "OR('OrdererMSP.member')"}
      Writers: {Type: Signature, Rule: "OR('OrdererMSP.member')"}
      Admins: {Type: Signature, Rule: "OR('OrdererMSP.admin')"}
    OrdererEndpoints: [orderer.example.com:7050]
EOF
  for o in $(seq 1 "$N"); do
    cat <<EOF
  - &Org$o
    Name: Org${o}MSP
    ID: Org${o}MSP
    MSPDir: $ORGS/peerOrganizations/org$o.example.com/msp
    Policies:
      Readers: {Type: Signature, Rule: "OR('Org${o}MSP.admin', 'Org${o}MSP.peer', 'Org${o}MSP.client')"}
      Writers: {Type: Signature, Rule: "OR('Org${o}MSP.admin', 'Org${o}MSP.client')"}
      Admins: {Type: Signature, Rule: "OR('Org${o}MSP.admin')"}
      Endorsement: {Type: Signature, Rule: "OR('Org${o}MSP.peer')"}
    AnchorPeers: [{Host: peer0.org$o.example.com, Port: $(peer_port "$o")}]
EOF
  done
  cat <<EOF
Capabilities:
  Channel: &ChannelCapabilities {V2_0: true}
  Orderer: &OrdererCapabilities {V2_0: true}
  Application: &ApplicationCapabilities {V2_5: true}
Application: &ApplicationDefaults
  Organizations:
  Policies:
    Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
    Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
    Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
    LifecycleEndorsement: {Type: ImplicitMeta, Rule: "MAJORITY Endorsement"}
    Endorsement: {Type: ImplicitMeta, Rule: "MAJORITY Endorsement"}
  Capabilities: *ApplicationCapabilities
Orderer: &OrdererDefaults
  OrdererType: etcdraft
  EtcdRaft:
    Consenters:
      - Host: orderer.example.com
        Port: 7050
        ClientTLSCert: $ORDERER_TLS/server.crt
        ServerTLSCert: $ORDERER_TLS/server.crt
  BatchTimeout: ${MM_BATCH_TIMEOUT:-2s}
  BatchSize:
    MaxMessageCount: ${MM_MAX_MESSAGE_COUNT:-10}
    AbsoluteMaxBytes: 99 MB
    PreferredMaxBytes: 512 KB
  Organizations:
  Policies:
    Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
    Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
    Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
    BlockValidation: {Type: ImplicitMeta, Rule: "ANY Writers"}
  Capabilities: *OrdererCapabilities
Channel: &ChannelDefaults
  Policies:
    Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
    Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
    Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
  Capabilities: *ChannelCapabilities
Profiles:
EOF
  for row in $(jq -c '.channels[] | {name, members}' "$PLAN"); do
    ch=$(jq -r .name <<<"$row")
    refs=$(for m in $(jq -r '.members[]' <<<"$row"); do printf '*Org%s, ' "$(dest_index "$m")"; done)
    cat <<EOF
  $ch:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      Organizations: [*OrdererOrg]
    Application:
      <<: *ApplicationDefaults
      Organizations: [${refs%, }]
EOF
  done
} > "$NET/configtx.yaml"
# For destination-check.sh, which has to gather the endorsements this asks for.
echo "${MM_ENDORSEMENT:-or}" > "$NET/endorsement"
echo "  $N orgs; endorsement ${MM_ENDORSEMENT:-or}; orderer BatchTimeout ${MM_BATCH_TIMEOUT:-2s}, MaxMessageCount ${MM_MAX_MESSAGE_COUNT:-10}"

# ── Containers ──
# Containers take Compose's project-prefixed names, so a stopped test-network
# on the same host cannot collide with them; the hostnames TLS and gossip use
# are the service names, which resolve on the project network.
# A peer that starts before its CouchDB answers exits; restart brings it back.
# The CouchDB password is a fixed local value: CouchDB is reachable only on
# the Compose network, never published.
{
  cat <<EOF
name: $PROJECT
networks:
  dest:
    name: $PROJECT
volumes:
  orderer:
services:
  orderer.example.com:
    image: hyperledger/fabric-orderer:$FABRIC_VERSION
    restart: unless-stopped
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT=7050
      - ORDERER_GENERAL_LOCALMSPID=OrdererMSP
      - ORDERER_GENERAL_LOCALMSPDIR=/var/hyperledger/orderer/msp
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_CLUSTER_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_ADMIN_TLS_ENABLED=true
      - ORDERER_ADMIN_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_ADMIN_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_ADMIN_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:7053
    volumes:
      - $ORGS/ordererOrganizations/example.com/orderers/orderer.example.com/msp:/var/hyperledger/orderer/msp
      - $ORDERER_TLS:/var/hyperledger/orderer/tls
      - orderer:/var/hyperledger/production/orderer
    ports: ["$PUBLISH_ADDR:7050:7050", "127.0.0.1:7053:7053"]
    networks: [dest]
EOF
  for o in $(seq 1 "$N"); do
    p=$(peer_port "$o"); host="peer0.org$o.example.com"
    pdir="$ORGS/peerOrganizations/org$o.example.com/peers/$host"
    cat <<EOF
  couchdb$o:
    image: couchdb:3.4.2
    restart: unless-stopped
    environment: [COUCHDB_USER=admin, 'COUCHDB_PASSWORD=\${MM_COUCHDB_PASSWORD:?}']
    networks: [dest]
  $host:
    image: hyperledger/fabric-peer:$FABRIC_VERSION
    restart: unless-stopped
    depends_on: [couchdb$o]
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_VM_ENDPOINT=unix:///host/var/run/docker.sock
      - CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE=$PROJECT
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
      - CORE_PEER_ID=$host
      - CORE_PEER_ADDRESS=$host:$p
      - CORE_PEER_LISTENADDRESS=0.0.0.0:$p
      - CORE_PEER_CHAINCODEADDRESS=$host:$((p + 1))
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:$((p + 1))
      - CORE_PEER_GOSSIP_BOOTSTRAP=$host:$p
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT=$host:$p
      - CORE_PEER_LOCALMSPID=Org${o}MSP
      - CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp
      - CORE_LEDGER_STATE_STATEDATABASE=CouchDB
      - CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS=couchdb$o:5984
      - CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin
      - CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=\${MM_COUCHDB_PASSWORD:?}
    volumes:
      - $pdir/msp:/etc/hyperledger/fabric/msp
      - $pdir/tls:/etc/hyperledger/fabric/tls
      - /var/run/docker.sock:/host/var/run/docker.sock
    ports: ["$PUBLISH_ADDR:$p:$p"]
    networks: [dest]
EOF
  done
} > "$NET/compose.yaml"
# A fresh CouchDB password per network, passed through the environment so compose.yaml holds none. It is not
# kept anywhere: restart the destination with this script rather than one service with `docker compose up`, which
# fails without MM_COUCHDB_PASSWORD.
MM_COUCHDB_PASSWORD=$(openssl rand -hex 16) \
  docker compose -p "$PROJECT" -f "$NET/compose.yaml" up -d >/dev/null 2>&1 || mm_die "starting the network failed"

# The peer CLI acts as one org's admin against that org's peer.
use_org() {
  CORE_PEER_ADDRESS="$PUBLISH_ADDR:$(peer_port "$1")"
  CORE_PEER_TLS_ROOTCERT_FILE="$(peer_tls "$1")"
  unset CORE_PEER_TLS_SERVERHOSTOVERRIDE
  export CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID="Org$1MSP" CORE_PEER_ADDRESS CORE_PEER_TLS_ROOTCERT_FILE
  export CORE_PEER_MSPCONFIGPATH="$ORGS/peerOrganizations/org$1.example.com/users/Admin@org$1.example.com/msp"
}
for o in $(seq 1 "$N"); do
  use_org "$o"
  for _ in $(seq 1 60); do peer channel list >/dev/null 2>&1 && break; sleep 2; done
  peer channel list >/dev/null 2>&1 || mm_die "peer0.org$o did not come up"
done

# ── Channels ──
osn() {
  osnadmin channel "$@" -o localhost:7053 --ca-file "$ORDERER_CA" \
    --client-cert "$ORDERER_TLS/server.crt" --client-key "$ORDERER_TLS/server.key"
}
for row in $(jq -c '.channels[] | {name, members}' "$PLAN"); do
  ch=$(jq -r .name <<<"$row")
  configtxgen -configPath "$NET" -profile "$ch" -channelID "$ch" -outputBlock "$NET/$ch.block" >/dev/null 2>&1 ||
    mm_die "configtxgen for $ch failed"
  osn join --channelID "$ch" --config-block "$NET/$ch.block" >/dev/null || mm_die "orderer join $ch failed"
  for _ in $(seq 1 30); do
    [ "$(osn list --channelID "$ch" 2>/dev/null | sed -n '/^{/,$p' | jq -r .status)" = active ] && break
    sleep 1
  done
  orgs=()
  for m in $(jq -r '.members[]' <<<"$row"); do
    o=$(dest_index "$m"); orgs+=("$o"); use_org "$o"
    peer channel join -b "$NET/$ch.block" >/dev/null 2>&1 || mm_die "Org$o join $ch failed"
  done
  echo "  created $ch for Org${orgs[*]}"
done

# ── Chaincodes ──
# MM_CC_ROOT: a directory holding one chaincode directory per plan chaincode name (default sample/chaincode).
# Each must import the migration package (<module>/migration) and register migration.MigrationContract.
CC_ROOT="${MM_CC_ROOT:-$MM_PROJECT_ROOT/sample/chaincode}"
WRITERS=$(for i in "${!SOURCE_MEMBERS[@]}"; do printf '"Org%dMSP", ' $((i + 1)); done); WRITERS="${WRITERS%, }"
declare -A INSTALLED
for row in $(jq -c '.channels[] | {name, members, chaincodes}' "$PLAN"); do
  ch=$(jq -r .name <<<"$row")
  mapfile -t members < <(jq -r '.members[]' <<<"$row")
  orgs=(); for m in "${members[@]}"; do orgs+=("$(dest_index "$m")"); done
  peers_list=$(for o in "${orgs[@]}"; do printf "'Org%sMSP.peer'," "$o"; done | sed 's/,$//')
  case "${MM_ENDORSEMENT:-or}" in
    or) policy="OR($peers_list)" ;;
    and) policy="AND($peers_list)" ;;
    majority) policy="OutOf($(( ${#orgs[@]} / 2 + 1 )), $peers_list)" ;;
  esac

  for cc in $(jq -r '.chaincodes[]' <<<"$row"); do
    work="$DEST/build/$cc"
    if [ ! -f "$DEST/build/$cc.tar.gz" ]; then
      rm -rf "$work"; mkdir -p "$work"
      [ -d "$CC_ROOT/$cc" ] || mm_die "chaincode $cc not found under $CC_ROOT (set MM_CC_ROOT)"
      cp -r "$CC_ROOT/$cc/." "$work/"
      mkdir -p "$work/migration"
      sed "s|^var writerMSPIDs = \[\]string{}$|var writerMSPIDs = []string{$WRITERS}|" \
        "$MM_PROJECT_ROOT/sample/chaincode/migration_contract/go/migration.go" > "$work/migration/migration.go"
      grep -q "writerMSPIDs = \[\]string{$WRITERS}" "$work/migration/migration.go" ||
        mm_die "could not render the writer list into $cc's migration contract"
      use_org 1
      peer lifecycle chaincode package "$DEST/build/$cc.tar.gz" --path "$work" --lang golang --label "${cc}_1.0" ||
        mm_die "packaging $cc failed"
    fi

    # The same positional template the source rendered, with destination MSPs.
    coll_args=()
    if [ -f "$work/collections_config.json" ]; then
      # Every placeholder renders to a temporary token first and the tokens to
      # MSP IDs last, so no destination name is ever rewritten by a later
      # positional rule: on a channel of Org1/Org3/Org5, ALL_ORGS expanded
      # straight to MSP IDs had its Org3MSP rewritten as position 3, to Org5MSP.
      all=$(for o in "${orgs[@]}"; do printf "'@@%s@@.member'," "$o"; done | sed 's/,$//')
      sed_args=()
      for i in "${!orgs[@]}"; do sed_args+=(-e "s/Org$((i + 1))MSP/@@${orgs[$i]}@@/g"); done
      sed_args+=(-e "s/ALL_ORGS/$all/g")
      sed_args+=(-e 's/@@\([0-9]\{1,\}\)@@/Org\1MSP/g')
      # blockToLive 0, so this test destination does not purge what replay
      # writes before verify reads it. Fabric does not allow it to be changed
      # later, so this is the collection's lasting value here
      # (docs/replay-config-reference.md#destination-blocktolive-during-migration).
      # MM_KEEP_BLOCK_TO_LIVE=1 keeps the source values, to reproduce the purge.
      btl='.'
      [ "${MM_KEEP_BLOCK_TO_LIVE:-0}" = 1 ] || btl='map(.blockToLive = 0)'
      # A collection's own policy, of the chaincode policy's kind, over the
      # MSPs its member policy names.
      endorse='.'
      if [ "${MM_ENDORSEMENT:-or}" != or ] && [ "${MM_NO_COLLECTION_ENDORSEMENT:-0}" != 1 ]; then
        endorse='map(. as $c | ([$c.policy | scan("Org[0-9]+MSP")] | unique) as $m
          | . + {endorsementPolicy: {signaturePolicy: (
              ($m | map("'"'"'" + . + ".peer'"'"'") | join(",")) as $p
              | if $mode == "and" then "AND(\($p))"
                else "OutOf(\(($m | length) / 2 | floor + 1), \($p))" end)}})'
      fi
      sed "${sed_args[@]}" "$work/collections_config.json" |
        jq --arg mode "${MM_ENDORSEMENT:-or}" "$btl | $endorse" > "$DEST/build/$ch-$cc-collections.json"
      coll_args=(--collections-config "$DEST/build/$ch-$cc-collections.json")
    fi

    peers=()
    for o in "${orgs[@]}"; do
      use_org "$o"
      if [ -z "${INSTALLED[$cc-$o]:-}" ]; then
        # Already installed is the only failure worth passing over.
        out=$(peer lifecycle chaincode install "$DEST/build/$cc.tar.gz" 2>&1) ||
          grep -q "already successfully installed" <<<"$out" || { echo "$out" >&2; mm_die "Org$o install of $cc failed"; }
        INSTALLED[$cc-$o]=1
      fi
      pkg=$(peer lifecycle chaincode queryinstalled -O json | jq -r --arg l "${cc}_1.0" '.installed_chaincodes[] | select(.label==$l) | .package_id')
      peer lifecycle chaincode approveformyorg -o "$PUBLISH_ADDR:7050" --ordererTLSHostnameOverride orderer.example.com \
        --tls --cafile "$ORDERER_CA" -C "$ch" -n "$cc" -v 1.0 --sequence 1 --package-id "$pkg" \
        --signature-policy "$policy" "${coll_args[@]}" >/dev/null 2>&1 || mm_die "Org$o approve $cc on $ch failed"
      peers+=(--peerAddresses "$PUBLISH_ADDR:$(peer_port "$o")" --tlsRootCertFiles "$(peer_tls "$o")")
    done
    use_org "${orgs[0]}"
    peer lifecycle chaincode commit -o "$PUBLISH_ADDR:7050" --ordererTLSHostnameOverride orderer.example.com \
      --tls --cafile "$ORDERER_CA" -C "$ch" -n "$cc" -v 1.0 --sequence 1 \
      --signature-policy "$policy" "${coll_args[@]}" "${peers[@]}" >/dev/null 2>&1 ||
      mm_die "commit $cc on $ch failed"
    echo "  committed $cc on $ch for Org${orgs[*]} ($policy)"
  done
done

# ── Connection profiles and replay config ──
for i in "${!SOURCE_MEMBERS[@]}"; do
  o=$((i + 1))
  jq -n --arg o "$o" --arg port "$(peer_port "$o")" --arg tls "$(peer_tls "$o")" --arg otls "$ORDERER_CA" \
    --arg host "${MM_DEST_HOST:-localhost}" '{
    name: "dest-org\($o)", version: "1.0.0",
    organizations: {("Org\($o)MSP"): {mspid: "Org\($o)MSP", peers: ["peer0.org\($o).example.com"]}},
    peers: {("peer0.org\($o).example.com"): {url: "grpcs://\($host):\($port)", tlsCACerts: {path: $tls},
      grpcOptions: {"ssl-target-name-override": "peer0.org\($o).example.com"}}},
    orderers: {"orderer.example.com": {url: "grpcs://\($host):7050", tlsCACerts: {path: $otls}}}
  }' > "$DEST/org$o-profile.json"
done

admin() {  # org number, cert|key
  local d="$ORGS/peerOrganizations/org$1.example.com/users/Admin@org$1.example.com/msp"
  if [ "$2" = cert ]; then ls "$d"/signcerts/*.pem | head -1; else ls "$d"/keystore/* | head -1; fi
}

msp_map='{}'; org_ids='{}'
for i in "${!SOURCE_MEMBERS[@]}"; do
  o=$((i + 1))
  # A failure inside the substitution would otherwise map an empty MSP ID.
  src_msp=$(mm_msp_id "${SOURCE_MEMBERS[$i]}") && [ -n "$src_msp" ] ||
    mm_die "no MSP ID for member ${SOURCE_MEMBERS[$i]} in $MM_HOME/members/"
  msp_map=$(jq --arg s "$src_msp" --arg d "Org${o}MSP" '. + {($s): $d}' <<<"$msp_map")
  [ "$o" = 1 ] && continue
  org_ids=$(jq --arg d "Org${o}MSP" --arg c "$(admin "$o" cert)" --arg k "$(admin "$o" key)" \
    --arg p "$DEST/org$o-profile.json" '. + {($d): {certPath: $c, keyPath: $k, connectionProfilePath: $p}}' <<<"$org_ids")
done

jq -n --slurpfile plan "$PLAN" --arg in "$INPUT_DIR" --arg prof "$DEST/org1-profile.json" \
  --arg cert "$(admin 1 cert)" --arg key "$(admin 1 key)" \
  --argjson msp "$msp_map" --argjson orgs "$org_ids" '
  def per(fn): [$plan[0].channels[] | {key: .name, value: ([.chaincodes[] | {key: ., value: fn}] | from_entries)}] | from_entries;
  {
    adapter: "chaincode", inputDir: $in,
    chaincode: {
      connectionProfilePath: $prof, mspId: "Org1MSP", certPath: $cert, keyPath: $key,
      channelMapping: ([$plan[0].channels[] | {key: .name, value: .name}] | from_entries),
      mspMapping: $msp, orgIdentities: $orgs,
      replayHistory: true,
      destinationStateDb: "CouchDB",
      keyMapping: per("PutState"),
      deleteMapping: per("DeleteState"),
      readFunctions: per("MigrationContract:ReadState"),
      privateReadFunctions: per("MigrationContract:ReadPrivateData"),
      historyReadFunctions: per("MigrationContract:GetKeyHistory"),
      concurrency: 32,
      channelConcurrency: ([$plan[0].channels[]] | length)
    },
    batchSize: 20000
  }' > "$DEST/replay-config.json"

echo "Destination ready: $(jq -r '.chaincode.channelMapping | keys | join(", ")' "$DEST/replay-config.json")"
echo "  replay config: $DEST/replay-config.json"
