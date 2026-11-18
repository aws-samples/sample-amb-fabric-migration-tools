// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Command, Option, OptionValues } from 'commander';
import { ChannelInfo, MigrationTier, ExtractionStrategy, StateBackendOption, ExtractOptions, GrpcTimeouts, Manifest } from '../../types';
import { createLogger } from '../../utils/logger';
import { ExtractorError } from '../../utils/errors';
import { assessPrivateDataSupport } from '../../utils/fabric-version';
import * as fs from 'fs';


/** Commander passes the previous/default value as a second parser argument. */
export function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}
const logger = createLogger('cli:extract');

const VALID_STRATEGIES: ExtractionStrategy[] = ['auto', 'block-reconstruction'];
const VALID_STATE_BACKENDS: StateBackendOption[] = ['auto', 'memory', 'leveldb'];

/**
 * Builds the extraction options out of the parsed flags.
 *
 * Separate from the action handler, which cannot run without a gateway: a flag
 * the command declares but nothing copies here is parsed and then silently
 * ignored, which is how `--state-data-dir` came to exist in two places and take
 * effect in neither.
 */
export function toExtractOptions(opts: OptionValues): ExtractOptions {
  return {
    manifest: opts.manifest,
    nodeId: opts.nodeId,
    tier: opts.tier as MigrationTier,
    channels: opts.channels,
    outputDir: opts.outputDir,
    batchSize: opts.batchSize,
    strategy: opts.strategy as ExtractionStrategy,
    concurrency: opts.concurrency,
    stateBackend: opts.stateBackend as StateBackendOption,
    memoryLimitMb: opts.memoryLimit,
    prefetchBuffer: opts.prefetchBuffer,
    stateDataDir: opts.stateDataDir,
    privateOnly: opts.privateOnly === true ? true : undefined,
    saveBlocksDir: opts.saveBlocks,
    blocksOnly: opts.blocksOnly === true ? true : undefined,
    extend: opts.extend === true ? true : undefined,
    processes: opts.processes,
    identitiesOut: opts.identitiesOut,
  };
}

/**
 * Refuse option combinations that would archive nothing or produce an output
 * directory that reads as a finished extraction when it is not.
 *
 * Pure, and exported, because the action handler cannot run without a gateway.
 *
 * @throws ExtractorError naming the conflict.
 */
export function checkArchiveOptions(options: ExtractOptions): void {
  if (options.blocksOnly && !options.saveBlocksDir) {
    throw new ExtractorError(
      '--blocks-only needs --save-blocks <dir>: it walks the chain to write the block archive and does nothing else, ' +
        'so without a directory it would read every block and keep none.',
      'EXTRACTION_ERROR',
    );
  }
  if (options.extend && options.blocksOnly) {
    throw new ExtractorError(
      '--extend cannot be combined with --blocks-only: a blocks-only run writes no extraction to extend. ' +
        'Re-run --blocks-only on the same --save-blocks directory; it continues from the last archived block.',
      'EXTRACTION_ERROR',
    );
  }
  if (options.saveBlocksDir && options.privateOnly) {
    throw new ExtractorError(
      '--save-blocks cannot be combined with --private-only: a private-only extraction skips the public block walk, ' +
        'so there would be no blocks to archive. Archive from the lead member\'s full extraction.',
      'EXTRACTION_ERROR',
    );
  }
}

/**
 * Narrow the discovered channels to those named by `--channels`.
 *
 * An unknown name is refused rather than filtered out. Filtering leaves an empty
 * list, the walk then has nothing to do, and the command exits 0 having written
 * an output directory that holds no channel's data — which every later step
 * reads as an extraction that simply found nothing. A typo in a channel name is
 * the whole distance between those two readings, so it stops the run.
 *
 * Exported for the same reason `toExtractOptions` is: the action handler cannot
 * run without a gateway, so anything only reachable through it is untested.
 *
 * @param manifest Manifest written by `discover`.
 * @param channels Channel IDs from `--channels`, or `undefined` for all.
 * @returns The channels to extract, never empty.
 * @throws ExtractorError naming the unknown channels, or refusing an empty run.
 */
