import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PrivateDataDeliveryExtractor } from '../src/extraction/private-data/private-data-delivery';
import { PrivateDataBlockCallback } from '../src/discovery/chaincode-discoverer';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { MigrationTier, ChannelInfo } from '../src/types';

/**
 * Helper to build a mock deliverFn that delivers a sequence of blocks
 * with private data.
 */
function mockDeliverFn(
  blocks: Array<{
    blockNumber: number;
    block: any;
    privateDataMap: Record<string, any>;
  }>,
) {
  return async (
    _channelId: string,
    startBlock: number,
    endBlock: number,
    onBlock: PrivateDataBlockCallback,
  ) => {
    for (const b of blocks) {
      if (b.blockNumber >= startBlock && b.blockNumber <= endBlock) {
        await onBlock(b.blockNumber, b.block, b.privateDataMap);
      }
    }
  };
}

/**
 * Helper to build a minimal block structure with tx metadata.
 *
 * `validationCodes` is the block's TRANSACTIONS_FILTER — one code per
 * transaction, 0 = VALID. It defaults to all-valid; pass it to model a
 * transaction the source ledger rejected.
 */
function makeBlock(
  blockNumber: number,
  transactions: Array<{ txId: string; timestamp: string }>,
  validationCodes: number[] = transactions.map(() => 0),
) {
  return {
    header: {
      number: blockNumber,
      data_hash: '',
      previous_hash: '',
    },
    data: {
      data: transactions.map((tx) => ({
        payload: {
          header: {
            channel_header: { tx_id: tx.txId, timestamp: tx.timestamp },
            signature_header: {
              creator: { mspid: 'Org1MSP', id_bytes: 'CN=admin' },
            },
          },
          data: { actions: [] },
        },
      })),
    },
    metadata: { metadata: [[], [], validationCodes] },
  };
}

/** Helper to build a TxPvtReadWriteSet structure (as decoded by fabric-common). */
function makePvtRwSet(
  entries: Array<{
    namespace: string;
    collection: string;
    writes: Array<{ key: string; value: string; is_delete?: boolean }>;
  }>,
) {
  return {
    ns_pvt_rwset: entries.map((e) => ({
      namespace: e.namespace,
      collection_pvt_rwset: [
        {
          collection_name: e.collection,
          rwset: {
            writes: e.writes.map((w) => ({
              key: w.key,
              value: Buffer.from(w.value),
              is_delete: w.is_delete ?? false,
            })),
          },
        },
      ],
    })),
  };
}

