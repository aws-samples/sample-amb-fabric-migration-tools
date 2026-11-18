// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChaincodeInfo, ExtractionRecord, ReplayConfig } from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  assertCollectionRouting,
  collectionLabel,
  destinationCollection,
  implicitCollectionOwner,
} from '../src/replay/collection-routing';

// ── Mocks ──
//
// A refusal has to land before the destination is touched, and a mapping has to
// reach the wire, so what these record is the collection name each write named
// and the identity that submitted it — a mapped collection is written by the
// identity configured for its *destination* name, which is the same claim in a
// second place.

interface Write {
  collection: string;
  mspId: string;
}

const writes: Write[] = [];

/** Collection the destination will reject writes to, as a peer would. */
let rejectedCollection: string | null = null;

/** Collections each write named, in submission order. */
function collectionsWritten(): string[] {
  return writes.map((w) => w.collection);
}

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

/** What the destination's migration contract answers the write pre-flight with. */
const EMPTY_KEY_PAGE = Buffer.from('{"keys":[],"bookmark":""}', 'utf-8');

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => {
    let mspId = '';
    return {
      connect: jest.fn(async (cfg: { mspId: string }) => { mspId = cfg.mspId; }),
      getGatewayNetwork: jest.fn(() => ({
        getContract: jest.fn(() => ({
          evaluateTransaction: jest.fn(async () => EMPTY_KEY_PAGE),
          newProposal: jest.fn((_fn: string, opts: { arguments: string[] }) => ({
            endorse: async () => ({
              submit: async () => {
                const collection = opts.arguments[0];
                if (collection === rejectedCollection) {
                  throw new Error(`collection ${collection} refused the write`);
                }
                writes.push({ collection, mspId });
                return { getStatus: async () => COMMITTED };
              },
            }),
          })),
        })),
      })),
      disconnect: jest.fn(),
    };
  }),
}));

/**
 * What the destination reports committed. An implicit collection is declared in
 * no chaincode definition, but the chaincode holding it still has to be
 * committed to have a namespace; an explicit one has to be declared to be
 * written, so the pre-flight has something to find under either name.
 */
const COMMITTED_CHAINCODES: ChaincodeInfo[] = [
  {
    name: 'mycc',
    version: '1.0',
    sequence: 1,
    collections: ['assetsCollection', 'shared'].map((name) => ({
      name,
      policy: "OR('Org1MSP.member')",
      requiredPeerCount: 0,
      maxPeerCount: 1,
      blockToLive: 0,
      memberOnlyRead: true,
      memberOnlyWrite: true,
    })),
  },
];

jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => COMMITTED_CHAINCODES),
  })),
}));

const warnings: string[] = [];

