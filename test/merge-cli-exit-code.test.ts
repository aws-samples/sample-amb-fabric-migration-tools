// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { MergeReport } from '../src/merge/merge-runner';
import { ExtractionError } from '../src/utils/errors';

const mockRun = jest.fn();
jest.mock('../src/merge/merge-runner', () => ({
  MergeRunner: jest.fn().mockImplementation(() => ({ run: mockRun })),
}));

import { mergeCommand } from '../src/cli/commands/merge';

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exitCode = undefined;
  jest.clearAllMocks();
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

function report(overrides: Partial<MergeReport> = {}): MergeReport {
  return {
    mergedAt: '2026-08-21T00:00:00.000Z',
    outputDir: '/out',
    members: [
      { inputDir: '/a', memberId: 'orgA', mspId: 'OrgAMSP',
        extractedAt: '2026-08-21T00:00:00.000Z' },
      { inputDir: '/b', memberId: 'orgB', mspId: 'OrgBMSP',
        extractedAt: '2026-08-21T00:00:00.000Z' },
    ],
    channels: [
      {
        channelId: 'ch1',
        ledgerHeight: 42,
        members: ['orgA', 'orgB'],
        coverage: [],
        counts: { privateState: 1, privateHistory: 1, privateHashes: 0 },
      },
    ],
    identities: 0,
    conflicts: [],
    warnings: [],
    ok: true,
    ...overrides,
  };
}

function coverageRow(overrides = {}) {
  return {
    chaincode: 'mycc',
    collection: 'col1',
    outcome: 'values' as const,
    contributedValues: ['orgA'],
    contributedHashes: [],
    byMember: [],
    needsAttention: false,
    ...overrides,
  };
}

async function runCli(): Promise<void> {
  await mergeCommand.parseAsync(
    ['--input-dirs', '/a', '/b', '--output-dir', '/out'],
    { from: 'user' },
  );
}

function loggedOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

function errorOutput(): string {
  return errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('merge CLI exit codes', () => {
  it('exits 0 and prints next steps on a clean merge', async () => {
    mockRun.mockResolvedValue(report());

    await runCli();

    expect(process.exitCode).toBeUndefined();
    expect(loggedOutput()).toContain('Members: orgA, orgB');
    expect(loggedOutput()).toContain('Next steps');
  });

  it('names the members that supplied each collection', async () => {
    mockRun.mockResolvedValue(report({
      channels: [{
        ...report().channels[0],
        coverage: [
          coverageRow({ contributedValues: ['orgA', 'orgB'] }),
          coverageRow({ collection: 'col2', contributedValues: ['orgB'] }),
        ],
      }],
    }));

    await runCli();

    expect(loggedOutput()).toContain('mycc/col1: values from orgA+orgB');
    expect(loggedOutput()).toContain('mycc/col2: values from orgB');
  });

  it('exits 1 when two members hold different values for one key', async () => {
    mockRun.mockResolvedValue(report({
      ok: false,
      conflicts: [{
        channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1',
        digests: { orgA: 'aaa', orgB: 'bbb' }, kept: 'orgA',
      }],
    }));

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(loggedOutput()).toContain('1 private key(s) differ between members');
    expect(loggedOutput()).toContain('ch1/mycc/col1/k1: orgA vs orgB (kept orgA)');
    expect(loggedOutput()).toContain('Re-extract both at the agreed height');
  });

  it('caps the conflict list and says where the rest are', async () => {
    mockRun.mockResolvedValue(report({
      ok: false,
      conflicts: Array.from({ length: 13 }, (_, i) => ({
        channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: `k${i}`,
        digests: { orgA: 'a', orgB: 'b' }, kept: 'orgA',
      })),
    }));

    await runCli();

    expect(loggedOutput()).toContain('... 3 more in merge-report.json');
    expect(loggedOutput()).not.toContain('col1/k12:');
  });

  it('exits 1 when a collection has no established cause', async () => {
    mockRun.mockResolvedValue(report({
      ok: false,
      channels: [{
        ...report().channels[0],
        coverage: [coverageRow({
          outcome: 'hashes-only', reason: 'unexplained', contributedValues: [],
          contributedHashes: ['orgA'], needsAttention: true,
        })],
      }],
    }));

    await runCli();

    expect(process.exitCode).toBe(1);
    expect(loggedOutput()).toContain(
      'mycc/col1: hashes-only (unexplained)  <-- needs attention',
    );
    expect(loggedOutput()).toContain('not accepted purge loss');
  });

  it('does not print next steps for a report that blocks sign-off', async () => {
    mockRun.mockResolvedValue(report({ ok: false }));

    await runCli();

    expect(loggedOutput()).not.toContain('Next steps');
  });

  it('exits 0 on accepted purge loss', async () => {
    mockRun.mockResolvedValue(report({
      channels: [{
        ...report().channels[0],
        coverage: [coverageRow({
          outcome: 'hashes-only', reason: 'purge-window', contributedValues: [],
          contributedHashes: ['orgA'],
        })],
      }],
    }));

    await runCli();

    expect(process.exitCode).toBeUndefined();
    expect(loggedOutput()).toContain('mycc/col1: hashes-only (purge-window)');
    expect(loggedOutput()).not.toContain('needs attention');
  });

  it('reports a refusal as a message, not a stack trace', async () => {
    mockRun.mockRejectedValue(new ExtractionError(
      'Members extracted channel ch1 at different ledger heights: 42; 99.',
    ));

    await expect(runCli()).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('merge failed: Members extracted channel');
    expect(loggedOutput()).toBe('');
  });

  it('lets an unexpected error through rather than reporting it as a refusal', async () => {
    mockRun.mockRejectedValue(new TypeError('cannot read property of undefined'));

    await expect(runCli()).rejects.toThrow(/cannot read property/);
  });

  it('prints warnings that do not block a sign-off', async () => {
    mockRun.mockResolvedValue(report({
      warnings: ['Members extracted ch1 at different tiers (2, 3).'],
    }));

    await runCli();

    expect(process.exitCode).toBeUndefined();
    expect(loggedOutput()).toContain('Warnings (1)');
    expect(loggedOutput()).toContain('different tiers');
  });
});
