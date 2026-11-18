// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  MigrationTier,
  ChannelInfo,
  PublicStateRecord,
  PublicHistoryRecord,
  BlockMetadataRecord,
  PrivateHistoryRecord,
  PrivateHashRecord,
  PrivateStateRecord,
} from '../src/types';
import { StateReconstructionExtractor } from '../src/extraction/strategies/state-reconstruction-extractor';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';
import { checkpointFileName } from '../src/replay/replay-checkpoint-manager';
import type { ReplaySummary } from '../src/replay/replay-orchestrator';
import { ADMIN_CERT_PEM, CLIENT_CERT_PEM } from './helpers/test-certs';
import { blockDataHash, encodeBlock } from './helpers/protobuf-block';

// ── PostgreSQL at the `pg` boundary ──

/*
 * `pg` is what gets mocked here, not `PostgresqlAdapter`.
 *
 * This file used to stub `PostgresqlAdapter.prototype.{initialize,replayBatch,
 * close}`, which meant no adapter code ran in the one test named for replay —
 * and the replay half of "extraction and replay" never constructed an
 * orchestrator at all, it re-read the NDJSON files itself and compared counts.
 * So the seam was untested from both sides: the orchestrator's file list was
 * never checked against what extraction wrote, and no extracted record ever
 * reached the code that turns it into SQL.
 *
 * `pg` is the real boundary — external, slow, not ours — so it is the thing
 * replaced. The SQL text belongs to `test/postgresql-adapter.test.ts`, which
 * drives the adapter directly with hand-built records; asserting it again here
 * would give the same statements two places to be updated and would not add a
 * case. What is asserted here is only what an end-to-end run can see: that
 * every record extraction wrote arrives, and arrives in the right table.
 */
interface PgStatement {
  sql: string;
  /** Present on parameterised statements, absent on DDL and BEGIN/COMMIT. */
  values?: unknown[];
}

const pgStatements: PgStatement[] = [];
let pgPoolsEnded = 0;

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(function (this: any) {
    this.query = async (sql: string) => {
      pgStatements.push({ sql });
      return { rows: [] };
    };
    this.end = async () => {
      pgPoolsEnded++;
    };
    this.connect = async () => ({
      query: async (sql: string, values?: unknown[]) => {
        pgStatements.push({ sql, values });
        return { rows: [] };
      },
      release: () => undefined,
    });
  }),
}));

/** Every bound parameter of every INSERT into `table`, flattened in order. */
function pgValuesFor(table: string): unknown[] {
  return pgStatements
    .filter((s) => s.values !== undefined && s.sql.includes(`INTO ${table}`))
    .flatMap((s) => s.values as unknown[]);
}

/** BEGIN/COMMIT/ROLLBACK in the order they were issued, DDL excluded. */
function pgTransactionMarkers(): string[] {
  return pgStatements
    .map((s) => s.sql.trim())
    .filter((sql) => sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK');
}

/**
 * Every NDJSON record written anywhere under `dir`.
 *
 * Replay builds its own file list from the manifest and the channel directory,
 * so this is the independent count that list has to agree with.
 */
function countNdjsonRecords(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countNdjsonRecords(full);
      continue;
    }
    if (!entry.name.endsWith('.ndjson')) continue;
    total += fs
      .readFileSync(full, 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
  }
  return total;
}

// ── Synthetic block builder ──

const CERT_ORG1 = ADMIN_CERT_PEM;
const CERT_ORG2 = CLIENT_CERT_PEM;

interface SyntheticWrite {
  namespace: string;
  key: string;
  value: string;
  is_delete?: boolean;
}

interface SyntheticPrivateHash {
  namespace: string;
  collection: string;
  key_hash: string;
  value_hash: string;
}

interface SyntheticTx {
  txId: string;
  timestamp: string;
  chaincodeId: string;
  cert: string;
  writes: SyntheticWrite[];
  privateHashes?: SyntheticPrivateHash[];
}

/**
 * Compute SHA-256(ASN.1 DER(BlockHeader)) — matches Fabric's protoutil.BlockHeaderHash()
 * and BlockWalker.computeBlockHeaderHash().
 */
function computeBlockHeaderHash(blockNumber: number, previousHash: string, dataHash: string): string {
  function asn1LengthPrefix(tag: number, length: number): Buffer {
    if (length < 128) return Buffer.from([tag, length]);
    else if (length < 256) return Buffer.from([tag, 0x81, length]);
    else return Buffer.from([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
  }
  function asn1EncodeInteger(value: number): Buffer {
    if (value === 0) return Buffer.from([0x02, 0x01, 0x00]);
    const hex = value.toString(16);
    const paddedHex = hex.length % 2 ? '0' + hex : hex;
    let bytes = Buffer.from(paddedHex, 'hex');
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
    return Buffer.concat([asn1LengthPrefix(0x02, bytes.length), bytes]);
  }
  function asn1EncodeOctetString(data: Buffer): Buffer {
    return Buffer.concat([asn1LengthPrefix(0x04, data.length), data]);
  }

  const numberBuf = asn1EncodeInteger(blockNumber);
  const prevHashBuf = asn1EncodeOctetString(
    previousHash ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0),
  );
  const dataHashBuf = asn1EncodeOctetString(
    dataHash ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0),
  );
  const contentLen = numberBuf.length + prevHashBuf.length + dataHashBuf.length;
  const seqHeader = asn1LengthPrefix(0x30, contentLen);
  const derEncoded = Buffer.concat([seqHeader, numberBuf, prevHashBuf, dataHashBuf]);
  return crypto.createHash('sha256').update(derEncoded).digest('hex');
}

