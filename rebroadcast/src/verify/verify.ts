/**
 * `verify` (design §9, level L3): the whole destination, not a sample, against the facts rebuilt from the archive,
 * through the migration contract's read functions on one destination peer.
 *
 *   state     every live key: ReadState equals the source's final value
 *   deletes   every key deleted at the source: ReadState says it does not exist
 *   sweep     ListKeys per namespace equals the expected live non-composite keys (no extra, none missing)
 *   history   every key's GetKeyHistory value/delete sequence equals the source's VALID writes (either order: peers
 *             answer newest-first, which is recorded)
 *   private   every live private key, by collection. A key with a value in --private: the value agrees with the hash
 *             in the blocks, the destination's ReadPrivateDataHash equals it, and ReadPrivateData returns the value
 *             where this peer's org can read the collection (hash-only otherwise). A key with no value supplied
 *             fails the run when its collection is readable by a member in scope (the extractions supplied, and
 *             this peer's org), and is listed for the members who can read it otherwise. Keys blockToLive purged
 *             at the source are counted apart: no extraction can hold them.
 *
 * Failures name the key and hashes; values are printed only with showValues.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Facts } from './facts';
import { Endorser, QueryResult } from '../fabric/endorser';
import { sameJson, sha256 } from '../util/misc';
import { Collection, destinationDefinition } from '../tip/chaincode';


export interface PrivateRecord { chaincode: string; collection: string; key: string; value: Buffer }

/** Private values from an extraction (private-*-state.ndjson under a directory) or one ndjson file of {chaincode, collection, key, value(base64)}. */
export function loadPrivate(p: string, channel: string): PrivateRecord[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/^private-.*-state\.ndjson$/.test(e.name)) files.push(f);
    }
  };
  if (fs.statSync(p).isDirectory()) {
    const ch = path.join(p, `channel-${channel}`);
    walk(fs.existsSync(ch) ? ch : p);
  } else files.push(p);
  const out: PrivateRecord[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { _type?: string; channel?: string; chaincode: string; collection: string; key: string; value: string; valueEncoding?: string };
      if (r.channel && r.channel !== channel) continue;
      // The extractor writes UTF-8 values literally unless marked base64; other files carry base64.
      const literal = r._type === 'private_state' && r.valueEncoding !== 'base64';
      out.push({ chaincode: r.chaincode, collection: r.collection, key: r.key, value: literal ? Buffer.from(r.value, 'utf8') : Buffer.from(r.value, 'base64') });
    }
  }
  return out;
}

/** Whose private data an input holds. */
export interface PrivateInputMembers {
  /** MSP IDs of the extractions found (`extractedByMspId` in each channel's metadata.json). */
  msps: string[];
  /** A merged directory (metadata.json without a single extracting MSP): it stands for every member. */
  all: boolean;
}

/** The members whose extractions `p` holds, from the metadata.json beside their private-state files. */
export function privateInputMembers(p: string, channel: string): PrivateInputMembers {
  const out: PrivateInputMembers = { msps: [], all: false };
  if (!fs.statSync(p).isDirectory()) return out;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name !== 'metadata.json') continue;
      let m: { channelId?: string; extractedByMspId?: string };
      try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { throw new Error(`${f}: not readable as JSON (${(err as Error).message})`); }
      if (m.channelId && m.channelId !== channel) continue;
      if (m.extractedByMspId) { if (!out.msps.includes(m.extractedByMspId)) out.msps.push(m.extractedByMspId); }
      else out.all = true;
    }
  };
  walk(p);
  return out;
}

const IMPLICIT = '_implicit_org_';

/** The orgs whose peers hold a collection's plaintext; empty when the archive does not say. */
function readersOf(group: string, collections: Map<string, Collection>): string[] {
  const coll = group.slice(group.indexOf('/') + 1);
  if (coll.startsWith(IMPLICIT)) return [coll.slice(IMPLICIT.length)];
  return [...new Set(collections.get(group)?.policy.msps ?? [])];
}

export interface CollectionCheck { hash: number; value: number; bad: number; hashOnly: number; liveAtSource: number; expired: number; unchecked: number; readers: string[]; inScope: boolean; accepted: boolean }

