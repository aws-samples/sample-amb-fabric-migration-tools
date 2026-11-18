# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# The patched binary is built from Fabric v2.5.14 (fabric-v2.5.14-migration.patch),
# so the base image is that release, pinned by digest: the floating 2.5 tag moves
# to later releases. Change both together.
FROM hyperledger/fabric-orderer:2.5.14@sha256:d29673a25a098a3841b8a5eedd0c5c3bb6ecf465248d9a67710ed3dba6852a16
COPY orderer /usr/local/bin/orderer
