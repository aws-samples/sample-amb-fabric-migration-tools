// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ChaincodeInfo, CollectionConfig } from '../types';
import { NetworkAdapter, ContractAdapter } from '../connection/network-adapter';
import { DiscoveryError } from '../utils/errors';
import { createLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';

// Lazy-load fabric-protos (same pattern as block-decoder.ts). The getter is
// sync because its callers decode buffers synchronously, so `await import()`
// is not available here.
let fabproto6: any = null;
function getFabricProtos(): any {
  if (!fabproto6) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fabproto6 = require('fabric-protos');
  }
  return fabproto6;
}

/**
 * Callback for processing a delivered block with private data.
 * @param blockNumber Block number
 * @param block Decoded block object (same structure as BlockParser input)
 * @param privateDataMap Map of tx sequence index → decoded TxPvtReadWriteSet.
 *   Only includes private data for collections the connected org is authorized to see.
 *   Structure per entry: { ns_pvt_rwset: [{ namespace, collection_pvt_rwset: [{ collection_name, rwset: { writes: [{ key, is_delete, value }] } }] }] }
 */
export type PrivateDataBlockCallback = (
  blockNumber: number,
  block: any,
  privateDataMap: Record<string, any>,
) => Promise<void>;

export interface DiscoveryGateway {
  getNetwork(channelId: string): NetworkAdapter;
  getMspId(): string;
  /**
   * Send a raw query to a system chaincode, bypassing the high-level SDK
   * transaction wrapper that may not work for system chaincodes like cscc.
   *
   * Uses the underlying fabric-common Channel.newQuery() API (legacy SDK) to
   * build and sign a proposal directly. This is more reliable than
   * contract.evaluateTransaction() for system chaincodes because the Gateway
   * SDK wraps proposals in a way that cscc may reject.
   *
   * Optional — if not implemented, callers fall back to evaluateTransaction.
   */
  evaluateSystemChaincode?(
    channelId: string,
    chaincodeName: string,
    functionName: string,
    ...args: string[]
  ): Promise<Uint8Array>;

  /**
   * Deliver blocks with private data using the peer's DeliverWithPrivateData
   * gRPC endpoint. The peer includes private data values for collections the
   * connected org is authorized to see. For unauthorized collections, only
   * hashes are available from the block's hashed rwsets.
   *
   * This is the correct way to extract private data — no helper chaincode
   * needed. The peer already stores private data for the org's collections
   * via gossip during normal block commitment.
   *
   * Caveat: Private data with blockToLive > 0 is purged after that many blocks.
   * Purged data will not be included in the delivery response.
   *
   * Optional — if not implemented, only private data hashes from the
   * block walk are available.
   */
  deliverPrivateData?(
    channelId: string,
    startBlock: number,
    endBlock: number,
    onBlock: PrivateDataBlockCallback,
  ): Promise<void>;
}

const logger = createLogger('chaincode-discoverer');

const MSP_ROLE_NAMES: Record<number | string, string> = {
  0: 'member', 1: 'admin', 2: 'client', 3: 'peer', 4: 'orderer',
  MEMBER: 'member', ADMIN: 'admin', CLIENT: 'client',
  PEER: 'peer', ORDERER: 'orderer',
};

/**
 * The one `lscc.GetCollectionsConfig` rejection that means "this chaincode has
 * no collections" rather than "the query failed".
 *
 * Fabric 1.x reports an absent collection config as an error rather than an
 * empty result, so it has to be recognised by message. The match is deliberately
 * narrow and the default is failure: an ACL denial, a timeout or a wrong system
 * chaincode must not read as "no private data", which is exactly how V4's silent
 * data loss happened.
 */
const LSCC_NO_COLLECTIONS_PATTERN = /collections config not defined for chaincode/i;

/**
 * Build the `_implicit_org_<MSPID>` collections a Fabric 2.x peer holds for a
 * channel's application organizations.
 *
 * Implicit collections appear in no chaincode definition — the peer derives them
 * from channel membership — so discovery has to construct them or private
 * extraction never runs for the standard 2.x per-org pattern.
 *
 * Their shape follows Fabric's own `GenerateImplicitCollectionForOrg`: a policy
 * naming the single owning org, and no purge horizon. `memberOnlyRead` and
 * `memberOnlyWrite` are false because Fabric's generated config leaves them
 * unset — access is enforced by the policy, not by those flags.
 *
 * @param mspIds MSP IDs of the channel's application organizations.
 * @param declared Collections already read from the chaincode definition; a
 *   declared collection of the same name wins, since it was actually observed.
 */
