import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrivateHashRecord, PrivateStateRecord } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import {
  PrivateCollectionRef,
  comparePrivateCollections,
  indexPrivateFiles,
} from '../output/private-file-index';
import { NdjsonReader } from '../replay/ndjson-reader';
import { ExtractionError } from '../utils/errors';
import { decodeLedgerValue } from '../utils/value-codec';
import { createLogger } from '../utils/logger';
import { runValidation } from '../validation/validation-runner';
import { collectionKey } from './coverage-matrix';
import { MemberInput, membersWithChannel } from './member-inputs';

const logger = createLogger('merge-integrity');

/** The three public files every peer of a channel extracts identically. */
const PUBLIC_FILES = [
  'publicStatePath',
  'publicHistoryPath',
  'blockMetadataPath',
] as const;

/**
 * Refuse to merge a member whose own output does not pass validation.
 *
 * `merge` trusts each input to be internally sound: it copies public files whole,
 * interleaves private history without re-checking its order, and dedupes shared
 * records on position alone. A member that fails `validate` — a truncated block
 * walk, a history file whose blocks go backwards, a private value that does not
 * match its on-chain hash — would carry that defect into the merged directory,
 * where it surfaces only when replay or verify reads it back. Running the same
 * checks here, before a single record is written, turns that latent failure into
 * a refusal that names the member and the check.
 *
 * Only a `fail` stops the merge. `warn` and `skip` are the states a sound
 * lower-tier or partially-authorized extraction legitimately reports — a Tier 1
 * member has no history to check, a member outside a collection's policy has
 * values it could not read — and combining exactly those is what the merge is
 * for.
 *
 * @param members Loaded member inputs.
 * @throws ExtractionError naming each member whose validation failed.
 */
export async function assertInputsValid(members: MemberInput[]): Promise<void> {
  const failed: string[] = [];

  for (const member of members) {
    // Judged against the other members too: a late-joining member never received the values written before it joined,
    // and the merged output is validated whole afterwards.
    const results = await runValidation(member.inputDir, undefined, {
      otherMembers: members.filter((m) => m !== member).map((m) => m.inputDir),
    });
    const failures = results.filter((r) => r.status === 'fail');
    if (failures.length === 0) {
      logger.info({ member: member.label }, 'Member passed validation');
      continue;
    }
    failed.push(
      `  ${member.label} (${member.inputDir}):\n` +
        failures
          .map(
            (f) =>
              `    [FAIL] ${f.check}: ${f.message}` +
              (f.details ? `\n           ${f.details}` : ''),
          )
          .join('\n'),
    );
  }

  if (failed.length === 0) return;

  throw new ExtractionError(
    `${failed.length} member(s) failed validation and cannot be merged. ` +
      'merge copies public files whole and interleaves private records without ' +
      're-checking them, so a failing member would carry its defect into the ' +
      'merged output. Fix or re-extract the member(s) below and merge again:\n' +
      failed.join('\n'),
  );
}

/**
 * Require the records members share on a channel to be identical.
 *
 * Public state, public history, block metadata and private data hashes are all
 * derived from the channel's blocks, which every peer holds alike, so the merge
 * copies the public files from one member and dedupes shared hashes without
 * comparing them. That shortcut is only sound if the members really agree, and a
 * byte-size check — the comparison this replaces — cannot establish it: the state
 * accumulator emits reconstructed public state in different orders on different
 * members (a LevelDB accumulator walks keys in key order, the in-memory one keeps
 * first-write order), so equal files differ in bytes while unequal ones can share
 * a length. The records are compared as an order-insensitive multiset of their
 * canonical JSON, which accepts the reordering and still rejects a member holding
 * a different record.
 *
 * Private state is deliberately excluded: its values differ between members by
 * design, since each holds only what its MSP was authorized to read. Only the
 * public-by-construction artifacts are compared.
 *
 * Members that never extracted a file are skipped — a Tier 1 member has no
 * history or hashes to disagree about.
 *
 * @param reader Shared NDJSON reader.
 * @param members Loaded member inputs.
 * @param channelIds Channels to compare.
 * @throws ExtractionError naming the file and the members that disagree.
 */
