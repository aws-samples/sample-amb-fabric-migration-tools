// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChaincodeInfo,
  ChannelInfo,
  ChannelMetadata,
  ExtractionRecord,
  IdentityRecord,
  Manifest,
  MergedMember,
  MigrationTier,
  PrivateHashRecord,
  PrivateHistoryRecord,
  PrivateStateRecord,
} from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { NdjsonWriter } from '../output/ndjson-writer';
import { countNdjsonLines } from '../output/ndjson-scan';
import {
  PrivateCollectionRef,
  comparePrivateCollections,
  indexPrivateFiles,
} from '../output/private-file-index';
import { NdjsonReader } from '../replay/ndjson-reader';
import { PrivateCollectionCoverage } from '../extraction/private-data/coverage';
import { PurgeRisk } from '../extraction/private-data/purge-assessor';
import { readNewestHashBlock } from '../extraction/private-data/newest-hash-block';
import { decodeLedgerValue } from '../utils/value-codec';
import { ExtractionError } from '../utils/errors';
import { OrderingViolation } from '../utils/record-ordering';
import { createLogger } from '../utils/logger';
import {
  MemberInput,
  assertMergeable,
  loadMembers,
  membersWithChannel,
  mergedChannelIds,
} from './member-inputs';
import {
  assertInputsValid,
  assertPrivateHashesMatchValues,
  assertSharedRecordsAgree,
} from './merge-integrity';
import { runValidation } from '../validation/validation-runner';
import {
  Contributors,
  CoverageMatrixRow,
  buildCoverageMatrix,
  collectionKey,
  contradictedPurgeClaims,
  coverageDisagreements,
} from './coverage-matrix';
import { LabelledStream, LedgerPositionDedupe, sortMerge } from './sort-merge';

const logger = createLogger('merge');

/** Risk levels worst-first, for collapsing several members' assessments. */
const RISK_ORDER: PurgeRisk['riskLevel'][] = ['high', 'medium', 'low', 'none'];

export interface MergeOptions {
  /** One extraction directory per member. */
  inputDirs: string[];
  /** Directory the merged extraction is written to. Must be empty or absent. */
  outputDir: string;
}

/** One private key whose value differs between members. */
export interface ValueConflict {
  channel: string;
  chaincode: string;
  collection: string;
  key: string;
  /** Member → SHA-256 of its decoded value, base64. */
  digests: Record<string, string>;
  /** Member whose value was kept: the first on the command line to hold it. */
  kept: string;
}

export interface MergedChannelReport {
  channelId: string;
  ledgerHeight: number;
  /** Members that extracted this channel, in command-line order. */
  members: string[];
  /** The cross-member coverage matrix — one row per collection. */
  coverage: CoverageMatrixRow[];
  /** Member the public files were copied from, absent if none had any. */
  publicSource?: string;
  counts: {
    privateState: number;
    privateHistory: number;
    privateHashes: number;
  };
}

export interface MergeReport {
  mergedAt: string;
  outputDir: string;
  members: MergedMember[];
  channels: MergedChannelReport[];
  identities: number;
  /** Private keys whose value differs between members. Any conflict is a stop. */
  conflicts: ValueConflict[];
  /** Everything that needs a human decision but does not stop the merge. */
  warnings: string[];
  /**
   * True when nothing in this report blocks a migration sign-off: no value
   * conflicts, and no collection whose merged coverage reason is unexplained or
   * indeterminate.
   */
  ok: boolean;
}

/**
 * Combine several members' extractions into one directory replay can consume.
 *
 * A peer delivers private data only for the collections its own org belongs to, so
 * each member extracts what its own MSP can see and the outputs are merged afterwards. Private data is the
 * only thing that genuinely differs between members: public state, history and
 * block metadata are identical on every peer of a channel, so they are copied
 * from one member once their equality has been established.
 *
 * Everything the merge depends on is checked rather than documented, because the
 * failure mode being replaced was silent — the hand-rolled `cat` recipe this
 * command supersedes produced a filename replay ignores, so replay wrote zero
 * private records and exited successfully.
 *
 * Four gates run before any record is written: every member is validated as a
 * standalone extraction, the members' shared public and hash records are checked
 * to be identical, and every extracted private value is cross-checked against the
 * on-chain hash for its key. The merged directory is then validated as a whole,
 * and its manifest removed if it fails.
 *
 * The manifest is written last, after every record. A directory left behind by a
 * failed merge therefore has no manifest, which is what every downstream command
 * checks first.
 */
