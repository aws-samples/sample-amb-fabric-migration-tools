/**
 * `run` and `compare` against an in-process orderer: the happy path and each refusal, with the exit code it must carry.
 * Needs `configtxlator` on PATH (it reads the destination's genesis config); skipped without it.
 */
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { common, msp } from '@hyperledger/fabric-protos';
import { Archive } from '../src/archive/reader';
import { loadDescriptor } from '../src/descriptor';
import { openDestination } from '../src/destination';
import { run } from '../src/run/run';
import { compare } from '../src/compare/compare';
import { decodeBlock, headerHash } from '../src/fabric/blocks';
import { Exit } from '../src/util/errors';
import { FakeChain, FakeOrderer, FakeOpts, serverCert } from './fake-orderer';
import { envelope, makePki, writeArchive } from './helpers';

const hasCtl = ((): boolean => { try { execFileSync('configtxlator', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
const d = hasCtl ? describe : describe.skip;

const GENESIS = fs.readFileSync(path.join(__dirname, 'fixtures/genesis-s14k.block'));
const CH = 's14k';

/** Real genesis (one org, SrcA) followed by `sizes.length` transaction blocks of those sizes, hash-linked. */
function archiveBlocks(sizes: number[]): Buffer[] {
  const out = [GENESIS];
  sizes.forEach((k, i) => {
    const n = i + 1;
    const prev = decodeBlock(out[n - 1]);
    const envs = Array.from({ length: k }, (_, j) => envelope(CH, `tx-${n}-${j}-${crypto.randomBytes(4).toString('hex')}`));
    const hdr = new common.BlockHeader();
    hdr.setNumber(n);
    hdr.setPreviousHash(Buffer.from(headerHash(n - 1, Buffer.from(prev.previousHash, 'hex'), Buffer.from(prev.dataHash, 'hex')), 'hex'));
    hdr.setDataHash(crypto.createHash('sha256').update(Buffer.concat(envs)).digest());
    const bd = new common.BlockData(); bd.setDataList(envs);
    const md = new common.BlockMetadata(); md.setMetadataList([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(k), Buffer.alloc(0)]);
    const b = new common.Block(); b.setHeader(hdr); b.setData(bd); b.setMetadata(md);
    out.push(Buffer.from(b.serializeBinary()));
  });
  return out;
}

d('run against an in-process orderer', () => {
  const pki = makePki();
  const srv = serverCert(pki.dir);
  let fake: FakeOrderer;
  let work: string;
  afterAll(() => pki.cleanup());
  afterEach(() => { fake?.stop(); fs.rmSync(work, { recursive: true, force: true }); });

  async function setup(blocks: Buffer[], opts: ConstructorParameters<typeof FakeOrderer>[1] = {}, prefill = 0) {
    work = fs.mkdtempSync(path.join(pki.dir, 'w-'));
    writeArchive(path.join(work, 'archive'), CH, blocks);
    fake = new FakeOrderer(GENESIS, opts);
    for (let n = 1; n <= prefill; n++) fake.cut(decodeBlock(blocks[n]).txs.map((t) => t.envelope));
    await fake.start({ ...srv, caCert: pki.caCert });
    const r = (f: string): string => path.relative(work, f);
    const desc = {
      schema: 1, profile: 'self-managed',
      orderer: { mode: 'timeout', batchTimeout: '50ms', endpoints: [{ address: `localhost:${fake.port}`, tlsCa: r(pki.caCert) }], reader: { msp: 'Ord', cert: r(pki.cert), key: r(pki.key) } },
      orgs: { SrcA: { signer: { mode: 'local', cert: r(pki.cert), key: r(pki.key) }, rootCa: r(pki.caCert), tlsRootCa: r(pki.caCert) } },
    };
    fs.writeFileSync(path.join(work, 'dest.json'), JSON.stringify(desc));
    const ld = loadDescriptor(path.join(work, 'dest.json'));
    return { archive: new Archive(path.join(work, 'archive'), CH), dst: openDestination(ld, CH) };
  }
  const code = async (p: Promise<unknown>): Promise<number> => p.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const log = (): void => undefined;

  it('sends every block, checks each on arrival, and compare agrees', async () => {
    const blocks = archiveBlocks([3, 1, 7, 2, 5]);
    const { archive, dst } = await setup(blocks);
    try {
      const s = await run(archive, dst, { log });
      expect(s).toMatchObject({ startHeight: 1, endHeight: 6, txBlocks: 5, blocksSent: 5 });
      expect(fake.blocks.slice(1).map((b) => decodeBlock(b).dataHash)).toEqual(blocks.slice(1).map((b) => decodeBlock(b).dataHash));
      const c = await compare(archive, dst, 'orderer', log);
      expect(c).toMatchObject({ compared: 6, txBlocks: 5, configBlocks: 1, differ: [] });
      const state = JSON.parse(fs.readFileSync(path.join(work, 'state', `${CH}.json`), 'utf8'));
      expect(state).toMatchObject({
        lastAligned: 5,
        lastDataHash: decodeBlock(blocks[5]).dataHash,
        lastSourceDataHash: decodeBlock(blocks[5]).dataHash,
      });
      expect(fs.readFileSync(path.join(work, 'report', `${CH}.ndjson`), 'utf8').trim().split('\n')).toHaveLength(5);
    } finally { dst.close(); }
  });

  it('stops with exit 6 when the destination splits a block', async () => {
    const { archive, dst } = await setup(archiveBlocks([2, 6, 2]), { maxCount: 4 });
    try { expect(await code(run(archive, dst, { log }))).toBe(Exit.Mismatch); } finally { dst.close(); }
  });

  it('stops with exit 3 when an envelope is refused, naming nothing sent after it', async () => {
    const { archive, dst } = await setup(archiveBlocks([2, 2, 2]), { reject: (_e, i) => (i === 3 ? 'bad signature' : null) });
    try {
      await expect(run(archive, dst, { log })).rejects.toMatchObject({ code: Exit.Rejected, message: expect.stringMatching(/block 2: envelope 1 .*refused: BAD_REQUEST bad signature/) });
    } finally { dst.close(); }
  });

  it('resumes at the destination height after a check that the last block is the source\'s', async () => {
    const blocks = archiveBlocks([2, 3, 1, 4]);
    const { archive, dst } = await setup(blocks, {}, 2);
    try {
      const s = await run(archive, dst, { log });
      expect(s).toMatchObject({ startHeight: 3, endHeight: 5, txBlocks: 2 });
    } finally { dst.close(); }
  });

  it('refuses to resume onto a destination whose last block is not the source\'s (exit 6)', async () => {
    const blocks = archiveBlocks([2, 3, 1]);
    const { archive, dst } = await setup(blocks, {}, 1);
    fake.cut([envelope(CH, 'stray')]);
    try { expect(await code(run(archive, dst, { log }))).toBe(Exit.Mismatch); } finally { dst.close(); }
  });

  it('refuses to resume when the destination moves while idle (exit 5)', async () => {
    const blocks = archiveBlocks([2, 3, 1]);
    // a block cut just after the tool has read the height: during its quiet period
    const { archive, dst } = await setup(blocks, { onFirstNewest: () => setTimeout(() => fake.cut([envelope(CH, 'late')]), 20) }, 1);
    try { expect(await code(run(archive, dst, { log }))).toBe(Exit.MovedWhileIdle); } finally { dst.close(); }
  });

  it('verifies the archive before sending: a block that no longer matches its sealed digest stops the run, nothing sent', async () => {
    const blocks = archiveBlocks([2, 3]);
    const { archive, dst } = await setup(blocks);
    const file = archive.file(2);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(file, bytes);
    try {
      await expect(run(archive, dst, { log })).rejects.toMatchObject({ code: Exit.Blocking, message: expect.stringMatching(/block 2 does not match its sealed digest/) });
      expect(fake.blocks).toHaveLength(1);
    } finally { dst.close(); }
  });

  it('resumes from the same archive extended after the freeze, and refuses another archive (exit 6)', async () => {
    const all = archiveBlocks([2, 3, 1, 4]);
    const { archive, dst } = await setup(all.slice(0, 3));
    const stateFile = path.join(work, 'state', `${CH}.json`);
    try {
      expect(await run(archive, dst, { log })).toMatchObject({ endHeight: 3 });
    } finally { dst.close(); }
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).archiveGenesis).toBe(crypto.createHash('sha256').update(GENESIS).digest('hex'));

    // The top-up: the same chain, two blocks longer, with a new digest list and manifest.
    writeArchive(path.join(work, 'archive'), CH, all);
    const extended = new Archive(path.join(work, 'archive'), CH);
    expect(extended.manifest!.digestFileSha256).not.toBe(archive.manifest!.digestFileSha256);
    const dst2 = openDestination(loadDescriptor(path.join(work, 'dest.json')), CH);
    try {
      expect(await run(extended, dst2, { log })).toMatchObject({ startHeight: 3, endHeight: 5, blocksSent: 2 });
    } finally { dst2.close(); }

    // A state file from another archive: its block 0 differs.
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...st, archiveGenesis: 'another-archive' }));
    const dst3 = openDestination(loadDescriptor(path.join(work, 'dest.json')), CH);
    try {
      await expect(run(extended, dst3, { log })).rejects.toMatchObject({ code: Exit.Mismatch, message: expect.stringMatching(/different archive/) });
    } finally { dst3.close(); }
  });

  it('refuses legacy state that cannot bind the destination prefix to a source archive', async () => {
    const blocks = archiveBlocks([2, 3]);
    const { archive, dst } = await setup(blocks);
    const stateFile = path.join(work, 'state', `${CH}.json`);
    try {
      await run(archive, dst, { log });
    } finally { dst.close(); }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.archiveGenesis;
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const resumed = openDestination(loadDescriptor(path.join(work, 'dest.json')), CH);
    try {
      await expect(run(archive, resumed, { log })).rejects.toMatchObject({
        code: Exit.Mismatch,
        message: expect.stringMatching(/predates source-archive binding/),
      });
    } finally { resumed.close(); }
  });

  it('refuses a destination ahead of the archive (exit 7) and another channel\'s archive (exit 9)', async () => {
    const blocks = archiveBlocks([1, 1]);
    const { archive, dst } = await setup(blocks, {}, 2);
    fake.cut([envelope(CH, 'extra')]);
    try { expect(await code(run(archive, dst, { log }))).toBe(Exit.DestinationAhead); } finally { dst.close(); }
    const other = writeArchive(path.join(work, 'other'), 'ch9', [GENESIS]);
    const dst2 = openDestination(loadDescriptor(path.join(work, 'dest.json')), CH);
    try { expect(await code(run(new Archive(other), dst2, { log }))).toBe(Exit.ChannelName); } finally { dst2.close(); }
  });

  it('cut-markers mode sends ahead, discards the markers, and still verifies every block', async () => {
    const blocks = archiveBlocks([2, 1, 3, 1, 2, 2]);
    const { archive, dst } = await setup(blocks, { batchMs: 5000 });
    // the fake cuts on a marker, as the patched orderer does
    const enqueue = fake.chain.enqueue.bind(fake.chain);
    fake.chain.enqueue = (e: Buffer) => {
      const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(e).getPayload_asU8());
      const t = common.ChannelHeader.deserializeBinary(pl.getHeader()!.getChannelHeader_asU8()).getType();
      enqueue(e);
      if (t === common.HeaderType.MESSAGE) fake.cut();
    };
    dst.ld.d.orderer.mode = 'cut-markers';
    try {
      const s = await run(archive, dst, { log, window: 2 });
      expect(s).toMatchObject({ txBlocks: 6, endHeight: 7 });
      expect((await compare(archive, dst, 'orderer', log)).differ).toEqual([]);
    } finally { dst.close(); }
  });

  it('cut-markers mode with every org signing by ceremony signs the markers as the orderer reader', async () => {
    const blocks = archiveBlocks([2, 1, 3]);
    const { archive, dst } = await setup(blocks, { batchMs: 5000 });
    const markerCreators: string[] = [];
    const enqueue = fake.chain.enqueue.bind(fake.chain);
    fake.chain.enqueue = (e: Buffer) => {
      const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(e).getPayload_asU8());
      const t = common.ChannelHeader.deserializeBinary(pl.getHeader()!.getChannelHeader_asU8()).getType();
      enqueue(e);
      if (t === common.HeaderType.MESSAGE) {
        const sh = common.SignatureHeader.deserializeBinary(pl.getHeader()!.getSignatureHeader_asU8());
        markerCreators.push(msp.SerializedIdentity.deserializeBinary(sh.getCreator_asU8()).getMspid());
        fake.cut();
      }
    };
    dst.ld.d.orderer.mode = 'cut-markers';
    dst.orgSigners.clear(); // a ceremony descriptor holds no org key
    try {
      expect(await run(archive, dst, { log, window: 2 })).toMatchObject({ txBlocks: 3, endHeight: 4 });
      expect(markerCreators).toEqual(['Ord', 'Ord', 'Ord']);
      expect((await compare(archive, dst, 'orderer', log)).differ).toEqual([]);
    } finally { dst.close(); }
  });

  describe('resume when the destination tip is a config block', () => {
    /** Genesis, then a config block carrying the genesis config, then one transaction block. */
    function configThenTx(): Buffer[] {
      const link = (n: number, prev: Buffer, envs: Buffer[]): Buffer => {
        const p = decodeBlock(prev);
        const hdr = new common.BlockHeader();
        hdr.setNumber(n);
        hdr.setPreviousHash(Buffer.from(headerHash(n - 1, Buffer.from(p.previousHash, 'hex'), Buffer.from(p.dataHash, 'hex')), 'hex'));
        hdr.setDataHash(crypto.createHash('sha256').update(Buffer.concat(envs)).digest());
        const bd = new common.BlockData(); bd.setDataList(envs);
        const md = new common.BlockMetadata(); md.setMetadataList([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(envs.length), Buffer.alloc(0)]);
        const b = new common.Block(); b.setHeader(hdr); b.setData(bd); b.setMetadata(md);
        return Buffer.from(b.serializeBinary());
      };
      const config = link(1, GENESIS, [decodeBlock(GENESIS).txs[0].envelope]);
      return [GENESIS, config, link(2, config, [envelope(CH, 'tx-2-a'), envelope(CH, 'tx-2-b')])];
    }
    const genesisSha = crypto.createHash('sha256').update(GENESIS).digest('hex');
    const writeState = (lastAligned: number, lastDataHash: string, lastSourceDataHash: string): void => {
      fs.mkdirSync(path.join(work, 'state'), { recursive: true });
      fs.writeFileSync(path.join(work, 'state', `${CH}.json`), JSON.stringify({
        schema: 1, channel: CH, destinationGenesis: genesisSha, archiveGenesis: genesisSha,
        lastAligned, lastDataHash, lastSourceDataHash,
        batchTimeout: '50ms', mode: 'timeout', descriptorSha256: '', updatedAt: '',
      }));
    };

    it('resumes after the config block the state file recorded (the run stopped on the next block)', async () => {
      const blocks = configThenTx();
      const { archive, dst } = await setup(blocks, {}, 1);
      expect(decodeBlock(fake.blocks[1]).isConfig).toBe(true);
      writeState(1, decodeBlock(fake.blocks[1]).dataHash, decodeBlock(blocks[1]).dataHash);
      try {
        expect(await run(archive, dst, { log })).toMatchObject({ startHeight: 2, endHeight: 3, txBlocks: 1 });
        expect((await compare(archive, dst, 'orderer', log)).differ).toEqual([]);
      } finally { dst.close(); }
    });

    it('refuses a recorded config block whose destination hash no longer matches (exit 6)', async () => {
      const blocks = configThenTx();
      const { archive, dst } = await setup(blocks, {}, 1);
      writeState(1, 'another-destination-block', decodeBlock(blocks[1]).dataHash);
      try {
        await expect(run(archive, dst, { log })).rejects.toMatchObject({ code: Exit.Mismatch, message: expect.stringMatching(/different archive/) });
      } finally { dst.close(); }
    });

    it('refuses an unrecorded config tip the state file does not bind (exit 6)', async () => {
      const blocks = configThenTx();
      const { archive, dst } = await setup(blocks, {}, 1);
      try {
        await expect(run(archive, dst, { log })).rejects.toMatchObject({ code: Exit.Mismatch, message: expect.stringMatching(/unrecorded config block/) });
      } finally { dst.close(); }
    });
  });
});


