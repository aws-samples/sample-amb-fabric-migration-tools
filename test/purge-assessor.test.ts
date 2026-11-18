// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PurgeAssessor } from '../src/extraction/private-data/purge-assessor';
import { ChannelInfo, CollectionConfig } from '../src/types';

describe('PurgeAssessor', () => {
  const assessor = new PurgeAssessor();

  const makeChannel = (collections: Partial<CollectionConfig>[], ledgerHeight = 1000): ChannelInfo => ({
    channelId: 'mychannel',
    ledgerHeight,
    chaincodes: [
      {
        name: 'mycc',
        version: '1.0',
        sequence: 1,
        collections: collections.map((c) => ({
          name: c.name ?? 'coll1',
          policy: '',
          requiredPeerCount: 0,
          maxPeerCount: 0,
          blockToLive: c.blockToLive ?? 0,
          memberOnlyRead: false,
          memberOnlyWrite: false,
        })),
      },
    ],
  });

  test('reports no risk when blockToLive is 0', () => {
    const channel = makeChannel([{ name: 'collA', blockToLive: 0 }]);
    const risks = assessor.assess(channel);

    expect(risks).toHaveLength(1);
    expect(risks[0].riskLevel).toBe('none');
    expect(risks[0].estimatedPurgedBlocks).toBe(0);
  });

  test('reports low risk when ledger height within retention window', () => {
    const channel = makeChannel([{ name: 'collA', blockToLive: 2000 }], 500);
    const risks = assessor.assess(channel);

    expect(risks[0].riskLevel).toBe('low');
    expect(risks[0].estimatedPurgedBlocks).toBe(0);
  });

  test('reports medium risk when some data may be purged', () => {
    const channel = makeChannel([{ name: 'collA', blockToLive: 800 }], 1000);
    const risks = assessor.assess(channel);

    expect(risks[0].riskLevel).toBe('medium');
    expect(risks[0].estimatedPurgedBlocks).toBe(200);
  });

  test('reports high risk when most data likely purged', () => {
    const channel = makeChannel([{ name: 'collA', blockToLive: 100 }], 10000);
    const risks = assessor.assess(channel);

    expect(risks[0].riskLevel).toBe('high');
    expect(risks[0].estimatedPurgedBlocks).toBe(9900);
  });

  test('assesses multiple collections independently', () => {
    const channel = makeChannel(
      [
        { name: 'safe', blockToLive: 0 },
        { name: 'risky', blockToLive: 50 },
      ],
      5000,
    );
    const risks = assessor.assess(channel);

    expect(risks).toHaveLength(2);
    expect(risks.find((r) => r.collection === 'safe')!.riskLevel).toBe('none');
    expect(risks.find((r) => r.collection === 'risky')!.riskLevel).toBe('high');
  });
});
