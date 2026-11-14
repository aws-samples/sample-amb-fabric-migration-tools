import * as fs from 'fs';
import * as path from 'path';
import { FileLayoutManager } from '../output/file-layout-manager';
import { countNdjsonLines } from '../output/ndjson-scan';
import { measureHistoryDepth } from '../output/history-depth';
import { indexPrivateFiles } from '../output/private-file-index';
import { NdjsonReader } from '../replay/ndjson-reader';
import { implicitCollectionOwner } from '../replay/collection-routing';
import { expandCollectionMapping } from '../replay/org-routing';
import { MAX_BATCH_BYTES } from '../replay/state-batch';
import { Manifest, ReplayConfig } from '../types';

/**
 * Replay advice from the extraction itself: what to set `concurrency`,
 * `channelConcurrency`, `batchSize` and `writeBatchSize` to, how long the run
 * will take and which bound sets that, and which settings will refuse or
 * misbehave before a single write is attempted.
 *
 * Read-only, and it reports shapes — record counts, bytes, key counts, version
 * depths — never a key or a value, so its output can go to an AI assistant.
 *
 * The duration model is the one measured in the live tests
 * (docs/tuning.md, "Replay sizing"): a channel's
 * files replay one after another; within a file, a key's versions commit one
 * transaction at a time (the depth bound), and distinct keys share batch
 * transactions up to `concurrency` in flight (the volume bound); channels run
 * `channelConcurrency` at a time. With the deepest key at 4,500 versions and
 * 0.32 s per commit it predicted 24:00 for a file that took 23:45.
 */

export type FindingLevel = 'error' | 'warn' | 'info';

export interface Finding {
  level: FindingLevel;
  id: string;
  message: string;
  /** A config change that addresses it, as a dotted path and value. */
  suggest?: { path: string; value: unknown };
}

export interface FileProfile {
  /** Absolute path, for the estimate's second pass; not reported. */
  path?: string;
  kind: 'public-state' | 'public-history' | 'private-state' | 'private-history';
  file: string;
  chaincode?: string;
  collection?: string;
  records: number;
  bytes: number;
  /** History files only. */
  keys?: number;
  maxVersions?: number;
  /** Chaincode of the deepest key — never the key itself. */
  deepestChaincode?: string;
}

export interface ChannelProfile {
  channelId: string;
  ledgerHeight: number;
  files: FileProfile[];
}

export interface ChannelEstimate {
  channelId: string;
  seconds: number;
  /** The file that dominates this channel, and which bound sets it. */
  criticalFile?: string;
  bound?: 'depth' | 'volume';
}

export interface ReplayAdvice {
  profile: { tier3: boolean; channels: ChannelProfile[]; totals: { records: number; bytes: number; maxVersions: number } };
  estimate: {
    commitLatencyMs: number;
    commitLatencyMeasured: boolean;
    replayHistory: boolean;
    perChannel: ChannelEstimate[];
    totalSeconds: number;
    /** Transactions the run submits. */
    transactions: number;
    /** Records the run writes. */
    writes: number;
    /** Set when the destination's write throughput, not latency or depth, decides the total. */
    throughputBound?: boolean;
    /** True when no throughput was given: the total is then a lower bound. */
    lowerBound: boolean;
    /** With no throughput given: the total at the five-org test destination's measured rate. */
    atReferenceThroughputSeconds?: number;
    /** The same extraction and latency, with the recommended settings. */
    recommendedTotalSeconds: number;
  };
  recommended: {
    batchSize: number;
    chaincode: { concurrency: number; channelConcurrency: number; writeBatchSize: number };
    nodeOptions: string;
    verifyConcurrency: number;
  };
  findings: Finding[];
}

export interface AdviseOptions {
  inputDir: string;
  config?: ReplayConfig;
  /** Measured on a dry run; otherwise an assumption is used and says so. */
  commitLatencyMs?: number;
  /**
   * Writes (records) per second the destination sustained in a dry run, all
   * channels together. Without it the estimate assumes the destination keeps
   * up — true when one deep key dominates, not when volume does.
   */
  destinationWritesPerSecond?: number;
}