d('run against a two-node ordering service: a failed send', () => {
  const pki = makePki();
  const srv = serverCert(pki.dir);
  let nodes: FakeOrderer[] = [];
  let work: string;
  afterAll(() => pki.cleanup());
  afterEach(() => { nodes.forEach((n) => n.stop()); fs.rmSync(work, { recursive: true, force: true }); });

  /** Node A (first in the descriptor, so the one the run starts on) carries the fault; node B is healthy. */
  async function cluster(blocks: Buffer[], faultA: FakeOpts, mode = 'timeout') {
    work = fs.mkdtempSync(path.join(pki.dir, 'w-'));
    writeArchive(path.join(work, 'archive'), CH, blocks);
    const chain = new FakeChain(GENESIS, { batchMs: 40 });
    nodes = [new FakeOrderer(chain, faultA), new FakeOrderer(chain)];
    for (const n of nodes) await n.start({ ...srv, caCert: pki.caCert });
    const r = (f: string): string => path.relative(work, f);
    const desc = {
      schema: 1, profile: 'self-managed',
      orderer: { mode, batchTimeout: '50ms', endpoints: nodes.map((n) => ({ address: `localhost:${n.port}`, tlsCa: r(pki.caCert) })), reader: { msp: 'Ord', cert: r(pki.cert), key: r(pki.key) } },
      orgs: { SrcA: { signer: { mode: 'local', cert: r(pki.cert), key: r(pki.key) }, rootCa: r(pki.caCert), tlsRootCa: r(pki.caCert) } },
    };
    fs.writeFileSync(path.join(work, 'dest.json'), JSON.stringify(desc));
    return { archive: new Archive(path.join(work, 'archive'), CH), dst: openDestination(loadDescriptor(path.join(work, 'dest.json')), CH), chain };
  }
  const opts = { log: (): void => undefined, failoverQuietMs: 300 };
  const same = (chain: FakeChain, blocks: Buffer[]): void =>
    expect(chain.blocks.slice(1).map((b) => decodeBlock(b).dataHash)).toEqual(blocks.slice(1).map((b) => decodeBlock(b).dataHash));

  it('a node that dies with part of a block, which never reached the chain: fails over and sends the block again', async () => {
    const blocks = archiveBlocks([2, 5, 3]);
    const { archive, dst, chain } = await cluster(blocks, { crashAt: { envelope: 5, fate: 'lost' } }); // 3rd envelope of block 2
    try {
      const s = await run(archive, dst, opts);
      expect(s).toMatchObject({ endHeight: 4, txBlocks: 3 });
      expect(s.failovers.length).toBeGreaterThanOrEqual(1);
      expect(s.failovers[0]).toMatchObject({ from: `localhost:${nodes[0].port}`, to: `localhost:${nodes[1].port}` });
      same(chain, blocks);
      expect((await compare(archive, dst, 'orderer', opts.log)).differ).toEqual([]);
    } finally { dst.close(); }
  });

  it('a node that dies after forwarding the whole block: fails over, finds the block cut, and checks it instead of resending', async () => {
    const blocks = archiveBlocks([2, 5, 3]);
    const { archive, dst, chain } = await cluster(blocks, { crashAt: { envelope: 7, fate: 'forwarded' } }); // last envelope of block 2
    try {
      const s = await run(archive, dst, opts);
      expect(s).toMatchObject({ endHeight: 4, txBlocks: 3 });
      same(chain, blocks); // no duplicate block
    } finally { dst.close(); }
  });

  it('a node that dies after forwarding part of a block: the split is found, exit 6', async () => {
    const { archive, dst } = await cluster(archiveBlocks([2, 5, 3]), { crashAt: { envelope: 5, fate: 'forwarded' } });
    try { await expect(run(archive, dst, opts)).rejects.toMatchObject({ code: Exit.Mismatch, message: expect.stringMatching(/block 2/) }); } finally { dst.close(); }
  });

  it('a node that accepts the whole block and dies before passing it on: no block appears; recovered by resending', async () => {
    const blocks = archiveBlocks([2, 5, 3]);
    const { archive, dst, chain } = await cluster(blocks, { crashAt: { envelope: 7, fate: 'lost', afterVerdict: true } });
    try {
      const s = await run(archive, dst, opts);
      expect(s).toMatchObject({ endHeight: 4, txBlocks: 3 });
      same(chain, blocks);
    } finally { dst.close(); }
  });

  it('SERVICE_UNAVAILABLE (no Raft leader) for a whole block: fails over and sends it again', async () => {
    const blocks = archiveBlocks([2, 4, 1]);
    const { archive, dst, chain } = await cluster(blocks, { unavailable: { from: 2, to: 1000 } });
    try {
      const s = await run(archive, dst, opts);
      expect(s).toMatchObject({ endHeight: 4, txBlocks: 3 });
      same(chain, blocks);
    } finally { dst.close(); }
  });

  it('cut-markers mode does not recover a failed send: exit 4', async () => {
    const { archive, dst } = await cluster(archiveBlocks([2, 5]), { crashAt: { envelope: 4, fate: 'lost' } }, 'cut-markers');
    try { await expect(run(archive, dst, opts)).rejects.toMatchObject({ code: Exit.BroadcastFailed }); } finally { dst.close(); }
  });
});