export class MergeRunner {
  /**
   * Path builder for the output directory.
   *
   * Also used to build paths *inside* member directories: every method except
   * `manifestPath` and `listPrivateFiles` returns a path relative to the base
   * directory, so the same instance names the same file under any root.
   */
  private readonly layout: FileLayoutManager;
  private readonly writer: NdjsonWriter;
  private readonly reader = new NdjsonReader();
  private readonly warnings: string[] = [];
  private readonly conflicts: ValueConflict[] = [];
  /** Merged channel views, built once per channel and reused by the manifest. */
  private readonly mergedChannels = new Map<string, ChannelInfo>();

  constructor(private readonly options: MergeOptions) {
    this.layout = new FileLayoutManager(options.outputDir);
    this.writer = new NdjsonWriter(options.outputDir);
  }

  /**
   * Merge every input directory into the output directory.
   *
   * @returns The merge report, also written to `merge-report.json`.
   * @throws ExtractionError if the inputs cannot be merged, before any write.
   */
  async run(): Promise<MergeReport> {
    const members = loadMembers(this.options.inputDirs);
    assertMergeable(members);
    await assertInputsValid(members);
    const channelIds = mergedChannelIds(members);
    await assertSharedRecordsAgree(this.reader, members, channelIds);
    await assertPrivateHashesMatchValues(this.reader, members, channelIds);
    this.assertOutputEmpty();

    logger.info(
      {
        members: members.map((m) => m.label),
        channels: channelIds,
        outputDir: this.options.outputDir,
      },
      'Merging member extractions',
    );

    const channels: MergedChannelReport[] = [];
    let identities = 0;
    try {
      for (const channelId of channelIds) {
        channels.push(await this.mergeChannel(members, channelId));
      }
      identities = await this.mergeIdentities(members);
    } finally {
      await this.writer.close();
    }

    this.writeManifest(members, channelIds);
    const report = this.buildReport(members, channels, identities);
    fs.writeFileSync(
      path.join(this.options.outputDir, 'merge-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8',
    );
    await this.assertMergedOutputValid();
    return report;
  }

  /**
   * Validate the merged directory as a whole, and remove its manifest if it
   * fails.
   *
   * Every input passed validation on its own, but the combination can fail a
   * check none of them did — a private history whose interleaving of two members
   * crossed a block boundary, a coverage gap only visible once every member's
   * view is in one place. Every downstream command opens manifest.json first and
   * refuses a directory without one, so removing it on failure makes an unsound
   * merge unreplayable rather than silently replayable. The records and
   * merge-report.json are left in place for inspection.
   *
   * @throws ExtractionError naming the checks that failed.
   */
  private async assertMergedOutputValid(): Promise<void> {
    const results = await runValidation(this.options.outputDir);
    const failures = results.filter((r) => r.status === 'fail');
    if (failures.length === 0) {
      logger.info('Merged output passed validation');
      return;
    }

    fs.rmSync(this.layout.manifestPath, { force: true });
    throw new ExtractionError(
      `The merged output failed validation, so its manifest has been removed ` +
        `and ${this.options.outputDir} will not replay. ` +
        `${failures.length} check(s) failed:\n` +
        failures
          .map(
            (f) =>
              `  [FAIL] ${f.check}: ${f.message}` +
              (f.details ? `\n         ${f.details}` : ''),
          )
          .join('\n') +
        '\nThe merged records remain on disk for inspection. Delete the ' +
        'directory and merge again once the inputs are corrected.',
    );
  }

  /**
   * Refuse to merge into a directory that already holds files.
   *
   * NDJSON output is opened in append mode, so merging twice into one directory
   * would double every record and leave a manifest that describes neither run.
   */
  private assertOutputEmpty(): void {
    const dir = this.options.outputDir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) return;
    throw new ExtractionError(
      `Output directory ${dir} is not empty (${entries.length} entries). ` +
        'merge appends to NDJSON files, so writing into an existing ' +
        'extraction would double its records. Choose an empty directory or ' +
        'delete this one.',
    );
  }

