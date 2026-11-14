import { Interface } from 'readline/promises';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChannelFunctionMap,
  Manifest,
  OrgIdentity,
  REPLAY_ADAPTERS,
  ReplayConfig,
} from '../types';
import { implicitCollectionOwner } from '../replay/collection-routing';
import {
  DEFAULT_MIGRATION_CONTRACT,
  countFunctions,
  parseQualifiedFunction,
} from '../replay/function-mapping';
import { createLogger } from '../utils/logger';

const logger = createLogger('cli:replay-config');

/** Migration contract functions every generated config points replay at. */
const DEFAULT_WRITE = 'PutState';
const DEFAULT_DELETE = 'DeleteState';

/** Migration contract functions every generated config points verify at. */
const DEFAULT_READ = 'MigrationContract:ReadState';
const DEFAULT_PRIVATE_READ = 'MigrationContract:ReadPrivateData';
const DEFAULT_HISTORY_READ = 'MigrationContract:GetKeyHistory';

// ── Public API ──

export async function promptReplayConfig(
  rl: Interface,
  outputDir: string,
  region: string,
  manifest: Manifest,
): Promise<ReplayConfig> {
  const adapterIdx = await choose(rl, 'Replay adapter', REPLAY_ADAPTERS);
  const adapter = REPLAY_ADAPTERS[adapterIdx];

  const config: ReplayConfig = {
    adapter,
    inputDir: outputDir,
  };

  if (adapter === 'postgresql') {
    config.postgresql = await promptPostgresql(rl);
  } else if (adapter === 'dynamodb') {
    config.dynamodb = await promptDynamodb(rl, region);
  } else {
    config.chaincode = await promptChaincode(rl, manifest);
  }

  return config;
}

// ── Adapter-specific prompts ──

async function promptPostgresql(
  rl: Interface,
): Promise<NonNullable<ReplayConfig['postgresql']>> {
  return {
    connectionString: await ask(
      rl,
      'PostgreSQL connection string' +
      ' (e.g. postgresql://user:pass@host:5432/db?sslmode=verify-full)',
    ),
  };
}

async function promptDynamodb(
  rl: Interface,
  region: string,
): Promise<NonNullable<ReplayConfig['dynamodb']>> {
  const dynamoRegion = await ask(
    rl, `DynamoDB region [${region}]`, region,
  );
  const stateTable = await ask(rl, 'State table name');
  const historyTable =
    (await ask(rl, 'History table name (optional)')) ||
    undefined;
  const metadataTable =
    (await ask(rl, 'Metadata table name (optional)')) ||
    undefined;
  const identityTable =
    (await ask(rl, 'Identity table name (optional)')) ||
    undefined;
  const privateHashTable =
    (await ask(
      rl, 'Private hash table name (optional)',
    )) || undefined;
  const endpoint =
    (await ask(
      rl, 'Endpoint override (optional, for local dev)',
    )) || undefined;

  return {
    region: dynamoRegion,
    stateTable,
    historyTable,
    metadataTable,
    identityTable,
    privateHashTable,
    endpoint,
  };
}

/**
 * Tell the operator the destination contract has to name this MSP.
 *
 * The migration contract ships with an empty writer list and refuses every
 * write, so a config this wizard generated is still one failed run away from
 * replaying anything. The refusal arrives per key from the destination peer,
 * which is a long way from the file that has to change.
 */
function printWriterListReminder(mspIds: string[]): void {
  console.log(
    '\n  Before replay: the destination chaincode\'s migration contract has' +
    `\n  to name ${mspIds.join(', ')} in its writer list — writerMSPIDs in Go,` +
    '\n  WRITER_MSP_IDS in Node.js and Java. It ships empty and refuses' +
    '\n  every write. Add each collectionIdentities MSP there as well.',
  );
}

