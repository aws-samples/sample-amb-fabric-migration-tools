// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { ReplayError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('replay-checkpoint-manager');

const CHECKPOINT_VERSION = 2;

/**
 * Checkpoint file name for one replay target.
 *
 * Per-adapter rather than shared: the three targets are replayed from the same
 * input directory, often one after another, and a single file would let each
 * run destroy the previous target's progress — including the `dirtyFile` marker
 * that makes a failed Tier 3 history replay refuse to resume.
 *
 * @param adapter Replay target name, e.g. `chaincode`.
 */
export function checkpointFileName(adapter: string, scope?: string): string {
  return scope === undefined
    ? `replay-checkpoint-${adapter}.json`
    : `replay-checkpoint-${adapter}-${scope}.json`;
}

/**
 * Per-channel checkpoint files a parallel replay of `adapter` left in `inputDir`.
 *
 * A sequential run and a parallel one keep their progress in different files,
 * so each refuses to start over the other's: resuming from the wrong one would
 * replay from the beginning and, at a history destination, append every
 * version a second time.
 */
export function scopedCheckpointFiles(inputDir: string, adapter: string): string[] {
  if (!fs.existsSync(inputDir)) return [];
  const prefix = `replay-checkpoint-${adapter}-`;
  return fs.readdirSync(inputDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
}

export interface ReplayCheckpoint {
  version: number;
  adapter: string;
  lastFile: string;
  recordsCompleted: number;
  /** Exact ordered input file set this cursor was computed against. */
  files: string[];
  updatedAt: string;
  /**
   * File whose append-only replay stopped because a record failed.
   *
   * Append-only replay records every write as a new destination history entry,
   * so the entries already written are a partial, out-of-order prefix that no
   * resume can repair. The marker survives the process so the next run refuses
   * instead of duplicating them.
   */
  dirtyFile?: string;
  /**
   * Append-only file whose batch was being written when the checkpoint was last
   * saved. Set before each batch and cleared by the update that follows it, so
   * it survives only a run that died mid-batch: that batch may or may not have
   * landed, and replaying it again would duplicate the history it wrote.
   */
  inFlight?: string;
}

/**
 * Tracks replay progress so a failed run can resume from where it left off
 * rather than restarting from the beginning.
 *
 * Each adapter gets its own checkpoint file in the input directory, alongside
 * the manifest. All writes are atomic (write to .tmp then rename).
 */
export class ReplayCheckpointManager {
  private readonly checkpointPath: string;
  private readonly tmpPath: string;
  private current: ReplayCheckpoint | null = null;

  /**
   * @param scope Names one channel's checkpoint in a parallel replay; omitted
   *   for the single checkpoint a sequential replay keeps.
   */
  constructor(
    private readonly inputDir: string,
    private readonly adapter: string,
    scope?: string,
  ) {
    this.checkpointPath = path.join(inputDir, checkpointFileName(adapter, scope));
    this.tmpPath = this.checkpointPath + '.tmp';
  }

  /** Absolute path of this adapter's checkpoint file. */
  getCheckpointPath(): string {
    return this.checkpointPath;
  }

  /** Load checkpoint from disk. Returns null if none exists. */
  load(): ReplayCheckpoint | null {
    if (this.current !== null) return this.current;
    if (!fs.existsSync(this.checkpointPath)) return null;

    let data: ReplayCheckpoint;
    try {
      data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8')) as ReplayCheckpoint;
    } catch (err) {
      throw new ReplayError('Failed to load replay checkpoint', err as Error);
    }

    if (data.version !== CHECKPOINT_VERSION) {
      throw new ReplayError(
        `Checkpoint ${this.checkpointPath} uses version ${data.version ?? 'missing'}, ` +
          `but this toolkit requires version ${CHECKPOINT_VERSION}, which binds ` +
          'the cursor to an exact ordered input file set. Reset the destination ' +
          'as required for its adapter, delete the checkpoint, and replay from ' +
          'the beginning.',
      );
    }

    // A mismatch means the file was copied or hand-edited. Ignoring it would
    // silently discard a dirtyFile marker or a resume offset, so refuse.
    if (data.adapter !== this.adapter) {
      throw new ReplayError(
        `Checkpoint ${this.checkpointPath} names adapter '${data.adapter}' but ` +
          `belongs to '${this.adapter}'. The file was copied or hand-edited. ` +
          'Delete it to replay this adapter from the beginning.',
      );
    }

    logger.info(
      { lastFile: data.lastFile, recordsCompleted: data.recordsCompleted },
      'Loaded replay checkpoint',
    );
    this.current = data;
    return data;
  }

  /** Write checkpoint atomically. */
  update(file: string, recordsCompleted: number, files: string[] = [file]): void {
    const dirtyFile = this.load()?.dirtyFile;
    this.write({
      version: CHECKPOINT_VERSION,
      adapter: this.adapter,
      lastFile: file,
      recordsCompleted,
      files: [...files],
      updatedAt: new Date().toISOString(),
      ...(dirtyFile ? { dirtyFile } : {}),
    });
  }

  /**
   * Record that a file's append-only replay stopped part-way through.
   *
   * Progress is left untouched — the point is not where to resume from but
   * that resuming is unsafe at all. `dirtyFile` is what a later run reads to
   * refuse.
   *
   * @param file Checkpoint key of the file that stopped.
   */
  markDirty(file: string, files: string[] = [file]): void {
    const cp = this.load();
    this.write({
      version: CHECKPOINT_VERSION,
      adapter: this.adapter,
      lastFile: cp?.lastFile ?? file,
      recordsCompleted: cp?.recordsCompleted ?? 0,
      files: cp?.files ?? [...files],
      updatedAt: new Date().toISOString(),
      dirtyFile: file,
    });
    logger.error(
      { dirtyFile: file },
      'Marked replay checkpoint dirty — the next run will refuse to resume',
    );
  }

  /** File whose append-only replay stopped part-way, if any. */
  getDirtyFile(): string | null {
    return this.load()?.dirtyFile ?? null;
  }

  /**
   * Record, durably, that an append-only batch of `file` is about to be
   * written. The next `update()` clears it.
   */
  markInFlight(file: string, files: string[] = [file]): void {
    const cp = this.load();
    this.write({
      version: CHECKPOINT_VERSION,
      adapter: this.adapter,
      lastFile: cp?.lastFile ?? file,
      recordsCompleted: cp?.recordsCompleted ?? 0,
      files: cp?.files ?? [...files],
      updatedAt: new Date().toISOString(),
      ...(cp?.dirtyFile ? { dirtyFile: cp.dirtyFile } : {}),
      inFlight: file,
    });
  }

  /** Append-only file a previous run was writing a batch of when it stopped, if any. */
  getInFlight(): string | null {
    return this.load()?.inFlight ?? null;
  }

  private write(checkpoint: ReplayCheckpoint): void {
    try {
      fs.writeFileSync(this.tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
      fs.renameSync(this.tmpPath, this.checkpointPath);
      this.current = checkpoint;
    } catch (err) {
      throw new ReplayError(
        `Failed to write replay checkpoint for ${checkpoint.lastFile}`,
        err as Error,
      );
    }
  }

  /** Remove checkpoint file after successful completion. */
  clear(): void {
    this.current = null;
    if (fs.existsSync(this.checkpointPath)) {
      try {
        fs.unlinkSync(this.checkpointPath);
        logger.info('Replay checkpoint cleared');
      } catch (err) {
        throw new ReplayError('Failed to clear replay checkpoint', err as Error);
      }
    }
  }

  /**
   * Returns true if this file was fully completed in a prior run.
   * A file is fully completed when the checkpoint points to a LATER file,
   * meaning this one was finished and we moved on.
   */
  shouldSkipFile(file: string, allFiles: string[]): boolean {
    const cp = this.load();
    if (!cp) return false;

    if (
      !Array.isArray(cp.files) ||
      cp.files.length !== allFiles.length ||
      cp.files.some((name, index) => name !== allFiles[index])
    ) {
      throw new ReplayError(
        `Replay input files changed since ${this.checkpointPath} was written. ` +
          'Resuming against a different file set can skip new records or replay ' +
          'completed history. Restore the original extraction, or reset the ' +
          'destination and delete the checkpoint to replay from the beginning.',
      );
    }

    const lastFileIdx = allFiles.indexOf(cp.lastFile);
    const thisFileIdx = allFiles.indexOf(file);

    // If either file is not in the list, don't skip
    if (lastFileIdx === -1 || thisFileIdx === -1) return false;

    // Skip files that come strictly before the checkpointed file
    return thisFileIdx < lastFileIdx;
  }

  /**
   * Returns the number of records already committed for a file that was
   * partially completed. Returns 0 if this file has no prior progress.
   */
  getResumeOffset(file: string): number {
    const cp = this.load();
    if (!cp) return 0;
    if (cp.lastFile !== file) return 0;
    return cp.recordsCompleted;
  }
}
