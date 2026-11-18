// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ReplayConfig } from '../src/types';

// ── Mocks ──

interface MockGateway {
  id: number;
  options?: Record<string, unknown>;
  connect: jest.Mock;
  getGatewayNetwork: jest.Mock;
  disconnect: jest.Mock;
}

/** Every gateway constructed, in construction order. */
const mockGateways: MockGateway[] = [];

/** MSP IDs whose connection should fail, as a peer with no route would. */
const mockUnreachable = new Set<string>();

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => {
    const gateway: MockGateway = {
      id: mockGateways.length,
      connect: jest.fn(async (options: Record<string, unknown>) => {
        gateway.options = options;
        if (mockUnreachable.has(options.mspId as string)) {
          throw new Error(`no route to a ${options.mspId} peer`);
        }
      }),
      // Identifies the gateway a network came from, so a test can tell which
      // identity a collection would be submitted over.
      getGatewayNetwork: jest.fn((channel: string) => ({
        gatewayId: gateway.id,
        channel,
      })),
      disconnect: jest.fn(),
    };
    mockGateways.push(gateway);
    return gateway;
  }),
}));

import { CollectionIdentityPool } from '../src/replay/collection-identities';

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

beforeEach(() => {
  mockGateways.length = 0;
  mockUnreachable.clear();
  jest.clearAllMocks();
});

// ── Fixtures ──

function config(overrides: Partial<ChaincodeConfig> = {}): ChaincodeConfig {
  return {
    connectionProfilePath: 'org1-profile.json',
    mspId: 'Org1MSP',
    certPath: 'org1-cert.pem',
    keyPath: 'org1-key.pem',
    ...overrides,
  };
}

const ORG2 = {
  mspId: 'Org2MSP',
  certPath: 'org2-cert.pem',
  keyPath: 'org2-key.pem',
};

const ORG3 = {
  mspId: 'Org3MSP',
  certPath: 'org3-cert.pem',
  keyPath: 'org3-key.pem',
};

/** The gateway a collection's writes would be submitted over. */
function gatewayIdFor(
  pool: CollectionIdentityPool,
  collection: string,
): number {
  return (pool.identitiesFor('dest1').get(collection) as any).network.gatewayId;
}

// ── Connecting ──

describe('CollectionIdentityPool — connecting', () => {
  it('opens only the top-level connection when nothing is configured', async () => {
    const pool = await CollectionIdentityPool.connect(config());

    expect(mockGateways).toHaveLength(1);
    expect(pool.configuredCollections()).toEqual([]);
    expect(pool.identitiesFor('dest1').size).toBe(0);
  });

  it('connects the top-level identity with its own credentials', async () => {
    await CollectionIdentityPool.connect(config());

    expect(mockGateways[0].options).toMatchObject({
      connectionProfilePath: 'org1-profile.json',
      mspId: 'Org1MSP',
      certPath: 'org1-cert.pem',
      keyPath: 'org1-key.pem',
    });
  });

  it('connects each configured collection identity as its own org', async () => {
    await CollectionIdentityPool.connect(config({
      collectionIdentities: { '_implicit_org_Org2MSP': { ...ORG2 } },
    }));

    expect(mockGateways).toHaveLength(2);
    expect(mockGateways[1].options).toMatchObject({
      mspId: 'Org2MSP',
      certPath: 'org2-cert.pem',
      keyPath: 'org2-key.pem',
    });
  });

  /**
   * Five collections owned by one org should cost one connection, not five —
   * each gateway is a gRPC channel and a peer-side session.
   */
  it('shares one connection between collections with the same credentials', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      collectionIdentities: {
        'assetsCollection': { ...ORG2 },
        'tradesCollection': { ...ORG2 },
      },
    }));

    expect(mockGateways).toHaveLength(2);
    expect(gatewayIdFor(pool, 'assetsCollection'))
      .toBe(gatewayIdFor(pool, 'tradesCollection'));
  });

  it('opens a connection per org for collections owned by different orgs', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      collectionIdentities: {
        '_implicit_org_Org2MSP': { ...ORG2 },
        '_implicit_org_Org3MSP': { ...ORG3 },
      },
    }));

    expect(mockGateways).toHaveLength(3);
    expect(gatewayIdFor(pool, '_implicit_org_Org2MSP'))
      .not.toBe(gatewayIdFor(pool, '_implicit_org_Org3MSP'));
  });

  /**
   * The peer matters as much as the identity: a peer that is not a collection
   * member cannot store the private data it endorses, so the same credentials
   * pointed at two profiles are two destinations, not one.
   */
  it('does not share a connection between two peers of the same org', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      collectionIdentities: {
        'onPeer0': { ...ORG2, connectionProfilePath: 'org2-peer0.json' },
        'onPeer1': { ...ORG2, connectionProfilePath: 'org2-peer1.json' },
      },
    }));

    expect(mockGateways).toHaveLength(3);
    expect(gatewayIdFor(pool, 'onPeer0')).not.toBe(gatewayIdFor(pool, 'onPeer1'));
  });

  it('connects a collection identity through its own connection profile', async () => {
    await CollectionIdentityPool.connect(config({
      collectionIdentities: {
        'assetsCollection': { ...ORG2, connectionProfilePath: 'org2-peer0.json' },
      },
    }));

    expect(mockGateways[1].options)
      .toMatchObject({ connectionProfilePath: 'org2-peer0.json' });
  });

  it('falls back to the top-level profile when a collection names none', async () => {
    await CollectionIdentityPool.connect(config({
      collectionIdentities: { 'assetsCollection': { ...ORG2 } },
    }));

    expect(mockGateways[1].options)
      .toMatchObject({ connectionProfilePath: 'org1-profile.json' });
  });

  /**
   * A per-collection gateway that did not inherit this would refuse a peer the
   * top-level identity was allowed to use — or, worse, accept a plaintext one it
   * was not.
   */
  it('applies the run\'s transport and timeout settings to every connection', async () => {
    await CollectionIdentityPool.connect(
      config({
        allowInsecure: true,
        collectionIdentities: { 'assetsCollection': { ...ORG2 } },
      }),
      { connectMs: 1, requestMs: 2, commitMs: 3 },
    );

    for (const gateway of mockGateways) {
      expect(gateway.options).toMatchObject({
        allowInsecure: true,
        timeouts: { connectMs: 1, requestMs: 2, commitMs: 3 },
      });
    }
  });
});

