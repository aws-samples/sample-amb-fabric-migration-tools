// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { Checkpoint } from '../types';
import { CheckpointError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('checkpoint-manager');

export class CheckpointManager {
  private checkpoints = new Map<string, Checkpoint>();
  /** Keys advanced by recordBlock() whose file has not been rewritten yet. */
  private pending = new Set<string>();

  constructor(private readonly checkpointDir: string) {
    fs.mkdirSync(this.checkpointDir, { recursive: true });
  }

  private keyFor(channel: string, strategy: string): string {
    return `${channel}:${strategy}`;
  }

  private fileFor(channel: string, strategy: string): string {
    return path.join(this.checkpointDir, `${channel}-${strategy}.json`);
  }

  load(channel: string, strategy: string): Checkpoint | null {
    const key = this.keyFor(channel, strategy);
    const cached = this.checkpoints.get(key);
    if (cached) return cached;

    const filePath = this.fileFor(channel, strategy);
    if (!fs.existsSync(filePath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Checkpoint;
      this.checkpoints.set(key, data);
      logger.info({ channel, strategy, lastBlock: data.lastBlockNumber }, 'Loaded checkpoint');
      return data;
    } catch (err) {
      throw new CheckpointError(
        `Failed to load checkpoint for ${channel}/${strategy}`,
        err as Error,
      );
    }
  }

  save(checkpoint: Checkpoint): void {
    const key = this.keyFor(checkpoint.channel, checkpoint.strategy);
    const filePath = this.fileFor(checkpoint.channel, checkpoint.strategy);

    checkpoint.updatedAt = new Date().toISOString();

    try {
      // Atomic write: write to temp file then rename
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      this.checkpoints.set(key, checkpoint);
      this.pending.delete(key);
    } catch (err) {
      throw new CheckpointError(
        `Failed to save checkpoint for ${checkpoint.channel}/${checkpoint.strategy}`,
        err as Error,
      );
    }
  }

  getLastBlockNumber(channel: string, strategy: string): number {
    const cp = this.load(channel, strategy);
    return cp?.lastBlockNumber ?? -1;
  }

  getBookmark(channel: string, strategy: string): string | undefined {
    return this.load(channel, strategy)?.lastBookmark;
  }

  /** Advance a checkpoint and rewrite its file now. */
  updateBlock(channel: string, strategy: string, blockNumber: number): void {
    this.save(this.advanced(channel, strategy, blockNumber));
  }

  /**
   * Advance a checkpoint in memory and leave its file to the next flush().
   *
   * A stringify-write-rename costs ~0.366 ms on a test machine, which is
   * 49 minutes of blocked event loop across an 8M-block walk. Every read goes
   * through the same in-memory map, so within the process the checkpoint is
   * exact either way; what a caller gives up is the last few blocks of a run
   * killed outright, and what it gets back is the ability to order the file
   * write after the records the block number claims (see BlockWalker).
   *
   * @param channel Channel the checkpoint belongs to.
   * @param strategy Extraction strategy whose progress this is.
   * @param blockNumber Last block whose records are all written.
   */
  recordBlock(channel: string, strategy: string, blockNumber: number): void {
    const key = this.keyFor(channel, strategy);
    this.checkpoints.set(key, this.advanced(channel, strategy, blockNumber));
    this.pending.add(key);
  }

  /** Write every checkpoint that recordBlock() advanced since the last flush. */
  flush(): void {
    for (const key of [...this.pending]) {
      const checkpoint = this.checkpoints.get(key);
      if (checkpoint) this.save(checkpoint);
    }
  }

  private advanced(channel: string, strategy: string, blockNumber: number): Checkpoint {
    const existing = this.load(channel, strategy);
    return {
      channel,
      strategy,
      lastBlockNumber: blockNumber,
      lastBookmark: existing?.lastBookmark,
      updatedAt: '',
    };
  }

  updateBookmark(channel: string, strategy: string, bookmark: string): void {
    const existing = this.load(channel, strategy);
    this.save({
      channel,
      strategy,
      lastBlockNumber: existing?.lastBlockNumber ?? -1,
      lastBookmark: bookmark,
      updatedAt: '',
    });
  }
}
