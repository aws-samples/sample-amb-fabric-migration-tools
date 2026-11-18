// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ChannelDiscoverer } from '../src/discovery/channel-discoverer';
import { DiscoveryGateway } from '../src/discovery/chaincode-discoverer';
import { NetworkAdapter, ContractAdapter } from '../src/connection/network-adapter';
import { verifyRequestedChannels } from '../src/cli/commands/discover';

/** Helper to build a ChannelQueryResponse protobuf by hand. */
function buildChannelQueryResponseProtobuf(channelIds: string[]): Uint8Array {
  // ChannelQueryResponse: field 1 (repeated) = ChannelInfo (length-delimited)
  // ChannelInfo: field 1 = channel_id (string, length-delimited)
  const parts: Buffer[] = [];
  for (const id of channelIds) {
    const idBytes = Buffer.from(id, 'utf-8');
    // ChannelInfo: tag=0x0a (field 1, wire type 2), varint length, string bytes
    const innerBuf = Buffer.concat([
      Buffer.from([0x0a, idBytes.length]),
      idBytes,
    ]);
    // ChannelQueryResponse: tag=0x0a (field 1, wire type 2), varint length, ChannelInfo bytes
    parts.push(
      Buffer.concat([
        Buffer.from([0x0a, innerBuf.length]),
        innerBuf,
      ]),
    );
  }
  return new Uint8Array(Buffer.concat(parts));
}

function buildJsonResponse(channelIds: string[]): Uint8Array {
  const json = JSON.stringify({
    channels: channelIds.map((id) => ({ channel_id: id })),
  });
  return new Uint8Array(Buffer.from(json, 'utf-8'));
}

function createMockContract(response: Uint8Array): ContractAdapter {
  return {
    evaluateTransaction: jest.fn().mockResolvedValue(response),
    submitTransaction: jest.fn(),
  };
}

function createMockGateway(opts: {
  contract?: ContractAdapter;
  evaluateSystemChaincode?: (
    channelId: string,
    chaincodeName: string,
    functionName: string,
    ...args: string[]
  ) => Promise<Uint8Array>;
}): DiscoveryGateway {
  const contract = opts.contract ?? createMockContract(new Uint8Array(0));
  return {
    getNetwork: jest.fn().mockReturnValue({
      getContract: jest.fn().mockReturnValue(contract),
    } as unknown as NetworkAdapter),
    getMspId: () => 'm-TEST123',
    evaluateSystemChaincode: opts.evaluateSystemChaincode,
  };
}

