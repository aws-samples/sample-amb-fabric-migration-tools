#!/usr/bin/env bash
#
# Set up a Hyperledger Fabric 2.5 test-network as the migration destination.
#
# This script:
#   1. Clones fabric-samples (if needed)
#   2. Downloads Fabric 2.5 Docker images and binaries
#   3. Brings up the test-network with CouchDB
#   4. Creates channels (mychannel + tradechannel)
#   5. Deploys chaincodes per the source deployment matrix:
#        mychannel:    sample_assets + trade_registry
#        tradechannel: trade_registry
#   6. Generates a replay config JSON for the extractor
#
# The test-network runs two orgs (Org1, Org2) with one peer each, plus an
# orderer — a realistic destination that also lets you verify multi-org
# private data replay.
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - Go 1.20+ (for chaincode vendoring, if vendor/ doesn't exist yet)
#   - curl, jq
#
# Usage:
#   ./sample/scripts/destination/setup-test-network.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FABRIC_SAMPLES_DIR="${FABRIC_SAMPLES_DIR:-$HOME/fabric-samples}"
FABRIC_VERSION="2.5.11"
FABRIC_CA_VERSION="1.5.12"

# Some packaged Go toolchains do not synthesize GOPATH when run non-interactively.
# Chaincode vendoring needs an explicit writable module cache in that environment.
export GOPATH="${GOPATH:-$HOME/go}"
export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}"
mkdir -p "$GOMODCACHE" "$GOCACHE"


GENERATED_MARKER_DIR="$PROJECT_ROOT/sample/destination-config/.live-test-generated"
mkdir -p "$GENERATED_MARKER_DIR"
CHANNEL_1="mychannel"
CHANNEL_2="tradechannel"

echo "═══════════════════════════════════════════════════════════"
echo " Setting up Fabric 2.5 test-network (migration destination)"
echo "═══════════════════════════════════════════════════════════"
echo " fabric-samples: $FABRIC_SAMPLES_DIR"
echo " Channels:       $CHANNEL_1, $CHANNEL_2"
echo " Chaincodes:     sample_assets ($CHANNEL_1)"
echo "                 trade_registry ($CHANNEL_1, $CHANNEL_2)"
echo " Fabric version: $FABRIC_VERSION"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Step 1: Get fabric-samples ──
echo "=== Step 1: fabric-samples ==="
if [ -d "$FABRIC_SAMPLES_DIR/test-network" ]; then
  echo "  Already present at $FABRIC_SAMPLES_DIR"
else
  echo "  Cloning fabric-samples (main branch)..."
  git clone --depth 1 \
    https://github.com/hyperledger/fabric-samples.git "$FABRIC_SAMPLES_DIR"
fi
echo ""

# ── Step 2: Download Fabric Docker images and binaries ──
echo "=== Step 2: Fabric binaries and Docker images ==="
if [ -f "$FABRIC_SAMPLES_DIR/bin/peer" ]; then
  echo "  Binaries already present"
else
  echo "  Downloading Fabric $FABRIC_VERSION binaries and images..."
  pushd "$FABRIC_SAMPLES_DIR" > /dev/null
  curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh | \
    bash -s -- docker binary -f "$FABRIC_VERSION" -c "$FABRIC_CA_VERSION"
  popd > /dev/null
fi

export PATH="$FABRIC_SAMPLES_DIR/bin:$PATH"
echo "  peer version: $(peer version 2>&1 | grep Version | awk '{print $2}' || echo 'unknown')"
echo ""

# ── Step 3: Bring up test-network ──
echo "=== Step 3: Starting test-network ==="
TEST_NETWORK_DIR="$FABRIC_SAMPLES_DIR/test-network"
pushd "$TEST_NETWORK_DIR" > /dev/null

./network.sh down 2>/dev/null || true

./network.sh up -ca -s couchdb

echo "  Waiting for CouchDB to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:5984/ >/dev/null 2>&1 && \
     curl -sf http://localhost:7984/ >/dev/null 2>&1; then
    echo "  CouchDB ready"
    break
  fi
  sleep 2
done