// ── Incomplete configuration ──

describe('CollectionIdentityPool — incomplete entries', () => {
  it.each(['mspId', 'certPath', 'keyPath'])(
    'refuses an entry with no %s rather than writing as the wrong org',
    async (field) => {
      const identity: Record<string, string> = { ...ORG2 };
      delete identity[field];

      const connecting = CollectionIdentityPool.connect(config({
        collectionIdentities: { 'assetsCollection': identity as any },
      }));

      await expect(connecting).rejects.toThrow(
        new RegExp(`collectionIdentities\\["assetsCollection"\\] is missing ` +
          `${field}`),
      );
    },
  );

  it('names every missing field at once', async () => {
    const connecting = CollectionIdentityPool.connect(config({
      collectionIdentities: { 'assetsCollection': { mspId: 'Org2MSP' } as any },
    }));

    await expect(connecting).rejects.toThrow(/missing certPath, keyPath/);
  });

  it('rejects an empty string as firmly as a missing field', async () => {
    const connecting = CollectionIdentityPool.connect(config({
      collectionIdentities: { 'assetsCollection': { ...ORG2, mspId: '' } },
    }));

    await expect(connecting).rejects.toThrow(/is missing mspId/);
  });

  /**
   * Validation runs before the first connect, so a typo in the fifth entry does
   * not cost four connections that then have to be unwound.
   */
  it('validates every entry before opening any connection', async () => {
    const connecting = CollectionIdentityPool.connect(config({
      collectionIdentities: {
        'ok': { ...ORG2 },
        'broken': { mspId: 'Org3MSP' } as any,
      },
    }));

    await expect(connecting).rejects.toThrow(/is missing/);
    expect(mockGateways).toHaveLength(0);
  });
});

// ── Cleanup ──

