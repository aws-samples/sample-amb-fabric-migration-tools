// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DiscoveryGateway } from './chaincode-discoverer';
import { DiscoveryError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const logger = createLogger('ledger-inspector');

export class LedgerInspector {
  constructor(private readonly gateway: DiscoveryGateway) {}

  /**
   * Get the current ledger height for a channel by querying the qscc system chaincode.
   * Equivalent to: peer channel getinfo -c <channelId>
   */
  async getHeight(channelId: string): Promise<number> {
    return withRetry(
      async () => {
        const network = this.gateway.getNetwork(channelId);
        const contract = network.getContract('qscc');

        // GetChainInfo returns a common.BlockchainInfo protobuf message
        const resultBytes = await contract.evaluateTransaction('GetChainInfo', channelId);
        const height = this.parseBlockchainInfoHeight(resultBytes);

        logger.info({ channelId, height }, 'Ledger height retrieved');
        return height;
      },
      `getHeight(${channelId})`,
    );
  }

  /**
   * Get a specific block by number via qscc.
   */
  async getBlockByNumber(channelId: string, blockNumber: number): Promise<Uint8Array> {
    return withRetry(
      async () => {
        const network = this.gateway.getNetwork(channelId);
        const contract = network.getContract('qscc');
        return contract.evaluateTransaction('GetBlockByNumber', channelId, blockNumber.toString());
      },
      `getBlockByNumber(${channelId}, ${blockNumber})`,
    );
  }

  /**
   * Parse the height field from a common.BlockchainInfo protobuf message.
   * BlockchainInfo { height: uint64 (field 1), currentBlockHash: bytes (field 2), previousBlockHash: bytes (field 3) }
   */
  private parseBlockchainInfoHeight(data: Uint8Array): number {
    const buf = Buffer.from(data);

    // Try JSON parse first (some SDK versions return JSON)
    try {
      const parsed = JSON.parse(buf.toString('utf-8'));
      if (typeof parsed.height !== 'undefined') {
        return Number(parsed.height);
      }
    } catch {
      // Not JSON, parse as protobuf
    }

    // Protobuf: field 1, wire type 0 (varint) = tag byte 0x08
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (fieldNumber === 1 && wireType === 0) {
        // Read varint for height
        let height = 0;
        let shift = 0;
        while (offset < buf.length) {
          const byte = buf[offset++];
          height += (byte & 0x7f) * (2 ** shift);
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        return height;
      }

      // Skip other fields
      if (wireType === 0) {
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {
          // Empty on purpose — the advance is the condition's `offset++`.
        }
      } else if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (offset < buf.length) {
          const byte = buf[offset++];
          len |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        offset += len;
      } else if (wireType === 1) {
        offset += 8;
      } else if (wireType === 5) {
        offset += 4;
      }
    }

    throw new DiscoveryError('Failed to parse BlockchainInfo height from protobuf');
  }
}
