// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ReplayConfig,
  PublicStateRecord,
  PublicHistoryRecord,
  PrivateStateRecord,
} from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { encodeLedgerValue } from '../src/utils/value-codec';

// ── Mocks ──

jest.mock('../src/connection/fabric-gateway');

const mockPgQuery = jest.fn();
const mockPgSweep = jest.fn();

/**
 * The reverse sweep's channel-wide row listing, told apart from a value lookup
 * by the columns it asks for.
 *
 * Routed to its own mock because the two queries want different answers: one
 * blanket `mockResolvedValue` would hand the sweep rows shaped like a value,
 * and every test in this file would grow a spurious extra key.
 */
function isSweepQuery(sql: string): boolean {
  return sql.includes('SELECT chaincode, key');
}

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: (sql: string, ...rest: any[]) => (
      isSweepQuery(sql) ? mockPgSweep(sql, ...rest) : mockPgQuery(sql, ...rest)
    ),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(function (this: any) {
    this.send = (...args: any[]) => mockDynamoSend(...args);
    this.destroy = jest.fn();
  }),
}));

/** The reverse sweep's scan. Separate for the same reason as {@link mockPgSweep}. */
const mockDynamoScan = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation(() => ({
      send: (cmd: any) => (
        cmd?._tag === 'Scan' ? mockDynamoScan(cmd) : mockDynamoSend(cmd)
      ),
    })),
  },
  GetCommand: jest.fn().mockImplementation((input: any) => ({
    input,
    _tag: 'Get',
  })),
  QueryCommand: jest.fn().mockImplementation((input: any) => ({
    input,
    _tag: 'Query',
  })),
  ScanCommand: jest.fn().mockImplementation((input: any) => ({
    input,
    _tag: 'Scan',
  })),
}));

import { FabricGateway } from '../src/connection/fabric-gateway';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DYNAMODB_MAX_ATTEMPTS } from '../src/replay/adapters/dynamodb-adapter';
import {
  VerifyEntry,
  VerifySummary,
  runVerification as runVerifier,
} from '../src/verification/verify-runner';

const MockGetCommand = GetCommand as jest.MockedClass<typeof GetCommand>;
const MockQueryCommand = QueryCommand as jest.MockedClass<typeof QueryCommand>;

/**
 * The verifier with its entries collected, which is what these tests assert on.
 *
 * The runner itself keeps none of them — one entry per source key on every
 * channel is the ledger's size, not a summary's — so anything that wants them
 * all asks for them. A test suite is the one caller that can afford to.
 */
async function runVerification(
  inputDir: string,
  config: ReplayConfig,
  channels?: string[],
  redactValues?: boolean,
): Promise<{ entries: VerifyEntry[]; summary: VerifySummary }> {
  const entries: VerifyEntry[] = [];
  const summary = await runVerifier(inputDir, config, {
    channels,
    redactValues,
    onEntry: (entry) => entries.push(entry),
  });
  return { entries, summary };
}

// ── Fixtures ──

/**
 * U+0000, the only separator Fabric composite keys use. Written as a code
 * point so this source file stays free of control characters.
 */
const NUL = String.fromCharCode(0);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
  jest.clearAllMocks();
  // An empty destination, so the sweep reports nothing unless a test says
  // otherwise. Set here rather than at module scope to survive a mock reset.
  mockPgSweep.mockResolvedValue({ rows: [] });
  mockDynamoScan.mockResolvedValue({ Items: [] });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(
  dir: string,
  channels: string[],
  stateDb: 'CouchDB' | 'LevelDB' = 'CouchDB',
): void {
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb,
      extractedAt: new Date().toISOString(),
      channels: channels.map((c) => ({
        channelId: c,
        ledgerHeight: 10,
        chaincodes: [],
      })),
    }),
    'utf-8',
  );
}

/**
 * Manifest with chaincodes, so read-function coverage and the reverse key sweep
 * both have something to work on. `writeManifest` names none, which is what
 * keeps the sweep out of the tests that are about something else.
 */
function writeManifestWithChaincodes(
  chaincodes: Array<{
    name: string;
    collections?: Array<{ name: string }>;
  }>,
): void {
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb: 'CouchDB',
      extractedAt: new Date().toISOString(),
      channels: [{
        channelId: 'ch1',
        ledgerHeight: 10,
        chaincodes: chaincodes.map((cc) => ({
          name: cc.name,
          version: '1.0',
          sequence: 1,
          collections: cc.collections ?? [],
        })),
      }],
    }),
    'utf-8',
  );
}

function writeRecords(dir: string, relPath: string, records: any[]): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(
    fullPath,
    records.map((r) => JSON.stringify(r)).join('\n'),
    'utf-8',
  );
}

function mockGateway(evaluateFn: jest.Mock): void {
  const mockContract = { evaluateTransaction: evaluateFn };
  const mockNetwork = { getContract: jest.fn(() => mockContract) };
  const MockGateway = FabricGateway as jest.MockedClass<typeof FabricGateway>;
  MockGateway.prototype.connect = jest.fn().mockResolvedValue(undefined);
  MockGateway.prototype.getGatewayNetwork = jest.fn()
    .mockReturnValue(mockNetwork) as any;
  MockGateway.prototype.disconnect = jest.fn();
}

function makeChaincodeConfig(
  overrides?: Partial<ReplayConfig['chaincode']>,
): ReplayConfig {
  return {
    adapter: 'chaincode',
    inputDir: tmpDir,
    chaincode: {
      connectionProfilePath: '/fake/profile.json',
      mspId: 'Org1MSP',
      certPath: '/fake/cert.pem',
      keyPath: '/fake/key.pem',
      channel: 'ch1',
      keyMapping: { ch1: { mycc: 'PutState' } },
      concurrency: 1,
      // Named contract, so these are the application's own read functions and
      // their result is compared as raw bytes. The migration contract's own
      // functions base64-encode instead — see the base64 block below.
      readFunctions: { ch1: { mycc: 'SampleAssets:ReadAsset' } },
      privateReadFunctions: { ch1: { mycc: 'SampleAssets:ReadPrivateData' } },
      ...overrides,
    },
  };
}

function makePgConfig(): ReplayConfig {
  return {
    adapter: 'postgresql',
    inputDir: tmpDir,
    postgresql: {
      connectionString: 'postgresql://localhost/test',
    },
  };
}

function makeDynamoConfig(
  overrides?: Partial<ReplayConfig['dynamodb']>,
): ReplayConfig {
  return {
    adapter: 'dynamodb',
    inputDir: tmpDir,
    dynamodb: {
      region: 'us-east-1',
      stateTable: 'fabric-state',
      ...overrides,
    },
  };
}

function publicRecord(
  key: string,
  value: string,
  chaincode = 'mycc',
): PublicStateRecord {
  return {
    _type: 'public_state',
    channel: 'ch1',
    chaincode,
    key,
    value,
  };
}

function privateRecord(
  key: string,
  value: string,
  collection = 'col1',
): PrivateStateRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode: 'mycc',
    collection,
    key,
    value,
  };
}

// ── Chaincode verification ──

describe('verify-runner — chaincode', () => {
  test('matching public state returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from('{"id":"asset1","owner":"alice"}'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.match).toBe(1);
    expect(result.summary.mismatch).toBe(0);
    expect(evaluate).toHaveBeenCalledWith('ReadAsset', 'asset1');
  });

  test('differing values returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from('{"id":"asset1","owner":"bob"}'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(result.entries[0].status).toBe('mismatch');
    expect(result.entries[0].detail).toContain('alice');
  });

  /** Output an assistant reads must not carry ledger values. */
  test('redactValues replaces value excerpts, and the next run quotes them again', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);
    mockGateway(jest.fn().mockResolvedValue(Buffer.from('{"id":"asset1","owner":"bob"}')));

    const redacted = await runVerification(tmpDir, makeChaincodeConfig(), undefined, true);
    const plain = await runVerification(tmpDir, makeChaincodeConfig());

    expect(redacted.entries[0].status).toBe('mismatch');
    expect(redacted.entries[0].key).toBe('asset1');
    expect(redacted.entries[0].detail).not.toMatch(/alice|bob/);
    expect(redacted.entries[0].detail).toMatch(/expected <redacted sha256:[0-9a-f]{12} \d+ chars>, got <redacted/);
    expect(plain.entries[0].detail).toContain('alice');
  });

  test('"does not exist" error returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1"}'),
    ]);

    const evaluate = jest.fn().mockRejectedValue(
      new Error('asset asset1 does not exist'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.missing).toBe(1);
    expect(result.entries[0].status).toBe('missing');
  });

  test('composite keys are skipped', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('color~id\0blue\0asset1', '\x00'),
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.skip).toBe(1);
    expect(result.entries[0].detail).toBe('composite key');
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('JSON normalization: key order differences still match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"owner":"alice","id":"asset1"}'),
    ]);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from('{"id":"asset1","owner":"alice"}'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.match).toBe(1);
  });

  test('strips merged migrationMeta overlay before comparing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    // Destination has migrationMeta merged in by embedSourceMetadata replay.
    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(
        '{"id":"asset1","owner":"alice","migrationMeta":{"blockNumber":5,"txId":"tx1","timestamp":"2025-01-01T00:00:00Z","isDelete":false}}',
      ),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.match).toBe(1);
    expect(result.summary.mismatch).toBe(0);
  });

  test('unwraps envelope migrationMeta overlay before comparing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    // Destination has envelope-wrapped value (non-object fallback path
    // shouldn't hit for objects, but verify still handles it to keep
    // older replays comparable).
    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(
        '{"migrationMeta":{"blockNumber":5,"txId":"tx1","timestamp":"2025-01-01T00:00:00Z","isDelete":false},"value":"{\\"id\\":\\"asset1\\",\\"owner\\":\\"alice\\"}"}',
      ),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.match).toBe(1);
    expect(result.summary.mismatch).toBe(0);
  });

  test('chaincodes not in mapping are skipped', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', 'v1', 'unknowncc'),
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.skip).toBe(1);
    expect(result.entries[0].detail).toContain('no read function');
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('private state comparison works', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir,
      layout.privateStatePath('ch1', 'mycc', 'orgPrivateData'),
      [privateRecord('appraisal_1', '{"assetId":"1","appraisedValue":100}', 'orgPrivateData')],
    );

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from('{"assetId":"1","appraisedValue":100}'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith(
      'ReadPrivateData', 'orgPrivateData', 'appraisal_1',
    );
  });

  test('private state without read function mapping is skipped', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('k1', 'v1'),
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(
      tmpDir,
      makeChaincodeConfig({ privateReadFunctions: undefined }),
    );

    expect(result.summary.skip).toBe(1);
    expect(result.entries[0].detail).toContain('no private read function');
  });

  test('channelMapping routes to correct destination channel', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['source-ch']);
    writeRecords(tmpDir, layout.publicStatePath('source-ch'), [
      { ...publicRecord('k1', '"hello"'), channel: 'source-ch' },
    ]);

    const evaluate = jest.fn().mockResolvedValue(Buffer.from('"hello"'));
    mockGateway(evaluate);

    const MockGateway = FabricGateway as jest.MockedClass<typeof FabricGateway>;

    await runVerification(
      tmpDir,
      makeChaincodeConfig({
        channel: undefined,
        channelMapping: { 'source-ch': 'dest-ch' },
      }),
    );

    expect(MockGateway.prototype.getGatewayNetwork)
      .toHaveBeenCalledWith('dest-ch');
  });

  test('throws when chaincode config is missing', async () => {
    writeManifest(tmpDir, ['ch1']);

    const config: ReplayConfig = {
      adapter: 'chaincode',
      inputDir: tmpDir,
    };

    await expect(runVerification(tmpDir, config))
      .rejects.toThrow('chaincode adapter config');
  });

  test('throws when readFunctions is missing', async () => {
    writeManifest(tmpDir, ['ch1']);

    await expect(
      runVerification(tmpDir, makeChaincodeConfig({ readFunctions: undefined })),
    ).rejects.toThrow('readFunctions');
  });

  /**
   * A map whose channels are all empty names no function, so it must be rejected
   * for the same reason an absent map is: verify would otherwise connect, skip
   * every record, and report a clean run over nothing.
   */
  test('throws when readFunctions names no function on any channel', async () => {
    writeManifest(tmpDir, ['ch1']);

    await expect(
      runVerification(tmpDir, makeChaincodeConfig({ readFunctions: { ch1: {} } })),
    ).rejects.toThrow('at least one channel-and-chaincode-to-function mapping');
  });

  /**
   * Row 2.9. Verify reads back through the routing replay wrote through, so the
   * same merge is the same mistake here: one destination for two channels means
   * half the keys read back as mismatches against the other channel's data.
   */
  test('refuses a single channel when two channels are being verified', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);

    await expect(
      runVerification(tmpDir, makeChaincodeConfig({ channel: 'dest-ch' })),
    ).rejects.toThrow(/sends every source channel to "dest-ch"/);
  });

  /**
   * S8's other half. An unmapped channel used to resolve to its own source name
   * — a channel that need not exist at the destination — so the run reported an
   * error per record and blamed a destination the config never named.
   */
  test('refuses a channel channelMapping has no destination for', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);

    await expect(
      runVerification(tmpDir, makeChaincodeConfig({
        channel: undefined,
        channelMapping: { 'orders-ch': 'dest-orders' },
      })),
    ).rejects.toThrow(/no entry for: trades-ch/);
  });

  test('does not connect to the destination when a channel is unrouted', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    const evaluate = jest.fn();
    mockGateway(evaluate);
    const MockGateway = FabricGateway as jest.MockedClass<typeof FabricGateway>;

    await expect(
      runVerification(tmpDir, makeChaincodeConfig({
        channel: undefined,
        channelMapping: { 'orders-ch': 'dest-orders' },
      })),
    ).rejects.toThrow();

    expect(MockGateway.prototype.connect).not.toHaveBeenCalled();
  });

  /** Narrowing the run is the remedy the refusal names, so it has to work. */
  test('verifies one channel of two when --channels narrows the run', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    writeRecords(tmpDir, layout.publicStatePath('orders-ch'), [
      { ...publicRecord('k1', '"hello"'), channel: 'orders-ch' },
    ]);

    const evaluate = jest.fn().mockResolvedValue(Buffer.from('"hello"'));
    mockGateway(evaluate);
    const MockGateway = FabricGateway as jest.MockedClass<typeof FabricGateway>;

    const result = await runVerification(
      tmpDir,
      makeChaincodeConfig({
        channel: 'dest-ch',
        readFunctions: { 'orders-ch': { mycc: 'SampleAssets:ReadAsset' } },
        privateReadFunctions: undefined,
      }),
      ['orders-ch'],
    );

    expect(result.summary.match).toBe(1);
    expect(MockGateway.prototype.getGatewayNetwork)
      .toHaveBeenCalledWith('dest-ch');
  });
});

