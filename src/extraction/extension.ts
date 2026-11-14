import * as fs from 'fs';
import * as path from 'path';
import { ChannelInfo, ChannelMetadata, MigrationTier } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { CheckpointManager } from './checkpoint-manager';
import { ExtractionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('extension');

/**
 * Suffix of a file written beside the one it will replace.
 *
 * State files are rewritten whole by an extension, and the old ones are the
 * only copy of the state before the new blocks: they are replaced by rename
 * once every writer has closed, never truncated first.
 */
export const STAGED_SUFFIX = '.next';

/** File, relative to the output directory, recording an extension in progress. */
export const EXTEND_JOURNAL = 'extend-journal.json';

export function stagedPath(relativePath: string): string {
  return relativePath + STAGED_SUFFIX;
}

/**
 * What an interrupted extension has to undo or finish.
 *
 * `walking`: records may have been appended past the sizes in `grown`, and
 * staged files may be partial. Recovery cuts every grown file back, deletes
 * the files this run created and the staged files, and rewinds the walk.
 * `committing`: every staged file is complete. Recovery finishes the renames
 * and writes the metadata recorded here.
 */
export interface ExtendJournal {
  version: 1;
  phase: 'walking' | 'committing';
  channels: Record<string, {
    fromBlock: number;
    /** Relative path → size in bytes before the extension. */
    grown: Record<string, number>;
  }>;
  /** `committing` only: staged files to rename over these relative paths. */
  renames?: string[];
  /** `committing` only: state files with no live key left, to empty. */
  empties?: string[];
  /** `committing` only: channel ID → metadata.json content. */
  metadata?: Record<string, ChannelMetadata>;
}

function journalPath(outputDir: string): string {
  return path.join(outputDir, EXTEND_JOURNAL);
}

function writeJournal(outputDir: string, journal: ExtendJournal): void {
  const target = journalPath(outputDir);
  const tmp = target + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(journal, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export function readJournal(outputDir: string): ExtendJournal | undefined {
  const p = journalPath(outputDir);
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ExtendJournal;
}

function readMetadata(
  outputDir: string,
  layout: FileLayoutManager,
  channelId: string,
): ChannelMetadata | undefined {
  const p = path.join(outputDir, layout.channelMetadataPath(channelId));
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as ChannelMetadata;
  } catch {
    // Unreadable is treated as absent, as the extractor itself does: there is
    // no completed extraction here that a run could corrupt or extend.
    return undefined;
  }
}

function checkpointsFor(outputDir: string, layout: FileLayoutManager, channelId: string): CheckpointManager {
  return new CheckpointManager(path.join(outputDir, layout.checkpointDir(channelId)));
}

/** Files an extension appends to: the ones whose records accumulate across blocks. */
function grownFiles(outputDir: string, layout: FileLayoutManager, channelId: string): string[] {
  const files = [layout.publicHistoryPath(channelId), layout.blockMetadataPath(channelId)];
  for (const suffix of ['-hashes.ndjson', '-history.ndjson']) {
    for (const f of layout.listPrivateFiles(channelId, suffix)) {
      files.push(path.join(layout.channelDir(channelId), f));
    }
  }
  return files;
}

/**
 * Refuse a run that would append to a completed extraction without `--extend`.
 *
 * A completed directory whose manifest has grown used to be walked from its
 * checkpoint with an empty state accumulator, and the state of the new blocks
 * alone was appended after the old state file: a file holding two partial
 * states, which every later step reads as one.
 */
export function refuseGrowthWithoutExtend(
  outputDir: string,
  layout: FileLayoutManager,
  channels: ChannelInfo[],
): void {
  if (readJournal(outputDir)) {
    throw new ExtractionError(
      `${outputDir} holds an interrupted extract --extend (${EXTEND_JOURNAL}). Re-run the same command with --extend to ` +
        'finish it; any other run would mix its files with the half-written extension.',
    );
  }
  const grown = channels.filter((c) => {
    const m = readMetadata(outputDir, layout, c.channelId);
    return m !== undefined && c.ledgerHeight > m.ledgerHeight;
  });
  if (grown.length > 0) {
    throw new ExtractionError(
      `${outputDir} already holds a completed extraction of ${grown.map((c) => c.channelId).join(', ')} at a lower ` +
        'height than the manifest. Add --extend to continue it to the new height, or extract into an empty directory.',
    );
  }
}

/**
 * Undo or finish an interrupted extension, so the run can start from a
 * consistent directory.
 *
 * @returns true when a commit was finished, in which case the directory is
 *   already at the journal's heights.
 */
export function recoverExtension(outputDir: string, layout: FileLayoutManager): boolean {
  const journal = readJournal(outputDir);
  if (!journal) return false;

  if (journal.phase === 'committing') {
    logger.warn('Finishing the commit of an interrupted extension');
    applyCommit(outputDir, journal);
    return true;
  }

  logger.warn(
    { channels: Object.keys(journal.channels) },
    'Rolling back an interrupted extension: cutting appended files back to their recorded sizes',
  );
  for (const [channelId, entry] of Object.entries(journal.channels)) {
    for (const rel of grownFiles(outputDir, layout, channelId)) {
      const full = path.join(outputDir, rel);
      if (!fs.existsSync(full)) continue;
      const size = entry.grown[rel];
      if (size === undefined) fs.rmSync(full);
      else if (fs.statSync(full).size > size) fs.truncateSync(full, size);
    }
    removeStaged(path.join(outputDir, layout.channelDir(channelId)));
    const checkpoints = checkpointsFor(outputDir, layout, channelId);
    if (checkpoints.getLastBlockNumber(channelId, 'block-walk') >= 0) {
      checkpoints.updateBlock(channelId, 'block-walk', entry.fromBlock - 1);
    }
  }
  removeStaged(outputDir);
  fs.rmSync(journalPath(outputDir));
  return false;
}

function removeStaged(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(STAGED_SUFFIX)) fs.rmSync(path.join(dir, f));
  }
}

