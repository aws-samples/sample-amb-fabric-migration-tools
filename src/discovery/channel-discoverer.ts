// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DiscoveryGateway } from './chaincode-discoverer';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const logger = createLogger('channel-discoverer');

export class ChannelDiscoverer {
  constructor(private readonly gateway: DiscoveryGateway) {}

  /**
   * List all channels the peer has joined by querying the cscc system chaincode.
   *
   * cscc.GetChannels works with an empty channel ID (same as `peer channel list`),
   * so no bootstrap channel is required. If a bootstrap channel is provided it
   * will be used as the channel context for the query, but either way cscc
   * returns all channels the peer has joined.
   *
   * @param bootstrapChannelId Optional channel context. Defaults to "" (empty).
   * @returns Array of channel IDs the peer has joined.
   */
  async listChannels(bootstrapChannelId?: string): Promise<string[]> {
    const channelContext = bootstrapChannelId || '';
    logger.info(
      { channelContext: channelContext || '(empty)' },
      'Querying channels via cscc system chaincode',
    );

    return withRetry(
      async () => {
        // Try the raw fabric-common query path first — this bypasses the SDK's
        // transaction wrapper and is more reliable for system chaincodes.
        if (this.gateway.evaluateSystemChaincode) {
          try {
            const resultBytes = await this.gateway.evaluateSystemChaincode(
              channelContext,
              'cscc',
              'GetChannels',
            );
            const channels = this.parseGetChannelsResponse(resultBytes);
            if (channels.length > 0) {
              return channels;
            }
            logger.warn('Raw cscc.GetChannels returned empty result — trying evaluateTransaction fallback');
          } catch (err) {
            logger.warn(
              { error: (err as Error).message },
              'Raw cscc.GetChannels query failed — trying evaluateTransaction fallback',
            );
          }
        }

        // Fallback: use the standard SDK evaluateTransaction path.
        const network = this.gateway.getNetwork(channelContext);
        const contract = network.getContract('cscc');
        const resultBytes = await contract.evaluateTransaction('GetChannels');

        return this.parseGetChannelsResponse(resultBytes);
      },
      'queryChannels',
    );
  }

  /**
   * Verify that a specific channel exists by querying qscc for the channel's
   * blockchain info. This is a real verification — it confirms the peer has
   * actually joined the channel and can serve queries for it.
   */
  async verifyChannel(channelId: string): Promise<boolean> {
    try {
      // Try raw query first — qscc.GetChainInfo returns blockchain info for the channel
      if (this.gateway.evaluateSystemChaincode) {
        const resultBytes = await this.gateway.evaluateSystemChaincode(
          channelId,
          'qscc',
          'GetChainInfo',
          channelId,
        );
        // If we get a response, the channel exists and the peer has joined it
        return resultBytes.length > 0;
      }

      // Fallback: try evaluateTransaction on qscc
      const network = this.gateway.getNetwork(channelId);
      const contract = network.getContract('qscc');
      const resultBytes = await contract.evaluateTransaction('GetChainInfo', channelId);
      return resultBytes.length > 0;
    } catch (err) {
      logger.warn(
        { channelId, error: (err as Error).message },
        'Channel verification failed',
      );
      return false;
    }
  }

  /**
   * Parse the cscc.GetChannels response.
   * Returns a ChannelQueryResponse: { channels: [{ channel_id: string }] }
   * Tries JSON first, falls back to protobuf decoding via fabric-protos,
   * then a hand-written minimal protobuf parser as a last resort.
   */
  private parseGetChannelsResponse(resultBytes: Uint8Array): string[] {
    const buf = Buffer.from(resultBytes);

    if (buf.length === 0) {
      logger.warn('cscc.GetChannels returned empty response');
      return [];
    }

    // Try JSON first (some SDK/peer combinations return JSON)
    try {
      const parsed = JSON.parse(buf.toString('utf-8'));
      const channels = parsed.channels ?? parsed;
      if (Array.isArray(channels)) {
        const ids = channels
          .map((c: any) => c.channel_id ?? c.channelId ?? c)
          .filter((id: any) => typeof id === 'string' && id.length > 0);
        if (ids.length > 0) {
          logger.info({ channels: ids, method: 'json' }, 'Channels discovered via cscc');
          return ids;
        }
      }
    } catch {
      // Not JSON — parse as protobuf
    }

    // Protobuf: ChannelQueryResponse { repeated ChannelInfo channels = 1; }
    // ChannelInfo { string channel_id = 1; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fabricProtos = require('fabric-protos');
      const decoded = fabricProtos.protos.ChannelQueryResponse.decode(buf);
      const ids = (decoded.channels ?? [])
        .map((c: any) => c.channel_id)
        .filter((id: string) => id && id.length > 0);

      if (ids.length > 0) {
        logger.info({ channels: ids, method: 'protobuf' }, 'Channels discovered via cscc');
        return ids;
      }
    } catch (err) {
      logger.debug(
        { error: (err as Error).message },
        'fabric-protos decode failed — trying manual protobuf parser',
      );
    }

    // Minimal protobuf fallback: hand-parse the simple message structure
    // ChannelQueryResponse: field 1 (repeated, length-delimited) = ChannelInfo
    // ChannelInfo: field 1 (length-delimited) = channel_id string
    const ids: string[] = [];
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (offset < buf.length) {
          const byte = buf[offset++];
          len += (byte & 0x7f) * (2 ** shift);
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }

        if (fieldNumber === 1) {
          // Embedded ChannelInfo message — parse its field 1 (channel_id)
          const innerBuf = buf.subarray(offset, offset + len);
          const channelId = this.parseChannelInfo(innerBuf);
          if (channelId) ids.push(channelId);
        }
        offset += len;
      } else if (wireType === 0) {
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {
          // Empty on purpose — the advance is the condition's `offset++`.
        }
      } else {
        break; // Unknown wire type — stop parsing
      }
    }

    if (ids.length > 0) {
      logger.info({ channels: ids, method: 'manual-protobuf' }, 'Channels discovered via cscc');
    } else {
      logger.warn(
        { responseLength: buf.length, firstBytes: buf.subarray(0, 32).toString('hex') },
        'Could not parse cscc.GetChannels response with any method',
      );
    }
    return ids;
  }

  private parseChannelInfo(buf: Buffer): string | null {
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset++];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        let len = 0;
        let shift = 0;
        while (offset < buf.length) {
          const byte = buf[offset++];
          len += (byte & 0x7f) * (2 ** shift);
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        if (fieldNumber === 1) {
          return buf.subarray(offset, offset + len).toString('utf-8');
        }
        offset += len;
      } else if (wireType === 0) {
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {
          // Empty on purpose — the advance is the condition's `offset++`.
        }
      } else {
        break;
      }
    }
    return null;
  }
}
