// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { spawn } from 'child_process';
import { ExtractOptions } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { identityPartPath, writeIdentityRegistry } from './identity-parts';
import { ExtractionError, ExtractorError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('extract-processes');

/**
 * Refuse `--processes` where children would share a file.
 *
 * Every per-channel output already has its own path; these are the options
 * that write something directory-wide.
 *
 * @throws ExtractorError naming the conflict.
 */
export function checkProcessOptions(options: ExtractOptions): void {
  const n = options.processes;
  if (n === undefined) return;
  if (!Number.isInteger(n) || n < 1) {
    throw new ExtractorError(`--processes must be a positive integer, got ${n}`, 'EXTRACTION_ERROR');
  }
  if (n === 1) return;
  if (options.extend) {
    throw new ExtractorError(
      '--processes cannot be combined with --extend yet: an extension commits every channel in one journaled step. ' +
        'Extend in one process; the blocks above the earlier height are a small part of the walk.',
      'EXTRACTION_ERROR',
    );
  }
  if (options.concurrency > 1) {
    throw new ExtractorError(
      '--processes replaces --concurrency: each child extracts one channel. Give one of them, not both.',
      'EXTRACTION_ERROR',
    );
  }
}

/**
 * The argument list for one child: the parent's own `extract` arguments, with
 * `--processes`, `--channels` and `--memory-limit` replaced.
 *
 * @param argv The parent's `process.argv`.
 * @param channelId The one channel this child extracts.
 * @param memoryLimitMb This child's share of `--memory-limit`.
 * @param identitiesOut The child's identity part, relative to the output directory.
 * @returns Arguments to pass after the CLI script.
 */
export function childArgs(argv: string[], channelId: string, memoryLimitMb: number, identitiesOut: string): string[] {
  const at = argv.indexOf('extract', 2);
  if (at < 0) throw new ExtractionError('--processes: cannot find the extract command in the process arguments');
  const rest = argv.slice(at + 1);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] = a.split('=', 2);
    if (flag === '--processes' || flag === '--memory-limit' || flag === '--identities-out') {
      if (inline === undefined) i++;
      continue;
    }
    if (flag === '--channels') {
      if (inline === undefined) while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return [
    ...argv.slice(2, at + 1), ...out,
    '--channels', channelId, '--memory-limit', String(memoryLimitMb), '--identities-out', identitiesOut,
  ];
}

/**
 * Extract each channel in a child process of its own, at most `processes` at
 * a time, then write `identities.ndjson` once from the children's parts.
 *
 * A child that fails leaves its channel's checkpoint, so re-running the same
 * command resumes it; the others are already complete and walk nothing.
 *
 * @throws ExtractionError naming every channel whose child failed.
 */
export async function runChannelProcesses(
  options: ExtractOptions,
  channelIds: string[],
  argv: string[] = process.argv,
): Promise<void> {
  const layout = new FileLayoutManager(options.outputDir);
  const workers = Math.min(options.processes ?? 1, channelIds.length);
  const share = Math.max(1, Math.floor(options.memoryLimitMb / workers));
  logger.info(
    { processes: workers, channels: channelIds, perProcessMemoryLimitMb: share },
    'Extracting one channel per process. Each process has its own V8 heap: the host needs room for ' +
      `${workers} heap ceilings (NODE_OPTIONS --max-old-space-size) at once`,
  );

  const queue = [...channelIds];
  const failed: string[] = [];
  const runOne = (channelId: string): Promise<void> =>
    new Promise((resolve) => {
      const args = childArgs(argv, channelId, share, identityPartPath(layout, channelId));
      const child = spawn(process.execPath, [...process.execArgv, argv[1], ...args], { stdio: 'inherit', env: process.env });
      child.on('exit', (code, signal) => {
        if (code !== 0) {
          failed.push(channelId);
          logger.error({ channelId, code, signal }, 'Channel process failed');
        } else {
          logger.info({ channelId }, 'Channel process complete');
        }
        resolve();
      });
    });
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) await runOne(queue.shift()!);
    }),
  );

  if (failed.length > 0) {
    throw new ExtractionError(
      `Extraction failed for ${failed.length} channel(s): ${failed.join(', ')}. Re-run the same command: ` +
        'completed channels are skipped and failed ones are extracted again. identities.ndjson is ' +
        'written only once every channel has succeeded.',
    );
  }
  // Every child committed its channel and its identity part: rebuild the registry from the parts of every
  // completed channel in the directory.
  const identities = writeIdentityRegistry(options.outputDir, layout.identitiesPath);
  logger.info({ identities }, 'Wrote identity registry from the completed channels');
}
