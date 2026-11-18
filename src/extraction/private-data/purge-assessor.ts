// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CollectionConfig, ChannelInfo } from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('purge-assessor');

export interface PurgeRisk {
  collection: string;
  chaincode: string;
  blockToLive: number;
  ledgerHeight: number;
  estimatedPurgedBlocks: number;
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  message: string;
}

export class PurgeAssessor {
  /**
   * Assess purge risk for all private data collections on a channel.
   * If blockToLive > 0, private data values are automatically purged
   * after that many blocks have been committed since the data was written.
   */
  assess(channel: ChannelInfo): PurgeRisk[] {
    const risks: PurgeRisk[] = [];

    for (const cc of channel.chaincodes) {
      for (const coll of cc.collections) {
        const risk = this.assessCollection(coll, cc.name, channel.ledgerHeight);
        risks.push(risk);

        if (risk.riskLevel !== 'none') {
          logger.warn(
            {
              channelId: channel.channelId,
              collection: coll.name,
              blockToLive: coll.blockToLive,
              riskLevel: risk.riskLevel,
            },
            risk.message,
          );
        }
      }
    }

    return risks;
  }

  private assessCollection(
    collection: CollectionConfig,
    chaincodeName: string,
    ledgerHeight: number,
  ): PurgeRisk {
    if (collection.blockToLive === 0) {
      return {
        collection: collection.name,
        chaincode: chaincodeName,
        blockToLive: 0,
        ledgerHeight,
        estimatedPurgedBlocks: 0,
        riskLevel: 'none',
        message: 'No purge policy — all private data retained indefinitely',
      };
    }

    const btl = collection.blockToLive;
    const purgedBlocks = Math.max(0, ledgerHeight - btl);

    let riskLevel: PurgeRisk['riskLevel'];
    let message: string;

    if (purgedBlocks === 0) {
      riskLevel = 'low';
      message = `blockToLive=${btl} but ledger height (${ledgerHeight}) is within retention window — no data purged yet`;
    } else if (purgedBlocks < ledgerHeight * 0.5) {
      riskLevel = 'medium';
      message = `~${purgedBlocks} blocks of private data may have been purged (blockToLive=${btl}, height=${ledgerHeight})`;
    } else {
      riskLevel = 'high';
      message = `Most private data likely purged — ~${purgedBlocks} blocks beyond retention (blockToLive=${btl}, height=${ledgerHeight}). Only hashes remain for purged data.`;
    }

    return {
      collection: collection.name,
      chaincode: chaincodeName,
      blockToLive: btl,
      ledgerHeight,
      estimatedPurgedBlocks: purgedBlocks,
      riskLevel,
      message,
    };
  }
}
