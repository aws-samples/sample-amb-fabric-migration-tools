import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  VerifyEntry,
  VerifyOptions,
  VerifySummary,
} from '../src/verification/verify-runner';

const mockRunVerification = jest.fn();
jest.mock('../src/verification/verify-runner', () => ({
  runVerification: (...args: any[]) => mockRunVerification(...args),
}));

import { verifyCommand } from '../src/cli/commands/verify';

/** The real reason list. The module it is declared in is mocked above. */
const { SKIP_REASONS } = jest.requireActual<
  typeof import('../src/verification/verify-runner')
>('../src/verification/verify-runner');

let tmpDir: string;
let configPath: string;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cli-test-'));
  configPath = path.join(tmpDir, 'replay-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ adapter: 'chaincode', inputDir: tmpDir }),
    'utf-8',
  );
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.exitCode = undefined;
  jest.clearAllMocks();
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function summary(overrides: Partial<VerifySummary> = {}): VerifySummary {
  return {
    match: 0,
    mismatch: 0,
    missing: 0,
    error: 0,
    skip: 0,
    extra: 0,
    skipsByReason: {},
    skipTargets: {},
    ...overrides,
  };
}

/**
 * Stand in for a verification run: hand each entry to the CLI's sink, then
 * return the summary.
 *
 * The entries are pushed rather than returned because that is how the runner
 * reports them — it keeps none of them, so a CLI that waited for an array would
 * print nothing.
 */
function resolveWith(
  result: { entries?: VerifyEntry[]; summary?: VerifySummary },
): void {
  const entries = result.entries ?? [];
  const resolved = result.summary ?? summary();
  mockRunVerification.mockImplementation(
    async (_dir: string, _config: unknown, options?: VerifyOptions) => {
      for (const entry of entries) options?.onEntry?.(entry);
      return resolved;
    },
  );
}

async function runCli(extra: string[] = []): Promise<void> {
  await verifyCommand.parseAsync(
    ['--input-dir', tmpDir, '--config', configPath, ...extra],
    { from: 'user' },
  );
}

function loggedOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('verify CLI exit codes', () => {
  it('exits 2 when nothing was actually checked', async () => {
    resolveWith({ summary: summary({ skip: 12 }) });

    await runCli();

    expect(process.exitCode).toBe(2);
    expect(loggedOutput()).toContain('Nothing was verified');
    expect(loggedOutput()).toContain('12 skipped');
  });

  it('exits 2 for an empty extraction rather than reporting success', async () => {
    resolveWith({ summary: summary() });

    await runCli();

    expect(process.exitCode).toBe(2);
  });

  it('exits 0 when every checked record matched', async () => {
    resolveWith({ summary: summary({ match: 3, skip: 5 }) });

    await runCli();

    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 on a mismatch', async () => {
    resolveWith({ summary: summary({ match: 2, mismatch: 1 }) });

    await runCli();

    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on a missing key', async () => {
    resolveWith({ summary: summary({ match: 2, missing: 1 }) });

    await runCli();

    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on an extra destination key', async () => {
    resolveWith({ summary: summary({ match: 2, extra: 1 }) });

    await runCli();

    expect(process.exitCode).toBe(1);
  });

  it('reports extra keys as a failure, not as a skip', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1', chaincode: 'mycc', key: 'leftover', status: 'extra',
      }],
      summary: summary({ match: 2, extra: 1 }),
    });

    await runCli();

    const out = loggedOutput();
    expect(out).toContain('[EXTRA] leftover (mycc)');
    expect(out).toContain('1 extra');
    expect(out).toContain('not in the extraction');
  });

  it('spells out control characters in the table, so text tools still read it', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1', chaincode: 'mycc', key: '\u0000asset\u0000a1\u0000',
        status: 'mismatch', detail: 'expected "\u0001\u007f"',
      }],
      summary: summary({ mismatch: 1 }),
    });

    await runCli();

    const out = loggedOutput();
    expect(out).toContain('[MISMATCH] \\0asset\\0a1\\0 (mycc) — expected "\\x01\\x7f"');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  it('says nothing about extra keys when the sweep found none', async () => {
    resolveWith({ summary: summary({ match: 2 }) });

    await runCli();

    expect(loggedOutput()).not.toContain('extra');
  });

  it('locates a channel-wide sweep failure by channel', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1',
        chaincode: '',
        key: '',
        status: 'error',
        detail: 'destination key sweep failed: connection terminated',
      }],
      summary: summary({ match: 2, error: 1 }),
    });

    await runCli();

    expect(loggedOutput()).toContain(
      '[ERROR] ch1 — destination key sweep failed: connection terminated',
    );
  });

  it('locates a namespace-scoped sweep failure by chaincode too', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1',
        chaincode: 'mycc',
        key: '',
        status: 'error',
        detail: 'destination key sweep failed: ListKeys is not a function',
      }],
      summary: summary({ match: 2, error: 1 }),
    });

    await runCli();

    expect(loggedOutput()).toContain(
      '[ERROR] ch1/mycc — destination key sweep failed: ' +
      'ListKeys is not a function',
    );
  });

  it('exits 1 when extra keys are the only thing found', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1', chaincode: 'mycc', key: 'leftover', status: 'extra',
      }],
      summary: summary({ extra: 1, skip: 4 }),
    });

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(loggedOutput()).not.toContain('Nothing was verified');
  });

  it('names the namespaces no sweep reached', async () => {
    resolveWith({
      entries: [{
        channel: 'ch1',
        chaincode: 'mycc',
        key: '',
        status: 'skip',
        skipReason: 'no-key-listing',
        detail: 'no key listing for ch1/mycc',
      }],
      summary: summary({
        match: 2,
        skip: 1,
        skipsByReason: { 'no-key-listing': 1 },
        skipTargets: { 'no-key-listing': ['mycc'] },
      }),
    });

    await runCli();

    const out = loggedOutput();
    expect(out).toContain('1 × no-key-listing: this chaincode namespace was ' +
      'not swept');
    expect(out).toContain('affected: mycc');
  });

  it.each(SKIP_REASONS)('explains a %s skip in words', async (reason) => {
    // An unexplained reason prints as its own slug, which tells the operator
    // that something was not verified but not what or whether it can be. Every
    // reason the verifier can emit has to reach this table, and a new one
    // reaches it only if something fails when it does not.
    resolveWith({
      entries: [{
        channel: 'ch1', chaincode: 'mycc', key: '', status: 'skip',
        skipReason: reason,
      }],
      summary: summary({ match: 1, skip: 1, skipsByReason: { [reason]: 1 } }),
    });

    await runCli();

    expect(loggedOutput()).toContain(`1 × ${reason}: `);
    expect(loggedOutput()).not.toContain(`× ${reason}: ${reason}`);
  });

  it('exits 2 when only query errors occurred', async () => {
    resolveWith({ summary: summary({ match: 2, error: 1 }) });

    await runCli();

    expect(process.exitCode).toBe(2);
  });

  it('exits 2 without querying when the config file is missing', async () => {
    await verifyCommand.parseAsync(
      ['--input-dir', tmpDir, '--config', path.join(tmpDir, 'nope.json')],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(2);
    expect(mockRunVerification).not.toHaveBeenCalled();
  });

  it('passes --channels through to the verifier', async () => {
    resolveWith({ summary: summary({ match: 1 }) });

    await runCli(['--channels', 'ch1', 'ch2']);

    expect(mockRunVerification).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({ adapter: 'chaincode' }),
      expect.objectContaining({ channels: ['ch1', 'ch2'] }),
    );
  });

  it('writes one JSON object per line, ending with the summary', async () => {
    // A whole-run JSON document cannot be written by something that streams,
    // and `JSON.stringify` of every entry is a string Node refuses past 512 MiB.
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    resolveWith({
      entries: [
        { channel: 'ch1', chaincode: 'mycc', key: 'k1', status: 'match' },
        { channel: 'ch1', chaincode: 'mycc', key: 'k2', status: 'mismatch' },
      ],
      summary: summary({ match: 1, mismatch: 1 }),
    });

    await runCli(['--output', 'json']);
    const lines = writeSpy.mock.calls.map((c) => String(c[0]));
    writeSpy.mockRestore();

    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({
      channel: 'ch1', chaincode: 'mycc', key: 'k1', status: 'match',
    });
    expect(JSON.parse(lines[1]).status).toBe('mismatch');
    expect(JSON.parse(lines[2])).toEqual({
      summary: summary({ match: 1, mismatch: 1 }),
    });
  });

  it('prints no table rows when the output is json', async () => {
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    resolveWith({
      entries: [
        { channel: 'ch1', chaincode: 'mycc', key: 'k1', status: 'match' },
      ],
      summary: summary({ match: 1 }),
    });

    await runCli(['--output', 'json']);
    writeSpy.mockRestore();

    expect(loggedOutput()).toBe('');
  });
});
