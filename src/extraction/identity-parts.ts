import * as fs from 'fs';
import * as path from 'path';
import { IdentityRecord } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { ExtractionError } from '../utils/errors';
import { stateReconstructionCompletePath, STATE_RECONSTRUCTION_COMPLETE } from './state-completion';

/**
 * Each channel's signers are kept in a part of their own, committed with the
 * channel, and `identities.ndjson` is rebuilt from the parts of every completed
 * channel. A channel's commit then never depends on another channel's: a run
 * that fails part-way keeps every channel it finished, signers included.
 */

/** A channel's identity part, relative to the output directory. */
export function identityPartPath(layout: FileLayoutManager, channelId: string): string {
  return path.join(layout.channelDir(channelId), 'identities.part');
}

const identityKey = (r: IdentityRecord): string => `${r.mspId}:${r.certFingerprint}`;

/**
 * Merge per-channel identity registries into one set of records: transaction
 * counts summed, first and last block widened.
 */
export function mergeIdentityRegistries(registries: Iterable<Map<string, IdentityRecord>>): IdentityRecord[] {
  const merged = new Map<string, IdentityRecord>();
  for (const registry of registries) {
    for (const [key, record] of registry) {
      const existing = merged.get(key);
      if (existing) {
        existing.txCount += record.txCount;
        existing.firstSeenBlock = Math.min(existing.firstSeenBlock, record.firstSeenBlock);
        existing.lastSeenBlock = Math.max(existing.lastSeenBlock, record.lastSeenBlock);
      } else {
        // Clone to avoid mutating the original
        merged.set(key, { ...record });
      }
    }
  }
  return Array.from(merged.values());
}

/** Read an identity part or registry file into a registry. */
export function readIdentities(file: string): Map<string, IdentityRecord> {
  const registry = new Map<string, IdentityRecord>();
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line) continue;
    const record = JSON.parse(line) as IdentityRecord;
    registry.set(identityKey(record), record);
  }
  return registry;
}

/**
 * Replace `file` with `records`, durably: written beside it, synced, renamed
 * over it, and the directory synced. Written even when empty, so an empty
 * part is distinguishable from a missing one.
 */
export function writeIdentities(file: string, records: IdentityRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    if (records.length > 0) fs.writeSync(fd, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/** Channel IDs with a completion marker in `outputDir`, sorted so the registry is built in a fixed order. */
export function completedChannels(outputDir: string): string[] {
  if (!fs.existsSync(outputDir)) return [];
  const ids: string[] = [];
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('channel-')) continue;
    const marker = path.join(outputDir, entry.name, 'checkpoints', STATE_RECONSTRUCTION_COMPLETE);
    if (!fs.existsSync(marker)) continue;
    ids.push((JSON.parse(fs.readFileSync(marker, 'utf-8')) as { channelId: string }).channelId);
  }
  return ids.sort();
}

/**
 * Rebuild the identity registry from the part of every completed channel.
 *
 * @param target File to write, relative to the output directory: `identities.ndjson`, or its staged sibling.
 * @param replaced channel ID → path of a part to read in place of the channel's own (an extension's staged part).
 * @returns The number of identities written.
 * @throws ExtractionError for a completed channel without a part: its signers are unknown, so no registry is written.
 */
export function writeIdentityRegistry(
  outputDir: string,
  target: string,
  replaced: Map<string, string> = new Map(),
): number {
  const layout = new FileLayoutManager(outputDir);
  const registries: Map<string, IdentityRecord>[] = [];
  for (const channelId of completedChannels(outputDir)) {
    const part = replaced.get(channelId) ?? path.join(outputDir, identityPartPath(layout, channelId));
    if (!fs.existsSync(part)) {
      throw new ExtractionError(
        `Channel ${channelId} is marked complete (${stateReconstructionCompletePath(outputDir, layout, channelId)}) ` +
          `but has no identity part (${part}), so identities.ndjson cannot be rebuilt. Extract into an empty directory.`,
      );
    }
    registries.push(readIdentities(part));
  }
  const records = mergeIdentityRegistries(registries);
  writeIdentities(path.join(outputDir, target), records);
  return records.length;
}
