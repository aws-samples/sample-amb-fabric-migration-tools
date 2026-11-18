// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Command } from 'commander';
import * as fs from 'fs';
import { FabricGateway } from '../../connection/fabric-gateway';
import { fingerprintDestination } from '../../replay/destination-fingerprint';
import { ReplayConfig } from '../../types';

/**
 * Destination channels a chaincode config writes to: every `channelMapping`
 * value, or the single `channel`.
 */
export function configuredDestChannels(cc: NonNullable<ReplayConfig['chaincode']>): string[] {
  const mapped = Object.values(cc.channelMapping ?? {}).filter((c) => c);
  if (mapped.length > 0) return [...new Set(mapped)].sort();
  return cc.channel ? [cc.channel] : [];
}

export const fingerprintDestinationCommand = new Command('fingerprint-destination')
  .description(
    'Print chaincode.destinationFingerprint for a replay config: the SHA-256 of ' +
      'each destination channel\'s genesis block. Read-only',
  )
  .requiredOption('--config <path>', 'Replay config JSON (chaincode adapter)')
  .option('--channels <channels...>', 'Destination channels (default: every one the config writes to)')
  .option('--allow-insecure', 'Allow plaintext gRPC (grpc://) connections')
  .action(async (opts) => {
    const config: ReplayConfig = JSON.parse(fs.readFileSync(opts.config, 'utf-8'));
    const cc = config.chaincode;
    if (!cc) throw new Error('fingerprint-destination needs a "chaincode" block in the config');
    const channels: string[] = opts.channels ?? configuredDestChannels(cc);
    if (channels.length === 0) {
      throw new Error('The config names no destination channel (channelMapping or channel)');
    }

    const gateway = new FabricGateway();
    await gateway.connect({
      connectionProfilePath: cc.connectionProfilePath,
      mspId: cc.mspId,
      certPath: cc.certPath,
      keyPath: cc.keyPath,
      timeouts: config.timeouts,
      allowInsecure: opts.allowInsecure ?? cc.allowInsecure,
    });
    try {
      const fingerprint = await fingerprintDestination(
        (destChannel) => gateway.getGatewayNetwork(destChannel), channels,
      );
      console.log(JSON.stringify({ destinationFingerprint: fingerprint }, null, 2));
    } finally {
      gateway.disconnect();
    }
  });
