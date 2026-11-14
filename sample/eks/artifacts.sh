#!/usr/bin/env bash
# Collect what fabric-rebroadcast needs from the hlf-operator deployment, on the devbox:
#   ~/fabric-eks/out/{ord,org1..N}/  CA and TLS CA certificates, MSP dirs, admin identities (keys 0600)
#   ~/fabric-eks/out/template.block  configtxgen block whose Orderer group is this ordering service (genesisTemplate)
#   ~/fabric-eks/out/dest-eks.json   the destination descriptor (self-managed, 3 orderers, one peer per source org)
set -euo pipefail
export PATH=$HOME/bin:$HOME/fabric/bin:$HOME/node/bin:$PATH
D=$HOME/fabric-eks; O=$D/out; DOM=fab.internal; BT=${BATCH_TIMEOUT:-500ms}; MODE=${SIGNER_MODE:-ceremony}
read -r -a ORGS <<< "${SOURCE_MSP_IDS:?set SOURCE_MSP_IDS to the source member MSP IDs, space-separated (AMB member IDs, m-...)}"
N=${#ORGS[@]}
umask 077; mkdir -p $O
st() { kubectl get "$1" "$2" -o json | jq -r "$3"; }
nodeous() { cat <<Y
NodeOUs:
  Enable: true
  ClientOUIdentifier: { Certificate: cacerts/ca.pem, OrganizationalUnitIdentifier: client }
  PeerOUIdentifier: { Certificate: cacerts/ca.pem, OrganizationalUnitIdentifier: peer }
  AdminOUIdentifier: { Certificate: cacerts/ca.pem, OrganizationalUnitIdentifier: admin }
  OrdererOUIdentifier: { Certificate: cacerts/ca.pem, OrganizationalUnitIdentifier: orderer }
Y
}
msp() { # msp <dir> <ca.pem> <tlsca.pem> <id yaml>  -> MSP dir with the admin as signer
  mkdir -p $1/msp/{cacerts,tlscacerts,signcerts,keystore}
  cp $2 $1/msp/cacerts/ca.pem; cp $3 $1/msp/tlscacerts/tlsca.pem; nodeous > $1/msp/config.yaml
  python3 -c "import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); open(sys.argv[2],'w').write(d['cert']['pem']); open(sys.argv[3],'w').write(d['key']['pem'])" $4 $1/msp/signcerts/cert.pem $1/msp/keystore/key.pem
}
tlsid() { python3 -c "import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); open(sys.argv[2],'w').write(d['cert']['pem']); open(sys.argv[3],'w').write(d['key']['pem'])" $1 $2 $3; }

# Orderer org
mkdir -p $O/ord
st fabricorderernodes.hlf.kungfusoftware.es orderer0 .status.signCaCert > $O/ord/ca.pem
st fabricorderernodes.hlf.kungfusoftware.es orderer0 .status.tlsCaCert > $O/ord/tlsca.pem
for n in 0 1 2; do st fabricorderernodes.hlf.kungfusoftware.es orderer$n .status.tlsCert > $O/ord/orderer$n-tls.pem; done
msp $O/ord $O/ord/ca.pem $O/ord/tlsca.pem $D/ids/ord-admin-ca.yaml
tlsid $D/ids/ord-admin-tlsca.yaml $O/ord/admin-tls.pem $O/ord/admin-tls.key

# Source orgs
for i in $(seq 1 $N); do
  mkdir -p $O/org$i
  st fabriccas.hlf.kungfusoftware.es org$i-ca .status.ca_cert > $O/org$i/ca.pem
  st fabriccas.hlf.kungfusoftware.es org$i-ca .status.tlsca_cert > $O/org$i/tlsca.pem
  msp $O/org$i $O/org$i/ca.pem $O/org$i/tlsca.pem $D/ids/org$i-admin-ca.yaml
  tlsid $D/ids/org$i-admin-tlsca.yaml $O/org$i/admin-tls.pem $O/org$i/admin-tls.key
done

# Genesis template: the Orderer group of this ordering service (the Application group is replaced by the source's)
cat > $O/configtx.yaml <<Y
Organizations:
  - &Ord
    Name: DstOrdererMSP
    ID: DstOrdererMSP
    MSPDir: $O/ord/msp
    Policies:
      Readers: {Type: Signature, Rule: "OR('DstOrdererMSP.member')"}
      Writers: {Type: Signature, Rule: "OR('DstOrdererMSP.member')"}
      Admins: {Type: Signature, Rule: "OR('DstOrdererMSP.admin')"}
    OrdererEndpoints: [orderer0.$DOM:443, orderer1.$DOM:443, orderer2.$DOM:443]
  - &App
    Name: ${ORGS[0]}
    ID: ${ORGS[0]}
    MSPDir: $O/org1/msp
    Policies:
      Readers: {Type: Signature, Rule: "OR('${ORGS[0]}.member')"}
      Writers: {Type: Signature, Rule: "OR('${ORGS[0]}.member')"}
      Admins: {Type: Signature, Rule: "OR('${ORGS[0]}.admin')"}
      Endorsement: {Type: Signature, Rule: "OR('${ORGS[0]}.peer')"}
Profiles:
  Template:
    Policies:
      Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
      Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
      Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
    Capabilities: {V2_0: true}
    Orderer:
      OrdererType: etcdraft
      BatchTimeout: $BT
      BatchSize: {MaxMessageCount: 500, AbsoluteMaxBytes: 10 MB, PreferredMaxBytes: 10 MB}
      EtcdRaft:
        Consenters:
$(for n in 0 1 2; do echo "          - {Host: orderer$n.$DOM, Port: 443, ClientTLSCert: $O/ord/orderer$n-tls.pem, ServerTLSCert: $O/ord/orderer$n-tls.pem}"; done)
      Organizations: [*Ord]
      Policies:
        Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
        Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
        BlockValidation: {Type: ImplicitMeta, Rule: "ANY Writers"}
      Capabilities: {V2_0: true}
    Application:
      Organizations: [*App]
      Policies:
        Readers: {Type: ImplicitMeta, Rule: "ANY Readers"}
        Writers: {Type: ImplicitMeta, Rule: "ANY Writers"}
        Admins: {Type: ImplicitMeta, Rule: "MAJORITY Admins"}
      Capabilities: {V2_0: true}
Y
configtxgen -configPath $O -profile Template -channelID template -outputBlock $O/template.block 2>&1 | tail -1

# Descriptor
python3 - "$O" "$BT" "$MODE" "${ORGS[@]}" <<'P'
import json,sys
O,bt,mode,orgs=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4:]
ord_admin={'cert':'ord/msp/signcerts/cert.pem','key':'ord/msp/keystore/key.pem'}
d={'schema':1,'profile':'self-managed',
   'orderer':{'mode':'timeout','batchTimeout':bt,
     'endpoints':[{'address':f'orderer{n}.fab.internal:443','sni':f'orderer{n}.fab.internal','tlsCa':'ord/tlsca.pem'} for n in range(3)],
     'reader':{'msp':'DstOrdererMSP',**ord_admin}},
   'peers':[{'address':f'peer0-org{i}.fab.internal:443','sni':f'peer0-org{i}.fab.internal','tlsCa':f'org{i}/tlsca.pem',
             'reader':{'msp':m,'cert':f'org{i}/msp/signcerts/cert.pem','key':f'org{i}/msp/keystore/key.pem'}} for i,m in enumerate(orgs,1)],
   'ordererOrg':{'msp':'DstOrdererMSP','admin':ord_admin},
   'genesisTemplate':'template.block',
   'orgs':{m:{'signer':({'mode':'ceremony','cert':f'org{i}/msp/signcerts/cert.pem'} if mode=='ceremony' else {'mode':'local','cert':f'org{i}/msp/signcerts/cert.pem','key':f'org{i}/msp/keystore/key.pem'}),
              'rootCa':f'org{i}/ca.pem','tlsRootCa':f'org{i}/tlsca.pem','anchorPeers':[{'host':f'peer0-org{i}.fab.internal','port':443}]} for i,m in enumerate(orgs,1)},
   'ordererOverrides':{'BatchTimeout':bt},
   'workDir':'work'}
json.dump(d,open(f'{O}/dest-eks.json','w'),indent=2)
P
find $O -name '*.key' -o -name 'key.pem' | xargs chmod 600
ls $O; echo "descriptor: $O/dest-eks.json"
