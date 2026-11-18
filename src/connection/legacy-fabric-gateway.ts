// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import { useNodeSigner } from './node-signer';
import * as fs from 'fs';
import { NetworkAdapter, ContractAdapter } from './network-adapter';
import { ConnectionProfile, GrpcTimeouts, DEFAULT_GRPC_TIMEOUTS } from '../types';
import { ConnectionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('legacy-fabric-gateway');

/**
 * The TLS CA a profile names for one endpoint. fabric-common given an empty
 * PEM would fall back to default roots, so a missing CA is refused instead.
 */
function profileTlsPem(name: string, endpoint: { tlsCACerts?: { path?: string; pem?: string } }): string {
  const caPath = endpoint.tlsCACerts?.path;
  if (caPath && fs.existsSync(caPath)) return fs.readFileSync(caPath, 'utf-8');
  if (caPath && !endpoint.tlsCACerts?.pem) throw new ConnectionError(`${name}: tlsCACerts.path ${caPath} does not exist`);
  if (endpoint.tlsCACerts?.pem) return endpoint.tlsCACerts.pem;
  throw new ConnectionError(
    `${name} has no tlsCACerts (path or pem) in the connection profile. ` +
      'Name the CA that issued its TLS certificate; default roots are not trusted.',
  );
}

export interface LegacyGatewayConfig {
  /** Path to a standard Fabric connection profile JSON. */
  connectionProfilePath: string;
  /** MSP ID for the submitting identity. */
  mspId: string;
  /** Path to the PEM-encoded X.509 certificate. */
  certPath: string;
  /** Path to the PEM-encoded private key. */
  keyPath: string;
  /** Enable Fabric discovery service. Default: false (use static endpoints from connection profile). */
  discovery?: boolean;
  /** gRPC timeout overrides. */
  timeouts?: GrpcTimeouts;
}

/**
 * Wraps the `fabric-common` low-level SDK to provide the same NetworkAdapter
 * interface used by extraction and discovery code.
 *
 * This replaces the previous fabric-network-based implementation to solve
 * AMB's "access denied" error. The fabric-network SDK forces mutual TLS
 * with a self-signed client cert, but AMB's VPC endpoint terminates TLS
 * so the peer sees a different cert than the tls_cert_hash in proposals.
 *
 * By using fabric-common directly, we control gRPC credentials and use
 * one-way TLS (server verification only, no client cert) — matching
 * how the `peer` CLI works.
 */
export class LegacyFabricGateway {
  private client: any = null;
  private identityContext: any = null;
  private endorser: any = null;
  private committer: any = null;
  private mspId: string = '';
  private requestMs: number = DEFAULT_GRPC_TIMEOUTS.requestMs;
  private channels: Map<string, any> = new Map();

  async connect(config: LegacyGatewayConfig): Promise<void> {
    if (!fs.existsSync(config.connectionProfilePath)) {
      throw new ConnectionError(
        `Connection profile not found: ${config.connectionProfilePath}`,
      );
    }
    if (!fs.existsSync(config.certPath)) {
      throw new ConnectionError(`Certificate not found: ${config.certPath}`);
    }
    if (!fs.existsSync(config.keyPath)) {
      throw new ConnectionError(`Private key not found: ${config.keyPath}`);
    }

    // Dynamic require — fabric-common is a dependency of fabric-ca-client, and
    // `await import()` cannot report a missing module to the catch below
    // without making every caller of this sync path async.
    let FabricCommon: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      FabricCommon = require('fabric-common');
    } catch {
      throw new ConnectionError(
        'fabric-common package is required for legacy Fabric (1.4–2.x) support. ' +
          'Install it with: npm install fabric-common',
      );
    }

    const profileJson = fs.readFileSync(config.connectionProfilePath, 'utf-8');
    const profile: ConnectionProfile = JSON.parse(profileJson);

    const certPEM = fs.readFileSync(config.certPath, 'utf-8');
    const keyPEM = fs.readFileSync(config.keyPath, 'utf-8');

    this.mspId = config.mspId;
    const requestMs = config.timeouts?.requestMs
      ?? DEFAULT_GRPC_TIMEOUTS.requestMs;
    const connectMs = config.timeouts?.connectMs
      ?? DEFAULT_GRPC_TIMEOUTS.connectMs;
    this.requestMs = requestMs;

    // 1. Create Client — do NOT call setTlsClientCertAndKey (one-way TLS)
    this.client = new FabricCommon.Client('amb-client');

    // 2. Create User and IdentityContext for signing proposals
    const user = FabricCommon.User.createUser('admin', '', config.mspId, certPEM, keyPEM);
    // Sign with Node's ECDSA, not fabric-common's `elliptic` (unpatched CVE-2025-14505).
    if (!useNodeSigner(user, keyPEM)) {
      logger.warn('The identity key is not ECDSA P-256; signing with fabric-common\'s own signer');
    }
    this.identityContext = this.client.newIdentityContext(user);

    // 3. Extract peer info from connection profile
    const peerNames = Object.keys(profile.peers);
    if (peerNames.length === 0) {
      throw new ConnectionError('Connection profile has no peers defined');
    }
    const peerConfig = profile.peers[peerNames[0]];
    const peerTlsPem = profileTlsPem(peerNames[0], peerConfig);
    const peerHostname = peerConfig.grpcOptions?.['ssl-target-name-override'];

    // 4. Create Endorser (peer) with one-way TLS — no clientKey/clientCert
    this.endorser = this.client.newEndorser(peerNames[0]);
    const peerEndpointOptions: any = {
      url: peerConfig.url,
      pem: peerTlsPem,
      requestTimeout: requestMs,
      'grpc-wait-for-ready-timeout': connectMs,
    };
    if (peerHostname) {
      peerEndpointOptions['ssl-target-name-override'] = peerHostname;
    }
    await this.endorser.connect(this.client.newEndpoint(peerEndpointOptions));
    logger.info({ peer: peerNames[0], url: peerConfig.url }, 'Endorser connected (one-way TLS)');

    // 5. Create Committer (orderer) with one-way TLS
    const ordererNames = Object.keys(profile.orderers);
    if (ordererNames.length > 0) {
      const ordererConfig = profile.orderers[ordererNames[0]];
      const ordererTlsPem = profileTlsPem(ordererNames[0], ordererConfig);
      const ordererHostname = ordererConfig.grpcOptions?.['ssl-target-name-override'];

      this.committer = this.client.newCommitter(ordererNames[0]);
      const ordererEndpointOptions: any = {
        url: ordererConfig.url,
        pem: ordererTlsPem,
        requestTimeout: requestMs,
        'grpc-wait-for-ready-timeout': connectMs,
      };
      if (ordererHostname) {
        ordererEndpointOptions['ssl-target-name-override'] = ordererHostname;
      }
      await this.committer.connect(this.client.newEndpoint(ordererEndpointOptions));
      logger.info({ orderer: ordererNames[0], url: ordererConfig.url }, 'Committer connected (one-way TLS)');
    }

    logger.info(
      { peer: peerNames[0], mspId: this.mspId, sdk: 'fabric-common' },
      'Connected via fabric-common gateway (one-way TLS)',
    );
  }

  /**
   * Get or create a fabric-common Channel for the given channel ID.
   * Adds the endorser and committer to the channel.
   */
  private getOrCreateChannel(channelId: string): any {
    if (this.channels.has(channelId)) {
      return this.channels.get(channelId);
    }

    const channel = this.client.newChannel(channelId);
    channel.addEndorser(this.endorser);
    if (this.committer) {
      channel.addCommitter(this.committer);
    }
    this.channels.set(channelId, channel);
    return channel;
  }

  /**
   * Send a raw query to a system chaincode using fabric-common's low-level
   * Channel.newQuery() API.
   */
  async evaluateSystemChaincode(
    channelId: string,
    chaincodeName: string,
    functionName: string,
    ...args: string[]
  ): Promise<Uint8Array> {
    if (!this.client) {
      throw new ConnectionError('Legacy gateway not connected');
    }

    // fabric-common's Channel rejects empty channel IDs, but system chaincodes
    // like cscc.GetChannels work with an empty channel_id (same as `peer channel list`).
    // For empty channel IDs, build and send the proposal manually.
    if (!channelId) {
      return this.evaluateSystemChaincodeRaw(chaincodeName, functionName, ...args);
    }

    const channel = this.getOrCreateChannel(channelId);
    const query = channel.newQuery(chaincodeName);
    query.build(this.identityContext, { fcn: functionName, args });
    query.sign(this.identityContext);

    logger.info(
      { channelId, chaincode: chaincodeName, function: functionName },
      'Sending system chaincode query via fabric-common',
    );

    const queryResults = await query.send({ targets: [this.endorser] });

    if (queryResults.errors && queryResults.errors.length > 0) {
      const errMsg = queryResults.errors.map((e: Error) => e.message).join('; ');
      throw new ConnectionError(`System chaincode query failed: ${errMsg}`);
    }

    if (queryResults.responses && queryResults.responses.length > 0) {
      const response = queryResults.responses[0];
      if (response.response && response.response.status === 200) {
        return new Uint8Array(response.response.payload);
      }
      const status = response.response?.status ?? 'unknown';
      const message = response.response?.message ?? 'no message';
      throw new ConnectionError(
        `System chaincode query returned status ${status}: ${message}`,
      );
    }

    throw new ConnectionError(
      `No response received from ${chaincodeName}.${functionName} on channel ${channelId}`,
    );
  }

  /**
   * Build and send a system chaincode query manually with an empty channel ID.
   * Used for queries like cscc.GetChannels where no channel context is needed.
   */
  private async evaluateSystemChaincodeRaw(
    chaincodeName: string,
    functionName: string,
    ...args: string[]
  ): Promise<Uint8Array> {
    // Use fabric-protos to build the proposal with an empty channel_id,
    // then send via endorser.sendProposal directly.
    let fabproto6: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fabproto6 = require('fabric-protos');
    } catch {
      throw new ConnectionError(
        'fabric-protos required for system chaincode queries with empty channel ID',
      );
    }

    // The identity context's serializeIdentity() returns protobuf-encoded SerializedIdentity
    const creator = Buffer.from(this.identityContext.serializeIdentity());
    const nonce = crypto.randomBytes(24);

    const txIdHash = crypto.createHash('sha256');
    txIdHash.update(nonce);
    txIdHash.update(creator);
    const txId = txIdHash.digest('hex');

    // Build ChaincodeInput
    const chaincodeArgs = [Buffer.from(functionName, 'utf8'), ...args.map(a => Buffer.from(a, 'utf8'))];

    const chaincodeInvocationSpec = fabproto6.protos.ChaincodeInvocationSpec.create({
      chaincode_spec: fabproto6.protos.ChaincodeSpec.create({
        type: fabproto6.protos.ChaincodeSpec.Type.GOLANG,
        chaincode_id: fabproto6.protos.ChaincodeID.create({ name: chaincodeName }),
        input: fabproto6.protos.ChaincodeInput.create({ args: chaincodeArgs }),
      }),
    });

    const ccProposalPayload = fabproto6.protos.ChaincodeProposalPayload.create({
      input: fabproto6.protos.ChaincodeInvocationSpec.encode(chaincodeInvocationSpec).finish(),
    });

    const channelHeader = fabproto6.common.ChannelHeader.create({
      type: fabproto6.common.HeaderType.ENDORSER_TRANSACTION,
      channel_id: '', // empty channel ID
      tx_id: txId,
      timestamp: fabproto6.google.protobuf.Timestamp.create({
        seconds: Math.floor(Date.now() / 1000),
        nanos: 0,
      }),
      extension: fabproto6.protos.ChaincodeHeaderExtension.encode(
        fabproto6.protos.ChaincodeHeaderExtension.create({
          chaincode_id: fabproto6.protos.ChaincodeID.create({ name: chaincodeName }),
        })
      ).finish(),
    });

    const signatureHeader = fabproto6.common.SignatureHeader.create({
      creator,
      nonce,
    });

    const header = fabproto6.common.Header.create({
      channel_header: fabproto6.common.ChannelHeader.encode(channelHeader).finish(),
      signature_header: fabproto6.common.SignatureHeader.encode(signatureHeader).finish(),
    });

    const proposal = fabproto6.protos.Proposal.create({
      header: fabproto6.common.Header.encode(header).finish(),
      payload: fabproto6.protos.ChaincodeProposalPayload.encode(ccProposalPayload).finish(),
    });
    const proposalBytes = Buffer.from(fabproto6.protos.Proposal.encode(proposal).finish());

    // Sign with the identity context
    const signature = Buffer.from(this.identityContext.sign(proposalBytes));

    const signedProposal = fabproto6.protos.SignedProposal.create({
      proposal_bytes: proposalBytes,
      signature,
    });

    logger.info(
      { chaincode: chaincodeName, function: functionName },
      'Sending system chaincode query with empty channel ID',
    );

    const response = await this.endorser.sendProposal(signedProposal, this.requestMs);

    if (response.response && response.response.status === 200) {
      return new Uint8Array(response.response.payload);
    }

    const status = response.response?.status ?? 'unknown';
    const message = response.response?.message ?? 'no message';
    throw new ConnectionError(
      `System chaincode query returned status ${status}: ${message}`,
    );
  }

  /**
   * Deliver blocks with private data using the peer's DeliverWithPrivateData
   * gRPC endpoint via fabric-common's EventService.
   */
  async deliverPrivateData(
    channelId: string,
    startBlock: number,
    endBlock: number,
    onBlock: (blockNumber: number, block: any, privateDataMap: Record<string, any>) => Promise<void>,
  ): Promise<void> {
    if (!this.client) {
      throw new ConnectionError('Legacy gateway not connected');
    }

    const channel = this.getOrCreateChannel(channelId);
    const eventServiceName = `pvtdata-delivery-${Date.now()}`;

    logger.info(
      { channelId, startBlock, endBlock, eventService: eventServiceName },
      'Starting DeliverWithPrivateData block delivery',
    );

    return new Promise<void>((resolve, reject) => {
      const eventService = channel.newEventService(eventServiceName);
      let completed = false;

      // Blocks are handed to onBlock strictly one at a time, in delivery order.
      // fabric-common fires the listener for each block as it arrives and does
      // not wait for the previous call, so starting each handler as its block
      // arrived let consecutive handlers interleave at every await inside them:
      // private history was written out of block order, and the end-of-stream
      // signal resolved this promise while the last block's handler was still
      // running — so the caller emitted current private state before that block
      // had finished accumulating, and dropped its remaining values silently.
      // Seen live on AMB 2.2 (C13). Every handler and the completion now go
      // through one chain, so completion waits for the last handler to finish.
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (step: () => Promise<void> | void): void => {
        chain = chain.then(() => {
          if (completed) return undefined;
          return step();
        }).catch((err) => {
          finish(err as Error);
        });
      };

      const finish = (err?: Error) => {
        if (completed) return;
        completed = true;
        try {
          eventService.close();
        } catch (err) {
          logger.debug({ err }, 'Error closing event service');
        }
        if (err) reject(err);
        else resolve();
      };

      // fabric-common uses registerBlockListener(callback, options).
      // The callback receives (error, event) — single callback for both.
      // When the endBlock is reached, EventService._close fires an error
      // like "Shutdown due to end block number has been seen" — treat as success,
      // once every block already received has been handled.
      eventService.registerBlockListener(
        (error: any, event: any) => {
          if (completed) return;

          if (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('end block') || msg.includes('Shutdown')) {
              enqueue(() => finish()); // normal completion, after the queue drains
            } else {
              // A transport failure is reported at once: the blocks still queued
              // cannot make the delivery complete.
              finish(error instanceof Error ? error : new Error(msg));
            }
            return;
          }

          if (event?.endBlockReceived) {
            enqueue(() => finish());
            return;
          }

          const blockNumber = Number(
            event?.blockNumber ?? event?.block?.header?.number ?? 0,
          );
          const privateDataMap = event?.privateData ?? {};
          const block = event?.block;

          enqueue(async () => {
            await onBlock(blockNumber, block, privateDataMap);
            if (blockNumber >= endBlock) {
              finish();
            }
          });
        },
        {},
      );

      // startBlock/endBlock go in build() — they control the SeekInfo in the
      // deliver request envelope, not listener-side filtering.
      eventService.build(this.identityContext, {
        startBlock: startBlock.toString(),
        endBlock: endBlock.toString(),
        blockType: 'private',
      });
      eventService.sign(this.identityContext);

      // Create an Eventer for delivery — use the peer endpoint.
      // Use a 30s timeout; AMB peers may not expose DeliverWithPrivateData.
      const eventer = this.client.newEventer(eventServiceName);
      const endorserEndpoint = this.endorser.endpoint;
      eventer.connect(this.client.newEndpoint({
        url: endorserEndpoint.url,
        pem: endorserEndpoint.options.pem,
        'ssl-target-name-override': endorserEndpoint.options['ssl-target-name-override'],
        requestTimeout: this.requestMs,
      })).then(() => {
        logger.info(
          { channelId, targets: 1, startBlock, endBlock },
          'Sending DeliverWithPrivateData request',
        );
        return eventService.send({ targets: [eventer], requestTimeout: this.requestMs });
      }).catch((err: Error) => {
        finish(err);
      });
    });
  }

  getNetwork(channelId: string): NetworkAdapter {
    if (!this.client) {
      throw new ConnectionError('Legacy gateway not connected');
    }
    return new FabricCommonNetworkAdapter(this, channelId);
  }

  getMspId(): string {
    return this.mspId;
  }

  disconnect(): void {
    if (this.endorser) {
      try { this.endorser.disconnect(); } catch (err) {
        logger.debug({ err }, 'Error disconnecting endorser');
      }
      this.endorser = null;
    }
    if (this.committer) {
      try { this.committer.disconnect(); } catch (err) {
        logger.debug({ err }, 'Error disconnecting committer');
      }
      this.committer = null;
    }
    this.channels.clear();
    this.client = null;
    this.identityContext = null;
    logger.info('Disconnected from fabric-common gateway');
  }

  /** @internal — used by FabricCommonContractAdapter */
  _getChannel(channelId: string): any {
    return this.getOrCreateChannel(channelId);
  }

  /** @internal */
  _getIdentityContext(): any {
    return this.identityContext;
  }

  /** @internal */
  _getEndorser(): any {
    return this.endorser;
  }

  /** @internal */
  _getCommitter(): any {
    return this.committer;
  }
}

