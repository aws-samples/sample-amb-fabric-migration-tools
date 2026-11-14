import { Command } from 'commander';
import { DiscoverOptions } from '../../types';
import type { ChannelDiscoverer } from '../../discovery/channel-discoverer';
import { DiscoveryError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const logger = createLogger('cli:discover');

/** Verify every explicitly requested channel or refuse the partial scope. */
export async function verifyRequestedChannels(
  discoverer: ChannelDiscoverer,
  requested: string[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const channelId of requested) {
    if (!await discoverer.verifyChannel(channelId)) failed.push(channelId);
  }
  if (failed.length > 0) {
    throw new DiscoveryError(
      `Could not verify requested channel(s): ${failed.join(', ')}. ` +
        'Discovery will not write a manifest that silently omits part of the ' +
        'declared migration scope. Run discovery separately for peers with ' +
        'different channel membership.',
    );
  }
  return [...requested];
}

export const discoverCommand = new Command('discover')
  .description('Discover AMB network topology: channels, chaincodes, collections, ledger heights')
  .requiredOption('--network-id <id>', 'AMB Network ID')
  .requiredOption('--member-id <id>', 'AMB Member ID')
  .requiredOption('--node-id <id>', 'AMB Node ID')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .option('--channels <channels...>', 'Explicit channel names (if cscc query unavailable)')
  .option('--output-dir <dir>', 'Output directory', './extraction-output')
  .option('--fabric-mode <mode>', 'Fabric SDK mode: auto, gateway, legacy', 'legacy')
  .option('--bootstrap-channel <channel>', 'Known channel name for cscc auto-discovery of all channels')
  .option('--tls-cert <path>', 'Path to AMB TLS CA certificate (auto-resolved from $TLS_CA_CERT or ~/managedblockchain-tls-chain.pem if not set)')
  .option('--msp-path <path>', 'Path to enrolled admin MSP directory (auto-resolved from $MSP_PATH if not set). Skips CA enrollment. Without --msp-path, set $CA_ENROLLMENT_SECRET for automatic CA enrollment.')
  .option('--discovery', 'Enable Fabric discovery service (default: disabled for AMB)', false)
  .action(async (opts) => {
    const options: DiscoverOptions = {
      networkId: opts.networkId,
      memberId: opts.memberId,
      nodeId: opts.nodeId,
      region: opts.region,
      outputDir: opts.outputDir,
      bootstrapChannel: opts.bootstrapChannel,
      channels: opts.channels,
      tlsCertPath: opts.tlsCert,
      mspPath: opts.mspPath,
    };

    logger.info({ networkId: options.networkId }, 'Starting AMB network discovery');

    const { AmbEndpointResolver } = await import('../../connection/amb-endpoint-resolver');
    const { ConnectionProfileBuilder } = await import('../../connection/connection-profile-builder');
    const { WalletManager } = await import('../../connection/wallet-manager');
    const { createGateway, detectAndValidateVersion } = await import('../../connection/gateway-factory');
    const { ChannelDiscoverer } = await import('../../discovery/channel-discoverer');
    const { ChaincodeDiscoverer } = await import('../../discovery/chaincode-discoverer');
    const { resolveImplicitOrgMspIds } = await import('../../discovery/implicit-collection-orgs');
    const { LedgerInspector } = await import('../../discovery/ledger-inspector');
    const { ManifestWriter } = await import('../../discovery/manifest-writer');

    const resolver = new AmbEndpointResolver(options.region);
    const endpoints = await resolver.resolve(options.networkId, options.memberId, options.nodeId);

    const profileBuilder = new ConnectionProfileBuilder();
    const profile = profileBuilder.build(endpoints, options);

    const walletManager = new WalletManager();
    const wallet = await walletManager.enroll(profile, options);

    const factoryConfig = {
      mode: (opts.fabricMode ?? 'auto') as 'auto' | 'gateway' | 'legacy',
      profile,
      wallet,
      discovery: opts.discovery as boolean,
    };

    let gatewayResult = await createGateway(factoryConfig);

    logger.info({ fabricMode: gatewayResult.mode }, 'Fabric SDK mode selected');

    try {
      const channelDiscoverer = new ChannelDiscoverer(gatewayResult.gateway);
      let channelIds: string[];

      if (opts.channels && opts.channels.length > 0) {
        logger.info({ provided: opts.channels }, 'Verifying explicitly provided channels');
        channelIds = await verifyRequestedChannels(
          channelDiscoverer, opts.channels as string[],
        );
      } else {
        // Auto-discover all channels via cscc.GetChannels.
        // If --bootstrap-channel is provided, use it as the channel context;
        // otherwise query with an empty channel ID (same as `peer channel list`).
        logger.info(
          { bootstrapChannel: options.bootstrapChannel || '(auto)' },
          'Auto-discovering channels via cscc',
        );
        channelIds = await channelDiscoverer.listChannels(options.bootstrapChannel);
        if (channelIds.length === 0) {
          logger.error(
            'cscc.GetChannels returned no channels. The peer may not have joined any channels, ' +
              'or the query may require a channel context. Try --bootstrap-channel <name> ' +
              'or --channels <name...> to provide channel names explicitly.',
          );
          process.exit(1);
        }
        logger.info({ channels: channelIds }, 'Channels discovered via cscc');
      }

      // Detect Fabric version from the first channel's config block.
      // This validates the SDK mode and may trigger a reconnect if needed.
      let versionInfo;
      if (channelIds.length > 0) {
        const validated = await detectAndValidateVersion(
          gatewayResult,
          channelIds[0],
          factoryConfig,
        );
        gatewayResult = validated.result;
        versionInfo = validated.versionInfo;

        console.log(`\nFabric version detected: ${versionInfo.majorVersion}`);
        console.log(`  Application capability: ${versionInfo.applicationCapability}`);
        console.log(`  Channel capability:     ${versionInfo.channelCapability}`);
        console.log(`  Orderer capability:     ${versionInfo.ordererCapability}`);
        console.log(`  SDK mode:               ${gatewayResult.mode}`);
        console.log(`  _lifecycle available:    ${versionInfo.lifecycleAvailable}`);
        console.log(`  Gateway service:        ${versionInfo.gatewayServiceExpected}\n`);
      }

      const chaincodeDiscoverer = new ChaincodeDiscoverer(gatewayResult.gateway);
      const ledgerInspector = new LedgerInspector(gatewayResult.gateway);

      const channels = await Promise.all(
        channelIds.map(async (channelId) => {
          const implicitOrgMspIds = await resolveImplicitOrgMspIds(
            gatewayResult.gateway,
            channelId,
            endpoints.frameworkVersion,
          );
          const chaincodes = await chaincodeDiscoverer.queryCommitted(channelId, {
            implicitOrgMspIds,
          });
          const ledgerHeight = await ledgerInspector.getHeight(channelId);
          return { channelId, chaincodes, ledgerHeight };
        }),
      );

      const manifestWriter = new ManifestWriter(options.outputDir);
      manifestWriter.write({
        networkId: options.networkId,
        memberId: options.memberId,
        nodeId: options.nodeId,
        region: options.region,
        stateDb: endpoints.stateDb,
        extractedAt: new Date().toISOString(),
        mspId: wallet.identity.mspId,
        fabricVersion: versionInfo?.majorVersion,
        ambFrameworkVersion: endpoints.frameworkVersion,
        fabricCapabilities: versionInfo ? {
          application: versionInfo.applicationCapability,
          channel: versionInfo.channelCapability,
          orderer: versionInfo.ordererCapability,
        } : undefined,
        channels,
      });

      // Print capacity advisory so the user can plan resource provisioning
      const { printCapacityAdvisory } = await import('../../discovery/capacity-estimator');
      printCapacityAdvisory(channels);

      logger.info(
        { channels: channels.length, outputDir: options.outputDir },
        'Discovery complete — manifest.json written',
      );
    } finally {
      gatewayResult.disconnect();
    }

    process.exit(0);
  });
