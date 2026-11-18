// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  ChaincodeInfo,
  CollectionConfig,
  ExtractionRecord,
  ReplayConfig,
} from '../src/types';

// ── Mocks ──

/** One write that reached the orderer, and the identity that submitted it. */
interface MockWrite {
  mspId: string;
  channel: string;
  fn: string;
  args: string[];
}

const mockWrites: MockWrite[] = [];
const mockDisconnects: string[] = [];

/** A commit status the peer would report for a transaction that validated. */
const mockCommitted = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

/** What a destination's migration contract answers the write pre-flight with. */
const EMPTY_KEY_PAGE = Buffer.from('{"keys":[],"bookmark":""}', 'utf-8');

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => {
    let mspId = '';
    return {
      connect: jest.fn(async (options: { mspId: string }) => {
        mspId = options.mspId;
      }),
      getGatewayNetwork: jest.fn((channel: string) => ({
        getContract: jest.fn(() => ({
          evaluateTransaction: jest.fn(async () => EMPTY_KEY_PAGE),
          newProposal: jest.fn((fn: string, opts: { arguments: string[] }) => ({
            endorse: async () => ({
              submit: async () => {
                mockWrites.push({ mspId, channel, fn, args: opts.arguments });
                return { getStatus: async () => mockCommitted };
              },
            }),
          })),
        })),
      })),
      disconnect: jest.fn(() => mockDisconnects.push(mspId)),
    };
  }),
}));

/** Committed chaincodes the destination channel reports, per test. */
let mockCommittedChaincodes: ChaincodeInfo[] = [];
/** Set to make the destination refuse to answer a lifecycle query. */
let mockQueryError: Error | null = null;
const mockQueryCommitted = jest.fn(async (_channel: string) => {
  if (mockQueryError) throw mockQueryError;
  return mockCommittedChaincodes;
});

jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: mockQueryCommitted,
  })),
}));

import { ChaincodeDiscoverer } from '../src/discovery/chaincode-discoverer';
import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-preflight-test-'));
  layout = new FileLayoutManager(tmpDir);
  mockWrites.length = 0;
  mockDisconnects.length = 0;
  // The destination has the chaincode these tests replay, since a destination
  // that does not is refused before any collection is looked at.
  mockCommittedChaincodes = [committed('mycc')];
  mockQueryError = null;
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ORG2 = {
  mspId: 'Org2MSP',
  certPath: 'org2-cert.pem',
  keyPath: 'org2-key.pem',
};

/**
 * An implicit collection has to be mapped before replay will write it, so the
 * membership checks below cannot be reached without one. Mapped to itself: these
 * tests are about the identity that writes a collection, not its name, and a
 * destination that reuses the source MSP IDs is what the sample networks do.
 */
const IMPLICIT_MAPPING = {
  '_implicit_org_Org1MSP': '_implicit_org_Org1MSP',
  '_implicit_org_Org2MSP': '_implicit_org_Org2MSP',
};

function collection(
  name: string,
  overrides: Partial<CollectionConfig> = {},
): CollectionConfig {
  return {
    name,
    policy: "OR('Org1MSP.member')",
    requiredPeerCount: 0,
    maxPeerCount: 1,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    ...overrides,
  };
}

/**
 * A chaincode definition as the destination's lifecycle reports it. An implicit
 * collection is declared in none of them, but the chaincode holding it still has
 * to be committed to have a namespace — so `collections` is often empty.
 */
function committed(
  name: string,
  collections: CollectionConfig[] = [],
): ChaincodeInfo {
  return { name, version: '1.0', sequence: 1, collections };
}

function writeManifest(): void {
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb: 'CouchDB',
      extractedAt: '2026-01-01T00:00:00.000Z',
      channels: [{ channelId: 'ch1', chaincodes: [], ledgerHeight: 1 }],
    }),
    'utf-8',
  );
}

