// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChannelInfo,
  CollectionConfig,
  ExtractOptions,
  ExtractionRecord,
  Manifest,
  MigrationTier,
} from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  HybridExtractor,
  PrivateDataDeliveryFn,
} from '../src/extraction/strategies/hybrid-extractor';
import { ADMIN_CERT_PEM } from './helpers/test-certs';
import { encodeBlock, sealBlock } from './helpers/protobuf-block';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';
import { HybridStateAccumulator } from '../src/extraction/state-accumulator';

// ── ASN.1 DER block header hashing (mirrors block-walker) ──

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

function blockHeaderHash(
  blockNumber: number,
  previousHash: string,
  dataHash: string,
): string {
  const der = Buffer.concat([
    asn1LengthPrefix(
      0x30,
      asn1EncodeInteger(blockNumber).length +
      asn1EncodeOctetString(
        previousHash ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0),
      ).length +
      asn1EncodeOctetString(
        dataHash ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0),
      ).length,
    ),
    asn1EncodeInteger(blockNumber),
    asn1EncodeOctetString(
      previousHash ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0),
    ),
    asn1EncodeOctetString(
      dataHash ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0),
    ),
  ]);
  return crypto.createHash('sha256').update(der).digest('hex');
}

// ── Block fixtures ──

interface Write {
  key: string;
  value: string;
}

/**
 * A block holding one endorsed transaction, or — when `writes` is empty — a
 * transaction-free block standing in for a config block.
 */
function makeBlock(
  blockNumber: number,
  previousHash: string,
  writes: Write[],
  namespace = 'mycc',
  hashedCollections: string[] = [],
): any {
  return sealBlock({
    header: {
      number: String(blockNumber),
      previous_hash: previousHash,
      data_hash: '',
    },
    data: {
      data: writes.length === 0 ? [] : [{
        payload: {
          header: {
            channel_header: {
              tx_id: `tx-${blockNumber}`,
              timestamp:
                `2026-01-01T00:00:${String(blockNumber % 60).padStart(2, '0')}Z`,
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
                  input: {
                    chaincode_spec: { chaincode_id: { name: namespace } },
                  },
                },
                action: {
                  proposal_response_payload: {
                    extension: {
                      results: {
                        ns_rwset: [{
                          namespace,
                          rwset: {
                            writes: writes.map((w) => ({
                              key: w.key,
                              value: w.value,
                              is_delete: false,
                            })),
                          },
                          collection_hashed_rwset: hashedCollections.map(
                            (name) => ({
                              collection_name: name,
                              hashed_rwset: {
                                hashed_writes: [{
                                  key_hash: Buffer.from(
                                    crypto.createHash('sha256')
                                      .update(`k${blockNumber}`).digest(),
                                  ),
                                  value_hash: Buffer.from(
                                    crypto.createHash('sha256')
                                      .update(`v${blockNumber}`).digest(),
                                  ),
                                }],
                              },
                            }),
                          ),
                        }],
                      },
                    },
                  },
                },
              },
            }],
          },
        },
      }],
    },
    metadata: { metadata: [[], [], writes.length === 0 ? [] : [0]] },
  });
}

/**
 * Build a hash-linked ledger. Block numbers listed in `emptyBlocks` carry no
 * transactions, so they produce no block-metadata records.
 */
function buildLedger(height: number, emptyBlocks: number[] = []): any[] {
  const blocks: any[] = [];
  let previousHash = '';

  for (let i = 0; i < height; i++) {
    const writes = i === 0 || emptyBlocks.includes(i)
      ? []
      : [{ key: `k${i}`, value: `v${i}` }];
    const block = makeBlock(i, previousHash, writes);
    blocks.push(block);
    previousHash = blockHeaderHash(
      i, block.header.previous_hash, block.header.data_hash,
    );
  }

  return blocks;
}

/**
 * A ledger whose every non-genesis block carries a hashed private write, so the
 * walk writes the hashes file itself rather than a fixture pre-seeding it.
 */
function buildLedgerWithPrivateHashes(height: number): any[] {
  const blocks: any[] = [];
  let previousHash = '';

  for (let i = 0; i < height; i++) {
    const writes = i === 0 ? [] : [{ key: `k${i}`, value: `v${i}` }];
    const block = makeBlock(
      i, previousHash, writes, 'mycc', i === 0 ? [] : ['col1'],
    );
    blocks.push(block);
    previousHash = blockHeaderHash(
      i, block.header.previous_hash, block.header.data_hash,
    );
  }

  return blocks;
}

