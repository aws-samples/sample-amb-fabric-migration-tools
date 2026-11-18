// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ChannelFunctionMap,
  ChannelInfo,
  Manifest,
  ReplayConfig,
  PublicStateRecord,
  PublicHistoryRecord,
  PrivateStateRecord,
} from '../types';
import { FabricGateway } from '../connection/fabric-gateway';
import { FileLayoutManager } from '../output/file-layout-manager';
import { lineReadBuffer, readLineAt } from '../output/ndjson-scan';
import { indexPrivateFiles } from '../output/private-file-index';
import {
  keyPartitionKey,
  parseKeyPartitionKey,
} from '../replay/adapters/dynamodb-keys';
import { DYNAMODB_MAX_ATTEMPTS } from '../replay/adapters/dynamodb-adapter';
import { assertPostgresqlTls, toJsonbLiteral } from '../replay/adapters/postgresql-adapter';
import { resolveChannelRouting } from '../replay/channel-routing';
import { assertDestinationFingerprint } from '../replay/destination-fingerprint';
import { destinationCollection } from '../replay/collection-routing';
import { withOrgRouting } from '../replay/org-routing';
import { forEachOrdered } from '../utils/ordered-pool';
import {
  DEFAULT_MIGRATION_CONTRACT,
  countFunctions,
  mappedFunction,
  parseQualifiedFunction,
} from '../replay/function-mapping';
import { NdjsonReader } from '../replay/ndjson-reader';
import { decodeStorageKey, encodeStorageKey } from '../utils/key-codec';
import { createLogger } from '../utils/logger';
import {
  EncodedValue,
  decodeLedgerValue,
  encodeLedgerValue,
  isTextValue,
  toColumnValue,
} from '../utils/value-codec';

const logger = createLogger('verify-runner');

/**
 * U+0000, the only separator Fabric composite keys use. Written as a code
 * point so this source file stays free of control characters.
 */
const NUL = String.fromCharCode(0);

/**
 * The contract and function one configured read function names.
 *
 * The split itself is `parseQualifiedFunction`, shared with replay so both
 * commands read a config value the same way.
 */
function resolveContract(
  network: any,
  chaincode: string,
  qualifiedFn: string,
  migrationContract: string,
): { contract: any; functionName: string; isMigrationContract: boolean } {
  const { contractName, functionName, isMigrationContract } =
    parseQualifiedFunction(qualifiedFn, migrationContract);
  return {
    contract: network.getContract(chaincode, contractName),
    functionName,
    isMigrationContract,
  };
}

/** Why a record was not verified. */
export type SkipReason =
  | 'composite-key'
  | 'no-read-function'
  | 'no-private-read-function'
  | 'no-history-read-function'
  | 'no-key-listing'
  | 'no-private-history-api';

export const SKIP_REASONS: SkipReason[] = [
  'composite-key',
  'no-read-function',
  'no-private-read-function',
  'no-history-read-function',
  'no-key-listing',
  'no-private-history-api',
];

export interface VerifyEntry {
  channel: string;
  chaincode: string;
  key: string;
  collection?: string;
  /** `extra` is a destination key no source record accounts for. */
  status: 'match' | 'mismatch' | 'missing' | 'error' | 'skip' | 'extra';
  detail?: string;
  /** Set only when status is 'skip'. */
  skipReason?: SkipReason;
}

export interface VerifySummary {
  match: number;
  mismatch: number;
  missing: number;
  error: number;
  skip: number;
  /** Destination keys with no source record. */
  extra: number;
  /** Skipped records broken down by reason. Reasons with no skips are omitted. */
  skipsByReason: Partial<Record<SkipReason, number>>;
  /**
   * What each skip reason affected, as `chaincode` or `chaincode/collection`,
   * sorted. Reasons with no skips are omitted.
   *
   * Carried in the summary rather than derived from the entries because the
   * entries are no longer kept: a reason's count says how much went unverified
   * and this says where to go and fix it. Bounded by the manifest — a chaincode
   * and its collections — not by the ledger.
   */
  skipTargets: Partial<Record<SkipReason, string[]>>;
}

/** Where a verification pass sends each entry as it is produced. */
type EmitEntry = (entry: VerifyEntry) => void;

type SkipBase = Omit<VerifyEntry, 'status'>;

function compositeKeySkip(base: SkipBase): VerifyEntry {
  return {
    ...base,
    status: 'skip',
    skipReason: 'composite-key',
    detail: 'composite key',
  };
}

/** The reasons that mean one configured function map has no entry. */
type UnmappedFunctionReason =
  | 'no-read-function'
  | 'no-private-read-function'
  | 'no-history-read-function';

const UNMAPPED_LABELS: Record<UnmappedFunctionReason, string> = {
  'no-read-function': 'read function',
  'no-private-read-function': 'private read function',
  'no-history-read-function': 'history read function',
};

/**
 * A record left unverified because its chaincode has no function mapped.
 *
 * The label names the channel as well as the chaincode: the maps are keyed by
 * both, so "no read function for mycc" would not say which of the eight entries
 * an operator has to add.
 */
function unmappedFunctionSkip(
  base: SkipBase,
  reason: UnmappedFunctionReason,
): VerifyEntry {
  return {
    ...base,
    status: 'skip',
    skipReason: reason,
    detail:
      `no ${UNMAPPED_LABELS[reason]} for ${base.channel}/${base.chaincode}`,
  };
}

export interface VerifyOptions {
  /** Channels to verify. Every channel in the manifest when omitted. */
  channels?: string[];
  /**
   * Called once per entry, in the order the entries are produced.
   *
   * The only way to see them: a run produces one entry per source key on every
   * channel, so the runner counts them and hands each one straight on rather
   * than returning an array whose size is the ledger's.
   */
  onEntry?: EmitEntry;
  /**
   * Destination queries in flight. Defaults to 1.
   *
   * Every compared key costs at least one round trip to the destination, so
   * one at a time makes a remote destination's latency the whole cost of the
   * run: 12,060 entries took 100 s on a LAN and 656 s at 50 ms more RTT. Entries
   * are still reported in source order whatever this is.
   */
  concurrency?: number;
  /**
   * Replace every value excerpt in a mismatch detail with its SHA-256 prefix
   * and length. Mismatch details otherwise quote up to 80 characters of the
   * expected and actual values — private ones included — which is right for a
   * human at a terminal and wrong for anything that forwards the output, such
   * as an AI assistant. Keys, statuses and counts are unchanged.
   */
  redactValues?: boolean;
}

/**
 * Set for the duration of one `runVerification`. Module state rather than a
 * parameter because the value renderers sit below every compare path; one
 * process runs one verification.
 */
let redactValues = false;

/** A value as it may appear in a detail: excerpted, or redacted. */
function shownValue(s: string): string {
  if (!redactValues) return truncate(s);
  const digest = crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
  return `<redacted sha256:${digest} ${s.length} chars>`;
}

/** What a verification pass reads a channel's extracted records from. */
interface RecordSource {
  inputDir: string;
  layout: FileLayoutManager;
  reader: NdjsonReader;
}

/**
 * Running totals for the summary, accumulated one entry at a time.
 *
 * The summary used to be six filters over the finished entry array; counting on
 * the way past is what lets the array go.
 */
function createTally(onEntry?: EmitEntry): {
  emit: EmitEntry;
  summary: () => VerifySummary;
} {
  const counts: Record<VerifyEntry['status'], number> = {
    match: 0, mismatch: 0, missing: 0, error: 0, skip: 0, extra: 0,
  };
  const skips = new Map<SkipReason, { count: number; targets: Set<string> }>();

  return {
    emit: (entry) => {
      counts[entry.status]++;
      if (entry.skipReason) {
        let seen = skips.get(entry.skipReason);
        if (!seen) {
          seen = { count: 0, targets: new Set() };
          skips.set(entry.skipReason, seen);
        }
        seen.count++;
        seen.targets.add(
          entry.collection
            ? `${entry.chaincode}/${entry.collection}`
            : entry.chaincode,
        );
      }
      onEntry?.(entry);
    },

    summary: () => {
      const skipsByReason: Partial<Record<SkipReason, number>> = {};
      const skipTargets: Partial<Record<SkipReason, string[]>> = {};
      for (const reason of SKIP_REASONS) {
        const seen = skips.get(reason);
        if (!seen) continue;
        skipsByReason[reason] = seen.count;
        skipTargets[reason] = [...seen.targets].sort();
      }
      return { ...counts, skipsByReason, skipTargets };
    },
  };
}

/**
 * Verify extracted state matches the destination by querying each key
 * and comparing values. Supports chaincode, postgresql, and dynamodb
 * adapters — dispatches based on config.adapter.
 *
 * @returns The counts alone. Pass `options.onEntry` to see the entries.
 */