for peer in peer0.org1.example.com peer0.org2.example.com; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$peer" 2>/dev/null)" != "true" ]; then
    echo "  Restarting $peer (exited before CouchDB was ready)..."
    docker start "$peer"
  fi
done

echo "  Waiting for peers to be ready..."
for port in 7051 9051; do
  for i in $(seq 1 30); do
    if (echo > "/dev/tcp/localhost/$port") 2>/dev/null; then
      echo "  Port $port ready"
      break
    fi
    if [ "$i" = 30 ]; then
      echo "  WARNING: port $port not ready after 60s"
    fi
    sleep 2
  done
done

popd > /dev/null
echo ""

# ── Step 4: Create channels ──
echo "=== Step 4: Creating channels ==="
pushd "$TEST_NETWORK_DIR" > /dev/null

./network.sh createChannel -c "$CHANNEL_1"
echo "  Created $CHANNEL_1"

./network.sh createChannel -c "$CHANNEL_2"
echo "  Created $CHANNEL_2"

popd > /dev/null
echo ""

# ── Step 5: Vendor chaincode deps if needed ──
echo "=== Step 5: Checking vendored dependencies ==="
for CC_NAME in sample_assets trade_registry; do
  CC_DIR="$PROJECT_ROOT/sample/chaincode/$CC_NAME"
  # Each chaincode imports its local migration package. Put the canonical source
  # in place before `go mod tidy`; deploy_chaincode renders the writer list into
  # its separate deployment copy later.
  if [ ! -d "$CC_DIR/migration" ]; then
    touch "$GENERATED_MARKER_DIR/$CC_NAME-migration"
  fi
  mkdir -p "$CC_DIR/migration"
  cp "$PROJECT_ROOT/sample/chaincode/migration_contract/go/migration.go" \
    "$CC_DIR/migration/migration.go"
  if [ ! -d "$CC_DIR/vendor" ]; then
    touch "$GENERATED_MARKER_DIR/$CC_NAME-vendor"
    echo "  Vendoring $CC_NAME..."
    pushd "$CC_DIR" > /dev/null
    go mod tidy
    go mod vendor
    popd > /dev/null
  else
    echo "  $CC_NAME: vendor/ already present"
  fi
done
echo ""

# ── Step 6: Deploy chaincodes ──
# test-network's deployCC expects chaincode source in a known location.
# We copy each chaincode there, set up collection policies for test-network
# orgs, then deploy.
#
# sample_assets carries an org2OnlyData collection that the default replay
# identity (Org1MSP) is deliberately NOT a member of. The generated default
# config does not route source data into it; it is a destination target for the
# documented optional collectionMapping + Org2 collectionIdentities exercise.
# The default run covers ordinary private replay, while denial/pre-flight
# behavior is covered by unit fixtures unless that optional route is enabled.
# Both MSPs are real channel members here, which makes the policy deployable.

