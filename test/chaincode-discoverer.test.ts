// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  ChaincodeDiscoverer,
  DiscoveryGateway,
  synthesizeImplicitCollections,
} from '../src/discovery/chaincode-discoverer';
import { NetworkAdapter } from '../src/connection/network-adapter';
import { CollectionConfig } from '../src/types';
import { DiscoveryError } from '../src/utils/errors';

// ── Fixtures ──

/** Handles one system chaincode's evaluateTransaction calls. */
type Handler = (fn: string, ...args: unknown[]) => Promise<Uint8Array>;

function json(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), 'utf-8'));
}

/**
 * A gateway serving only the named system chaincodes. Any other chaincode
 * rejects the way a peer does, which is what drives the lifecycle→lscc fallback.
 */
function gatewayWith(contracts: Record<string, Handler>): DiscoveryGateway {
  return {
    getNetwork: () =>
      ({
        getContract: (name: string) => ({
          evaluateTransaction: async (fn: string, ...args: unknown[]) => {
            const handler = contracts[name];
            if (!handler) throw new Error(`could not find chaincode ${name}`);
            return handler(fn, ...args);
          },
          submitTransaction: jest.fn(),
        }),
      }) as unknown as NetworkAdapter,
    getMspId: () => 'Org1MSP',
  };
}

function lifecycleContract(
  definitions: Array<{ name: string; version: string; sequence: number }>,
  collections: Record<string, unknown> = {},
): Handler {
  return async (fn, ...args) => {
    if (fn === 'QueryChaincodeDefinitions') {
      return json({ chaincode_definitions: definitions });
    }
    if (fn === 'QueryChaincodeDefinition') {
      // The single arg is a hand-rolled protobuf { string name = 1 }.
      const argBytes = Buffer.from(args[0] as Uint8Array);
      const name = argBytes.subarray(2).toString('utf-8');
      const config = collections[name];
      if (config === undefined) return json({});
      return json({ collections: { config } });
    }
    throw new Error(`unexpected _lifecycle function ${fn}`);
  };
}

function lsccContract(
  chaincodes: Array<{ name: string; version: string }>,
  collections: Record<string, unknown> = {},
): Handler {
  return async (fn, ...args) => {
    if (fn === 'GetChaincodes') return json({ chaincodes });
    if (fn === 'GetCollectionsConfig') {
      const config = collections[args[0] as string];
      if (config === undefined) {
        throw new Error(
          `collections config not defined for chaincode ${args[0]}, pass ` +
            "'--collections-config' if collections are required",
        );
      }
      return json({ config });
    }
    throw new Error(`unexpected lscc function ${fn}`);
  };
}

const STATIC_COLLECTION = {
  static_collection_config: {
    name: 'col1',
    required_peer_count: 1,
    maximum_peer_count: 2,
    block_to_live: 0,
    member_only_read: true,
    member_only_write: true,
  },
};

// Retries sleep between attempts, so failing paths are driven through fake
// timers rather than waiting out the real backoff.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function expectDiscoveryError(
  promise: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  const assertions = Promise.all([
    expect(promise).rejects.toThrow(DiscoveryError),
    expect(promise).rejects.toThrow(message),
  ]);
  await jest.runAllTimersAsync();
  await assertions;
}

async function resolved<T>(promise: Promise<T>): Promise<T> {
  await jest.runAllTimersAsync();
  return promise;
}

// ── synthesizeImplicitCollections ──

describe('synthesizeImplicitCollections', () => {
  test('builds one collection per org, named the way Fabric names them', () => {
    const collections = synthesizeImplicitCollections(
      ['Org1MSP', 'Org2MSP'], [],
    );

    expect(collections.map((c) => c.name)).toEqual([
      '_implicit_org_Org1MSP',
      '_implicit_org_Org2MSP',
    ]);
    expect(collections[0]).toMatchObject({
      policy: "OR('Org1MSP.member')",
      blockToLive: 0,
      implicit: true,
    });
  });

  test('is empty when the channel has no orgs to synthesize for', () => {
    expect(synthesizeImplicitCollections([], [])).toEqual([]);
  });

  // A declared collection was actually observed on the peer; a synthesized one
  // is a guess about what the peer holds, so the observation wins.
  test('leaves a declared collection of the same name alone', () => {
    const declared: CollectionConfig = {
      name: '_implicit_org_Org1MSP',
      policy: "OR('Org1MSP.admin')",
      requiredPeerCount: 3,
      maxPeerCount: 5,
      blockToLive: 7,
      memberOnlyRead: true,
      memberOnlyWrite: true,
    };

    const collections = synthesizeImplicitCollections(
      ['Org1MSP', 'Org2MSP'], [declared],
    );

    expect(collections.map((c) => c.name)).toEqual(['_implicit_org_Org2MSP']);
  });
});

// ── queryCommitted: implicit collection synthesis (row 2.3) ──