// ── Per-channel read functions ──
//
// An eight-channel migration runs one application across eight channels,
// so a chaincode name identifies a deployment only alongside its channel. Keyed
// by the chaincode alone, two deployments share one entry and verify reads both
// through whichever function was written last.

describe('verify-runner — per-channel read functions', () => {
  /** Two channels carrying one chaincode name, as a multi-channel migration can. */
  function twoChannelConfig(
    overrides?: Partial<ReplayConfig['chaincode']>,
  ): ReplayConfig {
    return makeChaincodeConfig({
      channel: undefined,
      channelMapping: { 'orders-ch': 'orders-ch', 'trades-ch': 'trades-ch' },
      readFunctions: {
        'orders-ch': { marketplace: 'SampleAssets:ReadOrder' },
        'trades-ch': { marketplace: 'SampleAssets:ReadTrade' },
      },
      privateReadFunctions: undefined,
      ...overrides,
    });
  }

  /** One public record, on a channel of its own. */
  function writePublic(channel: string, key: string, value: string): void {
    const layout = new FileLayoutManager(tmpDir);
    writeRecords(tmpDir, layout.publicStatePath(channel), [
      { ...publicRecord(key, value, 'marketplace'), channel },
    ]);
  }

  test('one chaincode name reads through each channel\'s own function', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    writePublic('orders-ch', 'k1', '"v1"');
    writePublic('trades-ch', 'k2', '"v2"');

    const evaluate = jest.fn(async (_fn: string, key: string) =>
      Buffer.from(key === 'k1' ? '"v1"' : '"v2"'),
    );
    mockGateway(evaluate as jest.Mock);

    const result = await runVerification(tmpDir, twoChannelConfig());

    expect(result.summary.match).toBe(2);
    expect(evaluate.mock.calls.map((c) => c.join(' ')).sort())
      .toEqual(['ReadOrder k1', 'ReadTrade k2']);
  });

  test('a function mapped on another channel does not apply', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    writePublic('trades-ch', 'k1', '"v1"');

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, twoChannelConfig({
      readFunctions: { 'orders-ch': { marketplace: 'SampleAssets:ReadOrder' } },
    }));

    expect(result.summary.skip).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
  });

  /**
   * The skip has to name the channel: with eight channels mapped, "no read
   * function for marketplace" does not say which entry is missing.
   */
  test('an unmapped skip names the channel and the chaincode', async () => {
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    writePublic('trades-ch', 'k1', '"v1"');
    mockGateway(jest.fn());

    const result = await runVerification(tmpDir, twoChannelConfig({
      readFunctions: { 'orders-ch': { marketplace: 'SampleAssets:ReadOrder' } },
    }));

    expect(result.entries[0].detail)
      .toBe('no read function for trades-ch/marketplace');
  });

  test('private read functions are per channel too', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    for (const channel of ['orders-ch', 'trades-ch']) {
      writeRecords(
        tmpDir,
        layout.privateStatePath(channel, 'marketplace', 'col1'),
        [{ ...privateRecord('pk1', '"pv1"'), channel, chaincode: 'marketplace' }],
      );
    }

    const evaluate = jest.fn().mockResolvedValue(Buffer.from('"pv1"'));
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, twoChannelConfig({
      privateReadFunctions: {
        'orders-ch': { marketplace: 'SampleAssets:ReadOrderPrivate' },
        'trades-ch': { marketplace: 'SampleAssets:ReadTradePrivate' },
      },
    }));

    expect(result.summary.match).toBe(2);
    expect(evaluate.mock.calls.map((c) => c[0]).sort())
      .toEqual(['ReadOrderPrivate', 'ReadTradePrivate']);
  });

  test('history read functions are per channel too', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['orders-ch', 'trades-ch']);
    for (const channel of ['orders-ch', 'trades-ch']) {
      writeRecords(tmpDir, layout.publicHistoryPath(channel), [{
        _type: 'public_history', channel, chaincode: 'marketplace',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '2025-01-01T00:00:00Z', isDelete: false, creator,
      }]);
    }

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([{ value: '"v1"' }])),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, twoChannelConfig({
      historyReadFunctions: {
        'orders-ch': { marketplace: 'SampleAssets:GetOrderHistory' },
        'trades-ch': { marketplace: 'SampleAssets:GetTradeHistory' },
      },
    }));

    expect(result.summary.match).toBe(2);
    expect(evaluate.mock.calls.map((c) => c[0]).sort())
      .toEqual(['GetOrderHistory', 'GetTradeHistory']);
  });
});

// ── History ordering verification ──

const creator = {
  mspId: 'Org1MSP',
  commonName: 'admin',
  org: 'org1',
  certFingerprint: 'sha256:abc',
};

function historyConfig(
  overrides?: Partial<ReplayConfig['chaincode']>,
): ReplayConfig {
  return makeChaincodeConfig({
    historyReadFunctions: { ch1: { mycc: 'SampleAssets:GetKeyHistory' } },
    ...overrides,
  });
}

describe('verify-runner — history ordering', () => {
  test('matching value sequence returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    const records: PublicHistoryRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '2025-01-01T00:00:00Z',
        isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v2"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '2025-01-02T00:00:00Z',
        isDelete: false, creator,
      },
    ];
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), records);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([
        { value: '"v2"' },
        { value: '"v1"' },
      ])),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0].status).toBe('match');
    expect(evaluate).toHaveBeenCalledWith('GetKeyHistory', 'k1');
  });

  test('mismatched history length returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    const records: PublicHistoryRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v2"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ];
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), records);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([{ value: '"v1"' }])),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries[0].status).toBe('mismatch');
    expect(historyEntries[0].detail).toContain('history length');
  });

  test('CouchDB newest-first history is reversed before comparison', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    const records: PublicHistoryRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"first"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"second"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ];
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), records);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([
        { value: '"second"' },
        { value: '"first"' },
      ])),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries[0].status).toBe('match');
  });

  test('LevelDB oldest-first history compared directly', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1'], 'LevelDB');

    const records: PublicHistoryRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"first"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"second"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ];
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), records);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([
        { value: '"second"' },
        { value: '"first"' },
      ])),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries[0].status).toBe('mismatch');
    expect(historyEntries[0].detail).toContain('history[0]');
  });

  test('destinationStateDb overrides manifest stateDb', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1'], 'LevelDB');

    const records: PublicHistoryRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"first"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"second"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ];
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), records);

    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify([
        { value: '"second"' },
        { value: '"first"' },
      ])),
    );
    mockGateway(evaluate);

    const result = await runVerification(
      tmpDir,
      historyConfig({ destinationStateDb: 'CouchDB' }),
    );

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries[0].status).toBe('match');
  });

  test('state-only verification does not query history without replayHistory', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.entries.filter((e) => e.key === 'k1')).toHaveLength(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('replayHistory requires historyReadFunctions', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([{ name: 'mycc' }]);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);
    mockGateway(jest.fn());

    await expect(runVerification(
      tmpDir,
      makeChaincodeConfig({ replayHistory: true }),
    )).rejects.toThrow(/missing historyReadFunctions/);
  });

  test('"not found" returns missing for history key', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);

    const evaluate = jest.fn().mockRejectedValue(
      new Error('key k1 not found'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter((e) => e.key === 'k1');
    expect(historyEntries[0].status).toBe('missing');
  });

  test('composite keys are skipped in history verify', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'color\0blue', value: '"v"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const historyEntries = result.entries.filter(
      (e) => e.detail === 'composite key',
    );
    expect(historyEntries.length).toBeGreaterThanOrEqual(1);
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('unmapped chaincode skips history verification', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1',
        chaincode: 'othercc', key: 'k1', value: '"v1"',
        txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '', isDelete: false, creator,
      },
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('skip');
    expect(entry?.detail).toContain('no history read function');
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('generic error returns error status for history key', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);

    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1',
        chaincode: 'mycc', key: 'k1', value: '"v1"',
        txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '', isDelete: false, creator,
      },
    ]);

    const evaluate = jest.fn().mockRejectedValue(
      new Error('network timeout'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, historyConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('error');
    expect(entry?.detail).toContain('network timeout');
  });
});

// ── Migration contract read path ──
//
// The migration contract returns every value base64-encoded, because the Node
// and Java shims re-encode a returned String as UTF-8 and would replace any
// byte that is not valid UTF-8 with U+FFFD. Verify has to decode before
// comparing, or a correctly replayed binary value reports as a mismatch and the
// report blames the destination ledger.