export interface VerifyResult {
  channel: string;
  peerMsp: string;
  /** `jsonNormalized`: of `ok`, values equal only as JSON documents (re-serialised by a CouchDB state database). */
  state: { live: number; ok: number; differ: number; missing: number; jsonNormalized: number };
  deletes: { total: number; absent: number; present: number };
  sweep: { namespaces: number; listed: number; extra: number; missing: number };
  history: { keys: number; versions: number; ok: number; differ: number; order: { single: number; oldestFirst: number; newestFirst: number } };
  private?: {
    records: number; hashOk: number; hashBad: number; inputDisagrees: number; valueOk: number; valueBad: number; hashOnly: number;
    /** Live keys with no value supplied, in every collection; `uncheckedInScope` of them fail the run. */
    uncheckedLiveKeys: number; uncheckedInScope: number;
    /** Live in the blocks but past their collection's blockToLive at the archive's last block. */
    expiredAtSource: number;
    /** Members in scope: the extractions supplied, and the verifying peer's org; `all` for a merged input or none from a source org. */
    members: string[] | 'all';
    /** Member → collections with unchecked keys that only its extraction can supply. */
    toVerifyBy: Record<string, string[]>;
    accepted: string[];
    perCollection: Record<string, CollectionCheck>;
  };
  queryErrors: number;
  failures: string[];
  ok: boolean;
}

const DOES_NOT_EXIST = /does not exist/;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

