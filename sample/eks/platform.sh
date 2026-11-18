#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# docs/eks-fabric-runbook.md, step 3, on the devbox: gp3 StorageClass, Istio with an internal NLB (TLS passthrough on
# 443), hlf-operator. Idempotent. Prints the NLB hostname for the Route 53 record of step 3.
#
#   LB_SOURCE_RANGES  CIDRs allowed to reach the NLB (default: this devbox's VPC CIDR). Without it the cloud provider
#                     opens the gateway's NodePorts to 0.0.0.0/0 on the node security group.
set -euo pipefail
export PATH=$HOME/bin:$HOME/fabric/bin:$HOME/node/bin:$PATH
IV=1.30.6; HLFV=1.14.0
if [ -z "${LB_SOURCE_RANGES:-}" ]; then
  t=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  md() { curl -fsS -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/meta-data/$1"; }
  LB_SOURCE_RANGES=$(md "network/interfaces/macs/$(md mac)/vpc-ipv4-cidr-block")
fi
echo "NLB source ranges: $LB_SOURCE_RANGES"

cat <<'Y' | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters: { type: gp3, encrypted: "true", tagSpecification_1: "KubernetesCluster=fabric-eks" }
Y
kubectl annotate storageclass gp2 storageclass.kubernetes.io/is-default-class=false --overwrite >/dev/null 2>&1 || true

helm repo add istio https://istio-release.storage.googleapis.com/charts --force-update >/dev/null
helm repo add kfs https://kfsoftware.github.io/hlf-helm-charts --force-update >/dev/null
helm repo update >/dev/null
helm upgrade --install istio-base istio/base -n istio-system --create-namespace --version $IV --wait >/dev/null
helm upgrade --install istiod istio/istiod -n istio-system --version $IV --wait >/dev/null
ranges=$(printf '"%s",' ${LB_SOURCE_RANGES//,/ }); ranges="[${ranges%,}]"
cat > /tmp/istio-gateway-values.yaml <<Y
service:
  type: LoadBalancer
  loadBalancerSourceRanges: $ranges
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: nlb
    service.beta.kubernetes.io/aws-load-balancer-internal: "true"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
  ports:
    - { name: status-port, port: 15021, targetPort: 15021, protocol: TCP }
    - { name: https, port: 443, targetPort: 8443, protocol: TCP }
Y
helm upgrade --install istio-ingressgateway istio/gateway -n istio-system --version $IV \
  -f /tmp/istio-gateway-values.yaml --wait >/dev/null
helm upgrade --install hlf-operator kfs/hlf-operator --version $HLFV --wait >/dev/null

for _ in $(seq 1 60); do
  LB=$(kubectl -n istio-system get svc istio-ingressgateway -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
  [ -n "$LB" ] && break; sleep 10
done
echo "NLB: ${LB:?the gateway Service got no load balancer}"