async function promptChaincode(
  rl: Interface,
  manifest: Manifest,
): Promise<NonNullable<ReplayConfig['chaincode']>> {
  const connectionProfilePath = await ask(
    rl, 'Connection profile path',
  );
  const mspId = await ask(rl, 'MSP ID');
  const certPath = await ask(rl, 'Certificate path');
  const rawKeyPath = await ask(
    rl, 'Private key path (file or keystore directory)',
  );
  const keyPath = resolveKeyPath(rawKeyPath);

  const channelResult = await promptChannelMapping(
    rl, manifest,
  );
  const { mspMapping, orgIdentities } = await promptOrgRouting(
    rl, manifest, { mspId, connectionProfilePath },
  );
  const concurrency = await askNumber(
    rl, 'Concurrency [4]', 1, 100, 4,
  );
  const { keyMapping, deleteMapping } = await promptKeyMapping(rl, manifest);
  const {
    readFunctions, privateReadFunctions, historyReadFunctions,
  } = await promptReadFunctions(rl, manifest);

  const replayHistoryAnswer = await ask(
    rl,
    'Replay Tier 3 history (full write history per key)? [y/N]',
    'N',
  );
  const replayHistory = isYes(replayHistoryAnswer);

  const destinationStateDb = manifest.stateDb ?? 'LevelDB';

  printWriterListReminder([mspId, ...Object.keys(orgIdentities ?? {})]);

  return {
    connectionProfilePath,
    mspId,
    certPath,
    keyPath,
    ...channelResult,
    mspMapping,
    orgIdentities,
    keyMapping,
    deleteMapping,
    concurrency,
    replayHistory: replayHistory || undefined,
    destinationStateDb,
    readFunctions: countFunctions(readFunctions) > 0
      ? readFunctions : undefined,
    privateReadFunctions:
      countFunctions(privateReadFunctions) > 0
        ? privateReadFunctions : undefined,
    historyReadFunctions:
      countFunctions(historyReadFunctions) > 0
        ? historyReadFunctions : undefined,
  };
}

// ── Channel mapping ──

async function promptChannelMapping(
  rl: Interface,
  manifest: Manifest,
): Promise<
  { channel: string } | { channelMapping: Record<string, string> }
> {
  const sourceChannels = manifest.channels.map(
    (c) => c.channelId,
  );

  console.log(
    '\n  Default channel mapping (source → destination):',
  );
  for (const ch of sourceChannels) {
    console.log(`    ${ch} → ${ch}`);
  }

  const useDefault = await ask(
    rl, 'Use this channel mapping? [Y/n]', 'Y',
  );

  if (sourceChannels.length === 1) {
    if (isNo(useDefault)) {
      const name = await ask(rl, 'Destination channel name');
      return { channel: name };
    }
    return { channel: sourceChannels[0] };
  }

  if (!isNo(useDefault)) {
    const mapping: Record<string, string> = {};
    for (const ch of sourceChannels) {
      mapping[ch] = ch;
    }
    return { channelMapping: mapping };
  }

  return { channelMapping: await promptDestinations(rl, sourceChannels) };
}

/**
 * Ask for a destination channel per source channel, refusing a name twice.
 *
 * Two source channels on one destination channel is a merge rather than a
 * mapping: a destination channel is one ledger, and the pair's copies of a
 * shared key overwrite each other on it. `replay` refuses such a config, so the
 * prompt does not offer to write one — the operator is asked again instead of
 * finding out at the end of a generate-then-replay round trip.
 *
 * @param rl Readline interface for the session.
 * @param sourceChannels Every channel in the manifest, in manifest order.
 * @returns Source channel → destination channel, one distinct value each.
 */
async function promptDestinations(
  rl: Interface,
  sourceChannels: string[],
): Promise<Record<string, string>> {
  const mapping: Record<string, string> = {};
  const takenBy = new Map<string, string>();

  for (const src of sourceChannels) {
    let dst = await ask(rl, `Destination for "${src}" [${src}]`, src);
    while (!dst || takenBy.has(dst)) {
      console.log(
        dst
          ? `    "${dst}" is already the destination for ` +
            `"${takenBy.get(dst)}". Both channels' data would land on one ` +
            'ledger and overwrite each other, so each needs its own.'
          : '    A destination channel name is required.',
      );
      dst = await ask(rl, `Destination for "${src}"`);
    }
    takenBy.set(dst, src);
    mapping[src] = dst;
  }

  return mapping;
}

// ── Member mapping ──

/**
 * A destination MSP per migrating member, and the credentials each destination
 * org writes its own implicit collection with.
 *
 * Asked per member rather than per collection: `_implicit_org_<MSPID>` exists
 * once per member on every chaincode, so the one fact behind every entry is
 * which destination MSP that member becomes. `mspMapping` records it once and
 * `replay` derives the collection routing from it; `orgIdentities` records each
 * destination org's credentials once, which is what lets that org write the
 * collection named after it. `replay` refuses to start while either is missing
 * for a collection carrying data, so asking here is what keeps a generated
 * config from being one refusal away from replaying anything.
 *
 * @param defaults Top-level identity: its org needs no `orgIdentities` entry,
 *   and its profile is the default for the others.
 * @returns Both maps, each omitted when empty — a manifest with no implicit
 *   collection needs neither, since a collection a chaincode declares is named
 *   the same on every network that commits that chaincode.
 */