describe('verify-runner — migration contract read path', () => {
  /** The default config: unqualified names resolve to the migration contract. */
  function migrationConfig(
    overrides?: Partial<ReplayConfig['chaincode']>,
  ): ReplayConfig {
    return makeChaincodeConfig({
      readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
      privateReadFunctions: { ch1: { mycc: 'ReadPrivateData' } },
      historyReadFunctions: { ch1: { mycc: 'GetKeyHistory' } },
      ...overrides,
    });
  }

  /** What the contract returns for `bytes`. */
  function returns(bytes: Buffer | string): jest.Mock {
    return jest.fn().mockResolvedValue(
      Buffer.from(Buffer.from(bytes).toString('base64'), 'utf-8'),
    );
  }

  test('decodes a base64 public value before comparing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    const evaluate = returns('{"id":"asset1","owner":"alice"}');
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith('ReadState', 'asset1');
  });

  test('matches a value that is not valid UTF-8', async () => {
    // The reason the encoding exists. Compared as text this value would be two
    // U+FFFD on both sides and match by accident; compared as raw bytes the
    // base64 payload would never equal it.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      { ...publicRecord('bin1', ''), ...encodeLedgerValue(raw) },
    ]);

    mockGateway(returns(raw));

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.summary.match).toBe(1);
  });

  test('reports a mismatch on the decoded bytes, not the base64', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"owner":"alice"}'),
    ]);

    mockGateway(returns('{"owner":"bob"}'));

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(result.entries[0].detail).toContain('alice');
    expect(result.entries[0].detail).toContain('bob');
  });

  test('still strips the migrationMeta overlay after decoding', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1"}'),
    ]);

    mockGateway(returns(
      '{"id":"asset1","migrationMeta":{"blockNumber":5,"txId":"tx1"}}',
    ));

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.summary.match).toBe(1);
  });

  test('decodes a base64 private value', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '{"appraisedValue":100}'),
    ]);

    const evaluate = returns('{"appraisedValue":100}');
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith('ReadPrivateData', 'col1', 'pk1');
  });

  test('decodes each base64 value in a history sequence', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v2"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ]);

    // CouchDB, so the contract's newest-first order is reversed first.
    mockGateway(jest.fn().mockResolvedValue(Buffer.from(JSON.stringify([
      { value: Buffer.from('"v2"').toString('base64') },
      { value: Buffer.from('"v1"').toString('base64') },
    ]))));

    const result = await runVerification(tmpDir, migrationConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('match');
  });

  test('reports a history mismatch on decoded bytes', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);

    mockGateway(jest.fn().mockResolvedValue(Buffer.from(JSON.stringify([
      { value: Buffer.from('"wrong"').toString('base64') },
    ]))));

    const result = await runVerification(tmpDir, migrationConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
    expect(entry?.detail).toContain('wrong');
  });

  test('names the qualified-name fix when a result is not base64', async () => {
    // The likely cause is an unqualified read function that is really the
    // application's own. Decoding leniently would turn that misconfiguration
    // into a mismatch report pointing at the destination ledger.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"owner":"alice"}'),
    ]);

    mockGateway(jest.fn().mockResolvedValue(
      Buffer.from('{"owner":"alice"}'),
    ));

    const result = await runVerification(tmpDir, migrationConfig());

    expect(result.entries[0].status).toBe('error');
    expect(result.entries[0].detail).toContain('not base64');
    expect(result.entries[0].detail).toContain('YourContract:YourFunction');
  });
});

// ── History grouped by offset ──
//
// Row 3.6. A key's versions are scattered through the history file while a
// comparison needs them together, and the map that used to group them held every
// value — the file itself, in heap. The index now holds where each version is,
// so these cover what an index of offsets has to get right that a map of values
// got for free: which key a version belongs to, what order they come back in,
// and a line too long to read in one go.

describe('verify-runner — history grouped by offset', () => {
  function historyRecord(
    key: string,
    value: string,
    blockNumber: number,
  ): PublicHistoryRecord {
    return {
      _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
      key, value, txId: `tx${blockNumber}`, txIndex: 0,
      blockNumber, timestamp: '', isDelete: false, creator,
    };
  }

  /**
   * A destination that answers each key with the versions given for it.
   *
   * Versions are given oldest-first, the order the history file holds them in,
   * and handed back newest-first because the manifest says CouchDB and that is
   * the order a CouchDB destination answers in.
   */
  function destinationHistory(byKey: Record<string, string[]>): jest.Mock {
    return jest.fn().mockImplementation(async (_fn: string, key: string) =>
      Buffer.from(JSON.stringify(
        [...byKey[key]].reverse().map((value) => ({ value })),
      )),
    );
  }

  test('interleaved keys each keep their own versions, in file order', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    // Neither key's versions are contiguous, so grouping cannot come from the
    // file's shape — only from the key each offset was recorded under.
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      historyRecord('k1', '"a1"', 1),
      historyRecord('k2', '"b1"', 2),
      historyRecord('k1', '"a2"', 3),
      historyRecord('k2', '"b2"', 4),
      historyRecord('k1', '"a3"', 5),
    ]);
    mockGateway(destinationHistory({
      k1: ['"a1"', '"a2"', '"a3"'],
      k2: ['"b1"', '"b2"'],
    }));

    const result = await runVerification(tmpDir, historyConfig());

    expect(
      result.entries.filter((e) => e.status === 'match').map((e) => e.key).sort(),
    ).toEqual(['k1', 'k2']);
  });

  test('a version order the destination does not share is a mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      historyRecord('k1', '"a1"', 1),
      historyRecord('k1', '"a2"', 2),
    ]);
    mockGateway(destinationHistory({ k1: ['"a2"', '"a1"'] }));

    const result = await runVerification(tmpDir, historyConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
    expect(entry?.detail).toContain('history[0]');
  });

  test('a value longer than one read is read back whole', async () => {
    // Bigger than both the stream's chunks and the line reader's buffer, so the
    // line is joined from several reads on each side of the index.
    const long = JSON.stringify('x'.repeat(200_000));
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      historyRecord('k1', long, 1),
      historyRecord('k1', '"short"', 2),
    ]);
    mockGateway(destinationHistory({ k1: [long, '"short"'] }));

    const result = await runVerification(tmpDir, historyConfig());

    expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
  });

  test('a value read back by offset keeps its encoding', async () => {
    // A history value that is not valid UTF-8 is stored base64 with a marker,
    // and the marker is on the same line as the value. Everything the
    // comparison needs has to come off the re-read line — a value read back
    // without its encoding is compared as the base64 text it was stored as.
    const bytes = Buffer.from([0xff, 0x00, 0x10]);
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        ...historyRecord('k1', bytes.toString('base64'), 1),
        valueEncoding: 'base64',
      },
    ]);
    // The migration contract base64-encodes what it returns, so both sides are
    // base64 here and only the source side needs decoding by marker.
    mockGateway(destinationHistory({ k1: [bytes.toString('base64')] }));

    const result = await runVerification(tmpDir, makeChaincodeConfig({
      readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
      historyReadFunctions: { ch1: { mycc: 'MigrationContract:GetKeyHistory' } },
    }));

    expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
  });

  test('a history file rewritten mid-run fails instead of comparing', async () => {
    // Reading by offset means the file has to still be the file that was
    // indexed. Truncating it under an open descriptor is what an extraction
    // writing to the same directory would do, and comparing a destination
    // against a source that moved is not a result anyone can act on.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    const historyPath = path.join(tmpDir, layout.publicHistoryPath('ch1'));
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      historyRecord('k1', '"a1"', 1),
      historyRecord('k2', '"b1"', 2),
    ]);

    mockGateway(jest.fn().mockImplementation(async () => {
      fs.writeFileSync(historyPath, '', 'utf-8');
      return Buffer.from(JSON.stringify([{ value: '"a1"' }]));
    }));

    await expect(runVerification(tmpDir, historyConfig()))
      .rejects.toThrow(/changed while verify was reading it/);
  });
});

// ── Private data read back by hash ──
//
// Row 2.12. Verify connects exactly one identity, and a merged multi-member
// extraction holds collections that identity is not a member of. The value read
// fails for every key in them, and each one used to be reported missing — a loss
// report over data that is present and correct. A private-data hash is public
// channel state, so it answers where the value cannot.

describe('verify-runner — private data read back by hash', () => {
  const VALUE = '{"appraisedValue":100}';

  /** Private reads on the migration contract, which is what arms the fallback. */
  function hashConfig(
    overrides?: Partial<ReplayConfig['chaincode']>,
  ): ReplayConfig {
    return makeChaincodeConfig({
      readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
      privateReadFunctions: {
        ch1: { mycc: 'MigrationContract:ReadPrivateData' },
      },
      ...overrides,
    });
  }

  /** One extracted private key, in the collection the tests cannot read. */
  function writePrivateKey(value = VALUE): void {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', value),
    ]);
  }

  /** A value's SHA-256, in both forms the two sides carry it in. */
  function digest(value: Buffer | string): { payload: Buffer; hex: string } {
    const bytes = crypto.createHash('sha256')
      .update(typeof value === 'string' ? Buffer.from(value, 'utf-8') : value)
      .digest();
    return {
      payload: Buffer.from(bytes.toString('base64'), 'utf-8'),
      hex: bytes.toString('hex'),
    };
  }

  /**
   * A destination that refuses the value read and answers the hash read.
   *
   * @param valueError What the peer says when the value is not readable.
   * @param hash The base64 payload ReadPrivateDataHash returns, or what it
   *   throws instead.
   */
  function nonMemberGateway(
    valueError: string,
    hash: Buffer | Error,
  ): jest.Mock {
    const evaluate = jest.fn(async (fn: string) => {
      if (fn !== 'ReadPrivateDataHash') throw new Error(valueError);
      if (hash instanceof Error) throw hash;
      return hash;
    });
    mockGateway(evaluate);
    return evaluate;
  }

  test('matches a key whose value it cannot read but whose hash agrees', async () => {
    writePrivateKey();
    const evaluate = nonMemberGateway(
      'private data col1/pk1 does not exist', digest(VALUE).payload,
    );

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary).toMatchObject({ match: 1, missing: 0 });
    expect(evaluate).toHaveBeenCalledWith('ReadPrivateDataHash', 'col1', 'pk1');
  });

  test('says the value was unreadable, and by which MSP', async () => {
    // A match reached by hash is weaker evidence than one reached by value, and
    // the reader's next question is whether that identity was the right one to
    // verify with. A bare "match" would not raise the question at all.
    writePrivateKey();
    nonMemberGateway('private data col1/pk1 does not exist', digest(VALUE).payload);

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.entries[0].detail).toContain('not readable by Org1MSP');
    expect(result.entries[0].detail).toContain('SHA-256 matches');
  });

  test('reports a mismatch carrying both hashes', async () => {
    // Neither hash is derivable from the report without the other: the operator
    // cannot see the destination's value, so the two hex strings are the whole
    // evidence that this key is the one that differs.
    writePrivateKey();
    nonMemberGateway(
      'private data col1/pk1 does not exist', digest('{"appraisedValue":1}').payload,
    );

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(result.entries[0].detail).toContain(digest(VALUE).hex);
    expect(result.entries[0].detail)
      .toContain(digest('{"appraisedValue":1}').hex);
  });

  test('hashes the decoded bytes of a value that is not UTF-8', async () => {
    // The reason private values carry an encoding. Hashing the record's stored
    // form would hash base64 text, which is not what any destination holds, so
    // every binary private value in an unreadable collection would report a
    // mismatch — and the hex in the report would match nothing on either side.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      { ...privateRecord('pk1', ''), ...encodeLedgerValue(raw) },
    ]);

    nonMemberGateway(
      'private data col1/pk1 does not exist', digest(raw).payload,
    );

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary).toMatchObject({ match: 1, mismatch: 0 });
  });

  test('falls back when the collection policy refuses the client', async () => {
    // The other way a non-member fails. With memberOnlyRead set the peer errors
    // instead of returning nothing, so the value read reports error rather than
    // missing — the same question, answered by the same evidence.
    writePrivateKey();
    nonMemberGateway(
      'GET_STATE failed: tx creator does not have read access permission on ' +
      'privatedata in chaincodeName:mycc collectionName:col1',
      digest(VALUE).payload,
    );

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary).toMatchObject({ match: 1, error: 0 });
  });

  test('keeps the missing report when the hash cannot be read either', async () => {
    // A destination packaged before this function existed. The reason the key
    // was in question stays the headline, so an absent key and a contract that
    // cannot answer for it do not read the same.
    writePrivateKey();
    nonMemberGateway(
      'private data col1/pk1 does not exist',
      new Error('Function ReadPrivateDataHash not found in MigrationContract'),
    );

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary.missing).toBe(1);
    expect(result.entries[0].detail).toContain(
      'ReadPrivateDataHash: Function ReadPrivateDataHash not found',
    );
  });

  test('does not fall back through the application\'s own read function', async () => {
    // ReadPrivateDataHash belongs to the migration contract. Called on a
    // customer's contract it is a function that contract never declared, and
    // the error coming back would replace the real reason the key was missing.
    writePrivateKey();
    const evaluate = nonMemberGateway(
      'private data col1/pk1 does not exist', digest(VALUE).payload,
    );

    const result = await runVerification(tmpDir, hashConfig({
      privateReadFunctions: { ch1: { mycc: 'SampleAssets:ReadPrivateData' } },
    }));

    expect(result.summary.missing).toBe(1);
    expect(evaluate).not.toHaveBeenCalledWith(
      'ReadPrivateDataHash', 'col1', 'pk1',
    );
  });

  test('does not retry a value that was read and differed', async () => {
    // The hash is computed from the bytes that just compared unequal, so it
    // would differ too. Asking again would spend a round trip per mismatched
    // key to reach the conclusion already in hand.
    writePrivateKey();
    const evaluate = jest.fn(async (fn: string) => {
      if (fn === 'ReadPrivateDataHash') throw new Error('should not be reached');
      return Buffer.from(
        Buffer.from('{"appraisedValue":1}').toString('base64'), 'utf-8',
      );
    });
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, hashConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(evaluate).not.toHaveBeenCalledWith(
      'ReadPrivateDataHash', 'col1', 'pk1',
    );
  });
});