export async function assertSharedRecordsAgree(
  reader: NdjsonReader,
  members: MemberInput[],
  channelIds: string[],
): Promise<void> {
  const pathOf = new FileLayoutManager('');

  for (const channelId of channelIds) {
    const contributing = membersWithChannel(members, channelId);

    for (const file of PUBLIC_FILES) {
      await assertFileRecordsAgree(
        reader, contributing, channelId, pathOf[file](channelId),
      );
    }

    for (const ref of await discoverHashCollections(
      reader, contributing, channelId,
    )) {
      await assertFileRecordsAgree(
        reader,
        contributing,
        channelId,
        pathOf.privateHashesPath(channelId, ref.chaincode, ref.collection),
      );
    }
  }
}

/**
 * Cross-check every extracted private value against the on-chain hash for its
 * key, across members, before any record is written.
 *
 * Hashes are public channel data every peer records identically; private values
 * are what only an authorized member could read. The merge combines one member's
 * values with the whole set of hashes, so this is where a value from member A can
 * first be checked against the hash member B recorded for the same key. A
 * mismatch means the value does not match what the ledger committed — a stale or
 * corrupt extraction — and merging it would write a value into the destination
 * that never existed on chain.
 *
 * The comparison mirrors `validate`'s per-member hash cross-check: the value
 * bytes are hashed exactly as extracted and compared against the latest hashed
 * write for the key. A key with no hash on chain, or whose latest write was a
 * delete, has nothing to check against and is skipped.
 *
 * @param reader Shared NDJSON reader.
 * @param members Loaded member inputs.
 * @param channelIds Channels to check.
 * @throws ExtractionError listing every key whose value contradicts its hash.
 */
export async function assertPrivateHashesMatchValues(
  reader: NdjsonReader,
  members: MemberInput[],
  channelIds: string[],
): Promise<void> {
  const pathOf = new FileLayoutManager('');
  const mismatches: string[] = [];

  for (const channelId of channelIds) {
    const contributing = membersWithChannel(members, channelId);
    for (const ref of await discoverHashCollections(
      reader, contributing, channelId,
    )) {
      const latest = await latestHashes(reader, contributing, channelId, ref, pathOf);
      if (latest.size === 0) continue;
      await collectValueMismatches(
        reader, contributing, channelId, ref, pathOf, latest, mismatches,
      );
    }
  }

  if (mismatches.length === 0) return;

  throw new ExtractionError(
    `${mismatches.length} extracted private value(s) do not match the hash ` +
      'the ledger recorded for their key. A merged value that contradicts its ' +
      'on-chain hash never committed as extracted — the member that produced it ' +
      'is stale or corrupt. Re-extract the affected collection(s) before ' +
      'merging:\n' +
      mismatches.map((m) => `  ${m}`).join('\n'),
  );
}

/** Latest hashed write per key hash, unioned across every member's hash file. */
async function latestHashes(
  reader: NdjsonReader,
  members: MemberInput[],
  channelId: string,
  ref: PrivateCollectionRef,
  pathOf: FileLayoutManager,
): Promise<Map<string, LatestHash>> {
  const relative = pathOf.privateHashesPath(
    channelId, ref.chaincode, ref.collection,
  );
  const latest = new Map<string, LatestHash>();

  for (const member of members) {
    const from = path.join(member.inputDir, relative);
    if (!hasContent(from)) continue;
    for await (const record of reader.stream(from)) {
      if (record._type !== 'private_hash') continue;
      const r = record as PrivateHashRecord;
      if (!r.key) continue;
      const previous = latest.get(r.key);
      if (previous && !isLaterWrite(r, previous)) continue;
      latest.set(r.key, {
        hash: r.hash,
        blockNumber: r.blockNumber,
        txIndex: r.txIndex ?? 0,
      });
    }
  }

  return latest;
}