async function promptOrgRouting(
  rl: Interface,
  manifest: Manifest,
  defaults: { mspId: string; connectionProfilePath: string },
): Promise<{
  mspMapping?: Record<string, string>;
  orgIdentities?: Record<string, OrgIdentity>;
}> {
  const members = implicitCollectionOwners(manifest);
  if (members.length === 0) return {};

  console.log(
    '\n  Default member mapping (source MSP → destination MSP). Each member\'s' +
    '\n  implicit collection is named after its MSP ID, so a destination' +
    '\n  network with different MSP IDs needs different names:',
  );
  for (const msp of members) {
    console.log(`    ${msp} → ${msp}`);
  }

  const mspMapping = isNo(await ask(rl, 'Use this member mapping? [Y/n]', 'Y'))
    ? await promptMspDestinations(rl, members)
    : Object.fromEntries(members.map((m) => [m, m]));

  const orgIdentities = await promptOrgIdentities(
    rl,
    [...new Set(Object.values(mspMapping))].filter((m) => m !== defaults.mspId),
    defaults.connectionProfilePath,
  );

  return {
    mspMapping,
    orgIdentities: Object.keys(orgIdentities).length > 0
      ? orgIdentities : undefined,
  };
}

/**
 * Ask for a destination MSP per source member, refusing an MSP twice.
 *
 * Two members on one destination MSP put both implicit collections into one
 * destination collection, where their copies of a shared key overwrite each
 * other. `replay` refuses such a config, so the operator is asked again rather
 * than finding out at the end of a generate-then-replay round trip.
 *
 * @param members Every implicit collection owner in the manifest.
 * @returns Source MSP → destination MSP, one distinct value each.
 */
async function promptMspDestinations(
  rl: Interface,
  members: string[],
): Promise<Record<string, string>> {
  const mapping: Record<string, string> = {};
  const takenBy = new Map<string, string>();

  for (const src of members) {
    let dst = await ask(rl, `Destination MSP for "${src}" [${src}]`, src);
    while (!dst || takenBy.has(dst)) {
      console.log(
        dst
          ? `    "${dst}" is already the destination for "${takenBy.get(dst)}". ` +
            'Both members\' implicit collections would become one collection, ' +
            'one keyspace within its chaincode, and overwrite each other\'s keys.'
          : '    A destination MSP ID is required.',
      );
      dst = await ask(rl, `Destination MSP for "${src}"`);
    }
    takenBy.set(dst, src);
    mapping[src] = dst;
  }

  return mapping;
}

/**
 * Credentials per destination org other than the top-level one.
 *
 * Optional per org: the operator may not hold another org's key yet, and a
 * skipped org is not silent — `replay` refuses before its first write naming
 * the implicit collection that has no identity of its owner's.
 */
async function promptOrgIdentities(
  rl: Interface,
  mspIds: string[],
  defaultProfile: string,
): Promise<Record<string, OrgIdentity>> {
  const identities: Record<string, OrgIdentity> = {};
  if (mspIds.length === 0) return identities;

  console.log(
    '\n  Each org\'s implicit collection takes writes only when that org\'s' +
    '\n  peers endorse them, so replay needs its credentials and a peer of its' +
    '\n  own — or chaincode.ownerEndorsement: true, which routes the' +
    '\n  endorsement to the owner without its credentials. Leave the' +
    '\n  certificate blank to add an org later; replay refuses until then.',
  );

  for (const mspId of mspIds) {
    const certPath = await ask(
      rl, `Certificate path for ${mspId} (blank to skip)`,
    );
    if (!certPath) continue;
    let rawKeyPath = await ask(rl, `Private key path for ${mspId}`);
    while (!rawKeyPath) {
      rawKeyPath = await ask(rl, `Private key path for ${mspId} (required)`);
    }
    const profile = await ask(
      rl,
      `Connection profile for a ${mspId} peer [${defaultProfile}]`,
      defaultProfile,
    );
    identities[mspId] = {
      certPath,
      keyPath: resolveKeyPath(rawKeyPath),
      ...(profile !== defaultProfile ? { connectionProfilePath: profile } : {}),
    };
  }

  return identities;
}

/** Every distinct implicit collection owner in the manifest, in manifest order. */
function implicitCollectionOwners(manifest: Manifest): string[] {
  return implicitCollections(manifest)
    .map((name) => implicitCollectionOwner(name) as string);
}

/** Every distinct implicit collection in the manifest, in manifest order. */
function implicitCollections(manifest: Manifest): string[] {
  const names = manifest.channels.flatMap((ch) =>
    ch.chaincodes.flatMap((cc) =>
      cc.collections
        .map((c) => c.name)
        .filter((name) => implicitCollectionOwner(name) !== null),
    ),
  );
  return [...new Set(names)];
}

