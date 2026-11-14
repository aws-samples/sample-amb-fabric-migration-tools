import { NdjsonReader } from '../replay/ndjson-reader';

/** How deep one history file's keys go. */
export interface HistoryDepth {
  /** Records in the file. */
  versions: number;
  /** Distinct (chaincode, key) pairs. */
  keys: number;
  /** Versions of the most-written key. */
  maxVersions: number;
  /** That key, as `chaincode/key`. */
  deepestKey: string;
}

/**
 * Measure a history file's per-key depth.
 *
 * Replay submits a key's versions one transaction after another, in order, so
 * however wide the batches and however many channels run at once, a replay
 * cannot finish sooner than the deepest key's version count times the
 * destination's commit latency. That is the one replay duration no tuning
 * removes, so it has to be known before a migration window is promised.
 *
 * Holds one counter per distinct key, which is bounded by the channel's key
 * count rather than by its history.
 *
 * @param filePath A `public-history.ndjson` or `private-*-history.ndjson`.
 */
export async function measureHistoryDepth(filePath: string): Promise<HistoryDepth> {
  const reader = new NdjsonReader();
  const counts = new Map<string, number>();
  let versions = 0;

  for await (const record of reader.stream(filePath)) {
    const r = record as { chaincode?: string; key?: string };
    if (typeof r.key !== 'string') continue;
    const id = `${r.chaincode ?? ''}/${r.key}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    versions++;
  }

  let maxVersions = 0;
  let deepestKey = '';
  for (const [id, n] of counts) {
    if (n > maxVersions) {
      maxVersions = n;
      deepestKey = id;
    }
  }

  return { versions, keys: counts.size, maxVersions, deepestKey };
}

/** One line for `status`: versions, keys, and the deepest key. */
export function formatHistoryDepth(depth: HistoryDepth): string {
  if (depth.versions === 0) return 'no history';
  // A composite key carries U+0000, which would garble the terminal.
  const key = depth.deepestKey.split('\u0000').join('\\0');
  return `${depth.versions} versions over ${depth.keys} keys, deepest ` +
    `${depth.maxVersions} (${key})`;
}
