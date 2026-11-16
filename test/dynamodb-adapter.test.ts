import { keyPartitionKey } from '../src/replay/adapters/dynamodb-keys';
import {
  DYNAMODB_MAX_ATTEMPTS,
  DynamoDBAdapter,
  DynamoDBAdapterConfig,
} from '../src/replay/adapters/dynamodb-adapter';
import {
  ExtractionRecord,
  PublicStateRecord,
  PrivateStateRecord,
  PublicHistoryRecord,
  PrivateHistoryRecord,
  BlockMetadataRecord,
  IdentityRecord,
  PrivateHashRecord,
} from '../src/types';

// ── Mock AWS SDK ──
// jest.mock factories are hoisted above variable declarations. Use a
// module-scoped send mock that the factories capture by reference via
// a getter so it resolves after initialization.
const mockSendFn = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(function (this: any) {
    this.send = (...args: any[]) => mockSendFn(...args);
    this.destroy = jest.fn();
  }),
  CreateTableCommand: jest.fn().mockImplementation((input: any) => ({ input, _tag: 'CreateTable' })),
  DescribeTableCommand: jest.fn().mockImplementation((input: any) => ({ input, _tag: 'DescribeTable' })),
  ResourceInUseException: class ResourceInUseException extends Error {
    constructor() {
      super('Table already exists');
      this.name = 'ResourceInUseException';
    }
  },
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn().mockImplementation((_client: any) => ({
      send: (...args: any[]) => mockSendFn(...args),
    })),
  },
  BatchWriteCommand: jest.fn().mockImplementation((input: any) => ({ input, _tag: 'BatchWrite' })),
  UpdateCommand: jest.fn().mockImplementation((input: any) => ({ input, _tag: 'Update' })),
}));

// ── Helpers ──

const BASE_CONFIG: DynamoDBAdapterConfig = {
  region: 'us-east-1',
  stateTable: 'fabric-state',
  historyTable: 'fabric-history',
  metadataTable: 'fabric-metadata',
  identityTable: 'fabric-identities',
  privateHashTable: 'fabric-private-hashes',
  endpoint: 'http://localhost:8000',
};

function makePublicState(key: string): PublicStateRecord {
  return { _type: 'public_state', channel: 'ch1', chaincode: 'mycc', key, value: `v-${key}` };
}

function makePrivateState(key: string): PrivateStateRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value: `pv-${key}`,
  };
}