describe('PrivateDataDeliveryExtractor', () => {
  let tmpDir: string;
  let writer: NdjsonWriter;
  let layout: FileLayoutManager;

  const channel: ChannelInfo = {
    channelId: 'mychannel',
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: [
          { name: 'privateData', policy: 'OR("Org1MSP.member")', requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: false, memberOnlyWrite: false },
          { name: 'secretData', policy: 'OR("Org2MSP.member")', requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: false, memberOnlyWrite: false },
        ],
      },
    ],
    ledgerHeight: 5,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvtdata-test-'));
    writer = new NdjsonWriter(tmpDir);
    layout = new FileLayoutManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reports the private state it holds while it runs, and none once written', async () => {
    const pvt = (key: string, value: string, isDelete = false) => ({
      '0': makePvtRwSet([{ namespace: 'mycc', collection: 'privateData', writes: [{ key, value, is_delete: isDelete }] }]),
    });
    const tx = (n: number) => makeBlock(n, [{ txId: `tx${n}`, timestamp: '2024-01-01T00:00:00Z' }]);
    const seen: number[] = [];
    const deliverFn = async (_c: string, _s: number, _e: number, onBlock: PrivateDataBlockCallback) => {
      for (const [n, map] of [[0, pvt('a', 'x'.repeat(100))], [1, pvt('a', 'x'.repeat(10))], [2, pvt('a', '', true)]] as const) {
        await onBlock(n, tx(n), map);
        seen.push(extractor.heldBytes());
      }
    };
    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    await extractor.extract({ ...channel, ledgerHeight: 3 });

    // Grows with a write, shrinks when the value is overwritten smaller, and is
    // released by the delete
    expect(seen[0]).toBeGreaterThan(100);
    expect(seen[1]).toBe(seen[0] - 90);
    expect(seen[2]).toBe(0);
    expect(extractor.heldBytes()).toBe(0);
  });

  test('stops at the next block once cancelled', async () => {
    const delivered: number[] = [];
    const deliverFn = async (_c: string, _s: number, _e: number, onBlock: PrivateDataBlockCallback) => {
      for (let n = 0; n < 5; n++) {
        if (n === 2) extractor.cancel(new Error('walk failed at block 7'));
        await onBlock(n, makeBlock(n, []), {});
        delivered.push(n);
      }
    };
    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    await expect(extractor.extract(channel)).rejects.toThrow(
      /Private data delivery for mychannel stopped at block 2: the public walk failed/,
    );
    expect(delivered).toEqual([0, 1]);
  });

  test('extracts private state from delivered blocks', async () => {
    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [
                { key: 'asset1', value: '{"owner":"alice"}' },
                { key: 'asset2', value: '{"owner":"bob"}' },
              ],
            },
          ]),
        },
      },
      {
        blockNumber: 1,
        block: makeBlock(1, [{ txId: 'tx2', timestamp: '2024-01-01T01:00:00Z' }]),
        privateDataMap: {},
      },
      {
        blockNumber: 2,
        block: makeBlock(2, [{ txId: 'tx3', timestamp: '2024-01-01T02:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'asset1', value: '{"owner":"charlie"}' }],
            },
          ]),
        },
      },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      { blockNumber: 4, block: makeBlock(4, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    const summary = await extractor.extract(channel);

    expect(summary.processedBlocks).toBe(5);
    expect(summary.currentStateKeys).toBe(2); // asset1 (updated) + asset2
    expect(summary.collectionsWithData).toContain('mycc:privateData');
    // secretData had no private data delivered (org not authorized)
    expect(summary.collectionsHashOnly).toContain('mycc:secretData');

    // Flush writes before reading
    await writer.close();

    // Read the output file and verify records
    const outputPath = path.join(tmpDir, layout.privateStatePath('mychannel', 'mycc', 'privateData'));
    expect(fs.existsSync(outputPath)).toBe(true);

    const lines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const records = lines.map((l) => JSON.parse(l));

    // asset1 should have the LATEST value (charlie, not alice)
    const asset1 = records.find((r: any) => r.key === 'asset1');
    expect(asset1).toBeDefined();
    expect(asset1.value).toBe('{"owner":"charlie"}');
    expect(asset1.chaincode).toBe('mycc');
    expect(asset1.collection).toBe('privateData');
    expect(asset1._type).toBe('private_state');

    const asset2 = records.find((r: any) => r.key === 'asset2');
    expect(asset2).toBeDefined();
    expect(asset2.value).toBe('{"owner":"bob"}');
  });

  // An implicit collection exists for every channel org on every 2.x chaincode
  // whether or not it was ever written to, so "declared but nothing delivered"
  // says nothing about it. Whether it held data is settled by the coverage
  // report, which reads the hash files the block walk wrote.
  test('omits implicit collections from collectionsHashOnly', async () => {
    const withImplicit: ChannelInfo = {
      ...channel,
      chaincodes: [
        {
          ...channel.chaincodes[0],
          collections: [
            ...channel.chaincodes[0].collections,
            { name: '_implicit_org_Org2MSP', policy: 'OR("Org2MSP.member")',
              requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0,
              memberOnlyRead: false, memberOnlyWrite: false, implicit: true },
            { name: '_implicit_org_Org1MSP', policy: 'OR("Org1MSP.member")',
              requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0,
              memberOnlyRead: false, memberOnlyWrite: false, implicit: true },
          ],
        },
      ],
    };

    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: '_implicit_org_Org1MSP',
              writes: [{ key: 'asset1', value: '{"owner":"alice"}' }],
            },
          ]),
        },
      },
      ...[1, 2, 3, 4].map((n) => ({
        blockNumber: n, block: makeBlock(n, []), privateDataMap: {},
      })),
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    const summary = await extractor.extract(withImplicit);

    expect(summary.collectionsHashOnly).toEqual([
      'mycc:privateData',
      'mycc:secretData',
    ]);
    // The one that was written to is still reported, from the delivered rwset.
    expect(summary.collectionsWithData).toEqual(['mycc:_implicit_org_Org1MSP']);
  });

  test('handles deletes correctly in state accumulation', async () => {
    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [
                { key: 'ephemeral', value: 'temp-value' },
                { key: 'keeper', value: 'keep-me' },
              ],
            },
          ]),
        },
      },
      {
        blockNumber: 1,
        block: makeBlock(1, [{ txId: 'tx2', timestamp: '2024-01-01T01:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'ephemeral', value: '', is_delete: true }],
            },
          ]),
        },
      },
      { blockNumber: 2, block: makeBlock(2, []), privateDataMap: {} },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      { blockNumber: 4, block: makeBlock(4, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    const summary = await extractor.extract(channel);

    // Only 'keeper' should remain — 'ephemeral' was deleted
    expect(summary.currentStateKeys).toBe(1);

    await writer.close();

    const outputPath = path.join(tmpDir, layout.privateStatePath('mychannel', 'mycc', 'privateData'));
    const lines = fs.readFileSync(outputPath, 'utf-8').trim().split('\n');
    const records = lines.map((l) => JSON.parse(l));

    expect(records).toHaveLength(1);
    expect(records[0].key).toBe('keeper');
  });

  test('emits history records at Tier 3', async () => {
    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'asset1', value: 'v1' }],
            },
          ]),
        },
      },
      {
        blockNumber: 1,
        block: makeBlock(1, [{ txId: 'tx2', timestamp: '2024-01-01T01:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'asset1', value: 'v2' }],
            },
          ]),
        },
      },
      { blockNumber: 2, block: makeBlock(2, []), privateDataMap: {} },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      { blockNumber: 4, block: makeBlock(4, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.FullHistory);

    await extractor.extract(channel);
    await writer.close();

    // Check history file
    const historyPath = path.join(tmpDir, layout.privateHistoryPath('mychannel', 'mycc', 'privateData'));
    expect(fs.existsSync(historyPath)).toBe(true);

    const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n');
    const records = lines.map((l) => JSON.parse(l));

    // Should have 2 history entries (one per write)
    expect(records).toHaveLength(2);
    expect(records[0]._type).toBe('private_history');
    expect(records[0].key).toBe('asset1');
    expect(records[0].value).toBe('v1');
    expect(records[0].txId).toBe('tx1');
    expect(records[0].blockNumber).toBe(0);
    expect(records[0].txIndex).toBe(0);
    expect(records[1].value).toBe('v2');
    expect(records[1].txId).toBe('tx2');
    expect(records[1].blockNumber).toBe(1);
    expect(records[1].txIndex).toBe(0);
  });

  test('does not emit history records at Tier 1', async () => {
    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'asset1', value: 'v1' }],
            },
          ]),
        },
      },
      { blockNumber: 1, block: makeBlock(1, []), privateDataMap: {} },
      { blockNumber: 2, block: makeBlock(2, []), privateDataMap: {} },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      { blockNumber: 4, block: makeBlock(4, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    await extractor.extract(channel);

    const historyPath = path.join(tmpDir, layout.privateHistoryPath('mychannel', 'mycc', 'privateData'));
    expect(fs.existsSync(historyPath)).toBe(false);
  });

  test('handles multiple chaincodes and collections', async () => {
    const multiChannel: ChannelInfo = {
      channelId: 'mychannel',
      chaincodes: [
        {
          name: 'ccA',
          version: '1.0',
          sequence: 1,
          collections: [
            { name: 'collX', policy: '', requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: false, memberOnlyWrite: false },
          ],
        },
        {
          name: 'ccB',
          version: '1.0',
          sequence: 1,
          collections: [
            { name: 'collY', policy: '', requiredPeerCount: 0, maxPeerCount: 1, blockToLive: 0, memberOnlyRead: false, memberOnlyWrite: false },
          ],
        },
      ],
      ledgerHeight: 2,
    };

    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [
          { txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' },
          { txId: 'tx2', timestamp: '2024-01-01T00:00:01Z' },
        ]),
        privateDataMap: {
          '0': makePvtRwSet([
            { namespace: 'ccA', collection: 'collX', writes: [{ key: 'k1', value: 'fromA' }] },
          ]),
          '1': makePvtRwSet([
            { namespace: 'ccB', collection: 'collY', writes: [{ key: 'k2', value: 'fromB' }] },
          ]),
        },
      },
      { blockNumber: 1, block: makeBlock(1, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    const summary = await extractor.extract(multiChannel);

    expect(summary.currentStateKeys).toBe(2);
    expect(summary.collectionsWithData).toContain('ccA:collX');
    expect(summary.collectionsWithData).toContain('ccB:collY');

    await writer.close();

    // Verify separate output files per chaincode and collection
    const pathA = path.join(
      tmpDir, layout.privateStatePath('mychannel', 'ccA', 'collX'),
    );
    const pathB = path.join(
      tmpDir, layout.privateStatePath('mychannel', 'ccB', 'collY'),
    );
    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);

    const recA = JSON.parse(fs.readFileSync(pathA, 'utf-8').trim());
    expect(recA.chaincode).toBe('ccA');
    expect(recA.key).toBe('k1');

    const recB = JSON.parse(fs.readFileSync(pathB, 'utf-8').trim());
    expect(recB.chaincode).toBe('ccB');
    expect(recB.key).toBe('k2');
  });

  test('skips system chaincode private data', async () => {
    const deliverFn = mockDeliverFn([
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx1', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': {
            ns_pvt_rwset: [
              {
                namespace: '_lifecycle',
                collection_pvt_rwset: [
                  {
                    collection_name: '_implicit_org_Org1MSP',
                    rwset: {
                      writes: [{ key: 'syskey', value: Buffer.from('sysval'), is_delete: false }],
                    },
                  },
                ],
              },
              {
                namespace: 'mycc',
                collection_pvt_rwset: [
                  {
                    collection_name: 'privateData',
                    rwset: {
                      writes: [{ key: 'real', value: Buffer.from('data'), is_delete: false }],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      { blockNumber: 1, block: makeBlock(1, []), privateDataMap: {} },
      { blockNumber: 2, block: makeBlock(2, []), privateDataMap: {} },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      { blockNumber: 4, block: makeBlock(4, []), privateDataMap: {} },
    ]);

    const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

    const summary = await extractor.extract(channel);

    // Only the 'mycc' write should appear, not '_lifecycle'
    expect(summary.currentStateKeys).toBe(1);
  });

  test('re-derives state and history from genesis after an interrupted attempt', async () => {
    const statePath = layout.privateStatePath(
      'mychannel', 'mycc', 'privateData',
    );
    const historyPath = layout.privateHistoryPath(
      'mychannel', 'mycc', 'privateData',
    );
    fs.mkdirSync(path.dirname(path.join(tmpDir, statePath)), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, statePath),
      JSON.stringify({
        _type: 'private_state', channel: 'mychannel', chaincode: 'mycc',
        collection: 'privateData', key: 'stale-partial', value: 'stale',
      }) + '\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, historyPath),
      JSON.stringify({
        _type: 'private_history', channel: 'mychannel', chaincode: 'mycc',
        collection: 'privateData', key: 'stale-partial', value: 'stale',
        txId: 'stale', blockNumber: 99, txIndex: 0, timestamp: '',
        isDelete: false,
      }) + '\n',
    );

    const blocks = [
      {
        blockNumber: 0,
        block: makeBlock(0, [{ txId: 'tx0', timestamp: '2024-01-01T00:00:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([{
            namespace: 'mycc', collection: 'privateData',
            writes: [
              { key: 'before-checkpoint', value: 'v1' },
              { key: 'deleted-later', value: 'temporary' },
            ],
          }]),
        },
      },
      { blockNumber: 1, block: makeBlock(1, []), privateDataMap: {} },
      {
        blockNumber: 2,
        block: makeBlock(2, [{ txId: 'tx2', timestamp: '2024-01-01T00:02:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([{
            namespace: 'mycc', collection: 'privateData',
            writes: [
              { key: 'before-checkpoint', value: 'v2' },
              { key: 'deleted-later', value: '', is_delete: true },
            ],
          }]),
        },
      },
      { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
      {
        blockNumber: 4,
        block: makeBlock(4, [{ txId: 'tx4', timestamp: '2024-01-01T00:04:00Z' }]),
        privateDataMap: {
          '0': makePvtRwSet([{
            namespace: 'mycc', collection: 'privateData',
            writes: [{ key: 'tail-key', value: 'tail' }],
          }]),
        },
      },
    ];
    const deliverFn = jest.fn(mockDeliverFn(blocks));
    const extractor = new PrivateDataDeliveryExtractor(
      deliverFn, writer, layout, MigrationTier.FullHistory,
    );

    const summary = await extractor.extract(channel);
    await writer.close();

    expect(deliverFn).toHaveBeenCalledWith(
      'mychannel', 0, 4, expect.any(Function),
    );
    expect(summary.processedBlocks).toBe(5);
    expect(readRecords(statePath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'before-checkpoint', value: 'v2' }),
        expect.objectContaining({ key: 'tail-key', value: 'tail' }),
      ]),
    );
    expect(readRecords(statePath).map((r) => r.key).sort()).toEqual([
      'before-checkpoint', 'tail-key',
    ]);
    expect(readRecords(historyPath).map((r) => [r.blockNumber, r.key, r.isDelete]))
      .toEqual([
        [0, 'before-checkpoint', false],
        [0, 'deleted-later', false],
        [2, 'before-checkpoint', false],
        [2, 'deleted-later', true],
        [4, 'tail-key', false],
      ]);
  });

  // The peer stores private data at endorsement time, before validation, so a
  // transaction the source ledger rejected can still arrive with a payload.
  describe('invalid transactions', () => {
    /** Two txs in one block; only the second committed. */
    function blockWithOneRejectedTx() {
      const ENDORSEMENT_POLICY_FAILURE = 10;
      return {
        blockNumber: 0,
        block: makeBlock(
          0,
          [
            { txId: 'rejected', timestamp: '2024-01-01T00:00:00Z' },
            { txId: 'committed', timestamp: '2024-01-01T00:00:01Z' },
          ],
          [ENDORSEMENT_POLICY_FAILURE, 0],
        ),
        privateDataMap: {
          '0': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'never-committed', value: '{"owner":"nobody"}' }],
            },
          ]),
          '1': makePvtRwSet([
            {
              namespace: 'mycc',
              collection: 'privateData',
              writes: [{ key: 'real', value: '{"owner":"alice"}' }],
            },
          ]),
        },
      };
    }

    const emptyTail = [3, 4].map((n) => ({
      blockNumber: n, block: makeBlock(n, []), privateDataMap: {},
    }));

    test('excludes private state written by a rejected transaction', async () => {
      const deliverFn = mockDeliverFn([blockWithOneRejectedTx(), ...emptyTail]);
      const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

      const summary = await extractor.extract(channel);
      await writer.close();

      expect(summary.currentStateKeys).toBe(1);
      const records = readRecords(layout.privateStatePath('mychannel', 'mycc', 'privateData'));
      expect(records.map((r) => r.key)).toEqual(['real']);
    });

    test('excludes private history written by a rejected transaction', async () => {
      const deliverFn = mockDeliverFn([blockWithOneRejectedTx(), ...emptyTail]);
      const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.FullHistory);

      await extractor.extract(channel);
      await writer.close();

      const records = readRecords(layout.privateHistoryPath('mychannel', 'mycc', 'privateData'));
      expect(records.map((r) => r.txId)).toEqual(['committed']);
    });

    test('refuses a block whose private data cannot be told apart from rejects', async () => {
      // Without the filter, an uncommitted write is indistinguishable from a
      // real one — so extraction aborts rather than guessing.
      const deliverFn = mockDeliverFn([
        {
          blockNumber: 0,
          block: makeBlock(0, [{ txId: 'tx1', timestamp: '' }], []),
          privateDataMap: {
            '0': makePvtRwSet([
              {
                namespace: 'mycc',
                collection: 'privateData',
                writes: [{ key: 'asset1', value: 'v1' }],
              },
            ]),
          },
        },
      ]);
      const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

      await expect(extractor.extract(channel)).rejects.toThrow(
        /TRANSACTIONS_FILTER holds 0 code\(s\)/,
      );
    });

    test('tolerates a missing filter on a block with no private data', async () => {
      // Nothing to filter, so nothing to refuse.
      const deliverFn = mockDeliverFn(
        [0, 1, 2, 3, 4].map((n) => ({
          blockNumber: n,
          block: makeBlock(n, [{ txId: `tx${n}`, timestamp: '' }], []),
          privateDataMap: {},
        })),
      );
      const extractor = new PrivateDataDeliveryExtractor(deliverFn, writer, layout, MigrationTier.CurrentState);

      const summary = await extractor.extract(channel);
      expect(summary.processedBlocks).toBe(5);
      expect(summary.currentStateKeys).toBe(0);
    });
  });

  // A block records every private write by hash, whether or not the peer
  // holds the value. When it does not, the key's current value is unknown:
  // keeping the previous value would put a version the source has replaced
  // into current state, and from there into the destination.
  describe('writes the block records by hash but whose values were not delivered', () => {
    const sha = (k: string): Buffer => crypto.createHash('sha256').update(k).digest();
    /** A one-transaction block whose transaction records these private writes by hash. */
    const hashedBlock = (n: number, hashed: Array<{ collection?: string; key: string; isDelete?: boolean }>, valid = true) => {
      const b: any = makeBlock(n, [{ txId: `tx${n}`, timestamp: '' }], [valid ? 0 : 11]);
      const byColl = new Map<string, any[]>();
      for (const h of hashed) {
        const c = h.collection ?? 'privateData';
        byColl.set(c, [...(byColl.get(c) ?? []), { key_hash: sha(h.key), value_hash: Buffer.alloc(32), is_delete: h.isDelete ?? false }]);
      }
      b.data.data[0].payload.data.actions = [{ payload: { action: { proposal_response_payload: { extension: { results: { ns_rwset: [{
        namespace: 'mycc', rwset: { writes: [] },
        collection_hashed_rwset: [...byColl].map(([collection_name, hashed_writes]) => ({ collection_name, hashed_rwset: { hashed_writes } })),
      }] } } } } } }];
      return b;
    };
    const delivered = (key: string, value: string, isDelete = false) => ({
      '0': makePvtRwSet([{ namespace: 'mycc', collection: 'privateData', writes: [{ key, value, is_delete: isDelete }] }]),
    });
    const run = async (blocks: Array<{ blockNumber: number; block: any; privateDataMap: Record<string, any> }>) => {
      const extractor = new PrivateDataDeliveryExtractor(mockDeliverFn(blocks), writer, layout, MigrationTier.FullHistory);
      const summary = await extractor.extract({ ...channel, ledgerHeight: blocks.length });
      await writer.close();
      const state = (coll = 'privateData') => {
        const p = path.join(tmpDir, layout.privateStatePath('mychannel', 'mycc', coll));
        return fs.existsSync(p) ? readRecords(layout.privateStatePath('mychannel', 'mycc', coll)) : [];
      };
      return { summary, state, history: () => readRecords(layout.privateHistoryPath('mychannel', 'mycc', 'privateData')) };
    };

    test('leaves out a key whose latest write was not delivered, instead of keeping its earlier value', async () => {
      const { summary, state, history } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }, { key: 'b' }]), privateDataMap: {
          '0': makePvtRwSet([{ namespace: 'mycc', collection: 'privateData', writes: [{ key: 'a', value: 'a1' }, { key: 'b', value: 'b1' }] }]),
        } },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a' }]), privateDataMap: {} },
      ]);
      expect(state().map((r) => [r.key, r.value])).toEqual([['b', 'b1']]);
      expect(history().map((r) => [r.key, r.value])).toEqual([['a', 'a1'], ['b', 'b1']]);
      expect(summary.valuesMissing).toEqual({ 'mycc:privateData': { writes: 1, dropped: 1, firstBlock: 1, lastBlock: 1 } });
    });

    test('holds the value again once a later write of the key is delivered', async () => {
      const { summary, state } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }]), privateDataMap: delivered('a', 'a1') },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a' }]), privateDataMap: {} },
        { blockNumber: 2, block: hashedBlock(2, [{ key: 'a' }]), privateDataMap: delivered('a', 'a3') },
      ]);
      expect(state().map((r) => [r.key, r.value])).toEqual([['a', 'a3']]);
      expect(summary.valuesMissing['mycc:privateData']).toMatchObject({ writes: 1, dropped: 1 });
    });

    test('applies a delete recorded by hash alone, and does not count it as missing', async () => {
      const { summary, state } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }]), privateDataMap: delivered('a', 'a1') },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a', isDelete: true }]), privateDataMap: {} },
      ]);
      expect(state()).toEqual([]);
      expect(summary.valuesMissing).toEqual({});
    });

    test('changes nothing when every hashed write was delivered', async () => {
      const { summary, state } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }]), privateDataMap: delivered('a', 'a1') },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a' }]), privateDataMap: delivered('a', 'a2') },
      ]);
      expect(state().map((r) => [r.key, r.value])).toEqual([['a', 'a2']]);
      expect(summary.valuesMissing).toEqual({});
    });

    test('ignores hashed writes of a rejected transaction', async () => {
      const { state } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }]), privateDataMap: delivered('a', 'a1') },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a' }], false), privateDataMap: {} },
      ]);
      expect(state().map((r) => [r.key, r.value])).toEqual([['a', 'a1']]);
    });

    test('drops a key expired by blockToLive without counting it as missing', async () => {
      const btl: ChannelInfo = {
        ...channel,
        chaincodes: [{ ...channel.chaincodes[0], collections: channel.chaincodes[0].collections.map((c) => ({ ...c, blockToLive: 2 })) }],
      };
      const blocks = [
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }]), privateDataMap: delivered('a', 'a1') },
        { blockNumber: 1, block: hashedBlock(1, [{ key: 'a' }, { key: 'b' }]), privateDataMap: delivered('b', 'b1') },
        { blockNumber: 2, block: makeBlock(2, []), privateDataMap: {} },
        { blockNumber: 3, block: makeBlock(3, []), privateDataMap: {} },
        { blockNumber: 4, block: hashedBlock(4, [{ key: 'c' }]), privateDataMap: {} },
      ];
      const extractor = new PrivateDataDeliveryExtractor(mockDeliverFn(blocks), writer, layout, MigrationTier.FullHistory);
      const summary = await extractor.extract({ ...btl, ledgerHeight: 5 });
      await writer.close();
      // Block 1's write of a is older than height 5 - blockToLive 2: expired, not missing. Block 4's c is missing.
      expect(readRecords(layout.privateStatePath('mychannel', 'mycc', 'privateData')).map((r) => r.key)).toEqual(['b']);
      expect(summary.valuesMissing).toEqual({ 'mycc:privateData': { writes: 1, dropped: 0, firstBlock: 4, lastBlock: 4 } });
    });

    test('reports nothing for a collection the peer never delivered a value of', async () => {
      const { summary } = await run([
        { blockNumber: 0, block: hashedBlock(0, [{ key: 'a' }, { collection: 'secretData', key: 's' }]), privateDataMap: delivered('a', 'a1') },
      ]);
      expect(summary.valuesMissing).toEqual({});
    });
  });

  function readRecords(relativePath: string): any[] {
    return fs
      .readFileSync(path.join(tmpDir, relativePath), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
});
