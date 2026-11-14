import * as fs from 'fs';
import * as path from 'path';
import { ChannelMetadata, ExtractionRecord, MigrationTier, StateDeleteRecord } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { NdjsonReader } from './ndjson-reader';
import { ReplayError } from '../utils/errors';

/**
 * Replay only what an extension added (`replay --since`).
 *
 * After `extract --extend`, every history, block-metadata and private-hash record above the earlier height has
 * `blockNumber >= fromBlock`. State files are rewritten whole, so the keys that changed are found from the records in
 * that range: history at Tier 3, block metadata at Tier 2. A key whose last write in the range is a delete is absent
 * from the new state file, and is sent as a {@link StateDeleteRecord}, so the destination drops it too.
 */

/** Per channel, the first block to replay. */
export type SinceSpec = Map<string, number>;

const SEP = '\u0000\u0001';
/** Identity of one state key: chaincode, collection ('' for public) and key. */
export function stateKeyOf(chaincode: string, collection: string | undefined, key: string): string {
  return [chaincode, collection ?? '', key].join(SEP);
}

/**
 * Parse `--since`: `extension` (each channel's most recent `extract --extend`, from `metadata.json`) or
 * `<channel>=<block>[,<channel>=<block>...]` naming every channel replayed.
 *
 * @throws ReplayError when a channel has no height, or its extraction cannot support a partial replay.
 */
export function resolveSince(
  since: string, inputDir: string, layout: FileLayoutManager, channels: string[],
): SinceSpec {
  const spec: SinceSpec = new Map();
  const explicit = since === 'extension' ? undefined : parseExplicit(since);
  for (const channelId of channels) {
    const meta = readMetadata(inputDir, layout, channelId);
    let from: number | undefined;
    if (explicit) {
      from = explicit.get(channelId);
      if (from === undefined) {
        throw new ReplayError(`--since names no height for channel ${channelId}. Name every channel replayed, or use --since extension.`);
      }
    } else {
      const ext = meta?.extensions?.[meta.extensions.length - 1];
      if (!ext) {
        throw new ReplayError(
          `--since extension: channel ${channelId} has no extract --extend recorded in its metadata.json, so there is no ` +
            'earlier height to replay from. Give the height explicitly (--since <channel>=<block>).',
        );
      }
      from = ext.fromBlock;
    }
    checkTier(meta, channelId, layout);
    spec.set(channelId, from);
  }
  return spec;
}

function parseExplicit(since: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const part of since.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.lastIndexOf('=');
    const n = Number(part.slice(i + 1));
    if (i <= 0 || !Number.isInteger(n) || n < 0) {
      throw new ReplayError(`--since: "${part}" is not <channel>=<block>. Use --since extension or ch1=1200,ch2=900.`);
    }
    m.set(part.slice(0, i), n);
  }
  if (m.size === 0) throw new ReplayError('--since: no channel heights given');
  return m;
}

function readMetadata(inputDir: string, layout: FileLayoutManager, channelId: string): Partial<ChannelMetadata> | undefined {
  const p = path.join(inputDir, layout.channelMetadataPath(channelId));
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<ChannelMetadata>;
}

/** Which keys changed can only be told from history (Tier 3) or, for public data, block metadata (Tier 2). */
function checkTier(meta: Partial<ChannelMetadata> | undefined, channelId: string, layout: FileLayoutManager): void {
  const tier = meta?.tier;
  if (tier === undefined || tier < MigrationTier.StateWithAudit) {
    throw new ReplayError(
      `--since: channel ${channelId} was extracted at Tier ${tier ?? 'unknown'}, which records no block numbers, so the ` +
        'records added since a height cannot be told apart. Replay the whole directory, or extract at Tier 2 or 3.',
    );
  }
  if (tier < MigrationTier.FullHistory && layout.listPrivateFiles(channelId, '-state.ndjson').length > 0) {
    throw new ReplayError(
      `--since: channel ${channelId} has private data extracted at Tier 2, which records no private writes per block, so ` +
        'the private keys that changed cannot be found. Replay the whole directory, or extract at Tier 3.',
    );
  }
}

/** The state keys a channel's records at or above `from` touched, and those whose last touch there was a delete. */
export interface ChannelDelta {
  from: number;
  touched: Set<string>;
  /** Keys last deleted in the range, in the order their deletes happened. */
  deletes: StateDeleteRecord[];
}

/**
 * Scan a channel's history (or, at Tier 2, block metadata) for the keys written or deleted at or above `from`.
 *
 * Holds one entry per key touched in the range, which after an extension is the gap since the earlier pass.
 */
export async function channelDelta(
  inputDir: string, layout: FileLayoutManager, channelId: string, from: number,
): Promise<ChannelDelta> {
  const reader = new NdjsonReader();
  const last = new Map<string, { isDelete: boolean; chaincode: string; collection?: string; key: string; order: number }>();
  let order = 0;
  const note = (chaincode: string, collection: string | undefined, key: string, isDelete: boolean): void => {
    const id = stateKeyOf(chaincode, collection, key);
    last.delete(id); // re-insert so iteration order is the order of the last touch
    last.set(id, { isDelete, chaincode, collection, key, order: order++ });
  };

  const historyPath = path.join(inputDir, layout.publicHistoryPath(channelId));
  const metadataPath = path.join(inputDir, layout.blockMetadataPath(channelId));
  if (fs.existsSync(historyPath)) {
    for await (const r of reader.stream(historyPath)) {
      const h = r as Extract<ExtractionRecord, { _type: 'public_history' }>;
      if (h.blockNumber >= from) note(h.chaincode, undefined, h.key, h.isDelete);
    }
  } else if (fs.existsSync(metadataPath)) {
    // Tier 2: a transaction's writes are attributed to the chaincode it invoked.
    for await (const r of reader.stream(metadataPath)) {
      const m = r as Extract<ExtractionRecord, { _type: 'block_metadata' }>;
      if (m.blockNumber < from) continue;
      for (const k of m.keysWritten ?? []) note(m.chaincodeId, undefined, k, false);
      for (const k of m.keysDeleted ?? []) note(m.chaincodeId, undefined, k, true);
    }
  }
  for (const file of layout.listPrivateFiles(channelId, '-history.ndjson')) {
    for await (const r of reader.stream(path.join(inputDir, layout.channelDir(channelId), file))) {
      const h = r as Extract<ExtractionRecord, { _type: 'private_history' }>;
      if (h.blockNumber >= from) note(h.chaincode, h.collection, h.key, h.isDelete);
    }
  }

  const deletes: StateDeleteRecord[] = [];
  for (const v of last.values()) {
    if (!v.isDelete) continue;
    deletes.push({
      _type: 'state_delete', channel: channelId, chaincode: v.chaincode, key: v.key,
      ...(v.collection !== undefined ? { collection: v.collection } : {}),
    });
  }
  return { from, touched: new Set(last.keys()), deletes };
}

/** Whether a record belongs to the replay of `delta`. Identities are always replayed (small, idempotent). */
export function inDelta(record: ExtractionRecord, delta: ChannelDelta): boolean {
  switch (record._type) {
    case 'public_state':
      return delta.touched.has(stateKeyOf(record.chaincode, undefined, record.key));
    case 'private_state':
      return delta.touched.has(stateKeyOf(record.chaincode, record.collection, record.key));
    case 'public_history':
    case 'private_history':
    case 'block_metadata':
    case 'private_hash':
      return record.blockNumber >= delta.from;
    default:
      return true;
  }
}
