import * as fs from 'fs';
import { createLogger } from '../../utils/logger';

const logger = createLogger('newest-hash-block');

/**
 * Bytes read from the end of a hashes file to find its last record.
 *
 * A private hash record is a few hundred bytes of fixed fields, so this holds
 * tens of them. Only the last complete line is parsed, so the window only has
 * to be larger than one record.
 */
const TAIL_BYTES = 8192;

/**
 * Read the highest block number a private hashes file records.
 *
 * The block walk processes blocks in strict ascending order and appends as it
 * goes — only the network fetches overlap, see `BlockWalker.walkWithPrefetch` —
 * so the file's last record holds its highest block. That makes this a tail read
 * rather than a scan of a file that can run to gigabytes, and it stays correct
 * across a resumed run, which appends higher blocks to the same file.
 *
 * @param fullPath Absolute path to a private hashes NDJSON file.
 * @returns The last record's `blockNumber`, or `undefined` when the file is
 *   missing or empty, or its last line does not parse as a record with one.
 */
export function readNewestHashBlock(fullPath: string): number | undefined {
  let fd: number | undefined;
  try {
    const size = fs.statSync(fullPath).size;
    // An early-out, not a correctness guard: a zero-length read would yield no
    // lines and return undefined anyway. It saves opening a file with nothing
    // in it, which is what an untouched collection leaves behind.
    if (size === 0) return undefined;

    const length = Math.min(TAIL_BYTES, size);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(fullPath, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);

    return blockNumberOfLastLine(buffer.toString('utf-8'));
  } catch (err) {
    // Not fatal: an unreadable newest block leaves the coverage reason as it
    // was, which is why this is reported rather than swallowed or thrown.
    logger.warn(
      { path: fullPath, error: (err as Error).message },
      'Could not read the newest hash block — the purge horizon will not be ' +
        'checked against it for this collection',
    );
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Parse the `blockNumber` out of the last complete line of a tail.
 *
 * Only the last line is parsed. When the tail starts mid-file its first line is
 * a fragment, and a fragment that happened to parse would report a block from
 * the wrong record.
 */
function blockNumberOfLastLine(tail: string): number | undefined {
  const lines = tail.split('\n').filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;

  const parsed = JSON.parse(last) as { blockNumber?: unknown };
  return typeof parsed.blockNumber === 'number' ? parsed.blockNumber : undefined;
}