export async function runVerification(
  inputDir: string,
  rawConfig: ReplayConfig,
  options: VerifyOptions = {},
): Promise<VerifySummary> {
  // Read back through the same effective collectionMapping replay wrote through.
  const config = withOrgRouting(rawConfig);
  const { channels } = options;
  const layout = new FileLayoutManager(inputDir);
  const reader = new NdjsonReader();

  if (!fs.existsSync(layout.manifestPath)) {
    throw new Error(
      `No manifest.json found at ${layout.manifestPath}`,
    );
  }

  const manifest: Manifest = JSON.parse(
    fs.readFileSync(layout.manifestPath, 'utf-8'),
  );

  if (channels) {
    const known = manifest.channels.map((c) => c.channelId);
    const unknown = channels.filter((c) => !known.includes(c));
    if (unknown.length > 0) {
      throw new Error(
        `--channels named channel(s) that are not in the manifest: ` +
        `${unknown.join(', ')}. Manifest channels: ` +
        `${known.length > 0 ? known.join(', ') : '(none)'}`,
      );
    }
  }

  const channelsToVerify = channels
    ? manifest.channels.filter(
        (c) => channels.includes(c.channelId),
      )
    : manifest.channels;

  redactValues = options.redactValues ?? false;
  try {
    return await runVerificationInner(inputDir, config, channelsToVerify, manifest, layout, reader, options);
  } finally {
    redactValues = false;
  }
}

async function runVerificationInner(
  inputDir: string,
  config: ReplayConfig,
  channelsToVerify: ChannelInfo[],
  manifest: Manifest,
  layout: FileLayoutManager,
  reader: NdjsonReader,
  options: VerifyOptions,
): Promise<VerifySummary> {
  const tally = createTally(options.onEntry);
  const ctx: VerifyContext = {
    inputDir, layout, reader, manifest,
    channels: channelsToVerify,
    config,
    emit: tally.emit,
    concurrency: resolveVerifyConcurrency(options.concurrency),
  };

  switch (config.adapter) {
    case 'chaincode':
      await verifyChaincode(ctx);
      break;
    case 'postgresql':
      await verifyPostgresql(ctx);
      break;
    case 'dynamodb':
      await verifyDynamodb(ctx);
      break;
    default:
      throw new Error(
        `Unsupported adapter: ${config.adapter}`,
      );
  }

  const summary = tally.summary();
  logger.info({ summary }, 'Verification complete');
  return summary;
}

// ── Shared iteration ──

/** What one adapter's verification pass works from. */
interface VerifyContext extends RecordSource {
  manifest: Manifest;
  /** The manifest channels in scope for this run. */
  channels: ChannelInfo[];
  config: ReplayConfig;
  emit: EmitEntry;
  /** Destination queries in flight. */
  concurrency: number;
}

/** Validate `VerifyOptions.concurrency`; 0 would compare nothing. */
function resolveVerifyConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`verify concurrency must be an integer >= 1, got: ${value}`);
  }
  return value;
}

async function iterateStateRecords(
  ctx: VerifyContext,
  onPublic: (r: PublicStateRecord, ch: string) => Promise<VerifyEntry>,
  onPrivate: (r: PrivateStateRecord, ch: string) => Promise<VerifyEntry>,
): Promise<void> {
  const { inputDir, layout, reader } = ctx;

  for (const channel of ctx.channels) {
    const channelId = channel.channelId;

    const publicStatePath = path.join(
      inputDir, layout.publicStatePath(channelId),
    );
    if (fs.existsSync(publicStatePath)) {
      await forEachOrdered(
        reader.streamByType<PublicStateRecord>(publicStatePath, 'public_state'),
        ctx.concurrency,
        (record) => onPublic(record, channelId),
        ctx.emit,
      );
    }

    const channelDir = path.join(
      inputDir, layout.channelDir(channelId),
    );
    for (const pvtFile of layout.listPrivateFiles(channelId, '-state.ndjson')) {
      const pvtPath = path.join(channelDir, pvtFile);
      await forEachOrdered(
        reader.streamByType<PrivateStateRecord>(pvtPath, 'private_state'),
        ctx.concurrency,
        (record) => onPrivate(record, channelId),
        ctx.emit,
      );
    }
  }
}

// ── Reverse sweep: destination keys with no source record ──
//
// Verification is otherwise one-directional. It asks whether every source key
// arrived and never whether anything else is there, so a destination that was
// not empty before replay, a tombstone replayed as a write, or a mapped write
// function that stored under a different key all leave keys behind that no
// source record accounts for — and every one of those runs reports success.
//
// Public state only. Private state is not swept because one member's extraction
// is not the whole collection set: in a multi-member migration each member
// replays the collections it can read into the same destination, so a collection
// absent from this extraction can still belong there, and sweeping it would
// report the other members' data as junk.
//
// Each destination answers a different question, and the difference is a limit
// on what the sweep can see. The two databases are asked for a whole channel's
// public rows, so a key under a chaincode the extraction never names is found.
// A Fabric destination can only be range-queried one chaincode namespace at a
// time, so it is asked once per chaincode the manifest names, and a namespace
// outside the manifest is not swept at all.
//
// Costs one channel's public key set in memory. A sweep also holds the extra
// keys it finds until it has finished, because a sweep that fails partway
// reports the failure alone: what it holds is bounded by the keys nothing
// accounts for, which is nothing at all on a clean run, and streaming them out
// as they were found would mean reporting a set that may be missing pages.

/**
 * Every public key the source holds on one channel, in the destination's form.
 *
 * Compared in the form the destination reports — `encodeStorageKey` for the two
 * databases, base64 for a chaincode's `ListKeys` — so the sweep decodes only
 * the keys it reports rather than every key it reads.
 *
 * Composite keys are included even though the forward pass skips comparing
 * them: replay wrote them, so they are at the destination, and a source set
 * without them would report every one as extra.
 *
 * Held whole, one channel at a time, because a sweep cannot tell what is absent
 * from a stream. The destination returns keys in its own order, not the file's.
 */
async function collectSourceKeys(
  src: RecordSource,
  channelId: string,
  encodeKey: (key: string) => string,
): Promise<Set<string>> {
  const { inputDir, layout, reader } = src;
  const keys = new Set<string>();
  const statePath = path.join(inputDir, layout.publicStatePath(channelId));
  // An empty source set, not a warning: a channel may hold no public state,
  // and the forward pass reads the same file behind the same check. The sweep
  // still runs — every destination key is then extra, which is the answer.
  if (!fs.existsSync(statePath)) return keys;

  for await (const record of reader.streamByType<PublicStateRecord>(
    statePath, 'public_state',
  )) {
    keys.add(`${record.chaincode}${NUL}${encodeKey(record.key)}`);
  }

  return keys;
}

/** How a chaincode destination reports and receives a key. */
const toBase64 = (key: string): string =>
  Buffer.from(key, 'utf-8').toString('base64');

const fromBase64 = (encoded: string): string =>
  Buffer.from(encoded, 'base64').toString('utf-8');

/**
 * A destination key no source record accounts for.
 *
 * The caller decodes, because each destination stores keys in its own form and
 * only the caller knows which one answered.
 */
function extraKey(
  channelId: string,
  chaincode: string,
  key: string,
): VerifyEntry {
  return { channel: channelId, chaincode, key, status: 'extra' };
}

/**
 * A sweep that could not run, reported without losing the rest of the run.
 *
 * `key` is empty because the failure belongs to no one key: the sweep asks one
 * question of a whole channel, or of one chaincode's namespace on it. Reported
 * rather than thrown so a connection lost after the forward pass still leaves
 * its results readable.
 */
function sweepFailure(
  channelId: string,
  err: any,
  chaincode = '',
): VerifyEntry {
  return {
    channel: channelId,
    chaincode,
    key: '',
    status: 'error',
    detail: `destination key sweep failed: ${err.message}`,
  };
}

/**
 * The migration contract's key listing
 * (`sample/chaincode/migration_contract/README.md`).
 */
const LIST_KEYS_FUNCTION = 'ListKeys';

/**
 * Keys per `ListKeys` page.
 *
 * Bounds peer-to-chaincode traffic rather than the response: there is no
 * keys-only range query in the chaincode API, so the peer sends every value in
 * the page to the chaincode whichever way `ListKeys` answers.
 */
const KEY_PAGE_SIZE = 500;

/**
 * One chaincode namespace left unswept, because nothing there can list its keys.
 *
 * `ListKeys` has no configurable stand-in — a paginated range query over a whole
 * namespace is not a shape an application's read function has — so the sweep
 * runs only where the config says the migration contract is deployed, which is
 * its `readFunctions` entry. Reported rather than attempted so a deployment
 * reading through its own contract can still finish clean, with the namespaces
 * nobody swept named in the skip report.
 */
function keyListingSkip(
  channelId: string,
  chaincode: string,
  migrationContract: string,
): VerifyEntry {
  return {
    channel: channelId,
    chaincode,
    key: '',
    status: 'skip',
    skipReason: 'no-key-listing',
    detail:
      `no key listing for ${channelId}/${chaincode} — its readFunctions ` +
      `entry does not name ${migrationContract}, the only contract with ` +
      `${LIST_KEYS_FUNCTION}`,
  };
}

// ── Chaincode verification ──

