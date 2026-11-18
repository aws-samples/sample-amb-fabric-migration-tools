// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { ResolvedEndpoints, ConnectionProfile, DiscoverOptions } from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('connection-profile-builder');

const TLS_CERT_FILENAME = 'managedblockchain-tls-chain.pem';

/**
 * Resolve the TLS CA certificate path. Search order:
 *   1. Explicit --tls-cert CLI option
 *   2. $TLS_CA_CERT environment variable
 *   3. $HOME/managedblockchain-tls-chain.pem
 *   4. /tmp/managedblockchain-tls-chain.pem
 *
 * Once found, the cert is copied into outputDir (if provided) so that the
 * saved connection profile remains self-contained and portable.
 */
function resolveTlsCertPath(outputDir?: string, explicitPath?: string): string {
  const candidates: string[] = [];

  if (explicitPath) {
    candidates.push(explicitPath);
  }
  if (process.env.TLS_CA_CERT) {
    candidates.push(process.env.TLS_CA_CERT);
  }
  const home = process.env.HOME || '/tmp';
  candidates.push(path.join(home, TLS_CERT_FILENAME));
  candidates.push(path.join('/tmp', TLS_CERT_FILENAME));

  let foundPath: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      foundPath = candidate;
      break;
    }
  }

  if (!foundPath) {
    const searched = candidates.join(', ');
    throw new Error(
      `TLS CA certificate not found. Searched: ${searched}. ` +
        'Use --tls-cert <path> or set $TLS_CA_CERT to the certificate location.',
    );
  }

  // If outputDir is set, copy the cert there so the profile is self-contained
  if (outputDir) {
    const destPath = path.join(outputDir, TLS_CERT_FILENAME);
    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(foundPath, destPath);
      // copyFileSync keeps the source's mode; the output directory is owner-only throughout.
      fs.chmodSync(destPath, 0o600);
      logger.info({ src: foundPath, dest: destPath }, 'Copied TLS CA cert to output directory');
    }
    return destPath;
  }

  return foundPath;
}

/**
 * Resolve the admin MSP path for mutual TLS client certs.
 * Search order: --msp-path option → $MSP_PATH env var.
 * Returns undefined if no MSP is available (falls back to CA enrollment without mTLS).
 */
function resolveClientTlsCerts(mspPath?: string): { certPath: string; keyPath: string } | undefined {
  const resolved = mspPath || process.env.MSP_PATH;
  if (!resolved) return undefined;

  const certPath = path.join(resolved, 'signcerts', 'cert.pem');
  if (!fs.existsSync(certPath)) return undefined;

  const keystoreDir = path.join(resolved, 'keystore');
  if (!fs.existsSync(keystoreDir)) return undefined;

  const keyFiles = fs.readdirSync(keystoreDir).filter((f) => !f.startsWith('.'));
  if (keyFiles.length === 0) return undefined;

  const keyPath = path.join(keystoreDir, keyFiles[0]);
  logger.info({ certPath, keyPath }, 'Resolved client TLS certs from MSP');
  return { certPath, keyPath };
}

export class ConnectionProfileBuilder {
  build(endpoints: ResolvedEndpoints, options: DiscoverOptions): ConnectionProfile {
    const peerName = `peer-${options.nodeId}`;
    const ordererName = `orderer-${options.networkId}`;
    const caName = `ca-${options.memberId}`;
    const orgName = `org-${options.memberId}`;
    const mspId = options.memberId;
    const tlsCertPath = resolveTlsCertPath(options.outputDir, options.tlsCertPath);
    const clientTls = resolveClientTlsCerts(options.mspPath);

    // Build channel-to-peer mapping so fabric-network knows which peers to
    // query when discovery is disabled. Include bootstrap channel and any
    // explicitly provided channels.
    const channels: ConnectionProfile['channels'] = {};
    const knownChannels = new Set<string>();
    if (options.bootstrapChannel) knownChannels.add(options.bootstrapChannel);
    if (options.channels) options.channels.forEach((ch) => knownChannels.add(ch));
    for (const ch of knownChannels) {
      channels[ch] = {
        orderers: [ordererName],
        peers: { [peerName]: { endorsingPeer: true, chaincodeQuery: true, ledgerQuery: true, eventSource: true } },
      };
    }

    const profile: ConnectionProfile = {
      name: `amb-${options.networkId}`,
      version: '1.0.0',
      channels,
      ...(clientTls && {
        client: {
          organization: orgName,
          tlsClientCerts: {
            certPath: clientTls.certPath,
            keyPath: clientTls.keyPath,
          },
        },
      }),
      organizations: {
        [orgName]: {
          mspid: mspId,
          peers: [peerName],
          certificateAuthorities: [caName],
        },
      },
      orderers: {
        [ordererName]: {
          url: `grpcs://${endpoints.ordererEndpoint}`,
          tlsCACerts: { path: tlsCertPath },
          grpcOptions: {
            'ssl-target-name-override': endpoints.ordererEndpoint.split(':')[0],
          },
        },
      },
      peers: {
        [peerName]: {
          url: `grpcs://${endpoints.peerEndpoint}`,
          tlsCACerts: { path: tlsCertPath },
          eventUrl: `grpcs://${endpoints.peerEventEndpoint}`,
          grpcOptions: {
            'ssl-target-name-override': endpoints.peerEndpoint.split(':')[0],
          },
        },
      },
      certificateAuthorities: {
        [caName]: {
          url: `https://${endpoints.caEndpoint}`,
          tlsCACerts: { path: tlsCertPath },
        },
      },
    };

    logger.info(
      {
        profileName: profile.name,
        peerEndpoint: endpoints.peerEndpoint,
        peerEventEndpoint: endpoints.peerEventEndpoint,
        ordererEndpoint: endpoints.ordererEndpoint,
        caEndpoint: endpoints.caEndpoint,
        tlsCertPath,
      },
      'Connection profile built',
    );
    return profile;
  }
}
