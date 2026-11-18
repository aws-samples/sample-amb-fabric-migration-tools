// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Network } from '@hyperledger/fabric-gateway';
import { FabricGateway } from '../connection/fabric-gateway';
import { CollectionIdentity, GrpcTimeouts, ReplayConfig } from '../types';
import { ReplayError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import {
  expandChannelCollectionIdentities,
  expandCollectionIdentities,
} from './org-routing';

const logger = createLogger('collection-identities');

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;
type IdentityConfig = CollectionIdentity;

/** A connected destination identity: where to submit, and as whom. */
export interface ReplayIdentity {
  mspId: string;
  network: Network;
}

/** One connected gateway and the MSP its identity presents. */
interface PooledIdentity {
  mspId: string;
  gateway: FabricGateway;
}

/**
 * Every field of a collection identity, so two collections configured with the
 * same credentials share one connection instead of opening one each.
 */
function identityFingerprint(
  identity: IdentityConfig,
  defaultProfile: string,
): string {
  return [
    identity.mspId,
    identity.certPath,
    identity.keyPath,
    identity.connectionProfilePath ?? defaultProfile,
  ].join('\x00');
}

/**
 * Reject a collection identity that cannot be connected with.
 *
 * Every field is required because a partial identity has no safe default: an
 * absent `mspId` cannot fall back to the top-level one (the whole point of the
 * entry is that a different org writes this collection), and an absent cert or
 * key would silently write the collection as the default identity — the exact
 * outcome the entry was added to prevent.
 */
function assertComplete(where: string, identity: IdentityConfig): void {
  const missing = (['mspId', 'certPath', 'keyPath'] as const).filter(
    (field) => !identity[field],
  );
  if (missing.length === 0) return;

  throw new ReplayError(
    `chaincode.${where} is missing ` +
    `${missing.join(', ')}. Each entry needs mspId, certPath and keyPath — ` +
    'an incomplete one would fall back to the top-level identity and write ' +
    'the collection as the wrong org.',
  );
}

/**
 * The destination identities a chaincode replay submits with.
 *
 * One identity per destination collection that names one, plus the top-level
 * identity for everything else. Connections are opened once per distinct set of
 * credentials and shared, so five collections owned by one org cost one
 * gateway, not five.
 */
export class CollectionIdentityPool {
  private constructor(
    private readonly defaultIdentity: PooledIdentity,
    private readonly byCollection: Map<string, PooledIdentity>,
    /** Destination channel → collection → identity; wins on that channel. */
    private readonly byChannel: Map<string, Map<string, PooledIdentity>>,
    private readonly all: PooledIdentity[],
    private readonly explicit: string[],
  ) {}

  /**
   * Connect the top-level identity and every configured collection identity.
   *
   * @throws ReplayError if any identity is incomplete or cannot connect. A
   *   partially-connected pool is never returned: connections already opened
   *   are closed before the error propagates.
   */
  static async connect(
    ccConfig: ChaincodeConfig,
    timeouts?: GrpcTimeouts,
  ): Promise<CollectionIdentityPool> {
    const entries = Object.entries(expandCollectionIdentities(ccConfig));
    const explicit = Object.keys(ccConfig.collectionIdentities ?? {});
    for (const [collection, identity] of entries) {
      assertComplete(`collectionIdentities["${collection}"]`, identity);
    }
    const perChannel = Object.entries(
      expandChannelCollectionIdentities(ccConfig),
    );
    for (const [channel, collections] of perChannel) {
      for (const [collection, identity] of Object.entries(collections)) {
        assertComplete(
          `channelCollectionIdentities["${channel}"]["${collection}"]`,
          identity,
        );
      }
    }

    const all: PooledIdentity[] = [];
    const connect = async (
      mspId: string,
      certPath: string,
      keyPath: string,
      profilePath: string,
    ): Promise<PooledIdentity> => {
      // Registered before connecting, not after: a failing connect can leave an
      // open gRPC client behind (it is created before the identity is built, and
      // a malformed key throws after that), and only the cleanup below closes it.
      const pooled = { mspId, gateway: new FabricGateway() };
      all.push(pooled);
      await pooled.gateway.connect({
        connectionProfilePath: profilePath,
        mspId,
        certPath,
        keyPath,
        timeouts,
        allowInsecure: ccConfig.allowInsecure,
      });
      return pooled;
    };

    try {
      const defaultIdentity = await connect(
        ccConfig.mspId,
        ccConfig.certPath,
        ccConfig.keyPath,
        ccConfig.connectionProfilePath,
      );

      const shared = new Map<string, PooledIdentity>();
      const pooledFor = async (
        identity: IdentityConfig,
      ): Promise<PooledIdentity> => {
        const fingerprint = identityFingerprint(
          identity, ccConfig.connectionProfilePath,
        );
        let pooled = shared.get(fingerprint);
        if (!pooled) {
          pooled = await connect(
            identity.mspId,
            identity.certPath,
            identity.keyPath,
            identity.connectionProfilePath ?? ccConfig.connectionProfilePath,
          );
          shared.set(fingerprint, pooled);
        }
        return pooled;
      };

      const byCollection = new Map<string, PooledIdentity>();
      for (const [collection, identity] of entries) {
        byCollection.set(collection, await pooledFor(identity));
      }
      const byChannel = new Map<string, Map<string, PooledIdentity>>();
      for (const [channel, collections] of perChannel) {
        const resolved = new Map<string, PooledIdentity>();
        for (const [collection, identity] of Object.entries(collections)) {
          resolved.set(collection, await pooledFor(identity));
        }
        byChannel.set(channel, resolved);
      }

      if (byCollection.size > 0 || byChannel.size > 0) {
        logger.info(
          {
            collections: [...byCollection.keys()],
            perChannel: Object.fromEntries(
              [...byChannel].map(([ch, m]) => [ch, [...m.keys()]]),
            ),
            connections: all.length,
            mspIds: [...new Set(all.map((i) => i.mspId))],
          },
          'Connected per-collection replay identities',
        );
      }

      return new CollectionIdentityPool(
        defaultIdentity, byCollection, byChannel, all, explicit,
      );
    } catch (err) {
      for (const pooled of all) pooled.gateway.disconnect();
      throw err;
    }
  }

  /** MSP that will submit writes to this collection on this channel. */
  mspIdFor(collection: string, destChannel: string): string {
    return this.resolve(collection, destChannel).mspId;
  }

  private resolve(collection: string, destChannel: string): PooledIdentity {
    return this.byChannel.get(destChannel)?.get(collection) ??
      this.byCollection.get(collection) ??
      this.defaultIdentity;
  }

  /**
   * Collections named in `collectionIdentities` itself.
   *
   * Excludes the implicit collections derived from `orgIdentities`: those are
   * written for every configured org whether or not this run carries its data,
   * so only an entry the operator typed can be a typo worth warning about.
   */
  configuredCollections(): string[] {
    return [...this.explicit];
  }

  /** `channelCollectionIdentities` entries, as destination channel/collection. */
  configuredChannelCollections(): Array<{ destChannel: string; collection: string }> {
    return [...this.byChannel].flatMap(([destChannel, collections]) =>
      [...collections.keys()].map((collection) => ({ destChannel, collection })));
  }

  /** The top-level identity's network for a destination channel. */
  defaultNetwork(destChannel: string): Network {
    return this.defaultIdentity.gateway.getGatewayNetwork(destChannel);
  }

  /** The top-level identity's gateway, for querying the destination. */
  defaultGateway(): FabricGateway {
    return this.defaultIdentity.gateway;
  }

  /**
   * Collection → identity for one destination channel.
   *
   * Only collections with an identity of their own appear; the caller falls
   * back to `defaultNetwork` for the rest.
   */
  identitiesFor(destChannel: string): Map<string, ReplayIdentity> {
    const resolved = new Map<string, ReplayIdentity>();
    const collections = new Set([
      ...this.byCollection.keys(),
      ...(this.byChannel.get(destChannel)?.keys() ?? []),
    ]);
    for (const collection of collections) {
      const pooled = this.resolve(collection, destChannel);
      resolved.set(collection, {
        mspId: pooled.mspId,
        network: pooled.gateway.getGatewayNetwork(destChannel),
      });
    }
    return resolved;
  }

  disconnect(): void {
    for (const pooled of this.all) pooled.gateway.disconnect();
  }
}
