// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ValueEncoding } from './utils/value-codec';
import { PrivateCollectionCoverage } from './extraction/private-data/coverage';

export { ValueEncoding };

// ── Migration tiers ──

export enum MigrationTier {
  CurrentState = 1,
  StateWithAudit = 2,
  FullHistory = 3,
}

// ── Extraction strategy ──

export type ExtractionStrategy = 'auto' | 'block-reconstruction';

// ── AMB configuration ──

export interface AmbNetworkConfig {
  networkId: string;
  memberId: string;
  nodeId: string;
  region: string;
  tlsCertPath: string;
}

export interface ResolvedEndpoints {
  peerEndpoint: string; // host:30003
  peerEventEndpoint: string; // host:30004
  caEndpoint: string; // host:30002
  ordererEndpoint: string; // host:30001
  stateDb: 'CouchDB' | 'LevelDB';
  /**
   * AMB's `FrameworkVersion` for the network — the peer binary version, e.g.
   * '1.2', '1.4', '2.2'. This is what decides whether the peer implements
   * `DeliverWithPrivateData`; see `utils/fabric-version`.
   */
  frameworkVersion: string;
}

export interface ConnectionProfile {
  name: string;
  version: string;
  client?: {
    organization: string;
    tlsClientCerts?: {
      certPath: string;
      keyPath: string;
    };
  };
  channels: Record<string, { orderers: string[]; peers: Record<string, object> }>;
  organizations: Record<string, { mspid: string; peers: string[]; certificateAuthorities: string[] }>;
  orderers: Record<string, { url: string; tlsCACerts: { path?: string; pem?: string }; grpcOptions?: Record<string, string> }>;
  peers: Record<string, { url: string; tlsCACerts: { path?: string; pem?: string }; eventUrl?: string; grpcOptions?: Record<string, string> }>;
  certificateAuthorities: Record<string, { url: string; tlsCACerts: { path?: string; pem?: string } }>;
}

// ── gRPC tuning ──

export interface GrpcTimeouts {
  /** Deadline for evaluate/endorse/submit/request calls (ms). Default: 30 000. */
  requestMs?: number;
  /** Deadline for commit-status checks (ms). Default: 60 000. */
  commitMs?: number;
  /** gRPC wait-for-ready / connect timeout (ms). Default: 15 000. */
  connectMs?: number;
}

export const DEFAULT_GRPC_TIMEOUTS: Required<GrpcTimeouts> = {
  requestMs: 30_000,
  commitMs: 60_000,
  connectMs: 15_000,
};

/**
 * Largest response every gRPC client this tool builds will accept, in bytes.
 *
 * grpc-js caps receives at 4 MiB by default, which is well under what a Fabric
 * peer will legitimately send: the sample migration contract alone allows 8 MiB
 * of history values per key and base64-encodes them, and a single large state
 * value inflates the same way when it is read back. This matches the peer's own
 * `maxSendMsgSize` default of 100 MB, so the far end's limit binds first rather
 * than a client default nothing documents.
 *
 * The send direction is left at grpc-js's own default, which is unlimited.
 */
export const GRPC_MAX_RECEIVE_BYTES = 100 * 1024 * 1024;

// ── Identity ──

export interface FabricIdentity {
  mspId: string;
  certFingerprint: string;
  commonName: string;
  org: string;
}

export interface IdentityRecord extends FabricIdentity {
  _type: 'identity';
  firstSeenBlock: number;
  lastSeenBlock: number;
  txCount: number;
}

// ── Discovery / Manifest ──

export interface CollectionConfig {
  name: string;
  policy: string;
  requiredPeerCount: number;
  maxPeerCount: number;
  blockToLive: number;
  memberOnlyRead: boolean;
  memberOnlyWrite: boolean;
  /**
   * True for a Fabric 2.x `_implicit_org_<MSPID>` collection synthesized from
   * the channel's member MSPs rather than read from a collection package.
   *
   * Implicit collections exist for every org on every 2.x chaincode and appear
   * in no chaincode definition, so discovery has to construct them. Synthesized
   * means "this collection may exist", not "this collection was written to" —
   * coverage still comes from what the peer delivered.
   */
  implicit?: boolean;
}

