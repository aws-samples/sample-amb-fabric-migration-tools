// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CoverageReason,
  PrivateCollectionCoverage,
  blocksSignOff,
  classifyCoverageReason,
  mostSevereReason,
} from '../extraction/private-data/coverage';
import { MemberInput, isPrivateOnly } from './member-inputs';

/** What one member reported for one collection, from its metadata.json. */
export interface MemberCoverage {
  member: string;
  coverage: PrivateCollectionCoverage['coverage'];
  reason?: CoverageReason;
  authorized?: boolean;
}

/** One row of the cross-member coverage matrix. */
export interface CoverageMatrixRow {
  chaincode: string;
  collection: string;
  /**
   * What the merged directory holds, read from the merged records rather than
   * from any member's self-report.
   */
  outcome: PrivateCollectionCoverage['coverage'];
  /**
   * Why the merged outcome is not `values`, collapsed across members.
   *
   * Absent when values were merged: one member holding the values means the
   * merged extraction holds them. Whether every *key* arrived is a different
   * question, and the one `validate` answers against `mergedFrom`.
   */
  reason?: CoverageReason;
  /** Members that contributed plaintext values, from state or history. */
  contributedValues: string[];
  /** Members that contributed hashes, whether or not they had values. */
  contributedHashes: string[];
  /** Per-member self-report, for members that shipped a metadata.json. */
  byMember: MemberCoverage[];
  /** True when `reason` stops a sign-off — see `blocksSignOff`. */
  needsAttention: boolean;
}

/** Which members contributed records, keyed by `collectionKey`. */
export type Contributors = Map<string, Set<string>>;

/** Highest block of any merged hash for a collection, if one can be read. */
export type NewestHashBlock = (
  chaincode: string,
  collection: string,
) => number | undefined;

/**
 * Separator between the two halves of a collection key.
 *
 * Fabric restricts chaincode and collection names to `[A-Za-z0-9_-]`, so a
 * colon cannot occur inside either half and splitting on it is unambiguous.
 * Same `chaincode:collection` spelling the extractor's delivery summary uses.
 */
const KEY_SEP = ':';

/** Identifies a collection within a channel, since two chaincodes may share a name. */
export function collectionKey(chaincode: string, collection: string): string {
  return `${chaincode}${KEY_SEP}${collection}`;
}

/**
 * Build the cross-member coverage matrix for one channel.
 *
 * This is the artifact a migration coordinator makes the go/no-go call from: it
 * answers "does the combined extraction hold this collection, and if not, has
 * anyone established why" in one row per collection. Neither question can be
 * answered from a single member's output, because a collection one member cannot
 * see is routine and a collection *no* member can see is a stop.
 *
 * Outcomes come from the merged records and reasons come from the members'
 * metadata, so a member that reported values but shipped none is visible as a
 * disagreement rather than being taken at its word.
 *
 * @param members Members contributing to this channel, in report order.
 * @param channelId Channel the rows describe.
 * @param values Members that contributed plaintext values, per collection.
 * @param hashes Members whose private-hash records were merged, per collection.
 * @param newestHashBlock Reads the merged hashes, to resolve the reasons
 *   private-only members could not give — see `resolvePrivateOnlyReason`.
 */
export function buildCoverageMatrix(
  members: MemberInput[],
  channelId: string,
  values: Contributors,
  hashes: Contributors,
  newestHashBlock: NewestHashBlock = () => undefined,
): CoverageMatrixRow[] {
  const rows: CoverageMatrixRow[] = [];

  for (const [chaincode, collection] of collectionsToReport(
    members, channelId, values, hashes,
  )) {
    const key = collectionKey(chaincode, collection);
    const contributedValues = inMemberOrder(members, values.get(key));
    const outcome = mergedOutcome(contributedValues, hashes.get(key));
    const byMember = memberReports(members, channelId, chaincode, collection)
      .map((report) => resolvePrivateOnlyReason(
        report, members, channelId, chaincode, collection, outcome,
        newestHashBlock,
      ));
    const reason = mergedReason(outcome, byMember);

    rows.push({
      chaincode,
      collection,
      outcome,
      ...(reason ? { reason } : {}),
      contributedValues,
      contributedHashes: inMemberOrder(members, hashes.get(key)),
      byMember,
      needsAttention: blocksSignOff(reason),
    });
  }

  return rows;
}

