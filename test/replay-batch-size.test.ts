// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { PublicStateRecord } from '../src/types';

// Mock pg so PostgresqlAdapter can initialize without a real DB
jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
  return {
    Pool: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';
import { PostgresqlAdapter } from '../src/replay/adapters/postgresql-adapter';

describe('ReplayOrchestrator batchSize', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(channels: string[]): void {
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        channels: channels.map((c) => ({
          channelId: c,
          ledgerHeight: 10,
          chaincodes: [],
        })),
      }),
      'utf-8',
    );
  }

  function writeRecords(
    relPath: string,
    records: PublicStateRecord[],
  ): void {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(
      fullPath,
      records.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );
  }

  it('flushes at custom batchSize threshold', async () => {
    writeManifest(['ch1']);
    const layout = new FileLayoutManager(tmpDir);

    const records: PublicStateRecord[] = Array.from(
      { length: 5 },
      (_, i) => ({
        _type: 'public_state' as const,
        channel: 'ch1',
        chaincode: 'mycc',
        key: `k${i}`,
        value: `v${i}`,
      }),
    );
    writeRecords(layout.publicStatePath('ch1'), records);

    const batchSizes: number[] = [];
    jest
      .spyOn(PostgresqlAdapter.prototype, 'replayBatch')
      .mockImplementation(async function (batch) {
        batchSizes.push(batch.length);
      });

    const orchestrator = new ReplayOrchestrator({
      adapter: 'postgresql',
      inputDir: tmpDir,
      batchSize: 2,
      postgresql: { connectionString: 'postgresql://localhost/db' },
    });

    await orchestrator.run();

    // 5 records with batchSize=2: batches of [2, 2, 1]
    expect(batchSizes).toEqual([2, 2, 1]);
  });

  it('uses default batch size (500) when not configured', async () => {
    writeManifest(['ch1']);
    const layout = new FileLayoutManager(tmpDir);

    // Write 3 records — fewer than default 500, so single batch
    const records: PublicStateRecord[] = Array.from(
      { length: 3 },
      (_, i) => ({
        _type: 'public_state' as const,
        channel: 'ch1',
        chaincode: 'mycc',
        key: `k${i}`,
        value: `v${i}`,
      }),
    );
    writeRecords(layout.publicStatePath('ch1'), records);

    const batchSizes: number[] = [];
    jest
      .spyOn(PostgresqlAdapter.prototype, 'replayBatch')
      .mockImplementation(async function (batch) {
        batchSizes.push(batch.length);
      });

    const orchestrator = new ReplayOrchestrator({
      adapter: 'postgresql',
      inputDir: tmpDir,
      postgresql: { connectionString: 'postgresql://localhost/db' },
    });

    await orchestrator.run();

    // All 3 records in a single batch (< 500 default)
    expect(batchSizes).toEqual([3]);
  });
});