/** 200 ms block time, separate host, one AZ apart: 0.25–0.32 s measured. */
const ASSUMED_LATENCY_MS = 300;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_WRITE_BATCH_SIZE = 500;
const RECOMMENDED_BATCH_SIZE = 20000;
const RECOMMENDED_CONCURRENCY = 32;
const MAX_CHANNEL_CONCURRENCY = 8;
/** Parsed records cost several times their NDJSON bytes in V8. */
const HEAP_FACTOR = 4;
/**
 * Writes/s the five-org test destination (c6i.2xlarge, CouchDB, 200 ms
 * BatchTimeout) sustained across four channels: 185,567 records in 2:53.
 */
const REFERENCE_WRITES_PER_SECOND = 1070;

async function fileSize(p: string): Promise<number> {
  try { return (await fs.promises.stat(p)).size; } catch { return 0; }
}

async function profileFile(
  full: string,
  kind: FileProfile['kind'],
  extra: Partial<FileProfile>,
): Promise<FileProfile | null> {
  if (!fs.existsSync(full)) return null;
  const bytes = await fileSize(full);
  if (kind.endsWith('history')) {
    const d = await measureHistoryDepth(full);
    if (d.versions === 0) return null;
    return {
      path: full, kind, file: path.basename(full), records: d.versions, bytes, keys: d.keys,
      maxVersions: d.maxVersions, deepestChaincode: d.deepestKey.split('/')[0], ...extra,
    };
  }
  const records = await countNdjsonLines(full);
  if (records === 0) return null;
  return { path: full, kind, file: path.basename(full), records, bytes, ...extra };
}

/** Profile every replayable file of every channel. */
export async function profileExtraction(inputDir: string): Promise<{ manifest: Manifest; channels: ChannelProfile[] }> {
  const layout = new FileLayoutManager(inputDir);
  if (!fs.existsSync(layout.manifestPath)) throw new Error(`No manifest.json in ${inputDir}`);
  const manifest: Manifest = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf-8'));
  const reader = new NdjsonReader();
  const channels: ChannelProfile[] = [];

  for (const ch of manifest.channels) {
    const id = ch.channelId;
    const files: FileProfile[] = [];
    const add = (f: FileProfile | null) => { if (f) files.push(f); };
    add(await profileFile(path.join(inputDir, layout.publicStatePath(id)), 'public-state', {}));
    add(await profileFile(path.join(inputDir, layout.publicHistoryPath(id)), 'public-history', {}));
    for (const [suffix, kind] of [['-state.ndjson', 'private-state'], ['-history.ndjson', 'private-history']] as const) {
      for (const t of await indexPrivateFiles(reader, layout, id, suffix)) {
        add(await profileFile(path.join(inputDir, layout.channelDir(id), t.file), kind, {
          chaincode: t.chaincode, collection: t.collection,
        }));
      }
    }
    channels.push({ channelId: id, ledgerHeight: ch.ledgerHeight, files });
  }
  return { manifest, channels };
}

/** Distinct keys per batch transaction, after every cap that applies. */
function batchWidth(f: FileProfile, batchSize: number, writeBatchSize: number): number {
  const avg = f.bytes / Math.max(1, f.records);
  const byBytes = Math.max(1, Math.floor(MAX_BATCH_BYTES / Math.max(1, avg)));
  const keys = f.keys ?? f.records;
  return Math.max(1, Math.min(writeBatchSize, batchSize, byBytes, keys));
}

/**
 * Per read window of `batchSize` records, how many keys have at least r
 * versions in it, for r = 1, 2, … — which is exactly what replay submits:
 * it reads a window, then drains it in rounds, one version of each remaining
 * key per round.
 */