/**
 * Every collection worth a row: those any member declared, plus any that
 * produced records without being declared.
 *
 * Undeclared collections are included rather than dropped — records for a
 * collection missing from every manifest mean the manifests are stale, and
 * silently omitting the row would hide data the merge is carrying.
 *
 * Synthesized implicit collections are the one exclusion, and they come from the
 * members' metadata instead — see `memberCollections`.
 */
function collectionsToReport(
  members: MemberInput[],
  channelId: string,
  values: Contributors,
  hashes: Contributors,
): Array<[string, string]> {
  const found = new Map<string, [string, string]>();

  for (const member of members) {
    for (const [chaincode, collection] of memberCollections(member, channelId)) {
      found.set(collectionKey(chaincode, collection), [chaincode, collection]);
    }
  }

  for (const key of [...values.keys(), ...hashes.keys()]) {
    if (found.has(key)) continue;
    const [chaincode, collection] = key.split(KEY_SEP);
    found.set(key, [chaincode, collection]);
  }

  return [...found.values()];
}

/**
 * Collections one member accounts for on a channel: those its manifest declares,
 * plus those its metadata reports coverage for.
 *
 * Synthesized implicit collections are taken from the metadata and not the
 * manifest. Discovery records one per channel org per chaincode whether or not
 * anything was ever written to it, so reporting every manifest entry would add a
 * large block of rows nobody can act on — and with no member self-report to draw
 * a reason from, each would land on `indeterminate` and stop the sign-off. The
 * extractor only reports an implicit collection it captured something for, which
 * is exactly the set worth a row.
 */
function memberCollections(
  member: MemberInput,
  channelId: string,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  const channel = member.manifest.channels.find(
    (c) => c.channelId === channelId,
  );
  for (const cc of channel?.chaincodes ?? []) {
    for (const coll of cc.collections) {
      if (!coll.implicit) pairs.push([cc.name, coll.name]);
    }
  }

  const reported =
    member.channelMetadata.get(channelId)?.privateDataCoverage ?? [];
  for (const row of reported) pairs.push([row.chaincode, row.collection]);

  return pairs;
}

function memberReports(
  members: MemberInput[],
  channelId: string,
  chaincode: string,
  collection: string,
): MemberCoverage[] {
  const reports: MemberCoverage[] = [];

  for (const member of members) {
    const reported = member.channelMetadata
      .get(channelId)
      ?.privateDataCoverage?.find(
        (c) => c.chaincode === chaincode && c.collection === collection,
      );
    if (!reported) continue;
    reports.push({
      member: member.label,
      coverage: reported.coverage,
      ...(reported.reason ? { reason: reported.reason } : {}),
      ...(reported.authorized === undefined
        ? {}
        : { authorized: reported.authorized }),
    });
  }

  return reports;
}

/**
 * Replace a private-only member's `indeterminate` with the reason the merged
 * hashes support.
 *
 * A private-only member has no hashes, so for a collection it was entitled to
 * it cannot tell "never written" from "written and missing" and says
 * `indeterminate`. The merge does have the hashes, from a full member — which
 * are channel data, identical on every peer — so it can ask the question the
 * member could not, with the same `classifyCoverageReason` the extractor uses.
 * Taking `indeterminate` as given would stop every such sign-off; dropping it
 * would let a full member's `unauthorized` stand for a collection an entitled
 * member failed to deliver, which is the case the matrix exists to catch.
 */
function resolvePrivateOnlyReason(
  report: MemberCoverage,
  members: MemberInput[],
  channelId: string,
  chaincode: string,
  collection: string,
  outcome: PrivateCollectionCoverage['coverage'],
  newestHashBlock: NewestHashBlock,
): MemberCoverage {
  if (report.reason !== 'indeterminate' || report.authorized !== true) {
    return report;
  }
  const member = members.find((m) => m.label === report.member);
  if (!member || !isPrivateOnly(member, channelId)) return report;

  const metadata = member.channelMetadata.get(channelId);
  const row = metadata?.privateDataCoverage?.find(
    (c) => c.chaincode === chaincode && c.collection === collection,
  );
  const blockToLive = row?.blockToLive ?? 0;
  const ledgerHeight = metadata?.ledgerHeight ?? 0;
  const newest = outcome === 'hashes-only'
    ? newestHashBlock(chaincode, collection) : undefined;

  return {
    ...report,
    reason: classifyCoverageReason(
      outcome === 'absent' ? 'absent' : 'hashes-only',
      true,
      { blockToLive, ledgerHeight, ...(newest === undefined ? {} : { newestHashBlock: newest }) },
    ),
  };
}