export function synthesizeImplicitCollections(
  mspIds: string[],
  declared: CollectionConfig[],
): CollectionConfig[] {
  const declaredNames = new Set(declared.map((c) => c.name));
  return mspIds
    .map((mspId) => `_implicit_org_${mspId}`)
    .filter((name) => !declaredNames.has(name))
    .map((name) => ({
      name,
      policy: `OR('${name.slice('_implicit_org_'.length)}.member')`,
      requiredPeerCount: 0,
      maxPeerCount: 0,
      blockToLive: 0,
      memberOnlyRead: false,
      memberOnlyWrite: false,
      implicit: true,
    }));
}

/**
 * Decode a protobuf-encoded CollectionConfigPackage into CollectionConfig[].
 * Uses fabric-protos for full decode including policy parsing.
 */
export function decodeCollectionConfigPackage(
  bytes: Uint8Array,
): CollectionConfig[] {
  const fp = getFabricProtos();
  const pkg = fp.protos.CollectionConfigPackage.decode(bytes);

  return (pkg.config || [])
    .map((cc: any) => {
      const sc = cc.static_collection_config;
      if (!sc) return null;
      return {
        name: sc.name || '',
        policy: formatCollectionPolicy(sc.member_orgs_policy),
        requiredPeerCount: sc.required_peer_count || 0,
        maxPeerCount: sc.maximum_peer_count || 0,
        blockToLive: Number(sc.block_to_live || 0),
        memberOnlyRead: sc.member_only_read || false,
        memberOnlyWrite: sc.member_only_write || false,
      };
    })
    .filter(
      (c: CollectionConfig | null): c is CollectionConfig => c !== null,
    );
}

/**
 * Format a CollectionPolicyConfig into a human-readable Fabric policy string.
 * Handles both protobuf-decoded objects (Uint8Array principals) and
 * JSON-decoded objects (already-deserialized principals).
 *
 * @returns Policy string like "OR('Org1MSP.member', 'Org2MSP.peer')" or ''
 */
export function formatCollectionPolicy(
  policyConfig: any,
): string {
  if (!policyConfig) return '';

  const envelope =
    policyConfig.signature_policy ?? policyConfig.signaturePolicy;
  if (!envelope) return '';

  const identities = envelope.identities || [];
  const rule = envelope.rule;
  if (!rule) return '';

  return formatPolicyRule(rule, identities);
}

function formatPolicyRule(
  rule: any,
  identities: any[],
): string {
  if (rule.signed_by !== undefined && rule.signed_by !== null) {
    return resolveIdentity(identities[rule.signed_by]);
  }

  const nOutOf = rule.n_out_of ?? rule.nOutOf;
  if (!nOutOf) return '';

  const n = nOutOf.n || 0;
  const rules = nOutOf.rules || [];
  if (rules.length === 0) return '';

  const parts = rules.map(
    (r: any) => formatPolicyRule(r, identities),
  );

  if (n === 1) return `OR(${parts.join(', ')})`;
  if (n === rules.length) return `AND(${parts.join(', ')})`;
  return `OutOf(${n}, ${parts.join(', ')})`;
}

/**
 * Resolve an MSPPrincipal to a quoted identity string.
 * Handles three representations of the principal field:
 *   - Uint8Array (from fabric-protos decode)
 *   - Object with msp_identifier (from JSON decode)
 *   - Base64 string (from JSON serialization of bytes)
 */
function resolveIdentity(mspPrincipal: any): string {
  if (!mspPrincipal) return "'unknown'";

  // Only handle ROLE classification (covers nearly all collection policies)
  if (mspPrincipal.principal_classification !== 0) return "'unknown'";

  const p = mspPrincipal.principal;
  if (!p) return "'unknown'";

  // Uint8Array from protobuf decode — decode as MSPRole
  if (p instanceof Uint8Array || Buffer.isBuffer(p)) {
    const role = getFabricProtos().common.MSPRole.decode(p);
    const name = MSP_ROLE_NAMES[role.role] ?? 'member';
    return `'${role.msp_identifier}.${name}'`;
  }

  // Already-decoded object from JSON
  if (typeof p === 'object') {
    const mspId = p.msp_identifier || p.mspIdentifier || '';
    const name = MSP_ROLE_NAMES[p.role] ?? String(p.role).toLowerCase();
    return `'${mspId}.${name}'`;
  }

  // Base64 string from JSON serialization
  if (typeof p === 'string') {
    try {
      const bytes = Buffer.from(p, 'base64');
      const role = getFabricProtos().common.MSPRole.decode(bytes);
      const name = MSP_ROLE_NAMES[role.role] ?? 'member';
      return `'${role.msp_identifier}.${name}'`;
    } catch {
      return "'unknown'";
    }
  }

  return "'unknown'";
}