function makePublicHistory(key: string, txId: string): PublicHistoryRecord {
  return {
    _type: 'public_history',
    channel: 'ch1',
    chaincode: 'mycc',
    key,
    value: 'v1',
    txId,
    txIndex: 0,
    blockNumber: 1,
    timestamp: '2024-01-01T00:00:00Z',
    isDelete: false,
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

function makePrivateHistory(key: string, txId: string, blockNumber = 1, txIndex = 0): PrivateHistoryRecord {
  return {
    _type: 'private_history',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value: 'pv1',
    txId,
    blockNumber,
    txIndex,
    timestamp: '2024-01-01T00:00:00Z',
    isDelete: false,
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

function makeBlockMetadata(blockNumber: number, txId: string): BlockMetadataRecord {
  return {
    _type: 'block_metadata',
    channel: 'ch1',
    blockNumber,
    txId,
    txIndex: 0,
    timestamp: '2024-01-01T00:00:00Z',
    chaincodeId: 'mycc',
    keysWritten: ['k1'],
    keysDeleted: [],
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

/** Every item the adapter sent to one table, flattened in request order. */
function itemsFor(tableName: string): any[] {
  const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
  return BatchWriteCommand.mock.calls
    .filter((call: any[]) => tableName in call[0].RequestItems)
    .flatMap((call: any[]) =>
      call[0].RequestItems[tableName].map((r: any) => r.PutRequest.Item),
    );
}

/** The BatchWriteItem requests the adapter aimed at one table. */
function requestsFor(tableName: string): any[] {
  const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
  return BatchWriteCommand.mock.calls
    .filter((call: any[]) => tableName in call[0].RequestItems)
    .map((call: any[]) => call[0].RequestItems[tableName]);
}

function makeIdentity(mspId: string, fingerprint: string): IdentityRecord {
  return {
    _type: 'identity',
    mspId,
    certFingerprint: fingerprint,
    commonName: 'admin',
    org: 'org1',
    firstSeenBlock: 1,
    lastSeenBlock: 10,
    txCount: 5,
  };
}

// ── Tests ──

describe('DynamoDBAdapter', () => {
  beforeEach(() => {
    mockSendFn.mockReset();
    mockSendFn.mockImplementation((cmd: any) => {
      if (cmd._tag === 'DescribeTable') {
        return Promise.resolve({ Table: { TableStatus: 'ACTIVE' } });
      }
      return Promise.resolve({});
    });
    // Reset command constructor mocks so call counts don't leak between tests
    const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
    const { BatchWriteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    CreateTableCommand.mockClear();
    BatchWriteCommand.mockClear();
    UpdateCommand.mockClear();
  });

  describe('initialize()', () => {
    it('creates all five tables when all table names are configured', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.initialize();

      const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
      expect(CreateTableCommand).toHaveBeenCalledTimes(5);
    });

    it('creates only the state table when optional tables are not configured', async () => {
      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });
      await adapter.initialize();

      const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
      expect(CreateTableCommand).toHaveBeenCalledTimes(1);
    });

    it('does not throw when table already exists (ResourceInUseException)', async () => {
      const { ResourceInUseException } = require('@aws-sdk/client-dynamodb');
      mockSendFn.mockRejectedValueOnce(new ResourceInUseException());

      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });
      await expect(adapter.initialize()).resolves.not.toThrow();
    });

    it('propagates unexpected errors during table creation', async () => {
      mockSendFn.mockRejectedValueOnce(new Error('Access denied'));

      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });
      await expect(adapter.initialize()).rejects.toThrow('Access denied');
    });

    it('creates the state table with no sort key', async () => {
      // The whole primary key is the ledger key's partition key. A RANGE key
      // would mean a partition shared by more than one key, which is the
      // throughput ceiling this schema exists to remove.
      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });
      await adapter.initialize();

      const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
      const [[params]] = CreateTableCommand.mock.calls;
      expect(params.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
      expect(params.AttributeDefinitions).toEqual([
        { AttributeName: 'pk', AttributeType: 'S' },
      ]);
    });
  });

  describe('replayBatch() — state records', () => {
    it('batches state instead of sending one request per record', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      const records: ExtractionRecord[] = [makePublicState('k1'), makePublicState('k2')];

      await adapter.replayBatch(records);

      expect(requestsFor('fabric-state')).toHaveLength(1);
      expect(itemsFor('fabric-state')).toHaveLength(2);
    });

    it('puts the ledger key in the partition key: pk={channel}#{chaincode}##{key}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState('mykey')]);

      const [item] = itemsFor('fabric-state');
      expect(item.pk).toBe('ch1#mycc##mykey');
      expect(item.sk).toBeUndefined();
    });

    it('names the collection for private state: pk={channel}#{chaincode}#{collection}#{key}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePrivateState('mykey')]);

      const [item] = itemsFor('fabric-state');
      expect(item.pk).toBe('ch1#mycc#col1#mykey');
      expect(item.sk).toBeUndefined();
    });

    it('gives one chaincode as many partition keys as it has keys', async () => {
      // The defect this replaced: every key of a chaincode shared one partition
      // key, and DynamoDB caps a single partition key value at ~1,000 WCU/s.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      const records: ExtractionRecord[] = Array.from({ length: 40 }, (_, i) =>
        makePublicState(`k${i}`),
      );

      await adapter.replayBatch(records);

      const partitions = new Set(itemsFor('fabric-state').map((i) => i.pk));
      expect(partitions.size).toBe(40);
    });

    it('keeps a public key apart from the same key in a collection', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState('k1'), makePrivateState('k1')]);

      const items = itemsFor('fabric-state');
      expect(items.map((i) => i.pk)).toEqual(['ch1#mycc##k1', 'ch1#mycc#col1#k1']);
    });
  });

  describe('duplicate primary keys within a batch', () => {
    it('keeps the last write to a repeated state key', async () => {
      // A resumed extraction appends to its NDJSON files, so a batch can carry
      // one key twice. BatchWriteItem rejects the whole request for that, where
      // the serial PutItem loop this replaced was last-wins.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        { ...makePublicState('k1'), value: 'first' },
        { ...makePublicState('k1'), value: 'last' },
      ]);

      const items = itemsFor('fabric-state');
      expect(items).toHaveLength(1);
      expect(items[0].value).toBe('last');
    });

    it('collapses before chunking, so the outcome does not depend on batch size', async () => {
      // 25 distinct keys and then a repeat of the first: collapsing per chunk
      // would leave the repeat in a second request and both copies written.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        ...Array.from({ length: 25 }, (_, i) => makePublicState(`k${i}`)),
        { ...makePublicState('k0'), value: 'last' },
      ]);

      expect(requestsFor('fabric-state')).toHaveLength(1);
      const items = itemsFor('fabric-state');
      expect(items).toHaveLength(25);
      expect(items.find((i) => i.pk === 'ch1#mycc##k0').value).toBe('last');
    });

    it('collapses a repeated history record, which has the same primary key', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        makePublicHistory('k1', 'tx1'),
        makePublicHistory('k1', 'tx1'),
      ]);

      expect(itemsFor('fabric-history')).toHaveLength(1);
    });

    it('keeps two versions of one key, which differ in the sort key', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        makePrivateHistory('k1', 'tx1', 1, 0),
        makePrivateHistory('k1', 'tx2', 2, 0),
      ]);

      expect(itemsFor('fabric-history')).toHaveLength(2);
    });

    it('does not collapse public and private state onto one item', async () => {
      // Both are written to the state table in one call, and public state's
      // empty collection is the only thing separating the two partition keys.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState('k1'), makePrivateState('k1')]);

      expect(itemsFor('fabric-state')).toHaveLength(2);
    });
  });

  describe('batch concurrency', () => {
    /** Resolve every promise and microtask the adapter is waiting on. */
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('keeps several BatchWriteItem requests in flight, capped at eight', async () => {
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];
      mockSendFn.mockImplementation((cmd: any) => {
        if (cmd._tag !== 'BatchWrite') return Promise.resolve({});
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => {
          release.push(() => {
            inFlight--;
            resolve({});
          });
        });
      });

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      // 250 keys is ten chunks of 25 — more than one wave.
      const done = adapter.replayBatch(
        Array.from({ length: 250 }, (_, i) => makePublicState(`k${i}`)),
      );

      await flush();
      expect(release).toHaveLength(8);

      while (release.length > 0) {
        for (const settle of release.splice(0, release.length)) settle();
        await flush();
      }
      await done;

      expect(peak).toBe(8);
      expect(requestsFor('fabric-state')).toHaveLength(10);
    });

    it('sends a single wave serially when there is only one', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch(
        Array.from({ length: 50 }, (_, i) => makePublicState(`k${i}`)),
      );

      expect(requestsFor('fabric-state')).toHaveLength(2);
    });
  });

  describe('replayBatch() — history records', () => {
    it('sends BatchWriteCommand for history records', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      const records: ExtractionRecord[] = [
        makePublicHistory('k1', 'tx1'),
        makePrivateHistory('k2', 'tx2'),
      ];

      await adapter.replayBatch(records);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).toHaveBeenCalledTimes(1);
    });

    it('uses temporal sort key for public history: sk={blockNumber}#{txIndex}#{txId}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicHistory('mykey', 'mytx')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const [[callArg]] = BatchWriteCommand.mock.calls;
      const item = callArg.RequestItems['fabric-history'][0].PutRequest.Item;
      expect(item.pk).toBe('ch1#mycc#mykey');
      expect(item.sk).toBe('000000000001#0000#mytx');
      expect(item.txIndex).toBe(0);
    });

    it('uses temporal sort key for private history: sk={blockNumber}#{txIndex}#{txId}#{collection}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePrivateHistory('mykey', 'mytx')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const [[callArg]] = BatchWriteCommand.mock.calls;
      const item = callArg.RequestItems['fabric-history'][0].PutRequest.Item;
      expect(item.pk).toBe('ch1#mycc#mykey');
      expect(item.sk).toBe('000000000001#0000#mytx#col1');
      expect(item.blockNumber).toBe(1);
      expect(item.txIndex).toBe(0);
    });

    it('refuses the batch when historyTable is not configured', async () => {
      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });

      await expect(
        adapter.replayBatch([makePublicHistory('k1', 'tx1')]),
      ).rejects.toThrow(/historyTable \(public_history, private_history\)/);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).not.toHaveBeenCalled();
    });
  });

  describe('replayBatch() — block metadata records', () => {
    it('sends BatchWriteCommand for metadata records', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeBlockMetadata(5, 'tx1')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).toHaveBeenCalledTimes(1);
    });

    it('uses padded block number in pk and temporal sort key for metadata', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeBlockMetadata(42, 'txabc')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const [[callArg]] = BatchWriteCommand.mock.calls;
      const item = callArg.RequestItems['fabric-metadata'][0].PutRequest.Item;
      expect(item.pk).toBe('ch1#000000000042');
      expect(item.sk).toBe('0000#txabc');
    });

    it('refuses the batch when metadataTable is not configured', async () => {
      const adapter = new DynamoDBAdapter({
        region: 'us-east-1',
        stateTable: 'fabric-state',
        historyTable: 'fabric-history',
      });

      await expect(
        adapter.replayBatch([makeBlockMetadata(1, 'tx1')]),
      ).rejects.toThrow(/metadataTable \(block_metadata\)/);

      // Refusal happens before any write, so the configured tables stay untouched
      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).not.toHaveBeenCalled();
    });
  });

  describe('replayBatch() — identity records', () => {
    it('sends one guarded UpdateCommand per monotone attribute, per record', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        makeIdentity('Org1MSP', 'fp1'),
        makeIdentity('Org2MSP', 'fp2'),
      ]);

      // firstSeenBlock, lastSeenBlock, and txCount each need their own
      // condition — see the `identity idempotency` block below.
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).toHaveBeenCalledTimes(6);
    });

    it('uses correct pk for identity: {mspId}#{certFingerprint}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'sha256:abc')]);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      for (const [callArg] of UpdateCommand.mock.calls) {
        expect(callArg.Key.pk).toBe('Org1MSP#sha256:abc');
      }
    });

    it('refuses the batch when identityTable is not configured', async () => {
      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });

      await expect(
        adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]),
      ).rejects.toThrow(/identityTable \(identity\)/);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand).not.toHaveBeenCalled();
    });
  });

  describe('replayBatch() — private_hash records', () => {
    function makePrivateHash(key: string, txId: string): PrivateHashRecord {
      return {
        _type: 'private_hash',
        channel: 'ch1',
        chaincode: 'mycc',
        collection: 'col1',
        key,
        hash: `sha256:${key}${txId}`,
        blockNumber: 1,
        txId,
        txIndex: 0,
      };
    }

    it('sends BatchWriteCommand for private_hash records', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePrivateHash('k1', 'tx1')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const hashCalls = BatchWriteCommand.mock.calls.filter((c: any) =>
        'fabric-private-hashes' in c[0].RequestItems,
      );
      expect(hashCalls).toHaveLength(1);
    });

    it('keys by ledger key then time: pk={channel}#{chaincode}#{collection}#{key}', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePrivateHash('mykey', 'mytx')]);

      const [item] = itemsFor('fabric-private-hashes');
      expect(item.pk).toBe('ch1#mycc#col1#mykey');
      expect(item.sk).toBe('000000000001#0000#mytx');
      expect(item.hash).toBe('sha256:mykeymytx');
      expect(item.blockNumber).toBe(1);
    });

    it('gives one collection as many partition keys as it has keys', async () => {
      // At tier 3 this table takes one item per private write — more items than
      // state holds — so a partition key of channel, chaincode and collection
      // was the same hot-partition ceiling on more traffic.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch(
        Array.from({ length: 30 }, (_, i) => makePrivateHash(`k${i}`, `tx${i}`)),
      );

      const partitions = new Set(itemsFor('fabric-private-hashes').map((i) => i.pk));
      expect(partitions.size).toBe(30);
    });

    it('escapes a composite key in the partition key', async () => {
      const NUL = String.fromCharCode(0);
      const composite = `color~id${NUL}blue${NUL}asset1`;
      const escaped = 'b64:' + Buffer.from(composite, 'utf-8').toString('base64');

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePrivateHash(composite, 'mytx')]);

      const [item] = itemsFor('fabric-private-hashes');
      expect(item.pk).toBe(`ch1#mycc#col1#${escaped}`);
    });

    it('refuses the batch when privateHashTable is not configured', async () => {
      const adapter = new DynamoDBAdapter({ region: 'us-east-1', stateTable: 'fabric-state' });

      await expect(
        adapter.replayBatch([makePrivateHash('k1', 'tx1')]),
      ).rejects.toThrow(/privateHashTable \(private_hash\)/);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).not.toHaveBeenCalled();
    });
  });

  describe('BatchWriteItem chunking', () => {
    it('chunks history writes into groups of 25 when more than 25 items are present', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);

      // Build 30 public history records
      const records: ExtractionRecord[] = Array.from({ length: 30 }, (_, i) =>
        makePublicHistory(`k${i}`, `tx${i}`),
      );

      await adapter.replayBatch(records);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      // Expect 2 calls: one with 25 items, one with 5 items
      const historyCalls = BatchWriteCommand.mock.calls.filter((c: any) =>
        'fabric-history' in c[0].RequestItems,
      );
      expect(historyCalls).toHaveLength(2);
      expect(historyCalls[0][0].RequestItems['fabric-history']).toHaveLength(25);
      expect(historyCalls[1][0].RequestItems['fabric-history']).toHaveLength(5);
    });

    it('sends exactly 25 items per chunk when count is an exact multiple of 25', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);

      const records: ExtractionRecord[] = Array.from({ length: 25 }, (_, i) =>
        makePublicHistory(`k${i}`, `tx${i}`),
      );

      await adapter.replayBatch(records);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const historyCalls = BatchWriteCommand.mock.calls.filter((c: any) =>
        'fabric-history' in c[0].RequestItems,
      );
      expect(historyCalls).toHaveLength(1);
      expect(historyCalls[0][0].RequestItems['fabric-history']).toHaveLength(25);
    });

    it('chunks metadata writes into groups of 25', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);

      const records: ExtractionRecord[] = Array.from({ length: 26 }, (_, i) =>
        makeBlockMetadata(i, `tx${i}`),
      );

      await adapter.replayBatch(records);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const metaCalls = BatchWriteCommand.mock.calls.filter((c: any) =>
        'fabric-metadata' in c[0].RequestItems,
      );
      expect(metaCalls).toHaveLength(2);
      expect(metaCalls[0][0].RequestItems['fabric-metadata']).toHaveLength(25);
      expect(metaCalls[1][0].RequestItems['fabric-metadata']).toHaveLength(1);
    });
  });

  describe('UnprocessedItems', () => {
    /** Run the retry loop without waiting out its backoff. */
    function skipBackoff(): jest.SpyInstance {
      return jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(((cb: () => void) => {
          cb();
          return 0 as any;
        }) as any);
    }

    /**
     * Reply to BatchWrite by handing back the first `unwritten` requests as
     * unprocessed, for the first `failures` calls.
     */
    function throttleFor(failures: number, unwritten = 1): void {
      let call = 0;
      mockSendFn.mockImplementation((cmd: any) => {
        if (cmd._tag !== 'BatchWrite') return Promise.resolve({});
        const table = Object.keys(cmd.input.RequestItems)[0];
        if (call++ < failures) {
          return Promise.resolve({
            UnprocessedItems: {
              [table]: cmd.input.RequestItems[table].slice(0, unwritten),
            },
          });
        }
        return Promise.resolve({});
      });
    }

    it('retries only the items DynamoDB declined', async () => {
      throttleFor(1, 2);
      const timers = skipBackoff();
      try {
        const adapter = new DynamoDBAdapter(BASE_CONFIG);
        await adapter.replayBatch([
          makePublicHistory('k1', 'tx1'),
          makePublicHistory('k2', 'tx2'),
          makePublicHistory('k3', 'tx3'),
        ]);

        const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
        expect(BatchWriteCommand).toHaveBeenCalledTimes(2);
        // Second attempt carries only the two declined items, not all three
        expect(
          BatchWriteCommand.mock.calls[1][0].RequestItems['fabric-history'],
        ).toHaveLength(2);
      } finally {
        timers.mockRestore();
      }
    });

    it('succeeds once the retry is accepted', async () => {
      throttleFor(2);
      const timers = skipBackoff();
      try {
        const adapter = new DynamoDBAdapter(BASE_CONFIG);
        await expect(
          adapter.replayBatch([makePublicHistory('k1', 'tx1')]),
        ).resolves.toBeUndefined();
      } finally {
        timers.mockRestore();
      }
    });

    it('backs off exponentially between attempts', async () => {
      throttleFor(3);
      const timers = skipBackoff();
      try {
        const adapter = new DynamoDBAdapter(BASE_CONFIG);
        await adapter.replayBatch([makePublicHistory('k1', 'tx1')]);

        const delays = timers.mock.calls.map((c) => c[1]);
        expect(delays).toEqual([100, 200, 400]);
      } finally {
        timers.mockRestore();
      }
    });

    it('fails the batch when items stay unwritten after every attempt', async () => {
      throttleFor(Number.MAX_SAFE_INTEGER);
      const timers = skipBackoff();
      try {
        const adapter = new DynamoDBAdapter(BASE_CONFIG);
        await expect(
          adapter.replayBatch([makePublicHistory('k1', 'tx1')]),
        ).rejects.toThrow(/left 1 of 1 item\(s\) unwritten in fabric-history/);

        const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
        expect(BatchWriteCommand).toHaveBeenCalledTimes(6);
      } finally {
        timers.mockRestore();
      }
    });

    it('names throttling as the cause and replay as resumable', async () => {
      throttleFor(Number.MAX_SAFE_INTEGER);
      const timers = skipBackoff();
      try {
        const adapter = new DynamoDBAdapter(BASE_CONFIG);
        await expect(
          adapter.replayBatch([makePublicHistory('k1', 'tx1')]),
        ).rejects.toThrow(/PAY_PER_REQUEST.*last checkpoint/s);
      } finally {
        timers.mockRestore();
      }
    });

    it('treats an empty UnprocessedItems map as success', async () => {
      mockSendFn.mockImplementation(() =>
        Promise.resolve({ UnprocessedItems: {} }),
      );

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await expect(
        adapter.replayBatch([makePublicHistory('k1', 'tx1')]),
      ).resolves.toBeUndefined();

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      expect(BatchWriteCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('key escaping', () => {
    /** U+0000 as a code point, so this file holds no control characters. */
    const NUL = String.fromCharCode(0);
    const composite = `color~id${NUL}blue${NUL}asset1`;
    const escaped = 'b64:' + Buffer.from(composite, 'utf-8').toString('base64');

    it('escapes a composite key in a state partition key', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState(composite)]);

      const [item] = itemsFor('fabric-state');
      expect(item.pk).toBe(`ch1#mycc##${escaped}`);
    });

    it('escapes a composite key in a history partition key', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicHistory(composite, 'tx1')]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const item =
        BatchWriteCommand.mock.calls[0][0].RequestItems['fabric-history'][0]
          .PutRequest.Item;
      expect(item.pk).toBe(`ch1#mycc#${escaped}`);
    });

    it('escapes composite keys listed in block metadata', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      const record = makeBlockMetadata(1, 'tx1');
      record.keysWritten = [composite];
      record.keysDeleted = ['plain'];
      await adapter.replayBatch([record]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const item =
        BatchWriteCommand.mock.calls[0][0].RequestItems['fabric-metadata'][0]
          .PutRequest.Item;
      expect(item.keysWritten).toEqual([escaped]);
      expect(item.keysDeleted).toEqual(['plain']);
    });

    it('leaves an ordinary key verbatim, so a Scan filter still matches it', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState('asset1')]);

      const [item] = itemsFor('fabric-state');
      expect(item.pk).toBe('ch1#mycc##asset1');
    });
  });

  describe('value encoding', () => {
    it('stores a text value with a null encoding marker', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makePublicState('k1')]);

      expect(itemsFor('fabric-state')[0]).toMatchObject({
        value: 'v-k1',
        valueEncoding: null,
      });
    });

    it('stores a binary value as base64 with its marker', async () => {
      const bytes = Buffer.from([0x1f, 0x8b, 0xff]);
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        {
          ...makePublicState('k1'),
          value: bytes.toString('base64'),
          valueEncoding: 'base64',
        },
      ]);

      expect(itemsFor('fabric-state')[0]).toMatchObject({
        value: bytes.toString('base64'),
        valueEncoding: 'base64',
      });
    });

    it('promotes a value holding a JSON-escaped NUL to base64', async () => {
      const marshalled = '{"key":"a\\u0000b"}';
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([{ ...makePublicState('k1'), value: marshalled }]);

      const [item] = itemsFor('fabric-state');
      expect(item.valueEncoding).toBe('base64');
      expect(Buffer.from(item.value, 'base64').toString('utf-8')).toBe(marshalled);
    });

    it('carries the marker on history items too', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([
        { ...makePublicHistory('k1', 'tx1'), value: 'AP8=', valueEncoding: 'base64' },
      ]);

      const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
      const item =
        BatchWriteCommand.mock.calls[0][0].RequestItems['fabric-history'][0]
          .PutRequest.Item;
      expect(item).toMatchObject({ value: 'AP8=', valueEncoding: 'base64' });
    });
  });

  describe('identity idempotency', () => {
    /** The guarded update targeting `attribute`, or undefined if none was sent. */
    function updateFor(attribute: string): any {
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      return UpdateCommand.mock.calls
        .map((call: any[]) => call[0])
        .find((input: any) =>
          input.ConditionExpression?.includes(`attribute_not_exists(${attribute})`),
        );
    }

    it('assigns txCount rather than adding to it', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);

      const update = updateFor('txCount');
      // ADD or `txCount + :tc` would inflate the total on every replay
      expect(update.UpdateExpression).toBe('SET txCount = :v');
      expect(update.UpdateExpression).not.toMatch(/\bADD\b/);
      expect(update.ExpressionAttributeValues[':v']).toBe(5);
    });

    it('only ever moves firstSeenBlock earlier', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);

      // if_not_exists would be first-writer-wins: a member exporting from an
      // earlier block could not correct a later value already stored.
      expect(updateFor('firstSeenBlock').ConditionExpression).toBe(
        'attribute_not_exists(firstSeenBlock) OR firstSeenBlock > :v',
      );
    });

    it('only ever moves lastSeenBlock and txCount later', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);

      expect(updateFor('lastSeenBlock').ConditionExpression).toBe(
        'attribute_not_exists(lastSeenBlock) OR lastSeenBlock < :v',
      );
      expect(updateFor('txCount').ConditionExpression).toBe(
        'attribute_not_exists(txCount) OR txCount < :v',
      );
    });

    it('creates the item with commonName and org on a fresh key', async () => {
      // Only the first update runs unconditionally on a nonexistent item, so
      // the descriptive attributes have to travel with it.
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);

      const update = updateFor('firstSeenBlock');
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand.mock.calls[0][0]).toBe(update);
      expect(update.UpdateExpression).toBe(
        'SET commonName = :cn, org = :org, firstSeenBlock = :v',
      );
    });

    it('issues the same updates for a repeated replay of the same record', async () => {
      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);
      await adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]);

      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      expect(UpdateCommand.mock.calls).toHaveLength(6);
      expect(UpdateCommand.mock.calls.slice(0, 3).map((c: any[]) => c[0])).toEqual(
        UpdateCommand.mock.calls.slice(3).map((c: any[]) => c[0]),
      );
    });

    it('treats a failed condition as success, not an error', async () => {
      // The stored figure is already wider — the destination is where this
      // update was trying to get it, so the batch must not fail.
      const conditionFailed = Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      });
      mockSendFn.mockRejectedValueOnce(conditionFailed);

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await expect(
        adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]),
      ).resolves.toBeUndefined();
    });

    it('still surfaces a real failure on a guarded update', async () => {
      mockSendFn.mockRejectedValueOnce(
        Object.assign(new Error('Throughput exceeded'), {
          name: 'ProvisionedThroughputExceededException',
        }),
      );

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await expect(
        adapter.replayBatch([makeIdentity('Org1MSP', 'fp1')]),
      ).rejects.toMatchObject({ name: 'ReplayError' });
    });
  });

  describe('error handling', () => {
    it('wraps DynamoDB errors in ReplayError, naming the SDK error in the message', async () => {
      const cause = Object.assign(new Error('Internal server error'), { name: 'InternalServerError' });
      mockSendFn.mockRejectedValueOnce(cause);

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await expect(adapter.replayBatch([makePublicState('k1')])).rejects.toMatchObject({
        name: 'ReplayError',
        cause,
        // The CLI prints only the message, so the SDK's reason must be in it.
        message: 'DynamoDB batch replay failed: InternalServerError: Internal server error',
      });
    });
  });

  describe('SDK retries', () => {
    it('raises the SDK attempt limit above its default of 3', () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      DynamoDBClient.mockClear();

      new DynamoDBAdapter(BASE_CONFIG);

      expect(DynamoDBClient).toHaveBeenCalledWith(
        expect.objectContaining({ maxAttempts: DYNAMODB_MAX_ATTEMPTS }),
      );
      expect(DYNAMODB_MAX_ATTEMPTS).toBeGreaterThan(3);
    });
  });

  describe('close()', () => {
    it('destroys the DynamoDB client', async () => {
      const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
      const mockDestroy = jest.fn();
      DynamoDBClient.mockImplementationOnce(function (this: any) {
        this.send = mockSendFn;
        this.destroy = mockDestroy;
      });

      const adapter = new DynamoDBAdapter(BASE_CONFIG);
      await adapter.close();

      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('DynamoDBAdapter state deletes (replay --since)', () => {
  beforeEach(() => {
    mockSendFn.mockReset();
    mockSendFn.mockImplementation(() => Promise.resolve({}));
    require('@aws-sdk/lib-dynamodb').BatchWriteCommand.mockClear();
  });

  it('deletes the state item of each key, public and private, by its partition key', async () => {
    const adapter = new DynamoDBAdapter(BASE_CONFIG);
    await adapter.replayBatch([
      { _type: 'state_delete', channel: 'ch1', chaincode: 'mycc', key: 'gone' },
      { _type: 'state_delete', channel: 'ch1', chaincode: 'mycc', collection: 'col', key: 'p' },
      { _type: 'state_delete', channel: 'ch1', chaincode: 'mycc', key: 'gone' },
    ]);
    const reqs = requestsFor(BASE_CONFIG.stateTable).flat();
    expect(reqs).toEqual([
      { DeleteRequest: { Key: { pk: keyPartitionKey('ch1', 'mycc', '', 'gone') } } },
      { DeleteRequest: { Key: { pk: keyPartitionKey('ch1', 'mycc', 'col', 'p') } } },
    ]);
  });
});
