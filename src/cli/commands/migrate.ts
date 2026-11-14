import { Command } from 'commander';
import { createInterface, Interface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as fs from 'fs';
import * as path from 'path';
import {
  DiscoverOptions,
  ExtractOptions,
  Manifest,
  MigrationTier,
  ReplayConfig,
} from '../../types';
import { createLogger, setLogLevel } from '../../utils/logger';
import { assessPrivateDataSupport } from '../../utils/fabric-version';
import {
  runValidation,
  formatValidationResults,
} from '../../validation/validation-runner';
import {
  promptReplayConfig,
  ask,
  choose,
  chooseMultiple,
} from '../replay-config-prompts';

const logger = createLogger('cli:migrate');

// ── Types ──

interface AmbTarget {
  region: string;
  networkId: string;
  memberId: string;
  nodeId: string;
}

interface DiscoveryResult {
  manifest: Manifest;
  profile: any;
  wallet: any;
}

// ── Command ──

export const migrateCommand = new Command('migrate')
  .description(
    'Interactive wizard (for testing): discover, extract, validate, and replay in one session',
  )
  .option(
    '--output-dir <dir>',
    'Output directory',
    './extraction-output',
  )
  .option(
    '--config <path>',
    'Replay config JSON — skip adapter prompts and use this config for replay/verify',
  )
  .action(async (opts) => {
    const rl = createInterface({ input, output });
    try {
      await runWizard(rl, opts.outputDir, opts.config);
    } finally {
      rl.close();
    }
  });

// ── Wizard orchestrator ──

async function runWizard(
  rl: Interface,
  defaultOutputDir: string,
  configPath?: string,
): Promise<void> {
  const savedLogLevel = logger.level;
  setLogLevel('silent');

  console.log('');
  console.log('  Fabric AMB Migration Wizard');
  console.log(
    '  Guides you through: discover → extract → validate → replay',
  );

  const target = await promptAmbTarget(rl);

  const outputDir = defaultOutputDir;
  console.log(`\n  Output directory: ${outputDir}`);

  const mspPath = await promptMspPath(rl);

  const discovery = await runDiscoveryStep(
    target, outputDir, mspPath,
  );

  const scope = await promptExtractionScope(
    rl, discovery.manifest,
  );

  setLogLevel(savedLogLevel);
  await runExtractionStep(
    discovery, scope.tier, scope.channels, outputDir,
  );
  setLogLevel('silent');

  const shouldContinue = await runValidationStep(
    rl, outputDir,
  );
  if (!shouldContinue) return;

  await runReplayStep(
    rl, outputDir, configPath, target.region,
    discovery.manifest, savedLogLevel,
  );
}

// ── Phase 1: AMB target selection (steps 1-4) ──

async function promptAmbTarget(
  rl: Interface,
): Promise<AmbTarget> {
  const defaultRegion =
    process.env.AWS_DEFAULT_REGION ||
    process.env.AWS_REGION ||
    'us-east-1';
  console.log('\n  Step 1: AWS Configuration');
  const region = await ask(
    rl,
    `AWS region [${defaultRegion}]`,
    defaultRegion,
  );

  const { AmbEndpointResolver } = await import(
    '../../connection/amb-endpoint-resolver'
  );
  const resolver = new AmbEndpointResolver(region);

  console.log('\n  Listing available Fabric networks...');
  const networks = await resolver.listNetworks();
  if (networks.length === 0) {
    console.log(
      `\n  No available Hyperledger Fabric networks found in ${region}.`,
    );
    process.exit(1);
  }

  const networkIdx = await choose(
    rl,
    'Select network',
    networks.map(
      (n) => `${n.name} (${n.id}) — Fabric ${n.frameworkVersion}`,
    ),
  );
  const network = networks[networkIdx];

  console.log('\n  Listing your members...');
  const members = await resolver.listMembers(network.id);
  if (members.length === 0) {
    console.log(
      '\n  No available members found for this network.',
    );
    process.exit(1);
  }

  let memberIdx = 0;
  if (members.length === 1) {
    console.log(
      `  Auto-selected member: ${members[0].name} (${members[0].id})`,
    );
  } else {
    memberIdx = await choose(
      rl,
      'Select member',
      members.map((m) => `${m.name} (${m.id})`),
    );
  }
  const member = members[memberIdx];

  console.log('\n  Listing available nodes...');
  const nodes = await resolver.listNodes(
    network.id, member.id,
  );
  if (nodes.length === 0) {
    console.log(
      '\n  No available nodes found for this member.',
    );
    process.exit(1);
  }

  let nodeIdx = 0;
  if (nodes.length === 1) {
    console.log(
      `  Auto-selected node: ${nodes[0].id} (${nodes[0].availabilityZone}, ${nodes[0].instanceType})`,
    );
  } else {
    nodeIdx = await choose(
      rl,
      'Select node',
      nodes.map(
        (n) =>
          `${n.id} (${n.availabilityZone}, ${n.instanceType})`,
      ),
    );
  }
  const node = nodes[nodeIdx];

  return {
    region,
    networkId: network.id,
    memberId: member.id,
    nodeId: node.id,
  };
}

// ── Phase 2: MSP credentials (step 6) ──

async function promptMspPath(
  rl: Interface,
): Promise<string | undefined> {
  const envMsp = process.env['MSP_PATH'] ?? '';
  if (envMsp) {
    console.log(`  Using MSP_PATH: ${envMsp}`);
    return envMsp;
  }
  return (
    (await ask(
      rl,
      'Admin MSP path (or Enter for CA enrollment)',
    )) || undefined
  );
}

// ── Phase 3: Discovery (step 7) ──

async function runDiscoveryStep(
  target: AmbTarget,
  outputDir: string,
  mspPath?: string,
): Promise<DiscoveryResult> {
  console.log('\n  Running discovery...\n');

  const discoverOptions: DiscoverOptions = {
    networkId: target.networkId,
    memberId: target.memberId,
    nodeId: target.nodeId,
    region: target.region,
    outputDir,
    mspPath,
  };

  const [
    { AmbEndpointResolver },
    { ConnectionProfileBuilder },
    { WalletManager },
    { createGateway, detectAndValidateVersion },
    { ChannelDiscoverer },
    { ChaincodeDiscoverer },
    { resolveImplicitOrgMspIds },
    { LedgerInspector },
    { ManifestWriter },
  ] = await Promise.all([
    import('../../connection/amb-endpoint-resolver'),
    import('../../connection/connection-profile-builder'),
    import('../../connection/wallet-manager'),
    import('../../connection/gateway-factory'),
    import('../../discovery/channel-discoverer'),
    import('../../discovery/chaincode-discoverer'),
    import('../../discovery/implicit-collection-orgs'),
    import('../../discovery/ledger-inspector'),
    import('../../discovery/manifest-writer'),
  ]);

  const resolver = new AmbEndpointResolver(target.region);
  const endpoints = await resolver.resolve(
    target.networkId,
    target.memberId,
    target.nodeId,
  );
  const profile = new ConnectionProfileBuilder().build(
    endpoints,
    discoverOptions,
  );
  const wallet = await new WalletManager().enroll(
    profile,
    discoverOptions,
  );

  let gatewayResult = await createGateway({
    mode: 'legacy',
    profile,
    wallet,
    discovery: false,
  });

  let manifest: Manifest;
  try {
    const channelDiscoverer = new ChannelDiscoverer(
      gatewayResult.gateway,
    );
    const channelIds =
      await channelDiscoverer.listChannels();
    if (channelIds.length === 0) {
      console.log(
        '\n  No channels found on the peer. Try the discover command with --bootstrap-channel.',
      );
      process.exit(1);
    }

    const validated = await detectAndValidateVersion(
      gatewayResult,
      channelIds[0],
      { mode: 'legacy', profile, wallet, discovery: false },
    );
    gatewayResult = validated.result;
    const versionInfo = validated.versionInfo;

    const chaincodeDiscoverer = new ChaincodeDiscoverer(
      gatewayResult.gateway,
    );
    const ledgerInspector = new LedgerInspector(
      gatewayResult.gateway,
    );

    const channels = await Promise.all(
      channelIds.map(async (channelId) => {
        const implicitOrgMspIds = await resolveImplicitOrgMspIds(
          gatewayResult.gateway,
          channelId,
          endpoints.frameworkVersion,
        );
        const chaincodes =
          await chaincodeDiscoverer.queryCommitted(channelId, {
            implicitOrgMspIds,
          });
        const ledgerHeight =
          await ledgerInspector.getHeight(channelId);
        return { channelId, chaincodes, ledgerHeight };
      }),
    );

    const capabilities = versionInfo ? {
      application: versionInfo.applicationCapability,
      channel: versionInfo.channelCapability,
      orderer: versionInfo.ordererCapability,
    } : undefined;

    manifest = {
      networkId: target.networkId,
      memberId: target.memberId,
      nodeId: target.nodeId,
      region: target.region,
      stateDb: endpoints.stateDb,
      extractedAt: new Date().toISOString(),
      mspId: wallet.identity.mspId,
      fabricVersion: versionInfo?.majorVersion,
      ambFrameworkVersion: endpoints.frameworkVersion,
      fabricCapabilities: capabilities,
      channels,
    };

    new ManifestWriter(outputDir).write(manifest);
    printDiscoverySummary(manifest, versionInfo?.majorVersion);
  } finally {
    gatewayResult.disconnect();
  }

  return { manifest, profile, wallet };
}

function printDiscoverySummary(
  manifest: Manifest,
  fabricVersion?: string,
): void {
  console.log('  Discovery complete:\n');
  console.log(
    `  Fabric version: ${fabricVersion ?? 'unknown'}`,
  );
  for (const ch of manifest.channels) {
    console.log(
      `  Channel: ${ch.channelId} (${ch.ledgerHeight} blocks, ${ch.chaincodes.length} chaincodes)`,
    );
    for (const cc of ch.chaincodes) {
      const collSuffix =
        cc.collections.length > 0
          ? ` [${cc.collections.length} collections]`
          : '';
      console.log(
        `    - ${cc.name} v${cc.version}${collSuffix}`,
      );
    }
  }
}

// ── Phase 4: Extraction scope (steps 8-9) ──

async function promptExtractionScope(
  rl: Interface,
  manifest: Manifest,
): Promise<{ tier: MigrationTier; channels: string[] }> {
  console.log('');
  const tierIdx = await choose(
    rl,
    'Migration tier',
    [
      'Current state only (fastest)',
      'State + audit trail (block metadata)',
      'Full history + private data history',
    ],
  );
  const tier = (tierIdx + 1) as MigrationTier;

  const allChannelIds = manifest.channels.map(
    (c) => c.channelId,
  );
  let channels: string[];

  if (allChannelIds.length === 1) {
    channels = allChannelIds;
    console.log(
      `\n  Extracting channel: ${allChannelIds[0]}`,
    );
  } else {
    const extractAll =
      await ask(rl, 'Extract all channels? [Y/n]', 'Y');
    if (
      extractAll.toLowerCase() === 'n' ||
      extractAll.toLowerCase() === 'no'
    ) {
      channels = await chooseMultiple(
        rl,
        'Select channels (comma-separated numbers)',
        allChannelIds,
      );
    } else {
      channels = allChannelIds;
    }
  }

  return { tier, channels };
}

// ── Phase 5: Extraction (step 10) ──

async function runExtractionStep(
  discovery: DiscoveryResult,
  tier: MigrationTier,
  channels: string[],
  outputDir: string,
): Promise<void> {
  const manifestPath = path.join(outputDir, 'manifest.json');
  console.log('\n  Running extraction...\n');

  const extractOptions: ExtractOptions = {
    manifest: manifestPath,
    nodeId: discovery.manifest.nodeId,
    tier,
    channels,
    outputDir,
    batchSize: 100,
    strategy: 'auto',
    concurrency: 1,
    stateBackend: 'auto',
    memoryLimitMb: 512,
    prefetchBuffer: 8,
  };

  const { createGateway } = await import(
    '../../connection/gateway-factory'
  );
  const gatewayResult = await createGateway({
    mode: 'legacy',
    profile: discovery.profile,
    wallet: discovery.wallet,
    discovery: false,
  });

  try {
    let deliverPrivateData =
      gatewayResult.gateway.deliverPrivateData
        ? gatewayResult.gateway.deliverPrivateData.bind(
            gatewayResult.gateway,
          )
        : undefined;

    if (deliverPrivateData) {
      const support = assessPrivateDataSupport(discovery.manifest);
      if (!support.supported) {
        console.log(`\n  Private data: ${support.reason}.`);
        logger.warn(
          { frameworkVersion: support.frameworkVersion },
          `Skipping DeliverWithPrivateData — ${support.reason}`,
        );
        deliverPrivateData = undefined;
      }
    }

    const channelsToExtract =
      discovery.manifest.channels.filter((c) =>
        channels.includes(c.channelId),
      );

    const { HybridExtractor } = await import(
      '../../extraction/strategies/hybrid-extractor'
    );
    const extractor = new HybridExtractor(
      extractOptions,
      discovery.manifest,
      gatewayResult.gateway,
      discovery.wallet.identity.mspId,
      deliverPrivateData,
    );
    await extractor.run(channelsToExtract);
    console.log('  Extraction complete.\n');
  } finally {
    gatewayResult.disconnect();
  }
}

// ── Phase 6: Validation (step 11) ──

async function runValidationStep(
  rl: Interface,
  outputDir: string,
): Promise<boolean> {
  console.log('  Running validation...\n');
  const results = await runValidation(outputDir);
  console.log(formatValidationResults(results));
  console.log('');

  const failures = results.filter(
    (r) => r.status === 'fail',
  ).length;
  if (failures > 0) {
    const proceed = await ask(
      rl,
      'Validation failed. Continue to replay anyway? [y/N]',
      'N',
    );
    if (
      proceed.toLowerCase() !== 'y' &&
      proceed.toLowerCase() !== 'yes'
    ) {
      console.log(
        '\n  Stopping. Fix validation issues and re-run.\n',
      );
      return false;
    }
  }

  return true;
}

// ── Phase 7: Replay (steps 12-14) ──

async function runReplayStep(
  rl: Interface,
  outputDir: string,
  configPath: string | undefined,
  region: string,
  manifest: Manifest,
  logLevel: string,
): Promise<void> {
  const doReplay = await ask(
    rl,
    'Proceed to replay? [Y/n]',
    'Y',
  );
  if (
    doReplay.toLowerCase() === 'n' ||
    doReplay.toLowerCase() === 'no'
  ) {
    console.log('\n  Migration paused after extraction.');
    console.log(
      `  Output saved to: ${outputDir}`,
    );
    console.log(
      '  Run `node dist/cli/index.js replay' +
        ` --input-dir ${outputDir}` +
        ' --adapter <adapter> --config <config.json>` when ready.\n',
    );
    return;
  }

  let config: ReplayConfig;

  if (configPath) {
    config = JSON.parse(
      fs.readFileSync(configPath, 'utf-8'),
    );
    config.inputDir = outputDir;
    console.log(
      `\n  Using replay config: ${configPath}`,
    );
    console.log(`  Adapter: ${config.adapter}`);
  } else {
    config = await promptReplayConfig(
      rl, outputDir, region, manifest,
    );
  }

  const savedConfigPath = path.join(
    outputDir, 'replay-config.json',
  );
  fs.writeFileSync(
    savedConfigPath,
    JSON.stringify(config, null, 2),
    'utf-8',
  );
  console.log(`  Config saved to: ${savedConfigPath}`);

  console.log('\n  Running replay...\n');

  setLogLevel(logLevel);
  const { ReplayOrchestrator } = await import(
    '../../replay/replay-orchestrator'
  );
  const orchestrator = new ReplayOrchestrator(config);
  const summary = await orchestrator.run();
  setLogLevel('silent');

  if (summary.totalFailed > 0) {
    console.log(
      `\n  Replay FAILED: ${summary.totalFailed} record(s) did not reach ` +
      `the destination.\n  Full list: ${summary.failureReportPath}\n`,
    );
    console.log(
      '  The replay checkpoint has been retained — fix the cause and re-run ' +
      'replay to retry.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n  Migration complete.\n');
  console.log(`  Output directory: ${outputDir}`);
  console.log(
    '  To verify: node dist/cli/index.js verify' +
      ` --input-dir ${outputDir}` +
      ` --config ${savedConfigPath}\n`,
  );
}