function mockGateway(blocks: any[]): any {
  const contract = {
    evaluateTransaction: jest.fn(
      async (_fn: string, _channel: string, blockNum: string) => {
        const block = blocks[parseInt(blockNum, 10)];
        if (!block) throw new Error(`Block ${blockNum} not found`);
        return encodeBlock(block);
      },
    ),
    submitTransaction: jest.fn(),
  };
  return { getNetwork: jest.fn(() => ({ getContract: jest.fn(() => contract) })) };
}

// ── Channel / option fixtures ──

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-meta-test-'));
  layout = new FileLayoutManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function collection(overrides: Partial<CollectionConfig> = {}): CollectionConfig {
  return {
    name: 'col1',
    policy: "OR('Org1MSP.member')",
    requiredPeerCount: 1,
    maxPeerCount: 2,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    ...overrides,
  };
}

function channelInfo(
  collections: CollectionConfig[] = [],
  ledgerHeight = 5,
): ChannelInfo {
  return {
    channelId: 'ch1',
    ledgerHeight,
    chaincodes: [
      { name: 'mycc', version: '1.0', sequence: 1, collections },
    ],
  };
}

function options(
  overrides: Partial<ExtractOptions> = {},
): ExtractOptions {
  return {
    manifest: path.join(tmpDir, 'manifest.json'),
    nodeId: 'nd-TEST',
    tier: MigrationTier.StateWithAudit,
    channels: ['ch1'],
    outputDir: tmpDir,
    batchSize: 100,
    strategy: 'block-reconstruction',
    concurrency: 1,
    stateBackend: 'memory',
    memoryLimitMb: 512,
    prefetchBuffer: 0,
    ...overrides,
  };
}

function manifestFor(channel: ChannelInfo): Manifest {
  return {
    networkId: 'nd-TEST',
    memberId: 'm-TEST',
    region: 'us-east-1',
    stateDb: 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z',
    channels: [channel],
  };
}

async function extract(
  channel: ChannelInfo,
  blocks: any[],
  mspId?: string,
  overrides: Partial<ExtractOptions> = {},
  deliverPrivateData?: PrivateDataDeliveryFn,
): Promise<void> {
  const extractor = new HybridExtractor(
    options(overrides),
    manifestFor(channel),
    mockGateway(blocks),
    mspId,
    deliverPrivateData,
  );
  await extractor.run([channel]);
}

function readMetadata(): any {
  return JSON.parse(
    fs.readFileSync(path.join(tmpDir, layout.channelMetadataPath('ch1')), 'utf-8'),
  );
}

function writeRecords(relativePath: string, records: ExtractionRecord[]): void {
  const full = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function privateStateRecord(
  key: string,
  collection = 'col1',
  chaincode = 'mycc',
): ExtractionRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode,
    collection,
    key,
    value: 'v',
  };
}

function privateHashRecord(
  key: string,
  collection = 'col1',
  chaincode = 'mycc',
  blockNumber = 2,
): ExtractionRecord {
  return {
    _type: 'private_hash',
    channel: 'ch1',
    chaincode,
    collection,
    key: crypto.createHash('sha256').update(key).digest('hex'),
    hash: crypto.createHash('sha256').update('v').digest('hex'),
    blockNumber,
    txId: `tx-${blockNumber}`,
    txIndex: 0,
  };
}

// ── blocksWithoutMetadata ──

