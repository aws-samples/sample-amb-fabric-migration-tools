// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Command } from 'commander';
import { runValidation, formatValidationResults } from '../../validation/validation-runner';
import { createLogger } from '../../utils/logger';

const logger = createLogger('cli:validate');

export const validateCommand = new Command('validate')
  .description('Validate extraction output: check hashes, detect duplicates, verify completeness')
  .requiredOption('--input-dir <dir>', 'Directory containing extraction output')
  .option('--channels <channels...>', 'Specific channels to validate (default: all)')
  .option(
    '--other-members <dirs...>',
    'Other members\' extraction directories of the same channels. A private value or private-history block this ' +
      'member lacks but another member holds is accounted for (a member that joined a channel later never received ' +
      'earlier values); merge applies the same rule, and the merged output is still validated whole',
  )
  .action(async (opts) => {
    logger.info({ inputDir: opts.inputDir }, 'Starting validation');

    const results = await runValidation(opts.inputDir, opts.channels, { otherMembers: opts.otherMembers });

    console.log('\nValidation Results:\n');
    console.log(formatValidationResults(results));
    console.log('');

    const failures = results.filter((r) => r.status === 'fail').length;
    if (failures > 0) {
      console.log(
        'Fix validation issues and re-run before proceeding.\n',
      );
      process.exit(1);
    }

    console.log('Next steps:');
    console.log(
      `  1. Review the extraction output in ${opts.inputDir}`,
    );
    console.log(
      '  2. Generate a replay config:',
    );
    console.log(
      `     node dist/cli/index.js generate-replay-config --input-dir ${opts.inputDir}`,
    );
    console.log(
      '  3. Review and edit the generated replay-config.json',
    );
    console.log(
      '  4. Run replay:',
    );
    console.log(
      `     node dist/cli/index.js replay --input-dir ${opts.inputDir} --adapter <adapter> --config <config.json>`,
    );
    console.log('');
  });
