// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `extract --save-blocks` / `--blocks-only`: the raw-block archive.
 *
 * The contract these tests hold: the option is inert unless given (the extraction
 * output is the same files with the same contents), and when given the archive is
 * complete, byte-exact, durable ahead of the checkpoint, and never silently partial.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChannelInfo, ExtractOptions, Manifest, MigrationTier } from '../src/types';
import { BlockArchiveWriter, BlockSink, ArchivedBlock } from '../src/extraction/block-archive';
import { BlockArchiveExtractor } from '../src/extraction/strategies/block-archive-extractor';
import { BlockWalker } from '../src/extraction/strategies/block-walker';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';
import { HybridExtractor } from '../src/extraction/strategies/hybrid-extractor';
import { STATE_RECONSTRUCTION_COMPLETE } from '../src/extraction/state-completion';
import { identityPartPath, writeIdentityRegistry } from '../src/extraction/identity-parts';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { checkArchiveOptions, toExtractOptions } from '../src/cli/commands/extract';
import { ADMIN_CERT_PEM } from './helpers/test-certs';
import { encodeBlock, sealBlock } from './helpers/protobuf-block';

// ── ledger fixture: hash-linked blocks, served as protobuf like the other walker tests ──

function lenPrefix(tag: number, length: number): Buffer {
  if (length < 128) return Buffer.from([tag, length]);
  if (length < 256) return Buffer.from([tag, 0x81, length]);
  return Buffer.from([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}
function derInt(value: number): Buffer {
  if (value === 0) return Buffer.from([0x02, 0x01, 0x00]);
  const hex = value.toString(16);
  let bytes = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([lenPrefix(0x02, bytes.length), bytes]);
}
function derOctets(data: Buffer): Buffer {
  return Buffer.concat([lenPrefix(0x04, data.length), data]);
}
function headerHash(n: number, prev: string, data: string): string {
  const parts = [derInt(n), derOctets(prev ? Buffer.from(prev, 'hex') : Buffer.alloc(0)), derOctets(Buffer.from(data, 'hex'))];
  const len = parts.reduce((s, b) => s + b.length, 0);
  return crypto.createHash('sha256').update(Buffer.concat([lenPrefix(0x30, len), ...parts])).digest('hex');
}

function makeBlock(n: number, previousHash: string): any {
  const dataHash = crypto.createHash('sha256').update(`data-${n}`).digest('hex');
  const hasTx = n > 0;
  return {
    header: { number: String(n), previous_hash: previousHash, data_hash: dataHash },
    data: {
      data: hasTx ? [{
        payload: {
          header: {
            channel_header: { tx_id: `tx-${n}`, timestamp: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}Z` },
            signature_header: { creator: { mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM } },
          },
          data: {
            actions: [{
              payload: {
                chaincode_proposal_payload: { input: { chaincode_spec: { chaincode_id: { name: 'mycc' } } } },
                action: {
                  proposal_response_payload: {
                    extension: {
                      results: {
                        ns_rwset: [{
                          namespace: 'mycc',
                          rwset: { writes: [{ key: `k${n}`, value: `v${n}`, is_delete: false }] },
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
    metadata: { metadata: [[], [], hasTx ? [0] : []] },
  };
}

function ledger(height: number): any[] {
  const blocks: any[] = [];
  let prev = '';
  for (let i = 0; i < height; i++) {
    const b = sealBlock(makeBlock(i, prev));
    blocks.push(b);
    prev = headerHash(i, b.header.previous_hash, b.header.data_hash);
  }
  return blocks;
}

const bytesOf = (block: any): Buffer => encodeBlock(block);

function network(blocks: any[]): any {
  const contract = {
    evaluateTransaction: jest.fn(async (_fn: string, _ch: string, num: string) => {
      const b = blocks[parseInt(num, 10)];
      if (!b) throw new Error(`Block ${num} not found`);
      return bytesOf(b);
    }),
    submitTransaction: jest.fn(),
  };
  return { getContract: jest.fn(() => contract) };
}

function channel(height: number, id = 'ch1'): ChannelInfo {
  return { channelId: id, ledgerHeight: height, chaincodes: [{ name: 'mycc', version: '1.0', sequence: 1, collections: [] }] };
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'block-archive-test-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

describe('BlockArchiveWriter', () => {
  const blk = (n: number, bytes = `block-${n}`): ArchivedBlock => ({
    channelId: 'ch1', blockNumber: n, bytes: Buffer.from(bytes), previousHash: '', dataHash: '',
  });

  it('writes each block byte-exact under <channel>/blocks, owner-only', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    w.write(blk(0, 'AAA'));
    w.write(blk(1, 'BBB'));
    const f = path.join(tmp, 'arch/ch1/blocks/1.block');
    expect(fs.readFileSync(f, 'utf-8')).toBe('BBB');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(tmp, 'arch/ch1/blocks')).mode & 0o777).toBe(0o700);
    expect(listFiles(path.join(tmp, 'arch'))).toEqual(['ch1/blocks/0.block', 'ch1/blocks/1.block']);
  });

  it('leaves no temporary file behind', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    for (let i = 0; i < 5; i++) w.write(blk(i));
    expect(listFiles(path.join(tmp, 'arch')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('accepts the same block again and refuses a different one in its place', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    w.write(blk(0, 'AAA'));
    expect(() => w.write(blk(0, 'AAA'))).not.toThrow();
    expect(() => w.write(blk(0, 'ZZZ'))).toThrow(/Archive conflict/);
    expect(fs.readFileSync(path.join(tmp, 'arch/ch1/blocks/0.block'), 'utf-8')).toBe('AAA');
  });

  it('counts contiguous blocks from zero and stops at the first gap', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    expect(w.contiguousBlocks('ch1')).toBe(0);
    [0, 1, 2, 4].forEach((n) => w.write(blk(n)));
    expect(w.contiguousBlocks('ch1')).toBe(3);
  });

  it('refuses a channel name that is not a Fabric channel name', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    expect(() => w.write({ ...blk(0), channelId: '../escape' })).toThrow(/not a valid Fabric channel name/);
  });

  it('refuses to seal an incomplete archive and writes no manifest', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    [0, 1, 3].forEach((n) => w.write(blk(n)));
    expect(() => w.finalize('ch1', 4)).toThrow(/incomplete/);
    expect(fs.existsSync(path.join(tmp, 'arch/ch1/manifest.json'))).toBe(false);
  });

  it('refuses to seal an archive longer than the ledger height it was told', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'));
    [0, 1, 2].forEach((n) => w.write(blk(n)));
    expect(() => w.finalize('ch1', 2)).toThrow(/longer chain/);
  });

  it('seals with a sha256sum-compatible digest list and a manifest that names it', () => {
    const w = new BlockArchiveWriter(path.join(tmp, 'arch'), { networkId: 'n-1', memberId: 'm-1' });
    [0, 1, 2].forEach((n) => w.write(blk(n, `payload-${n}`)));
    const m = w.finalize('ch1', 3);

    const digestBody = fs.readFileSync(path.join(tmp, 'arch/ch1/blocks/blocks.sha256'), 'utf-8');
    const expected = [0, 1, 2]
      .map((n) => `${crypto.createHash('sha256').update(`payload-${n}`).digest('hex')}  ${n}.block`)
      .join('\n') + '\n';
    expect(digestBody).toBe(expected);

    expect(m).toMatchObject({
      schema: 1, kind: 'fabric-block-archive', channel: 'ch1', firstBlock: 0, lastBlock: 2,
      blockCount: 3, ledgerHeight: 3, complete: true, source: { networkId: 'n-1', memberId: 'm-1' },
    });
    expect(m.digestFileSha256).toBe(crypto.createHash('sha256').update(digestBody).digest('hex'));
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'arch/ch1/manifest.json'), 'utf-8'))).toEqual(m);
    expect(typeof m.extractor.version).toBe('string');
  });

  it('removes a sealed manifest as soon as the archive is written to again', () => {
    const root = path.join(tmp, 'arch');
    const w1 = new BlockArchiveWriter(root);
    [0, 1].forEach((n) => w1.write(blk(n)));
    w1.finalize('ch1', 2);
    expect(fs.existsSync(path.join(root, 'ch1/manifest.json'))).toBe(true);

    const w2 = new BlockArchiveWriter(root); // a later run extending the chain
    w2.write(blk(2));
    expect(fs.existsSync(path.join(root, 'ch1/manifest.json'))).toBe(false);
  });

  it('flushes (fsync) the blocks it wrote and nothing twice', () => {
    let fsyncs = 0;
    let Writer: typeof BlockArchiveWriter | undefined;
    jest.isolateModules(() => {
      jest.doMock('fs', () => {
        const actual = jest.requireActual('fs');
        return { ...actual, fsyncSync: (fd: number) => { fsyncs++; return actual.fsyncSync(fd); } };
      });
      Writer = require('../src/extraction/block-archive').BlockArchiveWriter;
    });
    const w = new Writer!(path.join(tmp, 'arch'));
    w.write(blk(0));
    w.write(blk(1));
    expect(fsyncs).toBe(0); // writing alone makes nothing durable
    w.flush('ch1');
    const afterFirst = fsyncs;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    w.flush('ch1');
    expect(fsyncs).toBe(afterFirst);
    jest.dontMock('fs');
  });
});

describe('BlockWalker with a block sink', () => {
  function walkerFor(blocks: any[], sink?: BlockSink, extra: Record<string, unknown> = {}) {
    const out = path.join(tmp, 'out');
    const cpDir = path.join(tmp, 'cp');
    fs.mkdirSync(out, { recursive: true });
    const writer = new NdjsonWriter(out);
    jest.spyOn(writer, 'writeBatch').mockImplementation(async () => {});
    jest.spyOn(writer, 'write').mockImplementation(async () => {});
    jest.spyOn(writer, 'syncAll').mockImplementation(() => {});
    const cp = new CheckpointManager(cpDir);
    const walker = new BlockWalker(network(blocks), writer, new FileLayoutManager(out), cp, MigrationTier.FullHistory, {
      prefetchBuffer: 0, durabilityInterval: 0, ...(sink && { blockSink: sink }), ...extra,
    });
    return { walker, cp, writer };
  }

  it('hands every block to the sink, in order, with the bytes the peer delivered and its header hashes', async () => {
    const blocks = ledger(5);
    const seen: ArchivedBlock[] = [];
    const sink: BlockSink = { write: (b) => { seen.push(b); }, flush: jest.fn(), contiguousBlocks: () => 0, holds: () => true };
    const { walker } = walkerFor(blocks, sink);
    await walker.walk(channel(5));
    expect(seen.map((b) => b.blockNumber)).toEqual([0, 1, 2, 3, 4]);
    seen.forEach((b, i) => {
      expect(Buffer.from(b.bytes).equals(bytesOf(blocks[i]))).toBe(true);
      expect(b.channelId).toBe('ch1');
      expect(b.dataHash).toBe(blocks[i].header.data_hash);
      expect(b.previousHash).toBe(blocks[i].header.previous_hash);
    });
  });

  it('flushes the sink before it writes the checkpoint', async () => {
    const order: string[] = [];
    const sink: BlockSink = { write: () => {}, flush: () => { order.push('sink'); }, contiguousBlocks: () => 0, holds: () => true };
    const { walker, cp } = walkerFor(ledger(3), sink);
    jest.spyOn(cp, 'flush').mockImplementation(() => { order.push('checkpoint'); });
    await walker.walk(channel(3));
    expect(order).toEqual(['sink', 'checkpoint']);
  });

  it('does not advance past a block the sink refused', async () => {
    const sink: BlockSink = {
      write: (b) => { if (b.blockNumber === 2) throw new Error('disk full'); },
      flush: jest.fn(), contiguousBlocks: () => 0, holds: () => true,
    };
    const { walker, cp } = walkerFor(ledger(5), sink);
    await expect(walker.walk(channel(5))).rejects.toThrow(/block 2/);
    expect(cp.getLastBlockNumber('ch1', 'block-walk')).toBe(1);
  });

  it('refuses to resume over blocks the archive never received', async () => {
    const { walker, cp } = walkerFor(ledger(6), {
      write: jest.fn(), flush: jest.fn(), contiguousBlocks: () => 2, holds: () => true,
    });
    cp.updateBlock('ch1', 'block-walk', 3); // an earlier run walked 0..3 without --save-blocks
    await expect(walker.walk(channel(6))).rejects.toThrow(/holds only 2 of them.*--blocks-only/s);
  });

  it('refuses even when the walk is already complete, so a fully-walked run cannot gain an empty archive', async () => {
    const { walker, cp } = walkerFor(ledger(4), { write: jest.fn(), flush: jest.fn(), contiguousBlocks: () => 0, holds: () => true });
    cp.updateBlock('ch1', 'block-walk', 3);
    await expect(walker.walk(channel(4))).rejects.toThrow(/walked without --save-blocks/);
  });

  it('needs a sink for a blocks-only walk', () => {
    expect(() => walkerFor(ledger(2), undefined, { blocksOnly: true })).toThrow(/needs a block sink/);
  });

  it('derives nothing from the blocks in a blocks-only walk', async () => {
    const sink: BlockSink = { write: jest.fn(), flush: jest.fn(), contiguousBlocks: () => 0, holds: () => true };
    const { walker, writer } = walkerFor(ledger(4), sink, { blocksOnly: true });
    await walker.walk(channel(4));
    expect(sink.write).toHaveBeenCalledTimes(4);
    expect(writer.writeBatch).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('is unchanged without a sink: no archive code is reached', async () => {
    const { walker } = walkerFor(ledger(4));
    const report = await walker.walk(channel(4));
    expect(report.hashChainValid).toBe(true);
    expect(report.blocksVerified).toBe(4);
  });
});

describe('extract with --save-blocks', () => {
  const baseOptions = (outputDir: string, overrides: Partial<ExtractOptions> = {}): ExtractOptions => ({
    manifest: path.join(tmp, 'manifest.json'), nodeId: 'nd-TEST', tier: MigrationTier.FullHistory,
    channels: ['ch1'], outputDir, batchSize: 100, strategy: 'block-reconstruction', concurrency: 1,
    stateBackend: 'memory', memoryLimitMb: 512, prefetchBuffer: 0, ...overrides,
  });
  const manifestFor = (ch: ChannelInfo): Manifest => ({
    networkId: 'n-TEST', memberId: 'm-TEST', region: 'us-east-1', stateDb: 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z', channels: [ch],
  });
  const gateway = (blocks: any[]): any => ({ getNetwork: jest.fn(() => network(blocks)) });

  /** Every output file with its bytes, except the fields that record when the run happened. */
  function snapshot(dir: string): Record<string, string> {
    const snap: Record<string, string> = {};
    for (const rel of listFiles(dir)) {
      let body = fs.readFileSync(path.join(dir, rel), 'utf-8');
      body = body.replace(/"(extractedAt|updatedAt)": "[^"]*"/g, '"$1": "*"');
      snap[rel] = body;
    }
    return snap;
  }

  it('produces the same extraction output with and without the option, plus the archive', async () => {
    const blocks = ledger(8);
    const ch = channel(8);

    const plainDir = path.join(tmp, 'plain');
    await new HybridExtractor(baseOptions(plainDir), manifestFor(ch), gateway(blocks), 'Org1MSP').run([ch]);

    const archDir = path.join(tmp, 'with-archive');
    const root = path.join(tmp, 'archive');
    await new HybridExtractor(baseOptions(archDir, { saveBlocksDir: root }), manifestFor(ch), gateway(blocks), 'Org1MSP').run([ch]);

    expect(snapshot(archDir)).toEqual(snapshot(plainDir));
    expect(Object.keys(snapshot(plainDir)).length).toBeGreaterThan(3);

    // and the archive is there, complete and byte-exact
    const dir = path.join(root, 'ch1/blocks');
    for (let i = 0; i < 8; i++) expect(fs.readFileSync(path.join(dir, `${i}.block`)).equals(bytesOf(blocks[i]))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ch1/manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({ blockCount: 8, complete: true, source: { networkId: 'n-TEST', memberId: 'm-TEST', mspId: 'Org1MSP' } });
  });

  it('writes no archive at all when the option is absent and marks state complete after close', async () => {
    const ch = channel(4);
    const out = path.join(tmp, 'plain');
    await new HybridExtractor(baseOptions(out), manifestFor(ch), gateway(ledger(4)), 'Org1MSP').run([ch]);
    expect(listFiles(tmp).filter((f) => f.endsWith('.block'))).toEqual([]);
    expect(fs.existsSync(path.join(
      out,
      new FileLayoutManager(out).checkpointDir(ch.channelId),
      STATE_RECONSTRUCTION_COMPLETE,
    ))).toBe(true);
  });

  it('rebuilds metadata and shared identities when a completion marker is missing', async () => {
    const ch = channel(4);
    const out = path.join(tmp, 'recover');
    const run = () => new HybridExtractor(
      baseOptions(out),
      manifestFor(ch),
      gateway(ledger(4)),
      'Org1MSP',
    ).run([ch]);

    await run();
    const layout = new FileLayoutManager(out);
    const marker = path.join(
      out,
      layout.checkpointDir(ch.channelId),
      STATE_RECONSTRUCTION_COMPLETE,
    );
    const metadata = path.join(out, layout.channelMetadataPath(ch.channelId));
    const identities = path.join(out, layout.identitiesPath);
    const before = JSON.parse(fs.readFileSync(metadata, 'utf8')).outputFiles;
    const identityLines = fs.readFileSync(identities, 'utf8').trim().split('\n').length;

    // A run that died before its commit wrote neither metadata nor marker.
    fs.rmSync(marker);
    fs.rmSync(metadata);
    await run();

    expect(JSON.parse(fs.readFileSync(metadata, 'utf8')).outputFiles).toEqual(before);
    expect(fs.readFileSync(identities, 'utf8').trim().split('\n')).toHaveLength(identityLines);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('refuses, changing nothing, a completed-looking channel that has metadata but no completion marker', async () => {
    const ch = channel(4);
    const out = path.join(tmp, 'unmarked');
    const run = () => new HybridExtractor(baseOptions(out), manifestFor(ch), gateway(ledger(4)), 'Org1MSP').run([ch]);
    await run();
    fs.rmSync(path.join(out, new FileLayoutManager(out).checkpointDir(ch.channelId), STATE_RECONSTRUCTION_COMPLETE));
    const before = snapshot(out);

    await expect(run()).rejects.toThrow(/completed-looking extraction of ch1 .*no completion marker.*Nothing was changed/s);
    expect(snapshot(out)).toEqual(before);
  });

  describe('one process, several channels: each channel commits on its own', () => {
    const a = channel(4, 'cha'), b = channel(6, 'chb');
    const both = { ...manifestFor(a), channels: [a, b] };
    /** Serves `cha` and `chb`; `failing` serves that channel a corrupt block 2, so its walk fails part-way. */
    const twoChannels = (failing?: string, calls: string[] = []): any => ({
      getNetwork: jest.fn((id: string) => {
        calls.push(id);
        const n = network(ledger(id === 'cha' ? 4 : 6));
        if (id !== failing) return n;
        const contract = n.getContract();
        const serve = contract.evaluateTransaction;
        contract.evaluateTransaction = jest.fn(async (fn: string, ch: string, num: string) =>
          (num === '2' ? Buffer.from('corrupt block') : serve(fn, ch, num)));
        return n;
      }),
    });
    const extractAll = (out: string, gw: any, channels: ChannelInfo[] = [a, b], o: Partial<ExtractOptions> = {}): Promise<void> =>
      new HybridExtractor(baseOptions(out, { channels: channels.map((c) => c.channelId), ...o }), both, gw, 'Org1MSP').run(channels);

    it('a re-run after one channel failed keeps the channel that finished and matches a clean run', async () => {
      const clean = path.join(tmp, 'clean');
      await extractAll(clean, twoChannels());

      const out = path.join(tmp, 'failed-once');
      await expect(extractAll(out, twoChannels('chb'))).rejects.toThrow();
      const layout = new FileLayoutManager(out);
      expect(fs.existsSync(path.join(out, layout.checkpointDir('cha'), STATE_RECONSTRUCTION_COMPLETE))).toBe(true);
      expect(fs.existsSync(path.join(out, layout.checkpointDir('chb'), STATE_RECONSTRUCTION_COMPLETE))).toBe(false);
      const committed = snapshot(path.join(out, layout.channelDir('cha')));

      const calls: string[] = [];
      await extractAll(out, twoChannels(undefined, calls));
      expect(calls).toEqual(['chb']); // the committed channel is not read again
      expect(snapshot(path.join(out, layout.channelDir('cha')))).toEqual(committed);
      expect(snapshot(out)).toEqual(snapshot(clean));
    });

    it('the same with --concurrency 2, where the other channel carries on after the failure', async () => {
      const clean = path.join(tmp, 'clean-par');
      await extractAll(clean, twoChannels(), [a, b], { concurrency: 2 });
      const out = path.join(tmp, 'failed-par');
      await expect(extractAll(out, twoChannels('cha'), [a, b], { concurrency: 2 })).rejects.toThrow(/cha/);
      const calls: string[] = [];
      await extractAll(out, twoChannels(undefined, calls), [a, b], { concurrency: 2 });
      expect(calls).toEqual(['cha']);
      expect(snapshot(out)).toEqual(snapshot(clean));
    });

    it('a re-run of a completed extraction reads nothing from the peer and changes nothing', async () => {
      const out = path.join(tmp, 'twice');
      await extractAll(out, twoChannels());
      const before = snapshot(out);
      const calls: string[] = [];
      await extractAll(out, twoChannels(undefined, calls));
      expect(calls).toEqual([]);
      expect(snapshot(out)).toEqual(before);
    });

    it('channels extracted by separate --channels runs into one directory match one run of both', async () => {
      const clean = path.join(tmp, 'clean-seq');
      await extractAll(clean, twoChannels());
      const out = path.join(tmp, 'sequential');
      await extractAll(out, twoChannels(), [a]);
      await extractAll(out, twoChannels(), [b]);
      expect(snapshot(out)).toEqual(snapshot(clean));
    });
  });

  describe('as --processes children sharing one output directory', () => {
    const a = channel(4, 'cha'), b = channel(4, 'chb');
    const child = (out: string, ch: ChannelInfo): Promise<void> => new HybridExtractor(
      baseOptions(out, { channels: [ch.channelId], identitiesOut: identityPartPath(new FileLayoutManager(out), ch.channelId) }),
      { ...manifestFor(a), channels: [a, b] },
      gateway(ledger(4)),
      'Org1MSP',
    ).run([ch]);

    it('a child that starts after a sibling completed extracts its channel, and the parts make the registry', async () => {
      const out = path.join(tmp, 'children');
      await child(out, a);
      await child(out, b);
      const layout = new FileLayoutManager(out);
      for (const ch of [a, b]) {
        expect(fs.existsSync(path.join(out, layout.checkpointDir(ch.channelId), STATE_RECONSTRUCTION_COMPLETE))).toBe(true);
      }
      expect(fs.existsSync(path.join(out, layout.identitiesPath))).toBe(false);
      writeIdentityRegistry(out, layout.identitiesPath);

      const single = path.join(tmp, 'single');
      await new HybridExtractor(
        baseOptions(single, { channels: [a.channelId, b.channelId] }),
        { ...manifestFor(a), channels: [a, b] },
        gateway(ledger(4)),
        'Org1MSP',
      ).run([a, b]);
      expect(fs.readFileSync(path.join(out, layout.identitiesPath), 'utf8'))
        .toBe(fs.readFileSync(path.join(single, layout.identitiesPath), 'utf8'));
    });

    it('a re-run resumes the failed child and leaves the completed sibling alone', async () => {
      const out = path.join(tmp, 'children-resume');
      await child(out, a);
      await child(out, b);
      const layout = new FileLayoutManager(out);
      const completed = snapshot(path.join(out, layout.channelDir(a.channelId)));
      const part = path.join(out, identityPartPath(layout, b.channelId));
      const expectedPart = fs.readFileSync(part, 'utf8');
      // chb's child died before its commit: no metadata or marker, and a partial identity part.
      fs.rmSync(path.join(out, layout.checkpointDir(b.channelId), STATE_RECONSTRUCTION_COMPLETE));
      fs.rmSync(path.join(out, layout.channelMetadataPath(b.channelId)));
      fs.appendFileSync(part, expectedPart);

      await child(out, a);
      await child(out, b);

      expect(snapshot(path.join(out, layout.channelDir(a.channelId)))).toEqual(completed);
      expect(fs.readFileSync(part, 'utf8')).toBe(expectedPart);
      expect(fs.existsSync(path.join(out, layout.checkpointDir(b.channelId), STATE_RECONSTRUCTION_COMPLETE))).toBe(true);
    });
  });

  it('resumes into an archive that is ahead of the checkpoint without a gap or a conflict', async () => {
    const blocks = ledger(10);
    const root = path.join(tmp, 'archive');
    // A first run dies after writing blocks 0..5 to the archive (no checkpoint reached disk).
    const first = new BlockArchiveWriter(root);
    for (let i = 0; i <= 5; i++) first.write({ channelId: 'ch1', blockNumber: i, bytes: bytesOf(blocks[i]), previousHash: '', dataHash: '' });

    const ch = channel(10);
    await new HybridExtractor(baseOptions(path.join(tmp, 'out'), { saveBlocksDir: root }), manifestFor(ch), gateway(blocks), 'Org1MSP').run([ch]);
    expect(new BlockArchiveWriter(root).contiguousBlocks('ch1')).toBe(10);
    expect(fs.existsSync(path.join(root, 'ch1/manifest.json'))).toBe(true);
  });

  it('refuses to add an archive to a checkpoint that already passed blocks it never saw', async () => {
    const blocks = ledger(6);
    const ch = channel(6);
    const out = path.join(tmp, 'out');
    // A finished extraction without --save-blocks...
    await new HybridExtractor(baseOptions(out), manifestFor(ch), gateway(blocks), 'Org1MSP').run([ch]);
    // ...then the same output directory asked for an archive.
    await expect(
      new HybridExtractor(baseOptions(out, { saveBlocksDir: path.join(tmp, 'archive') }), manifestFor(ch), gateway(blocks), 'Org1MSP').run([ch]),
    ).rejects.toThrow(/walked without --save-blocks/);
  });
});

describe('extract --blocks-only', () => {
  it('writes the archive and none of the extraction output', async () => {
    const blocks = ledger(7);
    const root = path.join(tmp, 'archive');
    const writer = new BlockArchiveWriter(root, { networkId: 'n-TEST' });
    await new BlockArchiveExtractor(network(blocks), writer, { prefetchBuffer: 2 }).extract(channel(7));

    expect(listFiles(tmp).filter((f) => !f.startsWith('archive/'))).toEqual([]);
    expect(writer.contiguousBlocks('ch1')).toBe(7);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ch1/manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({ blockCount: 7, lastBlock: 6, complete: true });
    // sha256sum -c semantics: every listed digest matches its file
    const lines = fs.readFileSync(path.join(root, 'ch1/blocks/blocks.sha256'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      const [digest, name] = line.split('  ');
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'ch1/blocks', name))).digest('hex')).toBe(digest);
    }
  });

  it('continues from the first missing block and fetches only what the archive lacks', async () => {
    const blocks = ledger(9);
    const root = path.join(tmp, 'archive');
    const seed = new BlockArchiveWriter(root);
    for (let i = 0; i < 4; i++) seed.write({ channelId: 'ch1', blockNumber: i, bytes: bytesOf(blocks[i]), previousHash: '', dataHash: '' });

    const net = network(blocks);
    await new BlockArchiveExtractor(net, new BlockArchiveWriter(root)).extract(channel(9));
    const contract = net.getContract();
    const fetched = (contract.evaluateTransaction as jest.Mock).mock.calls.map((c) => Number(c[2])).sort((a, b) => a - b);
    // block 3 once, to prove the archive is this chain; then 4..8, and nothing already archived beyond that
    expect(fetched).toEqual([3, 4, 5, 6, 7, 8]);
    expect(new BlockArchiveWriter(root).contiguousBlocks('ch1')).toBe(9);
  });

  it('does not seal an archive whose hash chain is broken', async () => {
    const blocks = ledger(6);
    blocks[3].header.previous_hash = crypto.createHash('sha256').update('wrong').digest('hex');
    const root = path.join(tmp, 'archive');
    await expect(new BlockArchiveExtractor(network(blocks), new BlockArchiveWriter(root)).extract(channel(6))).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'ch1/manifest.json'))).toBe(false);
  });

  it('refuses a directory that already holds a different chain, even when it is complete', async () => {
    const root = path.join(tmp, 'archive');
    await new BlockArchiveExtractor(network(ledger(3)), new BlockArchiveWriter(root, { networkId: 'n-A' })).extract(channel(3));
    // Block 2 of another network: a different but self-consistent block under the same number
    const other = ledger(3).map((b, i) => (i === 2 ? sealBlock({ ...b, header: { ...b.header }, data: { data: [] }, metadata: { metadata: [[], [], []] } }) : b));
    await expect(
      new BlockArchiveExtractor(network(other), new BlockArchiveWriter(root, { networkId: 'n-B' })).extract(channel(3)),
    ).rejects.toThrow(/differs from the block the peer serves/);
    // the sealed manifest of the first network was not re-labelled
    expect(JSON.parse(fs.readFileSync(path.join(root, 'ch1/manifest.json'), 'utf-8')).source.networkId).toBe('n-A');
  });

  it('refuses to extend an archive with blocks of another chain', async () => {
    const root = path.join(tmp, 'archive');
    const first = ledger(4);
    const seed = new BlockArchiveWriter(root);
    for (let i = 0; i < 3; i++) seed.write({ channelId: 'ch1', blockNumber: i, bytes: bytesOf(first[i]), previousHash: '', dataHash: '' });
    const other = ledger(6).map((b, i) => (i === 2 ? sealBlock({ ...b, data: { data: [] }, metadata: { metadata: [[], [], []] } }) : b));
    await expect(
      new BlockArchiveExtractor(network(other), new BlockArchiveWriter(root)).extract(channel(6)),
    ).rejects.toThrow(/differs from the block the peer serves/);
  });
});

describe('command-line options', () => {
  const base = { manifest: 'm.json', tier: 1, outputDir: 'o', batchSize: 100, strategy: 'auto', concurrency: 1, stateBackend: 'auto', memoryLimit: 512, prefetchBuffer: 8 };

  it('are absent from the options when not given', () => {
    const o = toExtractOptions(base);
    expect(o.saveBlocksDir).toBeUndefined();
    expect(o.blocksOnly).toBeUndefined();
  });

  it('carry --save-blocks and --blocks-only', () => {
    const o = toExtractOptions({ ...base, saveBlocks: '/arch', blocksOnly: true });
    expect(o.saveBlocksDir).toBe('/arch');
    expect(o.blocksOnly).toBe(true);
  });

  it('accept a save-blocks run, with or without blocks-only', () => {
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, saveBlocks: '/a' }))).not.toThrow();
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, saveBlocks: '/a', blocksOnly: true }))).not.toThrow();
    expect(() => checkArchiveOptions(toExtractOptions(base))).not.toThrow();
  });

  it('carry --extend, and refuse it with --blocks-only', () => {
    expect(toExtractOptions({ ...base, extend: true }).extend).toBe(true);
    expect(toExtractOptions(base).extend).toBeUndefined();
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, extend: true, saveBlocks: '/a' }))).not.toThrow();
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, extend: true, saveBlocks: '/a', blocksOnly: true })))
      .toThrow(/--extend cannot be combined with --blocks-only/);
  });

  it('refuse --blocks-only without a directory', () => {
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, blocksOnly: true }))).toThrow(/needs --save-blocks/);
  });

  it('refuse --save-blocks with --private-only', () => {
    expect(() => checkArchiveOptions(toExtractOptions({ ...base, saveBlocks: '/a', privateOnly: true }))).toThrow(/--private-only/);
  });
});
