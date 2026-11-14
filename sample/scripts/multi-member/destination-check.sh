#!/usr/bin/env bash
#
# Prove a destination built by destination.sh works for every org before
# replaying into it. On every plan channel, each member org in turn:
#
#   1. writes a public key through the migration contract, endorsed by its
#      own peer — plus, under a majority or AND policy, as many of the other
#      members' peers as the policy needs — and waits for the commit;
#   2. writes a key into the chaincode's first collection whose policy names
#      every channel member (consortium_ledger's allOrgs), if it has one;
#
# and then every member org reads every other org's keys back from its own
# peer. A public read proves ordering and block delivery reach that peer; a
# private read proves gossip found it, which needs the anchor peers in the
# channel's genesis block. Private reads are retried, because a peer that was
# not pushed the data at endorsement pulls it by reconciliation.
#
# Also checks that no org's peer has joined a channel it is not a member of.
# Every check writes ordinary keys named mm-check-*: run it on a destination
# before replay, and rebuild the destination (destination.sh) afterwards if
# the keys must not be there — verify reports them as [EXTRA].
#
# Usage:
#   ./destination-check.sh --plan populate-plan.json
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PLAN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="$2"; shift 2 ;;
    *) mm_die "unknown option $1" ;;
  esac
done
[ -f "$PLAN" ] || mm_die "--plan is required"

FABRIC_HOME="${MM_FABRIC_HOME:-$HOME/fabric-2.5}"
export PATH="$FABRIC_HOME/bin:$PATH" FABRIC_CFG_PATH="$FABRIC_HOME/config"
ORGS="$MM_HOME/destination/organizations"
[ -d "$ORGS" ] || mm_die "$ORGS missing — run destination.sh first"
ORDERER_CA="$ORGS/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ENDORSEMENT=$(cat "$MM_HOME/destination/network/endorsement" 2>/dev/null || echo or)
mapfile -t SOURCE_MEMBERS < <(mm_members)

# The same numbering and ports destination.sh uses.
dest_index() {
  local i
  for i in "${!SOURCE_MEMBERS[@]}"; do
    [ "${SOURCE_MEMBERS[$i]}" = "$1" ] && { echo $((i + 1)); return; }
  done
  mm_die "member $1 is not in $MM_HOME/members.list"
}
peer_port() { echo $((7051 + 2000 * ($1 - 1))); }
peer_tls() { echo "$ORGS/peerOrganizations/org$1.example.com/tlsca/tlsca.org$1.example.com-cert.pem"; }
use_org() {
  CORE_PEER_ADDRESS="localhost:$(peer_port "$1")"
  CORE_PEER_TLS_ROOTCERT_FILE="$(peer_tls "$1")"
  export CORE_PEER_TLS_ENABLED=true CORE_PEER_LOCALMSPID="Org$1MSP" CORE_PEER_ADDRESS CORE_PEER_TLS_ROOTCERT_FILE
  export CORE_PEER_MSPCONFIGPATH="$ORGS/peerOrganizations/org$1.example.com/users/Admin@org$1.example.com/msp"
}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# Endorsing peers for a write by <org>: its own first, then the channel's other
# members in order until the policy is met.
endorsers() {
  local o="$1"; shift
  local need=1 n=$# picked=("$o") x
  case "$ENDORSEMENT" in and) need=$n ;; majority) need=$(( n / 2 + 1 )) ;; esac
  for x in "$@"; do
    [ "${#picked[@]}" -ge "$need" ] && break
    [ "$x" = "$o" ] || picked+=("$x")
  done
  for x in "${picked[@]}"; do
    printf -- '--peerAddresses\nlocalhost:%s\n--tlsRootCertFiles\n%s\n' "$(peer_port "$x")" "$(peer_tls "$x")"
  done
}

