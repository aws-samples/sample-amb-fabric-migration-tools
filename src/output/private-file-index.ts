import * as path from 'path';
import { NdjsonReader } from '../replay/ndjson-reader';
import { createLogger } from '../utils/logger';
import { FileLayoutManager } from './file-layout-manager';

const logger = createLogger('private-file-index');

/**
 * A `(chaincode, collection)` pair, which is what identifies a private
 * collection: a collection name is only unique within one chaincode.
 */
export interface PrivateCollectionRef {
  chaincode: string;
  collection: string;
}

/** A private-data file and the `(chaincode, collection)` pair it holds. */
export interface PrivateFileTarget extends PrivateCollectionRef {
  /** Filename within the channel directory, not a full path. */
  file: string;
}

/**
 * Identify each of a channel's private-data files by reading its first record.
 *
 * The filename is deliberately not parsed. `private-{chaincode}-{collection}`
 * cannot be split back into its two halves — Fabric admits `-` in both names, so
 * `private-a-b-c-state.ndjson` has two readings — and the sanitizer that built it
 * is lossy besides. Every private record carries `chaincode` and `collection`
 * verbatim, and one file holds one pair, so the first record settles it.
 *
 * One record is read per file rather than all of them: the callers that need the
 * whole file stream it themselves, and the ones that only need to know what is on
 * disk should not pay for a full pass.
 *
 * @param reader Shared NDJSON reader; malformed records abort indexing.
 * @param layout Layout rooted at the directory to index.
 * @param channelId Channel whose directory is read.
 * @param suffix Which of the three files to index, e.g. '-state.ndjson'.
 * @returns One target per file that holds at least one named record, ordered by
 *   `(chaincode, collection)` so reports built from it are reproducible. Empty
 *   files yield nothing, which is what "this collection has no data" looks like
 *   on disk.
 */
export async function indexPrivateFiles(
  reader: NdjsonReader,
  layout: FileLayoutManager,
  channelId: string,
  suffix: string,
): Promise<PrivateFileTarget[]> {
  const channelDir = path.join(layout.baseDir, layout.channelDir(channelId));
  const targets: PrivateFileTarget[] = [];

  for (const file of layout.listPrivateFiles(channelId, suffix)) {
    const filePath = path.join(channelDir, file);
    const named = await firstNamedRecord(reader, filePath);
    if (!named) {
      logger.debug({ filePath }, 'Private file names no chaincode — skipping');
      continue;
    }
    targets.push({ file, ...named });
  }

  return targets.sort(comparePrivateCollections);
}

/** Order pairs by chaincode then collection, so reports are reproducible. */
export function comparePrivateCollections(
  a: PrivateCollectionRef,
  b: PrivateCollectionRef,
): number {
  return (
    a.chaincode.localeCompare(b.chaincode) ||
    a.collection.localeCompare(b.collection)
  );
}

/**
 * The `(chaincode, collection)` pair named by a file's first usable record.
 *
 * @returns `undefined` for a file with no records, or none carrying both fields.
 */
async function firstNamedRecord(
  reader: NdjsonReader,
  filePath: string,
): Promise<{ chaincode: string; collection: string } | undefined> {
  let records = 0;

  for await (const record of reader.stream(filePath)) {
    records++;
    const named = record as { chaincode?: string; collection?: string };
    if (named.chaincode && named.collection) {
      return { chaincode: named.chaincode, collection: named.collection };
    }
  }

  if (records > 0) {
    logger.warn(
      { filePath, records },
      'Private file holds records that name no chaincode and collection — it ' +
        'cannot be attributed and is left out',
    );
  }
  return undefined;
}
