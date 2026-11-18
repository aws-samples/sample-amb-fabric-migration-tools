// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ReplayConfig } from '../types';
import { ExtractorError } from '../utils/errors';

/**
 * Which destination collection each source collection's private data goes into.
 *
 * A collection name is part of the destination's chaincode definition, not of
 * the data, so the name the source used need not exist there. Fabric's
 * per-organization collection makes that the normal case rather than the
 * exception: `_implicit_org_<MSPID>` embeds the MSP ID of the org that owns it,
 * and a destination network's MSP IDs are not the source's. Submitted verbatim,
 * every private write of such a collection fails at the destination on the name
 * alone, and nothing about the failure says the name was the problem.
 *
 * `replay` writes through this and `verify` reads back through it, so it is
 * derived here once. A disagreement between them would write to one collection
 * and read another, reporting every mapped key as missing from a destination
 * that holds it.
 *
 * Keyed by collection name alone, like `collectionIdentities`, and lined up with
 * it: on Fabric 2.x every chaincode on a channel shares one
 * `_implicit_org_<MSPID>`, so one entry covers all of them. `collectionIdentities`
 * is keyed by the *destination* name, since the policy that admits or refuses a
 * write is the destination collection's.
 */

/**
 * Prefix Fabric gives the per-organization collection every chaincode gets for
 * free on 2.x. `_implicit_org_Org2MSP` belongs to Org2MSP and to no one else:
 * its policy is that single org and both member-only flags are set, so no other
 * identity can write it and no query is needed to establish that.
 */
export const IMPLICIT_COLLECTION_PREFIX = '_implicit_org_';

/** MSP that solely owns an implicit collection, or `null` if not implicit. */
export function implicitCollectionOwner(collection: string): string | null {
  if (!collection.startsWith(IMPLICIT_COLLECTION_PREFIX)) return null;
  const owner = collection.slice(IMPLICIT_COLLECTION_PREFIX.length);
  return owner.length > 0 ? owner : null;
}

/** Destination collection a source collection's records are written into. */
export function destinationCollection(
  collectionMapping: Record<string, string> | undefined,
  collection: string,
): string {
  return collectionMapping?.[collection] || collection;
}

/**
 * How a collection reads in a message when its name changes at the destination.
 *
 * Both names or neither: a message naming only the source name cannot be
 * matched against the destination's chaincode definition, and one naming only
 * the destination name cannot be matched against the extraction's files.
 */
export function collectionLabel(collection: string, dest: string): string {
  return dest === collection ? collection : `${collection} → ${dest}`;
}

/**
 * Refuse a run whose private data cannot be routed to a destination collection.
 *
 * Two refusals, both before the first write:
 *
 * An implicit source collection with no mapping entry. Its name is the source
 * MSP ID's, so leaving it unmapped is never right — and the entry is required
 * even when the destination happens to use the same MSP ID, because writing it
 * out is the difference between an intended coincidence and an unnoticed one.
 *
 * Two source collections mapped onto one destination collection. Within a
 * chaincode namespace a collection is one keyspace, so two of them merged share
 * it: their copies of a key overwrite each other and the survivor is whichever
 * file replayed last, with no failure anywhere. This is also what lets the write
 * queues stay partitioned by source collection — refusing the merge is what
 * makes the two names interchangeable as a partition.
 *
 * @param ccConfig Chaincode section of the replay config.
 * @param collections Source collections this run will write, taken from the
 *   files on disk: a collection carrying no data has nothing to route.
 * @throws ExtractorError naming every collection that cannot be routed.
 */
export function assertCollectionRouting(
  ccConfig: NonNullable<ReplayConfig['chaincode']>,
  collections: string[],
): void {
  const inScope = [...new Set(collections)];
  const unmapped = inScope.filter(
    (collection) => implicitCollectionOwner(collection) !== null &&
      !ccConfig.collectionMapping?.[collection],
  );

  if (unmapped.length > 0) {
    throw new ExtractorError(
      `${unmapped.length} implicit collection(s) have no ` +
      `chaincode.collectionMapping entry: ${unmapped.join(', ')}. An ` +
      'implicit collection is named after the MSP ID that owns it, and the ' +
      'destination network\'s MSP IDs are not the source\'s, so submitting ' +
      'the source name writes into a collection that does not exist there. ' +
      'Map each one to the destination collection its data belongs in — ' +
      `e.g. { "${unmapped[0]}": "_implicit_org_<destination MSP ID>" }, or ` +
      'map the owning member once in chaincode.mspMapping — e.g. ' +
      `{ "${implicitCollectionOwner(unmapped[0])}": "<destination MSP ID>" } — ` +
      'which covers its implicit collection on every chaincode. Map it to ' +
      'itself if the destination really does use the same MSP ID.',
      'COLLECTION_ROUTING_ERROR',
    );
  }

  const merges = mergedCollections(ccConfig.collectionMapping, inScope);
  if (merges.length > 0) {
    throw new ExtractorError(
      'chaincode.collectionMapping sends more than one source collection to ' +
      `the same destination collection: ${merges.join('; ')}. A collection is ` +
      'one keyspace within its chaincode, so the merged collections\' copies ' +
      'of a shared key overwrite each other there and the survivor is ' +
      'whichever file was replayed last. Give each source collection its own ' +
      'destination collection.',
      'COLLECTION_ROUTING_ERROR',
    );
  }
}

/**
 * Destinations more than one in-scope source collection resolves to.
 *
 * Resolved rather than declared, so a mapping onto a collection that is itself
 * in scope unmapped — `{ "a": "b" }` with `b` carrying data too — is caught
 * alongside two explicit entries pointing at one name.
 */
function mergedCollections(
  collectionMapping: Record<string, string> | undefined,
  inScope: string[],
): string[] {
  const sourcesByDest = new Map<string, string[]>();
  for (const collection of inScope) {
    const dest = destinationCollection(collectionMapping, collection);
    const sources = sourcesByDest.get(dest);
    if (sources) sources.push(collection);
    else sourcesByDest.set(dest, [collection]);
  }

  return Array.from(sourcesByDest)
    .filter(([, sources]) => sources.length > 1)
    .map(([dest, sources]) => `${sources.join(' + ')} → ${dest}`);
}