describe('ChaincodeDiscoverer — implicit collections', () => {
  test('appends implicit collections to every chaincode on the channel', async () => {
    const gateway = gatewayWith({
      _lifecycle: lifecycleContract([
        { name: 'cc-a', version: '1.0', sequence: 1 },
        { name: 'cc-b', version: '2.0', sequence: 3 },
      ]),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1', {
        implicitOrgMspIds: ['Org1MSP', 'Org2MSP'],
      }),
    );

    for (const cc of chaincodes) {
      expect(cc.collections.map((c) => c.name)).toEqual([
        '_implicit_org_Org1MSP',
        '_implicit_org_Org2MSP',
      ]);
      expect(cc.collections.every((c) => c.implicit)).toBe(true);
    }
  });

  test('keeps declared collections alongside the synthesized ones', async () => {
    const gateway = gatewayWith({
      _lifecycle: lifecycleContract(
        [{ name: 'cc-a', version: '1.0', sequence: 1 }],
        { 'cc-a': [STATIC_COLLECTION] },
      ),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1', {
        implicitOrgMspIds: ['Org1MSP'],
      }),
    );

    expect(chaincodes[0].collections.map((c) => c.name)).toEqual([
      'col1',
      '_implicit_org_Org1MSP',
    ]);
    expect(chaincodes[0].collections[0].implicit).toBeUndefined();
  });

  test('synthesizes nothing when no org MSP IDs are supplied', async () => {
    const gateway = gatewayWith({
      _lifecycle: lifecycleContract([
        { name: 'cc-a', version: '1.0', sequence: 1 },
      ]),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
    );

    expect(chaincodes[0].collections).toEqual([]);
  });
});

// ── queryCommitted: failed collection queries (row 2.4) ──

describe('ChaincodeDiscoverer — a failed collection query is an error', () => {
  test('treats lscc\'s "collections config not defined" as no collections', async () => {
    const gateway = gatewayWith({
      lscc: lsccContract([{ name: 'mycc', version: '1.0' }]),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
    );

    expect(chaincodes).toEqual([
      { name: 'mycc', version: '1.0', sequence: 0, collections: [] },
    ]);
  });

  test('reads collections through lscc when the chaincode has them', async () => {
    const gateway = gatewayWith({
      lscc: lsccContract(
        [{ name: 'mycc', version: '1.0' }],
        { mycc: [STATIC_COLLECTION] },
      ),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
    );

    expect(chaincodes[0].collections.map((c) => c.name)).toEqual(['col1']);
  });

  // An ACL denial is indistinguishable from "no collections" if it is swallowed,
  // and reporting zero collections silently disables private extraction.
  test('raises an lscc collection query that failed for any other reason', async () => {
    const gateway = gatewayWith({
      lscc: async (fn) => {
        if (fn === 'GetChaincodes') {
          return json({ chaincodes: [{ name: 'mycc', version: '1.0' }] });
        }
        throw new Error('access denied for [GetCollectionsConfig][ch1]');
      },
    });

    await expectDiscoveryError(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
      /lscc\.GetCollectionsConfig failed for chaincode "mycc".*access denied/s,
    );
  });

  test('raises an lscc payload that is neither JSON nor a config package', async () => {
    const gateway = gatewayWith({
      lscc: async (fn) => {
        if (fn === 'GetChaincodes') {
          return json({ chaincodes: [{ name: 'mycc', version: '1.0' }] });
        }
        // Field 1 declares 40 bytes of payload in a 3-byte message.
        return new Uint8Array(Buffer.from([0x0a, 0x28, 0xff]));
      },
    });

    await expectDiscoveryError(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
      /neither JSON nor a CollectionConfigPackage/,
    );
  });

  // The 2.x lifecycle answers "no collections" with a definition that omits the
  // package, so a rejection here is always a failed query.
  test('raises a failed _lifecycle.QueryChaincodeDefinition', async () => {
    const gateway = gatewayWith({
      _lifecycle: async (fn) => {
        if (fn === 'QueryChaincodeDefinitions') {
          return json({
            chaincode_definitions: [
              { name: 'mycc', version: '1.0', sequence: 1 },
            ],
          });
        }
        throw new Error('timeout after 30000ms');
      },
    });

    await expectDiscoveryError(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
      /_lifecycle\.QueryChaincodeDefinition failed for chaincode "mycc".*timeout/s,
    );
  });

  // The collection package is field 6, so a walk that stalls before reaching it
  // cannot tell an absent package from an unread one.
  test('raises a definition protobuf it cannot walk to the end of', async () => {
    const gateway = gatewayWith({
      _lifecycle: async (fn) => {
        if (fn === 'QueryChaincodeDefinitions') {
          return json({
            chaincode_definitions: [
              { name: 'mycc', version: '1.0', sequence: 1 },
            ],
          });
        }
        // Field 1, wire type 3 (group start) — nothing can be skipped past it.
        return new Uint8Array(Buffer.from([0x0b]));
      },
    });

    await expectDiscoveryError(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
      /unknown wire type 3 at field 1/,
    );
  });

  // Without this the failure above would be retried against lscc, and a 1.x
  // answer would stand in for a 2.x peer's real failure.
  test('does not fall back to lscc after a collection query fails', async () => {
    const lscc = jest.fn(async () =>
      json({ chaincodes: [{ name: 'mycc', version: '1.0' }] }),
    );
    const gateway = gatewayWith({
      _lifecycle: async (fn) => {
        if (fn === 'QueryChaincodeDefinitions') {
          return json({
            chaincode_definitions: [
              { name: 'mycc', version: '1.0', sequence: 1 },
            ],
          });
        }
        throw new Error('not found');
      },
      lscc,
    });

    await expectDiscoveryError(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
      /_lifecycle\.QueryChaincodeDefinition failed/,
    );
    expect(lscc).not.toHaveBeenCalled();
  });

  test('still falls back to lscc when _lifecycle itself is unavailable', async () => {
    const gateway = gatewayWith({
      lscc: lsccContract([{ name: 'mycc', version: '1.0' }]),
    });

    const chaincodes = await resolved(
      new ChaincodeDiscoverer(gateway).queryCommitted('ch1'),
    );

    expect(chaincodes.map((c) => c.name)).toEqual(['mycc']);
  });
});