export interface ChaincodeInfo {
  name: string;
  version: string;
  sequence: number;
  collections: CollectionConfig[];
}

export interface ChannelInfo {
  channelId: string;
  chaincodes: ChaincodeInfo[];
  ledgerHeight: number;
}

/** One member's contribution to a merged extraction directory. */
export interface MergedMember {
  /** Directory the records came from, as passed to `merge`. */
  inputDir: string;
  memberId: string;
  /** AMB peer node that supplied this member's private-data view. */
  nodeId?: string;
  /** MSP the extraction ran as, absent when the member's manifest omitted it. */
  mspId?: string;
  /** State database of this member's peer. Members of one network may differ. */
  stateDb?: 'CouchDB' | 'LevelDB';
  extractedAt: string;
}

export interface Manifest {
  networkId: string;
  memberId: string;
  /** AMB peer node used for discovery/extraction. */
  nodeId?: string;
  region: string;
  stateDb: 'CouchDB' | 'LevelDB';
  extractedAt: string;
  /**
   * MSP ID of the identity discovery ran as. Private data collection policies
   * are written in terms of MSP IDs, so this is what decides which collections
   * an extraction can read values for.
   *
   * Omitted in a merged directory, where several MSPs contributed and no single
   * one describes what was visible — read `mergedFrom` instead.
   */
  mspId?: string;
  /**
   * Members whose extractions were combined by `merge`, in the order given.
   *
   * Present only in a merged directory. A private key absent from a merged
   * extraction is out of reach of *every* listed MSP, which is what makes this
   * the field `validate` has to reason from rather than `mspId`.
   */
  mergedFrom?: MergedMember[];
  /** Detected Fabric major version: '2.x' or '1.x'. */
  fabricVersion?: string;
  /**
   * AMB's `FrameworkVersion` for the network — the peer binary version, e.g.
   * '1.2', '1.4', '2.2'.
   *
   * The only field that decides whether private-data *values* are obtainable:
   * `DeliverWithPrivateData` is implemented by the peer binary, not enabled by a
   * channel capability. See `utils/fabric-version`, which refuses to guess when
   * this is absent rather than fall back to `fabricCapabilities`.
   */
  ambFrameworkVersion?: string;
  /**
   * Detected channel capabilities from the config block.
   *
   * Descriptive only. These govern which *features a channel admits*, not which
   * RPCs its peers serve, so they are not a proxy for the peer version — a 2.2
   * peer serves `DeliverWithPrivateData` on a channel still at `V1_2`.
   */
  fabricCapabilities?: {
    application: string;
    channel: string;
    orderer: string;
  };
  channels: ChannelInfo[];
}

/** Channel-level extraction summary persisted as `channel-<id>/metadata.json`. */
export interface ChannelMetadata {
  channelId: string;
  extractedAt: string;
  /** AMB peer node whose ledger/private-data store answered extraction. */
  nodeId?: string;
  tier: MigrationTier;
  strategy: string;
  ledgerHeight: number;
  /**
   * MSP ID of the identity that ran the extraction.
   *
   * Omitted by `merge` for the same reason `Manifest.mspId` is: a merged
   * directory has no single extracting MSP.
   */
  extractedByMspId?: string;
  chaincodes: Array<{ name: string; version: string; collections: number }>;
  /** Blocks that legitimately produced no block-metadata records. */
  blocksWithoutMetadata: number[];
  privateDataCoverage: PrivateCollectionCoverage[];
  /**
   * `'private-only'` when the channel was extracted with `--private-only`;
   * absent for a full extraction, and on every merged directory.
   *
   * Such a channel carries no hashes, so its coverage cannot tell a collection
   * that was never written from one whose values are missing: an authorized
   * collection without values is reported `indeterminate`, and `merge`
   * re-derives the reason from the hashes a full member contributed.
   */
  scope?: 'private-only';
  /**
   * The last block the public walk verified: its number and its header hash
   * (SHA-256 of the ASN.1 header). `extract --extend` checks the peer's block
   * against it before walking on, so a directory is never extended with
   * another chain's blocks. Absent for private-only and older extractions.
   */
  walkTip?: { blockNumber: number; headerHash: string };
  /** One entry per `extract --extend` run, oldest first. */
  extensions?: Array<{ fromBlock: number; toLedgerHeight: number; extractedAt: string }>;
  /**
   * Record counts. History and metadata are cumulative across runs into this
   * directory; `publicState` is the count in the current state file.
   */
  outputFiles: {
    publicState: number;
    publicHistory: number;
    blockMetadata: number;
  };
}