function writeRecords(
  relativePath: string,
  records: ExtractionRecord[],
): void {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function privateRecord(
  collectionName: string,
  chaincode = 'mycc',
): ExtractionRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode,
    collection: collectionName,
    key: 'pk1',
    value: 'pv1',
  };
}

/** A run with one private collection's data and no public data. */
function setupPrivate(collectionName: string, chaincode = 'mycc'): void {
  writeManifest();
  writeRecords(layout.publicStatePath('ch1'), []);
  writeRecords(layout.privateStatePath('ch1', chaincode, collectionName), [
    privateRecord(collectionName, chaincode),
  ]);
}

function config(
  overrides: Partial<NonNullable<ReplayConfig['chaincode']>> = {},
): ReplayConfig {
  return {
    adapter: 'chaincode',
    inputDir: tmpDir,
    chaincode: {
      connectionProfilePath: 'org1-profile.json',
      mspId: 'Org1MSP',
      certPath: 'org1-cert.pem',
      keyPath: 'org1-key.pem',
      channelMapping: { ch1: 'dest1' },
      ...overrides,
    },
  };
}

function run(overrides = {}): Promise<any> {
  return new ReplayOrchestrator(config(overrides)).run();
}

// ── Refusing before the first write ──

describe('chaincode replay pre-flight', () => {
  /**
   * The defect this closes: one admin identity submitting five members' private
   * data has four fifths of it denied at endorsement, one warning per record,
   * and still exits 0. The run is refused instead — before anything is written.
   */
  it('refuses a collection the configured identity is not admitted to', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({ collectionMapping: IMPLICIT_MAPPING })).rejects.toThrow(
      /_implicit_org_Org2MSP: would be written as Org1MSP/,
    );
  });

  it('writes nothing to the destination when it refuses', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({ collectionMapping: IMPLICIT_MAPPING }))
      .rejects.toThrow();

    expect(mockWrites).toEqual([]);
  });

  it('names the configuration to add in the refusal', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({ collectionMapping: IMPLICIT_MAPPING })).rejects.toThrow(
      /chaincode.collectionIdentities entry naming that org's MSP ID/,
    );
  });

  it('closes every connection it opened before refusing', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({
      collectionMapping: IMPLICIT_MAPPING,
      collectionIdentities: { '_implicit_org_Org3MSP': { ...ORG2 } },
    })).rejects.toThrow();

    // Both the top-level identity and the (misnamed) collection identity.
    expect(mockDisconnects).toHaveLength(2);
  });

  /**
   * An implicit collection is decided from its name, so the refusal stands even
   * against a destination that will not answer a lifecycle query — a query the
   * client cannot make must not turn a certain denial into a warning.
   */
  it('refuses an implicit collection the destination cannot be asked about', async () => {
    setupPrivate('_implicit_org_Org2MSP');
    mockQueryError = new Error('UNIMPLEMENTED');

    await expect(run({ collectionMapping: IMPLICIT_MAPPING })).rejects.toThrow(
      /_implicit_org_Org2MSP: would be written as Org1MSP/,
    );
  });

  it('refuses a member-only collection whose policy excludes the identity', async () => {
    setupPrivate('assetsCollection');
    mockCommittedChaincodes = [committed('mycc', [
      collection('assetsCollection', { policy: "OR('Org2MSP.member')" }),
    ])];

    await expect(run()).rejects.toThrow(/memberOnlyWrite is on/);
    expect(mockWrites).toEqual([]);
  });

  it('refuses a collection the destination chaincode does not declare', async () => {
    setupPrivate('assetsCollection');

    await expect(run()).rejects.toThrow(
      /declares no collection assetsCollection/,
    );
  });
});

// ── Proceeding ──

