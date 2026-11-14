import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChaincodeAdapter } from '../src/replay/adapters/chaincode-adapter';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';
import {
  ExtractionRecord,
  PublicStateRecord,
} from '../src/types';
import {
  BATCH_ENTRY_HEADER_BYTES, MAX_BATCH_BYTES,
} from '../src/replay/state-batch';
import { decodeStateBatch, writtenKeys } from './helpers/state-batch';

const creator = {
  mspId: 'Org1MSP',
  commonName: 'admin',
  org: 'org1',
  certFingerprint: 'sha256:abc',
};

// ─── ChaincodeAdapter tests (mock Network) ───

/** The (chaincode, contract) pair the adapter routes to unless told otherwise. */
const DEFAULT_CHAINCODE = 'mycc';
const DEFAULT_CONTRACT = 'MigrationContract';

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 7n,
  transactionId: 'tx-committed',
};

/**
 * A Network whose `getContract` returns a distinct contract per
 * (chaincode, contract) pair, and records which pair each call arrived on.
 *
 * Returning one shared contract for every call — as this helper used to — makes
 * mis-routing invisible: a record submitted to the wrong chaincode, or to the
 * customer's own contract instead of the migration contract, lands in the same
 * place as a correct one and every assertion still passes.
 *
 * Every write goes through the same flow the adapter uses —
 * newProposal → endorse → submit → getStatus — because values travel as
 * transient data, which `submitTransaction` cannot carry. Two seams stand in
 * for the two ways a write fails for real: `onWrite` throws where a peer or
 * the orderer would reject the transaction, and `status` reports a transaction
 * that was ordered but failed validation.
 *
 * `submitted` records a write at the point it reaches the orderer, not when the
 * proposal is built, so a write that failed endorsement leaves nothing behind —
 * a test asserting what the destination received cannot be satisfied by an
 * attempt. Use the `newProposal` mock to assert attempts.
 */
function makeMockNetwork() {
  const submitted: Array<{
    chaincode: string; contract: string; fn: string; args: any[]; transient: any;
  }> = [];

  const contracts = new Map<string, any>();

  /**
   * The contract for one pair, created on first request.
   *
   * Stable identity per pair, so a test can stub a specific chaincode's
   * behaviour and still have the adapter reach the stub.
   */
  function contractFor(chaincode: string, contract = DEFAULT_CONTRACT) {
    const key = `${chaincode}\x00${contract}`;
    const existing = contracts.get(key);
    if (existing) return existing;

    const created: any = {
      onWrite: jest.fn(async (
        _fn: string, _args: any[], _transient: any,
      ) => {}),
      status: COMMITTED,
      newProposal: jest.fn((fn: string, opts: any) => ({
        endorse: async () => {
          await created.onWrite(fn, opts.arguments, opts.transientData);
          return {
            submit: async () => {
              submitted.push({
                chaincode,
                contract,
                fn,
                args: opts.arguments,
                transient: opts.transientData,
              });
              return { getStatus: async () => created.status };
            },
          };
        },
      })),
    };
    contracts.set(key, created);
    return created;
  }

  const network = {
    getContract: jest.fn((chaincode: string, contract: string) =>
      contractFor(chaincode, contract),
    ),
  };

  return {
    network,
    submitted,
    contractFor,
    /** The default pair, pre-created so a test can stub what the adapter uses. */
    mockContract: contractFor(DEFAULT_CHAINCODE, DEFAULT_CONTRACT),
  };
}

/** The public value the adapter sent, as a string. */
function publicValue(write: { transient: any }): string {
  return write.transient.public_value.toString('utf-8');
}

// ── Contract routing ───
//
// A Fabric-to-Fabric replay writes into the customer's own chaincode
// namespaces, so the (chaincode, contract) pair each record is submitted on is
// load-bearing: the destination chaincode must carry the same name as the
// source, and the migration functions live on a separate contract beside the
// customer's own. Neither could be asserted while every getContract() call
// returned the same object.

describe('ChaincodeAdapter — contract routing', () => {
  function adapterFor(network: any, overrides: Record<string, unknown> = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      ...overrides,
    } as any);
  }

  it('routes each record to its own source chaincode namespace', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'assets', key: 'k1', value: 'v1' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'trades', key: 'k2', value: 'v2' },
    ] as ExtractionRecord[]);

    expect(submitted).toHaveLength(2);
    expect(
      submitted.map((s) => [s.chaincode, s.args[0]]).sort(),
    ).toEqual([['assets', 'k1'], ['trades', 'k2']]);
  });

  it('does not leak one chaincode\'s writes into another', async () => {
    const { network, contractFor } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'assets', key: 'k1', value: 'v1' },
    ] as ExtractionRecord[]);

    expect(contractFor('assets').newProposal).toHaveBeenCalledTimes(1);
    expect(contractFor('trades').newProposal).not.toHaveBeenCalled();
  });

  it('submits on the configured migration contract, not the default', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { migrationContract: 'LedgerMigration' });

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'assets', key: 'k1', value: 'v1' },
    ] as ExtractionRecord[]);

    expect(submitted[0].contract).toBe('LedgerMigration');
  });

  it('routes private writes to the record\'s chaincode too', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      {
        _type: 'private_state',
        channel: 'ch1',
        chaincode: 'trades',
        collection: 'col1',
        key: 'pk1',
        value: 'pv1',
      },
    ] as ExtractionRecord[]);

    expect(submitted[0].chaincode).toBe('trades');
    expect(submitted[0].contract).toBe('MigrationContract');
  });

  it('keeps a per-key queue on one chaincode when another fails', async () => {
    const { network, contractFor, submitted } = makeMockNetwork();
    contractFor('assets').onWrite = jest.fn(async () => {
      throw new Error('assets chaincode not committed at the destination');
    });
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'assets', key: 'k1', value: 'v1' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'trades', key: 'k2', value: 'v2' },
    ] as ExtractionRecord[]);

    const stats = adapter.getStats();
    expect(stats.totalReplayed).toBe(1);
    expect(stats.totalFailed).toBe(1);
    expect(stats.failedKeys[0].chaincode).toBe('assets');
    // The healthy namespace still committed its write.
    expect(submitted.map((s) => s.chaincode)).toEqual(['trades']);
  });
});

// ── keyMapping resolution ───
//
// Row 2.8. Two resolutions stand between a `keyMapping` entry and a
// transaction, and `replay` used to skip both. Which entry applies is a question
// about `(channel, chaincode)`, because a chaincode name is only unique within a
// channel. Which contract answers is a question about the entry's value, because
// Fabric namespaces functions by contract — so `"SampleAssets:StoreAsset"`
// submitted as a function name is rejected by the peer on every record.

describe('ChaincodeAdapter — keyMapping resolution', () => {
  function adapterFor(network: any, keyMapping: any, overrides = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channelMapping: { 'orders-ch': 'orders-ch', 'trades-ch': 'trades-ch' },
      keyMapping,
      concurrency: 10,
      ...overrides,
    } as any);
  }

  function publicRecord(channel: string, chaincode: string, key: string) {
    return {
      _type: 'public_state', channel, chaincode, key, value: 'v',
    } as ExtractionRecord;
  }

  it('sends one chaincode name to two functions on two channels', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      'orders-ch': { marketplace: 'PutState' },
      'trades-ch': { marketplace: 'ImportLegacyState' },
    });

    await adapter.replayBatch([
      publicRecord('orders-ch', 'marketplace', 'k1'),
      publicRecord('trades-ch', 'marketplace', 'k2'),
    ]);

    expect(submitted.map((s) => [s.args[0], s.fn]).sort()).toEqual([
      ['k1', 'PutState'],
      ['k2', 'ImportLegacyState'],
    ]);
  });

  it('does not apply another channel\'s mapping', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      'orders-ch': { marketplace: 'ImportLegacyState' },
    });

    await adapter.replayBatch([publicRecord('trades-ch', 'marketplace', 'k1')]);

    expect(submitted[0].fn).toBe('PutState');
  });

  it('submits a qualified mapping on the contract it names', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      'orders-ch': { marketplace: 'SampleAssets:StoreAsset' },
    });

    await adapter.replayBatch([publicRecord('orders-ch', 'marketplace', 'k1')]);

    expect(network.getContract)
      .toHaveBeenCalledWith('marketplace', 'SampleAssets');
    expect(submitted[0].contract).toBe('SampleAssets');
    expect(submitted[0].fn).toBe('StoreAsset');
  });

  it('keeps an unqualified mapping on the migration contract', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      'orders-ch': { marketplace: 'StoreAsset' },
    });

    await adapter.replayBatch([publicRecord('orders-ch', 'marketplace', 'k1')]);

    expect(submitted[0].contract).toBe('MigrationContract');
    expect(submitted[0].fn).toBe('StoreAsset');
  });

  it('resolves an unqualified mapping to a renamed migration contract', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(
      network,
      { 'orders-ch': { marketplace: 'StoreAsset' } },
      { migrationContract: 'LedgerMigration' },
    );

    await adapter.replayBatch([publicRecord('orders-ch', 'marketplace', 'k1')]);

    expect(submitted[0].contract).toBe('LedgerMigration');
  });

  it('routes history writes through the same resolution', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(
      network,
      { 'trades-ch': { marketplace: 'SampleAssets:StoreAsset' } },
      { replayHistory: true },
    );

    await adapter.replayBatch([{
      _type: 'public_history', channel: 'trades-ch', chaincode: 'marketplace',
      key: 'k1', value: 'v1', txId: 'tx1', txIndex: 0, blockNumber: 5,
      timestamp: '2025-01-01T00:00:00Z', isDelete: false, creator,
    }] as ExtractionRecord[]);

    expect(submitted[0].contract).toBe('SampleAssets');
    expect(submitted[0].fn).toBe('StoreAsset');
  });

  /**
   * A mapping is submitted where it points, wrong or not: a rejection from the
   * contract the operator named is the signal that the name is wrong, and
   * quietly retrying on the migration contract would hide it behind a success.
   */
  it('does not fall back to the migration contract when the named one rejects',
    async () => {
      const { network, contractFor } = makeMockNetwork();
      contractFor('marketplace', 'SampleAssets').onWrite = jest.fn(async () => {
        throw new Error('function StoreAsset not found');
      });
      const adapter = adapterFor(network, {
        'orders-ch': { marketplace: 'SampleAssets:StoreAsset' },
      });

      await adapter.replayBatch([
        publicRecord('orders-ch', 'marketplace', 'k1'),
      ]);

      expect(adapter.getStats().failedKeys).toHaveLength(1);
      expect(contractFor('marketplace', 'MigrationContract').newProposal)
        .not.toHaveBeenCalled();
    });

  /**
   * Private writes are the migration contract's own — `ImportPrivateData` takes
   * the value as transient data, which no application function is written to
   * accept — so `keyMapping` must not divert them.
   */
  it('leaves private writes on the migration contract', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      'orders-ch': { marketplace: 'SampleAssets:StoreAsset' },
    });

    await adapter.replayBatch([{
      _type: 'private_state', channel: 'orders-ch', chaincode: 'marketplace',
      collection: 'col1', key: 'pk1', value: 'pv1',
    }] as ExtractionRecord[]);

    expect(submitted[0].contract).toBe('MigrationContract');
    expect(submitted[0].fn).toBe('ImportPrivateData');
  });
});

