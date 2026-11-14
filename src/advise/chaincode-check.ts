import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CollectionIdentity, Manifest, ReplayConfig } from '../types';
import { Finding, FindingLevel } from './replay-advisor';

/**
 * Static readiness check of one chaincode's source for a migration
 * destination — the parts of the destination chaincode checklist
 * (docs/migration-overview.md#destination-chaincode-checklist) that can be
 * read off the source tree before anything is packaged or approved:
 *
 *   - the name is the source's (a chaincode name is its state namespace);
 *   - the migration contract is present, unmodified from this toolkit's
 *     revision apart from its writer list, and registered;
 *   - the writer list names every MSP the replay config submits as;
 *   - the dependencies the contract needs are declared;
 *   - the collection config declares every collection with data, names
 *     destination MSPs rather than source ones, does not purge during the
 *     migration, and carries its own endorsement policy under a multi-org
 *     chaincode policy;
 *   - CouchDB indexes are packaged where the source used CouchDB.
 *
 * It does not compile, deploy or run anything; replay's own pre-flights and
 * the endorsement probe check the deployed result.
 */

export type Language = 'go' | 'node' | 'java';

export interface ChaincodeCheckOptions {
  sourceDir: string;
  /** The chaincode's name as the source network has it committed. */
  name: string;
  manifest?: Manifest;
  config?: ReplayConfig;
  collectionsConfig?: string[];
  /** The destination chaincode-level endorsement policy kind. */
  endorsement?: 'or' | 'majority' | 'and';
}

export interface ChaincodeCheck {
  chaincode: string;
  language?: Language;
  deployedOn: string[];
  contractFile?: string;
  writers?: string[];
  collectionsFiles: string[];
  findings: Finding[];
}

const SHIPPED: Record<Language, string> = {
  go: 'go/migration.go',
  node: 'node/migration.js',
  java: 'java/MigrationContract.java',
};

/** Recognises the migration contract's defining line in each language. */
const DEFINES: Record<Language, RegExp> = {
  go: /^type\s+MigrationContract\s+struct\b/m,
  node: /class\s+MigrationContract\s+extends\s+Contract\b/,
  java: /class\s+MigrationContract\s+implements\s+ContractInterface\b|@Contract\s*\(\s*name\s*=\s*"MigrationContract"/,
};

/** The one line a deployment is meant to edit. */
const WRITER_LINE: Record<Language, RegExp> = {
  go: /^var writerMSPIDs = \[\]string\{(.*)\}\s*$/m,
  node: /^const WRITER_MSP_IDS = \[(.*)\];\s*$/m,
  java: /^(\s*)private static final List<String> WRITER_MSP_IDS = List\.of\((.*)\);\s*$/m,
};

const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'build', 'target', 'dist', '.gradle']);

function walk(dir: string, depth: number, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIRS.has(e.name)) walk(full, depth - 1, out); }
    else out.push(full);
  }
  return out;
}

function detectLanguage(dir: string): Language | undefined {
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (['build.gradle', 'build.gradle.kts', 'pom.xml'].some((f) => fs.existsSync(path.join(dir, f)))) return 'java';
  return undefined;
}

/** Contract text with the writer list and Go package line normalised away. */
function normalisedContract(text: string, lang: Language): string {
  let t = text.replace(/\r\n/g, '\n').replace(WRITER_LINE[lang], '<<WRITERS>>');
  if (lang === 'go') t = t.replace(/^package\s+\w+/m, 'package <<PKG>>');
  if (lang === 'java') t = t.replace(/^package\s+[\w.]+;/m, 'package <<PKG>>;');
  return t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
}

function writersOf(text: string, lang: Language): string[] | null {
  const m = text.match(WRITER_LINE[lang]);
  if (!m) return null;
  const list = lang === 'java' ? m[2] : m[1];
  return [...list.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]).filter((x) => x.length > 0);
}

/** MSPs a replay with this config submits as. */
function submittingMsps(cc: NonNullable<ReplayConfig['chaincode']>): string[] {
  const out = new Set<string>([cc.mspId]);
  for (const m of Object.keys(cc.orgIdentities ?? {})) out.add(m);
  const fromEntry = (e: CollectionIdentity | string) => (typeof e === 'string' ? e : e.mspId);
  for (const e of Object.values(cc.collectionIdentities ?? {})) out.add(fromEntry(e));
  for (const ch of Object.values(cc.channelCollectionIdentities ?? {})) for (const e of Object.values(ch)) out.add(fromEntry(e));
  return [...out].filter(Boolean);
}

