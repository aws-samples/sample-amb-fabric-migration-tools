import { DiscoveryGateway } from '../discovery/chaincode-discoverer';
import { FabricVersionInfo, FabricVersionDetector } from '../discovery/version-detector';
import { ConnectionProfile, GrpcTimeouts } from '../types';
import { createLogger } from '../utils/logger';
import { Wallet } from './wallet-manager';

const logger = createLogger('gateway-factory');

export type FabricMode = 'auto' | 'gateway' | 'legacy';

export interface GatewayFactoryConfig {
  /** Connection mode. 'auto' tries gateway SDK first, falls back to legacy. */
  mode: FabricMode;
  /** Parsed connection profile. */
  profile: ConnectionProfile;
  /** Enrolled wallet with identity credentials. */
  wallet: Wallet;
  /** Enable Fabric discovery service. Default: false. */
  discovery?: boolean;
  /** gRPC timeout overrides. */
  timeouts?: GrpcTimeouts;
}

export interface GatewayResult {
  gateway: DiscoveryGateway;
  disconnect: () => void;
  mode: 'gateway' | 'legacy';
}

/**
 * Creates the appropriate Fabric gateway implementation based on the target
 * peer's capabilities.
 *
 * - `gateway` mode: Uses @hyperledger/fabric-gateway (requires Fabric 2.4+ Gateway service)
 * - `legacy` mode: Uses fabric-network (works with Fabric 1.4–2.x)
 * - `auto` mode: Tries gateway first, catches UNIMPLEMENTED gRPC errors, falls back to legacy
 *
 * Returns a DiscoveryGateway-compatible object that can be passed to
 * ChaincodeDiscoverer, LedgerInspector, ChannelDiscoverer, and all extraction consumers.
 */
export async function createGateway(config: GatewayFactoryConfig): Promise<GatewayResult> {
  if (config.mode === 'legacy') {
    return connectLegacy(config);
  }

  if (config.mode === 'gateway') {
    return connectGateway(config);
  }

  // Auto-detect: try gateway SDK first
  try {
    const result = await connectGateway(config);

    // The gRPC connection itself succeeds even against pre-2.4 peers —
    // the UNIMPLEMENTED error surfaces on the first evaluate/submit call.
    // We can't probe here without a channel name, so we return optimistically
    // and let detectVersion() (called by the CLI) confirm or trigger a reconnect.
    logger.info('Gateway SDK connection established — using modern Fabric gateway');
    return result;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (isLegacyFallbackError(msg)) {
      logger.warn(
        { error: msg },
        'Gateway SDK failed — falling back to legacy fabric-network SDK',
      );
      return connectLegacy(config);
    }
    throw err;
  }
}

/**
 * Detect the Fabric version on a specific channel and validate the current
 * gateway mode. If the detected version is incompatible with the current
 * mode, reconnects with the correct SDK.
 *
 * Call this after `createGateway()` once you know a channel name.
 */
export async function detectAndValidateVersion(
  currentResult: GatewayResult,
  channelId: string,
  config: GatewayFactoryConfig,
): Promise<{ result: GatewayResult; versionInfo: FabricVersionInfo }> {
  const detector = new FabricVersionDetector();
  let versionInfo: FabricVersionInfo;

  try {
    const network = currentResult.gateway.getNetwork(channelId);
    versionInfo = await detector.detect(network, channelId);
  } catch (err) {
    const msg = (err as Error).message ?? '';

    // If we're on the gateway SDK and the probe fails with UNIMPLEMENTED,
    // the peer doesn't support the Gateway service — switch to legacy.
    if (currentResult.mode === 'gateway' && isLegacyFallbackError(msg)) {
      logger.warn(
        { error: msg, channel: channelId },
        'Version probe failed via gateway SDK — peer does not support Gateway service. ' +
          'Reconnecting with legacy fabric-network SDK.',
      );

      currentResult.disconnect();
      const legacyResult = await connectLegacy(config);

      // Re-probe via legacy
      try {
        const legacyNetwork = legacyResult.gateway.getNetwork(channelId);
        versionInfo = await detector.detect(legacyNetwork, channelId);
      } catch (err) {
        logger.warn({ err }, 'Version detection failed via legacy SDK — using defaults for Fabric 1.x');
        versionInfo = defaultV1VersionInfo();
      }

      return { result: legacyResult, versionInfo };
    }

    // Non-connectivity error — version detection failed but gateway may still work
    logger.warn(
      { error: msg, channel: channelId },
      'Version detection failed — continuing with current SDK mode',
    );
    versionInfo = currentResult.mode === 'gateway' ? defaultV2VersionInfo() : defaultV1VersionInfo();
    return { result: currentResult, versionInfo };
  }

  // Check if we need to switch modes based on detected capabilities
  if (currentResult.mode === 'gateway' && !versionInfo.gatewayServiceExpected) {
    logger.warn(
      { detected: versionInfo.majorVersion, capabilities: versionInfo.raw },
      'Detected Fabric 1.x capabilities but connected via gateway SDK — reconnecting with legacy SDK',
    );
    currentResult.disconnect();
    const legacyResult = await connectLegacy(config);
    return { result: legacyResult, versionInfo };
  }

  logger.info(
    {
      majorVersion: versionInfo.majorVersion,
      applicationCapability: versionInfo.applicationCapability,
      channelCapability: versionInfo.channelCapability,
      ordererCapability: versionInfo.ordererCapability,
      gatewayServiceExpected: versionInfo.gatewayServiceExpected,
      lifecycleAvailable: versionInfo.lifecycleAvailable,
      sdkMode: currentResult.mode,
    },
    'Fabric version detected',
  );

  return { result: currentResult, versionInfo };
}