async function windowRounds(file: string, batchSize: number): Promise<number[][]> {
  const reader = new NdjsonReader();
  const windows: number[][] = [];
  let counts = new Map<string, number>();
  let n = 0;
  const flush = () => {
    if (counts.size === 0) return;
    const hist: number[] = [];
    for (const c of counts.values()) for (let r = 0; r < c; r++) hist[r] = (hist[r] ?? 0) + 1;
    windows.push(hist);
    counts = new Map();
    n = 0;
  };
  for await (const rec of reader.stream(file)) {
    const r = rec as { chaincode?: string; key?: string };
    const id = `${r.chaincode ?? ''}\0${r.key ?? ''}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (++n >= batchSize) flush();
  }
  flush();
  return windows;
}

const roundsCache = new Map<string, Promise<number[][]>>();

/**
 * Seconds one file takes: Σ over windows, Σ over rounds, of the batches that
 * round needs divided across `concurrency`, each costing one commit. The
 * deepest key's versions still bound it from below; whether that or the
 * volume dominates is reported.
 */
async function fileSeconds(
  f: FileProfile, latencyS: number, concurrency: number, batchSize: number, writeBatchSize: number,
): Promise<{ seconds: number; bound: 'depth' | 'volume'; tx: number }> {
  const width = batchWidth({ ...f, keys: undefined }, batchSize, writeBatchSize);
  const key = `${f.path}\0${batchSize}`;
  if (!roundsCache.has(key)) roundsCache.set(key, windowRounds(f.path as string, batchSize));
  const windows = await (roundsCache.get(key) as Promise<number[][]>);
  let commits = 0;
  let tx = 0;
  for (const hist of windows) {
    for (const k of hist) {
      const batches = Math.ceil(k / width);
      tx += batches;
      commits += Math.ceil(batches / concurrency);
    }
  }
  const seconds = commits * latencyS;
  const depth = (f.maxVersions ?? 1) * latencyS;
  return { seconds: Math.max(seconds, depth), bound: depth * 1.25 >= seconds ? 'depth' : 'volume', tx };
}

/** Longest-processing-time schedule of channels onto `slots` parallel runs. */
function schedule(durations: number[], slots: number): number {
  const lanes = new Array(Math.max(1, slots)).fill(0);
  for (const d of [...durations].sort((a, b) => b - a)) {
    lanes.sort((a, b) => a - b);
    lanes[0] += d;
  }
  return Math.max(0, ...lanes);
}

function fmt(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}

export async function adviseReplay(opts: AdviseOptions): Promise<ReplayAdvice> {
  const { manifest, channels } = await profileExtraction(opts.inputDir);
  const cfg = opts.config;
  const cc = cfg?.chaincode;
  const findings: Finding[] = [];
  const add = (level: FindingLevel, id: string, message: string, suggest?: Finding['suggest']) =>
    findings.push({ level, id, message, ...(suggest ? { suggest } : {}) });

  const all = channels.flatMap((c) => c.files);
  const tier3 = all.some((f) => f.kind.endsWith('history'));
  const replayHistory = cc?.replayHistory ?? tier3;
  const wanted = (f: FileProfile) => (replayHistory ? f.kind.endsWith('history') : f.kind.endsWith('state'));
  const withData = channels.filter((c) => c.files.some(wanted));

  const latencyMs = opts.commitLatencyMs ?? ASSUMED_LATENCY_MS;
  const latencyS = latencyMs / 1000;
  const batchSize = cfg?.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = cc?.concurrency ?? 1;
  const channelConcurrency = cc?.channelConcurrency ?? 1;
  const writeBatchSize = cc?.writeBatchSize ?? DEFAULT_WRITE_BATCH_SIZE;

  // ── Recommendations ──
  const avgBytes = all.reduce((n, f) => n + f.bytes, 0) / Math.max(1, all.reduce((n, f) => n + f.records, 0));
  const recChannels = Math.max(1, Math.min(withData.length, MAX_CHANNEL_CONCURRENCY));
  const recBatch = all.reduce((n, f) => n + f.records, 0) > 50_000 ? RECOMMENDED_BATCH_SIZE : Math.max(DEFAULT_BATCH_SIZE, 5000);
  const heapMb = Math.max(4096, Math.ceil((recBatch * avgBytes * recChannels * HEAP_FACTOR) / 1e6 / 1024) * 1024 + 2048);
  const recommended = {
    batchSize: recBatch,
    chaincode: { concurrency: RECOMMENDED_CONCURRENCY, channelConcurrency: recChannels, writeBatchSize: DEFAULT_WRITE_BATCH_SIZE },
    nodeOptions: `--max-old-space-size=${heapMb}`,
    verifyConcurrency: 32,
  };

  // ── Estimate, for the config as given ──
  const estimate = async (conc: number, chConc: number, bs: number, wbs: number) => {
    const perChannel: ChannelEstimate[] = [];
    let transactions = 0;
    let writes = 0;
    for (const c of withData) {
      let seconds = 0; let critical: { file: string; s: number; bound: 'depth' | 'volume' } | null = null;
      for (const f of c.files.filter(wanted)) {
        const r = await fileSeconds(f, latencyS, conc, bs, wbs);
        seconds += r.seconds;
        transactions += r.tx;
        writes += f.records;
        if (!critical || r.seconds > critical.s) critical = { file: f.file, s: r.seconds, bound: r.bound };
      }
      perChannel.push({ channelId: c.channelId, seconds, ...(critical ? { criticalFile: critical.file, bound: critical.bound } : {}) });
    }
    const scheduled = schedule(perChannel.map((p) => p.seconds), chConc);
    const wps = opts.destinationWritesPerSecond;
    const byThroughput = wps ? writes / wps : 0;
    return {
      perChannel, transactions, writes,
      totalSeconds: Math.max(scheduled, byThroughput),
      throughputBound: byThroughput > scheduled,
      reference: Math.max(scheduled, writes / REFERENCE_WRITES_PER_SECOND),
    };
  };
  const current = await estimate(concurrency, channelConcurrency, batchSize, writeBatchSize);
  const best = await estimate(recommended.chaincode.concurrency, recChannels, recBatch, DEFAULT_WRITE_BATCH_SIZE);

  // ── Findings ──
  if (opts.commitLatencyMs === undefined) {
    add('warn', 'latency-assumed',
      `Commit latency is assumed (${latencyMs} ms). Measure it on a dry run against the real destination — ` +
      'replay a small channel and divide the deepest file\'s time by its deepest key\'s versions — and pass ' +
      '--commit-latency-ms; the estimate scales with it.');
  }
  if (opts.destinationWritesPerSecond === undefined) {
    add('warn', 'throughput-unknown',
      `The estimate assumes the destination keeps up with ${current.writes} writes, so it is a lower bound — right to within 7% ` +
      'when one deep key dominated, half the real time when volume did. At the test destination\'s measured ' +
      `${REFERENCE_WRITES_PER_SECOND} writes/s it is ${fmt(current.reference)}. Pass --destination-writes-per-second from a dry run ` +
      '(records replayed ÷ seconds) for the real destination.');
  }
  if (!cfg) add('info', 'no-config', 'No replay config given: findings below are about the extraction only.');

  if (replayHistory && !tier3) {
    add('error', 'history-without-history',
      'replayHistory is on but the extraction holds no history files: replay would read history files only and write nothing. Use a Tier 3 extraction, or turn replayHistory off.',
      { path: 'chaincode.replayHistory', value: false });
  }
  if (!replayHistory && tier3 && cfg) {
    add('info', 'history-not-replayed',
      'The extraction is Tier 3 but replayHistory is off: the destination gets current state only, one version per key.');
  }

  const maxVersions = Math.max(0, ...all.filter(wanted).map((f) => f.maxVersions ?? 1));
  if (replayHistory && maxVersions > 1) {
    const depthBound = maxVersions * latencyS;
    add('info', 'depth-bound',
      `The deepest key has ${maxVersions} versions, so no setting makes this replay shorter than ~${fmt(depthBound)} ` +
      `(${maxVersions} × ${latencyMs} ms). Only a lower destination commit latency (shorter BatchTimeout, closer network) moves it.`);
  }

  if (cc) {
    if (withData.length > 1 && channelConcurrency < recChannels) {
      add('warn', 'channel-concurrency',
        `channelConcurrency is ${channelConcurrency} for ${withData.length} channels with data. Channels are independent ledgers; ` +
        `running ${recChannels} at once takes the estimate from ${fmt(current.totalSeconds)} toward ${fmt((await estimate(concurrency, recChannels, batchSize, writeBatchSize)).totalSeconds)}.`,
        { path: 'chaincode.channelConcurrency', value: recChannels });
    }
    if (channelConcurrency > withData.length && withData.length > 0) {
      add('info', 'channel-concurrency-idle', `channelConcurrency ${channelConcurrency} exceeds the ${withData.length} channel(s) with data; the extra slots do nothing.`);
    }
    if (concurrency < 8) {
      add('warn', 'concurrency-low',
        `concurrency is ${concurrency}: at most ${concurrency} transaction(s) per channel in flight, so every commit's latency is paid almost serially. 16–32 was measured to be safe on a 5-org destination.`,
        { path: 'chaincode.concurrency', value: RECOMMENDED_CONCURRENCY });
    }
    const inFlight = concurrency * Math.min(channelConcurrency, Math.max(1, withData.length));
    if (concurrency > 64 || inFlight > 256) {
      add('warn', 'concurrency-high',
        `Up to ${inFlight} transactions in flight (concurrency ${concurrency} × ${Math.min(channelConcurrency, withData.length)} channels). Above ~256 a small destination's orderer and peers start timing out; raise it only after a dry run shows headroom.`);
    }
    if (batchSize <= DEFAULT_BATCH_SIZE && all.reduce((n, f) => n + f.records, 0) > 50_000) {
      add('warn', 'batch-size',
        `batchSize is ${batchSize}: replay reads that many records at a time and batches only the distinct keys among them, so no transaction carries more than ${batchSize} keys. ${RECOMMENDED_BATCH_SIZE} doubled public throughput in the live run.`,
        { path: 'batchSize', value: RECOMMENDED_BATCH_SIZE });
    }
    const capped = all.filter(wanted).filter((f) => Math.floor(MAX_BATCH_BYTES / Math.max(1, f.bytes / f.records)) < writeBatchSize);
    if (capped.length) {
      add('info', 'batch-bytes',
        `${capped.length} file(s) have records large enough that a ${writeBatchSize}-key batch exceeds 2 MiB; their batches are cut at 2 MiB instead (e.g. ${capped[0].file}: ~${Math.floor(MAX_BATCH_BYTES / (capped[0].bytes / capped[0].records))} keys).`);
    }
    if (replayHistory && !cc.historyImport) {
      add(current.totalSeconds > 3600 ? 'warn' : 'info', 'one-shot',
        `This history replay is one-shot (no chaincode.historyImport): a failure after the first write needs a destination reset${current.totalSeconds > 3600 ? `, and the estimate is ${fmt(current.totalSeconds)}` : ''}. ` +
        'historyImport makes it resumable; note its private history is not batched, so it is slower.');
    }
    if (!cc.destinationFingerprint) {
      add('warn', 'unbound', 'No chaincode.destinationFingerprint: run fingerprint-destination against the destination and add the map. Without it, replay and verify do not check which network they are connected to.');
    }

    // Routing that replay refuses before any write.
    const mapping = expandCollectionMapping(cc) ?? {};
    const routes = cc.channelMapping ?? (cc.channel ? Object.fromEntries(manifest.channels.map((c) => [c.channelId, cc.channel as string])) : {});
    const unmappedChannels = withData.filter((c) => !routes[c.channelId]).map((c) => c.channelId);
    if (unmappedChannels.length) {
      add(cc.channel ? 'info' : 'warn', 'channel-unmapped',
        `${unmappedChannels.join(', ')} ${unmappedChannels.length === 1 ? 'has' : 'have'} data but no channelMapping entry: replay skips ${unmappedChannels.length === 1 ? 'it' : 'them'} (exit 0) and verify refuses.`);
    }
    const implicitUnmapped = [...new Set(all.filter((f) => f.collection && implicitCollectionOwner(f.collection) && !mapping[f.collection]).map((f) => f.collection as string))];
    if (implicitUnmapped.length) {
      add('error', 'implicit-unmapped',
        `${implicitUnmapped.length} implicit collection(s) carry data with no destination: add one chaincode.mspMapping entry per member (source MSP → destination MSP). Source MSPs: ${implicitUnmapped.map((c) => implicitCollectionOwner(c)).join(', ')}.`);
    }
    const ccNames = new Set(manifest.channels.flatMap((c) => c.chaincodes.map((x) => `${c.channelId}\0${x.name}`)));
    const noRead = [...ccNames].filter((k) => { const [ch, name] = k.split('\0'); return !cc.readFunctions?.[ch]?.[name]; })
      .map((k) => k.replace('\0', '/'));
    if (noRead.length && cc.readFunctions !== undefined) {
      add('warn', 'read-functions', `No readFunctions entry for ${noRead.slice(0, 8).join(', ')}${noRead.length > 8 ? ', …' : ''}: verify refuses an unmapped chaincode that has state.`);
    }
  }

  const purging = manifest.channels.flatMap((c) => c.chaincodes.flatMap((x) => x.collections
    .filter((col) => col.blockToLive > 0).map((col) => `${c.channelId}/${x.name}/${col.name} (${col.blockToLive})`)));
  if (purging.length) {
    add('info', 'block-to-live',
      `${purging.length} source collection(s) purge (${purging.slice(0, 5).join(', ')}${purging.length > 5 ? ', …' : ''}). The destination purges replayed values on the same rule, and blockToLive cannot be changed after the definition is committed: replay them last and verify straight after, or commit them with blockToLive 0 as their lasting value.`);
  }

  add('info', 'verify', `Verify with --concurrency ${recommended.verifyConcurrency} --redact-values; one destination round trip per key otherwise sets its duration.`);

  return {
    profile: {
      tier3,
      channels: channels.map((c) => ({ ...c, files: c.files.map(({ path: _p, ...rest }) => rest) })),
      totals: { records: all.reduce((n, f) => n + f.records, 0), bytes: all.reduce((n, f) => n + f.bytes, 0), maxVersions: Math.max(0, ...all.map((f) => f.maxVersions ?? 1)) },
    },
    estimate: {
      commitLatencyMs: latencyMs,
      commitLatencyMeasured: opts.commitLatencyMs !== undefined,
      replayHistory,
      perChannel: current.perChannel,
      totalSeconds: current.totalSeconds,
      transactions: current.transactions,
      writes: current.writes,
      ...(current.throughputBound ? { throughputBound: true } : {}),
      lowerBound: opts.destinationWritesPerSecond === undefined,
      ...(opts.destinationWritesPerSecond === undefined ? { atReferenceThroughputSeconds: current.reference } : {}),
      recommendedTotalSeconds: best.totalSeconds,
    },
    recommended,
    findings: [...findings.filter((f) => f.level === 'error'), ...findings.filter((f) => f.level === 'warn'), ...findings.filter((f) => f.level === 'info')],
  };
}