/** Every MSP that exists at the destination, as far as the config says. */
function destinationMsps(cc: NonNullable<ReplayConfig['chaincode']>): Set<string> {
  return new Set([...submittingMsps(cc), ...Object.values(cc.mspMapping ?? {})]);
}

function looksLikeCollectionsConfig(file: string): boolean {
  if (!file.endsWith('.json')) return false;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof c.name === 'string' && typeof c.policy === 'string');
  } catch { return false; }
}

function policyMsps(policy: string): string[] {
  return [...new Set([...policy.matchAll(/'([^'.]+)\.(member|peer|admin|client)'/g)].map((m) => m[1]))];
}

export function checkChaincode(opts: ChaincodeCheckOptions): ChaincodeCheck {
  const findings: Finding[] = [];
  const add = (level: FindingLevel, id: string, message: string) => findings.push({ level, id, message });
  const dir = path.resolve(opts.sourceDir);
  const cc = opts.config?.chaincode;
  const result: ChaincodeCheck = { chaincode: opts.name, deployedOn: [], collectionsFiles: [], findings };

  if (!fs.existsSync(dir)) { add('error', 'no-source', `${dir} does not exist`); return result; }

  // ── Name ──
  const deployments = (opts.manifest?.channels ?? []).flatMap((ch) =>
    ch.chaincodes.filter((c) => c.name === opts.name).map((c) => ({ channelId: ch.channelId, info: c })));
  result.deployedOn = deployments.map((d) => d.channelId);
  if (opts.manifest && deployments.length === 0) {
    const names = [...new Set(opts.manifest.channels.flatMap((c) => c.chaincodes.map((x) => x.name)))];
    add('error', 'name', `No chaincode named ${opts.name} in the source manifest (it has: ${names.join(', ') || 'none'}). The destination must commit it under the source name — the name is its state namespace and nothing renames it.`);
  } else if (opts.manifest) {
    add('info', 'name', `${opts.name} is on ${result.deployedOn.join(', ')} at the source; commit it under this exact name on each of their destination channels.`);
  }

  // ── Language and contract file ──
  const lang = detectLanguage(dir);
  result.language = lang;
  if (!lang) { add('error', 'language', 'No go.mod, package.json, build.gradle or pom.xml at the top of the source directory; cannot tell its language.'); return result; }

  const files = walk(dir, 6);
  const ext = lang === 'go' ? '.go' : lang === 'node' ? '.js' : '.java';
  const sources = files.filter((f) => f.endsWith(ext) || (lang === 'node' && f.endsWith('.ts')));
  const contract = sources.find((f) => DEFINES[lang].test(fs.readFileSync(f, 'utf-8')));
  if (!contract) {
    add('error', 'contract-missing', `No migration contract in the source. Copy sample/chaincode/migration_contract/${SHIPPED[lang]} into the package and register it (docs/migration-overview.md#migration-contract-setup).`);
  } else {
    result.contractFile = path.relative(dir, contract);
    const text = fs.readFileSync(contract, 'utf-8');
    const shippedPath = path.resolve(__dirname, '..', '..', 'sample', 'chaincode', 'migration_contract', SHIPPED[lang]);
    if (fs.existsSync(shippedPath)) {
      const a = crypto.createHash('sha256').update(normalisedContract(text, lang)).digest('hex');
      const b = crypto.createHash('sha256').update(normalisedContract(fs.readFileSync(shippedPath, 'utf-8'), lang)).digest('hex');
      if (a !== b) {
        add('warn', 'contract-revision', `${result.contractFile} differs from this toolkit's ${SHIPPED[lang]} beyond its writer list: an older revision or a local edit. Replay and verify call it by name and wire format; recopy it from the same toolkit revision that will run replay.`);
      } else {
        add('info', 'contract-revision', `${result.contractFile} matches this toolkit's migration contract.`);
      }
    }

    // ── Writer list ──
    const writers = writersOf(text, lang);
    result.writers = writers ?? undefined;
    if (writers === null) {
      add('error', 'writers-unreadable', `Cannot find the writer list line in ${result.contractFile}; it must keep the shipped form so it can be checked.`);
    } else if (writers.length === 0) {
      add('error', 'writers-empty', 'The writer list is empty, so the contract refuses every write. Name every MSP the replay submits as.');
    } else if (cc) {
      const need = submittingMsps(cc);
      const missing = need.filter((m) => !writers.includes(m));
      if (missing.length) add('error', 'writers-missing', `The writer list (${writers.join(', ')}) does not name ${missing.join(', ')}, which the replay config submits as: every write as ${missing.join(', ')} would be refused.`);
      const sourceMsps = Object.keys(cc.mspMapping ?? {});
      const stale = writers.filter((w) => sourceMsps.includes(w));
      if (stale.length) add('warn', 'writers-source', `The writer list names source MSP(s) ${stale.join(', ')}; the destination's MSP IDs are the mspMapping values.`);
      const extra = writers.filter((w) => !need.includes(w) && !stale.includes(w));
      if (extra.length) add('info', 'writers-extra', `The writer list also admits ${extra.join(', ')}, which this config never submits as. Fine if intended; every name there can write arbitrary keys until cutover removes the contract.`);
    } else {
      add('info', 'writers', `Writers: ${writers.join(', ')}. Pass --config to check them against the MSPs the replay submits as.`);
    }

    // ── Registration ──
    const others = sources.filter((f) => f !== contract).map((f) => fs.readFileSync(f, 'utf-8'));
    if (lang === 'go') {
      if (!others.some((t) => /NewChaincode\s*\(/.test(t) && /MigrationContract\s*\{/.test(t))) {
        add('error', 'not-registered', 'MigrationContract is not passed to contractapi.NewChaincode in main(); the peer would not expose it.');
      }
    } else if (lang === 'node') {
      if (!others.some((t) => /contracts/.test(t) && /MigrationContract/.test(t))) {
        add('error', 'not-registered', 'MigrationContract is not in the exported contracts list (module.exports.contracts = [YourContract, MigrationContract]).');
      }
    } else {
      add('info', 'registration', 'Java discovers @Contract classes by classpath scan: confirm MigrationContract is in a scanned package of the built JAR.');
    }
  }

  // ── Dependencies ──
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { return ''; } };
  if (lang === 'go') {
    const gomod = read('go.mod');
    if (!/github\.com\/hyperledger\/fabric-contract-api-go\s+v1\./.test(gomod)) {
      add(/fabric-contract-api-go\/v2/.test(gomod) ? 'error' : 'warn', 'go-dependency',
        'go.mod does not require fabric-contract-api-go v1. The migration contract imports github.com/hyperledger/fabric-contract-api-go/contractapi (v1); v2 publishes /v2/contractapi and will not resolve.');
    }
    if (fs.existsSync(path.join(dir, 'vendor')) && !fs.existsSync(path.join(dir, 'vendor', 'github.com', 'hyperledger', 'fabric-contract-api-go'))) {
      add('warn', 'go-vendor', 'The package vendors dependencies but vendor/ has no fabric-contract-api-go; run go mod vendor after adding the contract.');
    }
  } else if (lang === 'node') {
    let pkg: any = {};
    try { pkg = JSON.parse(read('package.json')); } catch { /* reported below */ }
    if (!{ ...pkg.dependencies }['fabric-contract-api']) add('error', 'node-dependency', 'package.json does not depend on fabric-contract-api.');
  } else {
    const build = read('build.gradle') + read('build.gradle.kts') + read('pom.xml');
    for (const [dep, why] of [['gson', 'com.google.gson.Gson'], ['fabric-protos', 'QueryResponseMetadata']]) {
      if (!build.includes(dep)) add('error', 'java-dependency', `The build declares no ${dep}; the migration contract needs it on the compile path (${why}), and fabric-chaincode-shim's dependencies are runtime-scoped.`);
    }
  }

  // ── Collections ──
  const configs = (opts.collectionsConfig ?? []).length
    ? (opts.collectionsConfig ?? []).map((f) => path.resolve(f))
    : walk(dir, 2).filter(looksLikeCollectionsConfig);
  result.collectionsFiles = configs.map((f) => path.relative(dir, f) || f);
  const declared = new Map<string, any>();
  for (const f of configs) {
    try { for (const c of JSON.parse(fs.readFileSync(f, 'utf-8'))) declared.set(c.name, c); } catch (e) {
      add('error', 'collections-unreadable', `${f}: ${(e as Error).message}`);
    }
  }
  const sourceCollections = [...new Map(deployments.flatMap((d) => d.info.collections.filter((c) => !c.implicit)).map((c) => [c.name, c])).values()];
  const mapping = cc?.collectionMapping ?? {};
  if (sourceCollections.length && configs.length === 0) {
    add('error', 'collections-missing', `The source declares ${sourceCollections.length} collection(s) (${sourceCollections.map((c) => c.name).join(', ')}) but no collection config was found. Pass --collections-config with the file the destination will commit.`);
  }
  for (const c of sourceCollections) {
    const dest = mapping[c.name] || c.name;
    if (configs.length && !declared.has(dest)) {
      add('error', 'collection-undeclared', `Source collection ${c.name}${dest !== c.name ? ` (mapped to ${dest})` : ''} is not in the destination collection config; its private data has nowhere to go.`);
    }
  }
  const destMsps = cc ? destinationMsps(cc) : null;
  const sourceMsps = new Set([...Object.keys(cc?.mspMapping ?? {}), ...(opts.manifest ? [opts.manifest.memberId, ...(opts.manifest.mergedFrom ?? []).map((m) => m.mspId ?? m.memberId)] : [])].filter(Boolean) as string[]);
  for (const [name, c] of declared) {
    const msps = policyMsps(c.policy);
    if (msps.length === 0) {
      add('error', 'collection-policy', `${name}: policy ${c.policy} names no MSP — an unrendered template placeholder? Render it for the destination's MSPs.`);
      continue;
    }
    const src = msps.filter((m) => sourceMsps.has(m) && !(destMsps?.has(m)));
    if (src.length) add('error', 'collection-source-msp', `${name}: policy still names source MSP(s) ${src.join(', ')}. Rewrite it for the destination's MSP IDs (${[...(destMsps ?? [])].join(', ') || 'see mspMapping'}).`);
    if (destMsps && destMsps.size) {
      const unknown = msps.filter((m) => !destMsps.has(m) && !src.includes(m));
      if (unknown.length) add('warn', 'collection-unknown-msp', `${name}: policy names ${unknown.join(', ')}, which the replay config does not mention. Fabric commits a policy naming an unknown MSP and then rejects every write to it.`);
    }
    if (Number(c.blockToLive) > 0) add('warn', 'collection-purges', `${name}: blockToLive ${c.blockToLive}. Commit it with 0 for the migration and restore ${c.blockToLive} at cutover, or the destination purges replayed values before verify reads them.`);
    if (opts.endorsement && opts.endorsement !== 'or' && !c.endorsementPolicy) {
      add('error', 'collection-endorsement', `${name}: no endorsementPolicy of its own under a ${opts.endorsement} chaincode policy. A collection whose members cannot meet the chaincode policy alone cannot be written through the Gateway at all; give it one naming its members (${msps.join(', ')}).`);
    }
    if (c.memberOnlyWrite && cc && msps.length && !submittingMsps(cc).some((m) => msps.includes(m)) && !cc.ownerEndorsement) {
      add('warn', 'collection-writer', `${name}: memberOnlyWrite, and no MSP the replay submits as is in its policy (${msps.join(', ')}). Add an identity for one of them (collectionIdentities or channelCollectionIdentities).`);
    }
  }

  // ── CouchDB indexes ──
  if (opts.manifest?.stateDb === 'CouchDB') {
    const idx = path.join(dir, 'META-INF', 'statedb', 'couchdb', 'indexes');
    if (!fs.existsSync(idx)) add('warn', 'couchdb-indexes', 'The source ran CouchDB but the package has no META-INF/statedb/couchdb/indexes. If the application uses rich queries, package the same indexes or they run unindexed at the destination.');
    else add('info', 'couchdb-indexes', `${fs.readdirSync(idx).length} CouchDB index file(s) packaged.`);
  }

  result.findings = [...findings.filter((f) => f.level === 'error'), ...findings.filter((f) => f.level === 'warn'), ...findings.filter((f) => f.level === 'info')];
  return result;
}

export function formatChaincodeCheck(r: ChaincodeCheck): string {
  const errors = r.findings.filter((f) => f.level === 'error').length;
  const lines = [
    `Chaincode ${r.chaincode} (${r.language ?? 'unknown language'})${r.deployedOn.length ? `, source channels: ${r.deployedOn.join(', ')}` : ''}`,
    `  contract: ${r.contractFile ?? 'not found'}${r.writers ? `; writers: ${r.writers.join(', ') || '(empty)'}` : ''}`,
    `  collection config: ${r.collectionsFiles.join(', ') || 'none found'}`,
    '',
    ...r.findings.map((f) => `[${f.level.toUpperCase()}] ${f.id}: ${f.message}`),
    '',
    errors ? `NOT READY: ${errors} error(s).` : 'Ready as far as the source can show; replay\'s pre-flights check the deployed chaincode.',
  ];
  return lines.join('\n');
}