/**
 * Adapts fabric-common Channel to our NetworkAdapter interface.
 */
class FabricCommonNetworkAdapter implements NetworkAdapter {
  constructor(
    private readonly gateway: LegacyFabricGateway,
    private readonly channelId: string,
  ) {}

  getContract(chaincodeName: string): ContractAdapter {
    return new FabricCommonContractAdapter(this.gateway, this.channelId, chaincodeName);
  }
}

/**
 * Adapts fabric-common Query/Endorsement to our ContractAdapter interface.
 */
class FabricCommonContractAdapter implements ContractAdapter {
  constructor(
    private readonly gateway: LegacyFabricGateway,
    private readonly channelId: string,
    private readonly chaincodeName: string,
  ) {}

  async evaluateTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array> {
    const channel = this.gateway._getChannel(this.channelId);
    const identityContext = this.gateway._getIdentityContext();
    const endorser = this.gateway._getEndorser();

    // fabric-common build() converts string args via Buffer.from(str, 'utf-8').
    // For binary protobuf args (Uint8Array), convert to a Buffer directly so the
    // raw bytes survive without UTF-8 re-encoding corruption.
    const buildArgs = args.map((a) =>
      typeof a === 'string' ? a : Buffer.from(a),
    );

    const query = channel.newQuery(this.chaincodeName);
    query.build(identityContext, { fcn: name, args: buildArgs });
    query.sign(identityContext);

    const queryResults = await query.send({ targets: [endorser] });

    if (queryResults.errors && queryResults.errors.length > 0) {
      const errMsg = queryResults.errors.map((e: Error) => e.message).join('; ');
      throw new ConnectionError(`Query ${this.chaincodeName}.${name} failed: ${errMsg}`);
    }

    if (queryResults.responses && queryResults.responses.length > 0) {
      const response = queryResults.responses[0];
      if (response.response && response.response.status === 200) {
        return new Uint8Array(response.response.payload);
      }
      const status = response.response?.status ?? 'unknown';
      const message = response.response?.message ?? 'no message';
      throw new ConnectionError(
        `Query ${this.chaincodeName}.${name} returned status ${status}: ${message}`,
      );
    }

    throw new ConnectionError(
      `No response from ${this.chaincodeName}.${name} on channel ${this.channelId}`,
    );
  }