// ── Private data read back through collectionMapping ──
//
// Row 2.17. Replay writes a mapped collection under the destination's name, so
// verify has to read it back from there: reading the source name would report
// every mapped key missing from a destination that holds it, and the report
// would name a collection the destination never saw.

describe('verify-runner — mapped collections', () => {
  const VALUE = '{"appraisedValue":100}';

  /** Private reads on the migration contract, so the hash fallback is armed. */
  function mappedConfig(
    collectionMapping: Record<string, string>,
  ): ReplayConfig {
    return makeChaincodeConfig({
      privateReadFunctions: {
        ch1: { mycc: 'MigrationContract:ReadPrivateData' },
      },
      collectionMapping,
    });
  }

  /** One extracted private key, in the collection the mapping renames. */
  function writePrivateKey(): void {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', VALUE),
    ]);
  }

  test('reads the destination collection, not the source', async () => {
    writePrivateKey();
    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(Buffer.from(VALUE).toString('base64'), 'utf-8'),
    );
    mockGateway(evaluate);

    const result = await runVerification(
      tmpDir, mappedConfig({ col1: 'renamed' }),
    );

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith('ReadPrivateData', 'renamed', 'pk1');
  });

  /** Verify derives the same routing replay wrote through. */
  test('reads an implicit collection back through mspMapping', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.privateStatePath('ch1', 'mycc', '_implicit_org_m-SRC'),
      [{ ...privateRecord('pk1', VALUE), collection: '_implicit_org_m-SRC' }],
    );
    const evaluate = jest.fn().mockResolvedValue(
      Buffer.from(Buffer.from(VALUE).toString('base64'), 'utf-8'),
    );
    mockGateway(evaluate);

    const result = await runVerification(tmpDir, makeChaincodeConfig({
      privateReadFunctions: { ch1: { mycc: 'MigrationContract:ReadPrivateData' } },
      mspMapping: { 'm-SRC': 'Org2MSP' },
    }));

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith(
      'ReadPrivateData', '_implicit_org_Org2MSP', 'pk1',
    );
  });

  test('hashes the destination collection when the value is unreadable', async () => {
    writePrivateKey();
    const digest = crypto.createHash('sha256').update(VALUE).digest();
    const evaluate = jest.fn(async (fn: string) => {
      if (fn !== 'ReadPrivateDataHash') {
        throw new Error('private data renamed/pk1 does not exist');
      }
      return Buffer.from(digest.toString('base64'), 'utf-8');
    });
    mockGateway(evaluate);

    const result = await runVerification(
      tmpDir, mappedConfig({ col1: 'renamed' }),
    );

    expect(result.summary.match).toBe(1);
    expect(evaluate).toHaveBeenCalledWith(
      'ReadPrivateDataHash', 'renamed', 'pk1',
    );
  });

  /**
   * A `missing` reported against the source name reads as data loss. The likelier
   * cause is the mapping, and the operator cannot tell which without being told
   * where the read was actually addressed.
   */
  test('says which collection a failed read was addressed to', async () => {
    writePrivateKey();
    mockGateway(jest.fn(async () => {
      throw new Error('private data renamed/pk1 does not exist');
    }));

    const result = await runVerification(
      tmpDir, mappedConfig({ col1: 'renamed' }),
    );

    expect(result.summary.missing).toBe(1);
    expect(result.entries[0].collection).toBe('col1');
    expect(result.entries[0].detail).toContain('read from renamed');
  });

  /**
   * The annotation is a prefix, not a replacement. Where the read went is the
   * smaller half of the report: losing why it failed to say it would trade one
   * diagnosis for another.
   */
  test('keeps the reason a read failed alongside the collection', async () => {
    writePrivateKey();
    mockGateway(jest.fn(async (fn: string) => {
      throw new Error(
        fn === 'ReadPrivateDataHash'
          ? 'no such function ReadPrivateDataHash'
          : 'endorsement failure: access denied',
      );
    }));

    const result = await runVerification(
      tmpDir, mappedConfig({ col1: 'renamed' }),
    );

    expect(result.entries[0].status).toBe('error');
    expect(result.entries[0].detail).toContain('read from renamed');
    expect(result.entries[0].detail).toContain('endorsement failure');
  });

  /** Nothing to say when the mapping changes the name to itself. */
  test('says nothing about a collection the mapping leaves alone', async () => {
    writePrivateKey();
    mockGateway(jest.fn(async () => {
      throw new Error('private data col1/pk1 does not exist');
    }));

    const result = await runVerification(tmpDir, mappedConfig({ col1: 'col1' }));

    expect(result.summary.missing).toBe(1);
    expect(result.entries[0].detail).not.toContain('read from');
  });
});

// ── Private history, which nothing can read back ──

describe('verify-runner — private history', () => {
  function privateHistoryRecord(collection: string, key: string): any {
    return {
      _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
      collection, key, value: '"v1"', txId: 'tx1', txIndex: 0,
      blockNumber: 1, timestamp: '', isDelete: false, creator,
    };
  }

  /** History verification on, which is the tier the private gap belongs to. */
  function historyConfig(): ReplayConfig {
    return makeChaincodeConfig({
      readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
      historyReadFunctions: { ch1: { mycc: 'GetKeyHistory' } },
    });
  }

  test('reports one skip per collection whose history was replayed', async () => {
    // Fabric has no private-data history API, so this is not a gap a config
    // setting closes. Replaying it and then saying nothing reads as verified,
    // which is the one outcome a verifier must not produce.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateHistoryPath('ch1', 'mycc', 'col1'), [
      privateHistoryRecord('col1', 'pk1'),
      privateHistoryRecord('col1', 'pk2'),
    ]);
    writeRecords(tmpDir, layout.privateHistoryPath('ch1', 'mycc', 'col2'), [
      privateHistoryRecord('col2', 'pk3'),
    ]);
    mockGateway(jest.fn());

    const result = await runVerification(tmpDir, historyConfig());

    // Per collection, not per key: the reason is a property of the destination
    // platform, so one notice per key would be the same sentence three times.
    expect(result.summary.skipsByReason).toEqual({
      'no-private-history-api': 2,
    });
    expect(result.entries.map((e) => e.collection)).toEqual(['col1', 'col2']);
  });

  test('names the collection it could not read back, and no key', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateHistoryPath('ch1', 'mycc', 'col1'), [
      privateHistoryRecord('col1', 'pk1'),
    ]);
    mockGateway(jest.fn());

    const result = await runVerification(tmpDir, historyConfig());

    expect(result.entries[0]).toMatchObject({
      channel: 'ch1',
      chaincode: 'mycc',
      collection: 'col1',
      key: '',
      status: 'skip',
      skipReason: 'no-private-history-api',
    });
    expect(result.entries[0].detail).toContain('mycc/col1');
  });

  test('says nothing about a collection whose history was not replayed', async () => {
    // Private state without private history is the default extraction. A skip
    // there would report a gap the run does not have.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '"v1"'),
    ]);
    mockGateway(jest.fn().mockResolvedValue(Buffer.from(
      Buffer.from('"v1"').toString('base64'), 'utf-8',
    )));

    const result = await runVerification(tmpDir, makeChaincodeConfig({
      readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
      privateReadFunctions: {
        ch1: { mycc: 'MigrationContract:ReadPrivateData' },
      },
      historyReadFunctions: { ch1: { mycc: 'GetKeyHistory' } },
    }));

    expect(result.summary).toMatchObject({ match: 1, skip: 0 });
  });
});

// ── PostgreSQL verification ──

describe('verify-runner — postgresql', () => {
  test('matching public state returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '{"id": "asset1", "owner": "alice"}' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.match).toBe(1);
    expect(result.summary.mismatch).toBe(0);
  });

  test('differing value returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '{"id": "asset1", "owner": "bob"}' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(result.entries[0].detail).toContain('alice');
  });

  test('no row returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1"}'),
    ]);

    mockPgQuery.mockResolvedValue({ rows: [] });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.missing).toBe(1);
  });

  test('query error returns error', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', 'v1'),
    ]);

    mockPgQuery.mockRejectedValue(new Error('connection refused'));

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.error).toBe(1);
    expect(result.entries[0].detail).toContain('connection refused');
  });

  test('JSON key-order normalization still matches', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"owner":"alice","id":"asset1"}'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '{"id": "asset1", "owner": "alice"}' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.match).toBe(1);
  });

  test('composite keys are queried in their escaped form and verified', async () => {
    const compositeKey = `color~id${NUL}blue${NUL}asset1`;
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord(compositeKey, '"index"'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"index"' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.match).toBe(1);
    const queryArgs = mockPgQuery.mock.calls[0][1];
    expect(queryArgs[2]).toBe(
      'b64:' + Buffer.from(compositeKey, 'utf-8').toString('base64'),
    );
  });

  test('ordinary keys are queried verbatim', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('ab', '"v"'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v"' }],
    });

    await runVerification(tmpDir, makePgConfig());

    const queryArgs = mockPgQuery.mock.calls[0][1];
    expect(queryArgs[2]).toBe('ab');
  });

  test('private state match verifies with collection', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '{"secret":true}'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '{"secret": true}' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.match).toBe(1);
    const queryArgs = mockPgQuery.mock.calls[0][1];
    expect(queryArgs[3]).toBe('col1');
  });

  test('private state missing returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '"v"'),
    ]);

    mockPgQuery.mockResolvedValue({ rows: [] });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.missing).toBe(1);
  });

  test('throws when connectionString is missing', async () => {
    writeManifest(tmpDir, ['ch1']);

    const config: ReplayConfig = {
      adapter: 'postgresql',
      inputDir: tmpDir,
    };

    await expect(runVerification(tmpDir, config))
      .rejects.toThrow('postgresql.connectionString');
  });
});

// ── DynamoDB verification ──