// ── deleteMapping resolution ───
//
// Row 2.10. A tombstone used to be replayed as `DeleteState` on the migration
// contract no matter what the config said, so a destination whose delete lives
// elsewhere failed on every one of them. It resolves through its own map rather
// than `keyMapping`, because a delete is not a write with an empty value: it
// takes the key alone and carries no transient data, so the write function
// submitted for a tombstone would write where the source deleted.

describe('ChaincodeAdapter — deleteMapping resolution', () => {
  function adapterFor(network: any, overrides: Record<string, unknown> = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channelMapping: { 'orders-ch': 'orders-ch', 'trades-ch': 'trades-ch' },
      concurrency: 10,
      replayHistory: true,
      ...overrides,
    } as any);
  }

  /** A tombstone: a history record whose write removed the key. */
  function deleteRecord(channel: string, key: string) {
    return {
      _type: 'public_history', channel, chaincode: 'marketplace',
      key, value: '', txId: `tx-${key}`, txIndex: 0, blockNumber: 9,
      timestamp: '2026-01-01T00:00:00Z', isDelete: true, creator,
    } as ExtractionRecord;
  }

  it('submits a delete on the contract and function deleteMapping names', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      deleteMapping: { 'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' } },
    });

    await adapter.replayBatch([deleteRecord('orders-ch', 'k1')]);

    expect(submitted[0].contract).toBe('SampleAssets');
    expect(submitted[0].fn).toBe('RemoveAsset');
    expect(submitted[0].args).toEqual(['k1']);
    expect(submitted[0].transient).toBeUndefined();
  });

  it('sends one chaincode name to two delete functions on two channels', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      deleteMapping: {
        'orders-ch': { marketplace: 'RemoveOrder' },
        'trades-ch': { marketplace: 'RemoveTrade' },
      },
    });

    await adapter.replayBatch([
      deleteRecord('orders-ch', 'k1'),
      deleteRecord('trades-ch', 'k2'),
    ]);

    expect(submitted.map((s) => [s.args[0], s.fn]).sort()).toEqual([
      ['k1', 'RemoveOrder'],
      ['k2', 'RemoveTrade'],
    ]);
  });

  /**
   * The reason the map is separate. `keyMapping`'s function takes its value from
   * transient data, so submitting it for a tombstone writes an empty value where
   * the source deleted the key — a live key at the destination that the source
   * ledger does not have.
   */
  it('does not submit a delete through keyMapping', async () => {
    const { network, submitted, contractFor } = makeMockNetwork();
    const adapter = adapterFor(network, {
      keyMapping: { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
    });

    await adapter.replayBatch([deleteRecord('orders-ch', 'k1')]);

    expect(submitted[0].contract).toBe('MigrationContract');
    expect(submitted[0].fn).toBe('DeleteState');
    expect(contractFor('marketplace', 'SampleAssets').newProposal)
      .not.toHaveBeenCalled();
  });

  it('deletes with the migration contract when no entry names a function', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      deleteMapping: { 'trades-ch': { marketplace: 'RemoveTrade' } },
    });

    await adapter.replayBatch([deleteRecord('orders-ch', 'k1')]);

    expect(submitted[0].contract).toBe('MigrationContract');
    expect(submitted[0].fn).toBe('DeleteState');
  });

  /**
   * A write in the same history is unaffected: the two maps answer two
   * questions, and a run needs both to reproduce a key that was written and
   * later removed.
   */
  it('leaves a history write on its own mapping', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      keyMapping: { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
      deleteMapping: { 'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' } },
    });

    await adapter.replayBatch([
      {
        _type: 'public_history', channel: 'orders-ch', chaincode: 'marketplace',
        key: 'k1', value: 'v1', txId: 'tx1', txIndex: 0, blockNumber: 8,
        timestamp: '2026-01-01T00:00:00Z', isDelete: false, creator,
      } as ExtractionRecord,
      deleteRecord('orders-ch', 'k1'),
    ]);

    expect(submitted.map((s) => s.fn)).toEqual(['StoreAsset', 'RemoveAsset']);
  });

  /**
   * Private deletes stay where `ImportPrivateData` is. The private write carries
   * its value as transient data under the migration contract's own wire
   * convention and cannot be pointed elsewhere, so pointing the delete elsewhere
   * would split a pair that has to move together.
   */
  it('leaves a private delete on the migration contract', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      deleteMapping: { 'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' } },
    });

    await adapter.replayBatch([{
      _type: 'private_history', channel: 'orders-ch', chaincode: 'marketplace',
      collection: 'col1', key: 'pk1', value: '', txId: 'tx-p', txIndex: 0,
      blockNumber: 9, timestamp: '2026-01-01T00:00:00Z', isDelete: true,
    }] as ExtractionRecord[]);

    expect(submitted[0].contract).toBe('MigrationContract');
    expect(submitted[0].fn).toBe('DeletePrivateData');
  });
});

// ── Per-collection identities and the collection-aware partition ───
//
// A migration carrying several members' private data cannot submit all of it as
// one org: a collection with `memberOnlyWrite` admits writes only from an MSP
// its policy names, and `_implicit_org_<MSPID>` admits only that one MSP. So a
// collection can carry its own identity — a different gateway, usually a peer of
// the owning org — and a denial is per collection, not per key.