describe('ChannelDiscoverer', () => {
  describe('listChannels', () => {
    test('returns empty array when no bootstrap channel provided', async () => {
      const gateway = createMockGateway({});
      const discoverer = new ChannelDiscoverer(gateway);
      const result = await discoverer.listChannels();
      expect(result).toEqual([]);
    });

    test('uses evaluateSystemChaincode when available (protobuf response)', async () => {
      const response = buildChannelQueryResponseProtobuf(['mychannel', 'tradechannel']);
      const evalSysCC = jest.fn().mockResolvedValue(response);

      const gateway = createMockGateway({ evaluateSystemChaincode: evalSysCC });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.listChannels('mychannel');

      expect(result).toEqual(['mychannel', 'tradechannel']);
      expect(evalSysCC).toHaveBeenCalledWith('mychannel', 'cscc', 'GetChannels');
      // Should NOT fall back to evaluateTransaction
      expect(gateway.getNetwork).not.toHaveBeenCalled();
    });

    test('uses evaluateSystemChaincode when available (JSON response)', async () => {
      const response = buildJsonResponse(['alpha', 'beta']);
      const evalSysCC = jest.fn().mockResolvedValue(response);

      const gateway = createMockGateway({ evaluateSystemChaincode: evalSysCC });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.listChannels('alpha');
      expect(result).toEqual(['alpha', 'beta']);
    });

    test('falls back to evaluateTransaction when evaluateSystemChaincode fails', async () => {
      const response = buildChannelQueryResponseProtobuf(['fallback-channel']);
      const contract = createMockContract(response);
      const evalSysCC = jest.fn().mockRejectedValue(new Error('raw query failed'));

      const gateway = createMockGateway({
        contract,
        evaluateSystemChaincode: evalSysCC,
      });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.listChannels('fallback-channel');
      expect(result).toEqual(['fallback-channel']);
      expect(contract.evaluateTransaction).toHaveBeenCalledWith('GetChannels');
    });

    test('falls back to evaluateTransaction when evaluateSystemChaincode is not implemented', async () => {
      const response = buildJsonResponse(['nocustom']);
      const contract = createMockContract(response);

      const gateway = createMockGateway({ contract });
      // Remove the optional method
      delete (gateway as any).evaluateSystemChaincode;

      const discoverer = new ChannelDiscoverer(gateway);
      const result = await discoverer.listChannels('nocustom');

      expect(result).toEqual(['nocustom']);
      expect(contract.evaluateTransaction).toHaveBeenCalledWith('GetChannels');
    });

    test('parses single-channel protobuf response', async () => {
      const response = buildChannelQueryResponseProtobuf(['onlyone']);
      const evalSysCC = jest.fn().mockResolvedValue(response);

      const gateway = createMockGateway({ evaluateSystemChaincode: evalSysCC });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.listChannels('onlyone');
      expect(result).toEqual(['onlyone']);
    });

    test('returns empty array for empty protobuf response', async () => {
      const evalSysCC = jest.fn().mockResolvedValue(new Uint8Array(0));
      const contract = createMockContract(new Uint8Array(0));

      const gateway = createMockGateway({
        contract,
        evaluateSystemChaincode: evalSysCC,
      });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.listChannels('empty');
      expect(result).toEqual([]);
    });
  });

  describe('verifyChannel', () => {
    test('returns true when qscc.GetChainInfo succeeds via evaluateSystemChaincode', async () => {
      const evalSysCC = jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
      const gateway = createMockGateway({ evaluateSystemChaincode: evalSysCC });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.verifyChannel('mychannel');
      expect(result).toBe(true);
      expect(evalSysCC).toHaveBeenCalledWith('mychannel', 'qscc', 'GetChainInfo', 'mychannel');
    });

    test('returns false when qscc.GetChainInfo fails', async () => {
      const evalSysCC = jest.fn().mockRejectedValue(new Error('channel not found'));
      const gateway = createMockGateway({ evaluateSystemChaincode: evalSysCC });
      const discoverer = new ChannelDiscoverer(gateway);

      const result = await discoverer.verifyChannel('nonexistent');
      expect(result).toBe(false);
    });

    test('falls back to evaluateTransaction when evaluateSystemChaincode is not available', async () => {
      const contract = createMockContract(new Uint8Array([1, 2, 3]));
      const gateway = createMockGateway({ contract });
      delete (gateway as any).evaluateSystemChaincode;

      const discoverer = new ChannelDiscoverer(gateway);
      const result = await discoverer.verifyChannel('mychannel');

      expect(result).toBe(true);
      expect(contract.evaluateTransaction).toHaveBeenCalledWith('GetChainInfo', 'mychannel');
    });
  });
});


describe('verifyRequestedChannels', () => {
  test('returns every requested channel when all verify', async () => {
    const discoverer = {
      verifyChannel: jest.fn().mockResolvedValue(true),
    } as unknown as ChannelDiscoverer;

    await expect(verifyRequestedChannels(discoverer, ['ch1', 'ch2']))
      .resolves.toEqual(['ch1', 'ch2']);
  });

  test('refuses a partial manifest and names every failed channel', async () => {
    const verifyChannel = jest.fn(async (channelId: string) =>
      channelId === 'ch1',
    );
    const discoverer = { verifyChannel } as unknown as ChannelDiscoverer;

    await expect(verifyRequestedChannels(
      discoverer, ['ch1', 'ch2', 'ch3'],
    )).rejects.toThrow(/Could not verify requested channel\(s\): ch2, ch3/);
    expect(verifyChannel).toHaveBeenCalledTimes(3);
  });
});