describe('verify-runner — dynamodb', () => {
  test('matching public state returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { pk: 'ch1#mycc##asset1', value: '{"id":"asset1","owner":"alice"}' },
    });

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.match).toBe(1);
  });

  test('raises the SDK attempt limit above its default of 3', async () => {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    DynamoDBClient.mockClear();
    writeManifest(tmpDir, ['ch1']);
    mockDynamoSend.mockResolvedValue({});

    await runVerification(tmpDir, makeDynamoConfig());

    expect(DynamoDBClient).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: DYNAMODB_MAX_ATTEMPTS }),
    );
  });

  test('differing value returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1","owner":"alice"}'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { pk: 'ch1#mycc##asset1', value: '{"id":"asset1","owner":"bob"}' },
    });

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.mismatch).toBe(1);
    expect(result.entries[0].detail).toContain('alice');
  });

  test('missing item returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"id":"asset1"}'),
    ]);

    mockDynamoSend.mockResolvedValue({});

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.missing).toBe(1);
  });

  test('send error returns error', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', 'v1'),
    ]);

    mockDynamoSend.mockRejectedValue(new Error('Access denied'));

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.error).toBe(1);
    expect(result.entries[0].detail).toContain('Access denied');
  });

  test('JSON key-order normalization still matches', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '{"owner":"alice","id":"asset1"}'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { value: '{"id":"asset1","owner":"alice"}' },
    });

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.match).toBe(1);
  });

  test('public state is read by partition key alone: {channel}#{chaincode}##{key}', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v"'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { value: '"v"' },
    });

    await runVerification(tmpDir, makeDynamoConfig());

    // The state table has no sort key: a GetItem naming one is rejected
    // outright, so verify would report ERROR on every key.
    const [[callArg]] = MockGetCommand.mock.calls;
    expect(callArg.Key).toEqual({ pk: 'ch1#mycc##k1' });
  });

  test('private state names its collection: {channel}#{chaincode}#{collection}#{key}', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '"v"'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { value: '"v"' },
    });

    await runVerification(tmpDir, makeDynamoConfig());

    const calls = MockGetCommand.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.Key).toEqual({ pk: 'ch1#mycc#col1#pk1' });
  });

  test('a composite key is read in its escaped form', async () => {
    const NUL = String.fromCharCode(0);
    const composite = `color~id${NUL}blue${NUL}asset1`;
    const escaped = 'b64:' + Buffer.from(composite, 'utf-8').toString('base64');
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord(composite, '"v"'),
    ]);

    mockDynamoSend.mockResolvedValue({ Item: { value: '"v"' } });

    await runVerification(tmpDir, makeDynamoConfig());

    const [[callArg]] = MockGetCommand.mock.calls;
    expect(callArg.Key).toEqual({ pk: `ch1#mycc##${escaped}` });
  });

  test('private state match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '{"secret":true}'),
    ]);

    mockDynamoSend.mockResolvedValue({
      Item: { value: '{"secret":true}' },
    });

    const result = await runVerification(tmpDir, makeDynamoConfig());

    expect(result.summary.match).toBe(1);
  });

  test('throws when stateTable is missing', async () => {
    writeManifest(tmpDir, ['ch1']);

    const config: ReplayConfig = {
      adapter: 'dynamodb',
      inputDir: tmpDir,
      dynamodb: { region: 'us-east-1' } as any,
    };

    await expect(runVerification(tmpDir, config))
      .rejects.toThrow('dynamodb.stateTable');
  });
});

// ── PostgreSQL history verification ──

function pgHistoryRecords(): PublicHistoryRecord[] {
  return [
    {
      _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
      key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
      blockNumber: 1, timestamp: '', isDelete: false, creator,
    },
    {
      _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
      key: 'k1', value: '"v2"', txId: 'tx2', txIndex: 0,
      blockNumber: 2, timestamp: '', isDelete: false, creator,
    },
  ];
}

describe('verify-runner — postgresql history', () => {
  test('matching history sequence returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), pgHistoryRecords(),
    );

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v1"' }, { value: '"v2"' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('match');
  });

  test('mismatched history length returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), pgHistoryRecords(),
    );

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v1"' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
    expect(entry?.detail).toContain('history length');
  });

  test('mismatched history value returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), pgHistoryRecords(),
    );

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v1"' }, { value: '"WRONG"' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
    expect(entry?.detail).toContain('history[1]');
  });

  test('no history rows returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), pgHistoryRecords(),
    );

    mockPgQuery.mockResolvedValue({ rows: [] });

    const result = await runVerification(tmpDir, makePgConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('missing');
  });

  test('query error returns error', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), pgHistoryRecords(),
    );

    mockPgQuery.mockRejectedValue(new Error('connection reset'));

    const result = await runVerification(tmpDir, makePgConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('error');
    expect(entry?.detail).toContain('connection reset');
  });

  // The old name for this test said the skip happens "silently", which is true
  // and is not what the test asserts. A state-only extraction has no history
  // file, so comparing state alone is the correct outcome here — but `verify`
  // reads no `channel-<id>/metadata.json`, so a Tier 3 extraction whose history
  // file is missing takes this same path and reports every key as a match. That
  // gap is a known limitation; nothing below pins the silence as intended.
  test('verifies current state alone when there is no history file', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v"'),
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v"' }],
    });

    const result = await runVerification(tmpDir, makePgConfig());

    expect(result.summary.match).toBe(1);
    expect(result.entries).toHaveLength(1);
  });
});

// ── DynamoDB history verification ──

describe('verify-runner — dynamodb history', () => {
  function dynamoHistoryConfig(): ReplayConfig {
    return makeDynamoConfig({ historyTable: 'fabric-history' });
  }

  function dynamoHistoryRecords(): PublicHistoryRecord[] {
    return [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v2"', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: false, creator,
      },
    ];
  }

  test('matching history sequence returns match', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"v1"', blockNumber: 1 },
        { value: '"v2"', blockNumber: 2 },
      ],
    });

    const result = await runVerification(
      tmpDir, dynamoHistoryConfig(),
    );

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('match');
  });

  /** Two writes to one key inside a single block, distinguished by txIndex. */
  function sameBlockRecords(): PublicHistoryRecord[] {
    return [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"first"', txId: 'txa', txIndex: 0,
        blockNumber: 7, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"second"', txId: 'txb', txIndex: 1,
        blockNumber: 7, timestamp: '', isDelete: false, creator,
      },
    ];
  }

  test('asks DynamoDB for ascending sort key order', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"v1"', blockNumber: 1 },
        { value: '"v2"', blockNumber: 2 },
      ],
    });

    await runVerification(tmpDir, dynamoHistoryConfig());

    // The comparison consumes the query order as-is, so a descending query
    // would silently reverse every history it checks.
    const [lastCall] = MockQueryCommand.mock.calls.slice(-1);
    expect(lastCall[0].ScanIndexForward).toBe(true);
  });

  test('compares two writes in one block in sort key order', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), sameBlockRecords());

    // Same blockNumber, so only the sort key's txIndex orders these two.
    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"first"', blockNumber: 7 },
        { value: '"second"', blockNumber: 7 },
      ],
    });

    const result = await runVerification(tmpDir, dynamoHistoryConfig());

    expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
  });

  test('detects two writes in one block returned out of order', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), sameBlockRecords());

    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"second"', blockNumber: 7 },
        { value: '"first"', blockNumber: 7 },
      ],
    });

    const result = await runVerification(tmpDir, dynamoHistoryConfig());

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
  });

  test('detects mismatch when DynamoDB returns wrong order', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"v2"', blockNumber: 2 },
        { value: '"v1"', blockNumber: 1 },
      ],
    });

    const result = await runVerification(
      tmpDir, dynamoHistoryConfig(),
    );

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
  });

  test('mismatched history length returns mismatch', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({
      Items: [{ value: '"v1"', blockNumber: 1 }],
    });

    const result = await runVerification(
      tmpDir, dynamoHistoryConfig(),
    );

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('mismatch');
    expect(entry?.detail).toContain('history length');
  });

  test('no items returns missing', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({ Items: [] });

    const result = await runVerification(
      tmpDir, dynamoHistoryConfig(),
    );

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('missing');
  });

  test('query error returns error', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockRejectedValue(
      new Error('throughput exceeded'),
    );

    const result = await runVerification(
      tmpDir, dynamoHistoryConfig(),
    );

    const entry = result.entries.find((e) => e.key === 'k1');
    expect(entry?.status).toBe('error');
    expect(entry?.detail).toContain('throughput exceeded');
  });

  test('refuses history artifacts when historyTable is not configured', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v"'),
    ]);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    await expect(runVerification(tmpDir, makeDynamoConfig()))
      .rejects.toThrow(/contains history records.*historyTable/s);
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  test('queries with correct pk format', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'asset1', value: '"v"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
    ]);

    mockDynamoSend.mockResolvedValue({
      Items: [{ value: '"v"', blockNumber: 1 }],
    });

    await runVerification(tmpDir, dynamoHistoryConfig());

    const queryCalls = MockQueryCommand.mock.calls;
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = queryCalls[queryCalls.length - 1][0];
    expect(lastCall.TableName).toBe('fabric-history');
    expect(lastCall.ExpressionAttributeValues![':pk'])
      .toBe('ch1#mycc#asset1');
  });

  // Public and private history share a pk — only a trailing collection on the
  // sort key separates them — so the query has to exclude private entries.
  test('excludes private history entries from the partition', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    mockDynamoSend.mockResolvedValue({
      Items: [
        { value: '"v1"', blockNumber: 1 },
        { value: '"v2"', blockNumber: 2 },
      ],
    });

    await runVerification(tmpDir, dynamoHistoryConfig());

    const [lastCall] = MockQueryCommand.mock.calls.slice(-1);
    expect(lastCall[0].FilterExpression).toBe('size(#collection) = :noCollection');
    expect(lastCall[0].ExpressionAttributeNames)
      .toEqual({ '#collection': 'collection' });
    expect(lastCall[0].ExpressionAttributeValues![':noCollection']).toBe(0);
  });

  test('keeps paging while a filtered page comes back empty', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(
      tmpDir, layout.publicHistoryPath('ch1'), dynamoHistoryRecords(),
    );

    // A page holding only private entries is filtered to nothing but still
    // reports LastEvaluatedKey. Stopping there would report a false 'missing'.
    mockDynamoSend
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'p', sk: 's' } })
      .mockResolvedValueOnce({
        Items: [
          { value: '"v1"', blockNumber: 1 },
          { value: '"v2"', blockNumber: 2 },
        ],
      });

    const result = await runVerification(tmpDir, dynamoHistoryConfig());

    expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });
});

// ── Deletes in history verification ──
//
// A tombstone and a write of the empty value hold the same value; only the flag
// separates them. Comparing values alone reports MATCH for a delete replayed as
// PutState(key, "") — a key that is live at the destination and must not be,
// and that range and rich queries return.

