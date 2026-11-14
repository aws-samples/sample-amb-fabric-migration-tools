#!/usr/bin/env bash
# Deploy the Fabric 2.5 destination on the fabric-eks cluster with hlf-operator. Run on the devbox.
# Safe to rerun after a partial setup: existing resources are verified or converged. Registrar secrets are generated once into ~/fabric-eks/secrets (0600).
#
#   orderer org DstOrdererMSP: CA ord-ca, orderers orderer0..2 (hosts orderer<N>.fab.internal, admin-orderer<N>.fab.internal)
#   source orgs (MSP IDs as on AMB): CA org<N>-ca, peer org<N>-peer0 (host peer0-org<N>.fab.internal), CouchDB
# Every host resolves to the internal NLB (Route 53 private zone *.fab.internal) and is routed by SNI through Istio on 443.
set -euo pipefail
export PATH=$HOME/bin:$HOME/fabric/bin:$HOME/node/bin:$PATH
D=$HOME/fabric-eks
umask 077
mkdir -p "$D/secrets" "$D/ids"
chmod 700 "$D/secrets" "$D/ids"
FV=2.5.14; CAV=1.5.15; SC=gp3; DOM=fab.internal
read -r -a ORGS <<< "${SOURCE_MSP_IDS:?set SOURCE_MSP_IDS to the source member MSP IDs, space-separated (AMB member IDs, m-...)}"
N=${#ORGS[@]}
[ "$N" -gt 0 ] || { echo "SOURCE_MSP_IDS contains no MSP IDs" >&2; exit 1; }
# One orderer per AZ: the cluster's three zones (cluster.yaml availabilityZones).
REGION=${AWS_REGION:?set AWS_REGION to the cluster region}
read -r -a ZONES <<< "${EKS_ZONES:-${REGION}a ${REGION}b ${REGION}c}"
[ "${#ZONES[@]}" -eq 3 ] || { echo "EKS_ZONES must contain exactly three zones" >&2; exit 1; }
secret() { local f=$D/secrets/$1; [ -s $f ] || (umask 077; openssl rand -hex 16 > $f); cat $f; }
exists() { kubectl get "$1" "$2" >/dev/null 2>&1; }
with_spec() { # with_spec <json> : merge <json> into the spec of the resource YAML on stdin, then create it
  # --validate=warn as kubectl hlf's own create does: kubectl-hlf 1.14.0 writes fields (spec.credentialStore, …) that the
  # 1.14.0 chart's CRDs do not define, which the API server drops with a warning but strict validation refuses.
  python3 -c 'import json,sys,yaml; d=yaml.safe_load(sys.stdin); d["spec"].update(json.loads(sys.argv[1])); print(yaml.safe_dump(d))' "$1" |
    kubectl apply --validate=warn -f - 2>&1 >/dev/null | { grep -v 'unknown field' >&2 || true; }
}
ca() { # ca <name>
  exists fabriccas.hlf.kungfusoftware.es $1 && return
  kubectl hlf ca create --image=hyperledger/fabric-ca --version=$CAV --storage-class=$SC --capacity=1Gi --name=$1 \
    --enroll-id=enroll --enroll-pw=$(secret $1-enroll) --hosts=$1.$DOM --istio-port=443
}
reg() { # reg <ca> <user> <type> <mspid>
  local out
  if ! out=$(kubectl hlf ca register --name="$1" --user="$2" --secret="$(secret "$1-$2")" --type="$3" \
    --enroll-id=enroll --enroll-secret="$(secret "$1-enroll")" --mspid="$4" 2>&1); then
    grep -qi 'already registered' <<<"$out" && return
    printf '%s\n' "$out" >&2
    return 1
  fi
}

# 1. CAs
ca ord-ca; for i in $(seq 1 $N); do ca org$i-ca; done
kubectl wait --timeout=300s --for=condition=Running fabriccas.hlf.kungfusoftware.es --all

# 2. Orderers (Raft consenters), one per worker node where possible
reg ord-ca orderer orderer DstOrdererMSP
for n in 0 1 2; do
  if exists fabricorderernodes.hlf.kungfusoftware.es "orderer$n"; then
    zone=$(kubectl get fabricorderernodes.hlf.kungfusoftware.es "orderer$n" -o json |
      jq -r '[.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[]?.matchExpressions[]? | select(.key == "topology.kubernetes.io/zone") | .values[0]][0] // ""')
    [ "$zone" = "${ZONES[$n]}" ] || {
      echo "orderer$n exists without required affinity to ${ZONES[$n]}; delete it and its empty PVC, then rerun" >&2
      exit 1
    }
    continue
  fi
  # One orderer per AZ. The CR's nodeSelector is ignored for orderers; affinity is applied. It has to be in the spec
  # the CR is created with: the operator schedules the first pod at once, its volume binds in that pod's zone
  # (WaitForFirstConsumer) and cannot move, so a patch after creation loses the race (gotcha 2).
  kubectl hlf ordnode create --image=hyperledger/fabric-orderer --version=$FV --storage-class=$SC --capacity=20Gi \
    --enroll-id=orderer --enroll-pw=$(secret ord-ca-orderer) --mspid=DstOrdererMSP --name=orderer$n --ca-name=ord-ca.default \
    --hosts=orderer$n.$DOM --admin-hosts=admin-orderer$n.$DOM --istio-port=443 --output |
    with_spec "{\"affinity\":{\"nodeAffinity\":{\"requiredDuringSchedulingIgnoredDuringExecution\":{\"nodeSelectorTerms\":[{\"matchExpressions\":[{\"key\":\"topology.kubernetes.io/zone\",\"operator\":\"In\",\"values\":[\"${ZONES[$n]}\"]}]}]}}}}"
done

# 3. Peers, one per source org, CouchDB state database as on AMB
for i in $(seq 1 $N); do
  m=${ORGS[$((i-1))]}
  reg org$i-ca peer peer "$m"
  if exists fabricpeers.hlf.kungfusoftware.es "org$i-peer0"; then
    env=$(kubectl get fabricpeers.hlf.kungfusoftware.es "org$i-peer0" -o json |
      jq -c '([.spec.env[]? | select(.name != "CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD")] +
        [{"name":"CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD","value":"0s"}])')
    patch=$(jq -cn --argjson env "$env" '{spec:{env:$env}}')
    kubectl patch fabricpeers.hlf.kungfusoftware.es "org$i-peer0" --type merge -p "$patch" >/dev/null
    continue
  fi
  # During a re-broadcast no peer has the source's private data, so a peer that waits to pull it before committing
  # falls far behind the orderer (docs/rebroadcast.md, Prerequisites; gotcha 4). Restore the default after the tip phase.
  kubectl hlf peer create --statedb=couchdb --image=hyperledger/fabric-peer --version=$FV --storage-class=$SC --capacity=20Gi \
    --enroll-id=peer --enroll-pw=$(secret org$i-ca-peer) --mspid=$m --name=org$i-peer0 --ca-name=org$i-ca.default \
    --hosts=peer0-org$i.$DOM --istio-port=443 --output |
    with_spec '{"env":[{"name":"CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD","value":"0s"}]}'
done
kubectl wait --timeout=600s --for=condition=Running fabricorderernodes.hlf.kungfusoftware.es --all
kubectl wait --timeout=600s --for=condition=Running fabricpeers.hlf.kungfusoftware.es --all

# 4. Admin identities: each org's admin (signs config as that org, runs lifecycle), the orderer org's admin (sign + TLS for osnadmin)
reg ord-ca admin admin DstOrdererMSP
for c in ca tlsca; do [ -s $D/ids/ord-admin-$c.yaml ] || kubectl hlf ca enroll --name=ord-ca --namespace=default --user=admin --secret=$(secret ord-ca-admin) --mspid=DstOrdererMSP --ca-name=$c --output=$D/ids/ord-admin-$c.yaml; done
for i in $(seq 1 $N); do
  m=${ORGS[$((i-1))]}; reg org$i-ca admin admin $m
  for c in ca tlsca; do [ -s $D/ids/org$i-admin-$c.yaml ] || kubectl hlf ca enroll --name=org$i-ca --namespace=default --user=admin --secret=$(secret org$i-ca-admin) --mspid=$m --ca-name=$c --output=$D/ids/org$i-admin-$c.yaml; done
done
chmod 600 $D/ids/*.yaml

kubectl get fabriccas,fabricorderernodes,fabricpeers.hlf.kungfusoftware.es --no-headers | awk '{print $1,$2}'
kubectl get pods -o wide --no-headers | awk '{print $1,$3,$7}'
