/**
 * Reading a block archive. Two layouts:
 *   - the contract layout written by `extract --save-blocks` (design §6.1):
 *       <root>/<channel>/manifest.json, <root>/<channel>/blocks/<N>.block, <root>/<channel>/blocks/blocks.sha256
 *   - a bare directory of <N>.block files (the prototype's archives), accepted for lab use with a warning.
 * Opening checks the manifest; `verify()` checks every digest and the hash chain.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DecodedBlock, computedDataHash, decodeBlock, headerHash } from '../fabric/blocks';
import { Exit, RbError } from '../util/errors';
import { sha256 } from '../util/misc';

export interface ArchiveManifest {
  schema: number;
  kind: string;
  channel: string;
  firstBlock: number;
  lastBlock: number;
  blockCount: number;
  ledgerHeight: number;
  complete: boolean;
  digestFile: string;
  digestFileSha256: string;
  source?: { networkId?: string; memberId?: string; nodeId?: string; mspId?: string };
  extractor?: { name: string; version: string };
  finalizedAt?: string;
}

export class Archive {
  readonly blocksDir: string;
  readonly manifest?: ArchiveManifest;
  readonly height: number;
  readonly channel: string;
  readonly warnings: string[] = [];

  constructor(dir: string, channelHint?: string) {
    const abs = path.resolve(dir);
    const candidates = [abs, ...(channelHint ? [path.join(abs, channelHint)] : [])];
    const withManifest = candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json')) && fs.existsSync(path.join(c, 'blocks')));
    if (withManifest) {
      const m = JSON.parse(fs.readFileSync(path.join(withManifest, 'manifest.json'), 'utf8')) as ArchiveManifest;
      if (m.kind !== 'fabric-block-archive' || m.schema !== 1) throw new RbError(Exit.Usage, `${withManifest}/manifest.json is not a block archive manifest (schema 1)`);
      if (!m.complete) throw new RbError(Exit.Blocking, `the archive of ${m.channel} is not sealed as complete`);
      if (m.firstBlock !== 0) throw new RbError(Exit.Blocking, `the archive starts at block ${m.firstBlock}; a re-broadcast needs the chain from block 0`);
      this.blocksDir = path.join(withManifest, 'blocks');
      const digest = fs.readFileSync(path.join(this.blocksDir, m.digestFile));
      if (sha256(digest) !== m.digestFileSha256) throw new RbError(Exit.Blocking, `${m.digestFile} does not match the digest recorded in the manifest`);
      this.manifest = m;
      this.height = m.blockCount;
      this.channel = m.channel;
    } else {
      if (!fs.existsSync(path.join(abs, '0.block'))) {
        const chans = fs.existsSync(abs) ? fs.readdirSync(abs).filter((c) => fs.existsSync(path.join(abs, c, 'manifest.json'))) : [];
        if (chans.length) throw new RbError(Exit.Usage, `${dir} is an archive root holding ${chans.join(', ')}${channelHint ? `, not ${channelHint}` : ''}: name one with --channel`);
        throw new RbError(Exit.Usage, `${dir} holds neither an archive (manifest.json + blocks/) nor <N>.block files`);
      }
      this.blocksDir = abs;
      let n = 0;
      while (fs.existsSync(path.join(abs, `${n}.block`))) n++;
      this.height = n;
      this.channel = decodeBlock(this.raw(0)).txs[0]?.channel ?? '';
      this.warnings.push('no manifest: a bare directory of blocks (lab layout); digests are not checked against a sealed list');
    }
    if (channelHint && this.channel !== channelHint) throw new RbError(Exit.ChannelName, `the archive is channel "${this.channel}", not "${channelHint}"`);
  }

  file(n: number): string { return path.join(this.blocksDir, `${n}.block`); }
  raw(n: number): Buffer { return fs.readFileSync(this.file(n)); }
  block(n: number): DecodedBlock { return decodeBlock(this.raw(n)); }

  /** Every block present, its digest as sealed, data hashes, and the hash chain. Returns the number of blocks checked. */
  verify(onProgress?: (n: number) => void): number {
    const digests = new Map<string, string>();
    if (this.manifest) {
      for (const line of fs.readFileSync(path.join(this.blocksDir, this.manifest.digestFile), 'utf8').split('\n')) {
        if (!line) continue;
        const [d, name] = line.split(/\s+/);
        digests.set(name, d);
      }
      if (digests.size !== this.height) throw new RbError(Exit.Blocking, `${this.manifest.digestFile} lists ${digests.size} blocks, the manifest ${this.height}`);
    }
    let prev = '';
    for (let n = 0; n < this.height; n++) {
      const bytes = this.raw(n);
      if (this.manifest && digests.get(`${n}.block`) !== sha256(bytes)) throw new RbError(Exit.Blocking, `block ${n} does not match its sealed digest`);
      const b = decodeBlock(bytes);
      if (b.number !== n) throw new RbError(Exit.Blocking, `${n}.block holds block ${b.number}`);
      if (computedDataHash(b) !== b.dataHash) throw new RbError(Exit.Blocking, `block ${n}: data_hash does not match its transactions`);
      if (n > 0 && b.previousHash !== prev) throw new RbError(Exit.Blocking, `block ${n}: previous_hash does not match block ${n - 1}'s header`);
      for (const t of b.txs) if (t.channel !== this.channel) throw new RbError(Exit.Blocking, `block ${n} tx ${t.index} is on channel "${t.channel}", not "${this.channel}"`);
      prev = headerHash(n, Buffer.from(b.previousHash, 'hex'), Buffer.from(b.dataHash, 'hex'));
      onProgress?.(n);
    }
    return this.height;
  }
}