  private async mergeChannel(
    members: MemberInput[],
    channelId: string,
  ): Promise<MergedChannelReport> {
    const contributing = membersWithChannel(members, channelId);
    const channel = this.mergeChannelInfo(contributing, channelId);
    this.mergedChannels.set(channelId, channel);

    const publicSource = this.copyPublicFiles(contributing, channelId);
    const values: Contributors = new Map();
    const hashes: Contributors = new Map();
    const counts = { privateState: 0, privateHistory: 0, privateHashes: 0 };

    for (const ref of await this.discoverCollections(contributing, channelId)) {
      counts.privateState += await this.mergePrivateState(
        contributing, channelId, ref, values,
      );
      counts.privateHistory += await this.mergePrivateHistory(
        contributing, channelId, ref, values,
      );
      counts.privateHashes += await this.mergePrivateHashes(
        contributing, channelId, ref, hashes,
      );
    }

    // The merged hash files are complete by now, so they can answer the
    // purge-horizon question a private-only member could not.
    const coverage = buildCoverageMatrix(
      contributing, channelId, values, hashes,
      (chaincode, collection) => readNewestHashBlock(path.join(
        this.options.outputDir,
        this.layout.privateHashesPath(channelId, chaincode, collection),
      )),
    );
    this.warnings.push(...coverageDisagreements(coverage));
    this.warnings.push(...contradictedPurgeClaims(coverage));
    await this.writeChannelMetadata(contributing, channel, coverage);

    return {
      channelId,
      ledgerHeight: channel.ledgerHeight,
      members: contributing.map((m) => m.label),
      coverage,
      ...(publicSource ? { publicSource } : {}),
      counts,
    };
  }

  /**
   * Copy the channel's public files from the first member that has each one.
   *
   * `assertSharedRecordsAgree` has already established that the members holding a
   * file hold the same records, so one copy is the merged result. A member that
   * extracted at a lower tier simply has nothing to offer for that file, which
   * is why each file picks its own source.
   *
   * @returns The member the first file came from, for the report.
   */
  private copyPublicFiles(
    members: MemberInput[],
    channelId: string,
  ): string | undefined {
    const relativePaths = [
      this.layout.publicStatePath(channelId),
      this.layout.publicHistoryPath(channelId),
      this.layout.blockMetadataPath(channelId),
    ];
    let source: string | undefined;

    for (const relative of relativePaths) {
      for (const member of members) {
        const from = path.join(member.inputDir, relative);
        if (!hasContent(from)) continue;
        const to = path.join(this.options.outputDir, relative);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        // copyFileSync keeps the source's mode, and a member's files can hold private plaintext.
        fs.chmodSync(to, 0o600);
        source ??= member.label;
        break;
      }
    }

    return source;
  }

  /**
   * The `(chaincode, collection)` pairs with private files in any member's
   * channel directory.
   *
   * Read from the files rather than from the manifests because the files are
   * what the merge has to combine: a collection dropped from a stale manifest
   * still has data on disk, and a manifest entry with no files contributes
   * nothing. Each pair comes from the records inside its file and not from the
   * filename, which `indexPrivateFiles` explains. All three kinds are indexed
   * because a member may hold hashes for a collection it never had values for.
   */
  private async discoverCollections(
    members: MemberInput[],
    channelId: string,
  ): Promise<PrivateCollectionRef[]> {
    const suffixes = ['-state.ndjson', '-history.ndjson', '-hashes.ndjson'];
    const found = new Map<string, PrivateCollectionRef>();

    for (const member of members) {
      const layout = new FileLayoutManager(member.inputDir);
      for (const suffix of suffixes) {
        const targets = await indexPrivateFiles(
          this.reader, layout, channelId, suffix,
        );
        for (const { chaincode, collection } of targets) {
          found.set(collectionKey(chaincode, collection), {
            chaincode, collection,
          });
        }
      }
    }

    return [...found.values()].sort(comparePrivateCollections);
  }

