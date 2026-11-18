// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Archive } from '../src/archive/reader';
import { compare } from '../src/compare/compare';
import { requirePeersCaughtUp, Destination } from '../src/destination';
import { Exit, RbError } from '../src/util/errors';

// A stand-in destination: only the orderer's and peers' heights are read.
const dst = (ordererHeight: number, peerHeights: number[]): Destination =>
  ({
    channel: 'ch',
    orderer: { height: async () => ordererHeight, address: 'orderer:7050', addresses: ['orderer:7050'] },
    peers: peerHeights.map((h, i) => ({ height: async () => h, address: `peer${i}:7051` })),
  }) as unknown as Destination;

describe('requirePeersCaughtUp', () => {
  it('passes when every named peer has the orderer height', async () => {
    await expect(requirePeersCaughtUp(dst(100, [100, 100]), [0, 1])).resolves.toBeUndefined();
  });

  it('refuses with Behind, naming the peer and both heights, when a peer lags', async () => {
    const p = requirePeersCaughtUp(dst(100, [100, 97]), [0, 1]);
    await expect(p).rejects.toMatchObject({ code: Exit.Behind });
    await expect(requirePeersCaughtUp(dst(100, [100, 97]), [1])).rejects.toThrow(/peer1:7051 is at height 97, the orderer at 100/);
  });

  it('checks only the peers named', async () => {
    await expect(requirePeersCaughtUp(dst(100, [100, 3]), [0])).resolves.toBeUndefined();
  });

  it('refuses an index the descriptor does not have', async () => {
    await expect(requirePeersCaughtUp(dst(100, [100]), [2])).rejects.toBeInstanceOf(RbError);
  });
});

describe('compare through a peer whose org joined the channel later', () => {
  // Only what compare touches: the peer's height and feed, the descriptor's peer entry, the archive's height.
  const peerDst = (peerHeight: number, deliverError: string, heightError?: string): Destination =>
    ({
      channel: 'ch',
      orderer: { height: async () => 34, address: 'orderer:7050', addresses: ['orderer:7050'] },
      peers: [{
        address: 'peer0:7051',
        height: async () => {
          if (heightError) throw new Error(heightError);
          return peerHeight;
        },
        feed: () => ({ get: async () => { throw new Error(deliverError); }, close: () => undefined }),
      }],
      ld: { d: { peers: [{ address: 'peer0:7051', reader: { msp: 'OrgBMSP' } }] } },
    }) as unknown as Destination;
  const archive = { height: 34, block: () => { throw new Error('not reached'); } } as unknown as Archive;

  it('reports a factual Behind error when FORBIDDEN prevents reading peer height', async () => {
    const p = compare(
      archive,
      peerDst(0, 'not reached', 'Deliver status FORBIDDEN'),
      0,
      () => undefined,
    );
    await expect(p).rejects.toMatchObject({ code: Exit.Behind });
    await expect(compare(
      archive,
      peerDst(0, 'not reached', 'Deliver status FORBIDDEN'),
      0,
      () => undefined,
    )).rejects.toThrow(/before its height could be read.*invalid reader identity or ACL/s);
  });

  it('reports Behind, naming the org, when the peer refuses its own org below the archive height', async () => {
    const p = compare(archive, peerDst(20, 'Deliver status FORBIDDEN'), 0, () => undefined);
    await expect(p).rejects.toMatchObject({ code: Exit.Behind });
    await expect(compare(archive, peerDst(20, 'Deliver status FORBIDDEN'), 0, () => undefined))
      .rejects.toThrow(/peer peer0:7051 refused OrgBMSP \(Deliver FORBIDDEN\) at height 20 of 34/);
  });

  it('leaves a FORBIDDEN from a peer that has every block as it is', async () => {
    await expect(compare(archive, peerDst(34, 'Deliver status FORBIDDEN'), 0, () => undefined))
      .rejects.toThrow(/^Deliver status FORBIDDEN$/);
  });

  it('leaves other Deliver errors as they are', async () => {
    await expect(compare(archive, peerDst(20, 'Deliver status SERVICE_UNAVAILABLE'), 0, () => undefined))
      .rejects.toThrow(/^Deliver status SERVICE_UNAVAILABLE$/);
  });
});
