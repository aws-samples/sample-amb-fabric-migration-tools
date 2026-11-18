// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { collectionPolicyIncludes } from '../extraction/private-data/collection-policy';
import { FileLayoutManager } from '../output/file-layout-manager';
import { indexPrivateFiles } from '../output/private-file-index';
import { collectionLabel, implicitCollectionOwner } from './collection-routing';
import { NdjsonReader } from './ndjson-reader';
import { ChaincodeInfo } from '../types';

/** One (chaincode, collection) pair a chaincode replay is about to write. */
export interface PrivateWriteTarget {
  /** Source channel the records came from. */
  channel: string;
  /** Destination channel they will be written to. */
  destChannel: string;
  /** Chaincode whose namespace holds the collection. */
  chaincode: string;
  /** Collection as the extraction names it, which identifies the source file. */
  collection: string;
  /**
   * Collection the writes will actually name, after `collectionMapping`.
   *
   * Every check below is against this one: it is the collection whose policy
   * admits or refuses the write, and whose absence from the destination's
   * chaincode definition makes the write fail.
   */
  destCollection: string;
}

/**
 * Why a collection's writes cannot succeed as configured.
 *
 * collection-missing — the chaincode is committed but does not declare the
 *                      collection, so there is no keyspace to write into.
 * not-a-member       — the identity that would submit is not admitted by the
 *                      collection, so every write fails endorsement.
 *
 * Whether the chaincode holding the collection exists at all is settled before
 * this runs, by `preflightDeployments`.
 */
export type WriteBlockerKind =
  | 'collection-missing'
  | 'not-a-member';

export interface WriteBlocker extends PrivateWriteTarget {
  /** MSP that would have submitted these writes. */
  mspId: string;
  kind: WriteBlockerKind;
  detail: string;
}

/**
 * A destination collection that purges its own private data.
 *
 * Every replayed write is a new destination transaction, and the run commits
 * many blocks after it, so a value written early in the run is past
 * `blockToLive` on the destination's peers before the run ends — purged by
 * the destination itself, and reported by `verify` as missing. Seen live: a
 * `blockToLive: 40` collection lost every replayed value before verify ran.
 */
export interface PurgingCollection extends PrivateWriteTarget {
  blockToLive: number;
}

export interface PreflightResult {
  blockers: WriteBlocker[];
  /** Destination collections with `blockToLive > 0`, one per target. */
  purging: PurgingCollection[];
  /** What could not be established, one note per unresolved question. */
  unchecked: string[];
  /** Targets whose destination collection was confirmed writable. */
  checked: number;
}

/**
 * List the (chaincode, collection) pairs a chaincode replay will write into.
 *
 * Driven by the files on disk rather than by the manifest: an empty private file
 * writes nothing, so blocking a run on a collection that carries no data would
 * refuse a migration that had nothing to fail at. Each file names the chaincode
 * that holds the collection in its own records, so every target is attributed —
 * which matters most on Fabric 2.x, where every chaincode on a channel has its
 * own `_implicit_org_<MSPID>` under the same collection name.
 *
 * @param reader Shared NDJSON reader.
 * @param layout Layout rooted at the extraction directory being replayed.
 * @param channels Source/destination channel pairs in scope for this run.
 * @param suffix `-state.ndjson` or `-history.ndjson`, matching what will run.
 * @param destinationFor Source collection name → the name replay will submit.
 */
export async function listPrivateWriteTargets(
  reader: NdjsonReader,
  layout: FileLayoutManager,
  channels: Array<{ channel: string; destChannel: string }>,
  suffix: string,
  destinationFor: (collection: string) => string,
): Promise<PrivateWriteTarget[]> {
  const targets: PrivateWriteTarget[] = [];

  for (const { channel, destChannel } of channels) {
    const files = await indexPrivateFiles(reader, layout, channel, suffix);
    for (const { chaincode, collection } of files) {
      targets.push({
        channel,
        destChannel,
        chaincode,
        collection,
        destCollection: destinationFor(collection),
      });
    }
  }

  return targets;
}

/**
 * Confirm every destination collection admits the identity that will write it.
 *
 * Run before the first write, so a misconfigured identity costs a refusal
 * rather than a run that fails four fifths of its private data one warning at a
 * time. Every target is checked before anything is reported: an operator fixing
 * a five-member migration needs the whole list, not its first entry.
 *
 * Inconclusive checks are separated from failed ones. A destination that will
 * not answer a lifecycle query leaves membership unestablished, which is worth
 * saying but is not grounds to refuse — the writes themselves will establish
 * it, and they now report the collection and MSP that failed.
 *
 * @param definitions Committed chaincodes per destination channel, from
 *   `readDestinationDefinitions`. A target whose definition is not there is
 *   passed over silently, because both ways that happens are already reported:
 *   a channel that would not answer is one of that function's `unchecked` notes,
 *   and a chaincode that is not committed is refused by `preflightDeployments`
 *   before this runs. Reading an absent definition as "declares no collections"
 *   would turn either into a refusal naming the wrong cause.
 */
