// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REPLAY_ADAPTERS } from '../src/types';
import type { ReplayAdapter, ReplayConfig } from '../src/types';
import type { ReplaySummary } from '../src/replay/replay-orchestrator';
import { ReplayError } from '../src/utils/errors';

const mockRun = jest.fn();
jest.mock('../src/replay/replay-orchestrator', () => ({
  ReplayOrchestrator: jest.fn().mockImplementation(() => ({ run: mockRun })),
}));

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';
import { replayCommand } from '../src/cli/commands/replay';

let tmpDir: string;
let configPath: string;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cli-test-'));
  configPath = path.join(tmpDir, 'replay-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      adapter: 'chaincode',
      chaincode: {
        connectionProfilePath: 'p.json',
        mspId: 'Org1MSP',
        certPath: 'c.pem',
        keyPath: 'k.pem',
      },
    }),
    'utf-8',
  );
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
  jest.clearAllMocks();
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function summary(overrides: Partial<ReplaySummary> = {}): ReplaySummary {
  return {
    adapter: 'chaincode',
    totalReplayed: 0,
    totalFailed: 0,
    failures: [],
    skippedChannels: [],
    ...overrides,
  };
}

async function runCli(
  extra: string[] = [],
  adapter: ReplayAdapter = 'chaincode',
): Promise<void> {
  await replayCommand.parseAsync(
    [
      '--input-dir', tmpDir,
      '--adapter', adapter,
      '--config', configPath,
      ...extra,
    ],
    { from: 'user' },
  );
}

function loggedOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('replay CLI exit codes', () => {
  it('exits 1 when records did not reach the destination', async () => {
    mockRun.mockResolvedValue(summary({
      totalReplayed: 9,
      totalFailed: 3,
      // One failing key, plus the two later writes to it that were abandoned —
      // so a single report line accounts for all three failed records.
      failures: [{
        channel: 'ch1', chaincode: 'mycc', key: 'k1', mspId: 'Org1MSP',
        error: 'rejected', skippedAfter: 2,
      }],
      failureReportPath: path.join(tmpDir, 'replay-failures.ndjson'),
    }));

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(loggedOutput()).toContain('3 record(s) did not reach the destination');
    expect(loggedOutput()).toContain('replay-failures.ndjson');
    expect(loggedOutput()).toContain('skippedAfter');
    expect(loggedOutput()).toContain('checkpoint has been retained');
  });

  it('exits 0 on a clean run', async () => {
    mockRun.mockResolvedValue(summary({ totalReplayed: 12 }));

    await runCli();

    expect(process.exitCode).toBeUndefined();
  });

  it('names channels that were skipped for want of a mapping', async () => {
    mockRun.mockResolvedValue(summary({
      totalReplayed: 4,
      skippedChannels: ['ch7', 'ch8'],
    }));

    await runCli();

    expect(loggedOutput()).toContain('Channels skipped: ch7, ch8');
    expect(loggedOutput()).toContain('no channelMapping entry');
  });

  it('rejects a batch size of 0 rather than replaying nothing', async () => {
    await expect(runCli(['--batch-size', '0'])).rejects.toThrow(
      /--batch-size must be a positive integer, got: 0/,
    );
    expect(mockRun).not.toHaveBeenCalled();
  });
});

/**
 * `verify` has no `--adapter` flag and reads the config's field, so which of
 * the two wins here decides whether a mismatch sends the two commands to
 * different destinations.
 */
describe('replay CLI adapter selection', () => {
  function replayedAdapter(): ReplayConfig['adapter'] {
    const config = (ReplayOrchestrator as unknown as jest.Mock)
      .mock.calls[0][0] as ReplayConfig;
    return config.adapter;
  }

  // The config written in beforeEach says `chaincode`, so every case but one
  // is also a case of the flag overriding it.
  it.each([...REPLAY_ADAPTERS])(
    'replays to %s when the flag names it, whatever the config says',
    async (adapter) => {
      mockRun.mockResolvedValue(summary({ adapter }));

      await runCli([], adapter);

      expect(replayedAdapter()).toBe(adapter);
    },
  );

  /**
   * The `--adapter` help text is built from `REPLAY_ADAPTERS`, so it cannot
   * name fewer adapters than the code dispatches — provided the list stays a
   * closed union. Widen it to `string[]` and both that guarantee and every
   * `case` check go, leaving a runtime `Unsupported adapter` as the only guard.
   */
  it('keeps the adapter list closed', () => {
    // @ts-expect-error — a name outside the list must not type-check
    const typo: ReplayAdapter = 'mongodb';

    expect(REPLAY_ADAPTERS).not.toContain(typo);
    expect([...REPLAY_ADAPTERS]).toEqual(
      ['postgresql', 'dynamodb', 'chaincode'],
    );
  });
});

// ── Refusals ──

/**
 * A refusal's whole value is the sentence saying what to change. An unhandled
 * rejection would print it under a Node stack trace, which is the one place an
 * operator is least likely to read it.
 */
describe('replay CLI refusals', () => {
  const refusal =
    '1 destination collection(s) would reject every write from the identity ' +
    'configured for them';

  it('reports a refusal as a message and exits 1', async () => {
    mockRun.mockRejectedValue(new ReplayError(refusal));

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n'))
      .toContain(refusal);
  });

  it('prints no replay summary when the run never started', async () => {
    mockRun.mockRejectedValue(new ReplayError(refusal));

    await runCli();

    expect(loggedOutput()).toBe('');
  });

  /**
   * Only the errors this tool raises deliberately are turned into a message; a
   * programming error still surfaces with its stack, because a message alone
   * would hide where it came from.
   */
  it('lets an unexpected error propagate with its stack', async () => {
    mockRun.mockRejectedValue(new TypeError('cannot read x of undefined'));

    await expect(runCli()).rejects.toThrow(/cannot read x of undefined/);
    expect(process.exitCode).toBeUndefined();
  });
});