export function selectChannels(
  manifest: Manifest,
  channels: string[] | undefined,
): ChannelInfo[] {
  const known = manifest.channels.map((c) => c.channelId);

  if (channels) {
    const unknown = channels.filter((c) => !known.includes(c));
    if (unknown.length > 0) {
      throw new ExtractorError(
        '--channels named channel(s) that are not in the manifest: ' +
          `${unknown.join(', ')}. Manifest channels: ` +
          `${known.length > 0 ? known.join(', ') : '(none)'}. ` +
          'Extracting none of them would exit 0 over an empty output ' +
          'directory, which reads as a network that holds nothing.',
        'EXTRACTION_ERROR',
      );
    }
  }

  if (known.length === 0) {
    throw new ExtractorError(
      `The manifest at ${manifest.networkId} lists no channels, so there is ` +
        'nothing to extract. Re-run discover, or point --manifest at the ' +
        'manifest.json it wrote.',
      'EXTRACTION_ERROR',
    );
  }

  return channels
    ? manifest.channels.filter((c) => channels.includes(c.channelId))
    : manifest.channels;
}

export const extractCommand = new Command('extract')
  .description('Extract state and/or history from Fabric channels')
  .requiredOption('--manifest <path>', 'Path to manifest.json from discover step')
  .requiredOption('--tier <tier>', 'Migration tier: 1 (state), 2 (state+audit), 3 (full history)', parseInteger)
  .requiredOption('--network-id <id>', 'AMB Network ID')
  .requiredOption('--member-id <id>', 'AMB Member ID')
  .requiredOption('--node-id <id>', 'AMB Node ID')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .option('--msp-path <path>', 'Path to enrolled admin MSP directory (auto-resolved from $MSP_PATH if not set). Without --msp-path, set $CA_ENROLLMENT_SECRET for automatic CA enrollment.')
  .option('--tls-cert <path>', 'Path to AMB TLS CA certificate (auto-resolved from $TLS_CA_CERT or ~/managedblockchain-tls-chain.pem if not set)')
  .option('--channels <channels...>', 'Specific channels to extract (default: all)')
  .option('--output-dir <dir>', 'Output directory', './extraction-output')
  .option('--batch-size <size>', 'Pagination batch size', parseInteger, 100)
  .option(
    '--strategy <strategy>',
    'Extraction strategy: auto, block-reconstruction (default: auto)',
    'auto',
  )
  .option('--concurrency <n>', 'Number of channels to extract in parallel', parseInteger, 1)
  .option(
    '--state-backend <backend>',
    'State accumulator backend: auto (in-memory with LevelDB promotion), memory, leveldb (default: auto)',
    'auto',
  )
  .option(
    '--memory-limit <mb>',
    'Memory limit in MB before auto-promoting to LevelDB, for all channels ' +
      'together: with --concurrency > 1 each channel gets an equal share ' +
      '(default: 512)',
    parseInteger,
    512,
  )
  .option(
    '--state-data-dir <dir>',
    'Directory the LevelDB state accumulator spills into, one subdirectory per ' +
      'channel: point it at a volume with room for the whole reconstructed state ' +
      '(default: the system temp directory, which is the root volume on AL2)',
  )
  .option(
    '--prefetch-buffer <n>',
    'Number of blocks to fetch ahead during block walk (default: 8, 0 to disable)',
    parseInteger,
    8,
  )
  .option(
    '--grpc-request-timeout <ms>',
    'gRPC deadline for evaluate/endorse/submit calls in ms (default: 30000)',
    parseInteger,
  )
  .option(
    '--grpc-commit-timeout <ms>',
    'gRPC deadline for commit-status checks in ms (default: 60000)',
    parseInteger,
  )
  .option(
    '--grpc-connect-timeout <ms>',
    'gRPC wait-for-ready / connect timeout in ms (default: 15000)',
    parseInteger,
  )
  .option(
    '--private-only',
    'Extract this member\'s private data only, skipping the public block walk. ' +
      'For a member whose public data another member\'s full extraction carries; ' +
      'merge the two',
  )
  .option(
    '--save-blocks <dir>',
    'Also write every raw block to <dir>/<channel>/blocks/<N>.block with a SHA-256 list and a manifest, as the input ' +
      'of block-level migration (fabric-rebroadcast). The archive holds ledger values: keep it as private as the ' +
      'extraction output. Off by default; the extraction itself is unchanged',
  )
  .option(
    '--blocks-only',
    'With --save-blocks: walk, verify the hash chain and write the archive only. No state, history, metadata, ' +
      'private data or identity file is produced and --output-dir is not written (--tier is accepted and ignored)',
  )
  .option(
    '--extend',
    'Continue the completed extraction in --output-dir to the ledger heights in --manifest (re-run discover first): ' +
      'walks only the blocks above the extraction\'s height, seeded with the state it already holds, appends history, ' +
      'metadata and hashes and replaces the state files. For a final pass after the source stops taking writes. ' +
      'Interrupted, it is re-run with the same command',
  )
  .option(
    '--processes <n>',
    'Extract channels in up to <n> child processes, one channel each, into the same --output-dir, so each walk ' +
      'has a CPU core of its own (one process uses one core for parsing and hash checks whatever --concurrency is). ' +
      'Replaces --concurrency; --memory-limit is divided between them, and each has the heap NODE_OPTIONS sets',
    parseInteger,
  )
  .addOption(new Option('--identities-out <path>', 'internal: set by --processes for each child').hideHelp())
  .action(async (opts) => {
    const manifest: Manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf-8'));

    const options = toExtractOptions(opts);
    checkArchiveOptions(options);

    if (!VALID_STRATEGIES.includes(options.strategy)) {
      logger.error({ strategy: options.strategy, valid: VALID_STRATEGIES }, 'Invalid strategy');
      process.exit(1);
    }

    if (!VALID_STATE_BACKENDS.includes(options.stateBackend)) {
      logger.error(
        { stateBackend: options.stateBackend, valid: VALID_STATE_BACKENDS },
        'Invalid state backend',
      );
      process.exit(1);
    }

    if (![1, 2, 3].includes(options.tier)) {
      logger.error('Tier must be 1, 2, or 3');
      process.exit(1);
    }

    const channelsToExtract = selectChannels(manifest, options.channels);

    const { checkProcessOptions, runChannelProcesses } = await import('../../extraction/extract-processes');
    checkProcessOptions(options);
    if ((options.processes ?? 1) > 1 && channelsToExtract.length > 1) {
      // The parent only schedules: each child connects and extracts one channel.
      await runChannelProcesses(options, channelsToExtract.map((c) => c.channelId));
      logger.info('Extraction complete');
      process.exit(0);
    }

    logger.info(
      {
        tier: options.tier,
        strategy: options.strategy,
        stateBackend: options.stateBackend,
        memoryLimitMb: options.memoryLimitMb,
        stateDataDir: options.stateDataDir,
        channels: channelsToExtract.map((c) => c.channelId),
      },
      'Starting extraction',
    );

    logger.info({ strategy: options.strategy }, 'Using block-reconstruction strategy');

    // Establish gateway connection (same flow as discover)
    const { AmbEndpointResolver } = await import('../../connection/amb-endpoint-resolver');
    const { ConnectionProfileBuilder } = await import('../../connection/connection-profile-builder');
    const { WalletManager } = await import('../../connection/wallet-manager');
    const { createGateway } = await import('../../connection/gateway-factory');

    const resolver = new AmbEndpointResolver(opts.region);
    const endpoints = await resolver.resolve(opts.networkId, opts.memberId, opts.nodeId);

    const profileBuilder = new ConnectionProfileBuilder();
    const profile = profileBuilder.build(endpoints, {
      networkId: opts.networkId,
      memberId: opts.memberId,
      nodeId: opts.nodeId,
      region: opts.region,
      outputDir: opts.outputDir,
      tlsCertPath: opts.tlsCert,
      mspPath: opts.mspPath,
    });

    const walletManager = new WalletManager();
    const wallet = await walletManager.enroll(profile, {
      networkId: opts.networkId,
      memberId: opts.memberId,
      nodeId: opts.nodeId,
      region: opts.region,
      outputDir: opts.outputDir,
      tlsCertPath: opts.tlsCert,
      mspPath: opts.mspPath,
    });

    for (const [flag, val] of [
      ['--grpc-request-timeout', opts.grpcRequestTimeout],
      ['--grpc-commit-timeout', opts.grpcCommitTimeout],
      ['--grpc-connect-timeout', opts.grpcConnectTimeout],
    ] as const) {
      if (val !== undefined && (!Number.isInteger(val) || val < 0)) {
        throw new Error(`${flag} must be a non-negative integer, got: ${val}`);
      }
    }
    const timeouts: GrpcTimeouts = {
      ...(opts.grpcRequestTimeout !== undefined && { requestMs: opts.grpcRequestTimeout }),
      ...(opts.grpcCommitTimeout !== undefined && { commitMs: opts.grpcCommitTimeout }),
      ...(opts.grpcConnectTimeout !== undefined && { connectMs: opts.grpcConnectTimeout }),
    };
    const gatewayResult = await createGateway({
      mode: 'legacy',
      profile,
      wallet,
      discovery: false,
      timeouts,
    });

    try {
      if (options.blocksOnly) {
        // The archive stands alone: nothing below (state, private data, metadata) runs.
        const { BlockArchiveWriter } = await import('../../extraction/block-archive');
        const { BlockArchiveExtractor } = await import('../../extraction/strategies/block-archive-extractor');
        const archive = new BlockArchiveWriter(options.saveBlocksDir as string, {
          networkId: manifest.networkId,
          memberId: manifest.memberId,
          nodeId: options.nodeId ?? manifest.nodeId,
          mspId: wallet.identity.mspId,
          region: manifest.region,
        });
        const workers = Math.max(1, options.concurrency);
        for (let i = 0; i < channelsToExtract.length; i += workers) {
          await Promise.all(
            channelsToExtract.slice(i, i + workers).map((channel) =>
              new BlockArchiveExtractor(
                gatewayResult.gateway.getNetwork(channel.channelId),
                archive,
                { prefetchBuffer: options.prefetchBuffer },
              ).extract(channel),
            ),
          );
        }
        logger.info({ dir: options.saveBlocksDir }, 'Block archive complete');
        gatewayResult.disconnect();
        process.exit(0);
      }

      // Wire up DeliverWithPrivateData if available and supported
      let deliverPrivateData = gatewayResult.gateway.deliverPrivateData
        ? gatewayResult.gateway.deliverPrivateData.bind(gatewayResult.gateway)
        : undefined;

      if (deliverPrivateData) {
        const support = assessPrivateDataSupport(manifest);
        if (!support.supported) {
          logger.warn(
            { frameworkVersion: support.frameworkVersion },
            `Skipping DeliverWithPrivateData — ${support.reason}`,
          );
          deliverPrivateData = undefined;
        } else {
          logger.info(
            { frameworkVersion: support.frameworkVersion },
            'Private-data delivery enabled',
          );
        }
      }

      // Private-only has nothing else to produce, so a run without delivery
      // would write metadata.json and no data, and exit 0.
      if (options.privateOnly && !deliverPrivateData) {
        logger.error(
          '--private-only needs DeliverWithPrivateData, which is unavailable ' +
            'for this network (see the warning above); nothing would be extracted',
        );
        process.exit(1);
      }

      const { HybridExtractor } = await import('../../extraction/strategies/hybrid-extractor');
      const extractor = new HybridExtractor(
        options,
        manifest,
        gatewayResult.gateway,
        wallet.identity.mspId,
        deliverPrivateData,
      );
      await extractor.run(channelsToExtract);

      logger.info('Extraction complete');
    } finally {
      gatewayResult.disconnect();
    }

    process.exit(0);
  });
