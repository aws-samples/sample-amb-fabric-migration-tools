import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BlockWalker } from '../src/extraction/strategies/block-walker';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { NetworkAdapter, ContractAdapter } from '../src/connection/network-adapter';
import { MigrationTier, ChannelInfo } from '../src/types';
import { ADMIN_CERT_PEM } from './helpers/test-certs';
import { encodeBlock, sealBlock } from './helpers/protobuf-block';

// ─── ASN.1 DER helpers (matching block-walker's private implementation) ───

function asn1LengthPrefix(tag: number, length: number): Buffer {
  if (length < 128) return Buffer.from([tag, length]);
  if (length < 256) return Buffer.from([tag, 0x81, length]);
  return Buffer.from([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
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

function computeBlockHeaderHash(blockNumber: number, previousHash: string, dataHash: string): string {
  const numberBuf = asn1EncodeInteger(blockNumber);
  const prevHashBuf = asn1EncodeOctetString(previousHash ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0));
  const dataHashBuf = asn1EncodeOctetString(dataHash ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0));
  const contentLen = numberBuf.length + prevHashBuf.length + dataHashBuf.length;
  const seqHeader = asn1LengthPrefix(0x30, contentLen);
  const derEncoded = Buffer.concat([seqHeader, numberBuf, prevHashBuf, dataHashBuf]);
  return crypto.createHash('sha256').update(derEncoded).digest('hex');
}

// ─── Mock helpers ───

function makeBlock(blockNumber: number, previousHash: string, writes: Array<{ namespace: string; key: string; value: string; isDelete?: boolean }> = []) {
  const block = {
    header: {
      number: String(blockNumber),
      previous_hash: previousHash,
      data_hash: '',
    },
    data: {
      data: writes.length > 0 ? [{
        payload: {
          header: {
            channel_header: {
              tx_id: `tx-${blockNumber}`,
              timestamp: `2024-01-01T00:00:0${blockNumber}Z`,
            },
            signature_header: {
              creator: {
                mspid: 'Org1MSP',
                id_bytes: ADMIN_CERT_PEM,
              },
            },
          },
          data: {
            actions: [{
              payload: {
                chaincode_proposal_payload: {
                  input: { chaincode_spec: { chaincode_id: { name: writes[0].namespace } } },
                },
                action: {
                  proposal_response_payload: {
                    extension: {
                      results: {
                        ns_rwset: [{
                          namespace: writes[0].namespace,
                          rwset: {
                            writes: writes.map(w => ({
                              key: w.key,
                              value: w.value,
                              is_delete: w.isDelete ?? false,
                            })),
                          },
                          collection_hashed_rwset: [],
                        }],
                      },
                    },
                  },
                },
              },
            }],
          },
        },
      }] : [],
    },
    metadata: { metadata: [[], [], writes.length > 0 ? [0] : []] },
  };
  return sealBlock(block);
}

function buildLedger(blockCount: number, writes?: Array<Array<{ namespace: string; key: string; value: string; isDelete?: boolean }>>) {
  const blocks: any[] = [];
  let prevHash = '';

  for (let i = 0; i < blockCount; i++) {
    const block = makeBlock(i, prevHash, writes?.[i] ?? (i > 0 ? [{ namespace: 'mycc', key: `k${i}`, value: `v${i}` }] : []));
    blocks.push(block);
    prevHash = computeBlockHeaderHash(i, block.header.previous_hash, block.header.data_hash);
  }
  return blocks;
}

interface TestHarness {
  walker: BlockWalker;
  writer: NdjsonWriter;
  writtenRecords: Map<string, any[]>;
  checkpointManager: CheckpointManager;
  /** Checkpoint directory, for reading what a later run would find. */
  checkpointDir: string;
  cleanup: () => Promise<void>;
}

function createTestHarness(
  blocks: any[],
  tier: MigrationTier = MigrationTier.FullHistory,
  options: any = {},
): TestHarness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));
  const outputDir = path.join(tmpDir, 'output');
  const checkpointDir = path.join(tmpDir, 'checkpoints');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(checkpointDir, { recursive: true });

  const writtenRecords = new Map<string, any[]>();
  const writer = new NdjsonWriter(outputDir);
  // Spy on writeBatch and write to capture records
  jest.spyOn(writer, 'writeBatch').mockImplementation(async (filePath, records) => {
    const existing = writtenRecords.get(filePath) ?? [];
    existing.push(...records);
    writtenRecords.set(filePath, existing);
  });
  jest.spyOn(writer, 'write').mockImplementation(async (filePath, record) => {
    const existing = writtenRecords.get(filePath) ?? [];
    existing.push(record);
    writtenRecords.set(filePath, existing);
  });
  jest.spyOn(writer, 'syncAll').mockImplementation(() => {});

  const layout = new FileLayoutManager(outputDir);
  const checkpointManager = new CheckpointManager(checkpointDir);

  const mockContract: ContractAdapter = {
    evaluateTransaction: jest.fn(async (_name: string, _channel: string, blockNum: string) => {
      const block = blocks[parseInt(blockNum, 10)];
      if (!block) throw new Error(`Block ${blockNum} not found`);
      return encodeBlock(block);
    }),
    submitTransaction: jest.fn(),
  };

  const mockNetwork: NetworkAdapter = {
    getContract: jest.fn(() => mockContract),
  };

  const walker = new BlockWalker(
    mockNetwork,
    writer,
    layout,
    checkpointManager,
    tier,
    { prefetchBuffer: 0, durabilityInterval: 0, ...options },
  );

  return {
    walker,
    writer,
    writtenRecords,
    checkpointManager,
    checkpointDir,
    cleanup: async () => {
      await walker.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ─── Tests ───

describe('BlockWalker', () => {
  describe('hash chain verification', () => {
    it('verifies a valid hash chain', async () => {
      const blocks = buildLedger(5);
      const harness = createTestHarness(blocks);
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 5 };
        const report = await harness.walker.walk(channel);
        expect(report.hashChainValid).toBe(true);
        expect(report.blocksVerified).toBe(5);
        expect(report.brokenAtBlock).toBeUndefined();
      } finally {
        await harness.cleanup();
      }
    });

    it('detects a block whose header does not link to the one before', async () => {
      const blocks = buildLedger(5);
      // Block 4's previousHash no longer matches block 3's header hash
      blocks[4].header.previous_hash = 'aa'.repeat(32);
      const harness = createTestHarness(blocks);
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 5 };
        await expect(harness.walker.walk(channel)).rejects.toThrow(/Hash chain integrity failure at block 4/);
      } finally {
        await harness.cleanup();
      }
    });

    it('refuses a block whose transactions do not match its header', async () => {
      const blocks = buildLedger(5);
      // A write changed after the block was sealed: the header and the chain are
      // intact, only data_hash says the contents are not the committed ones.
      blocks[3].data.data[0].payload.data.actions[0].payload.action.proposal_response_payload
        .extension.results.ns_rwset[0].rwset.writes[0].value = 'forged';
      const harness = createTestHarness(blocks, MigrationTier.FullHistory, {
        continueOnHashChainBreak: true,
      });
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 5 };
        await expect(harness.walker.walk(channel)).rejects.toThrow(
          /Block 3: its 1 transaction\(s\) hash to [0-9a-f]{64}, but its header records data_hash/,
        );
        // Nothing from the forged block reached the output
        const history = harness.writtenRecords.get('channel-ch1/public-history.ndjson') ?? [];
        expect(history.map((r) => r.blockNumber)).toEqual([1, 2]);
      } finally {
        await harness.cleanup();
      }
    });

    it('continues on hash chain break with continueOnHashChainBreak', async () => {
      const blocks = buildLedger(5);
      blocks[4].header.previous_hash = 'aa'.repeat(32);
      const harness = createTestHarness(blocks, MigrationTier.FullHistory, {
        continueOnHashChainBreak: true,
      });
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 5 };
        const report = await harness.walker.walk(channel);
        expect(report.hashChainValid).toBe(false);
        expect(report.brokenAtBlock).toBe(4);
        expect(report.blocksVerified).toBe(5);
      } finally {
        await harness.cleanup();
      }
    });

    it('skips verification when disabled', async () => {
      const blocks = buildLedger(3);
      blocks[2].header.previous_hash = 'aa'.repeat(32);
      const harness = createTestHarness(blocks, MigrationTier.FullHistory, {
        verifyHashChain: false,
      });
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 3 };
        const report = await harness.walker.walk(channel);
        // Should not fail even though hash chain is broken
        expect(report.blocksVerified).toBe(0);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('tier branching', () => {
    const writes = [
      [], // block 0: genesis
      [{ namespace: 'mycc', key: 'k1', value: 'v1' }],
      [{ namespace: 'mycc', key: 'k2', value: 'v2' }],
    ];
    const blocks = buildLedger(3, writes);
    const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 3 };

    it('Tier 1 (CurrentState): no metadata or history written', async () => {
      const harness = createTestHarness(blocks, MigrationTier.CurrentState, {
        reconstructState: true,
      });
      try {
        await harness.walker.walk(channel);
        // No metadata or history files
        expect(harness.writtenRecords.has('channel-ch1/block-metadata.ndjson')).toBe(false);
        expect(harness.writtenRecords.has('channel-ch1/public-history.ndjson')).toBe(false);
        // State should still be accumulated
        const stateRecords: any[] = [];
        for await (const r of harness.walker.getReconstructedState('ch1')) {
          stateRecords.push(r);
        }
        expect(stateRecords).toHaveLength(2);
      } finally {
        await harness.cleanup();
      }
    });

    it('Tier 2 (StateWithAudit): metadata written, no history', async () => {
      const harness = createTestHarness(blocks, MigrationTier.StateWithAudit);
      try {
        await harness.walker.walk(channel);
        const metadata = harness.writtenRecords.get('channel-ch1/block-metadata.ndjson') ?? [];
        expect(metadata.length).toBeGreaterThan(0);
        expect(metadata[0]._type).toBe('block_metadata');
        // No history
        expect(harness.writtenRecords.has('channel-ch1/public-history.ndjson')).toBe(false);
      } finally {
        await harness.cleanup();
      }
    });

    it('Tier 3 (FullHistory): both metadata and history written', async () => {
      const harness = createTestHarness(blocks, MigrationTier.FullHistory);
      try {
        await harness.walker.walk(channel);
        const metadata = harness.writtenRecords.get('channel-ch1/block-metadata.ndjson') ?? [];
        const history = harness.writtenRecords.get('channel-ch1/public-history.ndjson') ?? [];
        expect(metadata.length).toBeGreaterThan(0);
        expect(history.length).toBeGreaterThan(0);
        expect(history[0]._type).toBe('public_history');
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('identity tracking', () => {
    it('tracks unique identities across blocks', async () => {
      const blocks = buildLedger(4);
      const harness = createTestHarness(blocks);
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 4 };
        await harness.walker.walk(channel);
        const registry = harness.walker.getIdentityRegistry();
        // All blocks use the same creator, so one identity
        expect(registry.size).toBe(1);
        const identity = Array.from(registry.values())[0];
        expect(identity.mspId).toBe('Org1MSP');
        expect(identity.txCount).toBe(3); // blocks 1,2,3 have txs (block 0 is empty genesis)
        expect(identity.firstSeenBlock).toBe(1);
        expect(identity.lastSeenBlock).toBe(3);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('state reconstruction', () => {
    it('accumulates state from writes and handles deletes', async () => {
      const writes = [
        [], // genesis
        [{ namespace: 'mycc', key: 'k1', value: 'v1' }],
        [{ namespace: 'mycc', key: 'k2', value: 'v2' }],
        [{ namespace: 'mycc', key: 'k1', value: '', isDelete: true }],
      ];
      const blocks = buildLedger(4, writes);
      const harness = createTestHarness(blocks, MigrationTier.CurrentState, {
        reconstructState: true,
        stateBackend: 'memory',
      });
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 4 };
        await harness.walker.walk(channel);

        const state: any[] = [];
        for await (const r of harness.walker.getReconstructedState('ch1')) {
          state.push(r);
        }
        // k1 was written then deleted, k2 survives
        expect(state).toHaveLength(1);
        expect(state[0].key).toBe('k2');
        expect(state[0].value).toBe('v2');
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('decodeBlock', () => {
    it('refuses a block that is not protobuf', async () => {
      // The content check needs the raw envelopes; a block in any other form
      // would be walked without it.
      const blocks = buildLedger(2);
      const harness = createTestHarness(blocks);
      (harness.walker as any).network.getContract('qscc').evaluateTransaction
        .mockImplementation(async (_n: string, _c: string, num: string) =>
          Buffer.from(JSON.stringify(blocks[parseInt(num, 10)]), 'utf-8'));
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 2 };
        await expect(harness.walker.walk(channel)).rejects.toThrow(/Failed to decode protobuf block/);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('checkpointing', () => {
    it('resumes from last checkpoint', async () => {
      const blocks = buildLedger(5);
      const harness = createTestHarness(blocks);
      try {
        const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 5 };
        // Walk first 3 blocks
        const channel3: ChannelInfo = { ...channel, ledgerHeight: 3 };
        await harness.walker.walk(channel3);

        // Create new walker with same checkpoint dir — should resume from block 3
        const report = await harness.walker.walk(channel);
        // First walk: blocks 0,1,2 = 3 verified. Second walk: blocks 3,4 = 2 verified.
        expect(report.blocksVerified).toBe(3 + 2);
      } finally {
        await harness.cleanup();
      }
    });

    it('writes the checkpoint on the durability interval, not once per block', async () => {
      // A stringify-write-rename per block is ~0.37 ms — 49 minutes across the
      // 8M blocks of a large migration, for a number that is stale as
      // soon as the next block arrives.
      const harness = createTestHarness(buildLedger(12), MigrationTier.StateWithAudit, {
        durabilityInterval: 5,
      });
      const saved = jest.spyOn(harness.checkpointManager, 'save');
      try {
        await harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 12 });

        // Blocks 5 and 10 are the interval boundaries; 11 is the end of the walk.
        expect(saved.mock.calls.map(([cp]) => cp.lastBlockNumber)).toEqual([5, 10, 11]);
      } finally {
        await harness.cleanup();
      }
    });

    it('defaults to a durability point every 100 blocks', async () => {
      // 100 blocks of records is what a SIGKILL costs, and 80k checkpoint
      // writes is what an 8M-block walk pays for that bound: half a minute.
      const harness = createTestHarness(buildLedger(102), MigrationTier.StateWithAudit, {
        durabilityInterval: undefined,
      });
      const saved = jest.spyOn(harness.checkpointManager, 'save');
      try {
        await harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 102 });

        expect(saved.mock.calls.map(([cp]) => cp.lastBlockNumber)).toEqual([100, 101]);
      } finally {
        await harness.cleanup();
      }
    });

    it('fsyncs the records before writing the checkpoint that claims them', async () => {
      // write() resolves once a record is in the stream buffer, so a checkpoint
      // written at that moment names records a SIGKILL still loses. Reversed,
      // the checkpoint can only lag the durable records — never lead them.
      const harness = createTestHarness(buildLedger(12), MigrationTier.StateWithAudit, {
        durabilityInterval: 5,
      });
      const order: string[] = [];
      jest.spyOn(harness.writer, 'syncAll').mockImplementation(() => {
        order.push('fsync');
      });
      jest.spyOn(harness.checkpointManager, 'save').mockImplementation((cp) => {
        order.push(`checkpoint:${cp.lastBlockNumber}`);
      });
      try {
        await harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 12 });

        expect(order).toEqual([
          'fsync', 'checkpoint:5',
          'fsync', 'checkpoint:10',
          'fsync', 'checkpoint:11',
        ]);
      } finally {
        await harness.cleanup();
      }
    });

    it('leaves a failed walk the last block it finished', async () => {
      // The rerun starts from whatever reached the file, so a walk that dies
      // between durability points must still write one on the way out.
      const blocks = buildLedger(6);
      blocks[4].header.previous_hash = 'aa'.repeat(32);
      const harness = createTestHarness(blocks, MigrationTier.StateWithAudit, {
        durabilityInterval: 100,
      });
      try {
        await expect(
          harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 6 }),
        ).rejects.toThrow(/Hash chain integrity failure at block 4/);

        const laterRun = new CheckpointManager(harness.checkpointDir);
        expect(laterRun.getLastBlockNumber('ch1', 'block-walk')).toBe(3);
      } finally {
        await harness.cleanup();
      }
    });

    it('reports what stopped the walk, not the checkpoint it then could not write', async () => {
      const blocks = buildLedger(6);
      blocks[4].header.previous_hash = 'aa'.repeat(32);
      const harness = createTestHarness(blocks, MigrationTier.StateWithAudit, {
        durabilityInterval: 100,
      });
      jest.spyOn(harness.checkpointManager, 'flush').mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });
      try {
        await expect(
          harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 6 }),
        ).rejects.toThrow(/Hash chain integrity failure at block 4/);
      } finally {
        await harness.cleanup();
      }
    });

    it('fails a completed walk whose progress could not be recorded', async () => {
      // Nothing is unwinding here, so a checkpoint that cannot be written is
      // the run's problem: silently returning would report a walk as complete
      // that the next run will repeat from the start.
      const harness = createTestHarness(buildLedger(5), MigrationTier.StateWithAudit, {
        durabilityInterval: 100,
      });
      jest.spyOn(harness.checkpointManager, 'flush').mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });
      try {
        await expect(
          harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 5 }),
        ).rejects.toThrow(/no space left on device/);
      } finally {
        await harness.cleanup();
      }
    });

    it('still checkpoints at the end of the walk when durability is disabled', async () => {
      const harness = createTestHarness(buildLedger(5), MigrationTier.StateWithAudit, {
        durabilityInterval: 0,
      });
      const saved = jest.spyOn(harness.checkpointManager, 'save');
      try {
        await harness.walker.walk({ channelId: 'ch1', chaincodes: [], ledgerHeight: 5 });

        expect(saved).toHaveBeenCalledTimes(1);
        expect(harness.writer.syncAll).not.toHaveBeenCalled();
        const laterRun = new CheckpointManager(harness.checkpointDir);
        expect(laterRun.getLastBlockNumber('ch1', 'block-walk')).toBe(4);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe('prefetch', () => {
    it('produces same results as sequential walk', async () => {
      const blocks = buildLedger(6);
      const channel: ChannelInfo = { channelId: 'ch1', chaincodes: [], ledgerHeight: 6 };

      const seqHarness = createTestHarness(blocks, MigrationTier.FullHistory, { prefetchBuffer: 0 });
      const preHarness = createTestHarness(blocks, MigrationTier.FullHistory, { prefetchBuffer: 3 });

      try {
        const seqReport = await seqHarness.walker.walk(channel);
        const preReport = await preHarness.walker.walk(channel);

        expect(seqReport.hashChainValid).toBe(preReport.hashChainValid);
        expect(seqReport.blocksVerified).toBe(preReport.blocksVerified);

        // Same history records written
        const seqHistory = seqHarness.writtenRecords.get('channel-ch1/public-history.ndjson') ?? [];
        const preHistory = preHarness.writtenRecords.get('channel-ch1/public-history.ndjson') ?? [];
        expect(seqHistory.length).toBe(preHistory.length);
      } finally {
        await seqHarness.cleanup();
        await preHarness.cleanup();
      }
    });
  });
});

describe('ASN.1 encoding', () => {
  it('encodes integer 0 correctly', () => {
    const encoded = asn1EncodeInteger(0);
    expect(encoded).toEqual(Buffer.from([0x02, 0x01, 0x00]));
  });

  it('encodes small positive integer', () => {
    const encoded = asn1EncodeInteger(5);
    // 0x02, length 1, value 0x05
    expect(encoded).toEqual(Buffer.from([0x02, 0x01, 0x05]));
  });

  it('encodes integer with high bit set (needs padding)', () => {
    const encoded = asn1EncodeInteger(128);
    // 128 = 0x80, needs 0x00 prefix to stay positive
    expect(encoded).toEqual(Buffer.from([0x02, 0x02, 0x00, 0x80]));
  });

  it('encodes multi-byte integer', () => {
    const encoded = asn1EncodeInteger(256);
    // 256 = 0x0100
    expect(encoded).toEqual(Buffer.from([0x02, 0x02, 0x01, 0x00]));
  });

  it('encodes empty octet string', () => {
    const encoded = asn1EncodeOctetString(Buffer.alloc(0));
    expect(encoded).toEqual(Buffer.from([0x04, 0x00]));
  });

  it('computes known block header hash for genesis block', () => {
    // Genesis block: number=0, previousHash='', dataHash=''
    const hash = computeBlockHeaderHash(0, '', '');
    // Should be deterministic
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Computing again should produce the same result
    expect(computeBlockHeaderHash(0, '', '')).toBe(hash);
  });

  it('produces different hashes for different block numbers', () => {
    const hash0 = computeBlockHeaderHash(0, '', 'aa'.repeat(32));
    const hash1 = computeBlockHeaderHash(1, '', 'aa'.repeat(32));
    expect(hash0).not.toBe(hash1);
  });
});