/**
 * Check each channel can be extended and return the block it starts from.
 *
 * Channels already at the manifest's height are left out: there is nothing
 * above them to walk.
 *
 * @returns channel ID → first block to extract (the earlier ledger height).
 * @throws ExtractionError for a channel that is not a completed extraction of
 *   the same tier and scope, or whose manifest height is lower.
 */
export function planExtension(
  outputDir: string,
  layout: FileLayoutManager,
  channels: ChannelInfo[],
  tier: MigrationTier,
  privateOnly: boolean,
): Map<string, number> {
  const plan = new Map<string, number>();
  for (const channel of channels) {
    const { channelId } = channel;
    const m = readMetadata(outputDir, layout, channelId);
    if (!m) {
      throw new ExtractionError(
        `--extend: channel ${channelId} has no completed extraction in ${outputDir} (no readable metadata.json). ` +
          'Run a full extraction first, or let an interrupted one finish without --extend.',
      );
    }
    if (m.tier !== tier) {
      throw new ExtractionError(`--extend: channel ${channelId} was extracted at tier ${m.tier}, not ${tier}.`);
    }
    if ((m.scope === 'private-only') !== privateOnly) {
      throw new ExtractionError(
        `--extend: channel ${channelId} was extracted ${m.scope === 'private-only' ? 'with' : 'without'} ` +
          '--private-only; extend it the same way.',
      );
    }
    if (channel.ledgerHeight < m.ledgerHeight) {
      throw new ExtractionError(
        `--extend: the manifest gives channel ${channelId} height ${channel.ledgerHeight}, below the ` +
          `${m.ledgerHeight} already extracted. Re-run discover against the same network.`,
      );
    }
    if (channel.ledgerHeight === m.ledgerHeight) {
      logger.info({ channelId, ledgerHeight: m.ledgerHeight }, 'Channel already at the manifest height — nothing to extend');
      continue;
    }
    if (!privateOnly) {
      const last = checkpointsFor(outputDir, layout, channelId).getLastBlockNumber(channelId, 'block-walk');
      if (last !== m.ledgerHeight - 1) {
        throw new ExtractionError(
          `--extend: channel ${channelId}'s block-walk checkpoint is at ${last}, but its metadata.json records a ` +
            `completed walk to ${m.ledgerHeight - 1}. The directory was changed by another run; extract afresh.`,
        );
      }
    }
    plan.set(channelId, m.ledgerHeight);
  }
  return plan;
}

/** Record the sizes of every file the extension will append to, before it writes any. */
export function beginExtension(
  outputDir: string,
  layout: FileLayoutManager,
  plan: Map<string, number>,
): void {
  const journal: ExtendJournal = { version: 1, phase: 'walking', channels: {} };
  for (const [channelId, fromBlock] of plan) {
    const grown: Record<string, number> = {};
    for (const rel of grownFiles(outputDir, layout, channelId)) {
      const full = path.join(outputDir, rel);
      if (fs.existsSync(full)) grown[rel] = fs.statSync(full).size;
    }
    journal.channels[channelId] = { fromBlock, grown };
  }
  writeJournal(outputDir, journal);
}

/**
 * Replace the state files and metadata, once every writer has closed.
 *
 * The plan is journaled first, so a crash part-way through the renames is
 * finished by the next run rather than leaving old and new files mixed.
 *
 * @param stateFiles Relative paths of every state file the extension rewrote
 *   or may have emptied: for each, its staged sibling replaces it, or it is
 *   emptied when no staged sibling exists (no live key left).
 */
export function commitExtension(
  outputDir: string,
  stateFiles: string[],
  metadata: Record<string, ChannelMetadata>,
): void {
  const journal = readJournal(outputDir);
  if (!journal) throw new ExtractionError(`--extend: ${EXTEND_JOURNAL} disappeared before the commit.`);
  const renames: string[] = [];
  const empties: string[] = [];
  for (const rel of new Set(stateFiles)) {
    if (fs.existsSync(path.join(outputDir, stagedPath(rel)))) renames.push(rel);
    else if (fs.existsSync(path.join(outputDir, rel))) empties.push(rel);
  }
  writeJournal(outputDir, { ...journal, phase: 'committing', renames, empties, metadata });
  applyCommit(outputDir, readJournal(outputDir)!);
}

function applyCommit(outputDir: string, journal: ExtendJournal): void {
  for (const rel of journal.renames ?? []) {
    const staged = path.join(outputDir, stagedPath(rel));
    if (fs.existsSync(staged)) fs.renameSync(staged, path.join(outputDir, rel));
  }
  for (const rel of journal.empties ?? []) {
    const full = path.join(outputDir, rel);
    if (fs.existsSync(full)) fs.truncateSync(full, 0);
  }
  for (const m of Object.values(journal.metadata ?? {})) {
    const layout = new FileLayoutManager(outputDir);
    fs.writeFileSync(
      path.join(outputDir, layout.channelMetadataPath(m.channelId)),
      JSON.stringify(m, null, 2),
      'utf-8',
    );
  }
  fs.rmSync(journalPath(outputDir));
  logger.info({ renamed: journal.renames?.length ?? 0, emptied: journal.empties?.length ?? 0 }, 'Extension committed');
}
