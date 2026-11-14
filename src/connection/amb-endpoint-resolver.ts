import {
  ManagedBlockchainClient,
  GetNetworkCommand,
  GetMemberCommand,
  GetNodeCommand,
  ListNetworksCommand,
  ListMembersCommand,
  ListNodesCommand,
} from '@aws-sdk/client-managedblockchain';
import { ResolvedEndpoints } from '../types';
import { ConnectionError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

const logger = createLogger('amb-endpoint-resolver');

export class AmbEndpointResolver {
  private client: ManagedBlockchainClient;

  constructor(private readonly region: string) {
    this.client = new ManagedBlockchainClient({ region });
  }

  async resolve(networkId: string, memberId: string, nodeId: string): Promise<ResolvedEndpoints> {
    logger.info({ networkId, memberId, nodeId }, 'Resolving AMB endpoints');

    const [network, member, node] = await Promise.all([
      this.getNetwork(networkId),
      this.getMember(networkId, memberId),
      this.getNode(networkId, memberId, nodeId),
    ]);

    const ordererEndpoint = network.FrameworkAttributes?.Fabric?.OrderingServiceEndpoint;
    if (!ordererEndpoint) {
      throw new ConnectionError('Could not resolve orderer endpoint from network');
    }

    const caEndpoint = member.FrameworkAttributes?.Fabric?.CaEndpoint;
    if (!caEndpoint) {
      throw new ConnectionError('Could not resolve CA endpoint from member');
    }

    const peerEndpoint = node.FrameworkAttributes?.Fabric?.PeerEndpoint;
    const peerEventEndpoint = node.FrameworkAttributes?.Fabric?.PeerEventEndpoint;
    if (!peerEndpoint || !peerEventEndpoint) {
      throw new ConnectionError('Could not resolve peer endpoints from node');
    }

    const stateDb = (node.StateDB as 'CouchDB' | 'LevelDB') ?? 'LevelDB';

    // The peer binary version, and so the only authority on which RPCs the peer
    // serves. Missing is an error rather than a default: guessing it either
    // abandons recoverable private data or attempts an RPC that does not exist.
    const frameworkVersion = network.FrameworkVersion;
    if (!frameworkVersion) {
      throw new ConnectionError(
        `Network ${networkId} reported no FrameworkVersion. It decides whether ` +
          'private-data values are obtainable at all, so extraction cannot ' +
          'proceed without it.',
      );
    }

    const resolved: ResolvedEndpoints = {
      peerEndpoint,
      peerEventEndpoint,
      caEndpoint,
      ordererEndpoint,
      stateDb,
      frameworkVersion,
    };

    logger.info(resolved, 'Endpoints resolved');
    return resolved;
  }

  async listNetworks(): Promise<
    Array<{
      id: string;
      name: string;
      status: string;
      frameworkVersion: string;
    }>
  > {
    return withRetry(async () => {
      const resp = await this.client.send(
        new ListNetworksCommand({
          Framework: 'HYPERLEDGER_FABRIC',
          Status: 'AVAILABLE',
        }),
      );
      return (resp.Networks ?? []).map((n) => ({
        id: n.Id ?? '',
        name: n.Name ?? '',
        status: n.Status ?? '',
        frameworkVersion: n.FrameworkVersion ?? '',
      }));
    }, 'ListNetworks');
  }

  async listMembers(
    networkId: string,
  ): Promise<
    Array<{ id: string; name: string; status: string }>
  > {
    return withRetry(async () => {
      const resp = await this.client.send(
        new ListMembersCommand({
          NetworkId: networkId,
          IsOwned: true,
          Status: 'AVAILABLE',
        }),
      );
      return (resp.Members ?? []).map((m) => ({
        id: m.Id ?? '',
        name: m.Name ?? '',
        status: m.Status ?? '',
      }));
    }, 'ListMembers');
  }

  async listNodes(
    networkId: string,
    memberId: string,
  ): Promise<
    Array<{
      id: string;
      status: string;
      availabilityZone: string;
      instanceType: string;
    }>
  > {
    return withRetry(async () => {
      const resp = await this.client.send(
        new ListNodesCommand({
          NetworkId: networkId,
          MemberId: memberId,
          Status: 'AVAILABLE',
        }),
      );
      return (resp.Nodes ?? []).map((n) => ({
        id: n.Id ?? '',
        status: n.Status ?? '',
        availabilityZone: n.AvailabilityZone ?? '',
        instanceType: n.InstanceType ?? '',
      }));
    }, 'ListNodes');
  }

  private async getNetwork(networkId: string) {
    return withRetry(
      async () => {
        const resp = await this.client.send(new GetNetworkCommand({ NetworkId: networkId }));
        if (!resp.Network) throw new ConnectionError(`Network ${networkId} not found`);
        return resp.Network;
      },
      'GetNetwork',
    );
  }

  private async getMember(networkId: string, memberId: string) {
    return withRetry(
      async () => {
        const resp = await this.client.send(
          new GetMemberCommand({ NetworkId: networkId, MemberId: memberId }),
        );
        if (!resp.Member) throw new ConnectionError(`Member ${memberId} not found`);
        return resp.Member;
      },
      'GetMember',
    );
  }

  private async getNode(networkId: string, memberId: string, nodeId: string) {
    return withRetry(
      async () => {
        const resp = await this.client.send(
          new GetNodeCommand({ NetworkId: networkId, MemberId: memberId, NodeId: nodeId }),
        );
        if (!resp.Node) throw new ConnectionError(`Node ${nodeId} not found`);
        return resp.Node;
      },
      'GetNode',
    );
  }
}