// ── Extraction records (NDJSON _type discriminant) ──

export interface PublicStateRecord {
  _type: 'public_state';
  channel: string;
  chaincode: string;
  key: string;
  value: string;
  /**
   * Set to `'base64'` when `value` is base64 of the raw ledger bytes.
   * Absent means `value` is the literal UTF-8 value. See `utils/value-codec`.
   */
  valueEncoding?: ValueEncoding;
  /** Identity that signed the transaction which last wrote this key. */
  creator?: FabricIdentity;
}

export interface PublicHistoryRecord {
  _type: 'public_history';
  channel: string;
  chaincode: string;
  key: string;
  value: string;
  /** See `PublicStateRecord.valueEncoding`. */
  valueEncoding?: ValueEncoding;
  txId: string;
  txIndex: number;
  blockNumber: number;
  timestamp: string;
  isDelete: boolean;
  creator: FabricIdentity;
}

export interface BlockMetadataRecord {
  _type: 'block_metadata';
  channel: string;
  blockNumber: number;
  txId: string;
  txIndex: number;
  timestamp: string;
  chaincodeId: string;
  keysWritten: string[];
  keysDeleted: string[];
  creator: FabricIdentity;
}

export interface PrivateStateRecord {
  _type: 'private_state';
  channel: string;
  chaincode: string;
  collection: string;
  key: string;
  value: string;
  /** See `PublicStateRecord.valueEncoding`. */
  valueEncoding?: ValueEncoding;
  /** Identity that signed the transaction which last wrote this key. */
  creator?: FabricIdentity;
}

export interface PrivateHistoryRecord {
  _type: 'private_history';
  channel: string;
  chaincode: string;
  collection: string;
  key: string;
  value: string;
  /** See `PublicStateRecord.valueEncoding`. */
  valueEncoding?: ValueEncoding;
  txId: string;
  blockNumber: number;
  txIndex: number;
  timestamp: string;
  isDelete: boolean;
  creator?: FabricIdentity;
}

export interface PrivateHashRecord {
  _type: 'private_hash';
  channel: string;
  chaincode: string;
  collection: string;
  key: string;
  hash: string;
  blockNumber: number;
  txId: string;
  txIndex: number;
}

/**
 * Not written by extraction. `replay --since` sends one for a state key whose last write in the replayed range was a
 * delete: the key is absent from the new state file, and the destination must drop it too.
 */
export interface StateDeleteRecord {
  _type: 'state_delete';
  channel: string;
  chaincode: string;
  /** Present for a private key. */
  collection?: string;
  key: string;
}

/** What a replay adapter is handed: extraction records, plus state deletes in a `--since` replay. */
export type ReplayRecord = ExtractionRecord | StateDeleteRecord;

export type ExtractionRecord =
  | PublicStateRecord
  | PublicHistoryRecord
  | BlockMetadataRecord
  | PrivateStateRecord
  | PrivateHistoryRecord
  | PrivateHashRecord
  | IdentityRecord;

// ── Checkpoint ──

export interface Checkpoint {
  channel: string;
  strategy: string;
  lastBlockNumber: number;
  lastBookmark?: string;
  updatedAt: string;
}

// ── Replay ──

