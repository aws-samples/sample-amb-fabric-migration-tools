/**
 * The plan digest binds a resilient history-import run to its inputs.
 *
 * A scope is a namespace on the destination contract, and the contract stores
 * one plan digest per scope. Re-running the same migration under the same scope
 * must present the same digest; a *different* plan under the same scope is
 * refused by the contract, because it would mean two migrations sharing one set
 * of receipts. The digest therefore binds everything that changes what the run
 * writes or where it writes it: the protocol version, the scope, a commitment to
 * the HMAC key (so a scope reused with a different key is refused), the exact
 * ordered history input files by content hash, the source network, channel and
 * collection routing, `embedSourceMetadata`, and the migration contract name.
 * Operational tuning such as batch size is deliberately not bound: receipts
 * make it safe to reduce a batch after a failure without changing any imported
 * record's destination intent.
 *
 * The HMAC key is bound by commitment, not by value — the digest is a plain
 * SHA-256 and travels to the destination, so the key must not be recoverable
 * from it.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ReplayConfig } from '../../types';
import { FileLayoutManager } from '../../output/file-layout-manager';
import { DEFAULT_MIGRATION_CONTRACT } from '../function-mapping';
import {
  DOMAIN_PLAN_DIGEST,
  PROTOCOL_VERSION,
  keyCommitment,
  writeField,
  writeUint,
} from './protocol';
import { ResilientHistoryContext } from './config';

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

/** A source/destination channel pair in scope for the run. */
export interface ChannelPair {
  channel: string;
  destChannel: string;
}

export interface PlanDigestInput {
  context: ResilientHistoryContext;
  ccConfig: ChaincodeConfig;
  layout: FileLayoutManager;
  /** Source network whose immutable history records are being imported. */
  sourceNetworkId: string;
  /** Source/destination channel pairs, in replay order. */
  pairs: ChannelPair[];
  /** `replay --since`: the first block replayed per channel. Bound so the same scope cannot mix two ranges. */
  since?: Map<string, number>;
}

/**
 * Compute the plan digest for a resilient history-import run.
 *
 * @returns The digest as lowercase hex.
 */
export async function computePlanDigest(
  input: PlanDigestInput,
): Promise<string> {
  const { context, ccConfig, layout, pairs, sourceNetworkId } = input;
  const files = gatherHistoryFiles(layout, pairs);
  const hashes: Array<{ key: string; hash: Buffer }> = [];
  for (const file of files) {
    hashes.push({ key: file.key, hash: await hashFile(file.path) });
  }

  const h = crypto.createHash('sha256');
  writeField(h, DOMAIN_PLAN_DIGEST);
  writeField(h, PROTOCOL_VERSION);
  writeField(h, context.scope);
  writeField(h, sourceNetworkId);
  writeField(h, keyCommitment(context.key));

  // Ordered history input files, by checkpoint key and content hash. Order is
  // significant and bound: a run that replays the same files in a different
  // order is a different plan.
  writeUint(h, hashes.length);
  for (const { key, hash } of hashes) {
    writeField(h, key);
    writeField(h, hash);
  }

  // Channel routing, sorted for determinism.
  const routing = [...pairs].sort((a, b) => a.channel.localeCompare(b.channel));
  writeUint(h, routing.length);
  for (const pair of routing) {
    writeField(h, pair.channel);
    writeField(h, pair.destChannel);
  }

  // Collection routing, sorted for determinism.
  const collections = Object.entries(ccConfig.collectionMapping ?? {})
    .sort((a, b) => a[0].localeCompare(b[0]));
  writeUint(h, collections.length);
  for (const [source, dest] of collections) {
    writeField(h, source);
    writeField(h, dest);
  }

  writeField(h, ccConfig.embedSourceMetadata ? '1' : '0');
  writeField(h, ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT);

  // Only when set, so a full replay's digest is unchanged by this field's existence.
  if (input.since) {
    const since = [...input.since].sort((a, b) => a[0].localeCompare(b[0]));
    writeField(h, 'since');
    writeUint(h, since.length);
    for (const [channel, from] of since) {
      writeField(h, channel);
      writeUint(h, from);
    }
  }

  return h.digest('hex');
}

/**
 * The history input files a run will replay, in replay order.
 *
 * Per channel: public history first, then each private-history file in the
 * layout's sorted order — the same order `replayChannel` streams them. Files
 * that do not exist are omitted, so the digest binds exactly what will be read.
 */
function gatherHistoryFiles(
  layout: FileLayoutManager,
  pairs: ChannelPair[],
): Array<{ key: string; path: string }> {
  const files: Array<{ key: string; path: string }> = [];

  for (const { channel } of pairs) {
    const publicAbs = path.join(layout.baseDir, layout.publicHistoryPath(channel));
    if (fs.existsSync(publicAbs)) {
      files.push({ key: `${channel}/public-history`, path: publicAbs });
    }
    for (const pf of layout.listPrivateFiles(channel, '-history.ndjson')) {
      files.push({
        key: `${channel}/${pf}`,
        path: path.join(layout.baseDir, layout.channelDir(channel), pf),
      });
    }
  }

  return files;
}

/** SHA-256 of a file's contents, streamed so large files are not held whole. */
function hashFile(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest()));
  });
}