/** Options for one channel's chaincode discovery. */
export interface QueryCommittedOptions {
  /**
   * MSP IDs to synthesize `_implicit_org_<MSPID>` collections for, on top of the
   * collections each chaincode declares.
   *
   * Pass the channel's application org MSP IDs on a Fabric 2.x network, and
   * nothing on 1.x — implicit collections do not exist before the 2.0 lifecycle.
   */
  implicitOrgMspIds?: string[];
}

export class ChaincodeDiscoverer {
  constructor(private readonly gateway: DiscoveryGateway) {}

  /**
   * Query all committed chaincodes on a channel.
   *
   * Tries `_lifecycle` (Fabric 2.0+) first, then falls back to `lscc`
   * (Fabric 1.x) if the peer doesn't support the new lifecycle.
   *
   * @throws DiscoveryError when a collection-config query fails. A chaincode
   *   whose collections could not be read is not reported as having none: that
   *   silently disables private extraction for the whole channel.
   */
  async queryCommitted(
    channelId: string,
    options: QueryCommittedOptions = {},
  ): Promise<ChaincodeInfo[]> {
    logger.info({ channelId }, 'Querying committed chaincodes');

    const chaincodes = await this.queryCommittedDefinitions(channelId);
    return this.addImplicitCollections(
      channelId,
      chaincodes,
      options.implicitOrgMspIds ?? [],
    );
  }

  /**
   * Append synthesized implicit collections to every chaincode on the channel.
   *
   * Synthesized means "the peer may hold this", not "this was written to" —
   * whether anything is actually there is settled by what the delivery returns,
   * which is why an unused implicit collection is left out of the coverage report
   * rather than recorded as a loss.
   */
  private addImplicitCollections(
    channelId: string,
    chaincodes: ChaincodeInfo[],
    implicitOrgMspIds: string[],
  ): ChaincodeInfo[] {
    if (implicitOrgMspIds.length === 0) return chaincodes;

    const withImplicit = chaincodes.map((cc) => {
      const implicit = synthesizeImplicitCollections(
        implicitOrgMspIds,
        cc.collections,
      );
      return { ...cc, collections: [...cc.collections, ...implicit] };
    });

    logger.info(
      { channelId, mspIds: implicitOrgMspIds, chaincodes: chaincodes.length },
      'Synthesized implicit collections for the channel\'s application orgs',
    );
    return withImplicit;
  }

  /**
   * Read the channel's chaincode definitions, preferring `_lifecycle`.
   *
   * A `DiscoveryError` is re-thrown rather than treated as "lifecycle is
   * unavailable": it means the lifecycle query worked and something inside it
   * failed, so retrying the same question against `lscc` would replace a real
   * failure with a 1.x answer that does not apply to this peer.
   */
  private async queryCommittedDefinitions(
    channelId: string,
  ): Promise<ChaincodeInfo[]> {
    try {
      return await this.queryCommittedViaLifecycle(channelId);
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;
      const msg = (err as Error).message ?? '';
      // UNIMPLEMENTED = peer doesn't have the Gateway service or _lifecycle
      // "chaincode _lifecycle not found" = 2.x peer without lifecycle initialized
      if (
        msg.includes('UNIMPLEMENTED') ||
        msg.includes('not found') ||
        msg.includes('could not find chaincode')
      ) {
        logger.warn(
          { channelId, error: msg },
          '_lifecycle query failed — falling back to lscc (Fabric 1.x)',
        );
        return this.queryCommittedViaLscc(channelId);
      }
      throw err;
    }
  }

