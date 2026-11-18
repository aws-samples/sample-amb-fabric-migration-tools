#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# Switch the fabric-eks orderers between the stock image and the patched migration orderer
# (rebroadcast/orderer-patch/), on the devbox. The patched orderer is for the migration window only.
#
#   ./orderer-image.sh patched <repository> <tag[@sha256:digest]>   # adds both migration switches (below)
#   ./orderer-image.sh stock                                         # hyperledger/fabric-orderer:2.5.14, no extra env
#
# The patched orderer's two switches, both set here: ORDERER_MIGRATION_SKIP_EXPIRATION=true accepts transactions
# whose signer certificate has expired, and ORDERER_MIGRATION_CUT_MARKERS=true cuts a block at each cut marker, which
# the descriptor's `cut-markers` orderer mode sends. Without markers the orderer cuts blocks as a stock one does.
#
# hlf-operator rolls a FabricOrdererNode change into its Deployment asynchronously, so a `kubectl rollout status`
# straight after the patch can return before the operator has changed anything. This waits until each Deployment
# runs the new image and its rollout is complete. All three orderers restart: do not run it during a `run`.
set -euo pipefail
export PATH=$HOME/bin:$PATH
case "${1:-}" in
  patched) repo=${2:?repository}; tag=${3:?tag}; migration_env='[{"name":"ORDERER_MIGRATION_SKIP_EXPIRATION","value":"true"},{"name":"ORDERER_MIGRATION_CUT_MARKERS","value":"true"}]' ;;
  stock) repo=hyperledger/fabric-orderer; tag=2.5.14; migration_env='[]' ;;
  *) echo "usage: $0 patched <repository> <tag> | stock" >&2; exit 1 ;;
esac
for n in 0 1 2; do
  # Keep every unrelated setting. A JSON merge patch would otherwise replace
  # the whole env array, and `env: null` would delete it on a stock-image reset.
  env=$(kubectl get fabricorderernodes.hlf.kungfusoftware.es "orderer$n" -o json |
    jq -c --argjson migration "$migration_env" '
      ([.spec.env[]? | select(.name | startswith("ORDERER_MIGRATION_") | not)] + $migration)')
  patch=$(jq -cn --arg image "$repo" --arg tag "$tag" --argjson env "$env" \
    '{spec:{image:$image,tag:$tag,env:$env}}')
  kubectl patch fabricorderernodes.hlf.kungfusoftware.es "orderer$n" --type merge \
    -p "$patch" >/dev/null
done
for n in 0 1 2; do
  for _ in $(seq 1 60); do
    [ "$(kubectl get deploy "orderer$n" -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$repo:$tag" ] && break
    sleep 5
  done
  [ "$(kubectl get deploy "orderer$n" -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$repo:$tag" ] ||
    { echo "orderer$n: the operator has not applied $repo:$tag after 5 minutes" >&2; exit 1; }
  kubectl rollout status "deploy/orderer$n" --timeout=300s >/dev/null
  sw=$(kubectl get deploy "orderer$n" -o json |
    jq -r '[.spec.template.spec.containers[0].env[]? | select(.name | startswith("ORDERER_MIGRATION_")) | "\(.name)=\(.value)"] | join(" ") | if . == "" then "no migration switches" else . end')
  echo "orderer$n: $repo:$tag ($sw)"
done
echo "Wait for each orderer to answer (fabric-rebroadcast plan) before the next run."
