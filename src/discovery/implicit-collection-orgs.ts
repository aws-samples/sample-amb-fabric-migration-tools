// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DiscoveryGateway } from './chaincode-discoverer';
import { FabricVersionDetector } from './version-detector';
import { supportsImplicitCollections } from '../utils/fabric-version';
import { DiscoveryError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('implicit-collection-orgs');

/** Why a missing MSP ID is fatal rather than something to carry on without. */
const WHY_FATAL =
  'Fabric 2.x peers hold an _implicit_org_<MSPID> collection for every channel ' +
  'org, and those collections appear in no chaincode definition, so without the ' +
  'MSP IDs any private data in them would be missed without a trace. Confirm ' +
  'this identity can read the channel config, then re-run discover.';

/**
 * Resolve the MSP IDs a channel's `_implicit_org_<MSPID>` collections belong to.
 *
 * Read per channel rather than once per network: channel membership is a
 * per-channel property, so a network's other channels say nothing about which
 * orgs this one has. The cost is one `cscc.GetConfigBlock` per channel, which is
 * negligible next to the block walk that follows.
 *
 * @param gateway Connected gateway, used to reach the channel's peer.
 * @param channelId Channel to read membership from.
 * @param frameworkVersion AMB `FrameworkVersion` for the network, e.g. '2.2'.
 * @returns The channel's application org MSP IDs, or an empty list on a network
 *   older than Fabric 2.0, where implicit collections do not exist.
 * @throws DiscoveryError when the config block cannot be read, or when it yields
 *   no MSP IDs at all. Every channel has at least one application org, so an
 *   empty result is a failed read.
 */
export async function resolveImplicitOrgMspIds(
  gateway: DiscoveryGateway,
  channelId: string,
  frameworkVersion: string,
): Promise<string[]> {
  if (!supportsImplicitCollections(frameworkVersion)) {
    logger.debug(
      { channelId, frameworkVersion },
      'Network predates Fabric 2.0 — it has no implicit collections',
    );
    return [];
  }

  const mspIds = await readApplicationMspIds(gateway, channelId);

  if (mspIds.length === 0) {
    throw new DiscoveryError(
      'No application organization MSP IDs could be read from channel ' +
        `"${channelId}"'s config block on this Fabric ${frameworkVersion} ` +
        'network. Every channel has at least one application organization, so ' +
        `this is a failed read rather than a channel without orgs. ${WHY_FATAL}`,
    );
  }

  logger.info(
    { channelId, mspIds },
    'Resolved application orgs for implicit-collection synthesis',
  );
  return mspIds;
}

/**
 * Read the channel's application org MSP IDs from its config block.
 *
 * @throws DiscoveryError when the config block cannot be fetched or parsed.
 */
async function readApplicationMspIds(
  gateway: DiscoveryGateway,
  channelId: string,
): Promise<string[]> {
  try {
    const versionInfo = await new FabricVersionDetector().detect(
      gateway.getNetwork(channelId),
      channelId,
    );
    return versionInfo.applicationMspIds;
  } catch (err) {
    throw new DiscoveryError(
      `Could not read channel "${channelId}"'s config block to resolve its ` +
        `application organizations: ${(err as Error).message}. ${WHY_FATAL}`,
    );
  }
}
