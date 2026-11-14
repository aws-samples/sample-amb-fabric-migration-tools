import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from '../../types';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { countNdjsonLines } from '../../output/ndjson-scan';
import { formatHistoryDepth, measureHistoryDepth } from '../../output/history-depth';
import { createLogger } from '../../utils/logger';

const logger = createLogger('cli:status');

export const statusCommand = new Command('status')
  .description('Show extraction progress and statistics')
  .option('--output-dir <dir>', 'Output directory', './extraction-output')
  .action(async (opts) => {
    const layout = new FileLayoutManager(opts.outputDir);

    if (!fs.existsSync(layout.manifestPath)) {
      logger.error('No manifest.json found. Run "extract discover" first.');
      process.exit(1);
    }

    const manifest: Manifest = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf-8'));

    console.log(`\nNetwork: ${manifest.networkId}`);
    console.log(`Region:  ${manifest.region}`);
    console.log(`StateDB: ${manifest.stateDb}`);
    console.log(`Discovered: ${manifest.extractedAt}`);
    console.log(`\nChannels (${manifest.channels.length}):`);

    let deepest = 0;
    for (const channel of manifest.channels) {
      console.log(`\n  ${channel.channelId} (height: ${channel.ledgerHeight})`);

      for (const cc of channel.chaincodes) {
        console.log(`    chaincode: ${cc.name}@${cc.version} (seq ${cc.sequence})`);
        for (const coll of cc.collections) {
          const purgeRisk = coll.blockToLive > 0 ? ` ⚠ blockToLive=${coll.blockToLive}` : '';
          const origin = coll.implicit ? ' (implicit)' : '';
          console.log(`      collection: ${coll.name}${origin}${purgeRisk}`);
        }
      }

      // Check extraction files
      const channelDir = path.join(opts.outputDir, layout.channelDir(channel.channelId));
      if (fs.existsSync(channelDir)) {
        const files = fs.readdirSync(channelDir).filter((f) => f.endsWith('.ndjson'));
        for (const file of files) {
          const filePath = path.join(channelDir, file);
          if (file.endsWith('-history.ndjson')) {
            // Depth, not just count: the deepest key bounds replay duration.
            const depth = await measureHistoryDepth(filePath);
            deepest = Math.max(deepest, depth.maxVersions);
            console.log(`    ${file}: ${formatHistoryDepth(depth)}`);
          } else {
            console.log(`    ${file}: ${await countNdjsonLines(filePath)} records`);
          }
        }
      } else {
        console.log('    (not yet extracted)');
      }
    }

    if (deepest > 0) {
      console.log(
        `\nDeepest key history: ${deepest} versions. Replay submits a key's ` +
        'versions one commit at a time, so a history replay takes at least ' +
        `${deepest} × the destination's commit latency however it is tuned.`,
      );
    }

    // Check checkpoints
    const checkpointFiles: string[] = [];
    for (const channel of manifest.channels) {
      const cpDir = path.join(opts.outputDir, layout.checkpointDir(channel.channelId));
      if (fs.existsSync(cpDir)) {
        const files = fs.readdirSync(cpDir).filter((f) => f.endsWith('.json'));
        checkpointFiles.push(...files.map((f) => `${channel.channelId}/${f}`));
      }
    }

    if (checkpointFiles.length > 0) {
      console.log(`\nCheckpoints:`);
      for (const cp of checkpointFiles) {
        console.log(`  ${cp}`);
      }
    }

    console.log('');
  });