/**
 * A destination function per chaincode, keyed by source channel then by source
 * chaincode name.
 *
 * Nested rather than flat because a chaincode name is only unique within a
 * channel: an eight-channel migration runs one application across eight channels,
 * and the same name on two of them is two deployments that can need two
 * different destination functions. A flat `Record<chaincode, fn>` gives them one
 * entry and silently routes both through it.
 *
 *   { "orders-ch": { "marketplace": "PutState" },
 *     "trades-ch": { "marketplace": "ImportLegacyState" } }
 *
 * Every value is `ContractName:FunctionName`, or a bare function name to mean
 * the migration contract — see `parseQualifiedFunction`.
 */
export type ChannelFunctionMap = Record<string, Record<string, string>>;

/** Credentials one destination org submits with, for `chaincode.orgIdentities`. */
export interface OrgIdentity {
  certPath: string;
  keyPath: string;
  /** Defaults to the top-level connection profile. */
  connectionProfilePath?: string;
}

/** A full per-collection identity, for `chaincode.collectionIdentities`. */
export interface CollectionIdentity extends OrgIdentity {
  mspId: string;
}

/**
 * Every destination `replay` can write to, in the order the config generator
 * offers them.
 *
 * The list is a value rather than a bare union because four places need it: the
 * `--adapter` help text, the config generator's menu, the orchestrator's
 * dispatch, and `verify`'s. A separate copy in the help text is what let it
 * name two of the three.
 */
export const REPLAY_ADAPTERS = ['postgresql', 'dynamodb', 'chaincode'] as const;

export type ReplayAdapter = typeof REPLAY_ADAPTERS[number];