describe('ChaincodeAdapter — per-collection identities', () => {
  function adapterFor(
    network: any,
    identities: Map<string, any> = new Map(),
    overrides: Record<string, unknown> = {},
  ) {
    return new ChaincodeAdapter(
      network as any,
      {
        connectionProfilePath: '',
        mspId: 'Org1MSP',
        certPath: '',
        keyPath: '',
        channel: 'ch1',
        keyMapping: {},
        concurrency: 10,
        ...overrides,
      } as any,
      identities,
    );
  }

  function privateRecord(
    collection: string,
    key = 'pk1',
    value = 'pv1',
  ): ExtractionRecord {
    return {
      _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
      collection, key, value,
    } as ExtractionRecord;
  }

  const publicRecord: ExtractionRecord = {
    _type: 'public_state', channel: 'ch1', chaincode: 'mycc',
    key: 'k1', value: 'v1',
  } as ExtractionRecord;

  it('submits a collection\'s writes over the identity configured for it', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
    ]));

    await adapter.replayBatch([privateRecord('_implicit_org_Org2MSP')]);

    // The values reached Org2's peer, and never touched Org1's.
    expect(org2.submitted.map((s) => s.args)).toEqual([
      ['_implicit_org_Org2MSP', 'pk1'],
    ]);
    expect(org1.submitted).toEqual([]);
  });

  it('keeps public writes on the top-level identity', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
    ]));

    await adapter.replayBatch([publicRecord]);

    expect(org1.submitted.map((s) => s.args)).toEqual([['k1']]);
    expect(org2.submitted).toEqual([]);
  });

  it('submits a collection with no entry as the top-level identity', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
    ]));

    await adapter.replayBatch([privateRecord('sharedCollection')]);

    expect(org1.submitted).toHaveLength(1);
    expect(org2.submitted).toEqual([]);
  });

  it('splits a batch across the identities its collections belong to', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    const org3 = makeMockNetwork();
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
      ['_implicit_org_Org3MSP', { mspId: 'Org3MSP', network: org3.network }],
    ]));

    await adapter.replayBatch([
      publicRecord,
      privateRecord('_implicit_org_Org2MSP', 'pk2'),
      privateRecord('_implicit_org_Org3MSP', 'pk3'),
      privateRecord('sharedCollection', 'pk4'),
    ]);

    expect(adapter.getStats().totalReplayed).toBe(4);
    expect(org1.submitted.map((s) => s.args.at(-1)).sort())
      .toEqual(['k1', 'pk4']);
    expect(org2.submitted.map((s) => s.args.at(-1))).toEqual(['pk2']);
    expect(org3.submitted.map((s) => s.args.at(-1))).toEqual(['pk3']);
  });

  /**
   * "This collection was denied" is only actionable alongside the identity it
   * was denied for — without the MSP, a missing `collectionIdentities` entry
   * reads exactly like a wrong one.
   */
  it('attributes a failure to the MSP that submitted it', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    org2.contractFor('mycc').onWrite = jest.fn(async () => {
      throw new Error('collection denied the writer');
    });
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
    ]));

    await adapter.replayBatch([privateRecord('_implicit_org_Org2MSP')]);

    const failure = adapter.getStats().failedKeys[0];
    expect(failure.mspId).toBe('Org2MSP');
    expect(failure.collection).toBe('_implicit_org_Org2MSP');
  });

  it('attributes a failure on an unconfigured collection to the top-level MSP', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(async () => {
      throw new Error('collection denied the writer');
    });
    const adapter = adapterFor(org1.network, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: makeMockNetwork().network }],
    ]));

    await adapter.replayBatch([privateRecord('sharedCollection')]);

    expect(adapter.getStats().failedKeys[0].mspId).toBe('Org1MSP');
  });

  it('attributes a public failure to the top-level MSP', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(async () => {
      throw new Error('rejected');
    });
    const adapter = adapterFor(org1.network);

    await adapter.replayBatch([publicRecord]);

    const failure = adapter.getStats().failedKeys[0];
    expect(failure.mspId).toBe('Org1MSP');
    expect(failure.collection).toBeUndefined();
  });

  /**
   * Row 2.7. Keys are the unit of ordering, collections are the unit of denial.
   * Partitioning on the key alone puts several collections' records for one key
   * in a single queue, so the first collection the identity may not write takes
   * every collection behind it down with it — and those were writable.
   */
  it('does not skip a writable collection behind a denied one', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(
      async (_fn: string, args: string[]) => {
        if (args[0] === 'deniedCollection') throw new Error('not a member');
      },
    );
    const adapter = adapterFor(org1.network, new Map(), { concurrency: 1 });

    // Same chaincode, same key — only the collection differs.
    await adapter.replayBatch([
      privateRecord('deniedCollection', 'sharedKey'),
      privateRecord('writableCollection', 'sharedKey'),
    ]);

    const stats = adapter.getStats();
    expect(stats.totalReplayed).toBe(1);
    expect(stats.totalFailed).toBe(1);
    expect(org1.submitted.map((s) => s.args)).toEqual([
      ['writableCollection', 'sharedKey'],
    ]);
    // Nothing was abandoned: the writable collection was never behind the
    // denied one.
    expect(stats.failedKeys).toHaveLength(1);
    expect(stats.failedKeys[0].skippedAfter).toBe(0);
  });

  it('does not skip a private key behind a failed public key of the same name', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(
      async (fn: string) => {
        if (fn === 'PutState') throw new Error('public write rejected');
      },
    );
    const adapter = adapterFor(org1.network, new Map(), { concurrency: 1 });

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
      privateRecord('col1', 'k1'),
    ] as ExtractionRecord[]);

    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(org1.submitted.map((s) => s.fn)).toEqual(['ImportPrivateData']);
  });

  /**
   * The collection widens the partition without splitting it: writes to one
   * collection's key are still one ordered queue, so a failure still abandons
   * the writes that depended on it rather than submitting them out of order.
   */
  it('still stops one collection\'s key queue at its first failure', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(async () => {
      throw new Error('not a member');
    });
    const adapter = adapterFor(org1.network, new Map(), { concurrency: 1 });

    await adapter.replayBatch([
      privateRecord('col1', 'pk1', 'first'),
      privateRecord('col1', 'pk1', 'second'),
      privateRecord('col1', 'pk1', 'third'),
    ]);

    const stats = adapter.getStats();
    expect(stats.totalFailed).toBe(3);
    expect(stats.failedKeys).toHaveLength(1);
    expect(stats.failedKeys[0].skippedAfter).toBe(2);
    expect(org1.contractFor('mycc').newProposal).toHaveBeenCalledTimes(1);
  });

  /**
   * `\x00` delimits the partition even though composite keys contain it: Fabric
   * restricts chaincode and collection names to word characters, so the first
   * two separators are always the field boundaries. Without that, a key whose
   * text spans the boundary would collide with a different collection's key and
   * be serialised behind it.
   */
  it('keeps composite keys containing NUL in separate queues', async () => {
    const org1 = makeMockNetwork();
    org1.contractFor('mycc').onWrite = jest.fn(
      async (_fn: string, args: string[]) => {
        if (args[1] === '\x00asset\x001') throw new Error('not a member');
      },
    );
    // One record per transaction, so the failure lands on one key's queue.
    const adapter = adapterFor(org1.network, new Map(), {
      concurrency: 1, writeBatchSize: 1,
    });

    await adapter.replayBatch([
      privateRecord('col1', '\x00asset\x001'),
      privateRecord('col1', '\x00asset\x002'),
    ]);

    const stats = adapter.getStats();
    expect(stats.totalReplayed).toBe(1);
    expect(stats.failedKeys[0].skippedAfter).toBe(0);
  });
});

// ── Owner endorsement ───
//
// An implicit collection's endorsement policy names its owner's peers, and its
// submitter is not checked. So with `ownerEndorsement` the lead writes another
// org's implicit collection as itself, and every proposal names the owner as
// the endorsing org — left to choose, the gateway may pick the lead's own peer,
// which the policy refuses and which cannot store the value.

describe('ChaincodeAdapter — ownerEndorsement', () => {
  function adapterFor(
    network: any,
    overrides: Record<string, unknown> = {},
    identities: Map<string, any> = new Map(),
  ) {
    return new ChaincodeAdapter(
      network as any,
      {
        connectionProfilePath: '', mspId: 'Org1MSP', certPath: '', keyPath: '',
        channel: 'ch1', keyMapping: {}, concurrency: 1,
        ownerEndorsement: true,
        ...overrides,
      } as any,
      identities,
    );
  }

  function privateRecord(collection: string, key: string): ExtractionRecord {
    return {
      _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
      collection, key, value: 'pv',
    } as ExtractionRecord;
  }

  /** The endorsingOrganizations of every proposal, in order. */
  function endorsers(mock: ReturnType<typeof makeMockNetwork>) {
    return mock.contractFor('mycc').newProposal.mock.calls
      .map(([, opts]: [string, any]) => opts.endorsingOrganizations);
  }

  it('names the owner as endorser for another org\'s implicit collection', async () => {
    const org1 = makeMockNetwork();
    await adapterFor(org1.network).replayBatch([
      privateRecord('_implicit_org_Org2MSP', 'single'),
    ]);

    expect(org1.submitted.map((s) => s.args)).toEqual([
      ['_implicit_org_Org2MSP', 'single'],
    ]);
    expect(endorsers(org1)).toEqual([['Org2MSP']]);
  });

  it('names the owner on a batch too', async () => {
    const org1 = makeMockNetwork();
    await adapterFor(org1.network).replayBatch([
      privateRecord('_implicit_org_Org3MSP', 'a'),
      privateRecord('_implicit_org_Org3MSP', 'b'),
    ]);

    expect(org1.submitted.map((s) => s.fn)).toEqual(['ImportPrivateDataBatch']);
    expect(endorsers(org1)).toEqual([['Org3MSP']]);
  });

  it('leaves the lead\'s own, explicit and public writes to the gateway', async () => {
    const org1 = makeMockNetwork();
    await adapterFor(org1.network, { writeBatchSize: 1 }).replayBatch([
      privateRecord('_implicit_org_Org1MSP', 'own'),
      privateRecord('shared', 'explicit'),
      {
        _type: 'public_state', channel: 'ch1', chaincode: 'mycc',
        key: 'pub', value: 'v',
      } as ExtractionRecord,
    ]);

    expect(org1.submitted).toHaveLength(3);
    expect(endorsers(org1)).toEqual([undefined, undefined, undefined]);
  });

  it('defers to an identity configured for the owner', async () => {
    const org1 = makeMockNetwork();
    const org2 = makeMockNetwork();
    await adapterFor(org1.network, {}, new Map([
      ['_implicit_org_Org2MSP', { mspId: 'Org2MSP', network: org2.network }],
    ])).replayBatch([privateRecord('_implicit_org_Org2MSP', 'k')]);

    expect(org1.submitted).toEqual([]);
    expect(endorsers(org2)).toEqual([undefined]);
  });

  it('is off by default', async () => {
    const org1 = makeMockNetwork();
    await adapterFor(org1.network, { ownerEndorsement: undefined }).replayBatch([
      privateRecord('_implicit_org_Org2MSP', 'k'),
    ]);

    expect(endorsers(org1)).toEqual([undefined]);
  });
});

