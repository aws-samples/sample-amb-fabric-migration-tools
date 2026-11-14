import { Command } from 'commander';
import { REPLAY_ADAPTERS, ReplayConfig } from '../../types';
import { checkpointFileName } from '../../replay/replay-checkpoint-manager';
import type { ReplaySummary } from '../../replay/replay-orchestrator';
import { ExtractorError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import * as fs from 'fs';

const logger = createLogger('cli:replay');

export const replayCommand = new Command('replay')
  .description('Replay extracted data to a target system')
  .requiredOption('--input-dir <dir>', 'Directory containing extraction output')
  .requiredOption(
    '--adapter <adapter>',
    `Target adapter: ${REPLAY_ADAPTERS.join(', ')}. Overrides the config's `
    + '"adapter" field, which is what verify reads',
  )
  .requiredOption('--config <path>', 'Path to replay config JSON')
  .option(
    '--batch-size <size>',
    'Records per batch during replay (overrides config, default: 500)',
    (value: string) => Number.parseInt(value, 10),
  )
  .option(
    '--since <heights>',
    'Replay only what was added at or above a height: "extension" (each channel\'s most recent extract --extend) or ' +
      '<channel>=<block>,... Keys deleted in that range are deleted at the destination. For a Fabric history ' +
      'destination it needs chaincode.historyImport with a scope of its own',
  )
  .option(
    '--allow-insecure',
    'Allow plaintext gRPC (grpc://) connections for chaincode replay',
  )
  .action(async (opts) => {
    const config: ReplayConfig = JSON.parse(fs.readFileSync(opts.config, 'utf-8'));
    config.inputDir = opts.inputDir;
    config.adapter = opts.adapter;
    if (opts.since !== undefined) config.since = opts.since;
    if (opts.batchSize !== undefined) {
      if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
        throw new Error(
          `--batch-size must be a positive integer, got: ${opts.batchSize}`,
        );
      }
      config.batchSize = opts.batchSize;
    }
    if (opts.allowInsecure) {
      if (config.adapter === 'chaincode' && !config.chaincode) {
        throw new Error(
          '--allow-insecure requires a "chaincode" block in the replay config JSON',
        );
      }
      if (config.chaincode) {
        config.chaincode.allowInsecure = true;
      }
    }

    logger.info({ adapter: config.adapter, inputDir: config.inputDir }, 'Starting replay');

    const summary = await runReplay(config);
    if (!summary) return;

    console.log('\nReplay summary:\n');
    console.log(`  Records replayed: ${summary.totalReplayed}`);
    console.log(`  Records failed:   ${summary.totalFailed}`);
    if (summary.skippedChannels.length > 0) {
      console.log(
        `  Channels skipped: ${summary.skippedChannels.join(', ')} ` +
        '(no channelMapping entry)',
      );
    }
    console.log('');

    if (summary.totalFailed > 0) {
      console.log(
        `${summary.totalFailed} record(s) did not reach the destination. ` +
        `One line per failing key, with the writes abandoned after it in ` +
        `"skippedAfter": ${summary.failureReportPath}`,
      );
      if (summary.historyAborted) {
        console.log(
          `History replay stopped part-way through ${summary.historyAborted}. ` +
          'Each replayed write appends a destination history entry, so re-running ' +
          'would duplicate the entries already written.',
        );
        console.log(
          'Fix the cause, reset the destination channel, delete ' +
          `${config.inputDir}/${checkpointFileName(summary.adapter)}, and replay ` +
          'from the beginning. Re-running without a reset will be refused.\n',
        );
      } else {
        console.log(
          'The replay checkpoint has been retained — fix the cause and re-run ' +
          'the same command to retry the failed records.\n',
        );
      }
      process.exitCode = 1;
      return;
    }

    logger.info('Replay complete');
  });

/**
 * Run the replay, reporting a refusal as a message rather than a stack trace.
 *
 * Every way this command declines to run — a destination collection that would
 * reject the identity configured for it, a previous history replay left
 * part-way — ends in a sentence naming what to change. An unhandled rejection
 * would bury that sentence in a Node stack trace, which is the one place an
 * operator is least likely to read it.
 *
 * @returns The summary, or `null` when the replay refused and `exitCode` is set.
 */
async function runReplay(
  config: ReplayConfig,
): Promise<ReplaySummary | null> {
  const { ReplayOrchestrator } = await import(
    '../../replay/replay-orchestrator'
  );
  try {
    return await new ReplayOrchestrator(config).run();
  } catch (error) {
    if (error instanceof ExtractorError) {
      console.error(`\nreplay failed: ${error.message}\n`);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}