describe('CollectionIdentityPool — cleanup', () => {
  /**
   * A partially-connected pool is never returned, and never leaks: the caller
   * that catches this error has no handle to close the connections that did
   * open.
   */
  it('closes the connections already open when a later one fails', async () => {
    mockUnreachable.add('Org3MSP');

    const connecting = CollectionIdentityPool.connect(config({
      collectionIdentities: {
        '_implicit_org_Org2MSP': { ...ORG2 },
        '_implicit_org_Org3MSP': { ...ORG3 },
      },
    }));

    await expect(connecting).rejects.toThrow(/no route to a Org3MSP peer/);
    expect(mockGateways).toHaveLength(3);
    for (const gateway of mockGateways) {
      expect(gateway.disconnect).toHaveBeenCalled();
    }
  });

  /**
   * `connect` opens the gRPC client before it can still throw, so the gateway
   * that failed has to be closed too — nothing else holds a reference to it.
   */
  it('closes the connection that failed, not just its predecessors', async () => {
    mockUnreachable.add('Org2MSP');

    await expect(
      CollectionIdentityPool.connect(config({
        collectionIdentities: { 'assetsCollection': { ...ORG2 } },
      })),
    ).rejects.toThrow();

    expect(mockGateways).toHaveLength(2);
    expect(mockGateways[1].disconnect).toHaveBeenCalled();
  });

  it('closes the top-level connection when it is the one that fails', async () => {
    mockUnreachable.add('Org1MSP');

    await expect(CollectionIdentityPool.connect(config())).rejects.toThrow();

    expect(mockGateways[0].disconnect).toHaveBeenCalled();
  });

  it('closes every connection on disconnect', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      collectionIdentities: {
        '_implicit_org_Org2MSP': { ...ORG2 },
        '_implicit_org_Org3MSP': { ...ORG3 },
      },
    }));

    pool.disconnect();

    expect(mockGateways).toHaveLength(3);
    for (const gateway of mockGateways) {
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
    }
  });
});

// ── Resolving ──

describe('CollectionIdentityPool — resolving', () => {
  async function poolWithOrg2(): Promise<CollectionIdentityPool> {
    return CollectionIdentityPool.connect(config({
      collectionIdentities: { '_implicit_org_Org2MSP': { ...ORG2 } },
    }));
  }

  it('names the configured MSP for a collection that has one', async () => {
    const pool = await poolWithOrg2();

    expect(pool.mspIdFor('_implicit_org_Org2MSP', 'dest1')).toBe('Org2MSP');
  });

  it('names the top-level MSP for a collection with no entry', async () => {
    const pool = await poolWithOrg2();

    expect(pool.mspIdFor('sharedCollection', 'dest1')).toBe('Org1MSP');
  });

  it('lists the collections that carry an identity of their own', async () => {
    const pool = await poolWithOrg2();

    expect(pool.configuredCollections()).toEqual(['_implicit_org_Org2MSP']);
  });

  it('resolves each identity against the destination channel it will write', async () => {
    const pool = await poolWithOrg2();

    const identities = pool.identitiesFor('dest7');

    expect(identities.get('_implicit_org_Org2MSP')).toMatchObject({
      mspId: 'Org2MSP',
      network: { gatewayId: 1, channel: 'dest7' },
    });
  });

  it('resolves the top-level network from the top-level connection', async () => {
    const pool = await poolWithOrg2();

    expect(pool.defaultNetwork('dest7')).toMatchObject({
      gatewayId: 0,
      channel: 'dest7',
    });
  });

  it('exposes the top-level gateway for querying the destination', async () => {
    const pool = await poolWithOrg2();

    expect(pool.defaultGateway()).toBe(mockGateways[0]);
  });

  /**
   * Each destination channel is a separate network on the same connection, so a
   * multi-channel replay must not reuse the first channel's networks.
   */
  it('resolves a separate network per destination channel', async () => {
    const pool = await poolWithOrg2();

    const first = pool.identitiesFor('dest1').get('_implicit_org_Org2MSP');
    const second = pool.identitiesFor('dest2').get('_implicit_org_Org2MSP');

    expect((first as any).network.channel).toBe('dest1');
    expect((second as any).network.channel).toBe('dest2');
  });
});

// ── Org-level identities ──
//
// `orgIdentities` states each org's credentials once; the pool writes each
// org's implicit collection as that org and resolves MSP ID references.