describe('ChaincodeAdapter', () => {
  it('submits public_state records with the value as transient data', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: { ch1: { mycc: 'StoreAsset' } },
      concurrency: 10,
    });

    const records: ExtractionRecord[] = [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(network.getContract).toHaveBeenCalledWith('mycc', 'MigrationContract');
    expect(submitted[0].fn).toBe('StoreAsset');
    expect(submitted[0].args).toEqual(['k1']);
    expect(submitted[0].transient.public_value).toEqual(Buffer.from('v1'));
  });

  it('uses default PutState when no key mapping exists', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
    });

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'unmapped', key: 'k1', value: 'v1' },
    ]);
    expect(submitted[0].fn).toBe('PutState');
  });

  it('submits private_state records via newProposal with transient data', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
    });

    await adapter.replayBatch([
      { _type: 'private_state', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'pk1', value: 'pv1' },
    ]);

    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(submitted[0].fn).toBe('ImportPrivateData');
    expect(submitted[0].args).toEqual(['col1', 'pk1']);
    expect(submitted[0].transient.private_value).toEqual(Buffer.from('pv1'));
  });

  it('sends replay --since state deletes through the delete functions, in a state-only replay', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '', mspId: 'Org1MSP', certPath: '', keyPath: '', channel: 'ch1', keyMapping: {}, concurrency: 10,
    });
    await adapter.replayBatch([
      { _type: 'state_delete', channel: 'ch1', chaincode: 'mycc', key: 'gone' },
      { _type: 'state_delete', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'pgone' },
    ]);
    expect(submitted.map((x) => [x.fn, x.args]).sort()).toEqual([['DeletePrivateData', ['col1', 'pgone']], ['DeleteState', ['gone']]]);
    expect(adapter.getStats().totalFailed).toBe(0);
  });

  it('skips non-state records (history, metadata, identity)', async () => {
    const { network } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1',
        txId: 'tx1', txIndex: 0, blockNumber: 1, timestamp: '', isDelete: false,
        creator,
      },
      {
        _type: 'block_metadata', channel: 'ch1', blockNumber: 1, txId: 'tx1', txIndex: 0,
        timestamp: '', chaincodeId: 'mycc', keysWritten: ['k1'], keysDeleted: [],
        creator,
      },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(0);
  });

  it('failed key stops its queue but other keys continue', async () => {
    // One transaction per write, which is the only configuration where a
    // rejection reaches nothing but the key it names. What it costs when three
    // keys share a transaction is in the batching describe below.
    const { network, mockContract } = makeMockNetwork();
    (mockContract as any).onWrite = jest.fn(async (_fn: string, args: string[]) => {
      if (args[0] === 'k2') throw new Error('Simulated failure');
    });

    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      writeBatchSize: 1,
    });

    const records: ExtractionRecord[] = [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k3', value: 'v3' },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(2);

    const stats = adapter.getStats();
    expect(stats.totalFailed).toBe(1);
    expect(stats.failedKeys).toHaveLength(1);
    expect(stats.failedKeys[0].key).toBe('k2');
  });

  it('stops entire key queue on first failure for that key', async () => {
    const { network, mockContract } = makeMockNetwork();
    const submittedKeys: string[] = [];
    (mockContract as any).onWrite = jest.fn(async (
      _fn: string, args: string[], transient: any,
    ) => {
      submittedKeys.push(...writtenKeys(args, transient));
      // Fail on the second write to k1
      if (submittedKeys.filter((k) => k === 'k1').length === 2) {
        throw new Error('Simulated failure');
      }
    });

    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 1,
    });

    // k1 has 3 writes, k2 has 1 write
    const records: ExtractionRecord[] = [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1a' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1b' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1c' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' },
    ];

    await adapter.replayBatch(records);

    // The first round batches k1's first write with k2's only one; the rounds
    // after it are k1 alone, so the second write to k1 is its own transaction.
    // k1: first write succeeded, second failed, third skipped = 1 replayed, 2 failed
    // k2: succeeded = 1 replayed
    expect(adapter.getStats().totalReplayed).toBe(2);
    const stats = adapter.getStats();
    expect(stats.totalFailed).toBe(2);
    expect(stats.failedKeys[0].key).toBe('k1');
  });

  it('submits same-key records sequentially in order', async () => {
    const { network, mockContract } = makeMockNetwork();
    const submittedValues: string[] = [];
    (mockContract as any).onWrite = jest.fn(async (
      _fn: string, _args: string[], transient: any,
    ) => {
      submittedValues.push(transient.public_value.toString('utf-8'));
      // Add delay so concurrent execution would reorder them
      await new Promise((r) => setTimeout(r, 5));
    });

    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
    });

    // Three sequential writes to the same key
    const records: ExtractionRecord[] = [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'first' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'second' },
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'third' },
    ];

    await adapter.replayBatch(records);
    expect(submittedValues).toEqual(['first', 'second', 'third']);
    expect(adapter.getStats().totalReplayed).toBe(3);
  });

  it('respects concurrency limit across key queues', async () => {
    const { network, mockContract } = makeMockNetwork();
    const concurrent: number[] = [];
    let active = 0;

    (mockContract as any).onWrite = jest.fn(async () => {
      active++;
      concurrent.push(active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });

    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 2,
    });

    // 5 different keys = 5 queues, but concurrency=2
    const records: ExtractionRecord[] = Array.from({ length: 5 }, (_, i) => ({
      _type: 'public_state' as const,
      channel: 'ch1',
      chaincode: 'mycc',
      key: `k${i}`,
      value: `v${i}`,
    }));

    await adapter.replayBatch(records);
    expect(Math.max(...concurrent)).toBeLessThanOrEqual(2);
    expect(adapter.getStats().totalReplayed).toBe(5);
  });

  it('skips history records when replayHistory is not set', async () => {
    const { network } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1',
        txId: 'tx1', txIndex: 0, blockNumber: 1, timestamp: '2025-01-01T00:00:00Z', isDelete: false,
        creator,
      },
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'pk1', value: 'pv1',
        txId: 'tx2', txIndex: 0, blockNumber: 2, timestamp: '', isDelete: false,
      },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(0);
    expect(adapter.getStats().historyReplayed).toBe(0);
  });

  it('replays public_history via PutState when replayHistory is true', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: { ch1: { mycc: 'StoreAsset' } },
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: false,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1',
        txId: 'tx1', txIndex: 0, blockNumber: 5, timestamp: '2025-01-01T00:00:00Z', isDelete: false,
        creator,
      },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(adapter.getStats().historyReplayed).toBe(1);
    expect(submitted[0].fn).toBe('StoreAsset');
    expect(submitted[0].args).toEqual(['k1']);
    expect(submitted[0].transient.public_value).toEqual(Buffer.from('v1'));
  });

  it('replays private_history via ImportPrivateData when replayHistory is true', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: false,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'pk1', value: 'secret_v1',
        txId: 'tx2', txIndex: 0, blockNumber: 3,
        timestamp: '2025-01-02T00:00:00Z', isDelete: false,
      },
    ];

    await adapter.replayBatch(records);
    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(adapter.getStats().historyReplayed).toBe(1);
    expect(submitted[0].fn).toBe('ImportPrivateData');
    expect(submitted[0].args).toEqual(['col1', 'pk1']);
    expect(submitted[0].transient.private_value).toEqual(Buffer.from('secret_v1'));
  });

  it('leaves public history values untouched when embedSourceMetadata is unset', async () => {
    // Default off: replay reproduces the source ledger, so a value the source
    // chaincode wrote is what the destination chaincode reads back.
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
    });

    const value = '{"docType":"asset","owner":"Alice"}';
    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value,
        txId: 'tx1', txIndex: 0, blockNumber: 5, timestamp: '2025-01-01T00:00:00Z', isDelete: false,
        creator,
      },
    ];

    await adapter.replayBatch(records);
    expect(submitted[0].transient.public_value).toEqual(Buffer.from(value));
    expect(publicValue(submitted[0])).not.toContain('migrationMeta');
  });

  it('leaves private history values untouched when embedSourceMetadata is unset', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
    });

    const value = '{"secret":true}';
    const records: ExtractionRecord[] = [
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'pk1', value,
        txId: 'tx5', txIndex: 0, blockNumber: 10, timestamp: '', isDelete: false,
      },
    ];

    await adapter.replayBatch(records);
    expect(submitted[0].transient.private_value).toEqual(Buffer.from(value));
  });

  it('merges metadata into source JSON objects when embedSourceMetadata is true', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1',
        value: '{"docType":"asset","owner":"Alice","value":42}',
        txId: 'tx1', txIndex: 0, blockNumber: 5, timestamp: '2025-01-01T00:00:00Z', isDelete: false,
        creator,
      },
    ];

    await adapter.replayBatch(records);
    const wrappedValue = JSON.parse(publicValue(submitted[0]));
    expect(wrappedValue.docType).toBe('asset');
    expect(wrappedValue.owner).toBe('Alice');
    expect(wrappedValue.value).toBe(42);
    expect(wrappedValue.migrationMeta).toEqual({
      blockNumber: 5,
      txId: 'tx1',
      timestamp: '2025-01-01T00:00:00Z',
      isDelete: false,
    });
  });

  it('submits values that cannot carry metadata byte-for-byte', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'kArr',
        value: '[1,2,3]',
        txId: 'tx1', txIndex: 0, blockNumber: 5, timestamp: '2025-01-01T00:00:00Z', isDelete: false,
        creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'kStr',
        value: 'plain-string-value',
        txId: 'tx2', txIndex: 0, blockNumber: 6, timestamp: '2025-01-02T00:00:00Z', isDelete: false,
        creator,
      },
    ];

    await adapter.replayBatch(records);
    // Distinct keys, so one batched transaction carries both.
    expect(submitted).toHaveLength(1);
    const entries = decodeStateBatch(submitted[0].transient.public_batch);
    expect(entries.map((e) => e.key)).toEqual(['kArr', 'kStr']);
    // A JSON array and a non-JSON string have nowhere to hold migrationMeta.
    // Wrapping them would change their type at the destination, so they pass
    // through untouched.
    expect(entries[0].value).toEqual(Buffer.from('[1,2,3]'));
    expect(entries[1].value).toEqual(Buffer.from('plain-string-value'));
  });

  it('overwrites an existing migrationMeta field on the source object', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1',
        value: '{"docType":"asset","migrationMeta":"stale"}',
        txId: 'tx9', txIndex: 0, blockNumber: 99, timestamp: '2025-12-01T00:00:00Z', isDelete: false,
        creator,
      },
    ];

    await adapter.replayBatch(records);
    const wrappedValue = JSON.parse(publicValue(submitted[0]));
    expect(wrappedValue.docType).toBe('asset');
    expect(wrappedValue.migrationMeta).toEqual({
      blockNumber: 99,
      txId: 'tx9',
      timestamp: '2025-12-01T00:00:00Z',
      isDelete: false,
    });
  });

  it('preserves block order for same-key history records', async () => {
    const { network, mockContract } = makeMockNetwork();
    const submittedValues: string[] = [];
    (mockContract as any).onWrite = jest.fn(
      async (_fn: string, _args: string[], transient: any) => {
        submittedValues.push(transient.public_value.toString('utf-8'));
        await new Promise((r) => setTimeout(r, 5));
      },
    );

    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: false,
    });


    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'block5',
        txId: 'tx1', txIndex: 0, blockNumber: 5, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'block6',
        txId: 'tx2', txIndex: 0, blockNumber: 6, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'block7',
        txId: 'tx3', txIndex: 0, blockNumber: 7, timestamp: '', isDelete: false, creator,
      },
    ];

    await adapter.replayBatch(records);
    expect(submittedValues).toEqual(['block5', 'block6', 'block7']);
  });

  it('handles mixed state and history records in the same batch', async () => {
    const { network } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: false,
    });


    const records: ExtractionRecord[] = [
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'hv1',
        txId: 'tx1', txIndex: 0, blockNumber: 1, timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'pk1', value: 'phv1',
        txId: 'tx2', txIndex: 0, blockNumber: 2, timestamp: '', isDelete: false,
      },
    ];

    await adapter.replayBatch(records);
    const stats = adapter.getStats();
    expect(stats.totalReplayed).toBe(3);
    expect(stats.historyReplayed).toBe(2);
  });

  it('merges metadata into private_history JSON objects', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      embedSourceMetadata: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'private_history', channel: 'ch1',
        chaincode: 'mycc', collection: 'col1',
        key: 'pk1', value: '{"secret":true}',
        txId: 'tx5', txIndex: 0, blockNumber: 10,
        timestamp: '2025-06-01T00:00:00Z', isDelete: false,
      },
    ];

    await adapter.replayBatch(records);
    const wrapped = JSON.parse(
      submitted[0].transient.private_value.toString(),
    );
    expect(wrapped.secret).toBe(true);
    expect(wrapped.migrationMeta).toEqual({
      blockNumber: 10,
      txId: 'tx5',
      timestamp: '2025-06-01T00:00:00Z',
      isDelete: false,
    });
  });

  it('calls DeleteState for public_history with isDelete=true', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'public_history', channel: 'ch1',
        chaincode: 'mycc', key: 'k1', value: '',
        txId: 'tx-del', txIndex: 0, blockNumber: 99,
        timestamp: '2025-06-02T00:00:00Z',
        isDelete: true, creator,
      },
    ];

    await adapter.replayBatch(records);
    expect(submitted[0].fn).toBe('DeleteState');
    expect(submitted[0].args).toEqual(['k1']);
  });

  it('calls DeletePrivateData for private_history with isDelete=true', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
    });

    const records: ExtractionRecord[] = [
      {
        _type: 'private_history', channel: 'ch1',
        chaincode: 'mycc', collection: 'col1',
        key: 'pk1', value: '',
        txId: 'tx-del', txIndex: 0, blockNumber: 99,
        timestamp: '2025-06-02T00:00:00Z',
        isDelete: true,
      },
    ];

    await adapter.replayBatch(records);
    expect(submitted[0].fn).toBe('DeletePrivateData');
    expect(submitted[0].args).toEqual(['col1', 'pk1']);
    expect(submitted[0].transient).toBeUndefined();
  });
});