jest.mock('../src/utils/logger', () => {
  const noop = (): void => {};
  const warn = (ctx: unknown, message?: string): void => {
    warnings.push(message ?? String(ctx));
  };
  const make = () => ({
    warn, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ── Fixtures ──

/** The credentials every config needs, none of which this row is about. */
const CREDENTIALS = {
  connectionProfilePath: 'profile.json',
  mspId: 'Org1MSP',
  certPath: 'cert.pem',
  keyPath: 'key.pem',
};

function config(
  chaincode: Partial<NonNullable<ReplayConfig['chaincode']>>,
): NonNullable<ReplayConfig['chaincode']> {
  return { ...CREDENTIALS, ...chaincode };
}

// ── Naming an implicit collection ──

describe('implicitCollectionOwner', () => {
  it('names the one org an implicit collection belongs to', () => {
    expect(implicitCollectionOwner('_implicit_org_Org2MSP')).toBe('Org2MSP');
  });

  it('returns null for a collection defined in the chaincode', () => {
    expect(implicitCollectionOwner('assetCollection')).toBeNull();
  });

  /**
   * A bare prefix names no org, so treating it as implicit would compare the
   * submitting MSP against an empty string and refuse every write to a
   * collection a chaincode is free to declare under that name.
   */
  it('returns null for the prefix with no MSP after it', () => {
    expect(implicitCollectionOwner('_implicit_org_')).toBeNull();
  });
});

// ── Resolving one name to another ──

describe('destinationCollection', () => {
  it('resolves a mapped collection to its destination', () => {
    expect(destinationCollection({ col1: 'renamed' }, 'col1')).toBe('renamed');
  });

  it('leaves a collection with no entry under its own name', () => {
    expect(destinationCollection({ col1: 'renamed' }, 'col2')).toBe('col2');
  });

  it('leaves every collection alone when nothing is mapped', () => {
    expect(destinationCollection(undefined, 'col1')).toBe('col1');
  });

  /**
   * A destination collection has to be namable, and the empty string is not a
   * collection — so an entry left blank falls back to the source name rather
   * than submitting `""` to every private write in that collection.
   */
  it('ignores an entry whose destination is empty', () => {
    expect(destinationCollection({ col1: '' }, 'col1')).toBe('col1');
  });
});

describe('collectionLabel', () => {
  it('shows one name when the mapping changes nothing', () => {
    expect(collectionLabel('col1', 'col1')).toBe('col1');
  });

  it('shows both names when the collection is renamed', () => {
    expect(collectionLabel('col1', 'renamed')).toBe('col1 → renamed');
  });
});

// ── Refusing a run whose private data has nowhere to go ──

describe('assertCollectionRouting — implicit collections', () => {
  /**
   * The defect this closes. `_implicit_org_Org2MSP` is Org2MSP's collection on
   * the *source* network, and the destination's MSP IDs are not the source's, so
   * submitting the name verbatim writes into a collection that exists nowhere.
   */
  it('refuses an implicit collection with no mapping entry', () => {
    expect(() => assertCollectionRouting(
      config({}), ['_implicit_org_Org2MSP'],
    )).toThrow(/no chaincode.collectionMapping entry: _implicit_org_Org2MSP/);
  });

  it('shows the entry to write, keyed by the collection it refused', () => {
    let message = '';
    try {
      assertCollectionRouting(config({}), ['_implicit_org_Org2MSP']);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(
      '{ "_implicit_org_Org2MSP": "_implicit_org_<destination MSP ID>" }',
    );
  });

  it('names every unmapped collection, not the first', () => {
    expect(() => assertCollectionRouting(
      config({
        collectionMapping: { '_implicit_org_Org1MSP': '_implicit_org_Org7MSP' },
      }),
      ['_implicit_org_Org1MSP', '_implicit_org_Org2MSP',
        '_implicit_org_Org3MSP'],
    )).toThrow(/_implicit_org_Org2MSP, _implicit_org_Org3MSP/);
  });

  /**
   * The entry is required even where it changes nothing, because writing it out
   * is the difference between an intended coincidence and an unnoticed one.
   */
  it('accepts an implicit collection mapped to itself', () => {
    expect(() => assertCollectionRouting(
      config({
        collectionMapping: { '_implicit_org_Org2MSP': '_implicit_org_Org2MSP' },
      }),
      ['_implicit_org_Org2MSP'],
    )).not.toThrow();
  });

  /**
   * An entry left blank resolves back to the source name, so accepting it as an
   * entry would submit the source MSP ID's collection name to a destination that
   * has nothing under it — the write this refusal exists to prevent.
   */
  it('refuses an implicit collection whose entry names no destination', () => {
    expect(() => assertCollectionRouting(
      config({ collectionMapping: { '_implicit_org_Org2MSP': '' } }),
      ['_implicit_org_Org2MSP'],
    )).toThrow(/no chaincode.collectionMapping entry/);
  });

  it('accepts an implicit collection mapped onto an explicit one', () => {
    expect(() => assertCollectionRouting(
      config({ collectionMapping: { '_implicit_org_Org2MSP': 'shared' } }),
      ['_implicit_org_Org2MSP'],
    )).not.toThrow();
  });

  /**
   * Only implicit names carry a source MSP ID, so only they are mandatory. A
   * chaincode's own collection is named the same on any network that commits
   * that chaincode, and requiring an entry for it would make every config list
   * every collection to say nothing.
   */
  it('requires no entry for a collection the chaincode declares', () => {
    expect(() => assertCollectionRouting(config({}), ['assetsCollection']))
      .not.toThrow();
  });

  /**
   * Scoped to the collections carrying data, like `channelMapping` is scoped to
   * the channels in the run: a collection whose file is empty writes nothing, so
   * it has nothing to route and no missing entry to refuse over.
   */
  it('refuses nothing when no collection is in scope', () => {
    expect(() => assertCollectionRouting(config({}), [])).not.toThrow();
  });
});

describe('assertCollectionRouting — merges', () => {
  /**
   * A collection is one keyspace within its chaincode. Two of them mapped onto
   * one destination share it, so their copies of a shared key overwrite each
   * other and the survivor is whichever file replayed last — with no failure
   * anywhere to say so.
   */
  it('refuses two source collections mapped onto one destination', () => {
    expect(() => assertCollectionRouting(
      config({ collectionMapping: { colA: 'shared', colB: 'shared' } }),
      ['colA', 'colB'],
    )).toThrow(/colA \+ colB → shared/);
  });

  /**
   * Resolved rather than declared. `{ "colA": "colB" }` names one destination
   * once, but `colB` resolves to itself, so the merge is the same one — and
   * comparing map values alone would miss it.
   */
  it('refuses a mapping onto a collection that is in scope unmapped', () => {
    expect(() => assertCollectionRouting(
      config({ collectionMapping: { colA: 'colB' } }),
      ['colA', 'colB'],
    )).toThrow(/colA \+ colB → colB/);
  });

  it('accepts a mapping onto a collection this run leaves out', () => {
    expect(() => assertCollectionRouting(
      config({ collectionMapping: { colA: 'colB' } }), ['colA'],
    )).not.toThrow();
  });

  /**
   * On Fabric 2.x every chaincode on a channel has its own
   * `_implicit_org_<MSPID>` under the same name, so one collection name arrives
   * once per chaincode. Those are separate keyspaces in separate namespaces —
   * treating the repeated name as a merge would refuse every 2.x migration of
   * more than one chaincode.
   */
  it('accepts one collection name arriving from two chaincodes', () => {
    expect(() => assertCollectionRouting(
      config({
        collectionMapping: { '_implicit_org_Org1MSP': '_implicit_org_Org7MSP' },
      }),
      ['_implicit_org_Org1MSP', '_implicit_org_Org1MSP'],
    )).not.toThrow();
  });

  it('names every merge it found, and the way out', () => {
    let message = '';
    try {
      assertCollectionRouting(
        config({ collectionMapping: { colA: 'shared', colB: 'shared' } }),
        ['colA', 'colB'],
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('replayed last');
    expect(message).toContain('own destination collection');
  });
});

// ── Through a whole replay run ──

describe('chaincode replay — collection routing', () => {
  let tmpDir: string;
  let layout: FileLayoutManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-routing-test-'));
    layout = new FileLayoutManager(tmpDir);
    writes.length = 0;
    warnings.length = 0;
    rejectedCollection = null;
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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

  function writeRecords(relPath: string, records: ExtractionRecord[]): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  /** A run carrying one private key in `collection`, and no public data. */
  function setupPrivate(collection: string): void {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.privateStatePath('ch1', 'mycc', collection), [
      {
        _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
        collection, key: 'pk1', value: 'pv1',
      },
    ]);
  }

  /** A run carrying one private write and one private delete in `collection`. */
  function setupPrivateHistory(collection: string): void {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), []);
    writeRecords(layout.privateHistoryPath('ch1', 'mycc', collection), [
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection, key: 'pk1', value: 'pv1', txId: 'tx1', txIndex: 0,
        blockNumber: 1, timestamp: '2026-01-01T00:00:00Z', isDelete: false,
      },
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection, key: 'pk1', value: '', txId: 'tx2', txIndex: 0,
        blockNumber: 2, timestamp: '2026-01-01T00:00:01Z', isDelete: true,
      },
    ]);
  }

  /** The mapping and the identity a run writing `_implicit_org_Org7MSP` needs. */
  const TO_ORG7 = {
    collectionMapping: { '_implicit_org_Org1MSP': '_implicit_org_Org7MSP' },
    collectionIdentities: {
      '_implicit_org_Org7MSP': {
        mspId: 'Org7MSP', certPath: 'org7-cert.pem', keyPath: 'org7-key.pem',
      },
    },
  };

  function run(
    chaincode: Partial<NonNullable<ReplayConfig['chaincode']>>,
  ): Promise<any> {
    return new ReplayOrchestrator({
      adapter: 'chaincode',
      inputDir: tmpDir,
      chaincode: config({ channelMapping: { ch1: 'dest1' }, ...chaincode }),
    }).run();
  }

  it('refuses an unmapped implicit collection', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({})).rejects.toThrow(/no chaincode.collectionMapping/);
  });

  /**
   * Where the refusal has to land. Writes submitted under a collection name the
   * destination does not have fail one record at a time, and the failure says
   * nothing about the name being the problem.
   */
  it('refuses before writing anything', async () => {
    setupPrivate('_implicit_org_Org2MSP');

    await expect(run({})).rejects.toThrow();

    expect(collectionsWritten()).toEqual([]);
  });

  /** What the row is for: the destination's own name reaches the peer. */
  it('submits the destination collection name', async () => {
    setupPrivate('_implicit_org_Org1MSP');

    const summary = await run(TO_ORG7);

    expect(summary.totalFailed).toBe(0);
    expect(collectionsWritten()).toEqual(['_implicit_org_Org7MSP']);
  });

  /**
   * `collectionIdentities` is keyed by the destination name, because the policy
   * that admits a write is the destination collection's. Resolving the identity
   * from the source name instead would submit a mapped collection as the default
   * identity and be denied by a policy the entry was added to satisfy.
   */
  it('submits over the identity keyed by the destination collection', async () => {
    setupPrivate('_implicit_org_Org1MSP');

    await run(TO_ORG7);

    expect(writes).toEqual([
      { collection: '_implicit_org_Org7MSP', mspId: 'Org7MSP' },
    ]);
  });

  /**
   * An identity configured for the name replay will submit is in use, not unused
   * — warning about it would send an operator to correct the one entry that is
   * already right.
   */
  it('does not warn about an identity keyed by the destination', async () => {
    setupPrivate('_implicit_org_Org1MSP');

    await run(TO_ORG7);

    expect(warnings.join('\n')).not.toContain('chaincode.collectionIdentities');
  });

  /**
   * The org-level form reaches the peer exactly as the per-collection one does:
   * one member mapping and one org's credentials, no per-collection entry.
   */
  it('routes and signs through mspMapping and orgIdentities alone', async () => {
    setupPrivate('_implicit_org_Org1MSP');

    const summary = await run({
      mspMapping: { Org1MSP: 'Org7MSP' },
      orgIdentities: {
        Org7MSP: { certPath: 'org7-cert.pem', keyPath: 'org7-key.pem' },
      },
    });

    expect(summary.totalFailed).toBe(0);
    expect(writes).toEqual([
      { collection: '_implicit_org_Org7MSP', mspId: 'Org7MSP' },
    ]);
    expect(warnings.join('\n')).not.toContain('chaincode.collectionIdentities');
  });

  /** The destination would purge these writes before the run ends. */
  it('warns before writing a collection the destination purges', async () => {
    setupPrivate('assetsCollection');
    const saved = COMMITTED_CHAINCODES[0].collections[0].blockToLive;
    COMMITTED_CHAINCODES[0].collections[0].blockToLive = 40;
    try {
      await run({});
    } finally {
      COMMITTED_CHAINCODES[0].collections[0].blockToLive = saved;
    }

    expect(warnings.join('\n')).toMatch(
      /mycc\/assetsCollection on dest1 purges private data after 40 blocks.*blockToLive 0/s,
    );
  });

  it('does not warn about a destination collection that never purges', async () => {
    setupPrivate('assetsCollection');

    await run({});

    expect(warnings.join('\n')).not.toContain('purges private data');
  });

  it('submits the source name when nothing maps it', async () => {
    setupPrivate('assetsCollection');

    await run({});

    expect(collectionsWritten()).toEqual(['assetsCollection']);
  });

  /** Both history paths carry the mapping too — a write and a tombstone. */
  it('submits history and deletes under the destination name', async () => {
    setupPrivateHistory('_implicit_org_Org1MSP');

    const summary = await run({ ...TO_ORG7, replayHistory: true });

    expect(summary.totalFailed).toBe(0);
    expect(collectionsWritten()).toEqual([
      '_implicit_org_Org7MSP', '_implicit_org_Org7MSP',
    ]);
  });

  /**
   * A failure names both collections. The source name alone cannot be matched
   * against the destination's chaincode definition, and the destination name
   * alone cannot be matched against the file the record came from.
   */
  it('names both collections when a private write fails', async () => {
    setupPrivate('_implicit_org_Org1MSP');
    rejectedCollection = '_implicit_org_Org7MSP';

    const summary = await run(TO_ORG7);

    expect(summary.totalFailed).toBe(1);
    expect(summary.failures[0].error).toContain(
      '_implicit_org_Org1MSP → _implicit_org_Org7MSP',
    );
    expect(summary.failures[0].mspId).toBe('Org7MSP');
  });

  it('refuses a merge before writing either collection', async () => {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    for (const collection of ['colA', 'colB']) {
      writeRecords(layout.privateStatePath('ch1', 'mycc', collection), [
        {
          _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
          collection, key: 'pk1', value: 'pv1',
        },
      ]);
    }

    await expect(run({
      collectionMapping: { colA: 'shared', colB: 'shared' },
    })).rejects.toThrow(/same destination collection/);

    expect(collectionsWritten()).toEqual([]);
  });
});
