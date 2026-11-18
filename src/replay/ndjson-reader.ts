// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import { scanNdjsonLines } from '../output/ndjson-scan';
import { ExtractionRecord } from '../types';
import { ExtractionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('ndjson-reader');

const VALID_TYPES = new Set([
  'public_state',
  'public_history',
  'block_metadata',
  'private_state',
  'private_history',
  'private_hash',
  'identity',
]);

/** A record together with where its line starts in the file. */
export interface RecordAtOffset<T extends ExtractionRecord = ExtractionRecord> {
  record: T;
  /** Byte offset of the record's line, for `readLineAt`. */
  offset: number;
}

/**
 * Reads NDJSON files as a stream of typed extraction records.
 */
export class NdjsonReader {
  /**
   * Read all records from an NDJSON file.
   *
   * Holds the whole file in memory. Only for files whose size is bounded by
   * something other than the ledger — a manifest, a channel's identities.
   */
  async readAll(filePath: string): Promise<ExtractionRecord[]> {
    const records: ExtractionRecord[] = [];
    for await (const record of this.stream(filePath)) {
      records.push(record);
    }
    return records;
  }

  /**
   * Stream records from an NDJSON file one at a time.
   */
  async *stream(filePath: string): AsyncGenerator<ExtractionRecord> {
    for await (const { record } of this.streamWithOffsets(filePath)) {
      yield record;
    }
  }

  /**
   * Stream records with the byte offset of each one's line.
   *
   * The offsets are what let a caller index a file it cannot hold: remember
   * eight bytes per record now, read the record back with `readLineAt` later.
   * All parsing and validation lives here so that a record reached by offset is
   * the same record this yielded.
   */
  async *streamWithOffsets(filePath: string): AsyncGenerator<RecordAtOffset> {
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'NDJSON file not found — skipping');
      return;
    }

    let lineNum = 0;
    for await (const { offset, bytes } of scanNdjsonLines(filePath)) {
      lineNum++;
      const line = bytes.toString('utf-8');
      if (!line.trim()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new ExtractionError(
          `Malformed NDJSON at ${filePath}:${lineNum}: ` +
            `${(err as Error).message}`,
          err as Error,
        );
      }

      const type =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { _type?: unknown })._type
          : undefined;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof type !== 'string' ||
        !VALID_TYPES.has(type)
      ) {
        throw new ExtractionError(
          `Invalid extraction record at ${filePath}:${lineNum}: ` +
            `expected _type to be one of ${[...VALID_TYPES].join(', ')}, ` +
            `got ${type === undefined ? 'missing' : JSON.stringify(type)}`,
        );
      }

      yield { record: parsed as ExtractionRecord, offset };
    }
  }

  /**
   * Stream records filtered by _type.
   */
  async *streamByType<T extends ExtractionRecord>(
    filePath: string,
    type: T['_type'],
  ): AsyncGenerator<T> {
    for await (const record of this.stream(filePath)) {
      if (record._type === type) {
        yield record as T;
      }
    }
  }

  /**
   * Count records in an NDJSON file without loading them all into memory.
   */
  async count(filePath: string): Promise<number> {
    let count = 0;
    for await (const _ of this.stream(filePath)) {
      count++;
    }
    return count;
  }
}
