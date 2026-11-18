// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Command } from 'commander';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from '../../types';
import { promptReplayConfig } from '../replay-config-prompts';

export const generateReplayConfigCommand = new Command(
  'generate-replay-config',
)
  .description(
    'Generate a replay-config.json from an extraction output directory',
  )
  .requiredOption(
    '--input-dir <dir>',
    'Directory containing extraction output (must include manifest.json)',
  )
  .option(
    '--output <path>',
    'Output path for replay-config.json (default: <input-dir>/replay-config.json)',
  )
  .action(async (opts) => {
    const manifestPath = path.join(
      opts.inputDir, 'manifest.json',
    );
    if (!fs.existsSync(manifestPath)) {
      console.error(
        `  Error: ${manifestPath} not found.` +
        ' Run discover and extract first.',
      );
      process.exit(1);
    }

    const manifest: Manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    );

    console.log('');
    console.log('  Generate Replay Configuration');
    console.log(
      `  Source: ${opts.inputDir}`,
    );
    console.log(
      `  Network: ${manifest.networkId}` +
      ` (${manifest.channels.length} channels,` +
      ` ${manifest.channels.reduce((n, ch) => n + ch.chaincodes.length, 0)} chaincodes)`,
    );

    const rl = createInterface({ input, output });
    try {
      const config = await promptReplayConfig(
        rl, opts.inputDir, manifest.region, manifest,
      );

      const outputPath = opts.output ?? path.join(
        opts.inputDir, 'replay-config.json',
      );
      fs.writeFileSync(
        outputPath,
        JSON.stringify(config, null, 2),
        'utf-8',
      );
      console.log(`\n  Config written to: ${outputPath}\n`);
    } finally {
      rl.close();
    }
  });