describe('channel metadata — blocksWithoutMetadata', () => {
  it('records blocks that produced no metadata records', async () => {
    const channel = channelInfo([], 5);
    await extract(channel, buildLedger(5, [3]));

    // Block 0 is the genesis block; block 3 carries no transactions.
    expect(readMetadata().blocksWithoutMetadata).toEqual([0, 3]);
  });

  it('is empty when every block produced metadata', async () => {
    const channel = channelInfo([], 3);
    const blocks = [
      makeBlock(0, '', [{ key: 'k0', value: 'v0' }]),
    ];
    let previousHash = blockHeaderHash(
      0, blocks[0].header.previous_hash, blocks[0].header.data_hash,
    );
    for (let i = 1; i < 3; i++) {
      const block = makeBlock(i, previousHash, [{ key: `k${i}`, value: `v${i}` }]);
      blocks.push(block);
      previousHash = blockHeaderHash(
        i, block.header.previous_hash, block.header.data_hash,
      );
    }

    await extract(channel, blocks);

    expect(readMetadata().blocksWithoutMetadata).toEqual([]);
  });

  it('replaces stale gaps when an incomplete extraction is rebuilt', async () => {
    const channel = channelInfo([], 5);
    const metadataPath = path.join(tmpDir, layout.channelMetadataPath('ch1'));
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ blocksWithoutMetadata: [0, 1, 2] }),
      'utf-8',
    );

    await extract(channel, buildLedger(5, [3]));

    // No completion marker accompanies this metadata, so it belongs to an
    // incomplete attempt and is replaced by this run's facts.
    expect(readMetadata().blocksWithoutMetadata).toEqual([0, 3]);
  });

  it('rewrites from this run alone when the existing file is corrupt', async () => {
    const channel = channelInfo([], 5);
    const metadataPath = path.join(tmpDir, layout.channelMetadataPath('ch1'));
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, '{ truncated', 'utf-8');

    await extract(channel, buildLedger(5, [3]));

    expect(readMetadata().blocksWithoutMetadata).toEqual([0, 3]);
  });

  it('does not record gaps at Tier 1, where no metadata is written', async () => {
    const channel = channelInfo([], 5);
    await extract(
      channel, buildLedger(5, [3]), undefined,
      { tier: MigrationTier.CurrentState },
    );

    expect(readMetadata().blocksWithoutMetadata).toEqual([]);
  });
});

// ── peer-node provenance ──

describe('channel metadata — nodeId', () => {
  it('records the AMB peer whose ledger and private-data store answered', async () => {
    const channel = channelInfo([], 3);
    await extract(channel, buildLedger(3));

    expect(readMetadata().nodeId).toBe('nd-TEST');
  });
});

// ── extractedByMspId ──

describe('channel metadata — extractedByMspId', () => {
  it('records the identity the extraction ran as', async () => {
    const channel = channelInfo([], 3);
    await extract(channel, buildLedger(3), 'Org2MSP');

    expect(readMetadata().extractedByMspId).toBe('Org2MSP');
  });

  it('keeps the earlier value when this run has no identity', async () => {
    const channel = channelInfo([], 3);
    await extract(channel, buildLedger(3), 'Org2MSP');
    await extract(channel, buildLedger(3), undefined);

    expect(readMetadata().extractedByMspId).toBe('Org2MSP');
  });
});

// ── privateDataCoverage ──

describe('channel metadata — privateDataCoverage', () => {
  it('is empty for a channel with no collections', async () => {
    const channel = channelInfo([], 3);
    await extract(channel, buildLedger(3));

    expect(readMetadata().privateDataCoverage).toEqual([]);
  });

  it('reports absent when neither values nor hashes were captured', async () => {
    const channel = channelInfo([collection()], 3);
    await extract(channel, buildLedger(3));

    expect(readMetadata().privateDataCoverage).toEqual([{
      chaincode: 'mycc',
      collection: 'col1',
      coverage: 'absent',
      // No extracting MSP was supplied, so membership cannot be evaluated.
      reason: 'indeterminate',
      blockToLive: 0,
      purgeRisk: 'none',
      estimatedPurgedBlocks: 0,
    }]);
  });

  it('reports hashes-only when only hashed rwsets landed on disk', async () => {
    const channel = channelInfo([collection()], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(3));

    expect(readMetadata().privateDataCoverage[0].coverage).toBe('hashes-only');
  });

  it('reports values when plaintext private state landed on disk', async () => {
    const channel = channelInfo([collection()], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateStateRecord('k1'),
    ]);

    await extract(channel, buildLedger(3));

    expect(readMetadata().privateDataCoverage[0].coverage).toBe('values');
  });

  it('treats an empty private state file as no values', async () => {
    const channel = channelInfo([collection()], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);
    fs.writeFileSync(
      path.join(tmpDir, layout.privateStatePath('ch1', 'mycc', 'col1')), '', 'utf-8',
    );

    await extract(channel, buildLedger(3));

    expect(readMetadata().privateDataCoverage[0].coverage).toBe('hashes-only');
  });

  it('carries blockToLive and the assessed purge risk', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 12);
    await extract(channel, buildLedger(12));

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.blockToLive).toBe(10);
    expect(entry.purgeRisk).toBe('medium');
    expect(entry.estimatedPurgedBlocks).toBe(2);
  });

  it('attributes values to one of two chaincodes sharing a collection name', async () => {
    const channel: ChannelInfo = {
      channelId: 'ch1',
      ledgerHeight: 3,
      chaincodes: [
        { name: 'cc-a', version: '1.0', sequence: 1, collections: [collection()] },
        { name: 'cc-b', version: '1.0', sequence: 1, collections: [collection()] },
      ],
    };
    writeRecords(layout.privateStatePath('ch1', 'cc-a', 'col1'), [
      privateStateRecord('k1', 'col1', 'cc-a'),
    ]);
    writeRecords(layout.privateHashesPath('ch1', 'cc-a', 'col1'), [
      privateHashRecord('k1', 'col1', 'cc-a'),
    ]);
    writeRecords(layout.privateHashesPath('ch1', 'cc-b', 'col1'), [
      privateHashRecord('k1', 'col1', 'cc-b'),
    ]);

    await extract(channel, buildLedger(3));

    // Each chaincode has its own files, so cc-a's values are not credited to
    // cc-b, and cc-b's missing values are not hidden behind cc-a's.
    const coverage = readMetadata().privateDataCoverage;
    expect(coverage.map((c: any) => [c.chaincode, c.coverage])).toEqual([
      ['cc-a', 'values'],
      ['cc-b', 'hashes-only'],
    ]);
  });
});