function buildBlock(
  blockNumber: number,
  previousHash: string,
  txs: SyntheticTx[],
): { json: any; dataHash: string; headerHash: string } {
  const txDataArray = txs.map((tx) => {
    const nsRwSets: any[] = [];
    // Group writes by namespace
    const byNs = new Map<string, SyntheticWrite[]>();
    for (const w of tx.writes) {
      if (!byNs.has(w.namespace)) byNs.set(w.namespace, []);
      byNs.get(w.namespace)!.push(w);
    }
    for (const [ns, writes] of byNs) {
      const collHashRwSets: any[] = [];
      // Attach private hashes to matching namespace
      const nsHashes = (tx.privateHashes ?? []).filter((h) => h.namespace === ns);
      for (const h of nsHashes) {
        collHashRwSets.push({
          collection_name: h.collection,
          hashed_rwset: {
            hashed_writes: [{ key_hash: h.key_hash, value_hash: h.value_hash }],
          },
        });
      }

      nsRwSets.push({
        namespace: ns,
        rwset: {
          writes: writes.map((w) => ({
            key: w.key,
            value: w.value,
            is_delete: w.is_delete ?? false,
          })),
        },
        collection_hashed_rwset: collHashRwSets,
      });
    }

    return {
      payload: {
        header: {
          channel_header: { tx_id: tx.txId, timestamp: tx.timestamp },
          signature_header: {
            creator: { mspid: tx.cert === CERT_ORG1 ? 'Org1MSP' : 'Org2MSP', id_bytes: tx.cert },
          },
        },
        data: {
          actions: [
            {
              payload: {
                chaincode_proposal_payload: {
                  input: { chaincode_spec: { chaincode_id: { name: tx.chaincodeId } } },
                },
                action: {
                  proposal_response_payload: {
                    extension: { results: { ns_rwset: nsRwSets } },
                  },
                },
              },
            },
          ],
        },
      },
    };
  });

  // Validation codes: all valid (0)
  const validationCodes = txs.map(() => 0);

  const json: any = {
    header: {
      number: blockNumber.toString(),
      previous_hash: previousHash,
      data_hash: '', // filled below
    },
    data: { data: txDataArray },
    metadata: { metadata: [[], [], validationCodes] },
  };

  // data_hash as Fabric computes it: over the block's encoded transactions
  const dataHash = blockDataHash(json);
  json.header.data_hash = dataHash;

  // Compute ASN.1 header hash (what Fabric uses for the hash chain)
  const headerHash = computeBlockHeaderHash(blockNumber, previousHash, dataHash);

  return { json, dataHash, headerHash };
}

// ── Build a realistic 10-block ledger ──
// Two chaincodes: "assetcc" (asset management) and "paymentcc" (payments)
// Private data collection "confidentialDocs" on assetcc

function buildLedger(): Array<{ json: any; dataHash: string; headerHash: string }> {
  const blocks: Array<{ json: any; dataHash: string; headerHash: string }> = [];

  // Block 0: genesis (empty config block)
  const b0 = buildBlock(0, '', []);
  blocks.push(b0);

  // Block 1: assetcc — create asset1, asset2
  const b1 = buildBlock(1, b0.headerHash, [
    {
      txId: 'tx-001',
      timestamp: '2024-06-01T10:00:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [
        { namespace: 'assetcc', key: 'asset1', value: '{"owner":"alice","color":"blue","size":10}' },
        { namespace: 'assetcc', key: 'asset2', value: '{"owner":"bob","color":"red","size":5}' },
      ],
    },
  ]);
  blocks.push(b1);

  // Block 2: paymentcc — create payment1
  const b2 = buildBlock(2, b1.headerHash, [
    {
      txId: 'tx-002',
      timestamp: '2024-06-01T10:01:00Z',
      chaincodeId: 'paymentcc',
      cert: CERT_ORG2,
      writes: [
        { namespace: 'paymentcc', key: 'pay-001', value: '{"from":"alice","to":"bob","amount":100}' },
      ],
    },
  ]);
  blocks.push(b2);

  // Block 3: assetcc — transfer asset1 to bob, with private data hash
  const b3 = buildBlock(3, b2.headerHash, [
    {
      txId: 'tx-003',
      timestamp: '2024-06-01T10:02:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [
        { namespace: 'assetcc', key: 'asset1', value: '{"owner":"bob","color":"blue","size":10}' },
      ],
      privateHashes: [
        {
          namespace: 'assetcc',
          collection: 'confidentialDocs',
          key_hash: 'a1b2c3',
          value_hash: 'd4e5f6',
        },
      ],
    },
  ]);
  blocks.push(b3);

  // Block 4: paymentcc — create payment2, payment3
  const b4 = buildBlock(4, b3.headerHash, [
    {
      txId: 'tx-004',
      timestamp: '2024-06-01T10:03:00Z',
      chaincodeId: 'paymentcc',
      cert: CERT_ORG2,
      writes: [
        { namespace: 'paymentcc', key: 'pay-002', value: '{"from":"bob","to":"charlie","amount":50}' },
        { namespace: 'paymentcc', key: 'pay-003', value: '{"from":"alice","to":"charlie","amount":25}' },
      ],
    },
  ]);
  blocks.push(b4);

  // Block 5: assetcc — create asset3
  const b5 = buildBlock(5, b4.headerHash, [
    {
      txId: 'tx-005',
      timestamp: '2024-06-01T10:04:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [
        { namespace: 'assetcc', key: 'asset3', value: '{"owner":"charlie","color":"green","size":20}' },
      ],
    },
  ]);
  blocks.push(b5);

  // Block 6: assetcc — delete asset2 (simulating burn/removal)
  const b6 = buildBlock(6, b5.headerHash, [
    {
      txId: 'tx-006',
      timestamp: '2024-06-01T10:05:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [{ namespace: 'assetcc', key: 'asset2', value: '', is_delete: true }],
    },
  ]);
  blocks.push(b6);

  // Block 7: paymentcc — update payment1 (e.g. mark as settled)
  const b7 = buildBlock(7, b6.headerHash, [
    {
      txId: 'tx-007',
      timestamp: '2024-06-01T10:06:00Z',
      chaincodeId: 'paymentcc',
      cert: CERT_ORG2,
      writes: [
        {
          namespace: 'paymentcc',
          key: 'pay-001',
          value: '{"from":"alice","to":"bob","amount":100,"status":"settled"}',
        },
      ],
    },
  ]);
  blocks.push(b7);

  // Block 8: assetcc — update asset1 color
  const b8 = buildBlock(8, b7.headerHash, [
    {
      txId: 'tx-008',
      timestamp: '2024-06-01T10:07:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [
        { namespace: 'assetcc', key: 'asset1', value: '{"owner":"bob","color":"gold","size":10}' },
      ],
      privateHashes: [
        {
          namespace: 'assetcc',
          collection: 'confidentialDocs',
          key_hash: 'g7h8i9',
          value_hash: 'j0k1l2',
        },
      ],
    },
  ]);
  blocks.push(b8);

  // Block 9: multi-chaincode block — both chaincodes in one block
  const b9 = buildBlock(9, b8.headerHash, [
    {
      txId: 'tx-009a',
      timestamp: '2024-06-01T10:08:00Z',
      chaincodeId: 'assetcc',
      cert: CERT_ORG1,
      writes: [
        { namespace: 'assetcc', key: 'asset4', value: '{"owner":"diana","color":"silver","size":15}' },
      ],
    },
    {
      txId: 'tx-009b',
      timestamp: '2024-06-01T10:08:01Z',
      chaincodeId: 'paymentcc',
      cert: CERT_ORG2,
      writes: [
        { namespace: 'paymentcc', key: 'pay-004', value: '{"from":"charlie","to":"diana","amount":75}' },
      ],
    },
  ]);
  blocks.push(b9);

  return blocks;
}

