// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChannelInfo,
  CollectionConfig,
  ExtractionRecord,
  MigrationTier,
} from '../src/types';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  runValidation,
  ValidationResult,
} from '../src/validation/validation-runner';

let tmpDir: string;
let layout: FileLayoutManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-test-'));
  layout = new FileLayoutManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixtures ──

const CREATOR = {
  mspId: 'Org1MSP',
  commonName: 'admin',
  org: 'Org1',
  certFingerprint: 'fp',
};

function collection(
  overrides: Partial<CollectionConfig> = {},
): CollectionConfig {
  return {
    name: 'col1',
    policy: "OR('Org1MSP.member', 'Org2MSP.member')",
    requiredPeerCount: 1,
    maxPeerCount: 2,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    ...overrides,
  };
}

function writeManifest(channel: ChannelInfo, mspId?: string): void {
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({
      networkId: 'nd-TEST',
      memberId: 'm-TEST',
      region: 'us-east-1',
      stateDb: 'CouchDB',
      extractedAt: '2026-01-01T00:00:00.000Z',
      mspId,
      channels: [channel],
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

function writeChannelMetadata(
  channelId: string,
  metadata: Record<string, unknown>,
): void {
  const full = path.join(tmpDir, layout.channelMetadataPath(channelId));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(metadata), 'utf-8');
}

function metadataRecord(blockNumber: number): ExtractionRecord {
  return {
    _type: 'block_metadata',
    channel: 'ch1',
    blockNumber,
    txId: `tx${blockNumber}`,
    txIndex: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    chaincodeId: 'mycc',
    keysWritten: [`k${blockNumber}`],
    keysDeleted: [],
    creator: CREATOR,
  };
}

function keyHash(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function valueHash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashRecord(
  key: string,
  blockNumber: number,
  value?: string,
  chaincode = 'mycc',
): ExtractionRecord {
  return {
    _type: 'private_hash',
    channel: 'ch1',
    chaincode,
    collection: 'col1',
    key: keyHash(key),
    hash: value === undefined ? '' : valueHash(value),
    blockNumber,
    txId: `tx${blockNumber}`,
    txIndex: 0,
  };
}

function privateStateRecord(
  key: string,
  value: string,
  chaincode = 'mycc',
): ExtractionRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode,
    collection: 'col1',
    key,
    value,
  };
}

function find(results: ValidationResult[], prefix: string): ValidationResult {
  const found = results.find((r) => r.check.startsWith(prefix));
  if (!found) {
    throw new Error(
      `No result starting with "${prefix}". Got: ` +
      results.map((r) => r.check).join(', '),
    );
  }
  return found;
}

// ── Channel selection: a run that validates nothing must not report success ──

describe('channel selection', () => {
  const channel: ChannelInfo = {
    channelId: 'mychannel',
    chaincodes: [],
    ledgerHeight: 6,
  };

  it('refuses a --channels name the manifest does not hold', async () => {
    writeManifest(channel);

    // Every check below the manifest is per channel, so filtering an unknown
    // name out leaves nothing to validate and the run used to return one
    // passing result and exit 0 — a typo reading as a green light to replay.
    await expect(runValidation(tmpDir, ['mychannl'])).rejects.toThrow(
      /not in the manifest: mychannl\. Manifest channels: mychannel/,
    );
  });

  it('names every unknown channel, not just the first', async () => {
    writeManifest(channel);

    await expect(
      runValidation(tmpDir, ['mychannel', 'ch2', 'ch3']),
    ).rejects.toThrow(/not in the manifest: ch2, ch3/);
  });

  it('validates the named subset when every name is known', async () => {
    writeManifest(channel);
    writeChannelMetadata('mychannel', { blocksWithoutMetadata: [] });
    writeRecords(layout.blockMetadataPath('mychannel'), [
      metadataRecord(0), metadataRecord(1), metadataRecord(2),
      metadataRecord(3), metadataRecord(4), metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir, ['mychannel']);

    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
    expect(find(results, 'Block completeness').status).toBe('pass');
  });

  it('leaves a channel out of the run when --channels does not name it', async () => {
    // The refusal above only establishes that an unknown name stops the run.
    // This is the other half: a known name has to *narrow* it, or --channels is
    // decoration and a coordinator validating one channel at a time is silently
    // reading the whole extraction's verdict.
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: '2026-01-01T00:00:00.000Z',
        mspId: 'Org1MSP',
        channels: [
          { channelId: 'ch1', chaincodes: [], ledgerHeight: 2 },
          { channelId: 'ch2', chaincodes: [], ledgerHeight: 2 },
        ],
      }),
      'utf-8',
    );

    const results = await runValidation(tmpDir, ['ch1']);
    const checks = results.map((r) => r.check).join(' ');

    expect(checks).toContain('ch1');
    expect(checks).not.toContain('ch2');
  });

  it('fails rather than passes when the manifest lists no channel', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: '2026-01-01T00:00:00.000Z',
        mspId: 'Org1MSP',
        channels: [],
      }),
      'utf-8',
    );

    const results = await runValidation(tmpDir);

    expect(find(results, 'Channels').status).toBe('fail');
  });
});