  /**
   * Fabric 2.x path: query via `_lifecycle` system chaincode.
   */
  private async queryCommittedViaLifecycle(channelId: string): Promise<ChaincodeInfo[]> {
    return withRetry(
      async () => {
        const network = this.gateway.getNetwork(channelId);
        const contract = network.getContract('_lifecycle');

        const resultBytes = await contract.evaluateTransaction('QueryChaincodeDefinitions', new Uint8Array(0));
        const result = this.parseQueryChaincodeDefinitionsResult(resultBytes);

        const chaincodes: ChaincodeInfo[] = [];

        for (const def of result) {
          const collections = await this.queryCollectionConfig(contract, def.name);

          chaincodes.push({
            name: def.name,
            version: def.version,
            sequence: def.sequence,
            collections,
          });

          logger.info(
            {
              channelId,
              chaincode: def.name,
              version: def.version,
              collections: collections.length,
            },
            'Found committed chaincode',
          );
        }

        return chaincodes;
      },
      `queryCommittedViaLifecycle(${channelId})`,
    );
  }

  /**
   * Fabric 1.x fallback: query via `lscc` (Lifecycle System Chaincode).
   *
   * `lscc.GetChaincodes` returns a `ChaincodeQueryResponse` protobuf with
   * a list of instantiated chaincodes. Collection config is queried per-chaincode
   * via `lscc.GetCollectionsConfig`.
   */
  private async queryCommittedViaLscc(channelId: string): Promise<ChaincodeInfo[]> {
    return withRetry(
      async () => {
        const network = this.gateway.getNetwork(channelId);
        const contract = network.getContract('lscc');

        const resultBytes = await contract.evaluateTransaction('GetChaincodes');
        const defs = this.parseLsccGetChaincodes(resultBytes);

        const chaincodes: ChaincodeInfo[] = [];

        for (const def of defs) {
          const collections = await this.queryLsccCollections(
            contract,
            def.name,
          );

          chaincodes.push({
            name: def.name,
            version: def.version,
            sequence: 0, // no lifecycle sequence in 1.x
            collections,
          });

          logger.info(
            {
              channelId,
              chaincode: def.name,
              version: def.version,
              collections: collections.length,
              via: 'lscc',
            },
            'Found instantiated chaincode',
          );
        }

        return chaincodes;
      },
      `queryCommittedViaLscc(${channelId})`,
    );
  }

  /**
   * Read one chaincode's collections through `lscc.GetCollectionsConfig`.
   *
   * Fabric 1.x signals "this chaincode declares no collections" by *rejecting*
   * the query, so that one rejection is translated to an empty list and every
   * other failure is raised. Anything else — an ACL denial, a timeout, a peer
   * that has not joined the channel — would otherwise be indistinguishable from
   * "no private data" and would silently exclude the chaincode from private
   * extraction.
   *
   * @throws DiscoveryError when the query fails for any reason other than the
   *   chaincode having no collection config.
   */
  private async queryLsccCollections(
    contract: ContractAdapter,
    chaincodeName: string,
  ): Promise<CollectionConfig[]> {
    try {
      const collBytes = await contract.evaluateTransaction(
        'GetCollectionsConfig',
        chaincodeName,
      );
      return this.parseLsccCollectionsConfig(collBytes);
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;

      const msg = (err as Error).message ?? '';
      if (LSCC_NO_COLLECTIONS_PATTERN.test(msg)) {
        logger.debug(
          { chaincode: chaincodeName },
          'Chaincode declares no collections',
        );
        return [];
      }

      throw new DiscoveryError(
        `lscc.GetCollectionsConfig failed for chaincode "${chaincodeName}": ${msg}. ` +
          'Recording it as having no collections would silently drop its private ' +
          'data, so discovery stops here. Confirm this identity can read the ' +
          'chaincode\'s collection config on the channel, then re-run discover.',
      );
    }
  }