  async submitTransaction(name: string, ...args: (string | Uint8Array)[]): Promise<Uint8Array> {
    const channel = this.gateway._getChannel(this.channelId);
    const identityContext = this.gateway._getIdentityContext();
    const endorser = this.gateway._getEndorser();
    const committer = this.gateway._getCommitter();

    if (!committer) {
      throw new ConnectionError('No orderer (committer) available for submit');
    }

    const stringArgs = args.map((a) =>
      typeof a === 'string' ? a : Buffer.from(a).toString('utf-8'),
    );

    // 1. Endorse
    const endorsement = channel.newEndorsement(this.chaincodeName);
    endorsement.build(identityContext, { fcn: name, args: stringArgs });
    endorsement.sign(identityContext);

    const endorseResult = await endorsement.send({ targets: [endorser] });

    if (endorseResult.errors && endorseResult.errors.length > 0) {
      const errMsg = endorseResult.errors.map((e: Error) => e.message).join('; ');
      throw new ConnectionError(`Endorsement ${this.chaincodeName}.${name} failed: ${errMsg}`);
    }

    if (!endorseResult.responses || endorseResult.responses.length === 0) {
      throw new ConnectionError(
        `No endorsement response from ${this.chaincodeName}.${name}`,
      );
    }

    const endorseResponse = endorseResult.responses[0];
    if (!endorseResponse.response || endorseResponse.response.status !== 200) {
      const status = endorseResponse.response?.status ?? 'unknown';
      const message = endorseResponse.response?.message ?? 'no message';
      throw new ConnectionError(
        `Endorsement ${this.chaincodeName}.${name} returned status ${status}: ${message}`,
      );
    }

    // 2. Commit to orderer
    const commit = endorsement.newCommit();
    commit.build(identityContext);
    commit.sign(identityContext);

    const commitResult = await commit.send({ targets: [committer] });

    if (commitResult.status !== 'SUCCESS') {
      throw new ConnectionError(
        `Commit ${this.chaincodeName}.${name} failed with status: ${commitResult.status}`,
      );
    }

    return new Uint8Array(endorseResponse.response.payload);
  }
}