/**
 * Fail before connecting to the destination if any chaincode in the manifest
 * has no read function mapped. Without this check those chaincodes are
 * silently skipped and verify still exits 0, reporting success for data that
 * was never checked.
 *
 * `privateReadFunctions` is required of exactly the chaincodes that have private
 * state on disk. It used to also require the chaincode to declare a collection,
 * which decided nothing: discovery synthesizes an implicit collection for every
 * channel org on every 2.x chaincode, so the count is never zero there. Private
 * files now name their chaincode, so the file itself answers the question the
 * collection count was standing in for.
 *
 * Args:
 *   channelsToVerify: Manifest channels in scope for this run.
 *   cc: Chaincode section of the replay config.
 *   hasPrivateState: Whether one chaincode on one channel has private state
 *     extracted.
 */
function checkReadFunctionCoverage(
  channelsToVerify: ChannelInfo[],
  cc: NonNullable<ReplayConfig['chaincode']>,
  hasPrivateState: (channelId: string, chaincode: string) => boolean,
): void {
  const gaps: string[] = [];

  for (const channel of channelsToVerify) {
    for (const chaincode of channel.chaincodes ?? []) {
      const missing: string[] = [];

      const mapped = (map: ChannelFunctionMap | undefined): boolean =>
        mappedFunction(map, channel.channelId, chaincode.name) !== undefined;

      if (!mapped(cc.readFunctions)) {
        missing.push('readFunctions');
      }
      if (
        hasPrivateState(channel.channelId, chaincode.name) &&
        !mapped(cc.privateReadFunctions)
      ) {
        missing.push('privateReadFunctions');
      }
      if (
        (cc.replayHistory || cc.historyReadFunctions) &&
        !mapped(cc.historyReadFunctions)
      ) {
        missing.push('historyReadFunctions');
      }

      if (missing.length > 0) {
        gaps.push(
          `${channel.channelId}/${chaincode.name} ` +
          `(missing ${missing.join(', ')})`,
        );
      }
    }
  }

  if (gaps.length > 0) {
    throw new Error(
      'Every chaincode on every channel must have a read function mapped, ' +
      'otherwise its records are skipped and verify reports success for ' +
      `data it never checked. Unmapped: ${gaps.join('; ')}. ` +
      'Add the missing entries to the chaincode section of the replay ' +
      'config, or narrow the run with --channels.',
    );
  }
}

/**
 * Look up where each in-scope channel's records were replayed to.
 *
 * Verify reads back from the same routing `replay` wrote through, so the config
 * has to route every channel in scope. An unrouted channel used to fall back to
 * the source channel's own name, which is a channel that need not exist at the
 * destination: the run then reported an error per record, blaming the
 * destination for a config that never named it.
 *
 * @param cc Chaincode section of the replay config.
 * @param channelsToVerify Manifest channels in scope for this run.
 * @returns Source channel → destination channel, total over the channels in
 *   scope.
 * @throws ExtractorError when the config routes none of them, or when it merges
 *   channels; Error naming the unrouted channels when it covers only some.
 */
function destinationChannels(
  cc: NonNullable<ReplayConfig['chaincode']>,
  channelsToVerify: ChannelInfo[],
): (channelId: string) => string {
  const sourceChannels = channelsToVerify.map((c) => c.channelId);
  const { routes, unroutedChannels } = resolveChannelRouting(
    cc, sourceChannels,
  );

  if (unroutedChannels.length > 0) {
    throw new Error(
      'Every channel being verified needs a destination, and ' +
      `chaincode.channelMapping has no entry for: ` +
      `${unroutedChannels.join(', ')}. Verify has no channel to read those ` +
      'records back from. Map them if they were replayed, or leave them out ' +
      'of the run with --channels.',
    );
  }

  const bySource = new Map(routes.map((r) => [r.channel, r.destChannel]));
  return (channelId: string): string => {
    const destChannel = bySource.get(channelId);
    if (!destChannel) {
      throw new Error(`No destination channel resolved for ${channelId}`);
    }
    return destChannel;
  };
}

/**
 * Which chaincodes have private state extracted, as `channelId\0chaincode`.
 *
 * Read from the files rather than from the manifest's collection counts: a
 * declared collection may hold nothing, and only a file with records means there
 * is private data to verify.
 */
async function chaincodesWithPrivateState(
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channels: ChannelInfo[],
): Promise<Set<string>> {
  const found = new Set<string>();

  for (const channel of channels) {
    const files = await indexPrivateFiles(
      reader, layout, channel.channelId, '-state.ndjson',
    );
    for (const { chaincode } of files) {
      found.add(`${channel.channelId}\0${chaincode}`);
    }
  }

  return found;
}

async function verifyChaincode(ctx: VerifyContext): Promise<void> {
  const { inputDir, layout, reader, config, manifest } = ctx;
  const channelsToVerify = ctx.channels;
  const cc = config.chaincode;
  if (!cc) {
    throw new Error(
      'Verify requires a chaincode adapter config with ' +
      'readFunctions defined',
    );
  }
  if (countFunctions(cc.readFunctions) === 0) {
    throw new Error(
      'No readFunctions defined in chaincode config — ' +
      'verify needs at least one channel-and-chaincode-to-function mapping, ' +
      'e.g. { "ch1": { "mycc": "MigrationContract:ReadState" } }',
    );
  }
  const destChannels = destinationChannels(cc, channelsToVerify);
  const withPrivateState = await chaincodesWithPrivateState(
    layout, reader, channelsToVerify,
  );
  checkReadFunctionCoverage(channelsToVerify, cc, (channelId, chaincode) =>
    withPrivateState.has(`${channelId}\0${chaincode}`),
  );

  // Resolved before connecting, so a config that cannot be verified is refused before any read.
  const historyStateDb = cc.replayHistory || cc.historyReadFunctions
    ? destinationStateDbFor(cc.destinationStateDb, manifest)
    : undefined;

  const skipComposite = cc.skipCompositeKeys ?? true;
  const gateway = new FabricGateway();
  await gateway.connect({
    connectionProfilePath: cc.connectionProfilePath,
    mspId: cc.mspId,
    certPath: cc.certPath,
    keyPath: cc.keyPath,
    timeouts: config.timeouts,
    allowInsecure: cc.allowInsecure,
  });

  const mcName = cc.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
  const networkFor = (channelId: string) =>
    gateway.getGatewayNetwork(destChannels(channelId));

  try {
    // A verify of the wrong network would report on a ledger nobody migrated.
    const bound = await assertDestinationFingerprint(
      cc.destinationFingerprint,
      (destChannel) => gateway.getGatewayNetwork(destChannel),
      channelsToVerify.map((c) => destChannels(c.channelId)),
    );
    if (!bound) {
      logger.warn(
        'chaincode.destinationFingerprint is not set, so nothing confirms this ' +
        'is the destination the config was made for: run fingerprint-destination ' +
        'and add the map',
      );
    }

    await iterateStateRecords(
      ctx,
      (record, channelId) => verifyChaincodePublicKey(
        networkFor(channelId), record, cc.readFunctions!,
        skipComposite, channelId, mcName,
      ),
      (record, channelId) => verifyChaincodePrivateKey({
        network: networkFor(channelId),
        privateReadFunctions: cc.privateReadFunctions,
        migrationContract: mcName,
        skipComposite,
        channelId,
        mspId: cc.mspId,
        collectionMapping: cc.collectionMapping,
      }, record),
    );

    if (cc.replayHistory || cc.historyReadFunctions) {
      const historyReadFunctions = cc.historyReadFunctions;
      if (!historyReadFunctions) {
        throw new Error(
          'chaincode.replayHistory requires historyReadFunctions for every ' +
            'chaincode in scope',
        );
      }
      const destStateDb = historyStateDb!;
      for (const channel of channelsToVerify) {
        const channelId = channel.channelId;
        await verifyChaincodeHistory({
          inputDir,
          layout,
          reader,
          emit: ctx.emit,
          concurrency: ctx.concurrency,
          network: networkFor(channelId),
          readFunctions: historyReadFunctions,
          migrationContract: mcName,
          skipComposite,
          channelId,
          reverseActual: destStateDb === 'CouchDB',
        });
        for (const entry of await skipPrivateHistory(layout, reader, channelId)) {
          ctx.emit(entry);
        }
      }
    }

    for (const channel of channelsToVerify) {
      const entries = await sweepChaincodeExtraKeys({
        inputDir,
        layout,
        reader,
        network: networkFor(channel.channelId),
        readFunctions: cc.readFunctions!,
        migrationContract: mcName,
        channel,
      });
      for (const entry of entries) ctx.emit(entry);
    }
  } finally {
    gateway.disconnect();
  }
}