describe('verify-runner — history deletes', () => {
  /** Source history for k1: written, then deleted. */
  function deletedRecords(): PublicHistoryRecord[] {
    return [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'k1', value: '', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '', isDelete: true, creator,
      },
    ];
  }

  function writeDeletedHistory(): void {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicHistoryPath('ch1'), deletedRecords());
  }

  /** A read function's result, newest-first as CouchDB returns it. */
  function returnsHistory(entries: any[]): void {
    mockGateway(jest.fn().mockResolvedValue(
      Buffer.from(JSON.stringify(entries)),
    ));
  }

  describe('chaincode', () => {
    test('a tombstone replayed as a tombstone matches', async () => {
      writeDeletedHistory();
      returnsHistory([
        { value: '', isDelete: true },
        { value: '"v1"', isDelete: false },
      ]);

      const result = await runVerification(tmpDir, historyConfig());

      expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    });

    test('a tombstone replayed as an empty write is a mismatch', async () => {
      writeDeletedHistory();
      returnsHistory([
        { value: '', isDelete: false },
        { value: '"v1"', isDelete: false },
      ]);

      const result = await runVerification(tmpDir, historyConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toBe(
        'history[1]: expected <delete>, got <empty>',
      );
    });

    test('a write replayed as a tombstone is a mismatch', async () => {
      const layout = new FileLayoutManager(tmpDir);
      writeManifest(tmpDir, ['ch1']);
      writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
        {
          _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
          key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
          blockNumber: 1, timestamp: '', isDelete: false, creator,
        },
      ]);
      returnsHistory([{ value: '"v1"', isDelete: true }]);

      const result = await runVerification(tmpDir, historyConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toContain('got <delete> "v1"');
    });

    test('a read function that omits isDelete cannot report a match', async () => {
      // The flag is part of the documented result shape. Absent, a destination
      // that did delete and one that wrote an empty value read alike, so the
      // sequence is reported as the writes it appears to be.
      writeDeletedHistory();
      returnsHistory([{ value: '' }, { value: '"v1"' }]);

      const result = await runVerification(tmpDir, historyConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toContain('expected <delete>');
    });

    test('history with no deletes still matches without the flag', async () => {
      // The flag defaults to false on both sides, so a read function that omits
      // it keeps working for any key that was never deleted.
      const layout = new FileLayoutManager(tmpDir);
      writeManifest(tmpDir, ['ch1']);
      writeRecords(tmpDir, layout.publicHistoryPath('ch1'), [
        {
          _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
          key: 'k1', value: '"v1"', txId: 'tx1', txIndex: 0,
          blockNumber: 1, timestamp: '', isDelete: false, creator,
        },
      ]);
      returnsHistory([{ value: '"v1"' }]);

      const result = await runVerification(tmpDir, historyConfig());

      expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    });

    /** Unqualified names resolve to the migration contract, whose values are
     * base64 — the flag beside them is not. */
    function migrationConfig(): ReplayConfig {
      return makeChaincodeConfig({
        historyReadFunctions: { ch1: { mycc: 'GetKeyHistory' } },
      });
    }

    test('the migration contract reports a tombstone as a match', async () => {
      // A tombstone's payload is the empty string, which is base64 for no
      // bytes; decoding it must not read as a contract that broke the wire
      // contract.
      writeDeletedHistory();
      returnsHistory([
        { value: '', isDelete: true },
        { value: Buffer.from('"v1"').toString('base64'), isDelete: false },
      ]);

      const result = await runVerification(tmpDir, migrationConfig());

      expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    });

    test('the migration contract read path compares the flag too', async () => {
      writeDeletedHistory();
      returnsHistory([
        { value: '', isDelete: false },
        { value: Buffer.from('"v1"').toString('base64'), isDelete: false },
      ]);

      const result = await runVerification(tmpDir, migrationConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toBe(
        'history[1]: expected <delete>, got <empty>',
      );
    });
  });

  describe('postgresql', () => {
    test('a tombstone replayed as a tombstone matches', async () => {
      writeDeletedHistory();
      mockPgQuery.mockResolvedValue({
        rows: [
          { value: '"v1"', is_delete: false },
          { value: null, is_delete: true },
        ],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    });

    test('a tombstone replayed as an empty write is a mismatch', async () => {
      writeDeletedHistory();
      mockPgQuery.mockResolvedValue({
        rows: [
          { value: '"v1"', is_delete: false },
          { value: null, is_delete: false },
        ],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toBe(
        'history[1]: expected <delete>, got <empty>',
      );
    });

    test('selects is_delete from fabric_history', async () => {
      // Without the column in the SELECT every row reads as a write, so the
      // comparison above would pass whatever the table holds.
      writeDeletedHistory();
      mockPgQuery.mockResolvedValue({
        rows: [
          { value: '"v1"', is_delete: false },
          { value: null, is_delete: true },
        ],
      });

      await runVerification(tmpDir, makePgConfig());

      const historyQuery = mockPgQuery.mock.calls
        .map((c) => c[0] as string)
        .find((sql) => sql.includes('fabric_history'));
      expect(historyQuery).toContain('is_delete');
      expect(historyQuery).toContain(
        'ORDER BY block_number, tx_index, tx_id, id',
      );
    });
  });

  describe('dynamodb', () => {
    function dynamoHistoryConfig(): ReplayConfig {
      return makeDynamoConfig({ historyTable: 'fabric-history' });
    }

    test('a tombstone replayed as a tombstone matches', async () => {
      writeDeletedHistory();
      mockDynamoSend.mockResolvedValue({
        Items: [
          { value: '"v1"', blockNumber: 1, isDelete: false },
          { value: '', blockNumber: 2, isDelete: true },
        ],
      });

      const result = await runVerification(tmpDir, dynamoHistoryConfig());

      expect(result.entries.find((e) => e.key === 'k1')?.status).toBe('match');
    });

    test('a tombstone replayed as an empty write is a mismatch', async () => {
      writeDeletedHistory();
      mockDynamoSend.mockResolvedValue({
        Items: [
          { value: '"v1"', blockNumber: 1, isDelete: false },
          { value: '', blockNumber: 2, isDelete: false },
        ],
      });

      const result = await runVerification(tmpDir, dynamoHistoryConfig());

      const entry = result.entries.find((e) => e.key === 'k1');
      expect(entry?.status).toBe('mismatch');
      expect(entry?.detail).toBe(
        'history[1]: expected <delete>, got <empty>',
      );
    });
  });
});

// ── Reverse sweep: destination keys with no source record ──

describe('verify-runner — extra destination keys', () => {
  /** One source key that the forward pass will find at the destination. */
  function writeOneSourceKey(): void {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '"v"'),
    ]);
  }

  const COMPOSITE_KEY = `color~id${NUL}blue${NUL}asset1`;
  const STORED_COMPOSITE =
    'b64:' + Buffer.from(COMPOSITE_KEY, 'utf-8').toString('base64');

  describe('postgresql', () => {
    beforeEach(() => {
      mockPgQuery.mockResolvedValue({ rows: [{ value: '"v"' }] });
    });

    test('a public row no source record accounts for is extra', async () => {
      writeOneSourceKey();
      mockPgSweep.mockResolvedValue({
        rows: [
          { chaincode: 'mycc', key: 'asset1' },
          { chaincode: 'mycc', key: 'leftover' },
        ],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.extra).toBe(1);
      const extra = result.entries.find((e) => e.status === 'extra');
      expect(extra).toMatchObject({
        channel: 'ch1', chaincode: 'mycc', key: 'leftover',
      });
    });

    test('a destination holding exactly the source keys has no extras', async () => {
      writeOneSourceKey();
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'mycc', key: 'asset1' }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(0);
      expect(result.summary.match).toBe(1);
    });

    test('the same key under another chaincode is still extra', async () => {
      writeOneSourceKey();
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'othercc', key: 'asset1' }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(1);
      expect(result.entries.find((e) => e.status === 'extra')?.chaincode)
        .toBe('othercc');
    });

    test('composite keys replay wrote are not reported as extra', async () => {
      const layout = new FileLayoutManager(tmpDir);
      writeManifest(tmpDir, ['ch1']);
      writeRecords(tmpDir, layout.publicStatePath('ch1'), [
        publicRecord(COMPOSITE_KEY, '"v"'),
      ]);
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'mycc', key: STORED_COMPOSITE }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(0);
    });

    test('an extra key is reported in source form, not storage form', async () => {
      writeOneSourceKey();
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'mycc', key: STORED_COMPOSITE }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.entries.find((e) => e.status === 'extra')?.key)
        .toBe(COMPOSITE_KEY);
    });

    test('the sweep asks one channel for its public rows only', async () => {
      writeOneSourceKey();

      await runVerification(tmpDir, makePgConfig());

      expect(mockPgSweep).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPgSweep.mock.calls[0];
      expect(sql).toContain('fabric_state');
      expect(sql).toContain('collection IS NULL');
      expect(sql).toContain('ORDER BY chaincode, key');
      // Bounded, because node-postgres buffers a result set whole: without this
      // the sweep allocates the channel. A mock answers whatever it likes, so
      // the clause itself is the only place this claim can be checked.
      expect(sql).toContain('LIMIT 5000');
      // No page boundary on the first page, and none needed after a short one.
      expect(sql).not.toContain('$2');
      expect(params).toEqual(['ch1']);
    });

    /**
     * A page's worth of destination rows, none of which the source holds.
     *
     * As many as the sweep's own page size, which is what makes the sweep ask
     * for another page.
     */
    function fullSweepPage(): Array<{ chaincode: string; key: string }> {
      return Array.from({ length: 5000 }, (_, i) => ({
        chaincode: 'mycc',
        key: `leftover-${String(i).padStart(4, '0')}`,
      }));
    }

    test('a full page is followed by one resumed from its last row', async () => {
      writeOneSourceKey();
      mockPgSweep
        .mockResolvedValueOnce({ rows: fullSweepPage() })
        .mockResolvedValueOnce({
          rows: [{ chaincode: 'othercc', key: 'last' }],
        });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(mockPgSweep).toHaveBeenCalledTimes(2);
      const [sql, params] = mockPgSweep.mock.calls[1];
      expect(sql).toContain('(chaincode, key) > ($2::TEXT, $3::TEXT)');
      expect(params).toEqual(['ch1', 'mycc', 'leftover-4999']);
      expect(result.summary.extra).toBe(5001);
    });

    test('a sweep that fails on a later page reports only the failure', async () => {
      // The keys page one found are dropped: a set missing pages cannot say
      // what the destination holds, and reporting it as though it could turns a
      // connection lost mid-sweep into a false picture of the destination.
      writeOneSourceKey();
      mockPgSweep
        .mockResolvedValueOnce({ rows: fullSweepPage() })
        .mockRejectedValueOnce(new Error('connection terminated'));

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(0);
      expect(result.summary.error).toBe(1);
      expect(result.entries.find((e) => e.status === 'error')?.detail).toBe(
        'destination key sweep failed: connection terminated',
      );
    });

    test('each channel is swept against its own keys', async () => {
      const layout = new FileLayoutManager(tmpDir);
      writeManifest(tmpDir, ['ch1', 'ch2']);
      writeRecords(tmpDir, layout.publicStatePath('ch1'), [
        publicRecord('k1', '"v"'),
      ]);
      writeRecords(tmpDir, layout.publicStatePath('ch2'), [
        { ...publicRecord('k2', '"v"'), channel: 'ch2' },
      ]);
      // Both channels hold k1 at the destination; only ch1 extracted it.
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'mycc', key: 'k1' }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(1);
      expect(result.entries.find((e) => e.status === 'extra')?.channel)
        .toBe('ch2');
    });

    test('a channel with no state file still gets swept', async () => {
      writeManifest(tmpDir, ['ch1']);
      mockPgSweep.mockResolvedValue({
        rows: [{ chaincode: 'mycc', key: 'leftover' }],
      });

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.extra).toBe(1);
    });

    test('a failed sweep is an error, not a lost run', async () => {
      writeOneSourceKey();
      mockPgSweep.mockRejectedValue(new Error('connection terminated'));

      const result = await runVerification(tmpDir, makePgConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.extra).toBe(0);
      expect(result.summary.error).toBe(1);
      const error = result.entries.find((e) => e.status === 'error');
      expect(error?.channel).toBe('ch1');
      expect(error?.detail).toBe(
        'destination key sweep failed: connection terminated',
      );
    });
  });

  describe('dynamodb', () => {
    beforeEach(() => {
      mockDynamoSend.mockResolvedValue({ Item: { value: '"v"' } });
    });

    test('a public item no source record accounts for is extra', async () => {
      writeOneSourceKey();
      mockDynamoScan.mockResolvedValue({
        Items: [
          { pk: 'ch1#mycc##asset1' },
          { pk: 'ch1#mycc##leftover' },
        ],
      });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.extra).toBe(1);
      expect(result.entries.find((e) => e.status === 'extra'))
        .toMatchObject({ channel: 'ch1', chaincode: 'mycc', key: 'leftover' });
    });

    test('an extra key containing the separator is reported whole', async () => {
      writeOneSourceKey();
      mockDynamoScan.mockResolvedValue({
        Items: [{ pk: 'ch1#mycc##a#b#c' }],
      });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.entries.find((e) => e.status === 'extra'))
        .toMatchObject({ chaincode: 'mycc', key: 'a#b#c' });
    });

    test('items that are not this channel\'s public state are left alone', async () => {
      writeOneSourceKey();
      mockDynamoScan.mockResolvedValue({
        Items: [
          // Private state: the collection sits where public state has nothing.
          { pk: 'ch1#mycc#col1#pk1' },
          // Another channel whose name starts with this one — the scan filter
          // matches a prefix, so the channel has to be checked field by field.
          { pk: 'ch1x#mycc##k1' },
          // Fewer fields than the layout has: nothing here wrote it.
          { pk: 'ch1#mycc#col1' },
          // An empty ledger key, which Fabric does not allow.
          { pk: 'ch1#mycc##' },
          // A partition key attribute of the wrong type entirely.
          { pk: 42 },
        ],
      });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.summary.extra).toBe(0);
    });

    test('the scan is filtered to the channel being verified', async () => {
      writeOneSourceKey();

      await runVerification(tmpDir, makeDynamoConfig());

      expect(mockDynamoScan).toHaveBeenCalledTimes(1);
      const { input } = mockDynamoScan.mock.calls[0][0];
      expect(input.TableName).toBe('fabric-state');
      expect(input.FilterExpression).toContain('begins_with(pk, :prefix)');
      expect(input.ExpressionAttributeValues[':prefix']).toBe('ch1#');
      expect(input.ExclusiveStartKey).toBeUndefined();
    });

    test('every page of the scan is swept', async () => {
      writeOneSourceKey();
      mockDynamoScan
        .mockResolvedValueOnce({
          Items: [{ pk: 'ch1#mycc##page1' }],
          LastEvaluatedKey: { pk: 'ch1#mycc##page1' },
        })
        .mockResolvedValueOnce({
          Items: [{ pk: 'ch1#mycc##page2' }],
        });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.summary.extra).toBe(2);
      expect(mockDynamoScan).toHaveBeenCalledTimes(2);
      expect(mockDynamoScan.mock.calls[1][0].input.ExclusiveStartKey)
        .toEqual({ pk: 'ch1#mycc##page1' });
    });

    test('a failed scan is an error, not a lost run', async () => {
      writeOneSourceKey();
      mockDynamoScan.mockRejectedValue(new Error('AccessDeniedException'));

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.error).toBe(1);
      expect(result.entries.find((e) => e.status === 'error')?.detail)
        .toBe('destination key sweep failed: AccessDeniedException');
    });

    test('an extra key is reported in source form, not storage form', async () => {
      writeOneSourceKey();
      mockDynamoScan.mockResolvedValue({
        Items: [{ pk: `ch1#mycc##${STORED_COMPOSITE}` }],
      });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.entries.find((e) => e.status === 'extra')?.key)
        .toBe(COMPOSITE_KEY);
    });

    test('composite keys replay wrote are not reported as extra', async () => {
      // The source keys are collected in storage form, so the partition key has
      // to be compared before it is decoded, not after.
      const layout = new FileLayoutManager(tmpDir);
      writeManifest(tmpDir, ['ch1']);
      writeRecords(tmpDir, layout.publicStatePath('ch1'), [
        publicRecord(COMPOSITE_KEY, '"v"'),
      ]);
      mockDynamoScan.mockResolvedValue({
        Items: [{ pk: `ch1#mycc##${STORED_COMPOSITE}` }],
      });

      const result = await runVerification(tmpDir, makeDynamoConfig());

      expect(result.summary.extra).toBe(0);
    });
  });

  describe('chaincode', () => {
    /**
     * A namespace the sweep will read: the manifest names the chaincode, and its
     * `readFunctions` entry names the migration contract, which is the one thing
     * in the config that says `ListKeys` is deployed.
     */
    function sweepableConfig(
      overrides?: Partial<ReplayConfig['chaincode']>,
    ): ReplayConfig {
      return makeChaincodeConfig({
        readFunctions: { ch1: { mycc: 'MigrationContract:ReadState' } },
        ...overrides,
      });
    }

    function writeOneSweepableKey(
      chaincodes: Array<{ name: string }> = [{ name: 'mycc' }],
    ): void {
      const layout = new FileLayoutManager(tmpDir);
      writeManifestWithChaincodes(chaincodes);
      writeRecords(tmpDir, layout.publicStatePath('ch1'), [
        publicRecord('asset1', '"v"'),
      ]);
    }

    /** How the contract reports a key. */
    const b64 = (key: string): string =>
      Buffer.from(key, 'utf-8').toString('base64');

    /**
     * The contract's evaluate, answering `ListKeys` with `pages` in order and
     * every other function with a value that matches the source.
     *
     * Routed by function name because the forward pass and the sweep reach the
     * same contract, and a page returned to a value read would be a mismatch in
     * every test here. Running out of pages throws rather than returning
     * nothing, so a sweep that pages too far is visible.
     */
    function evaluateWith(pages: string[]): jest.Mock {
      let next = 0;
      return jest.fn(async (fn: string) => {
        if (fn !== 'ListKeys') {
          return Buffer.from(Buffer.from('"v"').toString('base64'), 'utf-8');
        }
        if (next >= pages.length) {
          throw new Error(`ListKeys called ${next + 1} times, with ${pages.length} pages`);
        }
        return Buffer.from(pages[next++], 'utf-8');
      });
    }

    /** One page in the shape the migration contract answers with. */
    const page = (keys: string[], bookmark = ''): string =>
      JSON.stringify({ keys: keys.map(b64), bookmark });

    test('a public key no source record accounts for is extra', async () => {
      writeOneSweepableKey();
      mockGateway(evaluateWith([page(['asset1', 'leftover'])]));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.extra).toBe(1);
      expect(result.entries.find((e) => e.status === 'extra'))
        .toMatchObject({ channel: 'ch1', chaincode: 'mycc', key: 'leftover' });
    });

    test('a namespace holding exactly the source keys has no extras', async () => {
      writeOneSweepableKey();
      mockGateway(evaluateWith([page(['asset1'])]));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.extra).toBe(0);
      expect(result.summary.match).toBe(1);
    });

    test('the same key under another chaincode is still extra', async () => {
      writeOneSweepableKey([{ name: 'mycc' }, { name: 'othercc' }]);
      // Both namespaces report asset1; only mycc's was extracted.
      mockGateway(evaluateWith([page(['asset1']), page(['asset1'])]));

      const result = await runVerification(tmpDir, sweepableConfig({
        readFunctions: {
          ch1: {
            mycc: 'MigrationContract:ReadState',
            othercc: 'MigrationContract:ReadState',
          },
        },
      }));

      expect(result.summary.extra).toBe(1);
      expect(result.entries.find((e) => e.status === 'extra')?.chaincode)
        .toBe('othercc');
    });

    test('the sweep asks for one bounded page at a time', async () => {
      writeOneSweepableKey();
      const evaluate = evaluateWith([
        page(['asset1'], 'bm1'), page(['leftover']),
      ]);
      mockGateway(evaluate);

      const result = await runVerification(tmpDir, sweepableConfig());

      const listCalls = evaluate.mock.calls.filter((c) => c[0] === 'ListKeys');
      expect(listCalls).toEqual([
        ['ListKeys', '500', ''],
        ['ListKeys', '500', 'bm1'],
      ]);
      expect(result.summary.extra).toBe(1);
    });

    test('a bookmark that comes back twice is refused, not followed', async () => {
      writeOneSweepableKey();
      mockGateway(evaluateWith([page([], 'bm1'), page(['leftover'], 'bm1')]));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.error).toBe(1);
      // The keys the refused sweep did find are dropped: a partial page set
      // cannot tell an extra key from one a later page would account for.
      expect(result.summary.extra).toBe(0);
      const error = result.entries.find((e) => e.status === 'error');
      expect(error).toMatchObject({ channel: 'ch1', chaincode: 'mycc', key: '' });
      expect(error?.detail).toContain('the bookmark bm1 twice');
    });

    test.each([
      ['no keys array', '{"rows":[]}'],
      ['a key that is not a string', '{"keys":[1],"bookmark":""}'],
      ['no bookmark', '{"keys":[]}'],
    ])('a page with %s is refused as the wrong shape', async (_name, body) => {
      writeOneSweepableKey();
      mockGateway(evaluateWith([body]));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.error).toBe(1);
      // The shape it was measured against, not whatever downstream call the
      // wrong shape happened to break: a page read as empty would be
      // indistinguishable from a namespace holding nothing extra.
      expect(result.entries.find((e) => e.status === 'error')?.detail)
        .toContain(
          `returned ${body}, not the ` +
          '{"keys":["<base64>",...],"bookmark":"..."}',
        );
    });

    test('a page that is not JSON is refused, not thrown out of the run',
      async () => {
        writeOneSweepableKey();
        mockGateway(evaluateWith(['OK']));

        const result = await runVerification(tmpDir, sweepableConfig());

        expect(result.summary.match).toBe(1);
        expect(result.summary.error).toBe(1);
        expect(result.entries.find((e) => e.status === 'error')?.detail)
          .toContain('destination key sweep failed');
      });

    test('a failed ListKeys names the namespace and keeps the run', async () => {
      writeOneSweepableKey();
      mockGateway(jest.fn(async (fn: string) => {
        if (fn === 'ListKeys') {
          throw new Error('ListKeys is not a function of MigrationContract');
        }
        return Buffer.from(Buffer.from('"v"').toString('base64'), 'utf-8');
      }));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.error).toBe(1);
      const error = result.entries.find((e) => e.status === 'error');
      expect(error).toMatchObject({ channel: 'ch1', chaincode: 'mycc', key: '' });
      expect(error?.detail).toBe(
        'destination key sweep failed: ' +
        'ListKeys is not a function of MigrationContract',
      );
    });

    test('a namespace read through another contract is skipped, not swept', async () => {
      writeOneSweepableKey();
      const evaluate = jest.fn().mockResolvedValue(Buffer.from('"v"'));
      mockGateway(evaluate);

      // The default config's readFunctions name the application's own contract.
      const result = await runVerification(tmpDir, makeChaincodeConfig());

      expect(result.summary.match).toBe(1);
      expect(result.summary.extra).toBe(0);
      expect(result.summary.skipsByReason).toEqual({ 'no-key-listing': 1 });
      const skip = result.entries.find((e) => e.skipReason === 'no-key-listing');
      expect(skip).toMatchObject({ channel: 'ch1', chaincode: 'mycc', key: '' });
      expect(skip?.detail).toBe(
        'no key listing for ch1/mycc — its readFunctions entry does not name ' +
        'MigrationContract, the only contract with ListKeys',
      );
      expect(evaluate.mock.calls.map((c) => c[0])).not.toContain('ListKeys');
    });

    test('a chaincode the manifest does not name is not swept at all', async () => {
      writeOneSweepableKey();
      mockGateway(evaluateWith([page(['asset1'])]));

      const result = await runVerification(tmpDir, sweepableConfig());

      // One namespace named, so one sweep — a key under a chaincode nothing
      // told verify about is out of reach, and no skip claims otherwise.
      expect(result.summary.extra).toBe(0);
      expect(result.summary.skip).toBe(0);
    });

    test('a channel with no state file still gets swept', async () => {
      writeManifestWithChaincodes([{ name: 'mycc' }]);
      mockGateway(evaluateWith([page(['leftover'])]));

      const result = await runVerification(tmpDir, sweepableConfig());

      expect(result.summary.extra).toBe(1);
    });

    test('an extra key is reported decoded, not as the base64 it arrived in',
      async () => {
        const layout = new FileLayoutManager(tmpDir);
        writeManifestWithChaincodes([{ name: 'mycc' }]);
        writeRecords(tmpDir, layout.publicStatePath('ch1'), [
          publicRecord('asset/日本', '"v"'),
        ]);
        mockGateway(evaluateWith([page(['asset/日本', 'leftover/日本'])]));

        const result = await runVerification(tmpDir, sweepableConfig());

        expect(result.summary.extra).toBe(1);
        expect(result.entries.find((e) => e.status === 'extra')?.key)
          .toBe('leftover/日本');
      });
  });
});

