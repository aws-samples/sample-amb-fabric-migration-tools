import * as fs from 'fs';
import * as path from 'path';
import { ExtractionRecord } from '../types';
import { ExtractionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('ndjson-writer');

export class NdjsonWriter {
  private streams = new Map<string, fs.WriteStream>();
  private fds = new Map<string, number>();
  private recordCounts = new Map<string, number>();
  private streamErrors = new Map<string, Error>();
  private truncating = new Set<string>();

  constructor(private readonly baseDir: string) {}

  getBaseDir(): string {
    return this.baseDir;
  }

  async write(filePath: string, record: ExtractionRecord): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath);
    this.assertWritable(fullPath);
    const stream = this.getOrCreateStream(fullPath);
    const line = JSON.stringify(record) + '\n';

    const ok = stream.write(line, 'utf-8');
    this.recordCounts.set(fullPath, (this.recordCounts.get(fullPath) ?? 0) + 1);
    if (!ok) {
      await this.awaitDrain(fullPath, stream);
    }
  }

  async writeBatch(filePath: string, records: ExtractionRecord[]): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath);
    this.assertWritable(fullPath);
    const stream = this.getOrCreateStream(fullPath);
    const chunk = records.map((r) => JSON.stringify(r)).join('\n') + '\n';

    const ok = stream.write(chunk, 'utf-8');
    this.recordCounts.set(fullPath, (this.recordCounts.get(fullPath) ?? 0) + records.length);
    if (!ok) {
      await this.awaitDrain(fullPath, stream);
    }
  }

  /**
   * Wait for a backpressured write's chunk to be flushed.
   *
   * Every listener comes off again whichever event fires. A stream here outlives
   * the write by the whole extraction — one per output file — so a listener left
   * behind by each backpressured write accumulates until Node warns at ten and
   * then keeps accumulating, on the tall-ledger runs that backpressure at all.
   *
   * Three events, because a write that never drains has to fail rather than
   * wait: `'error'` is the stream failing under it, and `'close'` is
   * `discardStream()` taking the stream away with the write still pending, which
   * emits neither `'drain'` nor `'error'` and would otherwise hang the walk.
   *
   * @param fullPath Absolute path being written to, for the failure message.
   * @param stream The file's write stream, already holding the chunk.
   */
  private awaitDrain(fullPath: string, stream: fs.WriteStream): Promise<void> {
    return new Promise((resolve, reject) => {
      const onDrain = () => settle(resolve);
      const onError = (err: Error) => settle(() => reject(err));
      const onClose = () =>
        settle(() =>
          reject(
            new ExtractionError(
              `NDJSON stream for ${fullPath} closed while a record was waiting to ` +
                'drain, so the record was discarded.',
            ),
          ),
        );

      function settle(outcome: () => void): void {
        stream.removeListener('drain', onDrain);
        stream.removeListener('error', onError);
        stream.removeListener('close', onClose);
        outcome();
      }

      stream.on('drain', onDrain);
      stream.on('error', onError);
      stream.on('close', onClose);
    });
  }

  getRecordCount(filePath: string): number {
    const fullPath = path.join(this.baseDir, filePath);
    return this.recordCounts.get(fullPath) ?? 0;
  }

  /**
   * Reject a write that cannot be honoured, rather than accepting it silently.
   *
   * Two cases: a previous write to this path failed, or a `truncate()` of this
   * path is in flight and would discard whatever is written now.
   *
   * @param fullPath Absolute path being written to.
   */
  private assertWritable(fullPath: string): void {
    const storedError = this.streamErrors.get(fullPath);
    if (storedError) {
      throw storedError;
    }
    if (this.truncating.has(fullPath)) {
      throw new ExtractionError(
        `Cannot write to ${fullPath} while it is being truncated — the record ` +
          'would be discarded. Await truncate() before writing.',
      );
    }
  }

  /**
   * Flush and close every stream, then surface any write that failed.
   *
   * A stream error is latched by the 'error' handler rather than thrown at the
   * `write()` that caused it: `write()` resolves as soon as the chunk is
   * accepted into the stream's buffer, long before the descriptor sees it. The
   * next write to the same path rethrows the latched error, but the *last*
   * write to a path has no successor — so close() is the only place a failure
   * on the final batch can still be reported.
   *
   * @throws The first latched stream error, after closing every stream.
   */
  async close(): Promise<void> {
    await this.closeStreams([...this.streams.keys()], [...this.streamErrors.keys()]);
  }

  /**
   * Flush, sync and close every stream under one directory, as `close()` does
   * for all of them, so that directory's files can be committed while other
   * directories are still being written.
   *
   * @param relativeDir Directory relative to the writer's base directory.
   * @throws The first latched error of a file under that directory.
   */
  async closeDir(relativeDir: string): Promise<void> {
    const prefix = path.join(this.baseDir, relativeDir) + path.sep;
    const under = (p: string): boolean => p.startsWith(prefix);
    await this.closeStreams([...this.streams.keys()].filter(under), [...this.streamErrors.keys()].filter(under));
  }

  private async closeStreams(paths: string[], errorPaths: string[]): Promise<void> {
    // Out of syncAll()'s reach first: other channels' walks keep calling it,
    // and these descriptors close (and their numbers can be reused) below.
    const fds = new Map(paths.map((p) => [p, this.fds.get(p)]));
    for (const filePath of paths) this.fds.delete(filePath);
    const closePromises = paths.map(
      (filePath) => {
        const stream = this.streams.get(filePath)!;
        return new Promise<void>((resolve, reject) => {
          logger.info({ filePath, records: this.recordCounts.get(filePath) ?? 0 }, 'Closing NDJSON stream');
          // A stream that already errored is destroyed and its descriptor is
          // closed; end() would neither call back nor emit, hanging close().
          if (stream.destroyed) {
            resolve();
            return;
          }
          const fd = fds.get(filePath);
          stream.end(() => {
            try {
              // `finish` means Node has drained its buffers to the descriptor.
              // Sync now, not before end(), so a completion marker cannot
              // survive a host crash ahead of the final buffered records.
              if (fd !== undefined) fs.fsyncSync(fd);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          stream.once('error', reject);
        });
      },
    );
    const settled = await Promise.allSettled(closePromises);
    for (const filePath of paths) this.streams.delete(filePath);

    this.assertNoStreamErrors(settled, errorPaths);
  }

  /**
   * Throw if any write failed, so extraction cannot exit 0 with records
   * missing from disk.
   *
   * Latched errors are preferred over close() rejections: they name the write
   * that actually failed, whereas a close() rejection may be a downstream
   * effect of the same fault.
   *
   * @param settled Outcomes of the per-stream close promises.
   * @param errorPaths Files whose latched errors this close reports.
   */
  private assertNoStreamErrors(settled: PromiseSettledResult<void>[], errorPaths: string[]): void {
    const filePath = errorPaths[0];
    if (filePath !== undefined) {
      const err = this.streamErrors.get(filePath)!;
      throw new ExtractionError(
        `NDJSON write to ${filePath} failed, so the extraction on disk is ` +
          `incomplete and must not be replayed: ${err.message}`,
        err,
      );
    }

    const rejected = settled.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
  }

  /**
   * Fsync all open NDJSON streams to ensure data is flushed to disk.
   * Called periodically during block walks to bound data loss on OS crash.
   */
  syncAll(): void {
    for (const [filePath, fd] of this.fds) {
      try {
        fs.fsyncSync(fd);
      } catch (err) {
        logger.warn({ path: filePath, error: (err as Error).message }, 'fsync failed');
      }
    }
  }

  /**
   * Truncate a file to zero length, discarding whatever was written before.
   *
   * Used when a checkpoint is reset and the file's contents are about to be
   * re-derived from block 0: streams open in append mode, so without this the
   * re-derived records land after the abandoned attempt's records.
   *
   * Any open stream for the file is destroyed first. Truncating its descriptor
   * in place would not work: `write()` resolves once a record is in the
   * stream's buffer, so records accepted before the truncate would still be
   * flushed to the file afterwards.
   *
   * Writes to this path must be awaited before calling this, and none may be
   * issued until it resolves: a write accepted inside that window would be
   * discarded. `write()` and `writeBatch()` throw rather than allow it.
   *
   * @param filePath Path relative to the writer's base directory.
   */
  async truncate(filePath: string): Promise<void> {
    const fullPath = path.join(this.baseDir, filePath);
    this.truncating.add(fullPath);

    try {
      await this.discardStream(fullPath);
      if (fs.existsSync(fullPath)) {
        fs.truncateSync(fullPath, 0);
      }

      this.recordCounts.set(fullPath, 0);
      this.streamErrors.delete(fullPath);
    } finally {
      this.truncating.delete(fullPath);
    }
  }

  /**
   * Close a file's stream without flushing its buffered records.
   *
   * Resolves once the descriptor is closed, so no write can still be in
   * flight. The next write to this path reopens the file.
   *
   * @param fullPath Absolute path of the file to abandon.
   */
  private async discardStream(fullPath: string): Promise<void> {
    const stream = this.streams.get(fullPath);
    if (!stream) return;

    this.streams.delete(fullPath);
    this.fds.delete(fullPath);

    // An errored stream is already destroyed and has already emitted 'close';
    // waiting for another would never resolve, and destroy() is a no-op.
    if (stream.destroyed) return;

    await new Promise<void>((resolve) => {
      stream.once('close', resolve);
      stream.destroy();
    });
  }

  private getOrCreateStream(fullPath: string): fs.WriteStream {
    let stream = this.streams.get(fullPath);
    if (!stream) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      // Own the descriptor rather than letting createWriteStream open it:
      // stream.fd stays null until the async 'open' event fires, which would
      // make syncAll() a silent no-op for any freshly created stream.
      const fd = fs.openSync(fullPath, 'a');
      stream = fs.createWriteStream(fullPath, { fd, encoding: 'utf-8' });
      stream.on('error', (err) => {
        logger.error({ path: fullPath, error: err.message }, 'NDJSON write stream error');
        if (!this.streamErrors.has(fullPath)) {
          this.streamErrors.set(fullPath, err);
        }
        // autoDestroy has closed the descriptor. Leaving it registered makes
        // every later syncAll() fail with EBADF on a file already lost.
        this.fds.delete(fullPath);
      });
      this.streams.set(fullPath, stream);
      this.fds.set(fullPath, fd);
    }
    return stream;
  }
}
