#!/usr/bin/env bash
# Install the devbox tools for docs/eks-fabric-runbook.md into ~/bin, ~/fabric and ~/node.
# Run on the devbox: AWS_REGION=<cluster region> DEVBOX_ID=... ./dbx.sh devbox-tools.sh.
set -euo pipefail
REGION=${AWS_REGION:?set AWS_REGION to the cluster region}
KV=v1.34.1; HV=v4.3.1; HLFV=1.14.0; FV=2.5.14; NV=v22.20.0
FABRIC_SHA256=a4136c6149974a8f579e5f284ee9dd2a9acdcfbf396592f866e1a3a56d199fab
mkdir -p ~/bin ~/dl && cd ~/dl
sudo dnf install -y -q jq tar gzip unzip python3-pyyaml >/dev/null

if [ "$(~/bin/kubectl version --client -o json 2>/dev/null | jq -r '.clientVersion.gitVersion // empty')" != "$KV" ]; then
  curl -fsSLo kubectl "https://dl.k8s.io/release/$KV/bin/linux/amd64/kubectl"
  echo "$(curl -fsSL "https://dl.k8s.io/release/$KV/bin/linux/amd64/kubectl.sha256")  kubectl" | sha256sum -c -
  install -m 755 kubectl ~/bin/
fi
if [[ "$(~/bin/helm version --short 2>/dev/null || true)" != "$HV"* ]]; then
  archive="helm-$HV-linux-amd64.tar.gz"
  curl -fsSLO "https://get.helm.sh/$archive"
  curl -fsSL "https://get.helm.sh/$archive.sha256sum" | sha256sum -c -
  tar -xzf "$archive"
  install -m 755 linux-amd64/helm ~/bin/
fi
if [ "$(cat ~/bin/.kubectl-hlf-version 2>/dev/null || true)" != "$HLFV" ]; then
  zip=hlf-operator_v${HLFV}_linux_amd64.zip
  base=https://github.com/hyperledger-bevel/bevel-operator-fabric/releases/download/v$HLFV
  curl -fsSLO "$base/$zip"
  curl -fsSL "$base/hlf-operator_${HLFV}_checksums.txt" | grep " $zip\$" | sha256sum -c -
  unzip -oq "$zip" kubectl-hlf
  install -m 755 kubectl-hlf ~/bin/
  printf '%s\n' "$HLFV" > ~/bin/.kubectl-hlf-version
fi
if ! ~/fabric/bin/peer version 2>/dev/null | grep -q " Version: $FV\$"; then
  archive="hyperledger-fabric-linux-amd64-$FV.tar.gz"
  curl -fsSLo "$archive" "https://github.com/hyperledger/fabric/releases/download/v$FV/$archive"
  echo "$FABRIC_SHA256  $archive" | sha256sum -c -
  mkdir -p ~/fabric
  tar -xzf "$archive" -C ~/fabric
fi
if [ "$(~/node/bin/node --version 2>/dev/null || true)" != "$NV" ]; then
  archive="node-$NV-linux-x64.tar.xz"
  curl -fsSLO "https://nodejs.org/dist/$NV/$archive"
  curl -fsSL "https://nodejs.org/dist/$NV/SHASUMS256.txt" | grep " $archive\$" | sha256sum -c -
  mkdir -p ~/node
  tar -xJf "$archive" -C ~/node --strip-components 1
fi

grep -q 'fabric/bin' ~/.bashrc || echo "export PATH=\$HOME/bin:\$HOME/fabric/bin:\$HOME/node/bin:\$PATH AWS_REGION=$REGION" >> ~/.bashrc
export PATH=$HOME/bin:$HOME/fabric/bin:$HOME/node/bin:$PATH
aws eks update-kubeconfig --name fabric-eks --region "$REGION" >/dev/null
kubectl version --client
helm version --short
kubectl hlf --help >/dev/null && echo "kubectl-hlf $HLFV"
peer version | grep ' Version'
node --version
kubectl get nodes -L topology.kubernetes.io/zone --no-headers | awk '{print $1, $2, $NF}'