// ── Wire contract ───
//
// Values reach the destination as transient data because the Node and Java
// contract shims UTF-8-decode transaction arguments before the chaincode sees
// them, so a byte sequence that is not valid UTF-8 would be written to the
// destination ledger as U+FFFD.

describe('ChaincodeAdapter — wire contract', () => {
  function adapterFor(network: any, overrides: Record<string, unknown> = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      ...overrides,
    } as any);
  }

  it('sends a value that is not valid UTF-8 byte-for-byte', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x80]);

    await adapter.replayBatch([
      {
        _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'bin1',
        value: raw.toString('base64'), valueEncoding: 'base64',
      },
    ] as ExtractionRecord[]);

    expect(adapter.getStats().totalReplayed).toBe(1);
    expect(submitted[0].args).toEqual(['bin1']);
    expect(submitted[0].transient.public_value).toEqual(raw);
  });

  it('sends no value as a transaction argument', async () => {
    // A string argument is the one thing that cannot carry arbitrary bytes, so
    // no argument may hold a value on any path.
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { replayHistory: true });

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
      {
        _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'pk1', value: 'pv1',
      },
      {
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc',
        key: 'h1', value: 'hv1', txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '', isDelete: false, creator,
      },
      {
        _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
        collection: 'col1', key: 'ph1', value: 'phv1',
        txId: 'tx2', txIndex: 0, blockNumber: 2, timestamp: '', isDelete: false,
      },
    ] as ExtractionRecord[]);

    // Two transactions, not four: k1 and h1 are distinct public keys, so one
    // batch carries both, and pk1 and ph1 are distinct keys of one collection.
    expect(submitted).toHaveLength(2);
    const values = ['v1', 'pv1', 'hv1', 'phv1'];
    for (const write of submitted) {
      expect(write.args.every((a: string) => !values.includes(a))).toBe(true);
    }
    // The batched path takes no arguments at all — every key and every value it
    // carries is in the transient blob.
    const batched = submitted.filter((s) => s.transient?.public_batch);
    expect(batched).toHaveLength(1);
    expect(batched[0].args).toEqual([]);
    // The private batch names its collection and nothing else.
    const privateBatch = submitted.filter((s) => s.transient?.private_batch);
    expect(privateBatch).toHaveLength(1);
    expect(privateBatch[0].args).toEqual(['col1']);
  });

  it('counts a transaction that failed validation as a failure', async () => {
    // Endorsing and ordering successfully is not committing. An MVCC conflict,
    // an endorsement policy the destination applies, or a collection this
    // identity may not write all reach this point, and counting them as
    // replayed would report a success the destination ledger does not hold.
    const { network, mockContract } = makeMockNetwork();
    mockContract.status = {
      successful: false,
      code: 11,
      blockNumber: 42n,
      transactionId: 'tx-invalid',
    };
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
    ] as ExtractionRecord[]);

    const stats = adapter.getStats();
    expect(stats.totalReplayed).toBe(0);
    expect(stats.totalFailed).toBe(1);
    expect(stats.failedKeys[0].key).toBe('k1');
    expect(stats.failedKeys[0].error).toContain('tx-invalid');
    expect(stats.failedKeys[0].error).toContain('block 42');
    // The validation code by name, because a bare number is not actionable.
    expect(stats.failedKeys[0].error).toContain('MVCC_READ_CONFLICT');
  });

  it('names an unrecognised validation code by number', async () => {
    const { network, mockContract } = makeMockNetwork();
    mockContract.status = {
      successful: false,
      code: 999,
      blockNumber: 42n,
      transactionId: 'tx-unknown',
    };
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' },
    ] as ExtractionRecord[]);

    expect(adapter.getStats().failedKeys[0].error).toContain('code 999');
  });
});

// ── Batched public writes ───
//
// Row 3.7. A transaction costs an endorsement round trip plus an ordering and
// commit wait whatever it carries, so one transaction per version puts a deep
// history beyond any window an operator would wait through. Public writes to
// the migration contract travel in batches instead.
//
// What a batch may hold is not a tuning question. A transaction's write set
// records one value per key, so two versions of one key in one batch would drop
// the earlier one — silently, and out of the destination's GetHistoryForKey
// rather than out of anything a run reports.