# invoke <org> <channel> <chaincode> <function> <transient-json> <arg>...
# CHANNEL_ORGS holds the channel's member org numbers.
invoke() {
  local o="$1" ch="$2" cc="$3" fn="$4" transient="$5"; shift 5
  local peer_args
  mapfile -t peer_args < <(endorsers "$o" "${CHANNEL_ORGS[@]}")
  use_org "$o"
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" -C "$ch" -n "$cc" "${peer_args[@]}" \
    --waitForEvent --transient "$transient" \
    -c "$(jq -cn --arg f "MigrationContract:$fn" '{function: $f, Args: $ARGS.positional}' --args "$@")" >/dev/null 2>&1
}
# query <org> <function> <channel> <chaincode> <arg>... -> decoded value
query() {
  local o="$1" fn="$2" ch="$3" cc="$4"; shift 4
  use_org "$o"
  peer chaincode query -C "$ch" -n "$cc" \
    -c "$(jq -cn --arg f "MigrationContract:$fn" '{function: $f, Args: $ARGS.positional}' --args "$@")" 2>/dev/null |
    base64 -d 2>/dev/null
}

failed=0
fail() { echo "  FAIL $*"; failed=$((failed + 1)); }

for row in $(jq -c '.channels[] | {name, members, chaincodes}' "$PLAN"); do
  ch=$(jq -r .name <<<"$row")
  orgs=(); for m in $(jq -r '.members[]' <<<"$row"); do orgs+=("$(dest_index "$m")"); done
  CHANNEL_ORGS=("${orgs[@]}")
  cc=$(jq -r '.chaincodes[0]' <<<"$row")
  # The first collection whose policy is every channel member.
  coll=""
  rendered="$MM_HOME/destination/build/$ch-$cc-collections.json"
  if [ -f "$rendered" ]; then
    coll=$(jq -r --argjson n "${#orgs[@]}" \
      '[.[] | select((.policy | [scan("Org[0-9]+MSP")] | unique | length) == $n)][0].name // empty' "$rendered")
  fi

  for o in "${orgs[@]}"; do
    invoke "$o" "$ch" "$cc" PutState "{\"public_value\":\"$(b64 "from-Org$o")\"}" "mm-check-Org$o" ||
      fail "$ch: Org$o could not write a public key through its own peer"
    if [ -n "$coll" ]; then
      invoke "$o" "$ch" "$cc" ImportPrivateData "{\"private_value\":\"$(b64 "private-from-Org$o")\"}" "$coll" "mm-check-Org$o" ||
        fail "$ch: Org$o could not write to $coll"
    fi
  done

  for reader in "${orgs[@]}"; do
    for writer in "${orgs[@]}"; do
      [ "$(query "$reader" ReadState "$ch" "$cc" "mm-check-Org$writer")" = "from-Org$writer" ] ||
        fail "$ch: Org$reader does not see Org$writer's public key"
      if [ -n "$coll" ]; then
        got=""
        for _ in $(seq 1 24); do
          got=$(query "$reader" ReadPrivateData "$ch" "$cc" "$coll" "mm-check-Org$writer" || true)
          [ "$got" = "private-from-Org$writer" ] && break
          sleep 5
        done
        [ "$got" = "private-from-Org$writer" ] || fail "$ch: Org$reader never received Org$writer's $coll key"
      fi
    done
  done
  echo "  $ch: Org${orgs[*]} — every org wrote ($ENDORSEMENT endorsement) and every org read every write (public${coll:+, $coll})"
  [ -n "$coll" ] || echo "    $cc has no collection naming every member of $ch: private dissemination not checked"
done

# Membership: each org's peer is on exactly its plan channels.
for i in "${!SOURCE_MEMBERS[@]}"; do
  o=$((i + 1))
  want=$(jq -r --arg m "${SOURCE_MEMBERS[$i]}" '[.channels[] | select(.members | index($m)) | .name] | sort | join(" ")' "$PLAN")
  use_org "$o"
  have=$(peer channel list 2>/dev/null | awk 'seen; /^Channels peers has joined:/ {seen = 1}' | sort | tr '\n' ' ' | sed 's/ $//')
  [ "$have" = "$want" ] || fail "Org$o is on [$have], expected [$want]"
done

[ "$failed" = 0 ] || mm_die "$failed destination check(s) failed"
echo "Destination check passed: ${#SOURCE_MEMBERS[@]} orgs, $(jq '.channels | length' "$PLAN") channels"