async function verifyChaincodePublicKey(
  network: any,
  record: PublicStateRecord,
  readFunctions: ChannelFunctionMap,
  skipComposite: boolean,
  channelId: string,
  migrationContract: string,
): Promise<VerifyEntry> {
  const base = {
    channel: channelId,
    chaincode: record.chaincode,
    key: record.key,
  };

  if (skipComposite && record.key.includes(NUL)) {
    return compositeKeySkip(base);
  }

  const readFn = mappedFunction(readFunctions, channelId, record.chaincode);
  if (!readFn) {
    return unmappedFunctionSkip(base, 'no-read-function');
  }

  try {
    const { contract, functionName, isMigrationContract } = resolveContract(
      network, record.chaincode, readFn, migrationContract,
    );
    const resultBytes = await contract.evaluateTransaction(
      functionName, record.key,
    );
    return compareChaincodeValue(
      base, record, resultBytes, isMigrationContract,
    );
  } catch (err: any) {
    return classifyChaincodeError(base, err);
  }
}

/** What one channel's private keys are read back through. */
interface PrivateVerifyContext {
  network: any;
  privateReadFunctions: ChannelFunctionMap | undefined;
  migrationContract: string;
  skipComposite: boolean;
  channelId: string;
  /** The one MSP the run connects as, named in the hash-fallback detail. */
  mspId: string;
  /**
   * The same map replay wrote through, so a mapped collection is read back from
   * the collection it was written to rather than from the source's name.
   */
  collectionMapping: Record<string, string> | undefined;
}

/**
 * Compare one private key against the destination — by value, or by hash.
 *
 * The value read is the real check and is tried first. When it fails, the
 * fallback exists because failing is the expected outcome for a collection this
 * identity is not a member of, not evidence that the data is gone: `verify`
 * connects exactly one identity, a merged multi-member extraction holds
 * collections that identity cannot read, and every one of their keys used to be
 * reported `missing` — a loss report over data that is present and correct.
 *
 * Only for a read function on the migration contract, since `ReadPrivateDataHash`
 * is that contract's own. A mismatch is never retried by hash: the value was
 * read and it differed, so the hash would differ too.
 */
async function verifyChaincodePrivateKey(
  ctx: PrivateVerifyContext,
  record: PrivateStateRecord,
): Promise<VerifyEntry> {
  const base = {
    channel: ctx.channelId,
    chaincode: record.chaincode,
    key: record.key,
    collection: record.collection,
  };

  if (ctx.skipComposite && record.key.includes(NUL)) {
    return compositeKeySkip(base);
  }

  const readFn = mappedFunction(
    ctx.privateReadFunctions, ctx.channelId, record.chaincode,
  );
  if (!readFn) {
    return unmappedFunctionSkip(base, 'no-private-read-function');
  }

  const collection = destinationCollection(
    ctx.collectionMapping, record.collection,
  );

  try {
    const { contract, functionName, isMigrationContract } = resolveContract(
      ctx.network, record.chaincode, readFn, ctx.migrationContract,
    );
    const resultBytes = await contract.evaluateTransaction(
      functionName, collection, record.key,
    );
    return compareChaincodeValue(
      base, record, resultBytes, isMigrationContract,
    );
  } catch (err: any) {
    const byValue = readFromMapped(
      classifyChaincodeError(base, err), record.collection, collection,
    );
    const { isMigrationContract } = parseQualifiedFunction(
      readFn, ctx.migrationContract,
    );
    if (!isMigrationContract) return byValue;
    return comparePrivateDataHash(ctx, record, base, byValue);
  }
}

/**
 * Name the collection a failed private read was actually addressed to.
 *
 * Only when it differs from the source's. A `missing` on a mapped collection is
 * otherwise reported against a collection name the destination never saw, which
 * reads as data loss when the likelier cause is the mapping.
 */
function readFromMapped(
  entry: VerifyEntry,
  collection: string,
  dest: string,
): VerifyEntry {
  if (dest === collection) return entry;

  const read = `read from ${dest}`;
  return {
    ...entry,
    detail: entry.detail ? `${read}; ${entry.detail}` : read,
  };
}

/** The migration contract function that answers for an unreadable collection. */
const PRIVATE_HASH_FUNCTION = 'ReadPrivateDataHash';

/**
 * Compare a private key by hash, as evidence when its value cannot be read.
 *
 * A hash match is reported as a `match` rather than as its own status because it
 * is the same evidence Fabric itself gives a non-member: the private-data hash
 * lives in public channel state, so a destination whose hash equals the SHA-256
 * of the extracted value holds those bytes. The detail says the comparison was
 * by hash, and which identity could not read the value.
 *
 * A failed hash read returns the original value-read outcome with the hash
 * attempt appended, so the reason the key was in question stays the headline.
 * That covers both the key genuinely not being there and a destination package
 * predating this function.
 *
 * @param base The entry fields identifying the key, collection and channel.
 * @param byValue What the value read concluded, kept if the hash cannot be read.
 */
async function comparePrivateDataHash(
  ctx: PrivateVerifyContext,
  record: PrivateStateRecord,
  base: SkipBase,
  byValue: VerifyEntry,
): Promise<VerifyEntry> {
  const expected = sha256Hex(decodeLedgerValue(record));

  try {
    const contract = ctx.network.getContract(
      record.chaincode, ctx.migrationContract,
    );
    const resultBytes = await contract.evaluateTransaction(
      PRIVATE_HASH_FUNCTION,
      destinationCollection(ctx.collectionMapping, record.collection),
      record.key,
    );
    const actual = decodeContractPayload(
      Buffer.from(resultBytes).toString('utf-8'),
    ).toString('hex');

    const unreadable = `value not readable by ${ctx.mspId}`;
    if (actual === expected) {
      return {
        ...base,
        status: 'match',
        detail: `${unreadable}; SHA-256 matches the destination's ` +
          'private-data hash',
      };
    }
    return {
      ...base,
      status: 'mismatch',
      detail: `${unreadable}; expected SHA-256 ${expected}, the destination's ` +
        `private-data hash is ${actual}`,
    };
  } catch (err: any) {
    const hashError = err.message ?? String(err);
    return {
      ...byValue,
      detail: byValue.detail
        ? `${byValue.detail}; ${PRIVATE_HASH_FUNCTION}: ${hashError}`
        : `${PRIVATE_HASH_FUNCTION}: ${hashError}`,
    };
  }
}