describe('ChaincodeAdapter — batched public writes', () => {
  function adapterFor(network: any, overrides: Record<string, unknown> = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channel: 'ch1',
      keyMapping: {},
      concurrency: 10,
      replayHistory: true,
      ...overrides,
    } as any);
  }

  function stateRecord(
    key: string,
    value = `v-${key}`,
    chaincode = 'mycc',
  ): ExtractionRecord {
    return {
      _type: 'public_state', channel: 'ch1', chaincode, key, value,
    } as ExtractionRecord;
  }

  function historyRecord(
    key: string,
    value: string,
    blockNumber: number,
    isDelete = false,
  ): ExtractionRecord {
    return {
      _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key, value,
      txId: `tx-${key}-${blockNumber}`, txIndex: 0, blockNumber,
      timestamp: '2026-01-01T00:00:00Z', isDelete, creator,
    } as ExtractionRecord;
  }

  function privateRecord(key: string): ExtractionRecord {
    return {
      _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
      collection: 'col1', key, value: `pv-${key}`,
    } as ExtractionRecord;
  }

  /** The keys each submission carried, one array per transaction. */
  function keysPerTransaction(
    submitted: Array<{ args: any[]; transient: any }>,
  ): string[][] {
    return submitted.map((write) => writtenKeys(write.args, write.transient));
  }

  it('carries every key of a round in one transaction', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch(['k1', 'k2', 'k3'].map((k) => stateRecord(k)));

    expect(submitted).toHaveLength(1);
    expect(submitted[0].fn).toBe('PutStateBatch');
    expect(keysPerTransaction(submitted)).toEqual([['k1', 'k2', 'k3']]);
    expect(adapter.getStats().totalReplayed).toBe(3);
  });

  /**
   * A tombstone travels as a flag rather than as a write of no bytes. They are
   * different ledger facts — verify compares `isDelete` — so an encoding that
   * made them the same bytes would replay a delete as a live empty key.
   */
  it('sends each key\'s value and delete flag in the framed blob', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      historyRecord('k1', 'v1', 1),
      historyRecord('k2', '', 2, true),
    ]);

    expect(decodeStateBatch(submitted[0].transient.public_batch)).toEqual([
      { key: 'k1', value: Buffer.from('v1'), isDelete: false },
      { key: 'k2', value: Buffer.alloc(0), isDelete: true },
    ]);
    // Everything is in the blob: `PutStateBatch(ctx)` declares no parameters,
    // and a contract-api shim refuses a call carrying more than it declares.
    expect(submitted[0].args).toEqual([]);
  });

  /**
   * Metadata embedding has its own decode on the batched path, and every replay
   * of more than one key takes it — the single-record tests above go through
   * `submitRecord` and would not notice a batch that dropped the wrapping.
   */
  it('embeds source metadata in a batched value', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { embedSourceMetadata: true });

    await adapter.replayBatch([
      historyRecord('k1', '{"owner":"Alice"}', 5),
      historyRecord('k2', '{"owner":"Bob"}', 6),
    ]);

    const values = decodeStateBatch(submitted[0].transient.public_batch)
      .map((entry) => JSON.parse(entry.value.toString('utf-8')));
    expect(values).toEqual([
      {
        owner: 'Alice',
        migrationMeta: {
          blockNumber: 5, txId: 'tx-k1-5',
          timestamp: '2026-01-01T00:00:00Z', isDelete: false,
        },
      },
      {
        owner: 'Bob',
        migrationMeta: {
          blockNumber: 6, txId: 'tx-k2-6',
          timestamp: '2026-01-01T00:00:00Z', isDelete: false,
        },
      },
    ]);
  });

  it('keeps two versions of one key in separate transactions', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      historyRecord('k1', 'v1', 1),
      historyRecord('k1', 'v2', 2),
      historyRecord('k2', 'v3', 3),
    ]);

    // A round takes the head of every key's queue, so a batch names each key
    // once and the round after it takes the next version.
    expect(keysPerTransaction(submitted)).toEqual([['k1', 'k2'], ['k1']]);
    const first = decodeStateBatch(submitted[0].transient.public_batch);
    expect(first[0].value).toEqual(Buffer.from('v1'));
    expect(submitted[1].transient.public_value).toEqual(Buffer.from('v2'));
  });

  /**
   * A batch of one costs the same one transaction as a single write, and the
   * single-record path's bound on a value is the peer's message limit rather
   * than `MAX_BATCH_BYTES` — which is what keeps an oversized value from
   * needing a case of its own.
   */
  it('submits a batch of one through the single-record path', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([stateRecord('k1')]);

    expect(submitted[0].fn).toBe('PutState');
    expect(submitted[0].args).toEqual(['k1']);
    expect(submitted[0].transient.public_value).toEqual(Buffer.from('v-k1'));
    expect(submitted[0].transient.public_batch).toBeUndefined();
  });

  it('holds a batch to writeBatchSize keys', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { writeBatchSize: 2 });

    await adapter.replayBatch(
      ['k1', 'k2', 'k3', 'k4', 'k5'].map((k) => stateRecord(k)),
    );

    const keys = keysPerTransaction(submitted);
    expect(submitted).toHaveLength(3);
    expect(keys.every((batch) => batch.length <= 2)).toBe(true);
    expect(keys.flat().sort()).toEqual(['k1', 'k2', 'k3', 'k4', 'k5']);
  });

  it('submits every write on its own when writeBatchSize is 1', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { writeBatchSize: 1 });

    await adapter.replayBatch(['k1', 'k2', 'k3'].map((k) => stateRecord(k)));

    expect(submitted.map((s) => s.fn)).toEqual(['PutState', 'PutState', 'PutState']);
    expect(keysPerTransaction(submitted).flat().sort())
      .toEqual(['k1', 'k2', 'k3']);
  });

  /**
   * The byte cap, not the count, is the one a destination enforces: a batch is
   * one transaction, and an envelope over the channel's `AbsoluteMaxBytes` is
   * rejected whole.
   */
  it('splits a batch that would exceed the byte cap', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);
    const big = 'x'.repeat(Math.floor(MAX_BATCH_BYTES * 0.4));

    await adapter.replayBatch(
      ['k1', 'k2', 'k3'].map((k) => stateRecord(k, big)),
    );

    const keys = keysPerTransaction(submitted);
    expect(keys.map((batch) => batch.length).sort()).toEqual([1, 2]);
    expect(keys.flat().sort()).toEqual(['k1', 'k2', 'k3']);
    for (const write of submitted) {
      const framed = write.transient.public_batch;
      if (framed) expect(framed.length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(adapter.getStats().totalReplayed).toBe(3);
  });

  /**
   * The framing the destination measures includes the entry count, so what a
   * batch has room for is the cap less those four bytes. Values that each frame
   * to exactly half the cap are one transaction apiece — a pair of them would
   * be four bytes over and rejected whole.
   */
  it('counts the entry count header against the byte cap', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);
    const half = MAX_BATCH_BYTES / 2 - BATCH_ENTRY_HEADER_BYTES - 'k1'.length;

    await adapter.replayBatch(
      ['k1', 'k2', 'k3', 'k4'].map((k) => stateRecord(k, 'x'.repeat(half))),
    );

    for (const write of submitted) {
      const framed = write.transient.public_batch;
      if (framed) expect(framed.length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(submitted.map((s) => s.fn)).toEqual(Array(4).fill('PutState'));
    expect(keysPerTransaction(submitted).flat().sort())
      .toEqual(['k1', 'k2', 'k3', 'k4']);
  });

  it('submits a value too large to batch on its own', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      stateRecord('k1', 'x'.repeat(MAX_BATCH_BYTES + 1024)),
      stateRecord('k2'),
    ]);

    // A value cannot be written in pieces, so the greedy split admits it into
    // an empty batch regardless of size and the single-record path takes it.
    expect(submitted.map((s) => s.fn)).toEqual(['PutState', 'PutState']);
    expect(adapter.getStats().totalReplayed).toBe(2);
  });

  it('never puts two chaincodes\' writes in one transaction', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      stateRecord('k1', 'v1', 'assets'),
      stateRecord('k2', 'v2', 'assets'),
      stateRecord('k3', 'v3', 'trades'),
      stateRecord('k4', 'v4', 'trades'),
    ]);

    // A batch is one transaction on one chaincode's contract, so a shared one
    // would write the second chaincode's keys into the first's namespace —
    // under a chaincode that never held them.
    expect(submitted).toHaveLength(2);
    const byChaincode = new Map(
      submitted.map((s) => [s.chaincode, writtenKeys(s.args, s.transient)]),
    );
    expect(byChaincode.get('assets')).toEqual(['k1', 'k2']);
    expect(byChaincode.get('trades')).toEqual(['k3', 'k4']);
  });

  it('does not batch a chaincode keyMapping names', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      keyMapping: { ch1: { mycc: 'StoreAsset' } },
    });

    await adapter.replayBatch(['k1', 'k2'].map((k) => stateRecord(k)));

    // The mapped function is the application's own: it takes one key and knows
    // nothing of this framing.
    expect(submitted.map((s) => s.fn)).toEqual(['StoreAsset', 'StoreAsset']);
    expect(keysPerTransaction(submitted).flat().sort()).toEqual(['k1', 'k2']);
  });

  /**
   * `generate-replay-config` writes `PutState` for every deployment, so this is
   * the shape of nearly every real config: an entry naming the contract's own
   * function is the same configuration as no entry, and batching only the
   * unmapped ones would leave a generated config submitting one transaction per
   * write for a reason nothing in it expresses.
   */
  it('batches a deployment whose keyMapping names the default function', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      keyMapping: { ch1: { mycc: 'PutState' } },
      deleteMapping: { ch1: { mycc: 'DeleteState' } },
    });

    await adapter.replayBatch([
      historyRecord('k1', 'v1', 1),
      historyRecord('k2', '', 2, true),
    ]);

    expect(submitted.map((s) => s.fn)).toEqual(['PutStateBatch']);
    expect(keysPerTransaction(submitted)).toEqual([['k1', 'k2']]);
  });

  it('batches a deployment mapped to the migration contract by name', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      migrationContract: 'MyMigration',
      keyMapping: { ch1: { mycc: 'MyMigration:PutState' } },
    });

    await adapter.replayBatch(['k1', 'k2'].map((k) => stateRecord(k)));

    expect(submitted.map((s) => s.fn)).toEqual(['PutStateBatch']);
    expect(keysPerTransaction(submitted)).toEqual([['k1', 'k2']]);
  });

  /**
   * The other half of that: a function on a contract of that name that is not
   * the migration contract's own is the application's, whatever it is called.
   */
  it('does not batch a default-named function on another contract', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      keyMapping: { ch1: { mycc: 'SampleAssets:PutState' } },
    });

    await adapter.replayBatch(['k1', 'k2'].map((k) => stateRecord(k)));

    expect(submitted.map((s) => s.fn)).toEqual(['PutState', 'PutState']);
  });

  it('does not batch a chaincode deleteMapping names', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, {
      deleteMapping: { ch1: { mycc: 'RemoveAsset' } },
    });

    await adapter.replayBatch([
      historyRecord('k1', 'v1', 1),
      historyRecord('k1', '', 2, true),
    ]);

    // A tombstone is a flag inside a batch, so a deployment whose delete lives
    // on its own function has to keep its writes off the batch too — otherwise
    // one key's writes and deletes would be submitted in two separate phases,
    // and the order they arrive in is the history the destination ends up with.
    expect(submitted.map((s) => s.fn)).toEqual(['PutState', 'RemoveAsset']);
  });

  it('batches private data separately from public data', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      stateRecord('k1'),
      stateRecord('k2'),
      privateRecord('pk1'),
      privateRecord('pk2'),
    ]);

    expect(submitted.map((s) => s.fn).sort()).toEqual(
      ['ImportPrivateDataBatch', 'PutStateBatch'],
    );
    const priv = submitted.find((s) => s.fn === 'ImportPrivateDataBatch')!;
    expect(priv.args).toEqual(['col1']);
    expect(decodeStateBatch(Buffer.from(priv.transient.private_batch)))
      .toEqual([
        { key: 'pk1', value: Buffer.from('pv-pk1'), isDelete: false },
        { key: 'pk2', value: Buffer.from('pv-pk2'), isDelete: false },
      ]);
  });

  /**
   * Transient data reaches every endorser, so two collections in one batch would
   * disclose each one's values to the other's members' peers.
   */
  it('never puts two collections in one private batch', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);
    const inCollection = (collection: string, key: string) => ({
      _type: 'private_state', channel: 'ch1', chaincode: 'mycc',
      collection, key, value: 'v',
    } as ExtractionRecord);

    await adapter.replayBatch([
      inCollection('colA', 'k1'), inCollection('colA', 'k2'),
      inCollection('colB', 'k1'), inCollection('colB', 'k2'),
    ]);

    const batches = submitted.filter((s) => s.fn === 'ImportPrivateDataBatch');
    expect(batches.map((b) => b.args[0]).sort()).toEqual(['colA', 'colB']);
    for (const b of batches) {
      expect(decodeStateBatch(Buffer.from(b.transient.private_batch)).map((e) => e.key))
        .toEqual(['k1', 'k2']);
    }
  });

  /** One version per key per transaction, as for public history. */
  it('submits a private key\'s versions in separate rounds, in order', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network, { replayHistory: true });
    const ph = (key: string, value: string, blockNumber: number, isDelete = false) => ({
      _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1',
      key, value, txId: `t${blockNumber}`, txIndex: 0, blockNumber,
      timestamp: '', isDelete,
    } as ExtractionRecord);

    await adapter.replayBatch([
      ph('a', 'a1', 1), ph('b', 'b1', 1), ph('a', 'a2', 2), ph('a', '', 3, true),
    ]);

    const rounds = submitted.map((s) => s.transient?.private_batch
      ? decodeStateBatch(Buffer.from(s.transient.private_batch))
        .map((e) => `${e.key}:${e.isDelete ? 'del' : e.value.toString()}`)
      : [`${s.fn}:${s.args.join(',')}`]);
    expect(rounds).toEqual([
      ['a:a1', 'b:b1'],
      ['ImportPrivateData:col1,a'],
      ['DeletePrivateData:col1,a'],
    ]);
    expect(adapter.getStats().totalReplayed).toBe(4);
  });

  /** historyImport records a receipt per mutation, so private data stays single. */
  it('does not batch private history under historyImport', async () => {
    const { network, submitted } = makeMockNetwork();
    const entries: string[] = [];
    const resilient = {
      submitEntry: jest.fn(async (_c: unknown, e: any) => { entries.push(e.record.key); }),
      submitPublicBatch: jest.fn(async () => undefined),
    };
    const adapter = new ChaincodeAdapter(network as any, {
      connectionProfilePath: '', mspId: 'Org1MSP', certPath: '', keyPath: '',
      channel: 'ch1', keyMapping: {}, concurrency: 10, replayHistory: true,
    } as any, new Map(), resilient as any);
    const ph = (key: string) => ({
      _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1',
      key, value: 'v', txId: 't', txIndex: 0, blockNumber: 1, timestamp: '', isDelete: false,
    } as ExtractionRecord);

    await adapter.replayBatch([ph('a'), ph('b')]);

    expect(entries.sort()).toEqual(['a', 'b']);
    expect(submitted.filter((x) => x.fn === 'ImportPrivateDataBatch')).toEqual([]);
  });

  it('fails every key a rejected private batch carried, naming the collection', async () => {
    const { network, mockContract } = makeMockNetwork();
    (mockContract as any).onWrite = jest.fn(async (fn: string) => {
      if (fn === 'ImportPrivateDataBatch') throw new Error('not a member');
    });
    const adapter = adapterFor(network);

    await adapter.replayBatch([privateRecord('pk1'), privateRecord('pk2')]);

    const stats = adapter.getStats();
    expect(stats.failedKeys.map((f) => [f.key, f.collection])).toEqual([
      ['pk1', 'col1'], ['pk2', 'col1'],
    ]);
    expect(stats.failedKeys[0].error).toMatch(/2 private writes .* for col1 .*ImportPrivateDataBatch.*not a member/);
  });

  it('fails every key a rejected batch carried', async () => {
    const { network, mockContract, submitted } = makeMockNetwork();
    (mockContract as any).onWrite = jest.fn(async (fn: string) => {
      if (fn === 'PutStateBatch') throw new Error('endorsement failed');
    });
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      historyRecord('k1', 'v1', 1),
      historyRecord('k1', 'v2', 2),
      historyRecord('k2', 'v3', 3),
    ]);

    // A key whose transaction was rejected has no value at the destination, so
    // each gets its own entry: the operator's report is a list of keys to go
    // and look at, and one entry naming a batch names no key at all.
    const stats = adapter.getStats();
    expect(stats.failedKeys.map((f) => f.key)).toEqual(['k1', 'k2']);
    expect(stats.failedKeys[0].skippedAfter).toBe(1);
    expect(stats.failedKeys[1].skippedAfter).toBe(0);
    expect(stats.totalFailed).toBe(3);
    expect(stats.totalReplayed).toBe(0);
    // The round failed, so the round that would have written k1's v2 never ran.
    expect(submitted).toEqual([]);
  });

  it('says a failed write was batched, and how much it carried', async () => {
    const { network, mockContract } = makeMockNetwork();
    (mockContract as any).onWrite = jest.fn(async () => {
      throw new Error('failed to endorse transaction');
    });
    const adapter = adapterFor(network);

    await adapter.replayBatch(['k1', 'k2'].map((k) => stateRecord(k)));

    // Which function was attempted is the actionable half: `PutStateBatch` not
    // found means the destination is running a contract without it, and the
    // size says whether the byte cap is worth looking at.
    const { error } = adapter.getStats().failedKeys[0];
    expect(error).toContain('batch of 2 public writes');
    expect(error).toContain('mycc/MigrationContract:PutStateBatch');
    expect(error).toContain('failed to endorse transaction');
  });

  it('fails a value it cannot read without failing the round', async () => {
    const { network, submitted } = makeMockNetwork();
    const adapter = adapterFor(network);

    await adapter.replayBatch([
      {
        _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'bad',
        value: 'AA==', valueEncoding: 'gzip',
      } as any,
      stateRecord('k2'),
      stateRecord('k3'),
    ]);

    // It is one record's defect, reported against its own key. A batch that
    // never formed should not take the other keys' writes down with it.
    const stats = adapter.getStats();
    expect(stats.failedKeys.map((f) => f.key)).toEqual(['bad']);
    expect(stats.failedKeys[0].error)
      .toContain('Failed to read the value for key bad of mycc');
    expect(keysPerTransaction(submitted)).toEqual([['k2', 'k3']]);
  });

  it('rejects a writeBatchSize of 0, which would frame nothing', () => {
    expect(() => adapterFor(makeMockNetwork().network, { writeBatchSize: 0 }))
      .toThrow(/writeBatchSize must be an integer >= 1, got: 0/);
  });

  it('rejects a fractional writeBatchSize', () => {
    expect(() => adapterFor(makeMockNetwork().network, { writeBatchSize: 2.5 }))
      .toThrow(/writeBatchSize must be an integer/);
  });
});

