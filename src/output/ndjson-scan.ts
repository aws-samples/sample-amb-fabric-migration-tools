// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';

/**
 * Byte-level scanning of the NDJSON files this toolkit writes.
 *
 * Lives beside {@link NdjsonWriter} because it is the inverse of what that
 * writes: a file of newline-separated records, one per line, of unbounded total
 * size. Everything here works in bytes and never holds more than one line, which
 * is the difference between reading a tier-3 output and `ERR_STRING_TOO_LONG` —
 * Node refuses any string over about 512 MiB, so `readFileSync(path, 'utf-8')`
 * cannot see a file this tool can produce.
 */

const NEWLINE = 0x0a;

/** Bytes read per `readLineAt` attempt. One read covers all but huge values. */
const READ_CHUNK_BYTES = 64 * 1024;

/** One line of an NDJSON file, with where in the file it starts. */
export interface ScannedLine {
  /** Byte offset of the line's first byte, for {@link readLineAt}. */
  offset: number;
  /** The line's bytes, without its terminating newline. */
  bytes: Buffer;
}

/**
 * Yield every line of a file, in order, holding one line at a time.
 *
 * Splits on the newline *byte*, which is safe for any encoding this tool
 * writes: UTF-8 never uses 0x0A inside a multi-byte sequence. A line that
 * straddles two reads is joined before it is yielded, so a caller never sees
 * half a record.
 *
 * Empty lines are yielded too — a caller that wants records filters them, and a
 * caller reporting a line number needs them counted. A file's final newline
 * does not produce a trailing empty line.
 *
 * @param filePath File to read. Must exist.
 */
export async function* scanNdjsonLines(
  filePath: string,
): AsyncGenerator<ScannedLine> {
  const stream = fs.createReadStream(filePath);

  /** Absolute offset of the current chunk's first byte. */
  let base = 0;
  /** Absolute offset where the line now being assembled began. */
  let lineStart = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let pos = 0;
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, pos);
      if (nl === -1) {
        if (pos < chunk.length) {
          const tail = chunk.subarray(pos);
          pending.push(tail);
          pendingBytes += tail.length;
        }
        break;
      }

      const head = chunk.subarray(pos, nl);
      yield {
        offset: lineStart,
        bytes: pendingBytes === 0 ? head : Buffer.concat([...pending, head]),
      };
      pending = [];
      pendingBytes = 0;
      lineStart = base + nl + 1;
      pos = nl + 1;
    }
    base += chunk.length;
  }

  if (pendingBytes > 0) {
    yield { offset: lineStart, bytes: Buffer.concat(pending) };
  }
}

/**
 * Count the records in an NDJSON file without loading it.
 *
 * Blank lines are not counted, which is what makes this a record count rather
 * than a line count.
 *
 * @param filePath File to count. Must exist.
 */
export async function countNdjsonLines(filePath: string): Promise<number> {
  let count = 0;
  for await (const line of scanNdjsonLines(filePath)) {
    if (line.bytes.length > 0) count++;
  }
  return count;
}

/**
 * Read back the one line that starts at `offset`.
 *
 * The point of it is to let a caller remember where a record is instead of what
 * it holds: an offset is eight bytes whatever the value's size, so an index over
 * a whole file costs a fixed amount per record rather than the file's own bytes.
 *
 * @param fd Open descriptor on the file the offset came from.
 * @param offset Byte offset of the line's first byte, from
 *   {@link scanNdjsonLines}.
 * @param scratch Reusable buffer of at least one byte, owned by the caller so
 *   that reading many lines does not allocate one buffer per line.
 * @returns The line's text, without its terminating newline.
 */
export function readLineAt(fd: number, offset: number, scratch: Buffer): string {
  const parts: Buffer[] = [];
  let pos = offset;

  for (;;) {
    const read = fs.readSync(fd, scratch, 0, scratch.length, pos);
    if (read === 0) break;

    const chunk = scratch.subarray(0, read);
    const nl = chunk.indexOf(NEWLINE);
    if (nl !== -1) {
      parts.push(Buffer.from(chunk.subarray(0, nl)));
      break;
    }

    parts.push(Buffer.from(chunk));
    pos += read;
  }

  return Buffer.concat(parts).toString('utf-8');
}

/** A scratch buffer sized for {@link readLineAt}. */
export function lineReadBuffer(): Buffer {
  return Buffer.allocUnsafe(READ_CHUNK_BYTES);
}