/** Hash each member's extracted values and record any that miss their hash. */
async function collectValueMismatches(
  reader: NdjsonReader,
  members: MemberInput[],
  channelId: string,
  ref: PrivateCollectionRef,
  pathOf: FileLayoutManager,
  latest: Map<string, LatestHash>,
  mismatches: string[],
): Promise<void> {
  const relative = pathOf.privateStatePath(
    channelId, ref.chaincode, ref.collection,
  );

  for (const member of members) {
    const from = path.join(member.inputDir, relative);
    if (!hasContent(from)) continue;
    for await (const record of reader.stream(from)) {
      if (record._type !== 'private_state') continue;
      const r = record as PrivateStateRecord;
      const expected = latest.get(sha256Hex(r.key));
      // No hash for the key, or its latest write was a delete: nothing to
      // check the value against.
      if (!expected || !expected.hash) continue;
      const actual = sha256Hex(decodeLedgerValue(r));
      if (actual === expected.hash) continue;
      mismatches.push(
        `${channelId}/${ref.chaincode}/${ref.collection}/${r.key} ` +
          `(value from ${member.label})`,
      );
    }
  }
}

/** Latest hashed write for one key: its value hash and ledger position. */
interface LatestHash {
  /** Value hash the peer recorded; empty for a delete. */
  hash: string;
  blockNumber: number;
  txIndex: number;
}

function isLaterWrite(record: PrivateHashRecord, previous: LatestHash): boolean {
  if (record.blockNumber !== previous.blockNumber) {
    return record.blockNumber > previous.blockNumber;
  }
  return (record.txIndex ?? 0) >= previous.txIndex;
}

/**
 * The `(chaincode, collection)` pairs any contributing member has a hash file
 * for, ordered so refusals are reproducible.
 */
async function discoverHashCollections(
  reader: NdjsonReader,
  members: MemberInput[],
  channelId: string,
): Promise<PrivateCollectionRef[]> {
  const found = new Map<string, PrivateCollectionRef>();

  for (const member of members) {
    const layout = new FileLayoutManager(member.inputDir);
    for (const { chaincode, collection } of await indexPrivateFiles(
      reader, layout, channelId, '-hashes.ndjson',
    )) {
      found.set(collectionKey(chaincode, collection), { chaincode, collection });
    }
  }

  return [...found.values()].sort(comparePrivateCollections);
}

/**
 * Require the members that hold one file to hold the same records in it.
 *
 * @param relative Path within a member directory the file lives at.
 * @throws ExtractionError naming the file and the first pair that disagree.
 */
async function assertFileRecordsAgree(
  reader: NdjsonReader,
  members: MemberInput[],
  channelId: string,
  relative: string,
): Promise<void> {
  const name = path.basename(relative);
  const present: Array<{ member: string; records: Map<string, number> }> = [];

  for (const member of members) {
    const from = path.join(member.inputDir, relative);
    if (!hasContent(from)) continue;
    present.push({ member: member.label, records: await multisetOf(reader, from) });
  }

  if (present.length <= 1) return;

  const [first, ...rest] = present;
  for (const other of rest) {
    const diff = firstDifference(first.records, other.records);
    if (!diff) continue;
    throw new ExtractionError(
      `Members disagree on ${channelId}/${name}: ${first.member} and ` +
        `${other.member} hold different records (${diff}). These files are ` +
        'derived from the channel blocks, which every peer holds alike, so a ' +
        'difference means the members did not extract the same blocks — compare ' +
        'their checkpoints and re-extract before merging.',
    );
  }
}

/** Count each record's canonical JSON, so field and line order do not matter. */
async function multisetOf(
  reader: NdjsonReader,
  fullPath: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for await (const record of reader.stream(fullPath)) {
    const key = canonicalJson(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Describe the first record whose count differs between two multisets. */
function firstDifference(
  a: Map<string, number>,
  b: Map<string, number>,
): string | undefined {
  for (const [record, count] of a) {
    const other = b.get(record) ?? 0;
    if (other !== count) return describeCount(record, count, other);
  }
  for (const [record, count] of b) {
    if (!a.has(record)) return describeCount(record, 0, count);
  }
  return undefined;
}

function describeCount(record: string, a: number, b: number): string {
  const excerpt = record.length > 120 ? `${record.slice(0, 120)}…` : record;
  return `e.g. ${excerpt} appears ${a}× vs ${b}×`;
}

/** Canonical JSON: object keys sorted recursively, arrays left in order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** True when a file exists and holds at least one byte. */
function hasContent(fullPath: string): boolean {
  return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
}
