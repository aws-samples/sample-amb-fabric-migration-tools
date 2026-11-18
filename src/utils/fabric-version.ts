// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Manifest } from '../types';
import { ExtractionError } from './errors';

/**
 * First Fabric major version whose peer implements the `DeliverWithPrivateData`
 * RPC.
 *
 * Verified against the protobuf definitions rather than the release notes:
 * `protos/peer/events.proto` on `hyperledger/fabric` `release-1.4` defines only
 * `Deliver` and `DeliverFiltered`, and `DeliverWithPrivateData` first appears in
 * `hyperledger/fabric-protos` `release-2.2`. So private-data *values* cannot be
 * obtained from a 1.2 or 1.4 network by any client-side means.
 */
const PRIVATE_DATA_DELIVERY_MAJOR = 2;

/** Whether the source network's peers can deliver private-data values. */
export interface PrivateDataSupport {
  supported: boolean;
  /** AMB `FrameworkVersion` the decision was made from. */
  frameworkVersion: string;
  /** Why, phrased for an operator reading the extraction log. */
  reason: string;
}

/**
 * Decide whether the source network's peers implement `DeliverWithPrivateData`.
 *
 * Gated on AMB's `FrameworkVersion` — the peer binary version — because the RPC
 * is a property of the binary. Channel application capability is not a proxy for
 * it, and using one is wrong in both directions: a 2.2 peer serves the RPC on a
 * channel still at `V1_2` capability, which is legal and common, and a 1.4 peer
 * rejects it on a channel at `V1_4_2`.
 *
 * @param manifest Manifest written by `discover` against the source network.
 * @throws ExtractionError when the manifest carries no usable
 *   `ambFrameworkVersion`. Both fallbacks lose data — assuming support attempts
 *   an RPC that may not exist, assuming none abandons recoverable private data —
 *   so an unestablished version is refused instead of guessed.
 */
export function assessPrivateDataSupport(
  manifest: Manifest,
): PrivateDataSupport {
  const frameworkVersion = manifest.ambFrameworkVersion?.trim() ?? '';
  if (!frameworkVersion) {
    throw new ExtractionError(
      'Manifest carries no ambFrameworkVersion, so whether this network\'s peers ' +
        'implement DeliverWithPrivateData cannot be established. Re-run ' +
        '`discover` against the network to record it, then extract from the ' +
        'manifest it writes.',
    );
  }

  const major = parseMajorVersion(frameworkVersion);
  if (major === undefined) {
    throw new ExtractionError(
      `Manifest records ambFrameworkVersion "${frameworkVersion}", which is not ` +
        'a Fabric version this tool can compare against 2.0. Private-data ' +
        'support cannot be established from it.',
    );
  }

  if (major >= PRIVATE_DATA_DELIVERY_MAJOR) {
    return {
      supported: true,
      frameworkVersion,
      reason:
        `AMB FrameworkVersion ${frameworkVersion} is Fabric ` +
        `${PRIVATE_DATA_DELIVERY_MAJOR}.0 or later, so its peers serve ` +
        'DeliverWithPrivateData',
    };
  }

  return {
    supported: false,
    frameworkVersion,
    reason:
      `AMB FrameworkVersion ${frameworkVersion} predates Fabric ` +
      `${PRIVATE_DATA_DELIVERY_MAJOR}.0, which is where DeliverWithPrivateData ` +
      'was introduced. Private-data values are unobtainable from this network by ' +
      'any client-side route; hashes from the block walk are the ceiling',
  };
}

/**
 * Whether the network's peers provide `_implicit_org_<MSPID>` collections.
 *
 * Implicit collections arrived with the 2.0 chaincode lifecycle, so this shares
 * `PRIVATE_DATA_DELIVERY_MAJOR`'s threshold by coincidence of history rather
 * than by dependence — both are 2.0 peer features.
 *
 * @param frameworkVersion AMB `FrameworkVersion`, e.g. '2.2'.
 * @returns False for a version that cannot be parsed, so an unrecognised
 *   version synthesizes nothing rather than inventing collections.
 */
export function supportsImplicitCollections(frameworkVersion: string): boolean {
  const major = parseMajorVersion(frameworkVersion.trim());
  return major !== undefined && major >= PRIVATE_DATA_DELIVERY_MAJOR;
}

/**
 * Leading major version number of an AMB `FrameworkVersion` such as '2.2'.
 *
 * @returns The major version, or `undefined` when the string does not begin
 *   with one.
 */
function parseMajorVersion(version: string): number | undefined {
  const match = version.match(/^(\d+)(?:\.|$)/);
  return match ? parseInt(match[1], 10) : undefined;
}
