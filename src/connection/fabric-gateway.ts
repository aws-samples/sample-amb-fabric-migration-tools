import * as crypto from 'crypto';
import * as fs from 'fs';
import * as grpc from '@grpc/grpc-js';
import { connect, Gateway, Network, signers } from '@hyperledger/fabric-gateway';
import {
  ConnectionProfile,
  GrpcTimeouts,
  DEFAULT_GRPC_TIMEOUTS,
  GRPC_MAX_RECEIVE_BYTES,
} from '../types';
import { ConnectionError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { NetworkAdapter } from './network-adapter';

const logger = createLogger('fabric-gateway');

export interface FabricGatewayConfig {
  /** Path to a standard Fabric connection profile JSON. */
  connectionProfilePath: string;
  /** MSP ID for the submitting identity. */
  mspId: string;
  /** Path to the PEM-encoded X.509 certificate. */
  certPath: string;
  /** Path to the PEM-encoded private key. */
  keyPath: string;
  /** gRPC timeout overrides. */
  timeouts?: GrpcTimeouts;
  /** Allow plaintext (grpc://) connections. Default: false. */
  allowInsecure?: boolean;
}

/**
 * Generic Hyperledger Fabric Gateway connector that works with any Fabric 2.x
 * network using a standard connection profile.
 *
 * Compatible with:
 *   - Self-managed open-source Fabric networks
 *   - managed Fabric services
 *   - Amazon Managed Blockchain (as a replay target)
 *   - Any Fabric deployment that produces a standard connection profile
 *
 * The connection profile format is the same JSON structure used by
 * fabric-sdk-node and the Fabric Gateway SDK — containing peer endpoints,
 * TLS CA certificates, orderer endpoints, and organization definitions.
 */
export class FabricGateway {
  private gateway: Gateway | null = null;
  private grpcClient: grpc.Client | null = null;
  private mspId: string = '';

  async connect(config: FabricGatewayConfig): Promise<void> {
    // Load and parse the connection profile
    if (!fs.existsSync(config.connectionProfilePath)) {
      throw new ConnectionError(
        `Connection profile not found: ${config.connectionProfilePath}`,
      );
    }
    const profileJson = fs.readFileSync(config.connectionProfilePath, 'utf-8');
    const profile: ConnectionProfile = JSON.parse(profileJson);

    // Find the first peer in the profile
    const peerNames = Object.keys(profile.peers);
    if (peerNames.length === 0) {
      throw new ConnectionError('No peers defined in connection profile');
    }
    const peerConfig = profile.peers[peerNames[0]];
    const peerUrl = peerConfig.url;

    // Load identity credentials
    if (!fs.existsSync(config.certPath)) {
      throw new ConnectionError(`Certificate not found: ${config.certPath}`);
    }
    if (!fs.existsSync(config.keyPath)) {
      throw new ConnectionError(`Private key not found: ${config.keyPath}`);
    }
    const certificate = fs.readFileSync(config.certPath, 'utf-8');
    const privateKeyPem = fs.readFileSync(config.keyPath, 'utf-8');

    // Build gRPC client — handle both TLS (grpcs://) and plaintext (grpc://)
    const isTls = peerUrl.startsWith('grpcs://');
    const hostPort = peerUrl.replace(/^grpcs?:\/\//, '');

    let credentials: grpc.ChannelCredentials;
    if (isTls) {
      // The destination is trusted only through the CA its profile names. With
      // none, gRPC would accept any certificate the system roots vouch for.
      const tlsCertPath = peerConfig.tlsCACerts?.path;
      const tlsCertPem = peerConfig.tlsCACerts?.pem;
      if (tlsCertPath && fs.existsSync(tlsCertPath)) {
        credentials = grpc.credentials.createSsl(fs.readFileSync(tlsCertPath));
      } else if (tlsCertPath && !tlsCertPem) {
        throw new ConnectionError(`Peer ${hostPort}: tlsCACerts.path ${tlsCertPath} does not exist`);
      } else if (tlsCertPem) {
        credentials = grpc.credentials.createSsl(Buffer.from(tlsCertPem));
      } else {
        throw new ConnectionError(
          `Peer ${hostPort} has no tlsCACerts (path or pem) in the connection profile. ` +
            'Name the CA that issued its TLS certificate; system roots are not trusted.',
        );
      }
    } else if (config.allowInsecure) {
      logger.warn(
        { peer: hostPort },
        'Using insecure (plaintext) gRPC connection — private data and credentials ' +
          'will be transmitted unencrypted.',
      );
      credentials = grpc.credentials.createInsecure();
    } else {
      throw new ConnectionError(
        `Peer ${hostPort} uses plaintext gRPC (grpc://). ` +
          'In a migration context, private data and credentials would be transmitted unencrypted. ' +
          'Use grpcs:// in the connection profile, or pass --allow-insecure to proceed.',
      );
    }

    // The profile's override wins: a destination reached by IP or through a
    // load balancer presents a certificate for its own hostname, not the
    // address dialled. Without one, the dialled host is what TLS checks.
    const tlsHostname = peerConfig.grpcOptions?.['ssl-target-name-override']
      ?? hostPort.split(':')[0];
    this.grpcClient = new grpc.Client(hostPort, credentials, {
      'grpc.ssl_target_name_override': tlsHostname,
      'grpc.max_receive_message_length': GRPC_MAX_RECEIVE_BYTES,
    });

    // Build identity and signer
    const identity = {
      mspId: config.mspId,
      credentials: Buffer.from(certificate),
    };

    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const signer = signers.newPrivateKeySigner(privateKey);

    this.mspId = config.mspId;
    const requestMs = config.timeouts?.requestMs
      ?? DEFAULT_GRPC_TIMEOUTS.requestMs;
    const commitMs = config.timeouts?.commitMs
      ?? DEFAULT_GRPC_TIMEOUTS.commitMs;
    // connectMs is not honoured here: the fabric-gateway SDK's connect() does not
    // accept a waitForReady timeout. Use LegacyFabricGateway if you need connectMs.
    this.gateway = connect({
      client: this.grpcClient,
      identity,
      signer,
      evaluateOptions: () => ({ deadline: Date.now() + requestMs }),
      endorseOptions: () => ({ deadline: Date.now() + requestMs }),
      submitOptions: () => ({ deadline: Date.now() + requestMs }),
      commitStatusOptions: () => ({ deadline: Date.now() + commitMs }),
    });

    logger.info(
      { peer: hostPort, mspId: this.mspId, tls: isTls },
      'Connected to Fabric gateway',
    );
  }

  getNetwork(channelId: string): NetworkAdapter {
    if (!this.gateway) {
      throw new ConnectionError('Gateway not connected');
    }
    return this.gateway.getNetwork(channelId);
  }

  /**
   * Returns the native @hyperledger/fabric-gateway Network object.
   * Used by the replay path (ChaincodeAdapter) which needs contract.newProposal()
   * — a gateway-SDK-only API not exposed through NetworkAdapter.
   */
  getGatewayNetwork(channelId: string): Network {
    if (!this.gateway) {
      throw new ConnectionError('Gateway not connected');
    }
    return this.gateway.getNetwork(channelId);
  }

  getMspId(): string {
    return this.mspId;
  }

  disconnect(): void {
    if (this.gateway) {
      this.gateway.close();
      this.gateway = null;
    }
    if (this.grpcClient) {
      this.grpcClient.close();
      this.grpcClient = null;
    }
    logger.info('Disconnected from Fabric gateway');
  }
}