function isLegacyFallbackError(msg: string): boolean {
  return (
    msg.includes('UNIMPLEMENTED') ||
    msg.includes('is not defined or not found') ||
    msg.includes('does not support the Gateway') ||
    msg.includes('14 UNAVAILABLE')
  );
}

function defaultV1VersionInfo(): FabricVersionInfo {
  return {
    applicationCapability: 'V1_4_2',
    channelCapability: 'V1_4_3',
    ordererCapability: 'V1_4_2',
    raw: { application: ['V1_4_2'], channel: ['V1_4_3'], orderer: ['V1_4_2'] },
    applicationMspIds: [],
    majorVersion: '1.x',
    gatewayServiceExpected: false,
    lifecycleAvailable: false,
  };
}

function defaultV2VersionInfo(): FabricVersionInfo {
  return {
    applicationCapability: 'V2_0',
    channelCapability: 'V2_0',
    ordererCapability: 'V2_0',
    raw: { application: ['V2_0'], channel: ['V2_0'], orderer: ['V2_0'] },
    applicationMspIds: [],
    majorVersion: '2.x',
    gatewayServiceExpected: true,
    lifecycleAvailable: true,
  };
}

async function connectGateway(
  config: GatewayFactoryConfig,
): Promise<GatewayResult> {
  const { AmbGateway } = await import('./amb-gateway');
  const gw = new AmbGateway();
  await gw.connect(config.profile, config.wallet, config.timeouts);

  return {
    gateway: gw,
    disconnect: () => gw.disconnect(),
    mode: 'gateway',
  };
}

async function connectLegacy(
  config: GatewayFactoryConfig,
): Promise<GatewayResult> {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const tmpProfile = path.join(os.tmpdir(), `fabric-profile-${Date.now()}.json`);
  const tmpCert = path.join(os.tmpdir(), `fabric-cert-${Date.now()}.pem`);
  const tmpKey = path.join(os.tmpdir(), `fabric-key-${Date.now()}.pem`);

  const cleanupFiles = () => {
    for (const f of [tmpProfile, tmpCert, tmpKey]) {
      try {
        fs.unlinkSync(f);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.warn({ err, path: f }, 'Failed to clean up temp file');
        }
      }
    }
  };

  // Write temp files with restricted permissions (owner read/write only)
  fs.writeFileSync(tmpProfile, JSON.stringify(config.profile), { encoding: 'utf-8', mode: 0o600 });
  fs.writeFileSync(tmpCert, config.wallet.identity.credentials.certificate, { mode: 0o600 });
  fs.writeFileSync(tmpKey, config.wallet.identity.credentials.privateKey, { mode: 0o600 });

  const { LegacyFabricGateway } = await import('./legacy-fabric-gateway');
  const gw = new LegacyFabricGateway();

  try {
    await gw.connect({
      connectionProfilePath: tmpProfile,
      mspId: config.wallet.identity.mspId,
      certPath: tmpCert,
      keyPath: tmpKey,
      discovery: config.discovery,
      timeouts: config.timeouts,
    });
  } catch (err) {
    cleanupFiles();
    throw err;
  }

  return {
    gateway: gw,
    disconnect: () => {
      gw.disconnect();
      cleanupFiles();
    },
    mode: 'legacy',
  };
}