describe('chaincode replay pre-flight — proceeding', () => {
  it('replays a collection over the identity configured for it', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    const summary = await run({
      collectionMapping: IMPLICIT_MAPPING,
      collectionIdentities: { '_implicit_org_Org2MSP': { ...ORG2 } },
    });

    expect(summary.totalFailed).toBe(0);
    expect(mockWrites).toEqual([{
      mspId: 'Org2MSP',
      channel: 'dest1',
      fn: 'ImportPrivateData',
      args: ['_implicit_org_Org2MSP', 'pk1'],
    }]);
  });

  it('replays a collection whose policy admits the identity', async () => {
    setupPrivate('assetsCollection');
    mockCommittedChaincodes = [committed('mycc', [
      collection('assetsCollection'),
    ])];

    const summary = await run();

    expect(summary.totalReplayed).toBe(1);
    expect(mockWrites[0].mspId).toBe('Org1MSP');
  });

  /**
   * A public-only replay has no collection to check, but it still has a
   * chaincode to write into — so the destination is queried either way, and
   * 2.18's check is what that query is now for.
   */
  it('queries the destination for a run carrying no private data', async () => {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
    ]);

    const summary = await run();

    expect(summary.totalReplayed).toBe(1);
    expect(ChaincodeDiscoverer as unknown as jest.Mock).toHaveBeenCalled();
    expect(mockQueryCommitted).toHaveBeenCalledWith('dest1');
  });

  /**
   * A collection whose file carries no records writes nothing, so it cannot be
   * denied — refusing on it would block a migration that had nothing to fail at.
   */
  it('ignores a collection whose private file is empty', async () => {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    fs.writeFileSync(
      path.join(
        tmpDir,
        layout.privateStatePath('ch1', 'mycc', '_implicit_org_Org2MSP'),
      ),
      '',
      'utf-8',
    );

    await expect(run()).resolves.toMatchObject({ totalReplayed: 0 });
  });

  /**
   * A destination that will not answer leaves membership unestablished, which is
   * not grounds to refuse: the writes themselves establish it, and they now
   * report the collection and MSP that failed.
   */
  it('proceeds when the destination will not answer a lifecycle query', async () => {
    setupPrivate('assetsCollection');
    mockQueryError = new Error('UNIMPLEMENTED');

    const summary = await run();

    expect(mockQueryCommitted).toHaveBeenCalled();
    expect(summary.totalReplayed).toBe(1);
  });

  /**
   * Two chaincodes on one channel may each have a collection of the same name,
   * and a destination that declares it on one is not thereby declaring it on the
   * other. The pair comes from the records, so each is checked on its own.
   */
  it('checks a shared collection name against each chaincode', async () => {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.privateStatePath('ch1', 'cc-a', 'assetsCollection'), [
      privateRecord('assetsCollection', 'cc-a'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'cc-b', 'assetsCollection'), [
      privateRecord('assetsCollection', 'cc-b'),
    ]);
    mockCommittedChaincodes = [
      committed('cc-a', [collection('assetsCollection')]),
      committed('cc-b'),
    ];

    await expect(run()).rejects.toThrow(
      /ch1\/cc-b\/assetsCollection: cc-b on dest1 declares no collection/,
    );
  });

  it('checks the history files when history is what will be replayed', async () => {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), []);
    // State data for a collection Org1 owns, history data for one Org2 owns:
    // only the history file is in scope, so only it can refuse the run.
    writeRecords(
      layout.privateStatePath('ch1', 'mycc', '_implicit_org_Org1MSP'),
      [privateRecord('_implicit_org_Org1MSP')],
    );
    writeRecords(
      layout.privateHistoryPath('ch1', 'mycc', '_implicit_org_Org2MSP'),
      [{
        ...privateRecord('_implicit_org_Org2MSP'),
        _type: 'private_history',
        txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '2026-01-01T00:00:00Z', isDelete: false,
      } as ExtractionRecord],
    );

    await expect(run({
      replayHistory: true, collectionMapping: IMPLICIT_MAPPING,
    })).rejects.toThrow(
      /_implicit_org_Org2MSP: would be written as Org1MSP/,
    );
  });
});