deploy_chaincode() {
  local cc_name="$1"
  local channel="$2"
  local cc_src="$PROJECT_ROOT/sample/chaincode/$cc_name"
  local deploy_dir="$FABRIC_SAMPLES_DIR/chaincode-deploy-$cc_name"

  echo "  Deploying $cc_name on $channel..."

  rm -rf "$deploy_dir"
  mkdir -p "$deploy_dir"
  cp -r "$cc_src/"* "$deploy_dir/"

  # ── Name the orgs allowed to write migration data ──
  # The contract ships refusing every write, so the MSP IDs replay submits as
  # are rendered in here rather than checked in: a list in the contract is a
  # default every real destination would inherit. Both channel orgs are
  # rendered: the generated default run submits as Org1, while the documented
  # optional org2OnlyData route submits through an Org2 collection identity.
  #
  # Rendered from the contract source rather than from the copy above, which
  # vendor-deps.sh wrote and may predate an edit to the contract.
  local migration_src="$PROJECT_ROOT/sample/chaincode/migration_contract/go/migration.go"
  local migration_dst="$deploy_dir/migration/migration.go"
  if [ ! -f "$migration_src" ]; then
    echo "ERROR: migration contract not found at $migration_src" >&2
    exit 1
  fi
  mkdir -p "$deploy_dir/migration"
  sed 's|^var writerMSPIDs = \[\]string{}$|var writerMSPIDs = []string{"Org1MSP", "Org2MSP"}|' \
    "$migration_src" > "$migration_dst"
  if ! grep -q '^var writerMSPIDs = \[\]string{"Org1MSP", "Org2MSP"}$' "$migration_dst"; then
    echo "ERROR: could not render writerMSPIDs into $migration_dst." >&2
    echo "The declaration in $migration_src is no longer the line this" >&2
    echo "substitution matches; every replay write would be refused." >&2
    exit 1
  fi

  # Build collection config with test-network org policies
  local coll_file="$deploy_dir/collections_config.json"
  if [ "$cc_name" = "sample_assets" ]; then
    cat > "$coll_file" << 'COLLEOF'
[
  {
    "name": "orgPrivateData",
    "policy": "OR('Org1MSP.member', 'Org2MSP.member')",
    "requiredPeerCount": 0,
    "maxPeerCount": 1,
    "blockToLive": 0,
    "memberOnlyRead": true,
    "memberOnlyWrite": true
  },
  {
    "name": "tempPrivateData",
    "policy": "OR('Org1MSP.member', 'Org2MSP.member')",
    "requiredPeerCount": 0,
    "maxPeerCount": 1,
    "blockToLive": 100,
    "memberOnlyRead": true,
    "memberOnlyWrite": true
  },
  {
    "name": "org2OnlyData",
    "policy": "OR('Org2MSP.member')",
    "requiredPeerCount": 0,
    "maxPeerCount": 1,
    "blockToLive": 0,
    "memberOnlyRead": true,
    "memberOnlyWrite": true
  }
]
COLLEOF
  elif [ "$cc_name" = "trade_registry" ]; then
    cat > "$coll_file" << 'COLLEOF'
[
  {
    "name": "counterpartyDetails",
    "policy": "OR('Org1MSP.member', 'Org2MSP.member')",
    "requiredPeerCount": 0,
    "maxPeerCount": 1,
    "blockToLive": 0,
    "memberOnlyRead": true,
    "memberOnlyWrite": true
  }
]
COLLEOF
  fi

  pushd "$TEST_NETWORK_DIR" > /dev/null
  ./network.sh deployCC \
    -ccn "$cc_name" \
    -ccp "$deploy_dir" \
    -ccl go \
    -c "$channel" \
    -cccg "$deploy_dir/collections_config.json"
  popd > /dev/null
}

echo "=== Step 6: Deploying chaincodes ==="

deploy_chaincode sample_assets "$CHANNEL_1"
echo ""
deploy_chaincode trade_registry "$CHANNEL_1"
echo ""
deploy_chaincode trade_registry "$CHANNEL_2"
echo ""

# ── Step 7: Verify deployments ──
echo "=== Step 7: Verifying deployments ==="

export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS="localhost:7051"

for CC in sample_assets trade_registry; do
  for CH in $CHANNEL_1 $CHANNEL_2; do
    # sample_assets only on mychannel
    if [ "$CC" = "sample_assets" ] && [ "$CH" = "$CHANNEL_2" ]; then
      continue
    fi
    COMMITTED=$(peer lifecycle chaincode querycommitted \
      -C "$CH" -n "$CC" --output json 2>/dev/null || echo "{}")
    if echo "$COMMITTED" | jq -e '.name' &>/dev/null; then
      echo "  $CC on $CH: OK (seq=$(echo "$COMMITTED" | jq -r '.sequence'))"
    else
      echo "  WARNING: $CC on $CH: NOT FOUND"
    fi
  done
done
echo ""

# ── Step 8: Generate connection profile and replay config ──
echo "=== Step 8: Generating connection profile and replay config ==="

DEST_DIR="$PROJECT_ROOT/sample/destination-config"
mkdir -p "$DEST_DIR"