// ── Chaincode key mapping ──

/**
 * The write function per deployment, and the delete function where one is needed.
 *
 * @returns `deleteMapping` only when at least one write left the migration
 *   contract; a run whose writes are all `PutState` deletes with `DeleteState`,
 *   and generating that map would be config that says nothing.
 */
async function promptKeyMapping(
  rl: Interface,
  manifest: Manifest,
): Promise<{
  keyMapping: ChannelFunctionMap;
  deleteMapping?: ChannelFunctionMap;
}> {
  const deployments = chaincodeDeployments(manifest);

  console.log(
    '\n  Default write mapping (channel/chaincode → function):',
  );
  for (const { channel, chaincode } of deployments) {
    console.log(`    ${channel}/${chaincode} → ${DEFAULT_WRITE}`);
  }

  const useDefault = !isNo(
    await ask(rl, 'Use this chaincode mapping? [Y/n]', 'Y'),
  );

  const keyMapping: ChannelFunctionMap = {};
  const deleteMapping: ChannelFunctionMap = {};

  for (const { channel, chaincode } of deployments) {
    const label = `${channel}/${chaincode}`;
    const fn = useDefault ? DEFAULT_WRITE : await ask(
      rl, `Function for "${label}" [${DEFAULT_WRITE}]`, DEFAULT_WRITE,
    );
    setFunction(keyMapping, channel, chaincode, fn);

    if (parseQualifiedFunction(fn).isMigrationContract) continue;
    setFunction(
      deleteMapping, channel, chaincode,
      await askDeleteFunction(rl, label, fn),
    );
  }

  return {
    keyMapping,
    deleteMapping:
      countFunctions(deleteMapping) > 0 ? deleteMapping : undefined,
  };
}

/**
 * Ask for the delete function beside a write function on an application contract.
 *
 * Asked only for those. A write on the migration contract pairs with the
 * migration contract's `DeleteState`, so there is nothing to decide. A write on
 * the application's own contract is usually there because it maintains something
 * besides the key — a composite-key index, a counter — and a tombstone replayed
 * as `DeleteState` removes the key without it. The pair is answered together
 * rather than left to split silently at replay time.
 *
 * @param label `channel/chaincode` the write function was given for.
 * @param writeFunction The answer that made this question necessary.
 */
async function askDeleteFunction(
  rl: Interface,
  label: string,
  writeFunction: string,
): Promise<string> {
  console.log(
    `    "${label}" writes with ${writeFunction}, so its deletes need a ` +
    'function on that contract too — otherwise they are replayed as ' +
    `${DEFAULT_MIGRATION_CONTRACT}:${DEFAULT_DELETE}, which removes the key ` +
    'and nothing else.',
  );
  return ask(
    rl, `Delete function for "${label}" [${DEFAULT_DELETE}]`, DEFAULT_DELETE,
  );
}

// ── Read functions for verification ──

/**
 * The three verify read-function maps, one entry per `(channel, chaincode)`.
 *
 * Every deployment gets an entry, and a blank answer takes the default rather
 * than omitting it: `verify` refuses to start unless every chaincode in the
 * manifest has a read function, so a config that leaves one out is a config it
 * rejects.
 */
async function promptReadFunctions(
  rl: Interface,
  manifest: Manifest,
): Promise<{
  readFunctions: ChannelFunctionMap;
  privateReadFunctions: ChannelFunctionMap;
  historyReadFunctions: ChannelFunctionMap;
}> {
  const deployments = chaincodeDeployments(manifest);

  console.log(
    '\n  Verify functions (from the migration contract):',
  );
  for (const { channel, chaincode, hasCollections } of deployments) {
    console.log(`    ${channel}/${chaincode}:`);
    console.log(`      public  → ${DEFAULT_READ}`);
    if (hasCollections) {
      console.log(`      private → ${DEFAULT_PRIVATE_READ}`);
    }
    console.log(`      history → ${DEFAULT_HISTORY_READ}`);
  }

  const useDefaults = !isNo(
    await ask(rl, 'Use these verify functions? [Y/n]', 'Y'),
  );

  const readFunctions: ChannelFunctionMap = {};
  const privateReadFunctions: ChannelFunctionMap = {};
  const historyReadFunctions: ChannelFunctionMap = {};

  for (const { channel, chaincode, hasCollections } of deployments) {
    const label = `${channel}/${chaincode}`;
    const answer = async (question: string, def: string): Promise<string> =>
      useDefaults ? def : ask(rl, `${question} for "${label}" [${def}]`, def);

    setFunction(
      readFunctions, channel, chaincode,
      await answer('Read function', DEFAULT_READ),
    );

    if (hasCollections) {
      setFunction(
        privateReadFunctions, channel, chaincode,
        await answer('Private read function', DEFAULT_PRIVATE_READ),
      );
    }

    setFunction(
      historyReadFunctions, channel, chaincode,
      await answer('History read function', DEFAULT_HISTORY_READ),
    );
  }

  return {
    readFunctions, privateReadFunctions, historyReadFunctions,
  };
}

