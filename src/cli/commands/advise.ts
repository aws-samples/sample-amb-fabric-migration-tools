import { Command } from 'commander';
import * as fs from 'fs';
import { Manifest, ReplayConfig } from '../../types';

function readJson<T>(file: string | undefined): T | undefined {
  return file ? JSON.parse(fs.readFileSync(file, 'utf-8')) as T : undefined;
}

export const adviseReplayCommand = new Command('advise-replay')
  .description(
    'Recommend replay settings (concurrency, channelConcurrency, batchSize, heap) and estimate ' +
      'duration from the extraction, and flag config problems replay would refuse. Read-only; ' +
      'reports shapes and counts, never keys or values',
  )
  .requiredOption('--input-dir <dir>', 'Extraction (usually merged) directory')
  .option('--config <path>', 'Replay config to evaluate')
  .option('--commit-latency-ms <ms>', 'Destination commit latency measured on a dry run', (v) => Number.parseInt(v, 10))
  .option('--destination-writes-per-second <n>', 'Records per second the destination sustained in a dry run (all channels)', (v) => Number.parseFloat(v))
  .option('--output <format>', 'text (default) or json', 'text')
  .action(async (opts) => {
    const { adviseReplay, formatAdvice } = await import('../../advise/replay-advisor');
    const advice = await adviseReplay({
      inputDir: opts.inputDir,
      config: readJson<ReplayConfig>(opts.config),
      commitLatencyMs: opts.commitLatencyMs,
      destinationWritesPerSecond: opts.destinationWritesPerSecond,
    });
    console.log(opts.output === 'json' ? JSON.stringify(advice, null, 2) : formatAdvice(advice));
    process.exitCode = advice.findings.some((f) => f.level === 'error') ? 1 : 0;
  });

export const checkChaincodeCommand = new Command('check-chaincode')
  .description(
    'Check a chaincode source tree is ready for the migration destination: name, migration ' +
      'contract revision, writer list, registration, dependencies, collection config, CouchDB indexes. Read-only',
  )
  .requiredOption('--source <dir>', 'Chaincode package source directory')
  .requiredOption('--name <name>', 'Chaincode name as committed on the source')
  .option('--input-dir <dir>', 'Extraction directory, for the source manifest')
  .option('--config <path>', 'Replay config, for the MSPs replay submits as and collection routing')
  .option('--collections-config <files...>', 'Destination collection config file(s) (default: found in the source)')
  .option('--endorsement <kind>', 'Destination chaincode endorsement policy: or, majority or and')
  .option('--output <format>', 'text (default) or json', 'text')
  .action(async (opts) => {
    const { checkChaincode, formatChaincodeCheck } = await import('../../advise/chaincode-check');
    const manifest = opts.inputDir ? readJson<Manifest>(`${opts.inputDir}/manifest.json`) : undefined;
    const result = checkChaincode({
      sourceDir: opts.source,
      name: opts.name,
      manifest,
      config: readJson<ReplayConfig>(opts.config),
      collectionsConfig: opts.collectionsConfig,
      endorsement: opts.endorsement,
    });
    console.log(opts.output === 'json' ? JSON.stringify(result, null, 2) : formatChaincodeCheck(result));
    process.exitCode = result.findings.some((f) => f.level === 'error') ? 1 : 0;
  });