  /**
   * Read one chaincode's collections through `_lifecycle.QueryChaincodeDefinition`.
   *
   * Unlike `lscc`, the 2.x lifecycle answers "no collections" with a definition
   * that simply omits the collection package, so any thrown error here is a real
   * failure and is raised as one.
   *
   * @throws DiscoveryError when the definition cannot be read or parsed.
   */
  private async queryCollectionConfig(
    contract: ContractAdapter,
    chaincodeName: string,
  ): Promise<CollectionConfig[]> {
    try {
      // _lifecycle.QueryChaincodeDefinition expects a protobuf-encoded
      // QueryChaincodeDefinitionArgs { string name = 1; } as the single arg.
      const nameBytes = Buffer.from(chaincodeName, 'utf-8');
      const argsBuf = Buffer.alloc(2 + nameBytes.length);
      argsBuf[0] = 0x0a; // field 1, wire type 2
      argsBuf[1] = nameBytes.length;
      nameBytes.copy(argsBuf, 2);

      const resultBytes = await contract.evaluateTransaction(
        'QueryChaincodeDefinition',
        new Uint8Array(argsBuf),
      );
      logger.debug(
        { chaincode: chaincodeName, responseLength: resultBytes.length, hex: Buffer.from(resultBytes).toString('hex').substring(0, 200) },
        'QueryChaincodeDefinition response',
      );
      const collections = this.parseCollectionConfigs(resultBytes);
      logger.debug(
        { chaincode: chaincodeName, collections: collections.length },
        'Parsed collection configs',
      );
      return collections;
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;

      throw new DiscoveryError(
        '_lifecycle.QueryChaincodeDefinition failed for chaincode ' +
          `"${chaincodeName}": ${(err as Error).message}. A chaincode with no ` +
          'collections answers this query successfully with an empty package, so ' +
          'this is a failed query rather than an absence of private data, and ' +
          'treating it as an absence would silently drop that data.',
      );
    }
  }

