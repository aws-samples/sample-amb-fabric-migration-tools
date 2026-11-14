import * as crypto from 'crypto';
import * as fs from 'fs';
import * as grpc from '@grpc/grpc-js';
import { connect, Gateway, signers } from '@hyperledger/fabric-gateway';
import {
  ConnectionProfile,
  GrpcTimeouts,
  DEFAULT_GRPC_TIMEOUTS,
  GRPC_MAX_RECEIVE_BYTES,
} from '../types';
import { ConnectionError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { NetworkAdapter } from './network-adapter';
import { Wallet } from './wallet-manager';

const logger = createLogger('amb-gateway');

export class AmbGateway {
  private gateway: Gateway | null = null;
  private grpcClient: grpc.Client | null = null;
  private mspId: string = '';

  async connect(
    profile: ConnectionProfile,
    wallet: Wallet,
    timeouts?: GrpcTimeouts,
  ): Promise<void> {
    const peerNames = Object.keys(profile.peers);
    if (peerNames.length === 0) {
      throw new ConnectionError('No peer found in connection profile');
    }

    const peerConfig = profile.peers[peerNames[0]];
    const peerUrl = peerConfig.url.replace('grpcs://', '');
    const tlsCertPath = peerConfig.tlsCACerts.path;
    const tlsCertPem = peerConfig.tlsCACerts.pem;

    let tlsCert: Buffer;
    if (tlsCertPath) {
      tlsCert = fs.readFileSync(tlsCertPath);
    } else if (tlsCertPem) {
      tlsCert = Buffer.from(tlsCertPem);
    } else {
      throw new ConnectionError(
        'No TLS CA cert: provide tlsCACerts.path or tlsCACerts.pem',
      );
    }
    const tlsCredentials = grpc.credentials.createSsl(tlsCert);

    this.grpcClient = new grpc.Client(peerUrl, tlsCredentials, {
      'grpc.ssl_target_name_override': peerUrl.split(':')[0],
      'grpc.max_receive_message_length': GRPC_MAX_RECEIVE_BYTES,
    });

    const identity = {
      mspId: wallet.identity.mspId,
      credentials: Buffer.from(wallet.identity.credentials.certificate),
    };

    const privateKey = crypto.createPrivateKey(wallet.identity.credentials.privateKey);
    const signer = signers.newPrivateKeySigner(privateKey);

    this.mspId = wallet.identity.mspId;
    const requestMs = timeouts?.requestMs ?? DEFAULT_GRPC_TIMEOUTS.requestMs;
    const commitMs = timeouts?.commitMs ?? DEFAULT_GRPC_TIMEOUTS.commitMs;
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

    logger.info({ peer: peerUrl, mspId: this.mspId }, 'Connected to AMB gateway');
  }

  getNetwork(channelId: string): NetworkAdapter {
    if (!this.gateway) {
      throw new ConnectionError('Gateway not connected');
    }
    return this.gateway.getNetwork(channelId);
  }

  getMspId(): string {
    return this.mspId;
  }

  getGrpcClient(): grpc.Client {
    if (!this.grpcClient) {
      throw new ConnectionError('Gateway not connected');
    }
    return this.grpcClient;
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
    logger.info('Disconnected from AMB gateway');
  }
}