// ── privateDataCoverage: synthesized implicit collections ──

/**
 * Discovery synthesizes `_implicit_org_<MSPID>` for every channel org on every
 * 2.x chaincode, whether or not anything was ever written to it. Reporting the
 * untouched ones would bury the collections a coordinator has to make a call on,
 * so they only earn a row once they have captured something.
 */
describe('channel metadata — implicit collections', () => {
  const implicit = collection({
    name: '_implicit_org_Org1MSP',
    implicit: true,
  });

  it('leaves out an implicit collection that captured nothing', async () => {
    const channel = channelInfo([implicit], 3);
    await extract(channel, buildLedger(3), 'Org1MSP');

    expect(readMetadata().privateDataCoverage).toEqual([]);
  });

  it('reports an implicit collection that captured hashes', async () => {
    const channel = channelInfo([implicit], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', '_implicit_org_Org1MSP'), [
      privateHashRecord('k1', '_implicit_org_Org1MSP'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    const coverage = readMetadata().privateDataCoverage;
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      collection: '_implicit_org_Org1MSP',
      coverage: 'hashes-only',
    });
  });

  it('reports an implicit collection that captured values', async () => {
    const channel = channelInfo([implicit], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', '_implicit_org_Org1MSP'), [
      privateHashRecord('k1', '_implicit_org_Org1MSP'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', '_implicit_org_Org1MSP'), [
      privateStateRecord('k1', '_implicit_org_Org1MSP'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    expect(readMetadata().privateDataCoverage[0].coverage).toBe('values');
  });

  // A declared collection with nothing in it is a real finding — the chaincode
  // says data belongs there — so the suppression must not reach it.
  it('still reports a declared collection that captured nothing', async () => {
    const channel = channelInfo([collection(), implicit], 3);
    await extract(channel, buildLedger(3), 'Org1MSP');

    const coverage = readMetadata().privateDataCoverage;
    expect(coverage.map((c: any) => c.collection)).toEqual(['col1']);
    expect(coverage[0].coverage).toBe('absent');
  });

  // Implicit collections appear in no chaincode definition, so a channel whose
  // manifest declares none can still hold private data the peer will deliver.
  it('attempts private data delivery on a channel that declares no collections', async () => {
    const channel = channelInfo([], 3);
    const deliver = jest.fn<ReturnType<PrivateDataDeliveryFn>, any[]>(
      async () => undefined,
    );

    await extract(channel, buildLedger(3), 'Org1MSP', {}, deliver);

    expect(deliver).toHaveBeenCalledWith('ch1', 0, 2, expect.any(Function));
  });
});

// ── privateDataCoverage: authorization and cause ──

/**
 * `coverage` records the outcome; these cover the cause.
 *
 * A purge-loss sign-off has to name the collections that actually lost data, so
 * `hashes-only` reaching the artifact without a cause is not actionable — it is
 * arrived at by unauthorized, purged and never-written collections alike.
 */
describe('channel metadata — privateDataCoverage authorization', () => {
  const foreign = { policy: "OR('Org9MSP.member')" };

  it('records membership of the collection policy', async () => {
    const channel = channelInfo([collection()], 3);
    await extract(channel, buildLedger(3), 'Org1MSP');

    expect(readMetadata().privateDataCoverage[0].authorized).toBe(true);
  });

  it('names non-membership as the cause of hashes-only', async () => {
    const channel = channelInfo([collection(foreign)], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('hashes-only');
    expect(entry.authorized).toBe(false);
    expect(entry.reason).toBe('unauthorized');
  });

  it('names the purge window when a member captured only hashes', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 20);
    // Block 2 is ten blocks below the horizon at height 20, so this write is
    // genuinely past it: 2 + 10 < 20.
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(20), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.reason).toBe('purge-window');
    // What the sign-off quotes: the collection lost data, and how much of the
    // ledger is below the horizon.
    expect(entry.estimatedPurgedBlocks).toBe(10);
  });

  it('refuses the purge window when the newest hash is inside it', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 20);
    // 18 + 10 >= 20, so this write cannot have been purged. A peer that was
    // sent it still holds the value, so the horizon does not explain the loss.
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1', 'col1', 'mycc', 18),
    ]);

    await extract(channel, buildLedger(20), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.reason).toBe('unexplained');
    // The window itself is unchanged — it is the explanation that is refused.
    expect(entry.blockToLive).toBe(10);
    expect(entry.estimatedPurgedBlocks).toBe(10);
  });

  it('refuses the purge window when nothing is past the horizon yet', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 5);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(5), 'Org1MSP');

    // A young channel purges nothing, so no hash it holds can be purged. This
    // used to read purge-window with estimatedPurgedBlocks 0 — accepted loss
    // for a collection nothing had expired from.
    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.reason).toBe('unexplained');
    expect(entry.estimatedPurgedBlocks).toBe(0);
  });

  it('keeps the purge window one block below the boundary', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 12);
    // 1 + 10 < 12: the last block that is genuinely past the horizon.
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1', 'col1', 'mycc', 1),
    ]);

    await extract(channel, buildLedger(12), 'Org1MSP');

    expect(readMetadata().privateDataCoverage[0].reason).toBe('purge-window');
  });

  it('refuses the purge window exactly on the boundary', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 12);
    // 2 + 10 == 12, so block 2 has survived its full retention and is the
    // oldest block still inside the window. estimatedPurgedBlocks counts
    // blocks 0-1 as purged, and this has to agree with it.
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1', 'col1', 'mycc', 2),
    ]);

    await extract(channel, buildLedger(12), 'Org1MSP');

    expect(readMetadata().privateDataCoverage[0].reason).toBe('unexplained');
  });

  it('keeps the purge window when the newest hash cannot be read', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 20);
    const full = path.join(
      tmpDir, layout.privateHashesPath('ch1', 'mycc', 'col1'),
    );
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '{"_type":"private_ha', 'utf-8');

    await extract(channel, buildLedger(20), 'Org1MSP');

    // The file has content, so coverage is hashes-only, but no block can be
    // read from it. A check that cannot run must not manufacture a stop, so
    // the reason is what it was before the check existed.
    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('hashes-only');
    expect(entry.reason).toBe('purge-window');
  });

  it('takes the newest hash from the last record, not the first', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 20);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1', 'col1', 'mycc', 1),
      privateHashRecord('k2', 'col1', 'mycc', 2),
      privateHashRecord('k3', 'col1', 'mycc', 18),
    ]);

    await extract(channel, buildLedger(20), 'Org1MSP');

    // One unpurged write is enough to refuse the horizon, however many older
    // ones sit beneath it.
    expect(readMetadata().privateDataCoverage[0].reason).toBe('unexplained');
  });

  it('reads the newest hash this run wrote, not what was flushed early', async () => {
    // Every test above pre-seeds the hashes file with a plain fs write, so the
    // tail read always finds a complete file on disk. A real run writes it
    // through NdjsonWriter, where write() resolves once a record is in the
    // stream's buffer — so reading the tail before the stream is closed saw an
    // empty or partial file and fell back to keeping `purge-window`. Nothing
    // here is past the horizon (newest hash at block 19, blockToLive 10, height
    // 20), so `purge-window` from this scenario means the newest block was not
    // read, and accepted loss was recorded for a collection that lost nothing.
    const channel = channelInfo([collection({ blockToLive: 10 })], 20);

    await extract(
      channel,
      buildLedgerWithPrivateHashes(20),
      'Org1MSP',
      { tier: MigrationTier.FullHistory },
    );

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('hashes-only');
    expect(entry.reason).toBe('unexplained');
  });

  it('flags a member with no purge window and no values as unexplained', async () => {
    const channel = channelInfo([collection({ blockToLive: 0 })], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    // Not accepted loss — the values should have been delivered.
    expect(readMetadata().privateDataCoverage[0].reason).toBe('unexplained');
  });

  it('prefers non-membership over the purge window', async () => {
    const channel = channelInfo(
      [collection({ ...foreign, blockToLive: 10 })], 12,
    );
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(12), 'Org1MSP');

    // A peer never sent the values cannot have purged them, so membership
    // decides even though the collection does expire.
    expect(readMetadata().privateDataCoverage[0].reason).toBe('unauthorized');
  });

  it('does not call a collection purged when no hashes were seen either', async () => {
    const channel = channelInfo([collection({ blockToLive: 10 })], 12);

    await extract(channel, buildLedger(12), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('absent');
    // No hashes means no evidence the data ever existed; calling it purged
    // would invent a loss for the sign-off to account for.
    expect(entry.reason).toBe('never-written');
  });

  it('assigns no cause when the extraction succeeded', async () => {
    const channel = channelInfo([collection()], 3);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateStateRecord('k1'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('values');
    expect(entry.reason).toBeUndefined();
  });

  it('leaves membership undetermined when the extracting MSP is unknown', async () => {
    const channel = channelInfo([collection(foreign)], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(3), undefined);

    const entry = readMetadata().privateDataCoverage[0];
    // Absent rather than false: unknown is not a denial.
    expect(entry.authorized).toBeUndefined();
    expect(entry.reason).toBe('indeterminate');
  });

  it('treats an unreadable policy as membership rather than denial', async () => {
    const channel = channelInfo([collection({ policy: '' })], 3);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      privateHashRecord('k1'),
    ]);

    await extract(channel, buildLedger(3), 'Org1MSP');

    const entry = readMetadata().privateDataCoverage[0];
    // Fails open: a policy we cannot parse must not be blamed for the gap.
    expect(entry.authorized).toBe(true);
    expect(entry.reason).toBe('unexplained');
  });
});

