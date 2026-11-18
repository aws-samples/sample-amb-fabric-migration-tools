// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { Manifest } from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('manifest-writer');

export class ManifestWriter {
  constructor(private readonly outputDir: string) {}

  write(manifest: Manifest): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const manifestPath = path.join(this.outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info({ path: manifestPath }, 'Manifest written');

    // Log summary. Synthesized implicit collections are counted apart from the
    // declared ones: there is one per channel org per chaincode, so folding them
    // in would make every 2.x channel look far richer in private data than it is.
    for (const channel of manifest.channels) {
      const collections = channel.chaincodes.flatMap((cc) => cc.collections);
      const implicitCollections = collections.filter((c) => c.implicit).length;

      logger.info(
        {
          channelId: channel.channelId,
          chaincodes: channel.chaincodes.length,
          collections: collections.length - implicitCollections,
          implicitCollections,
          purgeRiskCollections: collections.filter((c) => c.blockToLive > 0).length,
          ledgerHeight: channel.ledgerHeight,
        },
        'Channel summary',
      );
    }
  }

}
