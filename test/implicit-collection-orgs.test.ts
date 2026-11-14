import { DiscoveryGateway } from '../src/discovery/chaincode-discoverer';
import { resolveImplicitOrgMspIds } from '../src/discovery/implicit-collection-orgs';
import { NetworkAdapter } from '../src/connection/network-adapter';
import { DiscoveryError } from '../src/utils/errors';

// ── Fixtures ──

/** A config block carrying one Application org group per MSP ID. */
function configBlock(mspIds: string[]): Uint8Array {
  const orgs: Record<string, unknown> = {};
  mspIds.forEach((mspId, i) => {
    orgs[`Org${i + 1}`] = { values: { MSP: { value: { config: { name: mspId } } } } };
  });

  const block = {
    data: {
      data: [
        {
          payload: {
            data: {
              config: {
                channel_group: {
                  values: { Capabilities: { value: { capabilities: { V2_0: {} } } } },
                  groups: {
                    Application: {
                      values: {
                        Capabilities: { value: { capabilities: { V2_0: {} } } },
                      },
                      groups: orgs,
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  };

  return new Uint8Array(Buffer.from(JSON.stringify(block), 'utf-8'));
}

/** Gateway whose cscc returns a per-channel config block. */
function gatewayFor(
  blocks: Record<string, Uint8Array | Error>,
  onQuery: (channelId: string) => void = () => {},
): DiscoveryGateway {
  return {
    getNetwork: (channelId: string) =>
      ({
        getContract: () => ({
          evaluateTransaction: async (_fn: string, requested: string) => {
            onQuery(requested);
            const block = blocks[requested];
            if (block === undefined) throw new Error(`no config block for ${requested}`);
            if (block instanceof Error) throw block;
            return block;
          },
          submitTransaction: jest.fn(),
        }),
        channelId,
      }) as unknown as NetworkAdapter,
    getMspId: () => 'Org1MSP',
  };
}

// A failed config-block read is retried with backoff before it propagates.
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ──

describe('resolveImplicitOrgMspIds', () => {
  test('returns the channel\'s application org MSP IDs on 2.x', async () => {
    const gateway = gatewayFor({ ch1: configBlock(['Org2MSP', 'Org1MSP']) });

    await expect(resolveImplicitOrgMspIds(gateway, 'ch1', '2.2')).resolves.toEqual([
      'Org1MSP',
      'Org2MSP',
    ]);
  });

  // Membership is a per-channel property, so reading it once per network would
  // synthesize collections for orgs that are not on the channel and miss the
  // ones that are.
  test('reads membership from the channel it was asked about', async () => {
    const queried: string[] = [];
    const gateway = gatewayFor(
      {
        ch1: configBlock(['Org1MSP', 'Org2MSP']),
        ch2: configBlock(['Org3MSP']),
      },
      (channelId) => queried.push(channelId),
    );

    await expect(resolveImplicitOrgMspIds(gateway, 'ch2', '2.2')).resolves.toEqual([
      'Org3MSP',
    ]);
    expect(queried).toEqual(['ch2']);
  });

  test('resolves nothing on a pre-2.0 network without querying the peer', async () => {
    const queried: string[] = [];
    const gateway = gatewayFor({ ch1: configBlock(['Org1MSP']) }, (c) => queried.push(c));

    await expect(resolveImplicitOrgMspIds(gateway, 'ch1', '1.4')).resolves.toEqual([]);
    expect(queried).toEqual([]);
  });

  // An empty result would synthesize no collections, and since implicit
  // collections appear in no chaincode definition nothing downstream would
  // notice their private data was never looked for.
  test('refuses a 2.x channel whose config block names no orgs', async () => {
    const gateway = gatewayFor({ ch1: configBlock([]) });
    const promise = resolveImplicitOrgMspIds(gateway, 'ch1', '2.2');

    const assertions = Promise.all([
      expect(promise).rejects.toThrow(DiscoveryError),
      expect(promise).rejects.toThrow(/Every channel has at least one application/),
    ]);
    await jest.runAllTimersAsync();
    await assertions;
  });

  test('refuses a 2.x channel whose config block cannot be read', async () => {
    const gateway = gatewayFor({
      ch1: new Error('access denied for [GetConfigBlock][ch1]'),
    });
    const promise = resolveImplicitOrgMspIds(gateway, 'ch1', '2.2');

    const assertions = Promise.all([
      expect(promise).rejects.toThrow(DiscoveryError),
      expect(promise).rejects.toThrow(/config block.*access denied/s),
    ]);
    await jest.runAllTimersAsync();
    await assertions;
  });
});