// ── outputFiles ──

describe('channel metadata — outputFiles', () => {
  it('counts the records this run wrote', async () => {
    const channel = channelInfo([], 5);
    await extract(channel, buildLedger(5));

    const files = readMetadata().outputFiles;
    expect(files.publicState).toBe(4);
    expect(files.blockMetadata).toBe(4);
  });

  it('rebuilds rather than appending when completion state is removed', async () => {
    const channel = channelInfo([], 5);
    await extract(channel, buildLedger(5));
    const first = readMetadata().outputFiles;

    // Removing the checkpoint directory also removes the completion marker.
    // The second run must replace every derived file, not append duplicates.
    fs.rmSync(path.join(tmpDir, layout.checkpointDir('ch1')), {
      recursive: true, force: true,
    });
    await extract(channel, buildLedger(5));

    expect(readMetadata().outputFiles.blockMetadata).toBe(
      first.blockMetadata,
    );
  });
});

// ── --private-only ──
//
// A member whose public data another member's full extraction carries runs
// private delivery alone. It must not walk the public ledger, must say in its
// metadata that it did not, and must not claim a collection it was entitled to
// was never written: with no hashes it has no evidence either way.

describe('private-only extraction', () => {
  const noDelivery = () =>
    jest.fn<ReturnType<PrivateDataDeliveryFn>, any[]>(async () => undefined);

  it('skips the public block walk and still delivers private data', async () => {
    const channel = channelInfo([collection()], 3);
    const gateway = mockGateway(buildLedger(3));
    const deliver = noDelivery();

    await new HybridExtractor(
      options({ privateOnly: true }), manifestFor(channel), gateway,
      'Org1MSP', deliver,
    ).run([channel]);

    expect(gateway.getNetwork).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith('ch1', 0, 2, expect.any(Function));
    expect(fs.existsSync(path.join(tmpDir, layout.publicStatePath('ch1'))))
      .toBe(false);
    expect(fs.existsSync(path.join(tmpDir, layout.identitiesPath))).toBe(false);
  });

  it('marks the channel private-only', async () => {
    const channel = channelInfo([collection()], 3);
    await extract(channel, buildLedger(3), 'Org1MSP', { privateOnly: true }, noDelivery());

    const metadata = readMetadata();
    expect(metadata.scope).toBe('private-only');
    expect(metadata.outputFiles).toEqual({
      publicState: 0, publicHistory: 0, blockMetadata: 0,
    });
  });

  it('leaves a full extraction unmarked', async () => {
    const channel = channelInfo([collection()], 3);
    await extract(channel, buildLedger(3), 'Org1MSP', {}, noDelivery());

    expect(readMetadata()).not.toHaveProperty('scope');
  });

  it('says indeterminate, not never-written, for an entitled collection without values', async () => {
    const channel = channelInfo([collection()], 3);
    await extract(channel, buildLedger(3), 'Org1MSP', { privateOnly: true }, noDelivery());

    const entry = readMetadata().privateDataCoverage[0];
    expect(entry.coverage).toBe('absent');
    expect(entry.authorized).toBe(true);
    expect(entry.reason).toBe('indeterminate');
  });

  it('still names non-membership, which the policy settles', async () => {
    const channel = channelInfo(
      [collection({ policy: "OR('Org9MSP.member')" })], 3,
    );
    await extract(channel, buildLedger(3), 'Org1MSP', { privateOnly: true }, noDelivery());

    expect(readMetadata().privateDataCoverage[0].reason).toBe('unauthorized');
  });
});

