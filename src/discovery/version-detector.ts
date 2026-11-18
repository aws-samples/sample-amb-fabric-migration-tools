// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { NetworkAdapter } from '../connection/network-adapter';
import { createLogger } from '../utils/logger';
import { PROBE_RETRY, withRetry } from '../utils/retry';
import { decodeProtobufBlock } from '../extraction/block-decoder';

const logger = createLogger('version-detector');

/**
 * Parsed Fabric network version information derived from channel config capabilities.
 */
export interface FabricVersionInfo {
  /** Highest application capability (e.g. 'V2_0', 'V1_4_2', 'V1_3'). */
  applicationCapability: string;
  /** Highest channel capability (e.g. 'V2_0', 'V1_4_3', 'V1_3'). */
  channelCapability: string;
  /** Highest orderer capability (e.g. 'V2_0', 'V1_4_2', 'V1_1'). */
  ordererCapability: string;
  /** All raw capability keys found, grouped by section. */
  raw: {
    application: string[];
    channel: string[];
    orderer: string[];
  };
  /**
   * MSP IDs of the channel's application organizations, from the config block's
   * `Application.groups.<Org>.values.MSP`.
   *
   * These are the orgs a 2.x peer holds an `_implicit_org_<MSPID>` collection
   * for, so they are what implicit-collection synthesis is built from. Empty
   * when the config block could not be navigated — synthesizing nothing is
   * preferable to synthesizing collections for orgs that may not exist.
   */
  applicationMspIds: string[];
  /** Inferred major Fabric version: '2.x' or '1.x'. */
  majorVersion: '2.x' | '1.x';
  /** Whether the peer likely supports the Gateway gRPC service (Fabric >= 2.4). */
  gatewayServiceExpected: boolean;
  /** Whether _lifecycle system chaincode is available (Fabric >= 2.0). */
  lifecycleAvailable: boolean;
}

/**
 * Detects the Fabric network version by querying the channel configuration block
 * via the `cscc` system chaincode (`GetConfigBlock`).
 *
 * The config block contains Application, Channel, and Orderer capabilities
 * (e.g. V2_0, V1_4_2, V1_3) which are the authoritative indicators of what
 * features the network supports. This is more reliable than checking the peer
 * binary version because capabilities determine actual behavior on the channel.
 */
export class FabricVersionDetector {
  /**
   * Detect the Fabric version for a specific channel.
   *
   * @param network A NetworkAdapter connected to the target channel.
   * @param channelId The channel to query.
   */
  async detect(network: NetworkAdapter, channelId: string): Promise<FabricVersionInfo> {
    return withRetry(
      async () => {
        const contract = network.getContract('cscc');
        const configBlockBytes = await contract.evaluateTransaction(
          'GetConfigBlock',
          channelId,
        );

        return this.parseConfigBlock(configBlockBytes);
      },
      `detectVersion(${channelId})`,
      // A peer that will not answer this leaves the caller assuming capabilities
      // and connecting anyway, so the full retry budget would only delay a
      // connection that is going to be made either way.
      PROBE_RETRY,
    );
  }

  /**
   * Parse the config block to extract capability keys.
   *
   * The config block is either JSON (modern SDK) or protobuf (older SDK/peer).
   * We handle both formats.
   */
  private parseConfigBlock(data: Uint8Array): FabricVersionInfo {
    const buf = Buffer.from(data);

    // Try JSON first (fast path)
    try {
      const block = JSON.parse(buf.toString('utf-8'));
      return this.extractCapabilitiesFromJson(block);
    } catch {
      // Not JSON — try protobuf decoding
    }

    // Try protobuf decoding via fabric-protos
    try {
      const decoded = decodeProtobufBlock(buf);
      return this.extractCapabilitiesFromJson(decoded);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        'Protobuf decode failed on config block — falling back to byte scan',
      );
    }