  /**
   * Merge one collection's private state, keeping one record per key.
   *
   * Members that share a collection hold the same values, so the same key
   * arrives once per member and every copy after the first is dropped. Values
   * are compared by digest of the *decoded* bytes: two members may have written
   * one value with different `valueEncoding`, and comparing the encoded form
   * would report that as a conflict.
   *
   * A genuine difference is reported rather than resolved. Two members cannot
   * legitimately hold different values for one key at one ledger height, so a
   * difference means one member's extraction is stale and the merge has no basis
   * for choosing which.
   *
   * @returns Records written.
   */
  private async mergePrivateState(
    members: MemberInput[],
    channelId: string,
    ref: PrivateCollectionRef,
    values: Contributors,
  ): Promise<number> {
    const relative = this.layout.privateStatePath(
      channelId, ref.chaincode, ref.collection,
    );
    const digests = new Map<string, { member: string; digest: string }>();
    const conflicts = new Map<string, ValueConflict>();
    let written = 0;

    for (const member of members) {
      const from = path.join(member.inputDir, relative);
      if (!hasContent(from)) continue;
      for await (const record of this.attributed<PrivateStateRecord>(
        from, ref, 'private_state', member.label, values,
      )) {
        const digest = digestOf(record);
        const seen = digests.get(record.key);
        if (!seen) {
          digests.set(record.key, { member: member.label, digest });
          await this.writer.write(relative, record);
          written++;
          continue;
        }
        if (seen.digest === digest) continue;
        recordConflict(conflicts, record.key, {
          channel: channelId,
          chaincode: record.chaincode,
          collection: record.collection,
          key: record.key,
          digests: { [seen.member]: seen.digest, [member.label]: digest },
          kept: seen.member,
        });
      }
    }

    this.conflicts.push(...conflicts.values());
    if (digests.size > 0) {
      logger.info(
        { channelId, ...ref, keys: digests.size, written },
        'Merged private state',
      );
    }
    return written;
  }

  /**
   * Merge one collection's private history in ledger order.
   *
   * A k-way sort-merge rather than a concatenation: replay applies history in
   * the order it reads it, and `validate` rejects a file whose block numbers go
   * backwards, so appending one member's history to another's would fail both.
   *
   * Duplicates are dropped on position and key without comparing values. Both
   * copies come from the same block's private rwset, so a difference between
   * them would mean a corrupt file rather than a disagreement about the ledger —
   * and the current-state merge above does compare values, so genuine divergence
   * between two members surfaces there.
   *
   * @returns Records written.
   */
  private async mergePrivateHistory(
    members: MemberInput[],
    channelId: string,
    ref: PrivateCollectionRef,
    values: Contributors,
  ): Promise<number> {
    const relative = this.layout.privateHistoryPath(
      channelId, ref.chaincode, ref.collection,
    );
    const streams = this.privateStreams<PrivateHistoryRecord>(
      members, ref, relative, 'private_history', values,
    );
    return this.writeMerged(relative, streams);
  }

  /**
   * Merge one collection's private data hashes in ledger order.
   *
   * @returns Records written.
   */
  private async mergePrivateHashes(
    members: MemberInput[],
    channelId: string,
    ref: PrivateCollectionRef,
    hashes: Contributors,
  ): Promise<number> {
    const relative = this.layout.privateHashesPath(
      channelId, ref.chaincode, ref.collection,
    );
    const streams = this.privateStreams<PrivateHashRecord>(
      members, ref, relative, 'private_hash', hashes,
    );
    return this.writeMerged(relative, streams);
  }