export async function verify(
  facts: Facts,
  e: Endorser,
  opts: {
    channel: string; concurrency: number; priv?: PrivateRecord[]; hashOnly?: string[]; showValues?: boolean; log: (s: string) => void;
    /** The archive's collection definitions (`archiveCollections`): who can read each, and its blockToLive. */
    collections?: Map<string, Collection>;
    /** Whose extractions `priv` holds (`privateInputMembers`). */
    members?: PrivateInputMembers;
    /** The source's org MSP IDs (the descriptor's orgs): a run with none of them in scope cannot check private data. */
    sourceOrgs?: string[];
    /** Collections (name or chaincode/collection, or "all") whose unchecked keys the data owners accepted. */
    acceptUnchecked?: string[];
  },
): Promise<VerifyResult> {
  const r: VerifyResult = {
    channel: opts.channel, peerMsp: e.mspId,
    state: { live: 0, ok: 0, differ: 0, missing: 0, jsonNormalized: 0 }, deletes: { total: 0, absent: 0, present: 0 },
    sweep: { namespaces: 0, listed: 0, extra: 0, missing: 0 },
    history: { keys: 0, versions: 0, ok: 0, differ: 0, order: { single: 0, oldestFirst: 0, newestFirst: 0 } },
    queryErrors: 0, failures: [], ok: false,
  };
  const fail = (m: string): void => { if (r.failures.length < 50) r.failures.push(m); };
  const k = (ns: string, key: string): string => `${ns}/${JSON.stringify(key)}`;
  const shown = (b: Buffer): string => (opts.showValues ? JSON.stringify(b.toString('utf8')) : `sha256 ${sha256(b).slice(0, 16)}`);
  const q = async (cc: string, args: string[]): Promise<QueryResult | undefined> => {
    try { return await e.query(cc, args); } catch (err) { r.queryErrors++; fail(`QUERY ${cc} ${args[0]}: ${(err as Error).message.slice(0, 160)}`); return undefined; }
  };

  // 1–3: state, deletes, sweep
  for (const [ns, keys] of facts.state) {
    const t0 = Date.now();
    await pool([...keys], opts.concurrency, async ([key, v]) => {
      const res = await q(ns, ['MigrationContract:ReadState', key]);
      if (!res) return;
      const absent = res.status !== 200 && DOES_NOT_EXIST.test(res.message);
      if (res.status !== 200 && !absent) { r.queryErrors++; fail(`QUERY ${k(ns, key)}: ${res.status} ${res.message.slice(0, 160)}`); return; }
      if (v.isDelete) {
        r.deletes.total++;
        if (absent) r.deletes.absent++; else { r.deletes.present++; fail(`DELETED-AT-SOURCE-BUT-PRESENT ${k(ns, key)}`); }
        return;
      }
      r.state.live++;
      if (absent) { r.state.missing++; fail(`MISSING ${k(ns, key)}`); return; }
      const got = Buffer.from(res.payload.toString('utf8'), 'base64');
      if (got.equals(v.value)) r.state.ok++;
      else if (sameJson(got, v.value)) { r.state.ok++; r.state.jsonNormalized++; }
      else { r.state.differ++; fail(`STATE ${k(ns, key)}: expected ${shown(v.value)}, got ${shown(got)}`); }
    });
    const expected = new Set([...keys].filter(([key, v]) => !v.isDelete && !key.includes('\u0000')).map(([key]) => key));
    const seen = new Set<string>();
    let bookmark = '', pages = 0, listOk = true;
    do {
      const res = await q(ns, ['MigrationContract:ListKeys', '500', bookmark]);
      if (!res || res.status !== 200) { listOk = false; if (res) { r.queryErrors++; fail(`LISTKEYS ${ns}: ${res.status} ${res.message.slice(0, 160)}`); } break; }
      const page = JSON.parse(res.payload.toString('utf8')) as { keys: string[]; bookmark: string };
      for (const x of page.keys ?? []) seen.add(Buffer.from(x, 'base64').toString('utf8'));
      bookmark = page.bookmark;
      pages++;
    } while (bookmark);
    r.sweep.namespaces++;
    if (listOk) {
      r.sweep.listed += seen.size;
      for (const x of seen) if (!expected.has(x)) { r.sweep.extra++; fail(`EXTRA ${k(ns, x)}`); }
      for (const x of expected) if (!seen.has(x)) r.sweep.missing++;
    }
    opts.log(`  ${ns}: ${keys.size} keys checked in ${Math.round((Date.now() - t0) / 1000)} s; listed ${seen.size} in ${pages} pages, expected ${expected.size}`);
  }

  // 4: history
  const hk: [string, string, { value: Buffer; isDelete: boolean }[]][] = [];
  for (const [ns, keys] of facts.history) for (const [key, vs] of keys) hk.push([ns, key, vs]);
  const t1 = Date.now();
  const tok = (x: { value: Buffer; isDelete: boolean }): string => (x.isDelete ? 'DEL' : x.value.toString('base64'));
  await pool(hk, opts.concurrency, async ([ns, key, vs]) => {
    r.history.keys++;
    r.history.versions += vs.length;
    const res = await q(ns, ['MigrationContract:GetKeyHistory', key]);
    if (!res) return;
    if (res.status !== 200) { r.queryErrors++; fail(`QUERY(history) ${k(ns, key)}: ${res.status} ${res.message.slice(0, 160)}`); return; }
    const got = ((JSON.parse(res.payload.toString('utf8') || '[]') ?? []) as { value: string; isDelete: boolean }[]).map((x) => (x.isDelete ? 'DEL' : x.value));
    const exp = vs.map(tok);
    const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
    if (same(got, exp)) { r.history.ok++; if (exp.length < 2) r.history.order.single++; else r.history.order.oldestFirst++; }
    else if (same(got, [...exp].reverse())) { r.history.ok++; r.history.order.newestFirst++; }
    else { r.history.differ++; fail(`HISTORY ${k(ns, key)}: expected ${exp.length} versions, got ${got.length}`); }
  });
  opts.log(`  history: ${r.history.keys} keys / ${r.history.versions} versions checked in ${Math.round((Date.now() - t1) / 1000)} s`);

  // 5: private data
  const liveHashes = [...facts.privateHashes.values()].reduce((n, m) => n + m.size, 0);
  if (opts.priv || liveHashes) {
    const priv = opts.priv ?? [];
    const collections = opts.collections ?? new Map<string, Collection>();
    const inputMembers = opts.members ?? { msps: [], all: false };
    const scope = new Set(inputMembers.msps);
    if (opts.sourceOrgs?.includes(e.mspId)) scope.add(e.mspId);
    // With no member in scope there is nobody to hand a collection to: every collection must be checked here.
    const everyone = inputMembers.all || scope.size === 0;
    const accept = new Set(opts.acceptUnchecked ?? []);
    const p: NonNullable<VerifyResult['private']> = {
      records: 0, hashOk: 0, hashBad: 0, inputDisagrees: 0, valueOk: 0, valueBad: 0, hashOnly: 0,
      uncheckedLiveKeys: 0, uncheckedInScope: 0, expiredAtSource: 0,
      members: everyone ? 'all' : [...scope].sort(), toVerifyBy: {}, accepted: [], perCollection: {},
    };
    const coll = (g: string): CollectionCheck => {
      let pc = p.perCollection[g];
      if (!pc) {
        const name = g.slice(g.indexOf('/') + 1);
        const readers = readersOf(g, collections);
        pc = p.perCollection[g] = {
          hash: 0, value: 0, bad: 0, hashOnly: 0, liveAtSource: facts.privateHashes.get(g)?.size ?? 0, expired: 0, unchecked: 0, readers,
          inScope: everyone || readers.length === 0 || readers.some((m) => scope.has(m)),
          accepted: accept.has('all') || accept.has(name) || accept.has(g),
        };
      }
      return pc;
    };
    const known = new Map<string, Set<string>>();
    const hashOnlyColl = new Set(opts.hashOnly ?? []);
    // A collection the verifying org is not a member of (memberOnlyRead) cannot be read through its peer: check it by hash.
    const notReadable = new Set<string>();
    for (const cc of new Set(priv.map((x) => x.chaincode))) {
      const def = await destinationDefinition(e, cc).catch(() => undefined);
      for (const c of def?.collections ?? []) {
        if (c.memberOnlyRead && c.policy.msps.length && !c.policy.msps.includes(e.mspId)) notReadable.add(`${cc}/${c.name}`);
      }
    }
    await pool(priv, opts.concurrency, async (x) => {
      const g = `${x.chaincode}/${x.collection}`;
      const pc = coll(g);
      p.records++;
      const kh = sha256(x.key), vh = sha256(x.value);
      (known.get(g) ?? known.set(g, new Set()).get(g)!).add(kh);
      const expected = facts.privateHashes.get(g)?.get(kh);
      if (expected !== vh) { p.inputDisagrees++; pc.bad++; fail(`PRIVATE-INPUT ${g}/${JSON.stringify(x.key)}: ${expected ? 'the value does not hash to the hash in the blocks' : 'no live hash for this key in the blocks'}`); return; }
      const h = await q(x.chaincode, ['MigrationContract:ReadPrivateDataHash', x.collection, x.key]);
      if (!h) return;
      const got = h.status === 200 ? Buffer.from(h.payload.toString('utf8'), 'base64').toString('hex') : '';
      if (got !== expected) { p.hashBad++; pc.bad++; fail(`PRIVATE-HASH ${g}/${JSON.stringify(x.key)}: ${h.status === 200 ? 'differs' : `${h.status} ${h.message.slice(0, 120)}`}`); return; }
      p.hashOk++; pc.hash++;
      const implicitOther = x.collection.startsWith(IMPLICIT) && x.collection !== `${IMPLICIT}${e.mspId}`;
      if (implicitOther || notReadable.has(g) || hashOnlyColl.has(x.collection) || hashOnlyColl.has(g)) { p.hashOnly++; pc.hashOnly++; return; }
      const v = await q(x.chaincode, ['MigrationContract:ReadPrivateData', x.collection, x.key]);
      if (!v) return;
      if (v.status === 200 && (Buffer.from(v.payload.toString('utf8'), 'base64').equals(x.value) || sameJson(Buffer.from(v.payload.toString('utf8'), 'base64'), x.value))) { p.valueOk++; pc.value++; }
      else { p.valueBad++; pc.bad++; fail(`PRIVATE-VALUE ${g}/${JSON.stringify(x.key)}: ${v.status === 200 ? 'differs' : `${v.status} ${v.message.slice(0, 120)}`}`); }
    });

    // Every live key no input supplied. One whose blockToLive ran out by the archive's last block was purged from
    // every source peer (Fabric expires a write committed at block N with the commit of block N + blockToLive + 1),
    // so no extraction can hold it.
    for (const [g, hashes] of facts.privateHashes) {
      if (!hashes.size) continue;
      const pc = coll(g);
      const btl = collections.get(g)?.blockToLive ?? 0;
      const written = facts.privateWriteBlock.get(g);
      const seen = known.get(g);
      for (const kh of hashes.keys()) {
        if (seen?.has(kh)) continue;
        const at = written?.get(kh);
        if (btl > 0 && at !== undefined && facts.lastBlock >= at + btl + 1) { pc.expired++; p.expiredAtSource++; continue; }
        pc.unchecked++; p.uncheckedLiveKeys++;
      }
      if (!pc.unchecked) continue;
      // Scope first: a collection only other members can read stays on their list, whatever this run accepts.
      if (pc.inScope && pc.accepted) { p.accepted.push(g); continue; }
      if (pc.inScope) {
        p.uncheckedInScope += pc.unchecked;
        const who = pc.readers.length ? `readable by ${pc.readers.join(', ')}` : 'its readers are not in the archive\'s definitions';
        fail(`PRIVATE-UNCHECKED ${g}: ${pc.unchecked} live key(s) have no value in --private (${who}). Add the values from a reader whose extraction holds them (its private-${g.replace('/', '-')}-state.ndjson is enough), or --accept-unchecked ${g} if the data owners accepted the loss`);
      } else {
        for (const m of pc.readers) (p.toVerifyBy[m] ??= []).push(g);
      }
    }
    r.private = p;
  }

  r.ok = !r.queryErrors && !r.state.differ && !r.state.missing && !r.deletes.present && !r.sweep.extra && !r.sweep.missing && !r.history.differ
    && (!r.private || (!r.private.hashBad && !r.private.inputDisagrees && !r.private.valueBad && !r.private.uncheckedInScope));
  return r;
}
