// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ExtractionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('block-archive');

/** Bumped when the on-disk layout changes in a way a reader must notice. */
export const BLOCK_ARCHIVE_SCHEMA = 1;
export const BLOCK_ARCHIVE_KIND = 'fabric-block-archive';
export const MANIFEST_FILE = 'manifest.json';
export const DIGEST_FILE = 'blocks.sha256';

/** Fabric channel names: lower-case letters, digits, '.' and '-', starting with a letter. */
const CHANNEL_ID = /^[a-z][a-z0-9.-]*$/;

/** One block as the walker received it, plus the two header hashes it already parsed. */
export interface ArchivedBlock {
  channelId: string;
  blockNumber: number;
  /** The block exactly as the peer delivered it (a serialized `common.Block`). */
  bytes: Uint8Array;
  previousHash: string;
  dataHash: string;
}

/**
 * What the block walker needs from an archive. The walker never imports the
 * writer, so a run without `--save-blocks` has no archive code on its path.
 */
export interface BlockSink {
  write(block: ArchivedBlock): void;
  /** Make everything written for the channel durable. Called before the walker's checkpoint. */
  flush(channelId: string): void;
  /** How many blocks 0..n-1 are present, with no gap. */
  contiguousBlocks(channelId: string): number;
  /** Whether the archived block is byte-identical to `bytes` (false if absent). */
  holds(channelId: string, blockNumber: number, bytes: Uint8Array): boolean;
}

export interface ArchiveSource {
  networkId?: string;
  memberId?: string;
  nodeId?: string;
  mspId?: string;
  region?: string;
}

export interface ArchiveManifest {
  schema: number;
  kind: typeof BLOCK_ARCHIVE_KIND;
  channel: string;
  firstBlock: 0;
  lastBlock: number;
  blockCount: number;
  ledgerHeight: number;
  /** Digest list in `sha256sum` format; `sha256sum -c blocks.sha256` run inside blocks/ checks the archive. */
  digestFile: typeof DIGEST_FILE;
  digestFileSha256: string;
  sha256OfLastBlock: string;
  source: ArchiveSource;
  extractor: { name: string; version: string };
  finalizedAt: string;
  /**
   * The extractor verifies each block's `previous_hash` against the prior block
   * while it walks, but a resumed run cannot verify across its own start. A
   * consumer must verify the whole chain itself.
   */
  hashChain: 'verified-per-run-by-extractor; consumer must re-verify';
  complete: true;
}

function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function fsyncPath(p: string, tolerateFailure: boolean): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!tolerateFailure) throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Writes the raw blocks of each channel to `<root>/<channel>/blocks/<N>.block`.
 *
 * The archive is the input of block-level migration (`fabric-rebroadcast`), so
 * it has three properties that the extraction output does not need:
 *
 * - **Byte-exact.** The bytes are the peer's, unchanged; the consumer re-sends
 *   the envelopes inside them, signatures included.
 * - **Never half-written.** Each block goes to a temporary name and is renamed;
 *   an existing block is compared, not overwritten, so a rerun that disagrees
 *   with what is on disk (another network, another channel) fails loudly.
 * - **Durable before the checkpoint.** `flush` fsyncs what was written; the
 *   walker calls it ahead of its own checkpoint write, so the archive can run
 *   ahead of the checkpoint and never behind it.
 *
 * The directory and files are created owner-only: blocks carry public-state
 * values and deserve the same care as the extraction output.
 */
export class BlockArchiveWriter implements BlockSink {
  private unsynced = new Map<string, string[]>();
  private started = new Set<string>();

  constructor(
    public readonly root: string,
    private readonly source: ArchiveSource = {},
    private readonly extractor: { name: string; version: string } = {
      name: 'fabric-amb-extractor',
      version: readOwnVersion(),
    },
  ) {}

  channelDir(channelId: string): string {
    if (!CHANNEL_ID.test(channelId)) {
      throw new ExtractionError(
        `Channel name "${channelId}" is not a valid Fabric channel name, so it cannot name an archive directory`,
      );
    }
    return path.join(this.root, channelId);
  }

  blocksDir(channelId: string): string {
    return path.join(this.channelDir(channelId), 'blocks');
  }