/** Hex SHA-256, the form Fabric's own private-data hashes are compared in. */
function sha256Hex(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Report that a channel's replayed private history cannot be read back.
 *
 * Fabric exposes no private-data history API — `GetHistoryForKey` covers public
 * state only, and none of `GetPrivateData`, `GetPrivateDataHash` or the private
 * range and rich queries carries a version — so there is no function a
 * destination contract could offer and no configuration that would help. Before
 * this, private history was replayed and then passed over in silence, which
 * reads as verified.
 *
 * One entry per `(chaincode, collection)` with no key, like the key sweep's own
 * skip: the reason is a property of the destination platform, not of any key.
 */
async function skipPrivateHistory(
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channelId: string,
): Promise<VerifyEntry[]> {
  const files = await indexPrivateFiles(
    reader, layout, channelId, '-history.ndjson',
  );

  return files.map(({ chaincode, collection }) => ({
    channel: channelId,
    chaincode,
    collection,
    key: '',
    status: 'skip' as const,
    skipReason: 'no-private-history-api' as const,
    detail:
      `Fabric has no private-data history API, so the replayed history of ` +
      `${chaincode}/${collection} cannot be read back from this destination`,
  }));
}

function classifyChaincodeError(
  base: Omit<VerifyEntry, 'status'>,
  err: any,
): VerifyEntry {
  const msg = err.message ?? String(err);
  if (msg.includes('does not exist') || msg.includes('not found')) {
    return { ...base, status: 'missing' };
  }
  return { ...base, status: 'error', detail: msg };
}

// ── History ordering verification (Tier 3) ──

interface HistoryVerifyContext extends RecordSource {
  emit: EmitEntry;
  concurrency: number;
  network: any;
  readFunctions: ChannelFunctionMap;
  migrationContract: string;
  skipComposite: boolean;
  channelId: string;
  reverseActual: boolean;
}

async function verifyChaincodeHistory(
  ctx: HistoryVerifyContext,
): Promise<void> {
  await forEachOrdered(
    expectedHistoryGroups(ctx, ctx.channelId),
    ctx.concurrency,
    ({ chaincode, key, values }) =>
      verifyKeyHistorySequence(ctx, chaincode, key, values),
    ctx.emit,
  );
}

/**
 * Compare one key's history against what the destination contract reports.
 *
 * The contract returns a JSON array, which can only carry text, so how each
 * entry's `value` is read depends on whose function answered. The migration
 * contract base64-encodes every entry, and those are compared as bytes. A read
 * function belonging to the customer's own application is compared as text —
 * JSON cannot carry arbitrary bytes, so a binary value against such a contract
 * reports a mismatch, and there is nothing honest to compare.
 *
 * `isDelete` is read from the same entry either way. Every stub returns it, and
 * an entry that omits it is taken to be a write, so a source tombstone against
 * it reports a mismatch rather than a match.
 */
async function verifyKeyHistorySequence(
  ctx: HistoryVerifyContext,
  chaincode: string,
  key: string,
  expected: ExpectedEntry[],
): Promise<VerifyEntry> {
  const base = { channel: ctx.channelId, chaincode, key };

  if (ctx.skipComposite && key.includes(NUL)) {
    return compositeKeySkip(base);
  }

  const readFn = mappedFunction(ctx.readFunctions, ctx.channelId, chaincode);
  if (!readFn) {
    return unmappedFunctionSkip(base, 'no-history-read-function');
  }

  try {
    const { contract, functionName, isMigrationContract } = resolveContract(
      ctx.network, chaincode, readFn, ctx.migrationContract,
    );
    const resultBytes =
      await contract.evaluateTransaction(functionName, key);
    const parsed: Array<{ value: string; isDelete?: boolean }> = JSON.parse(
      Buffer.from(resultBytes).toString('utf-8'),
    );
    const actual = ctx.reverseActual ? [...parsed].reverse() : parsed;

    if (isMigrationContract) {
      return verifySequence(
        base,
        expected.map((v) => ({
          value: decodeLedgerValue(v), isDelete: v.isDelete,
        })),
        actual.map((e) => ({
          value: decodeContractPayload(e.value), isDelete: e.isDelete === true,
        })),
        BYTES_SEQUENCE,
      );
    }

    return verifySequence(
      base,
      expected.map((v) => ({ value: v.value, isDelete: v.isDelete })),
      actual.map((e) => ({ value: e.value, isDelete: e.isDelete === true })),
      TEXT_SEQUENCE,
    );
  } catch (err: any) {
    const msg = err.message ?? String(err);
    if (
      msg.includes('does not exist') ||
      msg.includes('not found')
    ) {
      return { ...base, status: 'missing' };
    }
    return { ...base, status: 'error', detail: msg };
  }
}

// ── Chaincode key sweep ──

interface KeySweepContext extends RecordSource {
  network: any;
  readFunctions: ChannelFunctionMap;
  migrationContract: string;
  channel: ChannelInfo;
}

/**
 * Public keys the destination holds on one channel that the source does not.
 *
 * One sweep per chaincode the manifest names, because a range query reaches one
 * namespace at a time. That set is also the one `checkReadFunctionCoverage`
 * guarantees a `readFunctions` entry for, so every namespace is either swept or
 * reported skipped — a chaincode the extraction never named is neither, and
 * cannot be, since nothing tells verify it exists.
 *
 * A namespace that fails mid-sweep gives up on that namespace alone: the keys
 * already found are dropped rather than reported, because a partial page set
 * cannot tell an extra key from one the next page would have accounted for.
 */
async function sweepChaincodeExtraKeys(
  ctx: KeySweepContext,
): Promise<VerifyEntry[]> {
  const channelId = ctx.channel.channelId;
  const sourceKeys = await collectSourceKeys(ctx, channelId, toBase64);

  const entries: VerifyEntry[] = [];
  for (const { name } of ctx.channel.chaincodes ?? []) {
    const readFn = mappedFunction(ctx.readFunctions, channelId, name);
    const listable = readFn !== undefined &&
      parseQualifiedFunction(readFn, ctx.migrationContract).isMigrationContract;
    if (!listable) {
      entries.push(keyListingSkip(channelId, name, ctx.migrationContract));
      continue;
    }

    try {
      const { contract } = resolveContract(
        ctx.network, name, readFn!, ctx.migrationContract,
      );
      entries.push(
        ...await sweepNamespace(contract, channelId, name, sourceKeys),
      );
    } catch (err: any) {
      entries.push(sweepFailure(channelId, err, name));
    }
  }

  return entries;
}

/**
 * Page through one namespace's keys, reporting the ones no source record holds.
 *
 * Stops on the empty bookmark Fabric ends a range query with. A bookmark that
 * comes back a second time is refused instead of followed: the destination is
 * not advancing, and following it again would page forever.
 *
 * @param sourceKeys Source keys as `chaincode\0base64Key`, from
 *   {@link collectSourceKeys}.
 */
async function sweepNamespace(
  contract: any,
  channelId: string,
  chaincode: string,
  sourceKeys: Set<string>,
): Promise<VerifyEntry[]> {
  const entries: VerifyEntry[] = [];
  const seen = new Set<string>();
  let bookmark = '';

  for (;;) {
    const page = await readKeyPage(contract, bookmark);

    for (const encoded of page.keys) {
      if (sourceKeys.has(`${chaincode}${NUL}${encoded}`)) continue;
      entries.push(extraKey(channelId, chaincode, fromBase64(encoded)));
    }

    if (page.bookmark === '') return entries;
    if (seen.has(page.bookmark)) {
      throw new Error(
        `${LIST_KEYS_FUNCTION} returned the bookmark ${page.bookmark} twice, ` +
        'so it is not advancing through the namespace and paging it again ' +
        'would not end',
      );
    }
    seen.add(page.bookmark);
    bookmark = page.bookmark;
  }
}

interface KeyPage {
  /**
   * Base64, for the reason values are
   * (`sample/chaincode/migration_contract/README.md`).
   */
  keys: string[];
  bookmark: string;
}

/**
 * One page of keys, refused unless it has the shape the contract promises.
 *
 * A page checked rather than trusted because the alternative is silence: a
 * function that answered with something else would be read as an empty page, and
 * an empty page is indistinguishable from a namespace holding nothing extra.
 */
async function readKeyPage(
  contract: any,
  bookmark: string,
): Promise<KeyPage> {
  const resultBytes = await contract.evaluateTransaction(
    LIST_KEYS_FUNCTION, String(KEY_PAGE_SIZE), bookmark,
  );
  const text = Buffer.from(resultBytes).toString('utf-8');
  const page = JSON.parse(text);

  if (
    !Array.isArray(page?.keys) ||
    page.keys.some((key: unknown) => typeof key !== 'string') ||
    typeof page.bookmark !== 'string'
  ) {
    throw new Error(
      `${LIST_KEYS_FUNCTION} returned ${text.slice(0, 200)}, not the ` +
      '{"keys":["<base64>",...],"bookmark":"..."} the migration contract ' +
      'answers with',
    );
  }

  return page as KeyPage;
}

// ── PostgreSQL verification ──

async function verifyPostgresql(ctx: VerifyContext): Promise<void> {
  const { config } = ctx;
  if (!config.postgresql?.connectionString) {
    throw new Error(
      'Verify requires postgresql.connectionString in config',
    );
  }

  assertPostgresqlTls(config.postgresql.connectionString, config.postgresql.allowInsecure);
  const pool = new Pool({
    connectionString: config.postgresql.connectionString,
    allowExitOnIdle: true,
  });

  try {
    await iterateStateRecords(
      ctx,
      (record, channelId) =>
        verifyPgPublicKey(pool, record, channelId),
      (record, channelId) =>
        verifyPgPrivateKey(pool, record, channelId),
    );

    for (const channel of ctx.channels) {
      await verifyPgHistory(ctx, pool, channel.channelId);

      const sourceKeys = await collectSourceKeys(
        ctx, channel.channelId, encodeStorageKey,
      );
      const extras = await sweepPgExtraKeys(
        pool, channel.channelId, sourceKeys,
      );
      for (const entry of extras) ctx.emit(entry);
    }
  } finally {
    await pool.end();
  }
}

async function verifyPgPublicKey(
  pool: Pool,
  record: PublicStateRecord,
  channelId: string,
): Promise<VerifyEntry> {
  const base = {
    channel: channelId,
    chaincode: record.chaincode,
    key: record.key,
  };

  try {
    const { rows } = await pool.query(
      `SELECT value::TEXT AS value, value_encoding FROM fabric_state
       WHERE channel = $1 AND chaincode = $2
         AND key = $3 AND collection IS NULL`,
      [record.channel, record.chaincode, encodeStorageKey(record.key)],
    );

    if (rows.length === 0) {
      return { ...base, status: 'missing' };
    }

    return compareStored(base, pgStored(record), storedFromRow(rows[0]));
  } catch (err: any) {
    return { ...base, status: 'error', detail: err.message };
  }
}

async function verifyPgPrivateKey(
  pool: Pool,
  record: PrivateStateRecord,
  channelId: string,
): Promise<VerifyEntry> {
  const base = {
    channel: channelId,
    chaincode: record.chaincode,
    key: record.key,
    collection: record.collection,
  };

  try {
    const { rows } = await pool.query(
      `SELECT value::TEXT AS value, value_encoding FROM fabric_state
       WHERE channel = $1 AND chaincode = $2
         AND key = $3 AND collection = $4`,
      [
        record.channel, record.chaincode,
        encodeStorageKey(record.key), record.collection,
      ],
    );

    if (rows.length === 0) {
      return { ...base, status: 'missing' };
    }

    return compareStored(base, pgStored(record), storedFromRow(rows[0]));
  } catch (err: any) {
    return { ...base, status: 'error', detail: err.message };
  }
}

async function verifyPgHistory(
  ctx: VerifyContext,
  pool: Pool,
  channelId: string,
): Promise<void> {
  await forEachOrdered(expectedHistoryGroups(ctx, channelId), ctx.concurrency,
    async ({ chaincode, key, values }): Promise<VerifyEntry> => {
    const base = { channel: channelId, chaincode, key };

    try {
      const { rows } = await pool.query(
        `SELECT value::TEXT AS value, value_encoding, is_delete
         FROM fabric_history
         WHERE channel = $1 AND chaincode = $2
           AND key = $3 AND collection IS NULL
         ORDER BY block_number, tx_index, tx_id, id`,
        [channelId, chaincode, encodeStorageKey(key)],
      );

      if (rows.length === 0) return { ...base, status: 'missing' };

      return verifySequence(
        base,
        values.map((v) => ({ value: pgStored(v), isDelete: v.isDelete })),
        rows.map((row) => ({
          value: storedFromRow(row), isDelete: row.is_delete === true,
        })),
        STORED_SEQUENCE,
      );
    } catch (err: any) {
      return { ...base, status: 'error', detail: err.message };
    }
  }, ctx.emit);
}

/**
 * Rows per page of the `fabric_state` sweep.
 *
 * Small enough that a channel's rows are never all in the driver at once, large
 * enough that the round trips are not the cost of the sweep.
 */
const PG_SWEEP_PAGE_ROWS = 5_000;

/**
 * `SELECT` for one page of a channel's public keys.
 *
 * Keyset pagination, not `OFFSET`: the whole point is that `fabric_state` may
 * hold more rows for one channel than fit in memory, and node-postgres buffers
 * a result set entirely before handing it over — an unpaged query is one
 * allocation the size of the channel. `OFFSET` would re-scan the rows already
 * seen on every page, turning a linear sweep quadratic.
 *
 * `(chaincode, key)` is a row comparison, so the page boundary is one condition
 * rather than the three-way disjunction the same thing written out longhand
 * needs. It also matches the leading columns of `idx_fabric_state_unique`, so a
 * page is an index scan resumed rather than a sort.
 */
function pgSweepPage(afterFirstPage: boolean): string {
  return (
    `SELECT chaincode, key FROM fabric_state
     WHERE channel = $1 AND collection IS NULL` +
    (afterFirstPage ? `
       AND (chaincode, key) > ($2::TEXT, $3::TEXT)` : '') +
    `
     ORDER BY chaincode, key
     LIMIT ${PG_SWEEP_PAGE_ROWS}`
  );
}

/**
 * Public keys `fabric_state` holds for a channel that the source does not.
 *
 * Paged rather than one query per key: the sweep is looking for rows no source
 * record names, so it cannot ask about them by name.
 *
 * @param sourceKeys Source keys as `chaincode\0storedKey`, from
 *   {@link collectSourceKeys}.
 */
async function sweepPgExtraKeys(
  pool: Pool,
  channelId: string,
  sourceKeys: Set<string>,
): Promise<VerifyEntry[]> {
  const entries: VerifyEntry[] = [];
  let after: { chaincode: string; key: string } | undefined;

  try {
    for (;;) {
      const { rows } = await pool.query(
        pgSweepPage(after !== undefined),
        after ? [channelId, after.chaincode, after.key] : [channelId],
      );

      for (const row of rows) {
        if (sourceKeys.has(`${row.chaincode}${NUL}${row.key}`)) continue;
        entries.push(
          extraKey(channelId, row.chaincode, decodeStorageKey(row.key)),
        );
      }

      if (rows.length < PG_SWEEP_PAGE_ROWS) return entries;
      const last = rows[rows.length - 1];
      after = { chaincode: last.chaincode, key: last.key };
    }
  } catch (err: any) {
    return [sweepFailure(channelId, err)];
  }
}

// ── DynamoDB verification ──

async function verifyDynamodb(ctx: VerifyContext): Promise<void> {
  const { config } = ctx;
  if (!config.dynamodb?.stateTable) {
    throw new Error(
      'Verify requires dynamodb.stateTable in config',
    );
  }

  const client = new DynamoDBClient({
    region: config.dynamodb.region,
    maxAttempts: DYNAMODB_MAX_ATTEMPTS,
    ...(config.dynamodb.endpoint
      ? { endpoint: config.dynamodb.endpoint }
      : {}),
  });
  const docClient = DynamoDBDocumentClient.from(client);
  const stateTable = config.dynamodb.stateTable;

  const historyTable = config.dynamodb.historyTable;
  const extractedHistory = ctx.channels.some((channel) =>
    fs.existsSync(path.join(
      ctx.inputDir, ctx.layout.publicHistoryPath(channel.channelId),
    )) ||
    ctx.layout.listPrivateFiles(channel.channelId, '-history.ndjson').length > 0,
  );
  if (extractedHistory && !historyTable) {
    throw new Error(
      'The extraction contains history records, but dynamodb.historyTable is ' +
        'not configured. Verification would otherwise report matching state ' +
        'without checking whether replay preserved history.',
    );
  }

  try {
    await iterateStateRecords(
      ctx,
      (record, channelId) =>
        verifyDynamoPublicKey(docClient, stateTable, record, channelId),
      (record, channelId) =>
        verifyDynamoPrivateKey(docClient, stateTable, record, channelId),
    );

    for (const channel of ctx.channels) {
      if (historyTable) {
        await verifyDynamoHistory(
          ctx, docClient, historyTable, channel.channelId,
        );
      }

      const sourceKeys = await collectSourceKeys(
        ctx, channel.channelId, encodeStorageKey,
      );
      const extras = await sweepDynamoExtraKeys(
        docClient, stateTable, channel.channelId, sourceKeys,
      );
      for (const entry of extras) ctx.emit(entry);
    }
  } finally {
    client.destroy();
  }
}

async function verifyDynamoPublicKey(
  docClient: DynamoDBDocumentClient,
  stateTable: string,
  record: PublicStateRecord,
  channelId: string,
): Promise<VerifyEntry> {
  const base = {
    channel: channelId,
    chaincode: record.chaincode,
    key: record.key,
  };

  try {
    const result = await docClient.send(new GetCommand({
      TableName: stateTable,
      Key: {
        pk: keyPartitionKey(
          record.channel, record.chaincode, '', encodeStorageKey(record.key),
        ),
      },
    }));

    if (!result.Item) {
      return { ...base, status: 'missing' };
    }

    return compareStored(
      base, dynamoStored(record), storedFromItem(result.Item),
    );
  } catch (err: any) {
    return { ...base, status: 'error', detail: err.message };
  }
}

async function verifyDynamoPrivateKey(
  docClient: DynamoDBDocumentClient,
  stateTable: string,
  record: PrivateStateRecord,
  channelId: string,
): Promise<VerifyEntry> {
  const base = {
    channel: channelId,
    chaincode: record.chaincode,
    key: record.key,
    collection: record.collection,
  };

  try {
    const result = await docClient.send(new GetCommand({
      TableName: stateTable,
      Key: {
        pk: keyPartitionKey(
          record.channel, record.chaincode, record.collection,
          encodeStorageKey(record.key),
        ),
      },
    }));

    if (!result.Item) {
      return { ...base, status: 'missing' };
    }

    return compareStored(
      base, dynamoStored(record), storedFromItem(result.Item),
    );
  } catch (err: any) {
    return { ...base, status: 'error', detail: err.message };
  }
}

async function verifyDynamoHistory(
  ctx: VerifyContext,
  docClient: DynamoDBDocumentClient,
  historyTable: string,
  channelId: string,
): Promise<void> {
  await forEachOrdered(expectedHistoryGroups(ctx, channelId), ctx.concurrency,
    async ({ chaincode, key, values }): Promise<VerifyEntry> => {
    const base = { channel: channelId, chaincode, key };

    try {
      const items = await queryAllDynamoItems(
        docClient, historyTable,
        `${channelId}#${chaincode}#${encodeStorageKey(key)}`,
      );

      if (items.length === 0) return { ...base, status: 'missing' };

      // Already in ledger order: the sort key is temporal and the query sets
      // ScanIndexForward. Re-sorting on blockNumber alone would lose txIndex.
      return verifySequence(
        base,
        values.map((v) => ({ value: dynamoStored(v), isDelete: v.isDelete })),
        items.map((item) => ({
          value: storedFromItem(item), isDelete: item.isDelete === true,
        })),
        STORED_SEQUENCE,
      );
    } catch (err: any) {
      return { ...base, status: 'error', detail: err.message };
    }
  }, ctx.emit);
}

/**
 * The chaincode and stored key a public-state item holds, or undefined when the
 * item is not this channel's public state.
 *
 * The adapter puts the whole ledger key in the partition key, so both fields
 * come out of `pk` and an item's identity does not depend on a sort key it no
 * longer has. An empty collection is what marks the item public; a private item
 * carries a collection name there, and Fabric has no collection named `''`.
 *
 * Non-strings and keys with fewer than four parts are rejected by
 * {@link parseKeyPartitionKey}. The channel is checked here as well as by the
 * scan's filter, which matches a prefix rather than a whole field — the filter
 * alone would admit `mychannel2#…` for channel `mychannel`.
 */
function publicStateItemKey(
  pk: unknown,
  channelId: string,
): { chaincode: string; storedKey: string } | undefined {
  const parts = parseKeyPartitionKey(pk);
  if (parts === undefined) return undefined;
  if (parts.channel !== channelId || parts.collection !== '') return undefined;
  return { chaincode: parts.chaincode, storedKey: parts.storedKey };
}

/**
 * Public keys the state table holds for a channel that the source does not.
 *
 * A scan, and now necessarily one: the partition key is the ledger key itself,
 * so there is no partition to ask for the keys of a namespace. Even before that
 * a query was the wrong shape — asking by partition would only find chaincodes
 * the source already names and miss a whole namespace of keys left by an earlier
 * run. One scan per channel in scope, still fewer reads than the forward pass,
 * which spends a `GetItem` on every key.
 *
 * @param sourceKeys Source keys as `chaincode\0storedKey`, from
 *   {@link collectSourceKeys}.
 */
async function sweepDynamoExtraKeys(
  docClient: DynamoDBDocumentClient,
  stateTable: string,
  channelId: string,
  sourceKeys: Set<string>,
): Promise<VerifyEntry[]> {
  const entries: VerifyEntry[] = [];
  let lastKey: Record<string, any> | undefined;

  try {
    do {
      const result = await docClient.send(new ScanCommand({
        TableName: stateTable,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: { ':prefix': `${channelId}#` },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));

      for (const item of result.Items ?? []) {
        const found = publicStateItemKey(item.pk, channelId);
        if (found === undefined) continue;
        if (sourceKeys.has(`${found.chaincode}${NUL}${found.storedKey}`)) continue;
        entries.push(
          extraKey(channelId, found.chaincode, decodeStorageKey(found.storedKey)),
        );
      }

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return entries;
  } catch (err: any) {
    return [sweepFailure(channelId, err)];
  }
}

/**
 * Every public-history entry for one key, oldest first.
 *
 * Public and private history share a partition: the adapter derives `pk` from
 * channel, chaincode and key alone, and tells the two apart only by a trailing
 * collection on the sort key. So the partition is filtered down to the entries
 * with no collection — a key written both publicly and into a private
 * collection would otherwise be compared against the union of both, and
 * reported as a length mismatch that no amount of re-replaying could fix.
 *
 * `collection` is a DynamoDB reserved word, hence the name placeholder. `size`
 * is used rather than `= ''` because the attribute is the empty string on
 * public entries.
 *
 * @param pk Partition key: `channel#chaincode#encodedKey`.
 */
async function queryAllDynamoItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'size(#collection) = :noCollection',
      ExpressionAttributeNames: { '#collection': 'collection' },
      ExpressionAttributeValues: { ':pk': pk, ':noCollection': 0 },
      ScanIndexForward: true,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    if (result.Items) items.push(...result.Items);
    // A filtered page can be empty while more pages remain, so the loop is
    // driven by LastEvaluatedKey rather than by how many items came back.
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// ── Shared history helpers ──

/** One write in a key's history: the value it stored, or a tombstone. */
interface ExpectedEntry extends EncodedValue {
  /** True when the write removed the key instead of setting a value. */
  isDelete: boolean;
}

interface ExpectedHistory {
  chaincode: string;
  key: string;
  values: ExpectedEntry[];
}

/**
 * One key's history at a time, grouped, in the order the keys first appear.
 *
 * Two passes over the history file, and the reason for the second one is that a
 * key's versions are scattered through the file while a comparison needs them
 * together. The obvious way to group them is a map of key to values, which holds
 * every history *value* — the file itself, in heap, at a tier where the file is
 * the largest thing the extraction produced. So the first pass keeps only where
 * each version is: eight bytes per version, whatever the value's size. The
 * second reads each group's lines back by offset, so the values of one key are
 * the most that is ever held.
 *
 * The alternatives were worse. Spilling the map to a local store needs somewhere
 * to put it, and `verify` has no flag for that. A rolling digest per key would
 * fit in even less, but a digest cannot say which version diverged, and that is
 * the detail the mismatch report exists for. Reading the file once per group is
 * O(keys × file), which at this size is not an option.
 *
 * A group yields as soon as the index is built, so the destination queries a
 * caller makes per group overlap the reads rather than following them.
 */
async function* expectedHistoryGroups(
  src: RecordSource,
  channelId: string,
): AsyncGenerator<ExpectedHistory> {
  const historyPath = path.join(
    src.inputDir, src.layout.publicHistoryPath(channelId),
  );
  if (!fs.existsSync(historyPath)) return;

  const offsetsByKey = new Map<string, number[]>();
  for await (const { record, offset } of src.reader.streamWithOffsets(
    historyPath,
  )) {
    if (record._type !== 'public_history') continue;
    const history = record as PublicHistoryRecord;
    const groupKey = `${history.chaincode}${NUL}${history.key}`;
    const offsets = offsetsByKey.get(groupKey);
    if (offsets) offsets.push(offset);
    else offsetsByKey.set(groupKey, [offset]);
  }

  const scratch = lineReadBuffer();
  const fd = fs.openSync(historyPath, 'r');
  try {
    for (const [groupKey, offsets] of offsetsByKey) {
      const sep = groupKey.indexOf(NUL);
      yield {
        chaincode: groupKey.slice(0, sep),
        key: groupKey.slice(sep + 1),
        values: offsets.map(
          (offset) => expectedEntry(historyPath, fd, offset, scratch),
        ),
      };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read one history record back by offset, as its expected value.
 *
 * The line was parsed and validated on the indexing pass, so a failure here
 * means the file changed underneath the run. Reported as such: comparing a
 * destination against a moving source is not a verification anyone can read.
 */
function expectedEntry(
  historyPath: string,
  fd: number,
  offset: number,
  scratch: Buffer,
): ExpectedEntry {
  const line = readLineAt(fd, offset, scratch);
  let record: PublicHistoryRecord;
  try {
    record = JSON.parse(line);
  } catch (err: any) {
    throw new Error(
      `${historyPath} no longer holds a history record at byte ${offset} ` +
      `(${err.message}). The file changed while verify was reading it — ` +
      'rerun against an extraction nothing is writing to.',
    );
  }

  return {
    value: record.value,
    valueEncoding: record.valueEncoding,
    isDelete: record.isDelete === true,
  };
}

/** How to compare and render one element of a history sequence. */
interface SequenceComparator<T> {
  equal: (expected: T, actual: T) => boolean;
  render: (value: T) => string;
}

/**
 * Compare two value sequences positionally, reporting the first divergence.
 *
 * @param base Entry fields identifying the key under test.
 * @param expected Values in source-ledger order.
 * @param actual Values as the destination returns them, already ordered.
 * @param cmp How to compare and render one element.
 */
function verifySequence<T>(
  base: SkipBase,
  expected: T[],
  actual: T[],
  cmp: SequenceComparator<T>,
): VerifyEntry {
  if (actual.length !== expected.length) {
    return {
      ...base,
      status: 'mismatch',
      detail:
        `history length: expected ${expected.length}, ` +
        `got ${actual.length}`,
    };
  }

  for (let i = 0; i < expected.length; i++) {
    if (cmp.equal(expected[i], actual[i])) continue;
    return {
      ...base,
      status: 'mismatch',
      detail:
        `history[${i}]: ` +
        `expected ${shownValue(cmp.render(expected[i]))}, ` +
        `got ${shownValue(cmp.render(actual[i]))}`,
    };
  }

  return { ...base, status: 'match' };
}

/** One element of a history sequence: a value, and how it got there. */
interface HistoryElement<T> {
  value: T;
  isDelete: boolean;
}

/**
 * Compare the delete flag alongside the value.
 *
 * A tombstone and a write of the empty value hold the same value, so a
 * comparator that reads only values reports MATCH for a delete replayed as
 * `PutState(key, "")` — a live key at the destination that must not exist, and
 * one that range and rich queries return. The flag is what tells them apart, so
 * it is compared first-class rather than inferred from an empty value: an
 * application may legitimately write an empty value without deleting.
 *
 * The flag is part of the documented shape of a history read function's result
 * on every adapter. A function that omits it reports every source tombstone as
 * a mismatch against a write, which is the honest outcome — the destination not
 * having deleted and the read function not saying so are indistinguishable from
 * here, and neither is a match.
 *
 * Both kinds are rendered with a marker when the value is empty, because that
 * is precisely the mismatch this comparator exists to catch: `expected
 * <delete>, got <empty>` says the source removed the key and the destination
 * holds an empty value there, where two blanks would say nothing at all.
 */
function withDeleteFlag<T>(
  cmp: SequenceComparator<T>,
): SequenceComparator<HistoryElement<T>> {
  return {
    equal: (expected, actual) =>
      expected.isDelete === actual.isDelete &&
      cmp.equal(expected.value, actual.value),
    render: (el) => {
      const rendered = cmp.render(el.value);
      if (el.isDelete) return rendered ? `<delete> ${rendered}` : '<delete>';
      return rendered === '' ? '<empty>' : rendered;
    },
  };
}

/** A third-party read function's history, whose JSON can only carry text. */
const TEXT_SEQUENCE = withDeleteFlag<string>({
  equal: jsonEqualIgnoringOverlay,
  render: (value) => value,
});

/** The migration contract's history, decoded from base64 to bytes. */
const BYTES_SEQUENCE = withDeleteFlag<Buffer>({
  equal: bytesEqual,
  render: renderValueBytes,
});

/** PostgreSQL and DynamoDB history, stored with an encoding marker. */
const STORED_SEQUENCE = withDeleteFlag<StoredValue>({
  equal: storedEqual,
  render: renderStored,
});

// ── Destination value shapes ──

/**
 * A value as a destination store holds it.
 *
 * Verification compares what the replay adapter *would have written* against
 * what is actually there, because both destinations transform the value on the
 * way in: PostgreSQL renormalises JSONB, and either store may hold base64 for
 * a value that is not UTF-8 text.
 */
interface StoredValue {
  /** `null` when `rendered` is the literal value, else its encoding marker. */
  encoding: string | null;
  /** The stored text: a JSONB document for PostgreSQL, the raw string for DynamoDB. */
  rendered: string;
}

/** What the PostgreSQL adapter writes for a record. */
function pgStored(record: EncodedValue): StoredValue {
  const v = toColumnValue(record);
  return { encoding: v.encoding, rendered: toJsonbLiteral(v) ?? '' };
}

/** What the DynamoDB adapter writes for a record. */
function dynamoStored(record: EncodedValue): StoredValue {
  const v = toColumnValue(record);
  return { encoding: v.encoding, rendered: v.value };
}

/** A `fabric_state` or `fabric_history` row read back for comparison. */
function storedFromRow(row: {
  value?: string | null;
  value_encoding?: string | null;
}): StoredValue {
  return { encoding: row.value_encoding ?? null, rendered: row.value ?? '' };
}

/** A DynamoDB item read back for comparison. */
function storedFromItem(item: Record<string, any>): StoredValue {
  return {
    encoding: (item.valueEncoding as string | null) ?? null,
    rendered: (item.value as string) ?? '',
  };
}

/**
 * Compare a stored value against the one the adapter would have written.
 *
 * The encoding marker is part of the value: without it a reader cannot tell
 * base64 from text, so a value stored under the wrong marker is corrupt even
 * when its characters match.
 */
function storedEqual(expected: StoredValue, actual: StoredValue): boolean {
  return (
    expected.encoding === actual.encoding &&
    jsonEqual(expected.rendered, actual.rendered)
  );
}

function renderStored(value: StoredValue): string {
  return value.encoding ? `${value.encoding}:${value.rendered}` : value.rendered;
}

function compareStored(
  base: SkipBase,
  expected: StoredValue,
  actual: StoredValue,
): VerifyEntry {
  if (storedEqual(expected, actual)) return { ...base, status: 'match' };
  return {
    ...base,
    status: 'mismatch',
    detail:
      `expected ${shownValue(renderStored(expected))}, ` +
      `got ${shownValue(renderStored(actual))}`,
  };
}

// ── Shared helpers ──

/**
 * Compare a chaincode read against the extracted value.
 *
 * @param base Entry fields identifying the key under test.
 * @param record Extracted record carrying the expected value.
 * @param resultBytes Raw payload returned by the destination contract.
 * @param encoded Whether the payload is the migration contract's base64.
 */
function compareChaincodeValue(
  base: SkipBase,
  record: EncodedValue,
  resultBytes: Uint8Array,
  encoded: boolean,
): VerifyEntry {
  const asText = isTextValue(record);
  const expected = decodeLedgerValue(record);
  const actual = encoded
    ? decodeContractPayload(Buffer.from(resultBytes).toString('utf-8'))
    : Buffer.from(resultBytes);

  if (bytesEqual(expected, actual)) return { ...base, status: 'match' };

  return {
    ...base,
    status: 'mismatch',
    detail:
      `expected ${shownValue(renderBytes(expected, asText))}, ` +
      `got ${shownValue(renderBytes(actual, asText))}`,
  };
}

/**
 * Whether a chaincode read matches the extracted value.
 *
 * The comparison is on bytes, because that is what a ledger holds. Values that
 * are text additionally get a JSON comparison, so that key reordering and a
 * `migrationMeta` overlay left by `embedSourceMetadata` replay do not read as
 * corruption. Binary values get no such latitude: there is no formatting for
 * them to differ by, so any difference is a difference.
 */
function bytesEqual(expected: Buffer, actual: Buffer): boolean {
  if (expected.equals(actual)) return true;
  if (!isTextValue(encodeLedgerValue(expected))) return false;
  return jsonEqualIgnoringOverlay(
    expected.toString('utf-8'), actual.toString('utf-8'),
  );
}

/**
 * Strict base64: the alphabet, correct padding, length a multiple of four.
 *
 * `Buffer.from(s, 'base64')` is lenient — it discards characters outside the
 * alphabet and decodes whatever is left — so a payload has to be checked
 * before it is decoded rather than after.
 */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode a payload returned by the migration contract's read functions.
 *
 * They return base64 (`sample/chaincode/migration_contract/README.md`). A
 * payload that is not base64 means the contract answering under that name does
 * not implement the wire contract — a stale deployment, or the customer's own
 * contract registered under the migration contract's name. Decoding it anyway
 * would produce bytes nothing wrote and report a mismatch that blames the
 * destination ledger for the misconfiguration.
 */
function decodeContractPayload(payload: string): Buffer {
  if (!BASE64.test(payload)) {
    throw new Error(
      `read function returned ${shownValue(payload)}, which is not base64. ` +
      'The migration contract returns base64 from ReadState, ' +
      'ReadPrivateData, ReadPrivateDataHash and GetKeyHistory — see ' +
      'sample/chaincode/migration_contract/README.md. If this is your own ' +
      "application's read function, name its contract explicitly as " +
      "'YourContract:YourFunction' so its result is read as raw bytes.",
    );
  }
  return Buffer.from(payload, 'base64');
}

/**
 * Render value bytes for a mismatch detail, classified by their own content.
 *
 * Used where the two sides of a comparison may differ in kind, so that a text
 * value stays legible next to a binary one instead of both being forced into
 * whichever form the expected value took.
 */
function renderValueBytes(bytes: Buffer): string {
  return renderBytes(bytes, isTextValue(encodeLedgerValue(bytes)));
}

/**
 * Render value bytes for a mismatch detail.
 *
 * Both sides of a comparison are rendered the same way, so that a binary
 * value's mismatch is legible as base64 rather than as mojibake.
 */
function renderBytes(bytes: Buffer, asText: boolean): string {
  return asText
    ? bytes.toString('utf-8')
    : `base64:${bytes.toString('base64')}`;
}

/**
 * Compare two values as JSON: parse both, re-serialize with sorted keys, and
 * compare. Falls back to string equality if either is not valid JSON.
 */
function jsonEqual(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return (
      sortedStringify(JSON.parse(a)) === sortedStringify(JSON.parse(b))
    );
  } catch {
    return false;
  }
}

/**
 * `jsonEqual`, additionally tolerating the `migrationMeta` overlay that
 * `embedSourceMetadata` adds. Only chaincode replay writes that overlay, so
 * only chaincode verification strips it — stripping it elsewhere would hide a
 * genuine difference in a source value that has a `migrationMeta` field of
 * its own.
 */
function jsonEqualIgnoringOverlay(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return (
      sortedStringify(stripMigrationOverlay(JSON.parse(a))) ===
      sortedStringify(stripMigrationOverlay(JSON.parse(b)))
    );
  } catch {
    return false;
  }
}

/**
 * Remove the overlay that `embedSourceMetadata` adds during replay:
 *   - Merged shape: `{ ...fields, migrationMeta }` → drop `migrationMeta`
 *   - Envelope shape: `{ migrationMeta, value }` → unwrap `value`,
 *     re-parsing if it was stringified JSON.
 */
function stripMigrationOverlay(value: any): any {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  if (!('migrationMeta' in value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 2 && keys.includes('value')) {
    const inner = value.value;
    if (typeof inner === 'string') {
      try {
        return JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    return inner;
  }

  const { migrationMeta: _drop, ...rest } = value;
  return rest;
}

function sortedStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(sortedStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${sortedStringify(obj[k])}`,
      )
      .join(',') +
    '}'
  );
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * The destination's state database, which decides the order a history read returns.
 *
 * Defaults to the source peer's, which is a guess about the destination. A merge of members whose peers ran
 * different state databases has no single source value to guess from, so the config must name it.
 */
export function destinationStateDbFor(
  configured: 'CouchDB' | 'LevelDB' | undefined,
  manifest: Manifest,
): 'CouchDB' | 'LevelDB' {
  if (configured) return configured;
  const sourceDbs = new Set((manifest.mergedFrom ?? []).map((m) => m.stateDb).filter(Boolean));
  if (sourceDbs.size > 1) {
    throw new Error(
      'The merged extraction comes from peers with different state databases (' +
        [...sourceDbs].join(', ') +
        '): set chaincode.destinationStateDb to the destination peers\' state database',
    );
  }
  return manifest.stateDb ?? 'LevelDB';
}