    // Final fallback: scan raw bytes for capability string patterns
    return this.extractCapabilitiesFromBytes(buf);
  }

  /**
   * Extract capabilities from a JSON-decoded config block.
   *
   * The path to capabilities in the config block is:
   *   block.data.data[0].payload.data.config.channel_group.groups.{Application,Orderer}.values.Capabilities.value.capabilities
   *   block.data.data[0].payload.data.config.channel_group.values.Capabilities.value.capabilities
   */
  private extractCapabilitiesFromJson(block: any): FabricVersionInfo {
    const raw = { application: [] as string[], channel: [] as string[], orderer: [] as string[] };
    let applicationMspIds: string[] = [];

    try {
      const config = this.navigateToConfig(block);
      if (!config) {
        logger.warn('Could not navigate to config in config block JSON');
        return this.buildVersionInfo(raw, applicationMspIds);
      }

      const channelGroup = config.channel_group || config.channelGroup;
      if (!channelGroup) {
        logger.warn('No channel_group found in config');
        return this.buildVersionInfo(raw, applicationMspIds);
      }

      // Channel-level capabilities
      raw.channel = this.extractCapabilityKeys(channelGroup, 'Capabilities');

      const groups = channelGroup.groups;
      if (groups) {
        // Application capabilities
        const appGroup = groups.Application || groups.application;
        if (appGroup) {
          raw.application = this.extractCapabilityKeys(appGroup, 'Capabilities');
          applicationMspIds = this.extractApplicationMspIds(appGroup);
        }

        // Orderer capabilities
        const ordererGroup = groups.Orderer || groups.orderer;
        if (ordererGroup) {
          raw.orderer = this.extractCapabilityKeys(ordererGroup, 'Capabilities');
        }
      }
    } catch (err) {
      logger.warn(
        { error: (err as Error).message },
        'Error parsing capabilities from config block JSON — falling back to byte scan',
      );
      return this.extractCapabilitiesFromBytes(Buffer.from(JSON.stringify(block)));
    }

    return this.buildVersionInfo(raw, applicationMspIds);
  }

  /**
   * Read each application org's MSP ID out of the Application config group.
   *
   * The MSP ID is `values.MSP.value.config.name`, which is the identifier
   * collection policies are written in terms of — deliberately not the config
   * group's own key, which is a human-facing org name and often differs.
   */
  private extractApplicationMspIds(appGroup: any): string[] {
    const orgs = appGroup?.groups;
    if (!orgs || typeof orgs !== 'object') return [];

    const mspIds = new Set<string>();
    for (const org of Object.values<any>(orgs)) {
      const mspValue = org?.values?.MSP?.value ?? org?.values?.msp?.value;
      const name = mspValue?.config?.name ?? mspValue?.name;
      if (typeof name === 'string' && name.length > 0) mspIds.add(name);
    }

    return [...mspIds].sort();
  }

  /**
   * Navigate through the various possible JSON structures to find the config object.
   */
  private navigateToConfig(block: any): any {
    // Standard path: block.data.data[0].payload.data.config
    try {
      const envelope = block?.data?.data?.[0];
      const payload = envelope?.payload ?? envelope;
      const configData = payload?.data;
      if (configData?.config) return configData.config;
      if (configData?.channel_group) return configData;
    } catch (err) {
      logger.debug({ err }, 'Standard config block navigation failed');
    }

    // Direct config (some SDKs return just the config, not the full block)
    if (block?.channel_group || block?.channelGroup) return block;

    return null;
  }

  /**
   * Extract capability key names from a config group's values.
   */
  private extractCapabilityKeys(group: any, valueName: string): string[] {
    const capsValue =
      group?.values?.[valueName]?.value ??
      group?.values?.[valueName.toLowerCase()]?.value;

    if (!capsValue) return [];

    const capabilities = capsValue.capabilities ?? capsValue;
    if (typeof capabilities === 'object' && capabilities !== null) {
      return Object.keys(capabilities);
    }

    return [];
  }

  /**
   * Fallback: scan raw bytes for known Fabric capability strings.
   * Capability keys follow a pattern: V{major}_{minor} or V{major}_{minor}_{patch}
   */
  private extractCapabilitiesFromBytes(buf: Buffer): FabricVersionInfo {
    const text = buf.toString('utf-8');
    const raw = { application: [] as string[], channel: [] as string[], orderer: [] as string[] };

    // Find all capability-like strings: V1_1, V1_3, V1_4_2, V1_4_3, V2_0, V2_5, etc.
    const capPattern = /V[12]_\d(?:_\d)?/g;
    const found = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = capPattern.exec(text)) !== null) {
      found.add(match[0]);
    }

    if (found.size === 0) {
      logger.warn('No capability strings found in config block bytes');
      return this.buildVersionInfo(raw, []);
    }

    // Without full protobuf parsing, we can't distinguish which section each
    // capability belongs to. Put all found capabilities into all sections as
    // a best-effort heuristic — the highest capability is what matters.
    const caps = Array.from(found);
    raw.application = caps;
    raw.channel = caps;
    raw.orderer = caps;

    logger.info(
      { capabilities: caps, method: 'byte-scan' },
      'Detected capabilities via byte scan (protobuf config block)',
    );

    // A byte scan cannot attribute a capability to a section, and it cannot
    // recover MSP IDs at all — there is no pattern to anchor them to.
    return this.buildVersionInfo(raw, []);
  }

  /**
   * Build the FabricVersionInfo from extracted capability keys.
   */
  private buildVersionInfo(
    raw: {
      application: string[];
      channel: string[];
      orderer: string[];
    },
    applicationMspIds: string[],
  ): FabricVersionInfo {
    const applicationCapability = this.highestCapability(raw.application);
    const channelCapability = this.highestCapability(raw.channel);
    const ordererCapability = this.highestCapability(raw.orderer);

    // The highest capability across all sections determines the effective version
    const allCaps = [...raw.application, ...raw.channel, ...raw.orderer];
    const highest = this.highestCapability(allCaps);

    const majorVersion = this.isV2OrHigher(highest) ? '2.x' : '1.x';

    // Gateway gRPC service was introduced in Fabric 2.4.
    // Capability V2_0 means Fabric 2.0+ but Gateway service needs >= 2.4.
    // We can't distinguish 2.0 from 2.4 by capability alone (both use V2_0),
    // so we flag it as "expected" for V2_0 and let the factory probe.
    const gatewayServiceExpected = this.isV2OrHigher(highest);

    // _lifecycle is available with V2_0 capability
    const lifecycleAvailable = this.isV2OrHigher(highest);

    return {
      applicationCapability,
      channelCapability,
      ordererCapability,
      raw,
      applicationMspIds,
      majorVersion,
      gatewayServiceExpected,
      lifecycleAvailable,
    };
  }

  /**
   * Compare capability strings and return the highest one.
   * Capability format: V{major}_{minor} or V{major}_{minor}_{patch}
   */
  private highestCapability(caps: string[]): string {
    if (caps.length === 0) return 'unknown';

    return caps.reduce((highest, cap) => {
      if (highest === 'unknown') return cap;
      return this.compareCapabilities(cap, highest) > 0 ? cap : highest;
    }, 'unknown');
  }

  /**
   * Compare two capability strings. Returns positive if a > b, negative if a < b, 0 if equal.
   */
  private compareCapabilities(a: string, b: string): number {
    const parseVer = (s: string): number[] => {
      const match = s.match(/V(\d+)_(\d+)(?:_(\d+))?/);
      if (!match) return [0, 0, 0];
      return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3] ?? '0', 10)];
    };

    const va = parseVer(a);
    const vb = parseVer(b);

    for (let i = 0; i < 3; i++) {
      if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    return 0;
  }

  private isV2OrHigher(cap: string): boolean {
    const match = cap.match(/V(\d+)/);
    return match ? parseInt(match[1], 10) >= 2 : false;
  }
}