  /**
   * Sort-merge labelled streams into one file, dropping repeated records.
   *
   * @param relative Output path, relative to the output directory.
   * @param streams One stream per member holding the file.
   * @returns Records written.
   */
  private async writeMerged<
    T extends ExtractionRecord & {
      blockNumber: number;
      txIndex: number;
      chaincode: string;
      collection: string;
      key: string;
    },
  >(relative: string, streams: LabelledStream<T>[]): Promise<number> {
    const dedupe = new LedgerPositionDedupe();
    let written = 0;

    for await (const record of sortMerge(streams, this.onViolation)) {
      const id = JSON.stringify([
        record.chaincode, record.collection, record.key,
      ]);
      if (!dedupe.accept(record, id)) continue;
      await this.writer.write(relative, record);
      written++;
    }

    return written;
  }

  /**
   * One labelled stream per member that actually has the file.
   *
   * Contributions are noted here rather than at the merged output, because the
   * merged stream carries no provenance — once records from several members are
   * interleaved there is no way back to which member supplied one. Members
   * without the file are skipped so their absence is not logged as an error.
   */
  private privateStreams<T extends { chaincode: string; collection: string }>(
    members: MemberInput[],
    ref: PrivateCollectionRef,
    relative: string,
    type: ExtractionRecord['_type'],
    contributors: Contributors,
  ): LabelledStream<T>[] {
    const streams: LabelledStream<T>[] = [];

    for (const member of members) {
      const from = path.join(member.inputDir, relative);
      if (!hasContent(from)) continue;
      streams.push({
        source: `${member.label} (${from})`,
        records: this.attributed<T>(from, ref, type, member.label, contributors),
      });
    }

    return streams;
  }

  /**
   * Stream one member's records, noting which collections it contributed to.
   *
   * Every record is checked against the pair whose file this is. One private file
   * holds one `(chaincode, collection)` pair — that is what lets the merge read a
   * member's file by name at all — and a file holding two would be written
   * through to the merged output, recreating across members exactly the mixed
   * file that naming files by chaincode exists to prevent.
   *
   * @throws ExtractionError naming the member, the file and both pairs.
   */
  private async *attributed<T extends { chaincode: string; collection: string }>(
    from: string,
    ref: PrivateCollectionRef,
    type: ExtractionRecord['_type'],
    member: string,
    contributors: Contributors,
  ): AsyncGenerator<T> {
    for await (const record of this.reader.stream(from)) {
      if (record._type !== type) continue;
      const typed = record as unknown as T;
      if (
        typed.chaincode !== ref.chaincode ||
        typed.collection !== ref.collection
      ) {
        throw new ExtractionError(
          `Member ${member}'s ${path.basename(from)} holds a record from ` +
            `chaincode "${typed.chaincode}" collection "${typed.collection}", ` +
            `but that file is chaincode "${ref.chaincode}" collection ` +
            `"${ref.collection}"'s. One private file holds one ` +
            '(chaincode, collection) pair, or nothing downstream can tell its ' +
            `records apart. ${this.options.outputDir} is now incomplete — ` +
            `delete it, re-extract ${member}, and merge again.`,
        );
      }
      this.noteContribution(contributors, typed, member);
      yield typed;
    }
  }

  /**
   * Fail the merge on an input that was not in ledger order.
   *
   * The merge only produces ordered output from ordered input — after yielding a
   * record it cannot take it back — so a misordered input means the output is
   * already wrong. Stopping here leaves a partial directory with no manifest,
   * which is why the message says to delete it.
   */
  private readonly onViolation = (
    source: string,
    violation: OrderingViolation,
  ): never => {
    throw new ExtractionError(
      `Input from ${source} is not in ledger order: block ` +
        `${violation.prevBlock}/tx ${violation.prevTxIndex} is followed by ` +
        `block ${violation.currentBlock}/tx ${violation.currentTxIndex}. ` +
        'A merge of unordered input is unordered, so ' +
        `${this.options.outputDir} is now incomplete — delete it, re-extract ` +
        'that member, and merge again.',
    );
  };

  private noteContribution(
    contributors: Contributors,
    record: { chaincode: string; collection: string },
    member: string,
  ): void {
    const key = collectionKey(record.chaincode, record.collection);
    const existing = contributors.get(key);
    if (existing) {
      existing.add(member);
      return;
    }
    contributors.set(key, new Set([member]));
  }

