#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# dbx.sh <script file | -> : run a bash script on the fabric-eks devbox via SSM (as ec2-user's environment), print output.
set -euo pipefail
export AWS_REGION=${AWS_REGION:-us-east-1}   # credentials from AWS_PROFILE or the default chain
I=${DEVBOX_ID:?set DEVBOX_ID (the fabric-eks-devbox stack output InstanceId)}; S=$(cat "${1:--}")
P=$(python3 -c 'import json,sys; print(json.dumps({"commands":["sudo -iu ec2-user bash <<'"'"'DBXEOF'"'"'\n"+sys.argv[1]+"\nDBXEOF"]}))' "$S")
C=$(aws ssm send-command --instance-ids $I --document-name AWS-RunShellScript --timeout-seconds ${DBX_TIMEOUT:-3600} --parameters "$P" --query Command.CommandId --output text)
while :; do st=$(aws ssm get-command-invocation --command-id $C --instance-id $I --query Status --output text 2>/dev/null || echo Pending)
  case $st in Pending|InProgress|Delayed) sleep ${DBX_POLL:-5};; *) break;; esac; done
aws ssm get-command-invocation --command-id $C --instance-id $I --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "[dbx: $st]"; [ "$st" = Success ]