// ── Cross-adapter ──

describe('verify-runner — shared', () => {
  test('unsupported adapter throws', async () => {
    writeManifest(tmpDir, ['ch1']);

    const config = {
      adapter: 'redis',
      inputDir: tmpDir,
    } as unknown as ReplayConfig;

    await expect(runVerification(tmpDir, config))
      .rejects.toThrow('Unsupported adapter: redis');
  });

  test('channels filter limits verification scope', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1', 'ch2']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v1"'),
    ]);
    writeRecords(tmpDir, layout.publicStatePath('ch2'), [
      { ...publicRecord('k2', '"v2"'), channel: 'ch2' },
    ]);

    mockPgQuery.mockResolvedValue({
      rows: [{ value: '"v1"' }],
    });

    const result = await runVerification(
      tmpDir, makePgConfig(), ['ch1'],
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('k1');
    expect(result.summary.match).toBe(1);
  });

  test('a channel not in the manifest throws instead of verifying nothing', async () => {
    writeManifest(tmpDir, ['ch1', 'ch2']);

    await expect(
      runVerification(tmpDir, makePgConfig(), ['ch1', 'typo-ch']),
    ).rejects.toThrow(
      /--channels named channel\(s\) that are not in the manifest: typo-ch/,
    );
  });

  test('the unknown-channel error lists the manifest channels', async () => {
    writeManifest(tmpDir, ['ch1', 'ch2']);

    await expect(
      runVerification(tmpDir, makePgConfig(), ['nope']),
    ).rejects.toThrow(/Manifest channels: ch1, ch2/);
  });
});

