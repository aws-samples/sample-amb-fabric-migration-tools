#!/usr/bin/env node

import { Command } from 'commander';
import { discoverCommand } from './commands/discover';
import { extractCommand } from './commands/extract';
import { replayCommand } from './commands/replay';
import { statusCommand } from './commands/status';
import { mergeCommand } from './commands/merge';
import { validateCommand } from './commands/validate';
import { captureFixturesCommand } from './commands/capture-fixtures';
import { migrateCommand } from './commands/migrate';
import { generateReplayConfigCommand } from './commands/generate-replay-config';
import { verifyCommand } from './commands/verify';
import { fingerprintDestinationCommand } from './commands/fingerprint-destination';
import { adviseReplayCommand, checkChaincodeCommand } from './commands/advise';
import { ExtractorError } from '../utils/errors';

// Extraction output holds ledger values, including private plaintext, and
// configs can hold connection strings. Everything this CLI creates is
// owner-only; a stricter umask the operator already set is kept.
process.umask(process.umask() | 0o077);

const program = new Command();

program
  .name('amb-migrate')
  .description('Migrate Hyperledger Fabric data off Amazon Managed Blockchain')
  .version('0.1.0');

program.addCommand(discoverCommand);
program.addCommand(extractCommand);
program.addCommand(replayCommand);
program.addCommand(statusCommand);
program.addCommand(mergeCommand);
program.addCommand(validateCommand);
program.addCommand(captureFixturesCommand);
program.addCommand(migrateCommand);
program.addCommand(generateReplayConfigCommand);
program.addCommand(verifyCommand);
program.addCommand(fingerprintDestinationCommand);
program.addCommand(adviseReplayCommand);
program.addCommand(checkChaincodeCommand);

/**
 * Report a command's refusal as the sentence it was written as.
 *
 * Every command's action is async, so an unhandled rejection is all Node has to
 * work with and it prints a stack trace. The tool's refusals say what an operator
 * has to change — a chaincode whose collection config cannot be read, a channel
 * whose orgs cannot be resolved — and a stack trace is the one place that is
 * least likely to be read. Anything that is not a deliberate refusal is a bug in
 * the tool and keeps its stack trace.
 *
 * @param error Whatever the command rejected with.
 * @throws The original error when it is not an `ExtractorError`.
 */
export function reportCliFailure(error: unknown): void {
  if (!(error instanceof ExtractorError)) throw error;

  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  program.parseAsync(process.argv).catch(reportCliFailure);
}