// ─── What a failure record says ───
//
// The failure record and the warn log used to keep only the innermost cause
// message — the peer's reason — and drop the wrapper that names which record
// failed and which `chaincode/Contract:function` it was submitted to. For a
// mapped function that wrapper is the actionable half: "DeleteState not found"
// says the destination is wrong, and only the target says which config entry
// names it. Both halves are now recorded, outer first.

describe('ChaincodeAdapter — failure detail', () => {
  function adapterFor(network: any, overrides: Record<string, unknown> = {}) {
    return new ChaincodeAdapter(network as any, {
      connectionProfilePath: '',
      mspId: 'Org1MSP',
      certPath: '',
      keyPath: '',
      channelMapping: { 'orders-ch': 'orders-ch' },
      concurrency: 10,
      ...overrides,
    } as any);
  }

  /** A tombstone, which is the only record type a delete function ever sees. */
  function deleteRecord(key: string) {
    return {
      _type: 'public_history', channel: 'orders-ch', chaincode: 'marketplace',
      key, value: '', txId: `tx-${key}`, txIndex: 0, blockNumber: 9,
      timestamp: '2026-01-01T00:00:00Z', isDelete: true, creator,
    } as ExtractionRecord;
  }

  const publicRecord = {
    _type: 'public_state', channel: 'orders-ch', chaincode: 'marketplace',
    key: 'k1', value: 'v1',
  } as ExtractionRecord;

  it('names the function a failed write was submitted to', async () => {
    const { network, contractFor } = makeMockNetwork();
    contractFor('marketplace', 'SampleAssets').onWrite = async () => {
      throw new Error('chaincode response 500, StoreAsset not found');
    };
    const adapter = adapterFor(network, {
      keyMapping: { 'orders-ch': { marketplace: 'SampleAssets:StoreAsset' } },
    });

    await adapter.replayBatch([publicRecord]);

    const { error } = adapter.getStats().failedKeys[0];
    expect(error).toContain('marketplace/SampleAssets:StoreAsset');
    expect(error).toContain('chaincode response 500');
    // The target leads: what was attempted, then why the peer refused it.
    expect(error.indexOf('marketplace/SampleAssets:StoreAsset'))
      .toBeLessThan(error.indexOf('chaincode response 500'));
  });

  /**
   * Row 2.10's own case. A delete resolves through `deleteMapping`, so a failure
   * that names only the peer's reason leaves two maps it could have come from.
   */
  it('names the delete function a failed tombstone was submitted to', async () => {
    const { network, contractFor } = makeMockNetwork();
    contractFor('marketplace', 'SampleAssets').onWrite = async () => {
      throw new Error('chaincode response 500, RemoveAsset not found');
    };
    const adapter = adapterFor(network, {
      replayHistory: true,
      deleteMapping: { 'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' } },
    });

    await adapter.replayBatch([deleteRecord('k1')]);

    const { error } = adapter.getStats().failedKeys[0];
    expect(error).toContain('marketplace/SampleAssets:RemoveAsset');
    expect(error).toContain('RemoveAsset not found');
  });

  /** The gateway nests the peer's text under `details`, below a generic message. */
  it('keeps the endorsement detail a gateway error carries', async () => {
    const { network, mockContract } = makeMockNetwork();
    mockContract.onWrite = async () => {
      throw Object.assign(new Error('failed to endorse transaction'), {
        details: [{ message: 'collection col1 not defined' }],
      });
    };
    const adapter = adapterFor(network, { keyMapping: {} });

    await adapter.replayBatch([
      { ...publicRecord, chaincode: 'mycc' } as ExtractionRecord,
    ]);

    const { error } = adapter.getStats().failedKeys[0];
    expect(error).toContain('mycc/MigrationContract:PutState');
    expect(error).toContain('collection col1 not defined');
  });

  /** No cause message to append, so nothing is appended — no dangling separator. */
  it('records the target alone when the cause says nothing', async () => {
    const { network, mockContract } = makeMockNetwork();
    mockContract.onWrite = async () => { throw new Error(''); };
    const adapter = adapterFor(network, { keyMapping: {} });

    await adapter.replayBatch([
      { ...publicRecord, chaincode: 'mycc' } as ExtractionRecord,
    ]);

    const { error } = adapter.getStats().failedKeys[0];
    expect(error).toContain('mycc/MigrationContract:PutState');
    expect(error).not.toMatch(/[:\s]$/);
  });
});