export interface ReplayConfig {
  adapter: ReplayAdapter;
  inputDir: string;
  channels?: string[];
  /**
   * Replay only the records at or above a height per channel: `extension` (each channel's most recent
   * `extract --extend`) or `<channel>=<block>,...`. Keys deleted in that range are deleted at the destination.
   */
  since?: string;
  /** Records per batch during replay. Default: 500. */
  batchSize?: number;
  /** gRPC timeouts for chaincode replay. Ignored for postgresql/dynamodb adapters. */
  timeouts?: GrpcTimeouts;
  postgresql?: {
    connectionString: string;
    /** Accept a non-local connection without certificate-verified TLS. Default false. */
    allowInsecure?: boolean;
  };
  dynamodb?: {
    /** AWS region. */
    region: string;
    /** Table name for state records (public + private). */
    stateTable: string;
    /** Table name for history records (public + private). */
    historyTable?: string;
    /** Table name for block metadata. */
    metadataTable?: string;
    /** Table name for identity records. */
    identityTable?: string;
    /** Table name for private data hash records. */
    privateHashTable?: string;
    /** Optional endpoint override for local development (e.g. http://localhost:8000). */
    endpoint?: string;
  };
  chaincode?: {
    /** Path to a standard Fabric connection profile JSON (works with open-source Fabric, managed Fabric services, AMB, etc). */
    connectionProfilePath: string;
    /** MSP ID for the submitting identity. */
    mspId: string;
    /** Path to PEM-encoded X.509 certificate for the submitting identity. */
    certPath: string;
    /** Path to PEM-encoded private key for the submitting identity. */
    keyPath: string;
    /**
     * Destination collection name → the identity that writes it.
     *
     * A collection with `memberOnlyWrite` admits writes only from an MSP named
     * in its policy, and an implicit collection `_implicit_org_<MSPID>` admits
     * only that one MSP — so a migration carrying five members' private data
     * cannot submit all of it as one org. Collections with no entry here are
     * written by the top-level identity.
     *
     * An entry is either a full identity or the MSP ID of an org already
     * described in `orgIdentities` (or the top-level `mspId`), so a collection
     * owned by an org whose credentials are configured once is one word, not a
     * second copy of them. An implicit collection needs no entry at all when its
     * owning org is in `orgIdentities`; an entry here overrides that.
     *
     * `connectionProfilePath` defaults to the top-level profile. Override it
     * when the collection's data must be endorsed by a peer of the owning org:
     * a peer that is not a collection member cannot store the private data it
     * endorses, so an implicit collection generally needs both its owner's
     * identity and its owner's peer.
     *
     * Keyed by collection name alone, which is what implicit collections need:
     * on Fabric 2.x every chaincode on a channel shares `_implicit_org_<MSPID>`,
     * so one entry covers them all.
     */
    collectionIdentities?: Record<string, CollectionIdentity | string>;
    /**
     * Destination channel → collection → identity, for a collection name whose
     * owner differs between channels.
     *
     * `collectionIdentities` is keyed by collection name alone, which is right
     * for implicit collections and for a chaincode deployed with one collection
     * config everywhere. It cannot express `pairAB` belonging to Org1/Org2 on
     * one channel and Org4/Org5 on another — the same name, two policies — so
     * the five-member live test had to split its replay by channel. An entry
     * here wins over `collectionIdentities` and `orgIdentities` on that
     * channel only. Values take the same forms: a full identity or an MSP ID
     * reference.
     *
     * Keyed by the **destination** channel, like the collection names inside
     * it, because the policy that decides a write is the destination's.
     */
    channelCollectionIdentities?: Record<
      string, Record<string, CollectionIdentity | string>
    >;
    /**
     * Destination MSP ID → the credentials that org submits with.
     *
     * Each org's credentials are written once, and every
     * `_implicit_org_<MSPID>` destination collection is written as the org it
     * is named after with no `collectionIdentities` entry. Explicit collections
     * an org owns refer to it by MSP ID in `collectionIdentities`.
     */
    orgIdentities?: Record<string, OrgIdentity>;
    /**
     * Write an implicit collection whose owning org has no identity here as
     * the top-level identity, endorsed by the owning org's peers.
     *
     * Fabric checks two things on a write to `_implicit_org_<MSPID>`: that the
     * transaction is endorsed by a peer of `<MSPID>` (the collection's implicit
     * endorsement policy), and nothing about the submitter, since implicit
     * collections leave `memberOnlyWrite` off. So the owner's signing key is
     * not needed — its peer is. With this on, replay names the owner in the
     * gateway's `endorsingOrganizations` for every write to that collection;
     * the gateway reaches the owner's peer through service discovery, which
     * needs the owner's anchor peer in the channel config.
     *
     * Off by default because it moves a decision to the consortium: the owner
     * does not sign these writes, so its consent is the channel's endorsement
     * policy and whatever agreement made the lead the migration operator. An
     * `orgIdentities` or `collectionIdentities` entry for the owner still
     * wins. Explicit collections are unaffected: one with `memberOnlyWrite`
     * still refuses a submitter its policy does not name.
     */
    ownerEndorsement?: boolean;
    /**
     * Destination channel → hex SHA-256 of its genesis block, as printed by
     * `fingerprint-destination`. When set, `replay` and `verify` read every
     * destination channel's genesis block first and refuse on any mismatch —
     * a config is bound to one ledger, not to whatever its connection profile
     * points at. See `replay/destination-fingerprint.ts`.
     */
    destinationFingerprint?: Record<string, string>;
    /**
     * Source MSP ID → destination MSP ID, one entry per migrating member.
     *
     * Derives the `collectionMapping` entry for every implicit collection:
     * `{ "m-ABC123": "Org2MSP" }` routes `_implicit_org_m-ABC123` to
     * `_implicit_org_Org2MSP` on every chaincode and channel. An explicit
     * `collectionMapping` entry for the same collection wins.
     */
    mspMapping?: Record<string, string>;
    /**
     * Source collection name → destination collection name.
     * e.g. { "_implicit_org_m-ABC123": "_implicit_org_Org2MSP" }
     *
     * A collection name belongs to the destination's chaincode definition, not
     * to the data, so the source's name need not exist there. Collections with
     * no entry are written under the name the source used.
     *
     * **Required for every `_implicit_org_<MSPID>` collection**, whose name is
     * the owning org's MSP ID and therefore cannot match a destination network's
     * — replay refuses before its first write rather than failing every private
     * key on the collection name. Map it to itself if the destination really
     * does use the same MSP ID. An `mspMapping` entry for the owning MSP
     * satisfies this without a per-collection entry.
     *
     * Keyed by collection name alone, like `collectionIdentities`: on Fabric 2.x
     * every chaincode on a channel shares one `_implicit_org_<MSPID>`, so one
     * entry covers all of them. `collectionIdentities` is keyed by the
     * destination name — the policy that admits a write is the destination
     * collection's.
     *
     * `verify` reads private data back through the same map, so a mapped
     * collection is compared against the collection it was written to.
     */
    collectionMapping?: Record<string, string>;
    /**
     * Target channel for single-destination replay.
     * Required unless channelMapping is provided.
     */
    channel?: string;
    /**
     * Source channel → destination channel mapping for multi-channel replay.
     * e.g. { "source-ch1": "dest-ch1", "source-ch2": "dest-ch2" }
     * Channels not in this map are skipped.
     */
    channelMapping?: Record<string, string>;
    /**
     * Source channel → source chaincode → target function for public writes.
     * e.g. { "ch1": { "mycc": "PutState", "payments": "SampleAssets:ImportState" } }
     * Records whose (channel, chaincode) isn't in this map use "PutState",
     * which resolves to the migration contract.
     *
     * The function takes the key as its only argument and reads the value from
     * transient data under "public_value" — see
     * sample/chaincode/migration_contract/README.md.
     */
    keyMapping?: ChannelFunctionMap;
    /**
     * Source channel → source chaincode → target function for public deletes.
     * e.g. { "ch1": { "mycc": "DeleteState", "payments": "SampleAssets:Remove" } }
     * Records whose (channel, chaincode) isn't in this map use "DeleteState",
     * which resolves to the migration contract.
     *
     * Separate from keyMapping because a delete is not a write with an empty
     * value: the function takes the key alone and carries no transient data, so
     * a keyMapping entry submitted for a tombstone would write rather than
     * delete. Only read when replayHistory is on — a tombstone exists only in
     * public_history.
     *
     * Set this whenever keyMapping names a contract other than
     * migrationContract. Writes going to an application's own function while
     * deletes go to the migration contract's DeleteState leaves whatever that
     * function maintains besides the key — composite-key indexes, counters —
     * pointing at keys that no longer exist.
     *
     * Private deletes are not configurable: ImportPrivateData is fixed by the
     * transient-data wire contract, so DeletePrivateData stays beside it.
     */
    deleteMapping?: ChannelFunctionMap;
    /** Max concurrent transaction submissions. Defaults to 1. */
    concurrency?: number;
    /**
     * Max public writes carried in one `PutStateBatch` transaction. Defaults
     * to 500; 1 submits every write on its own.
     *
     * A transaction costs an endorsement round trip plus an ordering and commit
     * wait whatever it carries, so replaying a deep history one version at a
     * time takes weeks. Batching amortises that cost over every key in the
     * batch — but only over distinct keys: a transaction records one version per
     * key, so two versions of one key never share a batch and a single hot key's
     * history is submitted one version at a time whatever this is set to.
     *
     * Only public writes to the migration contract's own `PutState` and
     * `DeleteState` are batched — naming either explicitly in `keyMapping` or
     * `deleteMapping` is the same configuration as naming nothing. An entry
     * pointing anywhere else opts its (channel, chaincode) out, because the
     * application function it names has its own signature. Private writes are
     * batched through `ImportPrivateDataBatch`, one collection per transaction,
     * except under `historyImport` — see `sample/chaincode/migration_contract/README.md`.
     */
    writeBatchSize?: number;
    /**
     * Source channels replayed at once. Defaults to 1, one channel after another.
     *
     * Channels are separate destination ledgers, so nothing orders a write on
     * one against a write on another, and the per-key ordering replay depends
     * on lives entirely within a channel. Above 1, each channel keeps its own
     * checkpoint (`replay-checkpoint-chaincode-<channel>.json`) and its own
     * failure state, so a history failure on one channel stops that channel
     * alone. Up to `channelConcurrency × concurrency` transactions are in
     * flight at once.
     */
    channelConcurrency?: number;
    /**
     * Source channel → chaincode → read function for public state verification.
     * Used by the `verify` command to query each key on the destination.
     * e.g. { "ch1": { "mycc": "MigrationContract:ReadState" } }
     *
     * `ContractName:Function`. An unqualified name resolves to the migration
     * contract, whose results are base64-decoded, so an application's own read
     * function has to name its contract: "SampleAssets:ReadAsset".
     */
    readFunctions?: ChannelFunctionMap;
    /**
     * Source channel → chaincode → read function for private state verification.
     * e.g. { "ch1": { "mycc": "MigrationContract:ReadPrivateData" } }
     */
    privateReadFunctions?: ChannelFunctionMap;
    /**
     * Replay Tier 3 history records (public_history, private_history).
     * Each historical write becomes a PutState / ImportPrivateData call
     * using the existing keyMapping, replayed in block order so the
     * destination's native GetHistoryForKey reflects the full sequence.
     * Default: false.
     */
    replayHistory?: boolean;
    /**
     * Opt in to resilient, idempotent Tier 3 history replay.
     *
     * Valid only with `replayHistory: true`. When set, public and private
     * history mutations are submitted through the migration contract's
     * idempotency protocol (`ImportHistory` / `ImportHistoryBatch`) instead of
     * plain `PutState` / `ImportPrivateData`, so a failed or interrupted run can
     * be re-run safely: each mutation carries a deterministic operation ID and
     * an intent commitment, and the contract records a receipt per operation, so
     * re-submitting a mutation that already landed is a no-op rather than a
     * duplicate history entry.
     *
     * Current-state replay is unaffected — the protocol applies to history
     * records only — and public write/delete mappings to application contracts
     * are refused, since an application function cannot participate in the
     * protocol. See `src/replay/history-import`.
     */
    historyImport?: {
      /** Protocol version. Only `'idempotent-v1'` is implemented. */
      mode: 'idempotent-v1';
      /**
       * Lowercase-hex, 32–64 characters. Namespaces this migration's plan and
       * receipts on the destination contract. Reusing a scope with a different
       * plan (changed source network, history files, routing,
       * embedSourceMetadata, or migration contract) or a different key is
       * refused. Batch size is operational and may change between retries.
       */
      scope: string;
      /**
       * Path to a file holding the HMAC key: 32 raw bytes or 64 hex
       * characters. The key derives every operation ID and intent commitment
       * and never leaves the client. The same key must be used across runs of
       * the same scope for re-runs to be idempotent.
       */
      keyPath: string;
    };
    /**
     * When replayHistory is enabled, attach source block metadata to each
     * replayed value so downstream consumers can trace back to the source
     * ledger after migration.
     *
     * Only applies to values that are JSON objects, where the metadata is
     * merged in as a nested field and the original shape survives, so typed
     * chaincode reads and CouchDB rich queries keep working:
     *   { ...originalFields, migrationMeta: { blockNumber, txId, timestamp, isDelete } }
     *
     * Values that are not JSON objects — binary, JSON scalars, arrays,
     * non-JSON text — are replayed byte-for-byte and get no metadata.
     * Wrapping them would change their type at the destination.
     *
     * If the source object already has a `migrationMeta` field, it is
     * overwritten and a warning is logged.
     *
     * Default: false — the destination receives exactly what the source
     * held. Enable it only if you need source provenance in the value and
     * have confirmed the destination chaincode tolerates the extra field.
     */
    embedSourceMetadata?: boolean;
    /**
     * Source channel → chaincode → read function that returns key history as a
     * JSON array of { value, isDelete } objects, in the order GetHistoryForKey
     * yields them (see destinationStateDb).
     * Used by verify to confirm the replayed history sequence matches.
     * e.g. { "ch1": { "mycc": "MigrationContract:GetKeyHistory" } }
     */
    historyReadFunctions?: ChannelFunctionMap;
    /**
     * State database of the destination peer: 'CouchDB' or 'LevelDB'.
     * Determines history ordering for verification (CouchDB returns
     * newest-first, LevelDB returns oldest-first).
     * Default: uses the source peer's stateDb from the manifest.
     */
    destinationStateDb?: 'CouchDB' | 'LevelDB';
    /** Skip composite keys (keys containing \0) during verification. Default: true. */
    skipCompositeKeys?: boolean;
    /** Allow plaintext gRPC (grpc://) connections. Default: false. */
    allowInsecure?: boolean;
    /**
     * Contract name registered alongside your chaincode in
     * fabric-contract-api-go's NewChaincode(). When multiple
     * contracts are registered, the Fabric SDK requires this
     * to route calls to the correct contract namespace.
     * Default: 'MigrationContract'.
     */
    migrationContract?: string;
  };
}