  /**
   * Merge the members' identity registries.
   *
   * `txCount` is the greatest across members rather than their sum: every member
   * walked the same blocks, so each counted the same transactions, and summing
   * would multiply the count by the number of members.
   *
   * @returns Identity records written.
   */
  private async mergeIdentities(members: MemberInput[]): Promise<number> {
    const merged = new Map<string, IdentityRecord>();

    for (const member of members) {
      const from = path.join(member.inputDir, this.layout.identitiesPath);
      if (!hasContent(from)) continue;
      for await (const record of this.reader.streamByType<IdentityRecord>(
        from, 'identity',
      )) {
        const id = `${record.mspId}:${record.certFingerprint}`;
        const existing = merged.get(id);
        if (!existing) {
          merged.set(id, { ...record });
          continue;
        }
        existing.firstSeenBlock = Math.min(
          existing.firstSeenBlock, record.firstSeenBlock,
        );
        existing.lastSeenBlock = Math.max(
          existing.lastSeenBlock, record.lastSeenBlock,
        );
        existing.txCount = Math.max(existing.txCount, record.txCount);
      }
    }

    const records = [...merged.values()];
    if (records.length > 0) {
      await this.writer.writeBatch(this.layout.identitiesPath, records);
    }
    logger.info({ identities: records.length }, 'Merged identity registry');
    return records.length;
  }

