import { CollectionIdentity, ReplayConfig } from '../types';
import { ReplayError } from '../utils/errors';
import { IMPLICIT_COLLECTION_PREFIX } from './collection-routing';

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

/**
 * Org-level shorthands for the two per-collection maps.
 *
 * On Fabric 2.x every member of a channel owns one `_implicit_org_<MSPID>`
 * collection, so a migration of N members needs N `collectionMapping` entries
 * and N `collectionIdentities` entries that each restate one fact about one
 * org: which destination MSP it becomes, and what that MSP signs with. A
 * collection the chaincode declares and an org owns repeats that org's
 * credentials once more. `mspMapping` and `orgIdentities` state each fact once
 * and these functions expand them into the per-collection maps everything
 * downstream already reads, so the expanded maps are the only thing `replay`,
 * `verify` and the plan digest ever see.
 *
 * An explicit per-collection entry always wins over a derived one, and both
 * expansions are idempotent, so expanding an already-expanded config is safe.
 */

/**
 * `collectionMapping` with an entry derived from `mspMapping` for every
 * implicit collection, explicit entries taking precedence.
 *
 * @returns The effective map, or `undefined` when there is nothing to route.
 */
export function expandCollectionMapping(
  ccConfig: ChaincodeConfig,
): Record<string, string> | undefined {
  const derived: Record<string, string> = {};
  for (const [source, dest] of Object.entries(ccConfig.mspMapping ?? {})) {
    // A blank destination is not an entry, exactly as in collectionMapping:
    // it would resolve back to the source name.
    if (!dest) continue;
    derived[`${IMPLICIT_COLLECTION_PREFIX}${source}`] =
      `${IMPLICIT_COLLECTION_PREFIX}${dest}`;
  }

  const merged = { ...derived, ...(ccConfig.collectionMapping ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * `collectionIdentities` with every entry a full identity: one derived from
 * `orgIdentities` for each org's implicit collection, and every MSP ID
 * reference resolved to the credentials it names.
 *
 * @throws ReplayError for an `orgIdentities` entry without a cert or key, or a
 *   reference to an MSP neither `orgIdentities` nor the top-level identity
 *   describes. Both are refused rather than defaulted: a fallback would write
 *   the collection as the top-level org, which is the outcome the entry exists
 *   to prevent.
 */
export function expandCollectionIdentities(
  ccConfig: ChaincodeConfig,
): Record<string, CollectionIdentity> {
  const orgs = ccConfig.orgIdentities ?? {};
  for (const [mspId, org] of Object.entries(orgs)) {
    const missing = (['certPath', 'keyPath'] as const).filter((f) => !org[f]);
    if (missing.length > 0) {
      throw new ReplayError(
        `chaincode.orgIdentities["${mspId}"] is missing ${missing.join(', ')}. ` +
        'Each org needs certPath and keyPath — an incomplete one would fall ' +
        'back to the top-level identity and write that org\'s collections as ' +
        'the wrong org.',
      );
    }
  }

  const resolveOrg = orgResolver(ccConfig);

  const expanded: Record<string, CollectionIdentity> = {};
  for (const mspId of Object.keys(orgs)) {
    expanded[`${IMPLICIT_COLLECTION_PREFIX}${mspId}`] = resolveOrg('', mspId);
  }
  for (const [collection, entry] of Object.entries(
    ccConfig.collectionIdentities ?? {},
  )) {
    expanded[collection] = typeof entry === 'string'
      ? resolveOrg(`collectionIdentities["${collection}"]`, entry)
      : entry;
  }
  return expanded;
}

/**
 * `channelCollectionIdentities` with every MSP ID reference resolved, exactly
 * as `expandCollectionIdentities` resolves `collectionIdentities`.
 *
 * Nothing is derived here: a per-channel entry exists only because the
 * operator wrote one, so there are no implicit-collection defaults to add.
 *
 * @returns Destination channel → collection → full identity.
 * @throws ReplayError for a reference neither `orgIdentities` nor the top-level
 *   identity describes.
 */
export function expandChannelCollectionIdentities(
  ccConfig: ChaincodeConfig,
): Record<string, Record<string, CollectionIdentity>> {
  const resolveOrg = orgResolver(ccConfig);
  const expanded: Record<string, Record<string, CollectionIdentity>> = {};
  for (const [channel, entries] of Object.entries(
    ccConfig.channelCollectionIdentities ?? {},
  )) {
    expanded[channel] = {};
    for (const [collection, entry] of Object.entries(entries)) {
      expanded[channel][collection] = typeof entry === 'string'
        ? resolveOrg(
          `channelCollectionIdentities["${channel}"]["${collection}"]`, entry,
        )
        : entry;
    }
  }
  return expanded;
}

/**
 * Resolve an MSP ID reference to the credentials `orgIdentities` or the
 * top-level identity holds for it.
 *
 * @param where The config entry being resolved, for the error message.
 */
function orgResolver(
  ccConfig: ChaincodeConfig,
): (where: string, mspId: string) => CollectionIdentity {
  const orgs = ccConfig.orgIdentities ?? {};
  return (where: string, mspId: string): CollectionIdentity => {
    const org = orgs[mspId];
    if (org) return { mspId, ...org };
    if (mspId === ccConfig.mspId) {
      return {
        mspId,
        certPath: ccConfig.certPath,
        keyPath: ccConfig.keyPath,
        connectionProfilePath: ccConfig.connectionProfilePath,
      };
    }
    throw new ReplayError(
      `chaincode.${where} names "${mspId}", which ` +
      'is neither a chaincode.orgIdentities entry nor the top-level mspId ' +
      `(${ccConfig.mspId}). Add "${mspId}" to orgIdentities with its ` +
      'certPath and keyPath, or give this collection a full identity.',
    );
  };
}

/**
 * The replay config with `collectionMapping` expanded, for the two commands
 * that route private data — `replay` writes through the map and `verify` reads
 * back through it, so both must see the same effective map.
 *
 * Identities are not expanded here: only `replay` connects them, and its
 * identity pool expands them itself so it can still tell an entry the operator
 * wrote from one derived for them.
 */
export function withOrgRouting(config: ReplayConfig): ReplayConfig {
  if (!config.chaincode) return config;
  return {
    ...config,
    chaincode: {
      ...config.chaincode,
      collectionMapping: expandCollectionMapping(config.chaincode),
    },
  };
}