// ── Mock Fabric Network ──

function createMockNetwork(ledger: Array<{ json: any }>): any {
  const mockContract = {
    evaluateTransaction: jest.fn(async (...args: string[]) => {
      const [fcn, , blockNumStr] = args;
      if (fcn === 'GetBlockByNumber') {
        const blockNum = parseInt(blockNumStr, 10);
        if (blockNum < 0 || blockNum >= ledger.length) {
          throw new Error(`Block ${blockNum} not found`);
        }
        return encodeBlock(ledger[blockNum].json);
      }
      if (fcn === 'GetChainInfo') {
        return Buffer.from(
          JSON.stringify({ height: { low: ledger.length, high: 0, unsigned: true } }),
          'utf-8',
        );
      }
      throw new Error(`Unexpected qscc function: ${fcn}`);
    }),
  };

  return {
    getContract: jest.fn((name: string) => {
      if (name === 'qscc') return mockContract;
      throw new Error(`Unexpected contract: ${name}`);
    }),
  };
}

// ── Tests ──

describe('End-to-end extraction and replay', () => {
  let tmpDir: string;
  let ledger: ReturnType<typeof buildLedger>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-test-'));
    ledger = buildLedger();
    pgStatements.length = 0;
    pgPoolsEnded = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const CHANNEL: ChannelInfo = {
    channelId: 'tradechannel',
    ledgerHeight: 10, // blocks 0-9
    chaincodes: [
      {
        name: 'assetcc',
        version: '1.0',
        sequence: 1,
        collections: [
          {
            name: 'confidentialDocs',
            policy: "OR('Org1MSP.member')",
            requiredPeerCount: 1,
            maxPeerCount: 3,
            blockToLive: 0,
            memberOnlyRead: true,
            memberOnlyWrite: true,
          },
        ],
      },
      {
        name: 'paymentcc',
        version: '2.1',
        sequence: 3,
        collections: [],
      },
    ],
  };

  // ── Phase 1: Extraction ──

  test('extracts correct public state from block reconstruction (Tier 1)', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.CurrentState,
      { stateBackend: 'memory' },
    );

    await extractor.extract(CHANNEL);
    await writer.close();

    // Read back the public state NDJSON
    const reader = new NdjsonReader();
    const statePath = path.join(outputDir, layout.publicStatePath(CHANNEL.channelId));
    const stateRecords = await reader.readAll(statePath);
    const publicState = stateRecords.filter(
      (r): r is PublicStateRecord => r._type === 'public_state',
    );

    // Expected final state after 10 blocks:
    // assetcc:
    //   asset1 = {"owner":"bob","color":"gold","size":10}     (created b1, updated b3, updated b8)
    //   asset2 = DELETED (created b1, deleted b6)
    //   asset3 = {"owner":"charlie","color":"green","size":20} (created b5)
    //   asset4 = {"owner":"diana","color":"silver","size":15}  (created b9)
    // paymentcc:
    //   pay-001 = {"from":"alice","to":"bob","amount":100,"status":"settled"} (created b2, updated b7)
    //   pay-002 = {"from":"bob","to":"charlie","amount":50}    (created b4)
    //   pay-003 = {"from":"alice","to":"charlie","amount":25}  (created b4)
    //   pay-004 = {"from":"charlie","to":"diana","amount":75}  (created b9)

    // asset2 was deleted, so 3 assetcc keys + 4 paymentcc keys = 7 total
    expect(publicState).toHaveLength(7);

    // Group by chaincode
    const assetState = publicState.filter((r) => r.chaincode === 'assetcc');
    const paymentState = publicState.filter((r) => r.chaincode === 'paymentcc');

    expect(assetState).toHaveLength(3);
    expect(paymentState).toHaveLength(4);

    // Verify final values reflect the latest write, not earlier versions
    const asset1 = assetState.find((r) => r.key === 'asset1');
    expect(asset1).toBeDefined();
    expect(JSON.parse(asset1!.value)).toEqual({ owner: 'bob', color: 'gold', size: 10 });

    // asset2 should NOT be present (deleted)
    expect(assetState.find((r) => r.key === 'asset2')).toBeUndefined();

    // asset3 present
    const asset3 = assetState.find((r) => r.key === 'asset3');
    expect(JSON.parse(asset3!.value)).toEqual({ owner: 'charlie', color: 'green', size: 20 });

    // asset4 present
    const asset4 = assetState.find((r) => r.key === 'asset4');
    expect(JSON.parse(asset4!.value)).toEqual({ owner: 'diana', color: 'silver', size: 15 });

    // pay-001 reflects the settled version
    const pay001 = paymentState.find((r) => r.key === 'pay-001');
    expect(JSON.parse(pay001!.value)).toEqual({
      from: 'alice',
      to: 'bob',
      amount: 100,
      status: 'settled',
    });

    // pay-004 from multi-tx block
    const pay004 = paymentState.find((r) => r.key === 'pay-004');
    expect(JSON.parse(pay004!.value)).toEqual({ from: 'charlie', to: 'diana', amount: 75 });

    // All records are tagged with channel
    expect(publicState.every((r) => r.channel === 'tradechannel')).toBe(true);
  });

  test('a re-run after an interrupted state flush rewrites every block-derived output', async () => {
    const extractTo = async (outputDir: string): Promise<FileLayoutManager> => {
      const writer = new NdjsonWriter(outputDir);
      const layout = new FileLayoutManager(outputDir);
      const extractor = new StateReconstructionExtractor(
        createMockNetwork(ledger),
        writer,
        layout,
        new CheckpointManager(path.join(outputDir, layout.checkpointDir(CHANNEL.channelId))),
        MigrationTier.FullHistory,
        { stateBackend: 'memory' },
      );
      await extractor.extract(CHANNEL);
      await writer.close();
      return layout;
    };

    const refDir = path.join(tmpDir, 'uninterrupted');
    const layout = await extractTo(refDir);
    const files = [
      layout.publicStatePath(CHANNEL.channelId),
      layout.publicHistoryPath(CHANNEL.channelId),
      layout.blockMetadataPath(CHANNEL.channelId),
      layout.privateHashesPath(CHANNEL.channelId, 'assetcc', 'confidentialDocs'),
    ];

    // The block walk reached the tip and persisted its checkpoint, then the
    // process died after writing only a prefix of current state. History,
    // metadata and private hashes may also hold an abandoned prefix.
    const crashedDir = path.join(tmpDir, 'crashed');
    for (const f of files) {
      const lines = fs.readFileSync(path.join(refDir, f), 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(1);
      fs.mkdirSync(path.dirname(path.join(crashedDir, f)), { recursive: true });
      fs.writeFileSync(path.join(crashedDir, f), lines.slice(0, Math.ceil(lines.length / 2)).join('\n') + '\n');
    }
    const checkpointDir = path.join(crashedDir, layout.checkpointDir(CHANNEL.channelId));
    new CheckpointManager(checkpointDir).updateBlock(
      CHANNEL.channelId,
      'block-walk',
      CHANNEL.ledgerHeight - 1,
    );

    await extractTo(crashedDir);

    for (const f of files) {
      expect(fs.readFileSync(path.join(crashedDir, f), 'utf-8')).toBe(fs.readFileSync(path.join(refDir, f), 'utf-8'));
    }
  });

  test('extracted history and metadata maintain block/tx ordering', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output-ordering');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.FullHistory,
      { stateBackend: 'memory' },
    );

    await extractor.extract(CHANNEL);
    await writer.close();

    const reader = new NdjsonReader();

    // Verify history records are in ascending blockNumber order,
    // with non-decreasing txIndex within each block
    const historyPath = path.join(outputDir, layout.publicHistoryPath(CHANNEL.channelId));
    const historyRecords = await reader.readAll(historyPath);

    let prevBlock = -1;
    let prevTxIndex = -1;
    for (const record of historyRecords) {
      const r = record as any;
      expect(typeof r.blockNumber).toBe('number');
      expect(typeof r.txIndex).toBe('number');
      expect(r.blockNumber).toBeGreaterThanOrEqual(prevBlock);
      if (r.blockNumber === prevBlock) {
        expect(r.txIndex).toBeGreaterThanOrEqual(prevTxIndex);
      }
      prevBlock = r.blockNumber;
      prevTxIndex = r.txIndex;
    }

    // Verify metadata records maintain the same ordering
    const metadataPath = path.join(outputDir, layout.blockMetadataPath(CHANNEL.channelId));
    const metadataRecords = await reader.readAll(metadataPath);

    prevBlock = -1;
    prevTxIndex = -1;
    for (const record of metadataRecords) {
      const r = record as any;
      expect(typeof r.blockNumber).toBe('number');
      expect(typeof r.txIndex).toBe('number');
      expect(r.blockNumber).toBeGreaterThanOrEqual(prevBlock);
      if (r.blockNumber === prevBlock) {
        expect(r.txIndex).toBeGreaterThanOrEqual(prevTxIndex);
      }
      prevBlock = r.blockNumber;
      prevTxIndex = r.txIndex;
    }

    // Verify multi-tx block (block 9) has ascending txIndex
    const block9Meta = metadataRecords.filter((r) => (r as any).blockNumber === 9);
    expect(block9Meta).toHaveLength(2);
    expect((block9Meta[0] as any).txIndex).toBe(0);
    expect((block9Meta[1] as any).txIndex).toBe(1);
  });

  test('extracts history and metadata at Tier 3', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output-t3');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.FullHistory,
      { stateBackend: 'memory' },
    );

    const walker = await extractor.extract(CHANNEL);
    await writer.close();

    const reader = new NdjsonReader();

    // Verify public state is still correct
    const statePath = path.join(outputDir, layout.publicStatePath(CHANNEL.channelId));
    const stateRecords = await reader.readAll(statePath);
    expect(stateRecords.filter((r) => r._type === 'public_state')).toHaveLength(7);

    // Verify history records exist (every write across all blocks)
    const historyPath = path.join(outputDir, layout.publicHistoryPath(CHANNEL.channelId));
    const historyRecords = await reader.readAll(historyPath);

    // Count expected writes:
    // b0: 0, b1: 2, b2: 1, b3: 1, b4: 2, b5: 1, b6: 1, b7: 1, b8: 1, b9: 2 = 12
    expect(historyRecords).toHaveLength(12);

    // Verify a history record has full audit fields
    const asset1History = historyRecords.filter(
      (r) => r._type === 'public_history' && (r as any).key === 'asset1',
    );
    // asset1 was written in blocks 1, 3, 8 = 3 history entries
    expect(asset1History).toHaveLength(3);
    expect((asset1History[0] as any).txId).toBe('tx-001');
    expect((asset1History[0] as any).creator.mspId).toBe('Org1MSP');

    // Verify block metadata records
    const metadataPath = path.join(outputDir, layout.blockMetadataPath(CHANNEL.channelId));
    const metadataRecords = await reader.readAll(metadataPath);
    // 10 transactions total across blocks (one per tx, not per block)
    expect(metadataRecords).toHaveLength(10);

    // Verify private hash records were extracted
    const hashesPath = path.join(
      outputDir,
      layout.privateHashesPath(CHANNEL.channelId, 'assetcc', 'confidentialDocs'),
    );
    const hashRecords = await reader.readAll(hashesPath);
    // Blocks 3 and 8 each had one private hash
    expect(hashRecords).toHaveLength(2);
    expect(hashRecords[0]._type).toBe('private_hash');

    // Identities are written by HybridExtractor (which merges across channels),
    // not by StateReconstructionExtractor. Verify the walker's identity registry instead.
    const registry = walker.getIdentityRegistry();
    expect(registry.size).toBe(2);
    const org1 = [...registry.values()].find((r) => r.mspId === 'Org1MSP');
    const org2 = [...registry.values()].find((r) => r.mspId === 'Org2MSP');
    expect(org1).toBeDefined();
    expect(org2).toBeDefined();
    // org1 submitted txs: 001, 003, 005, 006, 008, 009a = 6
    expect(org1!.txCount).toBe(6);
    // org2 submitted txs: 002, 004, 007, 009b = 4
    expect(org2!.txCount).toBe(4);
  });

  test('hash chain integrity verification passes for valid ledger', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output-integrity');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    // Use BlockWalker directly to check integrity
    const { BlockWalker } = await import('../src/extraction/strategies/block-walker');
    const walker = new BlockWalker(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.CurrentState,
      { reconstructState: false, verifyHashChain: true },
    );

    const report = await walker.walk(CHANNEL);
    await writer.close();

    expect(report.hashChainValid).toBe(true);
    expect(report.blocksVerified).toBe(10); // blocks 0-9
    expect(report.brokenAtBlock).toBeUndefined();
  });

  test('hash chain integrity verification detects tampered block', async () => {
    // Tamper with block 5's previousHash — use a valid-looking hex string
    const tamperedLedger = buildLedger();
    tamperedLedger[5].json.header.previous_hash = 'aa'.repeat(32);

    const network = createMockNetwork(tamperedLedger);
    const outputDir = path.join(tmpDir, 'output-tampered');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const { BlockWalker } = await import('../src/extraction/strategies/block-walker');
    const walker = new BlockWalker(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.CurrentState,
      { reconstructState: false, verifyHashChain: true },
    );

    await expect(walker.walk(CHANNEL)).rejects.toThrow(/Hash chain integrity failure at block 5/);
    await writer.close();
  });

  // ── Phase 2: Replay ──

  /** Extract the synthetic ledger at Tier 3, plus the manifest replay reads. */
  async function extractForReplay(dirName: string): Promise<string> {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, dirName);
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      new CheckpointManager(checkpointDir),
      MigrationTier.FullHistory,
      { stateBackend: 'memory' },
    );

    const walker = await extractor.extract(CHANNEL);

    /*
     * `identities.ndjson` is written by `HybridExtractor`, which merges the
     * registry across channels, not by the extractor itself — so this is the
     * same registry, the same writer and the same layout path the real pipeline
     * uses. Without it replay's file list would be checked one file class short,
     * and `identities` is the first entry in that list.
     */
    await writer.writeBatch(layout.identitiesPath, [...walker.getIdentityRegistry().values()]);
    await writer.close();

    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST12345',
        memberId: 'm-TEST12345',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: new Date().toISOString(),
        channels: [CHANNEL],
      }),
      'utf-8',
    );

    return outputDir;
  }

  /** Replay an extraction directory to PostgreSQL, with `pg` mocked beneath. */
  async function replayToPostgres(
    inputDir: string,
    batchSize?: number,
  ): Promise<ReplaySummary> {
    const { ReplayOrchestrator } = await import('../src/replay/replay-orchestrator');
    return new ReplayOrchestrator({
      adapter: 'postgresql',
      inputDir,
      postgresql: { connectionString: 'postgresql://localhost/test' },
      ...(batchSize === undefined ? {} : { batchSize }),
    }).run();
  }

  test('every extracted record reaches PostgreSQL through the real adapter', async () => {
    const outputDir = await extractForReplay('output-replay');
    const onDisk = countNdjsonRecords(outputDir);

    const summary = await replayToPostgres(outputDir);

    /*
     * Compared against every NDJSON record on disk rather than a hardcoded
     * number, because the thing that can silently break here is coverage:
     * replay builds its own file list, and a file class it stops listing —
     * a new private file suffix, a renamed layout path — is dropped without
     * an error and the run still exits 0.
     */
    expect(summary.totalReplayed).toBe(onDisk);
    expect(summary.totalFailed).toBe(0);

    // 7 live keys + 12 writes + 10 transactions + 2 private hashes + 2 identities.
    expect(onDisk).toBe(33);

    // Each batch is one transaction, and the pool is closed on the way out.
    expect(pgTransactionMarkers()).not.toContain('ROLLBACK');
    expect(pgTransactionMarkers()).toContain('COMMIT');
    expect(pgPoolsEnded).toBe(1);
  });

  test('replay routes each record type to its own table', async () => {
    const outputDir = await extractForReplay('output-replay-tables');

    await replayToPostgres(outputDir);

    const state = pgValuesFor('fabric_state');
    const history = pgValuesFor('fabric_history');
    const metadata = pgValuesFor('fabric_block_metadata');
    const hashes = pgValuesFor('fabric_private_hashes');

    // Both namespaces' live keys reach current state.
    for (const key of ['asset1', 'asset3', 'asset4', 'pay-001', 'pay-004']) {
      expect(state).toContain(key);
    }

    // asset2 was written in block 1 and deleted in block 6. Current state must
    // not carry it, and history must — the tombstone is the only record that
    // the key ever existed, and losing it silently turns a delete into a key
    // that was never there.
    expect(state).not.toContain('asset2');
    expect(history).toContain('asset2');

    // Every transaction is accounted for in block metadata, including both
    // transactions of the multi-tx block.
    expect(metadata).toContain('tx-001');
    expect(metadata).toContain('tx-009a');
    expect(metadata).toContain('tx-009b');

    // Private hashes go to their own table. A hash reaching fabric_state would
    // present an unreadable digest as though it were the value.
    expect(hashes).toContain('confidentialDocs');
    expect(state).not.toContain('confidentialDocs');

    // Both submitting orgs reach the identity table. This is the file replay
    // reads first, and the only one whose absence costs no error anywhere.
    const identities = pgValuesFor('fabric_identities');
    expect(identities).toContain('Org1MSP');
    expect(identities).toContain('Org2MSP');
  });

  test('no record is lost at a batch boundary', async () => {
    const outputDir = await extractForReplay('output-replay-batched');
    const onDisk = countNdjsonRecords(outputDir);

    // Small enough that every file splits and every file's last batch is short.
    const summary = await replayToPostgres(outputDir, 4);

    expect(summary.totalReplayed).toBe(onDisk);

    const markers = pgTransactionMarkers();
    const begins = markers.filter((m) => m === 'BEGIN').length;
    expect(begins).toBeGreaterThan(1);
    expect(markers.filter((m) => m === 'COMMIT').length).toBe(begins);
    expect(markers).not.toContain('ROLLBACK');
  });

  test('a completed replay clears its checkpoint, so a re-run is not a no-op', async () => {
    const outputDir = await extractForReplay('output-replay-rerun');
    const onDisk = countNdjsonRecords(outputDir);

    const first = await replayToPostgres(outputDir, 4);
    expect(first.totalReplayed).toBe(onDisk);

    /*
     * Left behind, the checkpoint names the last file with every record
     * counted, so a second run skips every earlier file and resumes the last
     * one past its end: replay writes nothing, reports nothing and exits 0.
     * PostgreSQL replay is idempotent by upsert, so re-running is the
     * documented way to finish an interrupted migration — which only works if
     * a clean run leaves nothing behind.
     */
    expect(
      fs.existsSync(path.join(outputDir, checkpointFileName('postgresql'))),
    ).toBe(false);

    const second = await replayToPostgres(outputDir, 4);
    expect(second.totalReplayed).toBe(onDisk);
  });

  test('multi-chaincode namespace isolation is preserved end-to-end', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output-ns');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.CurrentState,
      { stateBackend: 'memory' },
    );

    await extractor.extract(CHANNEL);
    await writer.close();

    const reader = new NdjsonReader();
    const statePath = path.join(outputDir, layout.publicStatePath(CHANNEL.channelId));
    const stateRecords = (await reader.readAll(statePath)) as PublicStateRecord[];

    // Every record must have a chaincode field matching its originating namespace
    const chaincodes = new Set(stateRecords.map((r) => r.chaincode));
    expect(chaincodes).toEqual(new Set(['assetcc', 'paymentcc']));

    // No assetcc key should appear under paymentcc or vice versa
    const assetKeys = new Set(
      stateRecords.filter((r) => r.chaincode === 'assetcc').map((r) => r.key),
    );
    const paymentKeys = new Set(
      stateRecords.filter((r) => r.chaincode === 'paymentcc').map((r) => r.key),
    );

    // These must be disjoint sets
    for (const k of assetKeys) {
      expect(paymentKeys.has(k)).toBe(false);
    }
    for (const k of paymentKeys) {
      expect(assetKeys.has(k)).toBe(false);
    }
  });

  // ── Phase 3: Ordering validation ──

  test('validation runner passes ordering check on correctly ordered extraction', async () => {
    const network = createMockNetwork(ledger);
    const outputDir = path.join(tmpDir, 'output-val-order');
    const writer = new NdjsonWriter(outputDir);
    const layout = new FileLayoutManager(outputDir);
    const checkpointDir = path.join(outputDir, layout.checkpointDir(CHANNEL.channelId));
    const checkpointManager = new CheckpointManager(checkpointDir);

    const extractor = new StateReconstructionExtractor(
      network,
      writer,
      layout,
      checkpointManager,
      MigrationTier.FullHistory,
      { stateBackend: 'memory' },
    );

    await extractor.extract(CHANNEL);
    await writer.close();

    // Write manifest for validation
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: new Date().toISOString(),
        channels: [CHANNEL],
      }),
      'utf-8',
    );

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir);

    const orderingResults = results.filter((r) => r.check.startsWith('Record ordering'));
    expect(orderingResults.length).toBeGreaterThanOrEqual(2);
    for (const r of orderingResults) {
      expect(r.status).toBe('pass');
    }
  });

  test('validation runner detects out-of-order blockNumbers in history', async () => {
    const outputDir = path.join(tmpDir, 'output-bad-order');
    const layout = new FileLayoutManager(outputDir);

    // Write manifest
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 5, chaincodes: [] }],
      }),
      'utf-8',
    );

    // Write out-of-order history records
    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    const creator = { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' };
    const records: PublicHistoryRecord[] = [
      { _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1', value: 'v1', txId: 'tx1', txIndex: 0, blockNumber: 1, timestamp: '', isDelete: false, creator },
      { _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k2', value: 'v2', txId: 'tx3', txIndex: 0, blockNumber: 3, timestamp: '', isDelete: false, creator },
      { _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k3', value: 'v3', txId: 'tx2', txIndex: 0, blockNumber: 2, timestamp: '', isDelete: false, creator },
    ];
    const historyPath = path.join(outputDir, layout.publicHistoryPath('ch1'));
    fs.writeFileSync(historyPath, records.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');

    // Write empty state/metadata so validation doesn't skip
    fs.writeFileSync(path.join(outputDir, layout.publicStatePath('ch1')), '', 'utf-8');

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir, ['ch1']);

    const historyOrdering = results.find((r) => r.check.includes('public-history') && r.check.includes('ordering'));
    expect(historyOrdering).toBeDefined();
    expect(historyOrdering!.status).toBe('fail');
    expect(historyOrdering!.message).toContain('Block ordering violation');
  });

  test('replay orchestrator throws on out-of-order records', async () => {
    const outputDir = path.join(tmpDir, 'output-replay-order');
    const layout = new FileLayoutManager(outputDir);

    // Write manifest
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 5, chaincodes: [] }],
      }),
      'utf-8',
    );

    // Write out-of-order metadata records (block 3 before block 2)
    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    const creator = { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' };
    const metaRecords: BlockMetadataRecord[] = [
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 1, txId: 'tx1', txIndex: 0, timestamp: '', chaincodeId: 'mycc', keysWritten: ['k1'], keysDeleted: [], creator },
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 3, txId: 'tx3', txIndex: 0, timestamp: '', chaincodeId: 'mycc', keysWritten: ['k3'], keysDeleted: [], creator },
      { _type: 'block_metadata', channel: 'ch1', blockNumber: 2, txId: 'tx2', txIndex: 0, timestamp: '', chaincodeId: 'mycc', keysWritten: ['k2'], keysDeleted: [], creator },
    ];
    const metadataPath = path.join(outputDir, layout.blockMetadataPath('ch1'));
    fs.writeFileSync(metadataPath, metaRecords.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');

    // Write empty files for other expected paths
    fs.writeFileSync(path.join(outputDir, layout.publicStatePath('ch1')), '', 'utf-8');
    fs.writeFileSync(path.join(outputDir, layout.publicHistoryPath('ch1')), '', 'utf-8');

    await expect(replayToPostgres(outputDir)).rejects.toThrow(
      /Record ordering violation/,
    );

    // Nothing reached the destination: the check runs as records are read, so
    // the violating file is refused before its first batch is submitted.
    expect(pgValuesFor('fabric_block_metadata')).toEqual([]);

    // And the pool was closed anyway — the `finally` around the file loop is
    // what keeps a refused run from leaking a connection pool.
    expect(pgPoolsEnded).toBe(1);
  });

  // ── Phase 4: Private data validation checks ──

  test('validation passes private history ordering on correctly ordered data', async () => {
    const outputDir = path.join(tmpDir, 'output-pvt-order-ok');
    const layout = new FileLayoutManager(outputDir);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST', memberId: 'm-TEST', region: 'us-east-1',
        stateDb: 'CouchDB', extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 5, chaincodes: [] }],
      }),
      'utf-8',
    );

    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    const records: PrivateHistoryRecord[] = [
      { _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1', value: 'v1', txId: 'tx1', blockNumber: 2, txIndex: 0, timestamp: '', isDelete: false },
      { _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k2', value: 'v2', txId: 'tx2', blockNumber: 3, txIndex: 0, timestamp: '', isDelete: false },
    ];
    fs.writeFileSync(
      path.join(outputDir, layout.privateHistoryPath('ch1', 'mycc', 'col1')),
      records.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir, ['ch1']);

    const pvtOrdering = results.find(
      (r) => r.check.includes('private-mycc-col1-history') && r.check.includes('ordering'),
    );
    expect(pvtOrdering).toBeDefined();
    expect(pvtOrdering!.status).toBe('pass');
  });

  test('validation fails on out-of-order private history blockNumbers', async () => {
    const outputDir = path.join(tmpDir, 'output-pvt-order-bad');
    const layout = new FileLayoutManager(outputDir);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST', memberId: 'm-TEST', region: 'us-east-1',
        stateDb: 'CouchDB', extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 5, chaincodes: [] }],
      }),
      'utf-8',
    );

    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    const records: PrivateHistoryRecord[] = [
      { _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1', value: 'v1', txId: 'tx1', blockNumber: 3, txIndex: 0, timestamp: '', isDelete: false },
      { _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k2', value: 'v2', txId: 'tx2', blockNumber: 2, txIndex: 0, timestamp: '', isDelete: false },
    ];
    fs.writeFileSync(
      path.join(outputDir, layout.privateHistoryPath('ch1', 'mycc', 'col1')),
      records.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir, ['ch1']);

    const pvtOrdering = results.find(
      (r) => r.check.includes('private-mycc-col1-history') && r.check.includes('ordering'),
    );
    expect(pvtOrdering).toBeDefined();
    expect(pvtOrdering!.status).toBe('fail');
    expect(pvtOrdering!.message).toContain('Block ordering violation');
  });

  test('validation warns on duplicate private state keys', async () => {
    const outputDir = path.join(tmpDir, 'output-pvt-dups');
    const layout = new FileLayoutManager(outputDir);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST', memberId: 'm-TEST', region: 'us-east-1',
        stateDb: 'CouchDB', extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 5, chaincodes: [] }],
      }),
      'utf-8',
    );

    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    const records: PrivateStateRecord[] = [
      { _type: 'private_state', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1', value: 'v1' },
      { _type: 'private_state', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1', value: 'v2' },
      { _type: 'private_state', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k2', value: 'v3' },
    ];
    fs.writeFileSync(
      path.join(outputDir, layout.privateStatePath('ch1', 'mycc', 'col1')),
      records.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir, ['ch1']);

    const dupResult = results.find(
      (r) => r.check.includes('Duplicates') && r.check.includes('private-mycc-col1-state'),
    );
    expect(dupResult).toBeDefined();
    expect(dupResult!.status).toBe('warn');
    expect(dupResult!.message).toContain('1 duplicate');
  });

  test('validation fails when hash-file blocks missing from private history', async () => {
    const outputDir = path.join(tmpDir, 'output-pvt-hist-gap');
    const layout = new FileLayoutManager(outputDir);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST', memberId: 'm-TEST', region: 'us-east-1',
        stateDb: 'CouchDB', extractedAt: new Date().toISOString(),
        channels: [{ channelId: 'ch1', ledgerHeight: 10, chaincodes: [] }],
      }),
      'utf-8',
    );

    const channelDir = path.join(outputDir, layout.channelDir('ch1'));
    fs.mkdirSync(channelDir, { recursive: true });

    // Hashes reference blocks 2, 3, 5
    const hashes: PrivateHashRecord[] = [
      { _type: 'private_hash', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'h1', hash: 'abc', blockNumber: 2, txId: 'tx1', txIndex: 0 },
      { _type: 'private_hash', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'h2', hash: 'def', blockNumber: 3, txId: 'tx2', txIndex: 0 },
      { _type: 'private_hash', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'h3', hash: 'ghi', blockNumber: 5, txId: 'tx3', txIndex: 0 },
    ];
    fs.writeFileSync(
      path.join(outputDir, layout.privateHashesPath('ch1', 'mycc', 'col1')),
      hashes.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );

    // History only covers block 2 — missing blocks 3 and 5
    const history: PrivateHistoryRecord[] = [
      { _type: 'private_history', channel: 'ch1', chaincode: 'mycc', collection: 'col1', key: 'k1', value: 'v1', txId: 'tx1', blockNumber: 2, txIndex: 0, timestamp: '', isDelete: false },
    ];
    fs.writeFileSync(
      path.join(outputDir, layout.privateHistoryPath('ch1', 'mycc', 'col1')),
      history.map((r) => JSON.stringify(r)).join('\n'),
      'utf-8',
    );

    const { runValidation } = await import('../src/validation/validation-runner');
    const results = await runValidation(outputDir, ['ch1']);

    const completeness = results.find(
      (r) => r.check.includes('Private history completeness') && r.check.includes('col1'),
    );
    expect(completeness).toBeDefined();
    expect(completeness!.status).toBe('fail');
    expect(completeness!.message).toContain('blocks in hashes file missing');
  });
});