describe('CollectionIdentityPool — orgIdentities', () => {
  const ORG2_CREDS = { certPath: 'org2-cert.pem', keyPath: 'org2-key.pem' };

  it('writes an org\'s implicit collection as that org with no per-collection entry', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      orgIdentities: { Org2MSP: ORG2_CREDS },
    }));

    expect(pool.mspIdFor('_implicit_org_Org2MSP', 'dest1')).toBe('Org2MSP');
    expect(mockGateways[1].options).toMatchObject({
      mspId: 'Org2MSP',
      certPath: 'org2-cert.pem',
      keyPath: 'org2-key.pem',
      connectionProfilePath: 'org1-profile.json',
    });
  });

  /** One connection per org, however many collections reference it. */
  it('shares the org connection with explicit collections that reference it', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      orgIdentities: { Org2MSP: ORG2_CREDS },
      collectionIdentities: { colA: 'Org2MSP', colB: 'Org2MSP' },
    }));

    expect(mockGateways).toHaveLength(2);
    expect(gatewayIdFor(pool, 'colA')).toBe(gatewayIdFor(pool, '_implicit_org_Org2MSP'));
    expect(gatewayIdFor(pool, 'colB')).toBe(1);
  });

  it('lets an explicit entry override the derived implicit identity', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      orgIdentities: { Org2MSP: ORG2_CREDS },
      collectionIdentities: { '_implicit_org_Org2MSP': { ...ORG3 } },
    }));

    expect(pool.mspIdFor('_implicit_org_Org2MSP', 'dest1')).toBe('Org3MSP');
  });

  /** A derived entry cannot be a typo, so it must not trip the unused warning. */
  it('lists only collections the operator named as configured', async () => {
    const pool = await CollectionIdentityPool.connect(config({
      orgIdentities: { Org2MSP: ORG2_CREDS },
      collectionIdentities: { colA: 'Org2MSP' },
    }));

    expect(pool.configuredCollections()).toEqual(['colA']);
  });

  it('refuses a reference to an org it has no credentials for, before connecting', async () => {
    await expect(CollectionIdentityPool.connect(config({
      collectionIdentities: { colA: 'Org9MSP' },
    }))).rejects.toThrow(/colA.*"Org9MSP".*orgIdentities/s);
    expect(mockGateways).toHaveLength(0);
  });
});

// ── Per-channel identities ──
//
// One collection name, two owners: on the five-member live network `pairAB`
// was Org1/Org2's on `channel-a` and Org4/Org5's on `channel-d`, and the
// name-keyed `collectionIdentities` could route only one of them.

describe('CollectionIdentityPool — channelCollectionIdentities', () => {
  const ORG4_CREDS = { certPath: 'org4-cert.pem', keyPath: 'org4-key.pem' };

  async function pairABPool(): Promise<CollectionIdentityPool> {
    return CollectionIdentityPool.connect(config({
      orgIdentities: { Org2MSP: { certPath: 'org2-cert.pem', keyPath: 'org2-key.pem' }, Org4MSP: ORG4_CREDS },
      collectionIdentities: { pairAB: 'Org2MSP' },
      channelCollectionIdentities: { 'channel-d': { pairAB: 'Org4MSP', onlyA: 'Org4MSP' } },
    }));
  }

  it('routes one collection name to a different org on one channel', async () => {
    const pool = await pairABPool();

    expect(pool.mspIdFor('pairAB', 'consortium')).toBe('Org2MSP');
    expect(pool.mspIdFor('pairAB', 'channel-d')).toBe('Org4MSP');
    expect(pool.mspIdFor('onlyA', 'channel-d')).toBe('Org4MSP');
    expect(pool.mspIdFor('onlyA', 'consortium')).toBe('Org1MSP');
  });

  it('hands the adapter the channel\'s own identities', async () => {
    const pool = await pairABPool();

    expect(pool.identitiesFor('channel-d').get('pairAB')).toMatchObject({
      mspId: 'Org4MSP', network: { channel: 'channel-d' },
    });
    expect(pool.identitiesFor('consortium').get('pairAB')?.mspId).toBe('Org2MSP');
    expect(pool.identitiesFor('consortium').has('onlyA')).toBe(false);
  });

  it('shares the org connection a reference names', async () => {
    const pool = await pairABPool();

    // Top-level, Org2 and Org4: the two per-channel references reuse Org4's.
    expect(mockGateways).toHaveLength(3);
    expect(pool.configuredChannelCollections()).toEqual([
      { destChannel: 'channel-d', collection: 'pairAB' },
      { destChannel: 'channel-d', collection: 'onlyA' },
    ]);
  });

  it('refuses a reference to an org with no credentials, naming the entry', async () => {
    await expect(CollectionIdentityPool.connect(config({
      channelCollectionIdentities: { 'channel-d': { pairAB: 'Org9MSP' } },
    }))).rejects.toThrow(/channelCollectionIdentities\["channel-d"\]\["pairAB"\].*"Org9MSP"/s);
    expect(mockGateways).toHaveLength(0);
  });

  it('refuses an incomplete full identity, naming the entry', async () => {
    await expect(CollectionIdentityPool.connect(config({
      channelCollectionIdentities: { 'channel-d': { pairAB: { mspId: 'Org4MSP', certPath: 'c.pem' } as any } },
    }))).rejects.toThrow(/channelCollectionIdentities\["channel-d"\]\["pairAB"\] is missing keyPath/);
  });
});