cat > "$DEST_DIR/connection-profile.json" << CPEOF
{
  "name": "test-network-org1",
  "version": "1.0.0",
  "channels": {
    "$CHANNEL_1": {
      "orderers": ["orderer.example.com"],
      "peers": { "peer0.org1.example.com": {} }
    },
    "$CHANNEL_2": {
      "orderers": ["orderer.example.com"],
      "peers": { "peer0.org1.example.com": {} }
    }
  },
  "organizations": {
    "Org1MSP": {
      "mspid": "Org1MSP",
      "peers": ["peer0.org1.example.com"],
      "certificateAuthorities": ["ca.org1.example.com"]
    }
  },
  "orderers": {
    "orderer.example.com": {
      "url": "grpcs://localhost:7050",
      "tlsCACerts": {
        "path": "$TEST_NETWORK_DIR/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"
      }
    }
  },
  "peers": {
    "peer0.org1.example.com": {
      "url": "grpcs://localhost:7051",
      "tlsCACerts": {
        "path": "$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
      }
    }
  },
  "certificateAuthorities": {
    "ca.org1.example.com": {
      "url": "https://localhost:7054",
      "tlsCACerts": {
        "path": "$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/ca/ca.org1.example.com-cert.pem"
      }
    }
  }
}
CPEOF

# Find admin credentials (filename varies with CA-generated crypto)
ADMIN_KEY_DIR="$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/keystore"
ADMIN_KEY_FILE=$(ls "$ADMIN_KEY_DIR/"*_sk 2>/dev/null | head -1 || echo "")
ADMIN_CERT="$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/cert.pem"

if [ -z "$ADMIN_KEY_FILE" ]; then
  ADMIN_CERT=$(ls "$TEST_NETWORK_DIR/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp/signcerts/"*.pem 2>/dev/null | head -1)
  ADMIN_KEY_FILE=$(ls "$ADMIN_KEY_DIR/"* 2>/dev/null | head -1 || echo "KEY_NOT_FOUND")
fi

cat > "$DEST_DIR/replay-config.json" << RCEOF
{
  "adapter": "chaincode",
  "inputDir": "$PROJECT_ROOT/extraction-output",
  "chaincode": {
    "connectionProfilePath": "$DEST_DIR/connection-profile.json",
    "mspId": "Org1MSP",
    "certPath": "$ADMIN_CERT",
    "keyPath": "$ADMIN_KEY_FILE",
    "channelMapping": {
      "mychannel": "mychannel",
      "tradechannel": "tradechannel"
    },
    "keyMapping": {
      "mychannel": {
        "sample_assets": "PutState",
        "trade_registry": "PutState"
      },
      "tradechannel": {
        "trade_registry": "PutState"
      }
    },
    "readFunctions": {
      "mychannel": {
        "sample_assets": "MigrationContract:ReadState",
        "trade_registry": "MigrationContract:ReadState"
      },
      "tradechannel": {
        "trade_registry": "MigrationContract:ReadState"
      }
    },
    "privateReadFunctions": {
      "mychannel": {
        "sample_assets": "MigrationContract:ReadPrivateData",
        "trade_registry": "MigrationContract:ReadPrivateData"
      },
      "tradechannel": {
        "trade_registry": "MigrationContract:ReadPrivateData"
      }
    },
    "concurrency": 10
  }
}
RCEOF

echo "  Connection profile: $DEST_DIR/connection-profile.json"
echo "  Replay config:      $DEST_DIR/replay-config.json"
echo "  Admin cert:         $ADMIN_CERT"
echo "  Admin key:          $ADMIN_KEY_FILE"
echo ""

echo "═══════════════════════════════════════════════════════════"
echo " Destination test-network ready!"
echo ""
echo " Network:    Fabric 2.5 test-network (Org1 + Org2, CouchDB)"
echo " Channels:   $CHANNEL_1, $CHANNEL_2"
echo " Chaincodes: sample_assets ($CHANNEL_1)"
echo "             trade_registry ($CHANNEL_1, $CHANNEL_2)"
echo ""
echo " To replay extracted data:"
echo ""
echo "   npx ts-node src/cli/index.ts replay \\"
echo "     --input-dir ./extraction-output \\"
echo "     --adapter chaincode \\"
echo "     --config $DEST_DIR/replay-config.json"
echo ""
echo " To tear down:"
echo "   ./sample/scripts/destination/teardown-test-network.sh"
echo "═══════════════════════════════════════════════════════════"