export function preflightCollections(
  targets: PrivateWriteTarget[],
  definitions: Map<string, ChaincodeInfo[]>,
  mspIdFor: (collection: string, destChannel: string) => string,
  ownerEndorsement = false,
): PreflightResult {
  const blockers: WriteBlocker[] = [];
  const purging: PurgingCollection[] = [];
  const unchecked = new Set<string>();
  let checked = 0;

  for (const target of targets) {
    const mspId = mspIdFor(target.destCollection, target.destChannel);

    const implicitProblem = checkImplicit(target, mspId, ownerEndorsement);
    if (implicitProblem) {
      blockers.push(implicitProblem);
      continue;
    }

    const definition = definitions
      .get(target.destChannel)
      ?.find((d) => d.name === target.chaincode);
    if (definition === undefined) continue;

    const declared = definition.collections.find(
      (c) => c.name === target.destCollection,
    );
    if (declared && declared.blockToLive > 0) {
      purging.push({ ...target, blockToLive: declared.blockToLive });
    }

    const problem = checkDefinition(target, mspId, definition);
    if (problem.blocker) blockers.push(problem.blocker);
    if (problem.note) unchecked.add(problem.note);
    if (!problem.blocker) checked++;
  }

  return { blockers, purging, unchecked: [...unchecked], checked };
}

/**
 * Check an implicit destination collection against the MSP that would write it.
 *
 * Decided from the name alone, so it holds even when the destination cannot be
 * queried: `_implicit_org_Org2MSP` is Org2MSP's, and an Org1MSP identity
 * submitting to it is refused whenever that identity's peers endorse it. The
 * name that decides it is the destination's — an implicit source collection
 * mapped onto an explicit destination collection is bound by that one's policy
 * instead.
 *
 * Not a refusal under `ownerEndorsement`: the collection's endorsement policy
 * names the owner's peers, not the submitter, so routing the endorsement to
 * them is the whole requirement. Whether those peers are reachable is not
 * knowable from here; the first write to the collection establishes it.
 */
function checkImplicit(
  target: PrivateWriteTarget,
  mspId: string,
  ownerEndorsement: boolean,
): WriteBlocker | null {
  const owner = implicitCollectionOwner(target.destCollection);
  if (owner === null || owner === mspId || ownerEndorsement) return null;

  return {
    ...target,
    mspId,
    kind: 'not-a-member',
    detail:
      `would be written as ${mspId}, but an implicit collection admits only ` +
      `${owner}`,
  };
}

/**
 * Check a target against its destination chaincode's committed definition.
 *
 * Non-membership is only a refusal where Fabric makes it one. With
 * `memberOnlyWrite` off the peer does not check the submitter's org, so a
 * non-member identity writes successfully — but its own peer cannot store the
 * private data it endorses, so the values have to travel to an org that can.
 * That is worth stating and is not the same as a denial.
 */
function checkDefinition(
  target: PrivateWriteTarget,
  mspId: string,
  definition: ChaincodeInfo,
): { blocker?: WriteBlocker; note?: string } {
  if (implicitCollectionOwner(target.destCollection) !== null) return {};

  const collection = definition.collections.find(
    (c) => c.name === target.destCollection,
  );
  if (!collection) {
    return {
      blocker: {
        ...target,
        mspId,
        kind: 'collection-missing',
        detail:
          `${target.chaincode} on ${target.destChannel} declares no ` +
          `collection ${target.destCollection} (it declares ` +
          `${definition.collections.length}: ` +
          `${definition.collections.map((c) => c.name).join(', ') || 'none'})`,
      },
    };
  }

  if (collectionPolicyIncludes(collection.policy, mspId)) return {};

  if (collection.memberOnlyWrite) {
    return {
      blocker: {
        ...target,
        mspId,
        kind: 'not-a-member',
        detail:
          `would be written as ${mspId}, which the collection policy ` +
          `${collection.policy} does not admit, and memberOnlyWrite is on`,
      },
    };
  }

  return {
    note:
      `${target.channel}/${target.chaincode}/` +
      `${collectionLabel(target.collection, target.destCollection)}: ` +
      `${mspId} is not in the policy ${collection.policy}, so its writes ` +
      'depend on a peer of another org endorsing them and receiving the values',
  };
}

/**
 * Explain a refused pre-flight and what to change.
 *
 * Grouped by remedy rather than by channel: an operator reading this is
 * deciding which identities to add and which destination collections to
 * create, and those are two different jobs.
 */
export function formatPreflightRefusal(blockers: WriteBlocker[]): string {
  const lines = blockers.map(
    (b) => `  ${b.channel}/${b.chaincode}/` +
      `${collectionLabel(b.collection, b.destCollection)}: ${b.detail}`,
  );

  const remedies: string[] = [];
  if (blockers.some((b) => b.kind === 'not-a-member')) {
    remedies.push(
      'For a collection another org owns, add a ' +
      'chaincode.collectionIdentities entry naming that org\'s MSP ID, ' +
      'certificate and key — and its connection profile, since a peer that ' +
      'is not a collection member cannot store the private data it endorses.',
    );
  }
  if (blockers.some((b) =>
    b.kind === 'not-a-member' &&
    implicitCollectionOwner(b.destCollection) !== null)) {
    remedies.push(
      'For an implicit collection, chaincode.ownerEndorsement: true writes it ' +
      'as this identity with the owning org\'s peers endorsing instead, which ' +
      'needs no credentials of that org.',
    );
  }
  if (blockers.some((b) => b.kind === 'collection-missing')) {
    remedies.push(
      'For a collection the destination does not declare, either commit the ' +
      'destination chaincode with a collection config that includes it, or ' +
      'add a chaincode.collectionMapping entry routing it to a collection ' +
      'the destination already declares.',
    );
  }

  return (
    `${blockers.length} destination collection(s) would reject every write ` +
    'from the identity configured for them, so this run is refusing to ' +
    'start:\n' +
    `${lines.join('\n')}\n` +
    `${remedies.join('\n')}`
  );
}