function mergedOutcome(
  contributedValues: string[],
  hashContributors: Set<string> | undefined,
): PrivateCollectionCoverage['coverage'] {
  if (contributedValues.length > 0) return 'values';
  if (hashContributors && hashContributors.size > 0) return 'hashes-only';
  return 'absent';
}

/**
 * Collapse the members' reasons into the one a coordinator has to act on.
 *
 * With no values and nobody offering a reason, the cause is `indeterminate`
 * rather than absent: an unexplained gap must not read as an accepted one.
 */
function mergedReason(
  outcome: PrivateCollectionCoverage['coverage'],
  byMember: MemberCoverage[],
): CoverageReason | undefined {
  if (outcome === 'values') return undefined;

  const reasons = byMember
    .filter((m) => m.coverage !== 'values')
    .map((m) => m.reason)
    .filter((r): r is CoverageReason => r !== undefined);

  return mostSevereReason(reasons) ?? 'indeterminate';
}

/** Order contributors by the command line, so reports are reproducible. */
function inMemberOrder(
  members: MemberInput[],
  contributors: Set<string> | undefined,
): string[] {
  if (!contributors) return [];
  return members.map((m) => m.label).filter((label) => contributors.has(label));
}

/**
 * Members whose `purge-window` claim another member's values disprove.
 *
 * Purging is driven by `blockToLive` and the committed block height, and both
 * are channel-wide: every peer on a channel has the same blocks and applies the
 * same horizon. So a collection cannot be past its purge horizon for one member
 * and not for another. A member reporting `purge-window` for a collection that
 * another member delivered plaintext for has therefore lost nothing to the
 * purge, and its `purge-window` label is a misattribution with three possible
 * causes, none of them purging:
 *
 * - the member had no anchor peer while the transactions committed, so gossip
 *   never delivered the private data to it in the first place;
 * - the extraction ran against a peer that joined after those commits, which
 *   fetches blocks and hashes but not other members' historical private data;
 * - the member was added to the collection policy after those commits.
 *
 * This is the only discriminator the toolkit can offer, because a collection's
 * *historical* anchor-peer configuration is not readable from the channel
 * config — only the current one is. It needs at least two members, so a
 * single-member extraction cannot reach this check at all.
 *
 * Keyed on merged records rather than on the other member's self-report: a
 * member claiming values it shipped none of is a different fault, reported by
 * `coverageDisagreements`, and it must not be the evidence that refutes a purge.
 *
 * @param rows Matrix rows for one channel, one per pair.
 * @returns One message per contradicted member and collection.
 */
export function contradictedPurgeClaims(rows: CoverageMatrixRow[]): string[] {
  const messages: string[] = [];

  for (const row of rows) {
    if (row.contributedValues.length === 0) continue;

    for (const report of row.byMember) {
      if (report.reason !== 'purge-window') continue;
      messages.push(
        `Member ${report.member} reported purge-window for ${row.chaincode}/` +
          `${row.collection}, but ${row.contributedValues.join(', ')} ` +
          'contributed plaintext values for it. Purging depends only on ' +
          'blockToLive and block height, which are the same for every peer on ' +
          `the channel, so this collection is not purged and ${report.member} ` +
          'lost nothing to it. Its peer was never sent this private data — no ' +
          'anchor peer at commit time, a peer that joined later, or membership ' +
          'granted after the fact. Do not sign this off as accepted purge ' +
          `loss in ${report.member}'s sign-off.`,
      );
    }
  }

  return messages;
}

/**
 * Members that claimed values for a collection but merged none in.
 *
 * Checked per `(chaincode, collection)` pair, which is what one private file now
 * holds. A per-collection comparison used to be necessary because a value file
 * named by collection alone could not be attributed to one of two chaincodes
 * sharing that collection name; the pair is now recorded in the file, so a claim
 * with no records behind it is a real disagreement.
 *
 * @param rows Matrix rows for one channel, one per pair.
 * @returns One message per disagreeing member and collection.
 */
export function coverageDisagreements(rows: CoverageMatrixRow[]): string[] {
  const messages: string[] = [];

  for (const row of rows) {
    const delivered = new Set(row.contributedValues);
    const stem = `private-${row.chaincode}-${row.collection}`;

    for (const report of row.byMember) {
      if (report.coverage !== 'values') continue;
      if (delivered.has(report.member)) continue;
      messages.push(
        `Member ${report.member} reported values for ${row.chaincode}/` +
          `${row.collection} but contributed no plaintext records — its ` +
          `${stem}-state.ndjson and ${stem}-history.ndjson are missing or ` +
          'empty.',
      );
    }
  }

  return messages;
}