// ── Helpers ──

/** One chaincode as deployed on one channel — the key of every function map. */
interface ChaincodeDeployment {
  channel: string;
  chaincode: string;
  /** Whether the chaincode declares a collection on this channel. */
  hasCollections: boolean;
}

/**
 * Every `(channel, chaincode)` pair in the manifest.
 *
 * Per channel rather than a set of unique names: the function maps are keyed by
 * both, so a chaincode on two channels needs an entry under each, and one that
 * declares a collection on only one of them needs `privateReadFunctions` only
 * there.
 */
function chaincodeDeployments(manifest: Manifest): ChaincodeDeployment[] {
  return manifest.channels.flatMap((ch) =>
    ch.chaincodes.map((cc) => ({
      channel: ch.channelId,
      chaincode: cc.name,
      hasCollections: cc.collections.length > 0,
    })),
  );
}

/** Record one channel's chaincode → function entry, creating the channel. */
function setFunction(
  map: ChannelFunctionMap,
  channel: string,
  chaincode: string,
  fn: string,
): void {
  const byChaincode = map[channel] ?? {};
  byChaincode[chaincode] = fn;
  map[channel] = byChaincode;
}

export function resolveKeyPath(keyPath: string): string {
  try {
    if (!fs.statSync(keyPath).isDirectory()) return keyPath;
  } catch (err) {
    logger.debug(
      { keyPath, error: (err as Error).message },
      'Could not stat key path',
    );
    return keyPath;
  }

  const skFiles = fs.readdirSync(keyPath).filter(
    (f) => f.endsWith('_sk'),
  );
  if (skFiles.length === 0) {
    throw new Error(
      `No *_sk private key file found in ${keyPath}`,
    );
  }
  if (skFiles.length > 1) {
    console.log(
      `  WARNING: ${skFiles.length} keys in ${keyPath}` +
      ` — using ${skFiles[0]}`,
    );
  }
  return path.join(keyPath, skFiles[0]);
}

function isNo(answer: string): boolean {
  const lower = answer.toLowerCase();
  return lower === 'n' || lower === 'no';
}

function isYes(answer: string): boolean {
  const lower = answer.toLowerCase();
  return lower === 'y' || lower === 'yes';
}

export async function ask(
  rl: Interface,
  question: string,
  defaultVal?: string,
): Promise<string> {
  const answer = (
    await rl.question(`  ${question}: `)
  ).trim();
  return answer || defaultVal || '';
}

export async function askNumber(
  rl: Interface,
  question: string,
  min: number,
  max: number,
  defaultVal?: number,
): Promise<number> {
  while (true) {
    const raw = (
      await rl.question(`  ${question}: `)
    ).trim();
    if (!raw && defaultVal !== undefined) return defaultVal;
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= min && n <= max) return n;
    console.log(
      `  Enter a number between ${min} and ${max}.`,
    );
  }
}

export async function choose(
  rl: Interface,
  question: string,
  items: readonly string[],
  defaultIdx?: number,
): Promise<number> {
  console.log('');
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${items[i]}`);
  }
  const def =
    defaultIdx !== undefined ? defaultIdx + 1 : 1;
  while (true) {
    const raw = (
      await rl.question(`  ${question} [${def}]: `)
    ).trim();
    if (!raw) return def - 1;
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= items.length) {
      return n - 1;
    }
    console.log(
      `  Enter a number between 1 and ${items.length}.`,
    );
  }
}

export async function chooseMultiple(
  rl: Interface,
  question: string,
  items: string[],
): Promise<string[]> {
  console.log('');
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${items[i]}`);
  }
  while (true) {
    const raw = (
      await rl.question(`  ${question}: `)
    ).trim();
    const nums = raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10));
    const valid = nums.every(
      (n) => !isNaN(n) && n >= 1 && n <= items.length,
    );
    if (valid && nums.length > 0) {
      return nums.map((n) => items[n - 1]);
    }
    console.log(
      `  Enter numbers between 1 and ${items.length},` +
      ' separated by commas.',
    );
  }
}