// ── Block completeness: expected vs unexplained gaps ──

describe('block completeness gap classification', () => {
  const channel: ChannelInfo = {
    channelId: 'ch1',
    chaincodes: [],
    ledgerHeight: 6,
  };

  it('passes when every gap is listed in blocksWithoutMetadata', () => {
    writeManifest(channel);
    writeChannelMetadata('ch1', { blocksWithoutMetadata: [0, 1, 3] });
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2),
      metadataRecord(4),
      metadataRecord(5),
    ]);

    return runValidation(tmpDir).then((results) => {
      const result = find(results, 'Block completeness');
      expect(result.status).toBe('pass');
      expect(result.message).toContain('3 block(s) hold no metadata by design');
    });
  });

  it('fails on a gap the extractor did not account for', async () => {
    writeManifest(channel);
    writeChannelMetadata('ch1', { blocksWithoutMetadata: [0, 1] });
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2),
      metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      '2 unexplained missing blocks in range 0..5',
    );
    expect(result.details).toContain('[3, 4]');
    expect(result.details).toContain('re-run extract');
  });

  it('fails when gaps were never recorded', async () => {
    writeManifest(channel);
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2),
      metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('fail');
    expect(result.details).toContain(
      'does not record which blocks legitimately have no metadata',
    );
  });

  it('still treats blocks 0 and 1 as expected without any metadata file', async () => {
    writeManifest(channel);
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2),
      metadataRecord(3),
      metadataRecord(4),
      metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('warn');
    expect(result.message).toContain('genesis/config only');
  });

  it('fails when the walk stopped short of the ledger height', async () => {
    // The gap that matters most is the one at the end. Classifying only up to
    // the last block the extraction holds compares the extraction against
    // itself, so a run killed at block 2 of 6 looked complete in its own range
    // and the shortfall came back as a percentage at warn level — and validate
    // exits 0 on warnings, printing "Next steps: run replay".
    writeManifest(channel);
    writeChannelMetadata('ch1', { blocksWithoutMetadata: [0, 1] });
    writeRecords(layout.blockMetadataPath('ch1'), [metadataRecord(2)]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      '3 unexplained missing blocks in range 0..5',
    );
    expect(result.details).toContain('[3, 4, 5]');
  });

  it('fails on a short walk when gaps were never recorded', async () => {
    // Without blocksWithoutMetadata the extraction cannot account for the
    // missing tail. That uncertainty is a stop, not permission to replay.
    writeManifest(channel);
    writeRecords(layout.blockMetadataPath('ch1'), [metadataRecord(2)]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      '3 unexplained missing blocks in range 0..5',
    );
  });

  it('passes when the blocks after the last record are all accounted for', async () => {
    // A channel whose tail really is config blocks reads as short of the ledger
    // height and is complete. Failing this is how the check above stops being
    // trusted.
    writeManifest(channel);
    writeChannelMetadata('ch1', { blocksWithoutMetadata: [0, 1, 4, 5] });
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2),
      metadataRecord(3),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('4 block(s) hold no metadata by design');
  });

  it('passes an extraction that ran past the height discover recorded', async () => {
    // The ledger keeps growing between discover and extract, so walking further
    // than the manifest says is normal and must not read as a gap above the
    // recorded height.
    writeManifest({ channelId: 'ch1', chaincodes: [], ledgerHeight: 4 });
    writeChannelMetadata('ch1', { blocksWithoutMetadata: [0, 1] });
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2), metadataRecord(3), metadataRecord(4), metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Block completeness');
    expect(result.status).toBe('pass');
  });

  it('fails when metadata.json is missing', async () => {
    writeManifest(channel);
    writeRecords(layout.blockMetadataPath('ch1'), [
      metadataRecord(2), metadataRecord(3), metadataRecord(4), metadataRecord(5),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Channel metadata');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('incomplete');
  });

  it('reports an unparseable metadata.json instead of passing it', async () => {
    writeManifest(channel);
    const full = path.join(tmpDir, layout.channelMetadataPath('ch1'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '{ not json', 'utf-8');
    writeRecords(layout.blockMetadataPath('ch1'), [metadataRecord(2)]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Channel metadata');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('unparseable');
  });
});

// ── Tier-specific artifact completeness ──

describe('tier-specific history completeness', () => {
  const channel: ChannelInfo = {
    channelId: 'ch1',
    chaincodes: [{
      name: 'mycc', version: '1.0', sequence: 1,
      collections: [collection()],
    }],
    ledgerHeight: 3,
  };

  it('fails when Tier 3 public history is missing', async () => {
    writeManifest(channel, 'Org1MSP');
    writeChannelMetadata('ch1', {
      tier: MigrationTier.FullHistory,
      blocksWithoutMetadata: [0, 1],
      extractedByMspId: 'Org1MSP',
    });
    writeRecords(layout.blockMetadataPath('ch1'), [metadataRecord(2)]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'History completeness');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Tier 3');
    expect(result.message).toContain('public-history.ndjson');
  });

  it('fails when Tier 3 private history is missing for captured hashes', async () => {
    writeManifest(channel, 'Org1MSP');
    writeChannelMetadata('ch1', {
      tier: MigrationTier.FullHistory,
      blocksWithoutMetadata: [0, 1, 2],
      extractedByMspId: 'Org1MSP',
    });
    writeRecords(layout.blockMetadataPath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), []);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private history completeness');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Tier 3');
    expect(result.message).toContain('private history');
  });

  /** Another member's collection arrives as hashes only, so no history is owed. */
  it('expects no private history for a collection no extracting MSP is in', async () => {
    writeManifest(channel, 'Org3MSP');
    writeChannelMetadata('ch1', {
      tier: MigrationTier.FullHistory,
      blocksWithoutMetadata: [0, 1, 2],
      extractedByMspId: 'Org3MSP',
    });
    writeRecords(layout.blockMetadataPath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), []);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private history completeness');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('no extracting MSP');
  });

  /** A purged block's values are gone from every peer; a recent one's are not. */
  it('excuses only blocks past blockToLive', async () => {
    const purging: ChannelInfo = {
      ...channel,
      ledgerHeight: 100,
      chaincodes: [{
        name: 'mycc', version: '1.0', sequence: 1,
        collections: [collection({ blockToLive: 10 })],
      }],
    };
    writeManifest(purging, 'Org1MSP');
    writeChannelMetadata('ch1', {
      tier: MigrationTier.FullHistory,
      blocksWithoutMetadata: Array.from({ length: 100 }, (_, i) => i),
      extractedByMspId: 'Org1MSP',
    });
    writeRecords(layout.blockMetadataPath('ch1'), []);
    writeRecords(layout.publicHistoryPath('ch1'), []);
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 5, 'v1'),
      hashRecord('k2', 95, 'v2'),
    ]);
    writeRecords(layout.privateHistoryPath('ch1', 'mycc', 'col1'), [{
      _type: 'private_history', channel: 'ch1', chaincode: 'mycc',
      collection: 'col1', key: 'k2', value: 'v2', txId: 'tx95', txIndex: 0,
      blockNumber: 95, timestamp: '2026-01-01T00:00:00.000Z', isDelete: false,
    } as ExtractionRecord]);

    expect(find(await runValidation(tmpDir), 'Private history completeness').status)
      .toBe('pass');

    // The recent block missing from history is still a failure.
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 5, 'v1'),
      hashRecord('k2', 95, 'v2'),
      hashRecord('k3', 96, 'v3'),
    ]);
    const result = find(await runValidation(tmpDir), 'Private history completeness');
    expect(result.status).toBe('fail');
    expect(result.details).toContain('96');
    expect(result.details).not.toContain('5,');
  });

  it('keeps missing history as a skip for Tier 2', async () => {
    writeManifest(channel, 'Org1MSP');
    writeChannelMetadata('ch1', {
      tier: MigrationTier.StateWithAudit,
      blocksWithoutMetadata: [0, 1],
      extractedByMspId: 'Org1MSP',
    });
    writeRecords(layout.blockMetadataPath('ch1'), [metadataRecord(2)]);

    const results = await runValidation(tmpDir);
    expect(find(results, 'History completeness').status).toBe('skip');
  });
});