// ─── NdjsonReader tests ───

describe('NdjsonReader', () => {
  const reader = new NdjsonReader();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-reader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('reads all records from a valid NDJSON file', async () => {
    const p = writeFile('test.ndjson', [
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' }),
    ].join('\n'));

    const records = await reader.readAll(p);
    expect(records).toHaveLength(2);
    expect((records[0] as PublicStateRecord).key).toBe('k1');
    expect((records[1] as PublicStateRecord).key).toBe('k2');
  });

  it('skips empty lines', async () => {
    const p = writeFile('test.ndjson',
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }) +
      '\n\n\n' +
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' }) +
      '\n',
    );

    const records = await reader.readAll(p);
    expect(records).toHaveLength(2);
  });

  it('fails on malformed JSON with the file and physical line', async () => {
    const p = writeFile('test.ndjson', [
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
      'not valid json {{{',
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' }),
    ].join('\n'));

    await expect(reader.readAll(p)).rejects.toThrow(
      new RegExp(`Malformed NDJSON at .*test\\.ndjson:2`),
    );
  });

  it('fails on records with an unknown _type', async () => {
    const p = writeFile('test.ndjson', [
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
      JSON.stringify({ _type: 'bogus_type', channel: 'ch1', key: 'k2' }),
    ].join('\n'));

    await expect(reader.readAll(p)).rejects.toThrow(
      /Invalid extraction record at .*test\.ndjson:2:.*bogus_type/,
    );
  });

  it('fails on records missing _type', async () => {
    const p = writeFile(
      'test.ndjson',
      JSON.stringify({ channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
    );

    await expect(reader.readAll(p)).rejects.toThrow(
      /Invalid extraction record at .*test\.ndjson:1:.*got missing/,
    );
  });

  it.each([
    ['number', '42'],
    ['string', '"just a string"'],
    ['null', 'null'],
    ['boolean', 'true'],
  ])('fails on a JSON %s instead of a record', async (_label, value) => {
    const p = writeFile('test.ndjson', value);
    await expect(reader.readAll(p)).rejects.toThrow(
      /Invalid extraction record at .*test\.ndjson:1/,
    );
  });

  it('returns empty array for nonexistent file', async () => {
    const records = await reader.readAll(path.join(tmpDir, 'nonexistent.ndjson'));
    expect(records).toHaveLength(0);
  });

  it('streamByType filters by record type', async () => {
    const p = writeFile('test.ndjson', [
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
      JSON.stringify({
        _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1',
        txId: 'tx1', blockNumber: 1, timestamp: '', isDelete: false,
        creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp' },
      }),
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' }),
    ].join('\n'));

    const stateRecords: any[] = [];
    for await (const r of reader.streamByType(p, 'public_state')) {
      stateRecords.push(r);
    }
    expect(stateRecords).toHaveLength(2);
    expect(stateRecords.every(r => r._type === 'public_state')).toBe(true);
  });

  it('count returns correct number', async () => {
    const p = writeFile('test.ndjson', [
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1' }),
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2' }),
      JSON.stringify({ _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key: 'k3', value: 'v3' }),
    ].join('\n'));

    expect(await reader.count(p)).toBe(3);
  });

  it('count returns 0 for nonexistent file', async () => {
    expect(await reader.count(path.join(tmpDir, 'no.ndjson'))).toBe(0);
  });
});

// ─── ReplayOrchestrator tests ───

describe('ReplayOrchestrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-orch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when manifest is missing', async () => {
    const orchestrator = new ReplayOrchestrator({
      adapter: 'postgresql',
      inputDir: tmpDir,
      postgresql: { connectionString: 'postgresql://localhost/test' },
    });

    await expect(orchestrator.run()).rejects.toThrow(/Manifest not found/);
  });

  it('throws for unsupported adapter', async () => {
    // Write a minimal manifest
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({ channels: [{ channelId: 'ch1' }] }),
    );

    const orchestrator = new ReplayOrchestrator({
      adapter: 'redis' as any,
      inputDir: tmpDir,
    });

    await expect(orchestrator.run()).rejects.toThrow(/Unsupported adapter/);
  });

  it('throws when postgresql connection string is missing', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({ channels: [{ channelId: 'ch1' }] }),
    );

    const orchestrator = new ReplayOrchestrator({
      adapter: 'postgresql',
      inputDir: tmpDir,
    });

    await expect(orchestrator.run()).rejects.toThrow(/connection string required/);
  });

  it('throws when chaincode config is missing required fields', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({ channels: [{ channelId: 'ch1' }] }),
    );

    const orchestrator = new ReplayOrchestrator({
      adapter: 'chaincode',
      inputDir: tmpDir,
      chaincode: {} as any,
    });

    await expect(orchestrator.run()).rejects.toThrow(/connectionProfilePath is required/);
  });
});
