#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Enroll every member's CA admin and prepare what other members need from it.
#
# For each member in $MM_HOME/members.list:
#   - reads {"username"?, "password"} from Secrets Manager at
#     $MM_SECRET_PREFIX/<member>/admin, without printing it
#   - enrolls into $MM_HOME/msp/<member> (skipped if already enrolled)
#   - copies signcerts to admincerts, as AMB requires
#   - writes $MM_HOME/share/<member>/{admincerts,cacerts}: the two artifacts a
#     member hands a channel creator. A real consortium exchanges exactly these;
#     the keystore never leaves its owner.
#
# Usage:
#   MM_SECRET_PREFIX=amb-migration-live-test ./enroll.sh
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
mm_network

PREFIX="${MM_SECRET_PREFIX:-amb-migration-live-test}"

for name in $(mm_members); do
  mm_use "$name"
  if [ -f "$MSP_PATH/signcerts/cert.pem" ]; then
    echo "  $name: already enrolled at $MSP_PATH"
  else
    secret=$(aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id "$PREFIX/$name/admin" --query SecretString --output text)
    user=$(jq -r '.username // "admin"' <<<"$secret")
    pass=$(jq -r '.password' <<<"$secret")
    unset secret
    [ -n "$pass" ] && [ "$pass" != null ] || mm_die "$PREFIX/$name/admin has no password field"
    # The URL carries the password, so it goes through the environment rather
    # than the command line where `ps` would show it.
    FABRIC_CA_CLIENT_URL="https://${user}:${pass}@${CA_ENDPOINT}" \
      fabric-ca-client enroll --tls.certfiles "$TLS_CA_CERT" -M "$MSP_PATH" >/dev/null 2>&1 ||
      mm_die "$name: CA enrollment failed (check the secret's username and password)"
    unset pass
    cp -r "$MSP_PATH/signcerts" "$MSP_PATH/admincerts"
    echo "  $name: enrolled $user into $MSP_PATH"
  fi
  # One key per keystore: the toolkit and the peer CLI both take the first.
  [ "$(ls "$MSP_PATH/keystore" | wc -l)" -eq 1 ] ||
    mm_die "$name: $MSP_PATH/keystore holds more than one key"

  share="$MM_HOME/share/$name"
  mkdir -p "$share/admincerts" "$share/cacerts"
  cp "$MSP_PATH/admincerts/"* "$share/admincerts/"
  cp "$MSP_PATH/cacerts/"* "$share/cacerts/"
done

echo "Enrolled: $(mm_members | tr '\n' ' ')"