// ── Private value coverage classification ──

describe('private value coverage', () => {
  function channelWith(coll: CollectionConfig, height = 10): ChannelInfo {
    return {
      channelId: 'ch1',
      ledgerHeight: height,
      chaincodes: [
        { name: 'mycc', version: '1.0', sequence: 1, collections: [coll] },
      ],
    };
  }

  it('passes when every hashed key has an extracted value', async () => {
    writeManifest(channelWith(collection()), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
      hashRecord('k2', 3, 'v2'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateStateRecord('k1', 'v1'),
      privateStateRecord('k2', 'v2'),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.message).toContain('All 2 private keys');
  });

  it('fails when a value is missing with no explanation', async () => {
    writeManifest(channelWith(collection()), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
      hashRecord('k2', 3, 'v2'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateStateRecord('k1', 'v1'),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('fail');
    expect(result.message).toBe(
      '1/2 private keys have no value and no explanation',
    );
    expect(result.details).toContain('1 unexplained');
  });

  it('accounts for a key whose last hashed write was a delete', async () => {
    writeManifest(channelWith(collection()), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
      hashRecord('k1', 4),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.details).toContain('1 expected-deleted');
  });

  it('accounts for a key deleted according to private history', async () => {
    writeManifest(channelWith(collection()), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
      hashRecord('k1', 4, ''),
    ]);
    writeRecords(layout.privateHistoryPath('ch1', 'mycc', 'col1'), [
      {
        _type: 'private_history',
        channel: 'ch1',
        chaincode: 'mycc',
        collection: 'col1',
        key: 'k1',
        value: 'v1',
        txId: 'tx2',
        blockNumber: 2,
        txIndex: 0,
        timestamp: '',
        isDelete: false,
      },
      {
        _type: 'private_history',
        channel: 'ch1',
        chaincode: 'mycc',
        collection: 'col1',
        key: 'k1',
        value: '',
        txId: 'tx4',
        blockNumber: 4,
        txIndex: 0,
        timestamp: '',
        isDelete: true,
      },
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.details).toContain('1 expected-deleted');
  });

  it('accounts for a collection our MSP is not a member of', async () => {
    writeManifest(
      channelWith(collection({ policy: "OR('Org2MSP.member')" })),
      'Org1MSP',
    );
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.details).toContain('1 expected-unauthorized');
  });

  it('accounts for values aged out by blockToLive', async () => {
    writeManifest(channelWith(collection({ blockToLive: 5 }), 20), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('old', 2, 'v1'),
      hashRecord('new', 18, 'v2'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), [
      privateStateRecord('new', 'v2'),
    ]);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.details).toContain('1 expected-purged');
  });

  it('warns rather than fails when the extracting MSP is unknown', async () => {
    writeManifest(channelWith(collection({ policy: "OR('Org2MSP.member')" })));
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('warn');
    expect(result.details).toContain('re-run discover');
  });

  it('prefers the extracting MSP recorded on the channel over the manifest', async () => {
    writeManifest(
      channelWith(collection({ policy: "OR('Org1MSP.member')" })),
      'Org1MSP',
    );
    writeChannelMetadata('ch1', { extractedByMspId: 'Org3MSP' });
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('pass');
    expect(result.details).toContain('1 expected-unauthorized');
  });

  it('does not blame an unreadable collection policy', async () => {
    writeManifest(channelWith(collection({ policy: "OR('unknown')" })), 'Org1MSP');
    writeRecords(layout.privateHashesPath('ch1', 'mycc', 'col1'), [
      hashRecord('k1', 2, 'v1'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'mycc', 'col1'), []);

    const results = await runValidation(tmpDir);
    const result = find(results, 'Private value coverage');
    expect(result.status).toBe('fail');
    expect(result.details).toContain('1 unexplained');
  });
});

// ── Two chaincodes, one collection name ──

/**
 * Every chaincode on a 2.x channel has an `_implicit_org_<MSPID>` of the same
 * name, and applications share collection names too. Each pair's files are its
 * own, so each is cross-checked against its own hashes — one chaincode's values
 * hashed against another's would report every key as a mismatch.
 */
describe('collections sharing a name across chaincodes', () => {
  const channel: ChannelInfo = {
    channelId: 'ch1',
    ledgerHeight: 10,
    chaincodes: [
      { name: 'cc-a', version: '1.0', sequence: 1, collections: [collection()] },
      { name: 'cc-b', version: '1.0', sequence: 1, collections: [collection()] },
    ],
  };

  function writePair(chaincode: string, value: string): void {
    writeRecords(layout.privateHashesPath('ch1', chaincode, 'col1'), [
      hashRecord('k1', 2, value, chaincode),
    ]);
    writeRecords(layout.privateStatePath('ch1', chaincode, 'col1'), [
      privateStateRecord('k1', value, chaincode),
    ]);
  }

  it('cross-checks each chaincode against its own hashes', async () => {
    writeManifest(channel, 'Org1MSP');
    writePair('cc-a', 'value-a');
    writePair('cc-b', 'value-b');

    const results = await runValidation(tmpDir);
    const hashChecks = results.filter((r) =>
      r.check.startsWith('Private data hashes'),
    );

    expect(hashChecks.map((r) => [r.check, r.status])).toEqual([
      ['Private data hashes (ch1/cc-a/col1)', 'pass'],
      ['Private data hashes (ch1/cc-b/col1)', 'pass'],
    ]);
  });

  it('blames the chaincode whose value does not match its hash', async () => {
    writeManifest(channel, 'Org1MSP');
    writePair('cc-a', 'value-a');
    writeRecords(layout.privateHashesPath('ch1', 'cc-b', 'col1'), [
      hashRecord('k1', 2, 'value-b', 'cc-b'),
    ]);
    writeRecords(layout.privateStatePath('ch1', 'cc-b', 'col1'), [
      privateStateRecord('k1', 'tampered', 'cc-b'),
    ]);

    const results = await runValidation(tmpDir);

    expect(find(results, 'Private data hashes (ch1/cc-a/col1)').status)
      .toBe('pass');
    expect(find(results, 'Private data hashes (ch1/cc-b/col1)').status)
      .toBe('fail');
  });
});
