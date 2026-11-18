// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LegacyFabricGateway } from '../src/connection/legacy-fabric-gateway';

/**
 * fabric-common fires the block listener for each block as it arrives, without
 * waiting for the previous call, and then fires the end-of-stream signal. These
 * tests stand in for it by firing every block and the end signal in one burst,
 * which is what a fast AMB peer did in the live multi-member test (C13).
 */
function gatewayDelivering(
  blocks: number[],
  ending: 'end-block-error' | 'endBlockReceived' = 'end-block-error',
): LegacyFabricGateway {
  const gateway = new LegacyFabricGateway();
  let listener: (error: unknown, event: unknown) => void = () => undefined;
  const eventService = {
    registerBlockListener: (cb: typeof listener) => { listener = cb; },
    build: () => undefined,
    sign: () => undefined,
    close: () => undefined,
    send: async () => {
      for (const n of blocks) {
        listener(null, { blockNumber: n, block: { n }, privateData: { [n]: {} } });
      }
      if (ending === 'endBlockReceived') listener(null, { endBlockReceived: true });
      else listener(new Error('Shutdown due to end block number has been seen'), null);
    },
  };
  const g = gateway as any;
  g.client = {
    newEventer: () => ({ connect: async () => undefined }),
    newEndpoint: (options: unknown) => options,
  };
  g.identityContext = {};
  g.endorser = { endpoint: { url: 'grpcs://peer', options: { pem: '' } } };
  g.channels.set('ch1', { newEventService: () => eventService });
  return gateway;
}

/** A handler whose earlier blocks take longer, so overlap reorders them. */
function slowEarlyHandler(order: number[], finished: number[]) {
  return async (blockNumber: number): Promise<void> => {
    order.push(blockNumber);
    await new Promise((r) => setTimeout(r, (5 - blockNumber) * 5));
    finished.push(blockNumber);
  };
}

describe('LegacyFabricGateway.deliverPrivateData', () => {
  it.each(['end-block-error', 'endBlockReceived'] as const)(
    'handles blocks one at a time, in delivery order (%s)',
    async (ending) => {
      const order: number[] = [];
      const finished: number[] = [];
      await gatewayDelivering([0, 1, 2, 3, 4], ending)
        .deliverPrivateData('ch1', 0, 10, slowEarlyHandler(order, finished));

      expect(order).toEqual([0, 1, 2, 3, 4]);
      expect(finished).toEqual([0, 1, 2, 3, 4]);
    },
  );

  /** The caller emits current state when this resolves, so it must come last. */
  it('resolves only after the last block\'s handler has finished', async () => {
    const finished: number[] = [];
    await gatewayDelivering([0, 1, 2])
      .deliverPrivateData('ch1', 0, 10, slowEarlyHandler([], finished));

    expect(finished).toHaveLength(3);
  });

  it('stops at the end block once its handler finishes', async () => {
    const finished: number[] = [];
    await gatewayDelivering([0, 1, 2, 3, 4])
      .deliverPrivateData('ch1', 0, 2, slowEarlyHandler([], finished));

    expect(finished).toEqual([0, 1, 2]);
  });

  it('rejects with a handler failure and runs nothing after it', async () => {
    const seen: number[] = [];
    await expect(gatewayDelivering([0, 1, 2]).deliverPrivateData('ch1', 0, 10,
      async (n) => {
        seen.push(n);
        if (n === 1) throw new Error('disk full');
      })).rejects.toThrow('disk full');

    expect(seen).toEqual([0, 1]);
  });
});