// ── CLI options ──

export interface DiscoverOptions {
  networkId: string;
  memberId: string;
  nodeId: string;
  region: string;
  outputDir: string;
  /** A known channel name to bootstrap cscc channel discovery. */
  bootstrapChannel?: string;
  /** Explicitly provided channel names. */
  channels?: string[];
  /** Explicit path to the AMB TLS CA certificate. Auto-resolved if not set. */
  tlsCertPath?: string;
  /** Path to an existing admin MSP directory (signcerts/cert.pem + keystore/*_sk). Skips CA enrollment. */
  mspPath?: string;
}

export type StateBackendOption = 'auto' | 'memory' | 'leveldb';

export interface ExtractOptions {
  manifest: string;
  /** AMB peer node whose endpoint extraction uses. */
  nodeId?: string;
  tier: MigrationTier;
  channels?: string[];
  outputDir: string;
  batchSize: number;
  strategy: ExtractionStrategy;
  /** Number of channels to extract in parallel. Default: 1 (sequential). */
  concurrency: number;
  /** State accumulator backend: auto (promote when needed), memory, leveldb. Default: auto. */
  stateBackend: StateBackendOption;
  /** Memory limit in MB before auto-promoting to LevelDB. Default: 512. */
  memoryLimitMb: number;
  /** Number of blocks to fetch ahead during block walk. Default: 8. */
  prefetchBuffer: number;
  /**
   * Directory the LevelDB state accumulator spills into, one subdirectory per
   * channel. Default: the system temp directory.
   */
  stateDataDir?: string;
  /**
   * Extract this member's private data only: run `DeliverWithPrivateData` and
   * skip the public block walk, so no public state, public history, block
   * metadata, private hashes or identities are written. For a member of a
   * multi-member migration whose public data another member's full extraction
   * already carries — public records are identical on every peer, private
   * values are not. See `ChannelMetadata.scope`.
   */
  privateOnly?: boolean;
  /**
   * Also write every raw block to `<dir>/<channel>/blocks/<N>.block`, with a
   * digest list and a manifest, for block-level migration (`fabric-rebroadcast`).
   * Opt-in: when absent the extraction is the one it always was.
   */
  saveBlocksDir?: string;
  /**
   * With `saveBlocksDir`: walk, verify the hash chain and write the archive, and
   * nothing else. No state, history, metadata, private data or identity file is
   * produced, and `outputDir` is not written.
   */
  blocksOnly?: boolean;
  /**
   * Continue a completed extraction in `outputDir` to the manifest's (higher)
   * ledger height: walk only the new blocks, seeded with the state already
   * extracted, append history, metadata and hashes, and replace the state files.
   */
  extend?: boolean;
  /**
   * Extract channels in this many child processes, one channel each, into the
   * same output directory. Each child's walk then has a CPU core of its own.
   */
  processes?: number;
  /**
   * Set by the parent of `--processes` for each child, to the channel's
   * identity part (`identityPartPath`). Every fresh extraction commits that
   * part with the channel; a child leaves `identities.ndjson` alone, and the
   * parent rebuilds it from the parts once every child has committed.
   */
  identitiesOut?: string;
}