  /**
   * Write the merged manifest.
   *
   * `mspId` is omitted and `mergedFrom` takes its place: no single MSP describes
   * what a merged directory can see, and `validate` has to test a key's absence
   * against every contributing MSP rather than one.
   */
  private writeManifest(members: MemberInput[], channelIds: string[]): void {
    const first = members[0].manifest;
    const versioned = members.find((m) => m.manifest.fabricVersion)?.manifest;

    const manifest: Manifest = {
      networkId: first.networkId,
      memberId: members.map((m) => m.label).join('+'),
      region: first.region,
      // CouchDB if any member's peer ran it: check-chaincode then asks for the CouchDB indexes the application
      // may rely on. Each member's own value is in mergedFrom.
      stateDb: members.some((m) => m.manifest.stateDb === 'CouchDB') ? 'CouchDB' : 'LevelDB',
      extractedAt: new Date().toISOString(),
      mergedFrom: members.map((m) => mergedMember(m)),
      ...(versioned?.fabricVersion
        ? { fabricVersion: versioned.fabricVersion }
        : {}),
      ...(versioned?.fabricCapabilities
        ? { fabricCapabilities: versioned.fabricCapabilities }
        : {}),
      channels: channelIds
        .map((id) => this.mergedChannels.get(id))
        .filter((c): c is ChannelInfo => c !== undefined),
    };

    fs.writeFileSync(
      this.layout.manifestPath,
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  /** Union of the members' views of one channel's chaincodes and collections. */
  private mergeChannelInfo(
    members: MemberInput[],
    channelId: string,
  ): ChannelInfo {
    const chaincodes = new Map<string, ChaincodeInfo>();
    let ledgerHeight = 0;

    for (const member of members) {
      const channel = member.manifest.channels.find(
        (c) => c.channelId === channelId,
      );
      if (!channel) continue;
      ledgerHeight = channel.ledgerHeight;
      for (const cc of channel.chaincodes) {
        const existing = chaincodes.get(cc.name);
        if (!existing) {
          chaincodes.set(cc.name, { ...cc, collections: [...cc.collections] });
          continue;
        }
        this.noteChaincodeDrift(channelId, existing, cc, member.label);
        for (const coll of cc.collections) {
          if (existing.collections.some((c) => c.name === coll.name)) continue;
          existing.collections.push(coll);
        }
      }
    }

    return { channelId, chaincodes: [...chaincodes.values()], ledgerHeight };
  }

  /**
   * Warn when members disagree on a chaincode's definition.
   *
   * Not fatal: a member can be one approved definition behind without its data
   * being wrong, and the ledger-height check already rejects members that walked
   * different blocks. But the merged manifest can only carry one version, so the
   * coordinator has to know it is reading the first member's.
   */
  private noteChaincodeDrift(
    channelId: string,
    kept: ChaincodeInfo,
    other: ChaincodeInfo,
    member: string,
  ): void {
    if (kept.version === other.version && kept.sequence === other.sequence) {
      return;
    }
    this.warnings.push(
      `Members disagree on ${channelId}/${kept.name}: kept version ` +
        `${kept.version} sequence ${kept.sequence}; ${member} reported ` +
        `version ${other.version} sequence ${other.sequence}.`,
    );
  }

  /**
   * Write the merged channel `metadata.json`.
   *
   * `extractedByMspId` is deliberately absent for the same reason the manifest
   * omits `mspId`. `validate` falls back to the manifest when the field is
   * missing, and the manifest carries `mergedFrom`, so the merged directory
   * validates against every contributing MSP instead of one.
   */
  private async writeChannelMetadata(
    members: MemberInput[],
    channel: ChannelInfo,
    coverage: CoverageMatrixRow[],
  ): Promise<void> {
    const channelId = channel.channelId;
    const reported = members
      .map((m) => m.channelMetadata.get(channelId))
      .filter((m): m is Partial<ChannelMetadata> => m !== undefined);
    const gaps = new Set<number>();
    for (const metadata of reported) {
      for (const block of metadata.blocksWithoutMetadata ?? []) {
        gaps.add(block);
      }
    }

    // Carried only when every member that recorded them agrees: replay --since extension reads the last
    // extension's height, and members that extended to different heights leave it to an explicit --since.
    const same = <T>(xs: (T | undefined)[]): T | undefined => {
      const present = xs.filter((x): x is T => x !== undefined);
      return present.length > 0 && present.every((x) => JSON.stringify(x) === JSON.stringify(present[0])) ? present[0] : undefined;
    };
    const walkTip = same(reported.map((m) => m.walkTip));
    const lastExt = reported.map((m) => m.extensions?.[m.extensions.length - 1]);
    const extensions = lastExt.every((e) => e !== undefined) && same(lastExt.map((e) => e && { fromBlock: e.fromBlock, toLedgerHeight: e.toLedgerHeight }))
      ? reported[0].extensions
      : undefined;
    if (!extensions && lastExt.some((e) => e !== undefined)) {
      logger.warn({ channel: channelId }, 'Members extended this channel to different heights: replay --since needs explicit heights');
    }

    const metadata: ChannelMetadata = {
      channelId,
      extractedAt: new Date().toISOString(),
      tier: this.mergedTier(channelId, reported),
      ...(walkTip && { walkTip }),
      ...(extensions && { extensions }),
      strategy: 'merge',
      ledgerHeight: channel.ledgerHeight,
      chaincodes: channel.chaincodes.map((cc) => ({
        name: cc.name,
        version: cc.version,
        collections: cc.collections.length,
      })),
      blocksWithoutMetadata: [...gaps].sort((a, b) => a - b),
      privateDataCoverage: coverage.map((row) =>
        mergedCoverage(row, channel, reported),
      ),
      outputFiles: {
        publicState: await this.countLines(
          this.layout.publicStatePath(channelId),
        ),
        publicHistory: await this.countLines(
          this.layout.publicHistoryPath(channelId),
        ),
        blockMetadata: await this.countLines(
          this.layout.blockMetadataPath(channelId),
        ),
      },
    };

    const metadataPath = path.join(
      this.options.outputDir, this.layout.channelMetadataPath(channelId),
    );
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  /**
   * Highest tier any member reached.
   *
   * The merged directory holds whatever each member captured, so the highest
   * tier describes what is present; labelling it with the lowest would say the
   * history in the directory is not there. A mismatch is still a coordination
   * failure worth surfacing, because the higher tier only covers the collections
   * of the members that reached it.
   */
  private mergedTier(
    channelId: string,
    reported: Partial<ChannelMetadata>[],
  ): MigrationTier {
    const tiers = reported
      .map((m) => m.tier)
      .filter((t): t is MigrationTier => t !== undefined);
    if (tiers.length === 0) return MigrationTier.CurrentState;
    if (new Set(tiers).size > 1) {
      this.warnings.push(
        `Members extracted ${channelId} at different tiers ` +
          `(${[...new Set(tiers)].sort().join(', ')}). The merged output is ` +
          'labelled with the highest, but only the members that reached it ' +
          'contributed history for their own collections.',
      );
    }
    return Math.max(...tiers) as MigrationTier;
  }

  /**
   * Count NDJSON records in a copied public file, which the writer never saw.
   *
   * Streamed rather than read whole: a Tier 3 `public-history.ndjson` can exceed
   * the ~512 MiB ceiling on a single string, and this runs after every record
   * has been merged, so a whole-file read would fail the merge at its last step.
   */
  private async countLines(relativePath: string): Promise<number> {
    const fullPath = path.join(this.options.outputDir, relativePath);
    if (!fs.existsSync(fullPath)) return 0;
    return countNdjsonLines(fullPath);
  }

  private buildReport(
    members: MemberInput[],
    channels: MergedChannelReport[],
    identities: number,
  ): MergeReport {
    const needsAttention = channels.some((c) =>
      c.coverage.some((row) => row.needsAttention),
    );

    return {
      mergedAt: new Date().toISOString(),
      outputDir: this.options.outputDir,
      members: members.map((m) => mergedMember(m)),
      channels,
      identities,
      conflicts: this.conflicts,
      warnings: this.warnings,
      ok: this.conflicts.length === 0 && !needsAttention,
    };
  }
}

/** True when a file exists and holds at least one byte. */
function hasContent(fullPath: string): boolean {
  return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
}

function mergedMember(member: MemberInput): MergedMember {
  return {
    inputDir: member.inputDir,
    memberId: member.label,
    ...(member.manifest.nodeId ? { nodeId: member.manifest.nodeId } : {}),
    ...(member.mspId ? { mspId: member.mspId } : {}),
    stateDb: member.manifest.stateDb,
    extractedAt: member.manifest.extractedAt,
  };
}

/**
 * Collapse one matrix row into the per-collection shape metadata.json carries.
 *
 * `authorized` is omitted on purpose: it means "the extracting MSP is in this
 * policy", and a merged directory has several. The matrix in `merge-report.json`
 * keeps the per-member answer.
 */
function mergedCoverage(
  row: CoverageMatrixRow,
  channel: ChannelInfo,
  reported: Partial<ChannelMetadata>[],
): PrivateCollectionCoverage {
  const declared = channel.chaincodes
    .find((cc) => cc.name === row.chaincode)
    ?.collections.find((c) => c.name === row.collection);
  const theirs = reported
    .flatMap((m) => m.privateDataCoverage ?? [])
    .filter(
      (c) => c.chaincode === row.chaincode && c.collection === row.collection,
    );

  return {
    chaincode: row.chaincode,
    collection: row.collection,
    coverage: row.outcome,
    ...(row.reason ? { reason: row.reason } : {}),
    blockToLive: declared?.blockToLive ?? theirs[0]?.blockToLive ?? 0,
    purgeRisk: worstRisk(theirs.map((c) => c.purgeRisk)),
    estimatedPurgedBlocks: Math.max(
      0, ...theirs.map((c) => c.estimatedPurgedBlocks),
    ),
  };
}

/** SHA-256 of a record's decoded value bytes, so encodings compare equal. */
function digestOf(record: PrivateStateRecord): string {
  return crypto
    .createHash('sha256')
    .update(decodeLedgerValue(record))
    .digest('base64');
}

/** Accumulate digests so a key that differs across three members lists three. */
function recordConflict(
  conflicts: Map<string, ValueConflict>,
  id: string,
  conflict: ValueConflict,
): void {
  const existing = conflicts.get(id);
  if (!existing) {
    conflicts.set(id, conflict);
    return;
  }
  Object.assign(existing.digests, conflict.digests);
}

/** Worst risk level any member assessed, `none` when nobody assessed one. */
function worstRisk(levels: PurgeRisk['riskLevel'][]): PurgeRisk['riskLevel'] {
  for (const level of RISK_ORDER) {
    if (levels.includes(level)) return level;
  }
  return 'none';
}