// ── Read function coverage (fail before connecting) ──

describe('verify-runner — read function coverage', () => {
  test('throws when a manifest chaincode has no readFunctions entry', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([{ name: 'mycc' }, { name: 'othercc' }]);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v1"'),
    ]);

    const evaluate = jest.fn();
    mockGateway(evaluate);

    await expect(
      runVerification(tmpDir, makeChaincodeConfig()),
    ).rejects.toThrow(/Unmapped: ch1\/othercc \(missing readFunctions\)/);

    expect(evaluate).not.toHaveBeenCalled();
  });

  test('does not connect to the destination when coverage is incomplete', async () => {
    writeManifestWithChaincodes([{ name: 'unmapped' }]);
    const evaluate = jest.fn();
    mockGateway(evaluate);
    const MockGateway = FabricGateway as jest.MockedClass<typeof FabricGateway>;

    await expect(
      runVerification(tmpDir, makeChaincodeConfig()),
    ).rejects.toThrow(/Every chaincode on every channel must have a read/);

    expect(MockGateway.prototype.connect).not.toHaveBeenCalled();
  });

  test('throws when a collection-bearing chaincode has no privateReadFunctions', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([
      { name: 'mycc', collections: [{ name: 'col1' }] },
    ]);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '"pv1"'),
    ]);
    mockGateway(jest.fn());

    await expect(
      runVerification(
        tmpDir,
        makeChaincodeConfig({ privateReadFunctions: undefined }),
      ),
    ).rejects.toThrow(/missing privateReadFunctions/);
  });

  /**
   * The requirement follows the private file, and the file names its chaincode —
   * so a chaincode with no private data of its own is not made to map a private
   * read function because a chaincode beside it on the channel has some.
   */
  test('requires privateReadFunctions only of the chaincode that has the data',
    async () => {
      const layout = new FileLayoutManager(tmpDir);
      writeManifestWithChaincodes([
        { name: 'mycc', collections: [{ name: 'col1' }] },
        { name: 'othercc', collections: [{ name: 'col1' }] },
      ]);
      writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
        privateRecord('pk1', '"pv1"'),
      ]);
      mockGateway(jest.fn().mockResolvedValue(Buffer.from('"pv1"')));

      const result = await runVerification(
        tmpDir,
        makeChaincodeConfig({
          readFunctions: {
            ch1: {
              mycc: 'SampleAssets:ReadAsset',
              othercc: 'SampleAssets:ReadAsset',
            },
          },
          privateReadFunctions: {
            ch1: { mycc: 'SampleAssets:ReadPrivateData' },
          },
        }),
      );

      expect(result.summary.match).toBe(1);
    });

  test('ignores a collection whose private state was never extracted', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([
      { name: 'mycc', collections: [{ name: 'col1' }] },
    ]);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v1"'),
    ]);
    mockGateway(jest.fn().mockResolvedValue(Buffer.from('"v1"')));

    const result = await runVerification(
      tmpDir,
      makeChaincodeConfig({ privateReadFunctions: undefined }),
    );

    expect(result.summary.match).toBe(1);
  });

  test('throws when historyReadFunctions is set but misses a chaincode', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([{ name: 'mycc' }, { name: 'othercc' }]);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v1"'),
    ]);
    mockGateway(jest.fn());

    await expect(
      runVerification(
        tmpDir,
        makeChaincodeConfig({
          readFunctions: { ch1: { mycc: 'ReadAsset', othercc: 'ReadAsset' } },
          historyReadFunctions: { ch1: { mycc: 'GetHistory' } },
        }),
      ),
    ).rejects.toThrow(/ch1\/othercc \(missing historyReadFunctions\)/);
  });

  test('--channels narrows what coverage requires', async () => {
    const layout = new FileLayoutManager(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: new Date().toISOString(),
        channels: [
          {
            channelId: 'ch1',
            ledgerHeight: 10,
            chaincodes: [
              { name: 'mycc', version: '1.0', sequence: 1, collections: [] },
            ],
          },
          {
            channelId: 'ch2',
            ledgerHeight: 10,
            chaincodes: [
              { name: 'unmapped', version: '1.0', sequence: 1, collections: [] },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('k1', '"v1"'),
    ]);
    mockGateway(jest.fn().mockResolvedValue(Buffer.from('"v1"')));

    const result = await runVerification(
      tmpDir, makeChaincodeConfig(), ['ch1'],
    );

    expect(result.summary.match).toBe(1);
  });
});

// ── Skip accounting ──

describe('verify-runner — skipsByReason', () => {
  test('breaks skips down by reason so they cannot hide in a total', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord(`asset${NUL}idx`, '"v1"'),
      publicRecord(`asset${NUL}other`, '"v2"'),
      publicRecord('plain', '"v3"'),
      publicRecord('unmapped-key', '"v4"', 'lscc'),
    ]);

    mockGateway(jest.fn().mockResolvedValue(Buffer.from('"v3"')));

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.skip).toBe(3);
    expect(result.summary.skipsByReason).toEqual({
      'composite-key': 2,
      'no-read-function': 1,
    });
    expect(result.summary.match).toBe(1);
  });

  test('omits reasons with no skips', async () => {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('plain', '"v1"'),
    ]);

    mockGateway(jest.fn().mockResolvedValue(Buffer.from('"v1"')));

    const result = await runVerification(tmpDir, makeChaincodeConfig());

    expect(result.summary.skip).toBe(0);
    expect(result.summary.skipsByReason).toEqual({});
  });

  test('names the chaincode a reason affected, and its collection', async () => {
    // The names are what the CLI prints under a reason. They are carried in the
    // summary rather than derived, because the entries they came from are gone
    // by the time it is printed — and a private skip that named only "mycc"
    // would send an operator to look at the wrong data.
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('unmapped-key', '"v1"', 'lscc'),
    ]);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateRecord('pk1', '"v2"'),
    ]);
    writeRecords(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col2'), [
      privateRecord('pk2', '"v3"', 'col2'),
    ]);

    mockGateway(jest.fn());

    const result = await runVerification(
      tmpDir, makeChaincodeConfig({ privateReadFunctions: {} }),
    );

    expect(result.summary.skipTargets).toEqual({
      'no-read-function': ['lscc'],
      'no-private-read-function': ['mycc/col1', 'mycc/col2'],
    });
  });

  test('sorts the affected names instead of reporting skip order', async () => {
    // Discovered in the order the manifest names them, which is not sorted
    // order. Sorted anyway, so the line reads the same on a rerun and two runs
    // of the same extraction can be diffed.
    const layout = new FileLayoutManager(tmpDir);
    writeManifestWithChaincodes([{ name: 'zcc' }, { name: 'acc' }]);
    writeRecords(tmpDir, layout.publicStatePath('ch1'), [
      publicRecord('asset1', '"v"', 'zcc'),
    ]);

    mockGateway(jest.fn().mockResolvedValue(Buffer.from('"v"')));

    const result = await runVerification(tmpDir, makeChaincodeConfig({
      readFunctions: {
        ch1: { zcc: 'SampleAssets:Read', acc: 'SampleAssets:Read' },
      },
    }));

    expect(result.summary.skipTargets).toEqual({
      'no-key-listing': ['acc', 'zcc'],
    });
  });
});

// ── Concurrency ──
//
// Every compared key costs a destination round trip. Measured live: 12,060
// entries took 100 s on a LAN and 656 s at 50 ms more RTT, one query at a time.

describe('verify-runner — concurrency', () => {
  /** A destination that answers each key after a delay, slower for earlier keys. */
  function slowDestination(): { evaluate: jest.Mock; peak: () => number } {
    let inFlight = 0;
    let peak = 0;
    const evaluate = jest.fn(async (_fn: string, key: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const n = Number(key.slice(1));
      await new Promise((r) => setTimeout(r, (20 - n) * 2));
      inFlight--;
      if (key === 'k7') throw new Error('does not exist');
      return Buffer.from(key === 'k3' ? 'wrong' : `v-${key}`);
    });
    return { evaluate, peak: () => peak };
  }

  function writeKeys(): void {
    const layout = new FileLayoutManager(tmpDir);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, layout.publicStatePath('ch1'),
      Array.from({ length: 20 }, (_, i) => publicRecord(`k${i}`, `v-k${i}`)));
  }

  async function verifyWith(concurrency?: number) {
    const entries: VerifyEntry[] = [];
    const summary = await runVerifier(tmpDir, makeChaincodeConfig(), {
      onEntry: (e) => entries.push(e), ...(concurrency !== undefined ? { concurrency } : {}),
    });
    return { entries, summary };
  }

  it('keeps several destination queries in flight', async () => {
    writeKeys();
    const dest = slowDestination();
    mockGateway(dest.evaluate);

    await verifyWith(8);

    expect(dest.peak()).toBe(8);
  });

  it('queries one key at a time by default', async () => {
    writeKeys();
    const dest = slowDestination();
    mockGateway(dest.evaluate);

    await verifyWith();

    expect(dest.peak()).toBe(1);
  });

  /** Same entries, same order, same summary — only the wall clock changes. */
  it('reports exactly what a sequential run reports', async () => {
    writeKeys();
    mockGateway(slowDestination().evaluate);
    const sequential = await verifyWith(1);
    mockGateway(slowDestination().evaluate);
    const parallel = await verifyWith(8);

    expect(parallel.entries).toEqual(sequential.entries);
    expect(parallel.summary).toEqual(sequential.summary);
    expect(parallel.entries.map((e) => e.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => `k${i}`),
    );
    expect(parallel.summary.mismatch).toBe(1);
    expect(parallel.summary.missing + parallel.summary.error).toBe(1);
  });

  it.each([0, -2, 1.5])('rejects a concurrency of %p', async (value) => {
    writeKeys();
    mockGateway(slowDestination().evaluate);

    await expect(verifyWith(value)).rejects.toThrow(/concurrency must be an integer >= 1/);
  });
});

// ── Destination fingerprint ──

describe('verify-runner — destinationFingerprint', () => {
  it('refuses to read a destination whose genesis block is not the configured one', async () => {
    const evaluate = jest.fn(async (fn: string) => {
      if (fn === 'GetBlockByNumber') return Buffer.from('genesis-of-some-other-ledger');
      throw new Error('a key read must not happen');
    });
    mockGateway(evaluate);
    writeManifest(tmpDir, ['ch1']);
    writeRecords(tmpDir, new FileLayoutManager(tmpDir).publicStatePath('ch1'), [
      publicRecord('k1', 'v1'),
    ]);

    await expect(runVerifier(tmpDir, makeChaincodeConfig({
      destinationFingerprint: { ch1: 'ab'.repeat(32) },
    }))).rejects.toThrow(/not the network this config was made for/);
    expect(evaluate.mock.calls.map((c) => c[0])).toEqual(['GetBlockByNumber']);
  });
});

describe('destinationStateDbFor', () => {
  const { destinationStateDbFor } = require('../src/verification/verify-runner');
  const base = { networkId: 'n', memberId: 'm', region: 'r', stateDb: 'CouchDB', extractedAt: 't', channels: [] };
  const merged = (dbs: string[]) => ({ ...base, mergedFrom: dbs.map((d, i) => ({ inputDir: `d${i}`, memberId: `m${i}`, stateDb: d, extractedAt: 't' })) });

  it('uses the configured value first', () => {
    expect(destinationStateDbFor('LevelDB', merged(['LevelDB', 'CouchDB']))).toBe('LevelDB');
  });
  it('falls back to the source peer for one member or agreeing members', () => {
    expect(destinationStateDbFor(undefined, { ...base, stateDb: 'LevelDB' })).toBe('LevelDB');
    expect(destinationStateDbFor(undefined, merged(['CouchDB', 'CouchDB']))).toBe('CouchDB');
  });
  it('refuses to guess for a merge of peers with different state databases', () => {
    expect(() => destinationStateDbFor(undefined, merged(['LevelDB', 'CouchDB']))).toThrow(/destinationStateDb/);
  });
});