  write(block: ArchivedBlock): void {
    const { channelId, blockNumber, bytes } = block;
    if (!Number.isInteger(blockNumber) || blockNumber < 0) {
      throw new ExtractionError(`Cannot archive block number ${blockNumber} of channel ${channelId}`);
    }
    const dir = this.blocksDir(channelId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.invalidateManifest(channelId);

    const file = path.join(dir, `${blockNumber}.block`);
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file);
      if (Buffer.compare(existing, Buffer.from(bytes)) !== 0) {
        throw new ExtractionError(
          `Archive conflict: ${file} already exists and differs from block ${blockNumber} just delivered ` +
            `for channel ${channelId}. The directory holds blocks from a different channel or network, or ` +
            'a damaged file. Use an empty directory for this archive.',
        );
      }
    } else {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    const list = this.unsynced.get(channelId) ?? [];
    list.push(file);
    this.unsynced.set(channelId, list);
  }

  flush(channelId: string): void {
    const files = this.unsynced.get(channelId);
    if (!files || files.length === 0) return;
    for (const f of files) fsyncPath(f, false);
    // The renames live in the directory. Some platforms refuse to fsync a directory; the file contents are synced regardless.
    fsyncPath(this.blocksDir(channelId), true);
    this.unsynced.set(channelId, []);
  }

  contiguousBlocks(channelId: string): number {
    const dir = this.blocksDir(channelId);
    if (!fs.existsSync(dir)) return 0;
    const present = new Set<number>();
    for (const name of fs.readdirSync(dir)) {
      const m = /^(\d+)\.block$/.exec(name);
      if (m) present.add(Number(m[1]));
    }
    let n = 0;
    while (present.has(n)) n++;
    return n;
  }

  holds(channelId: string, blockNumber: number, bytes: Uint8Array): boolean {
    const file = path.join(this.blocksDir(channelId), `${blockNumber}.block`);
    return fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), Buffer.from(bytes)) === 0;
  }

  /**
   * Seal a channel's archive: check that blocks 0..ledgerHeight-1 are all
   * present, write the digest list and the manifest. A manifest on disk means
   * the archive was complete when it was written; any later `write` removes it.
   */
  finalize(channelId: string, ledgerHeight: number): ArchiveManifest {
    this.flush(channelId);
    const have = this.contiguousBlocks(channelId);
    if (have < ledgerHeight) {
      throw new ExtractionError(
        `Archive for channel ${channelId} is incomplete: blocks 0..${have - 1} are present, ` +
          `${ledgerHeight} were expected (ledger height). No manifest is written.`,
      );
    }
    if (have > ledgerHeight) {
      throw new ExtractionError(
        `Archive for channel ${channelId} holds ${have} blocks but the manifest being extracted records a ledger height of ` +
          `${ledgerHeight}. It was built from a longer chain than this run saw; re-run discover, or use an empty directory.`,
      );
    }

    const dir = this.blocksDir(channelId);
    const lines: string[] = [];
    let lastDigest = '';
    for (let n = 0; n < ledgerHeight; n++) {
      lastDigest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, `${n}.block`))).digest('hex');
      lines.push(`${lastDigest}  ${n}.block`);
    }
    const digestBody = lines.join('\n') + '\n';
    this.atomicWrite(path.join(dir, DIGEST_FILE), digestBody);

    const manifest: ArchiveManifest = {
      schema: BLOCK_ARCHIVE_SCHEMA,
      kind: BLOCK_ARCHIVE_KIND,
      channel: channelId,
      firstBlock: 0,
      lastBlock: ledgerHeight - 1,
      blockCount: ledgerHeight,
      ledgerHeight,
      digestFile: DIGEST_FILE,
      digestFileSha256: crypto.createHash('sha256').update(digestBody).digest('hex'),
      sha256OfLastBlock: lastDigest,
      source: this.source,
      extractor: this.extractor,
      finalizedAt: new Date().toISOString(),
      hashChain: 'verified-per-run-by-extractor; consumer must re-verify',
      complete: true,
    };
    this.atomicWrite(path.join(this.channelDir(channelId), MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
    logger.info({ channelId, blocks: ledgerHeight, dir }, 'Block archive sealed');
    return manifest;
  }

  /** The first write of a session removes a manifest left by an earlier, sealed run: the archive is about to change. */
  private invalidateManifest(channelId: string): void {
    if (this.started.has(channelId)) return;
    this.started.add(channelId);
    fs.rmSync(path.join(this.channelDir(channelId), MANIFEST_FILE), { force: true });
  }

  private atomicWrite(file: string, body: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fsyncPath(tmp, false);
    fs.renameSync(tmp, file);
  }
}