  /**
   * Parse the protobuf response from QueryChaincodeDefinitions.
   * The response is a lifecycle.QueryChaincodeDefinitionsResult protobuf message.
   */
  private parseQueryChaincodeDefinitionsResult(
    resultBytes: Uint8Array,
  ): Array<{ name: string; version: string; sequence: number }> {
    // The _lifecycle chaincode returns JSON when queried via the gateway SDK
    // on Fabric 2.2+. Parse the JSON response.
    try {
      const text = Buffer.from(resultBytes).toString('utf-8');
      const parsed = JSON.parse(text);

      if (parsed.chaincode_definitions) {
        return parsed.chaincode_definitions.map((def: any) => ({
          name: def.name,
          version: def.version,
          sequence: Number(def.sequence),
        }));
      }

      // If the response format is different (raw protobuf), attempt basic parsing
      return this.parseProtobufDefinitions(resultBytes);
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'JSON parse failed, falling back to protobuf');
      return this.parseProtobufDefinitions(resultBytes);
    }
  }

  /**
   * Fallback protobuf parser for QueryChaincodeDefinitionsResult.
   * Uses basic wire-format parsing since we don't want a full protobuf dependency.
   */
  private parseProtobufDefinitions(
    data: Uint8Array,
  ): Array<{ name: string; version: string; sequence: number }> {
    // Minimal protobuf field extraction
    // Field 1 (repeated): ChaincodeDefinition message
    //   Field 1: name (string)
    //   Field 2: version (string)
    //   Field 3: sequence (int64)
    const results: Array<{ name: string; version: string; sequence: number }> = [];
    const buf = Buffer.from(data);

    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 2 && fieldNumber === 1) {
        // Length-delimited: embedded message
        offset++;
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const messageBuf = buf.subarray(offset, offset + len);
        offset += len;

        const def = this.parseSingleDefinition(messageBuf);
        if (def) results.push(def);
      } else {
        // Skip unknown fields
        offset = this.skipField(buf, offset, wireType);
        if (offset < 0) break;
      }
    }

    return results;
  }

  private parseSingleDefinition(
    buf: Buffer,
  ): { name: string; version: string; sequence: number } | null {
    let name = '';
    let version = '';
    let sequence = 0;
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const strVal = buf.subarray(offset, offset + len).toString('utf-8');
        offset += len;

        if (fieldNumber === 1) name = strVal;
        else if (fieldNumber === 3) version = strVal;
      } else if (wireType === 0) {
        const { value, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        if (fieldNumber === 2) sequence = value;
      } else {
        offset = this.skipField(buf, offset - 1, wireType);
        if (offset < 0) break;
      }
    }

    return name ? { name, version, sequence } : null;
  }

  private parseCollectionConfigs(
    resultBytes: Uint8Array,
  ): CollectionConfig[] {
    // Try JSON first (some SDK versions return JSON)
    try {
      const text = Buffer.from(resultBytes).toString('utf-8');
      const parsed = JSON.parse(text);

      if (!parsed.collections?.config) return [];

      return parsed.collections.config.map((c: any) => {
        const sc = c.static_collection_config || c;
        const policyObj =
          sc.member_orgs_policy ?? sc.memberOrgsPolicy;
        return {
          name: sc.name,
          policy: formatCollectionPolicy(policyObj),
          requiredPeerCount: sc.required_peer_count ?? 0,
          maxPeerCount:
            sc.maximum_peer_count ?? sc.max_peer_count ?? 0,
          blockToLive: Number(sc.block_to_live ?? 0),
          memberOnlyRead: sc.member_only_read ?? false,
          memberOnlyWrite: sc.member_only_write ?? false,
        };
      });
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'JSON parse failed, falling back to protobuf');
    }

    // Protobuf: extract field 6 (CollectionConfigPackage) from
    // QueryChaincodeDefinitionResult, then decode with fabric-protos
    return this.extractCollectionPackageField(resultBytes);
  }

  /**
   * Extract the CollectionConfigPackage (field 6) from a
   * QueryChaincodeDefinitionResult protobuf, then decode it.
   *
   * We manually walk the outer message because fabric-protos doesn't
   * include QueryChaincodeDefinitionResult. Once we have the field 6
   * bytes, fabric-protos handles the full decode including policies.
   *
   * An empty result means field 6 was absent, which is how a chaincode without
   * collections is encoded.
   *
   * @throws DiscoveryError when the walk hits a wire type it cannot skip. The
   *   fields after that point are unreadable, so field 6 may be among them —
   *   returning an empty list would report unread collections as absent ones.
   */
  private extractCollectionPackageField(
    data: Uint8Array,
  ): CollectionConfig[] {
    const buf = Buffer.from(data);

    let offset = 0;
    while (offset < buf.length) {
      const { fieldNumber, wireType, newOffset } =
        this.readTag(buf, offset);
      offset = newOffset;

      if (wireType === 2) {
        const { value: len, bytesRead } =
          this.readVarint(buf, offset);
        offset += bytesRead;

        if (fieldNumber === 6) {
          return decodeCollectionConfigPackage(
            buf.subarray(offset, offset + len),
          );
        }
        offset += len;
      } else {
        offset = this.skipFieldFromTag(buf, offset, wireType);
        if (offset < 0) {
          throw new DiscoveryError(
            'QueryChaincodeDefinition returned a protobuf carrying unknown wire ' +
              `type ${wireType} at field ${fieldNumber}, so the rest of the ` +
              'message — which may hold the collection package — cannot be read.',
          );
        }
      }
    }

    return [];
  }

  private readTag(buf: Buffer, offset: number): { fieldNumber: number; wireType: number; newOffset: number } {
    const { value, bytesRead } = this.readVarint(buf, offset);
    return {
      fieldNumber: value >>> 3,
      wireType: value & 0x07,
      newOffset: offset + bytesRead,
    };
  }

  private skipFieldFromTag(buf: Buffer, offset: number, wireType: number): number {
    switch (wireType) {
      case 0: {
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {
          // Empty on purpose — the advance is the condition's `offset++`.
        }
        return offset;
      }
      case 1: return offset + 8;
      case 2: {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        return offset + bytesRead + len;
      }
      case 5: return offset + 4;
      default: return -1;
    }
  }

  /**
   * Parse lscc.GetChaincodes response.
   * Returns a ChaincodeQueryResponse protobuf: field 1 (repeated) = ChaincodeInfo message
   *   ChaincodeInfo: field 1 = name, field 2 = version, field 3 = path, field 4 = input, field 5 = escc, field 6 = vscc, field 7 = id
   */
  private parseLsccGetChaincodes(
    resultBytes: Uint8Array,
  ): Array<{ name: string; version: string }> {
    // Try JSON first (some SDK versions return JSON)
    try {
      const text = Buffer.from(resultBytes).toString('utf-8');
      const parsed = JSON.parse(text);

      if (Array.isArray(parsed.chaincodes)) {
        return parsed.chaincodes.map((cc: any) => ({
          name: cc.name,
          version: cc.version,
        }));
      }

      if (Array.isArray(parsed)) {
        return parsed.map((cc: any) => ({
          name: cc.name,
          version: cc.version,
        }));
      }
    } catch (err) {
      logger.debug({ error: (err as Error).message }, 'JSON parse failed, falling back to protobuf');
    }

    // Protobuf: ChaincodeQueryResponse { repeated ChaincodeInfo chaincodes = 1; }
    const results: Array<{ name: string; version: string }> = [];
    const buf = Buffer.from(resultBytes);
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;

      if (wireType === 2 && fieldNumber === 1) {
        offset++;
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const messageBuf = buf.subarray(offset, offset + len);
        offset += len;

        const cc = this.parseLsccChaincodeInfo(messageBuf);
        if (cc) results.push(cc);
      } else {
        offset = this.skipField(buf, offset, wireType);
        if (offset < 0) break;
      }
    }

    return results;
  }

  private parseLsccChaincodeInfo(
    buf: Buffer,
  ): { name: string; version: string } | null {
    let name = '';
    let version = '';
    let offset = 0;

    while (offset < buf.length) {
      const tag = buf[offset];
      const fieldNumber = tag >> 3;
      const wireType = tag & 0x07;
      offset++;

      if (wireType === 2) {
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
        const strVal = buf.subarray(offset, offset + len).toString('utf-8');
        offset += len;

        if (fieldNumber === 1) name = strVal;
        else if (fieldNumber === 2) version = strVal;
      } else if (wireType === 0) {
        const { bytesRead } = this.readVarint(buf, offset);
        offset += bytesRead;
      } else {
        offset = this.skipField(buf, offset - 1, wireType);
        if (offset < 0) break;
      }
    }

    return name ? { name, version } : null;
  }

  /**
   * Parse lscc.GetCollectionsConfig response.
   * Returns a CollectionConfigPackage protobuf: field 1 (repeated) = CollectionConfig message
   *   CollectionConfig: field 1 = StaticCollectionConfig (embedded)
   *     StaticCollectionConfig: field 1 = name, field 2 = policy, field 3 = required_peer_count,
   *       field 4 = maximum_peer_count, field 5 = block_to_live, field 6 = member_only_read, field 7 = member_only_write
   *
   * @throws DiscoveryError when the payload decodes as neither form.
   */
  private parseLsccCollectionsConfig(
    resultBytes: Uint8Array,
  ): CollectionConfig[] {
    // Try JSON first
    try {
      const text = Buffer.from(resultBytes).toString('utf-8');
      const parsed = JSON.parse(text);

      const configs = Array.isArray(parsed)
        ? parsed
        : parsed.config ?? parsed.configs ?? [];
      return configs.map((c: any) => {
        const sc =
          c.static_collection_config || c.staticCollectionConfig || c;
        const policyObj =
          sc.member_orgs_policy ?? sc.memberOrgsPolicy;
        return {
          name: sc.name,
          policy: formatCollectionPolicy(policyObj),
          requiredPeerCount:
            sc.required_peer_count ?? sc.requiredPeerCount ?? 0,
          maxPeerCount:
            sc.maximum_peer_count ??
            sc.maximumPeerCount ??
            sc.max_peer_count ??
            0,
          blockToLive:
            Number(sc.block_to_live ?? sc.blockToLive ?? 0),
          memberOnlyRead:
            sc.member_only_read ?? sc.memberOnlyRead ?? false,
          memberOnlyWrite:
            sc.member_only_write ?? sc.memberOnlyWrite ?? false,
        };
      });
    } catch {
      // Not JSON — decode as protobuf CollectionConfigPackage
      try {
        return decodeCollectionConfigPackage(resultBytes);
      } catch (err) {
        throw new DiscoveryError(
          'lscc.GetCollectionsConfig returned a payload that is neither JSON nor ' +
            `a CollectionConfigPackage: ${(err as Error).message}. The chaincode ` +
            'does have a collection config — lscc rejects the query outright when ' +
            'it does not — so this payload cannot be read as "no collections".',
        );
      }
    }
  }

  private readVarint(buf: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset < buf.length) {
      const byte = buf[offset++];
      bytesRead++;
      value += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }

    return { value, bytesRead };
  }

  private skipField(buf: Buffer, offset: number, wireType: number): number {
    switch (wireType) {
      case 0: { // varint
        while (offset < buf.length && (buf[offset++] & 0x80) !== 0) {
          // Empty on purpose — the advance is the condition's `offset++`.
        }
        return offset;
      }
      case 1: return offset + 8; // 64-bit
      case 2: { // length-delimited
        offset++;
        const { value: len, bytesRead } = this.readVarint(buf, offset);
        return offset + bytesRead + len;
      }
      case 5: return offset + 4; // 32-bit
      default: return -1;
    }
  }
}
