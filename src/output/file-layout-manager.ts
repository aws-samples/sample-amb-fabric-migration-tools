// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { ExtractionError } from '../utils/errors';

/**
 * Resolves canonical file paths within the extraction output directory.
 *
 * extraction-output/
 * ├── manifest.json
 * ├── identities.ndjson
 * ├── channel-{channelId}/
 * │   ├── public-state.ndjson
 * │   ├── public-history.ndjson
 * │   ├── block-metadata.ndjson
 * │   ├── private-{chaincode}-{collection}-state.ndjson
 * │   ├── private-{chaincode}-{collection}-history.ndjson
 * │   ├── private-{chaincode}-{collection}-hashes.ndjson
 * │   ├── checkpoints/
 * │   └── metadata.json
 *
 * Private files name the chaincode as well as the collection because a
 * collection name is only unique within a chaincode. On Fabric 2.x every
 * chaincode on a channel holds the same `_implicit_org_<MSPID>` collections, so
 * naming by collection alone wrote every chaincode's private data into one file:
 * at Tier 3 the interleaved block numbers abort replay, and at Tier 1/2
 * `validate` cross-checks one chaincode's values against another's hashes.
 *
 * A private filename identifies a file and is never read back. Fabric admits `-`
 * in both a chaincode name and a collection name, so `private-a-b-c-state.ndjson`
 * has two readings and no parser can choose between them, and `sanitize` is lossy
 * besides. Every private record carries `chaincode` and `collection` verbatim, so
 * consumers take the pair from the records — see `indexPrivateFiles`. That leaves
 * one hole a parser would not have: two distinct pairs can produce the same name.
 * The second claimant is refused rather than silently appended to the first,
 * because a merged file is the collision this layout exists to prevent.
 */
export class FileLayoutManager {
  /**
   * Which `(chaincode, collection)` pair claimed each private filename, keyed by
   * `channelId/filename`. One pair naming its own file repeatedly is normal.
   */
  private readonly privateFileOwners = new Map<string, string>();

  constructor(public readonly baseDir: string) {}

  /** Sanitize a path component to prevent path traversal. */
  private sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
  }

  get manifestPath(): string {
    return path.join(this.baseDir, 'manifest.json');
  }

  get identitiesPath(): string {
    return 'identities.ndjson';
  }

  channelDir(channelId: string): string {
    return `channel-${this.sanitize(channelId)}`;
  }

  publicStatePath(channelId: string): string {
    return path.join(this.channelDir(channelId), 'public-state.ndjson');
  }

  publicHistoryPath(channelId: string): string {
    return path.join(this.channelDir(channelId), 'public-history.ndjson');
  }

  blockMetadataPath(channelId: string): string {
    return path.join(this.channelDir(channelId), 'block-metadata.ndjson');
  }

  /** @throws ExtractionError when another pair already claimed this filename. */
  privateStatePath(
    channelId: string,
    chaincode: string,
    collection: string,
  ): string {
    return this.privatePath(channelId, chaincode, collection, 'state');
  }

  /** @throws ExtractionError when another pair already claimed this filename. */
  privateHistoryPath(
    channelId: string,
    chaincode: string,
    collection: string,
  ): string {
    return this.privatePath(channelId, chaincode, collection, 'history');
  }

  /** @throws ExtractionError when another pair already claimed this filename. */
  privateHashesPath(
    channelId: string,
    chaincode: string,
    collection: string,
  ): string {
    return this.privatePath(channelId, chaincode, collection, 'hashes');
  }

  checkpointDir(channelId: string): string {
    return path.join(this.channelDir(channelId), 'checkpoints');
  }

  channelMetadataPath(channelId: string): string {
    return path.join(this.channelDir(channelId), 'metadata.json');
  }

  /**
   * Name one of a `(chaincode, collection)` pair's three private files.
   *
   * @param kind `state`, `history` or `hashes`.
   * @throws ExtractionError when a different pair already claimed the name.
   */
  private privatePath(
    channelId: string,
    chaincode: string,
    collection: string,
    kind: 'state' | 'history' | 'hashes',
  ): string {
    const file =
      `private-${this.sanitize(chaincode)}-${this.sanitize(collection)}` +
      `-${kind}.ndjson`;
    this.claimPrivateFile(channelId, file, chaincode, collection);
    return path.join(this.channelDir(channelId), file);
  }

  /**
   * Refuse a filename two different pairs would share.
   *
   * Unreachable for the names Fabric produces in practice, and checked anyway:
   * the whole point of naming by chaincode is that one file holds one
   * `(chaincode, collection)` pair, and a name built from two sanitized fields
   * cannot promise that on its own.
   *
   * @throws ExtractionError naming both pairs and the file they share.
   */
  private claimPrivateFile(
    channelId: string,
    file: string,
    chaincode: string,
    collection: string,
  ): void {
    const key = `${channelId}/${file}`;
    const owner = `${chaincode}\x00${collection}`;
    const existing = this.privateFileOwners.get(key);

    if (existing === undefined) {
      this.privateFileOwners.set(key, owner);
      return;
    }
    if (existing === owner) return;

    const [otherChaincode, otherCollection] = existing.split('\x00');
    throw new ExtractionError(
      `Chaincode "${chaincode}" collection "${collection}" and chaincode ` +
        `"${otherChaincode}" collection "${otherCollection}" both resolve to ` +
        `${file} on channel ${channelId}. One file cannot hold both, and their ` +
        'records would be indistinguishable in it. Rename one collection at the ' +
        'source, or extract the two chaincodes into separate output directories.',
    );
  }

  /**
   * List private-data NDJSON files in a channel directory,
   * filtered by suffix (e.g. '.ndjson', '-state.ndjson').
   * Returns filenames only (not full paths).
   */
  listPrivateFiles(
    channelId: string,
    suffix: string,
  ): string[] {
    const dir = path.join(
      this.baseDir,
      this.channelDir(channelId),
    );
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(
        (f) =>
          f.startsWith('private-') && f.endsWith(suffix),
      )
      .sort();
  }
}
