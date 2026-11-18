# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Shared helpers for the multi-member harness. Source it; do not run it.
#
# Every member of the network gets an env file under $MM_HOME/members/, written
# by init.sh from the AMB API. mm_use <member> loads one into the shell, so the
# peer CLI acts as that member against that member's own peer:
#
#   source sample/scripts/multi-member/lib.sh
#   mm_use MemberB
#   peer channel list
#
# Nothing here holds a credential. Admin passwords are read from Secrets
# Manager by enroll.sh only, and the enrolled MSPs live under $MM_HOME/msp/.

MM_HOME="${MM_HOME:-$HOME/mm}"
MM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MM_SCRIPTS_DIR="$(cd "$MM_LIB_DIR/.." && pwd)"
MM_PROJECT_ROOT="$(cd "$MM_SCRIPTS_DIR/../.." && pwd)"
export TLS_CA_CERT="${TLS_CA_CERT:-$HOME/managedblockchain-tls-chain.pem}"
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-$HOME/fabric-2.2/config}"

mm_die() {
  echo "ERROR: $*" >&2
  exit 1
}

mm_network() {
  [ -f "$MM_HOME/network.env" ] || mm_die "$MM_HOME/network.env missing — run init.sh first"
  # shellcheck disable=SC1091
  . "$MM_HOME/network.env"
  export NETWORK_ID REGION ORDERER_ENDPOINT
}

# Load one member's identity and peer into the environment.
mm_use() {
  local name="$1"
  mm_network
  local file="$MM_HOME/members/$name.env"
  [ -f "$file" ] || mm_die "no member '$name' in $MM_HOME/members/ (members: $(mm_members | tr '\n' ' '))"
  # shellcheck disable=SC1090
  . "$file"
  export MEMBER_NAME MEMBER_ID NODE_ID PEER_ENDPOINT CA_ENDPOINT
  export MSP_ID="$MEMBER_ID"
  export MSP_PATH="$MM_HOME/msp/$name"
  export CORE_PEER_ADDRESS="$PEER_ENDPOINT"
  export CORE_PEER_LOCALMSPID="$MSP_ID"
  export CORE_PEER_MSPCONFIGPATH="$MSP_PATH"
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_TLS_ROOTCERT_FILE="$TLS_CA_CERT"
}

# Member names, one per line, in the order init.sh recorded them.
mm_members() {
  [ -f "$MM_HOME/members.list" ] || mm_die "$MM_HOME/members.list missing — run init.sh first"
  cat "$MM_HOME/members.list"
}

# MSP ID (AMB member ID) of a member, without loading it.
mm_msp_id() {
  ( mm_use "$1" >/dev/null; echo "$MEMBER_ID" )
}

# Retry a command a few times. AMB's orderer and a freshly joined peer both
# take a while to agree about a new channel, so a one-shot fetch is flaky.
mm_retry() {
  local attempts="$1"; shift
  local i
  for i in $(seq 1 "$attempts"); do
    if "$@"; then return 0; fi
    [ "$i" -lt "$attempts" ] && sleep 10
  done
  return 1
}