// ── Walk and private delivery at once ──
//
// Each channel's public walk and its private pass are separate streams to the
// peer, so they run together. The output must not depend on that, a failure in
// either must still leave the walk's checkpoint behind, and `--state-backend
// memory`, which nothing bounds, keeps them one after the other.

describe('walk and private delivery together', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** A gateway whose fetches take a turn of the event loop and are logged. */
  function loggedGateway(blocks: any[], events: string[], failAt?: number): any {
    const contract = {
      evaluateTransaction: jest.fn(async (_fn: string, _channel: string, n: string) => {
        await tick();
        if (Number(n) === failAt) throw new Error(`PERMISSION_DENIED: peer stopped serving at block ${n}`);
        events.push(`walk:${n}`);
        return encodeBlock(blocks[Number(n)]);
      }),
    };
    const network = { getContract: jest.fn(() => contract) };
    return { getNetwork: jest.fn(() => network) };
  }

  /** Delivery of one private value per block, logged; `failAt` stops it there. */
  function loggedDelivery(blocks: any[], events: string[], failAt?: number, valueBytes = 0): PrivateDataDeliveryFn {
    return async (_channel, start, end, onBlock) => {
      for (let i = start; i <= end; i++) {
        await tick();
        if (i === failAt) throw new Error(`delivery stream reset at block ${i}`);
        events.push(`pvt:${i}`);
        const value = valueBytes > 0 ? Buffer.alloc(valueBytes, 0x61) : Buffer.from(`v${i}`);
        const map = i === 0 ? {} : {
          0: {
            ns_pvt_rwset: [{
              namespace: 'mycc',
              collection_pvt_rwset: [{
                collection_name: 'col1',
                rwset: { writes: [{ key: `k${i}`, value, is_delete: false }] },
              }],
            }],
          },
        };
        await onBlock(i, blocks[i], map);
      }
    };
  }

  const run = (
    dir: string, blocks: any[], events: string[], overrides: Partial<ExtractOptions>,
    fail: { walk?: number; delivery?: number } = {},
  ): Promise<void> => {
    const channel = channelInfo([collection()], blocks.length);
    return new HybridExtractor(
      options({ tier: MigrationTier.FullHistory, outputDir: dir, ...overrides }),
      manifestFor(channel), loggedGateway(blocks, events, fail.walk), 'Org1MSP',
      loggedDelivery(blocks, events, fail.delivery),
    ).run([channel]);
  };

  /** Every NDJSON file under a directory, lines sorted. */
  function contents(dir: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const walk = (d: string): void => {
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f);
        if (fs.statSync(full).isDirectory()) { if (f !== 'checkpoints') walk(full); continue; }
        if (f.endsWith('.ndjson')) out[path.relative(dir, full)] = fs.readFileSync(full, 'utf-8').split('\n').filter(Boolean).sort();
      }
    };
    walk(dir);
    return out;
  }

  const lastWalked = (dir: string): number =>
    new CheckpointManager(path.join(dir, layout.checkpointDir('ch1'))).getLastBlockNumber('ch1', 'block-walk');

  it('delivers private data during the walk under the auto backend', async () => {
    const events: string[] = [];
    await run(tmpDir, buildLedgerWithPrivateHashes(8), events, { stateBackend: 'auto' });

    const lastWalk = events.lastIndexOf('walk:7');
    const firstPvt = events.indexOf('pvt:0');
    expect(firstPvt).toBeGreaterThanOrEqual(0);
    expect(firstPvt).toBeLessThan(lastWalk);
  });

  it('keeps them one after the other with --state-backend memory', async () => {
    const events: string[] = [];
    await run(tmpDir, buildLedgerWithPrivateHashes(8), events, { stateBackend: 'memory' });

    expect(events.indexOf('pvt:0')).toBeGreaterThan(events.lastIndexOf('walk:7'));
  });

  it('writes the same extraction either way', async () => {
    const blocks = buildLedgerWithPrivateHashes(8);
    const together = path.join(tmpDir, 'together');
    const sequential = path.join(tmpDir, 'sequential');
    await run(together, blocks, [], { stateBackend: 'auto' });
    await run(sequential, blocks, [], { stateBackend: 'memory' });

    expect(contents(together)).toEqual(contents(sequential));
    expect(Object.keys(contents(together))).toEqual(expect.arrayContaining([
      'channel-ch1/public-state.ndjson', 'channel-ch1/public-history.ndjson',
      'channel-ch1/private-mycc-col1-state.ndjson', 'channel-ch1/private-mycc-col1-history.ndjson',
      'channel-ch1/private-mycc-col1-hashes.ndjson',
    ]));
  });

  it('spills the walk to LevelDB when the private map fills the shared budget', async () => {
    // --memory-limit 1: the walk's own state is a few hundred bytes, but the
    // private pass running beside it holds 600 KB per block. The walk waits at
    // block 5 until delivery has passed block 3, so the map is over the budget
    // before the walk's next write, whatever the scheduling.
    const promote = jest.spyOn(HybridStateAccumulator.prototype as any, 'promote');
    const extractWith = async (dir: string, valueBytes: number): Promise<void> => {
      const blocks = buildLedgerWithPrivateHashes(10);
      const channel = channelInfo([collection()], blocks.length);
      let delivered!: () => void;
      const deliveredThrough3 = new Promise<void>((resolve) => { delivered = resolve; });
      const events: string[] = [];
      const gateway = loggedGateway(blocks, events);
      const contract = gateway.getNetwork().getContract();
      const serve = contract.evaluateTransaction.getMockImplementation();
      contract.evaluateTransaction.mockImplementation(async (fn: string, ch: string, n: string) => {
        if (Number(n) === 5) await deliveredThrough3;
        return serve(fn, ch, n);
      });
      const deliver = loggedDelivery(blocks, events, undefined, valueBytes);
      await new HybridExtractor(
        options({ tier: MigrationTier.FullHistory, outputDir: dir, stateBackend: 'auto', memoryLimitMb: 1 }),
        manifestFor(channel), gateway, 'Org1MSP',
        (c, s, e, onBlock) => deliver(c, s, e, async (n, b, m) => {
          await onBlock(n, b, m);
          if (n === 3) delivered();
        }),
      ).run([channel]);
    };
    try {
      await extractWith(path.join(tmpDir, 'small'), 0);
      expect(promote).not.toHaveBeenCalled();

      await extractWith(path.join(tmpDir, 'large'), 600 * 1024);
      expect(promote).toHaveBeenCalledTimes(1);
    } finally {
      promote.mockRestore();
    }
  });

  it('stops the delivery when the walk fails, and reports the walk', async () => {
    const events: string[] = [];
    await expect(
      run(tmpDir, buildLedgerWithPrivateHashes(40), events, { stateBackend: 'auto' }, { walk: 3 }),
    ).rejects.toThrow(/PERMISSION_DENIED: peer stopped serving at block 3/);

    // The delivery stopped soon after, not at the end of the ledger
    expect(events).not.toContain('pvt:39');
    expect(lastWalked(tmpDir)).toBe(2);
  });

  it('lets the walk finish when the delivery fails, so its checkpoint survives', async () => {
    await expect(
      run(tmpDir, buildLedgerWithPrivateHashes(8), [], { stateBackend: 'auto' }, { delivery: 1 }),
    ).rejects.toThrow(/delivery stream reset at block 1/);

    expect(lastWalked(tmpDir)).toBe(7);
  });
});