/** Human-readable report. Shapes only — no keys, no values. */
export function formatAdvice(a: ReplayAdvice): string {
  const lines: string[] = [];
  const t = a.profile.totals;
  lines.push(`Extraction: ${a.profile.channels.length} channel(s), ${t.records} records, ${(t.bytes / 1e6).toFixed(1)} MB, deepest key ${t.maxVersions} version(s)${a.profile.tier3 ? ', Tier 3' : ''}`);
  for (const c of a.profile.channels) {
    const recs = c.files.reduce((n, f) => n + f.records, 0);
    const deep = Math.max(0, ...c.files.map((f) => f.maxVersions ?? 0));
    lines.push(`  ${c.channelId}: height ${c.ledgerHeight}, ${c.files.length} file(s), ${recs} records${deep ? `, deepest ${deep}` : ''}`);
  }
  lines.push('');
  lines.push(`Estimate (${a.estimate.replayHistory ? 'history' : 'current state'}, ${a.estimate.commitLatencyMs} ms per commit, ${a.estimate.commitLatencyMeasured ? 'measured' : 'ASSUMED'}): ${a.estimate.lowerBound ? 'at least ' : ''}${fmt(a.estimate.totalSeconds)} with this config, ${fmt(a.estimate.recommendedTotalSeconds)} with the recommended settings; ~${a.estimate.transactions} transactions, ${a.estimate.writes} writes${a.estimate.throughputBound ? ' (destination-throughput-bound)' : ''}${a.estimate.atReferenceThroughputSeconds !== undefined ? `; ${fmt(a.estimate.atReferenceThroughputSeconds)} at the test destination's measured throughput` : ''}`);
  for (const p of a.estimate.perChannel) {
    lines.push(`  ${p.channelId}: ${fmt(p.seconds)}${p.criticalFile ? ` — longest file ${p.criticalFile} (${p.bound}-bound)` : ''}`);
  }
  lines.push('');
  const r = a.recommended;
  lines.push(`Recommended: batchSize ${r.batchSize}; chaincode.concurrency ${r.chaincode.concurrency}, channelConcurrency ${r.chaincode.channelConcurrency}, writeBatchSize ${r.chaincode.writeBatchSize}; NODE_OPTIONS=${r.nodeOptions}; verify --concurrency ${r.verifyConcurrency}`);
  lines.push('');
  for (const f of a.findings) {
    lines.push(`[${f.level.toUpperCase()}] ${f.id}: ${f.message}${f.suggest ? ` → set ${f.suggest.path} = ${JSON.stringify(f.suggest.value)}` : ''}`);
  }
  return lines.join('\n');
}
