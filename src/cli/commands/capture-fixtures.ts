import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { createLogger } from '../../utils/logger';

const logger = createLogger('cli:capture-fixtures');

export const captureFixturesCommand = new Command('capture-fixtures')
  .description(
    'Capture raw blocks from a live Fabric peer for use as offline test fixtures. ' +
      'Saves raw bytes (protobuf/JSON) and decoded JSON (when possible) per block. ' +
      'Has no credential flags: the identity comes from $MSP_PATH, or from ' +
      '$CA_ENROLLMENT_SECRET via CA enrollment, and the TLS CA certificate from ' +
      '$TLS_CA_CERT or ~/managedblockchain-tls-chain.pem.',
  )
  .requiredOption('--network-id <id>', 'AMB Network ID')
  .requiredOption('--member-id <id>', 'AMB Member ID')
  .requiredOption('--node-id <id>', 'AMB Node ID')
  .requiredOption('--channel <channel>', 'Channel to capture blocks from')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .option('--start-block <n>', 'First block to capture (default: 0)', '0')
  .option('--end-block <n>', 'Last block to capture (default: ledger height - 1)')
  .option('--max-blocks <n>', 'Maximum number of blocks to capture', '50')
  .option('--output-dir <dir>', 'Output directory for fixtures', './test/fixtures')
  .option('--fabric-mode <mode>', 'Fabric SDK mode: auto, gateway, legacy', 'auto')
  .action(async (opts) => {
    const channelId: string = opts.channel;
    const startBlock = parseInt(opts.startBlock, 10);
    const maxBlocks = parseInt(opts.maxBlocks, 10);
    const outputDir = path.resolve(opts.outputDir, channelId);

    fs.mkdirSync(outputDir, { recursive: true });

    logger.info(
      { networkId: opts.networkId, channel: channelId, outputDir },
      'Capturing block fixtures from live AMB peer',
    );

    // Connect to Fabric peer — same flow as discover command
    const { AmbEndpointResolver } = await import('../../connection/amb-endpoint-resolver');
    const { ConnectionProfileBuilder } = await import(
      '../../connection/connection-profile-builder'
    );
    const { WalletManager } = await import('../../connection/wallet-manager');
    const { createGateway, detectAndValidateVersion } = await import(
      '../../connection/gateway-factory'
    );

    const resolver = new AmbEndpointResolver(opts.region);
    const endpoints = await resolver.resolve(opts.networkId, opts.memberId, opts.nodeId);

    const profileBuilder = new ConnectionProfileBuilder();
    const profile = profileBuilder.build(endpoints, {
      networkId: opts.networkId,
      memberId: opts.memberId,
      nodeId: opts.nodeId,
      region: opts.region,
      outputDir: opts.outputDir,
    });

    const walletManager = new WalletManager();
    const wallet = await walletManager.enroll(profile, {
      networkId: opts.networkId,
      memberId: opts.memberId,
      nodeId: opts.nodeId,
      region: opts.region,
      outputDir: opts.outputDir,
    });

    const factoryConfig = {
      mode: (opts.fabricMode ?? 'auto') as 'auto' | 'gateway' | 'legacy',
      profile,
      wallet,
    };

    /*
     * Probe the version before the first capture call, not after.
     *
     * In `auto` mode `createGateway` returns gateway mode optimistically: the
     * gRPC connection to a 1.2/1.4 peer succeeds, and the UNIMPLEMENTED that
     * peer answers with only surfaces on the first evaluate. Its own comment
     * says the fallback is `detectAndValidateVersion`'s job. Without this call
     * the first capture request below is what fails, so the one command whose
     * purpose is capturing 1.2/1.4 bytes was the one command that could not
     * reach a 1.2/1.4 peer. `--channel` is required here, so unlike `discover`
     * there is nothing to wait for.
     */
    let gatewayResult = await createGateway(factoryConfig);
    const validated = await detectAndValidateVersion(gatewayResult, channelId, factoryConfig);
    gatewayResult = validated.result;
    const { versionInfo } = validated;

    logger.info(
      { sdkMode: gatewayResult.mode, majorVersion: versionInfo.majorVersion },
      'Fabric version detected — capturing through this SDK mode',
    );

    try {
      // Read through the validated result: a reconnect disconnected the first
      // gateway, so the pre-probe handle is dead.
      const network = gatewayResult.gateway.getNetwork(channelId);
      const qscc = network.getContract('qscc');

      // 1. Capture chain info
      logger.info('Fetching chain info...');
      const chainInfoBytes = await qscc.evaluateTransaction('GetChainInfo', channelId);
      const chainInfoRawPath = path.join(outputDir, 'chain-info.raw');
      fs.writeFileSync(chainInfoRawPath, Buffer.from(chainInfoBytes));

      // Try JSON decode
      let ledgerHeight: number;
      try {
        const chainInfoJson = JSON.parse(Buffer.from(chainInfoBytes).toString('utf-8'));
        fs.writeFileSync(
          path.join(outputDir, 'chain-info.json'),
          JSON.stringify(chainInfoJson, null, 2),
          'utf-8',
        );
        ledgerHeight = Number(chainInfoJson.height?.low ?? chainInfoJson.height ?? 0);
      } catch {
        logger.warn('Chain info is protobuf-encoded — saved raw bytes only');
        // Estimate: user must provide --end-block
        ledgerHeight = opts.endBlock ? parseInt(opts.endBlock, 10) + 1 : startBlock + maxBlocks;
      }

      const endBlock = opts.endBlock
        ? Math.min(parseInt(opts.endBlock, 10), ledgerHeight - 1)
        : Math.min(startBlock + maxBlocks - 1, ledgerHeight - 1);

      const totalBlocks = endBlock - startBlock + 1;
      logger.info(
        { ledgerHeight, startBlock, endBlock, totalBlocks },
        'Capturing blocks',
      );

      // 2. Capture blocks
      const blocksDir = path.join(outputDir, 'blocks');
      fs.mkdirSync(blocksDir, { recursive: true });

      const manifest: Array<{
        blockNumber: number;
        rawFile: string;
        jsonFile: string | null;
        rawSizeBytes: number;
        isProtobuf: boolean;
      }> = [];

      for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
        const blockBytes = await qscc.evaluateTransaction(
          'GetBlockByNumber',
          channelId,
          blockNum.toString(),
        );
        const rawBuf = Buffer.from(blockBytes);
        const paddedNum = blockNum.toString().padStart(6, '0');

        // Save raw bytes (this is the ground truth — protobuf or JSON)
        const rawFile = `block-${paddedNum}.raw`;
        fs.writeFileSync(path.join(blocksDir, rawFile), rawBuf);

        // Try to decode as JSON for inspection
        let jsonFile: string | null = null;
        let isProtobuf = false;
        try {
          const blockJson = JSON.parse(rawBuf.toString('utf-8'));
          jsonFile = `block-${paddedNum}.json`;
          fs.writeFileSync(
            path.join(blocksDir, jsonFile),
            JSON.stringify(blockJson, null, 2),
            'utf-8',
          );
        } catch {
          isProtobuf = true;
        }

        manifest.push({
          blockNumber: blockNum,
          rawFile,
          jsonFile,
          rawSizeBytes: rawBuf.length,
          isProtobuf,
        });

        if (blockNum % 10 === 0 || blockNum === endBlock) {
          logger.info(
            { blockNumber: blockNum, progress: `${blockNum - startBlock + 1}/${totalBlocks}` },
            'Block captured',
          );
        }
      }

      // 3. Also try to capture chaincode definitions via _lifecycle
      try {
        const lifecycle = network.getContract('_lifecycle');
        const ccBytes = await lifecycle.evaluateTransaction('QueryChaincodeDefinitions', '');
        fs.writeFileSync(path.join(outputDir, 'chaincode-definitions.raw'), Buffer.from(ccBytes));
        try {
          const ccJson = JSON.parse(Buffer.from(ccBytes).toString('utf-8'));
          fs.writeFileSync(
            path.join(outputDir, 'chaincode-definitions.json'),
            JSON.stringify(ccJson, null, 2),
            'utf-8',
          );
        } catch (err) {
          logger.info(
            { error: (err as Error).message },
            'Chaincode definitions are protobuf-encoded — saved raw bytes',
          );
        }
      } catch (err) {
        logger.warn({ error: (err as Error).message }, 'Could not query chaincode definitions');
      }

      // 4. Write fixture manifest
      const fixtureManifest = {
        capturedAt: new Date().toISOString(),
        networkId: opts.networkId,
        memberId: opts.memberId,
        channel: channelId,
        region: opts.region,
        // A fixture set is only evidence about a Fabric version if it says which
        // one produced it. Recorded from the probe above, not from a flag.
        fabricVersion: versionInfo.majorVersion,
        applicationCapability: versionInfo.applicationCapability,
        sdkMode: gatewayResult.mode,
        ledgerHeight,
        startBlock,
        endBlock,
        totalBlocks,
        stateDb: endpoints.stateDb,
        protobufBlocks: manifest.filter((b) => b.isProtobuf).length,
        jsonBlocks: manifest.filter((b) => !b.isProtobuf).length,
        blocks: manifest,
      };

      fs.writeFileSync(
        path.join(outputDir, 'fixture-manifest.json'),
        JSON.stringify(fixtureManifest, null, 2),
        'utf-8',
      );

      const protobufCount = manifest.filter((b) => b.isProtobuf).length;
      logger.info(
        {
          totalBlocks,
          jsonBlocks: totalBlocks - protobufCount,
          protobufBlocks: protobufCount,
          outputDir,
        },
        'Fixture capture complete',
      );

      if (protobufCount > 0) {
        console.log(
          `\n⚠  ${protobufCount}/${totalBlocks} blocks are protobuf-encoded (not JSON).\n` +
            '   This confirms the production decode path needs @hyperledger/fabric-protos.\n' +
            '   The .raw files are the ground truth for testing the protobuf decoder.\n',
        );
      }

      console.log(`\nFixtures saved to: ${outputDir}/`);
      console.log(`  chain-info.raw      — raw GetChainInfo response`);
      console.log(`  blocks/             — ${totalBlocks} blocks (.raw + .json when decodable)`);
      console.log(`  fixture-manifest.json — capture metadata\n`);
      console.log('To use in tests, load blocks from the .raw files and feed them');
      console.log('through BlockWalker.decodeBlock() → BlockParser.parseBlock().\n');
    } finally {
      gatewayResult.disconnect();
    }
  });
