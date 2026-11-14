/**
 * `run`: the per-block loop (design §5.2–5.6). One persistent Deliver feed tells us when block n is cut and hands us
 * the block itself; each source block is broadcast on its own stream; every destination block is compared with the
 * source block as it arrives. The run stops — it never skips ahead or pads — on any violation, with the exit code that
 * says what happened. The same command resumes.
 *
 * A send that fails (the orderer goes away, or answers SERVICE_UNAVAILABLE) is not simply retried: part of the block may
 * be queued. In timeout mode the run moves to another orderer, waits until nothing more can be cut, and then knows:
 * the destination is still at height n (nothing of block n survived) → send block n again; at n+1 → block n was cut, and
 * is checked like any other; anything else → a split, stop (exit 6). Cut-markers mode stops (exit 4): its batches do not
 * time out, so a partial one could still be waiting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Archive } from '../archive/reader';
import { Destination, liveConfig, reachableHeight } from '../destination';
import { DecodedBlock, decodeBlock } from '../fabric/blocks';
import { FedBlock } from '../orderer/client';
import { appOrgs, firstDiff } from '../config/chain';
import { configStep } from '../config/step';
import { configSignature, configUpdateEnvelope, cutMarker } from '../config/signer';
import { ConfigJson } from '../config/configtxlator';
import { readBundle, stepAfter, stepBefore, stepSignatures, stepUpdate, status } from '../ceremony/bundle';
import { Exit, RbError } from '../util/errors';
import { durationMs, percentile, sha256, sleep } from '../util/misc';

export interface RunOptions {
  /** Stop after this source block (inclusive); default: the archive's last. */
  to?: number;
  /** How long to wait for a block, as a multiple of BatchTimeout, before the long wait. */
  waitFactor?: number;
  /** Cut-markers mode only: at most this many blocks sent ahead of the last one verified. */
  window?: number;
  log: (s: string) => void;
  /** A signed config bundle (sign-config): its update bytes and signatures are submitted unchanged. */
  bundle?: string;
  /** After a failed send: how long no block may be cut before the outcome is read. Default max(2.5 × BatchTimeout, 10 s): above a Raft election. */
  failoverQuietMs?: number;
}

export interface RunSummary {
  channel: string;
  mode: string;
  startHeight: number;
  endHeight: number;
  blocksSent: number;
  txBlocks: number;
  configBlocks: number;
  seconds: number;
  perTxBlockMs?: { p50: number; p95: number; max: number };
  ingestMs?: { p50: number; max: number };
  reconnects: number;
  failovers: { at: number; from: string; to: string; why: string }[];
}

interface State {
  schema: 1;
  channel: string;
  destinationGenesis: string;
  archiveGenesis?: string;
  lastAligned: number;
  /** Destination hash; differs from source for rebuilt config blocks. */
  lastDataHash: string;
  /** Source hash, recorded separately so every resumed archive prefix is bound. */
  lastSourceDataHash?: string;
  batchTimeout: string;
  mode: string;
  descriptorSha256: string;
  updatedAt: string;
}

const sameContent = (s: DecodedBlock, d: DecodedBlock): string | null => {
  if (d.txs.length !== s.txs.length) return `the destination block has ${d.txs.length} transactions, the source's ${s.txs.length}`;
  if (d.dataHash !== s.dataHash) return 'data_hash differs';
  return null;
};

/**
 * Prove that the last aligned block still belongs to both chains. Transaction
 * blocks are byte-content aligned, so one hash proves both. Config blocks are
 * rebuilt for the destination and require one hash from each side.
 */
export function alignedBlockMatches(
  source: DecodedBlock,
  recordedSource: string | undefined,
  recordedDestination: string,
  destination?: DecodedBlock,
): boolean {
  if (recordedSource === undefined || source.dataHash !== recordedSource) return false;
  if (!source.isConfig) return recordedDestination === recordedSource;
  return destination !== undefined && destination.isConfig && destination.dataHash === recordedDestination;
}

export async function run(archive: Archive, dst: Destination, opts: RunOptions): Promise<RunSummary> {
  const { ld, channel, orderer } = dst;
  const log = opts.log;
  const mode = ld.d.orderer.mode;
  const btMs = durationMs(ld.d.orderer.batchTimeout);
  const last = Math.min(opts.to ?? archive.height - 1, archive.height - 1);

  // Invariant 3: the channel name is inside every signed header.
  if (archive.channel !== channel) throw new RbError(Exit.ChannelName, `the archive is channel "${archive.channel}" but the destination channel is "${channel}": signed envelopes carry the name and cannot be renamed`);

  // Nothing is sent from an archive that has not been checked end to end, whether or not `plan` ran first.
  log(`verifying ${archive.height} blocks (digests, data hashes, hash chain) ...`);
  archive.verify();
  const archiveGenesis = sha256(archive.raw(0));

  const h0 = await reachableHeight(dst);
  if (h0 > archive.height) throw new RbError(Exit.DestinationAhead, `the destination is at height ${h0}, beyond the archive's ${archive.height} blocks`);
  let { config: cur } = await liveConfig(dst);
  const genesisHash = sha256(await orderer.fetch(0));

  const stateDir = path.join(ld.workDir, 'state');
  const stateFile = path.join(stateDir, `${channel}.json`);
  const prior: State | undefined = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : undefined;
  if (prior && prior.destinationGenesis !== genesisHash) {
    throw new RbError(Exit.Mismatch, `${stateFile} belongs to a different destination channel (its genesis block differs). Move it aside if this is a new channel.`);
  }
  // A resume must come from the archive the run started from, or that archive extended (the top-up after the
  // freeze): same block 0, and the last block the run aligned is still the one it recorded.
  if (prior) {
    if (!prior.archiveGenesis) {
      throw new RbError(
        Exit.Mismatch,
        `${stateFile} predates source-archive binding and cannot prove which archive produced the destination prefix. ` +
          'Reset the destination channel and start this run again.',
      );
    }
    if (prior.archiveGenesis !== archiveGenesis || prior.lastAligned >= archive.height) {
      throw new RbError(Exit.Mismatch, `${stateFile} was written by a run from a different archive (block 0, or block ${prior.lastAligned} it last aligned, differs). Resume with the archive the run started from, or that archive extended.`);
    }
    const alignedSource = archive.block(prior.lastAligned);
    // State written before lastSourceDataHash existed can safely resume after a
    // transaction block because lastDataHash was the source hash. A legacy
    // config-block state cannot prove which source prefix produced it.
    const recordedSource = prior.lastSourceDataHash ??
      (alignedSource.isConfig ? undefined : prior.lastDataHash);
    const alignedDestination = alignedSource.isConfig && prior.lastAligned < h0
      ? decodeBlock(await orderer.fetch(prior.lastAligned))
      : undefined;
    if (!alignedBlockMatches(
      alignedSource,
      recordedSource,
      prior.lastDataHash,
      alignedDestination,
    )) {
      throw new RbError(Exit.Mismatch, `${stateFile} was written by a run from a different archive (block 0, or block ${prior.lastAligned} it last aligned, differs). Resume with the archive the run started from, or that archive extended.`);
    }
  }

  const sourceOrgs = new Set(Object.keys(ld.d.orgs));
  const started = appOrgs(cur).some((m) => sourceOrgs.has(m));
  if (!started) {
    // Invariant 2: the destination's own leading blocks stand in for source config blocks.
    if (ld.d.profile !== 'provider') throw new RbError(Exit.Unaligned, `the destination channel has none of the source orgs; was it created from \`genesis\`?`);
    for (let n = 0; n < h0; n++) if (!archive.block(n).isConfig) throw new RbError(Exit.Unaligned, `the platform created ${h0} blocks, but source block ${n} is a transaction block: block numbers cannot line up`);
    log(`provider channel at height ${h0}: source blocks 0..${h0 - 1} are config blocks and stand in for the platform's own`);
  } else if (ld.d.profile === 'self-managed' && h0 === 1) {
    const want = appOrgs(dst.ctl.blockConfig(archive.raw(0))).sort().join(','), have = appOrgs(cur).sort().join(',');
    if (want !== have) throw new RbError(Exit.Unaligned, `the destination genesis has orgs ${have}, the source genesis ${want}: create the channel from \`genesis\` of this archive`);
  } else if (h0 > 1) {
    // Resume. A run that died may have left envelopes queued: quiet for 2.5 batch timeouts means nothing is pending.
    log(`resuming at height ${h0}: checking that nothing is pending (${(btMs * 2.5) / 1000} s)`);
    await sleep(btMs * 2.5);
    const h1 = await reachableHeight(dst);
    if (h1 !== h0) throw new RbError(Exit.MovedWhileIdle, `the destination moved from ${h0} to ${h1} while idle: a partial batch was cut. Reset the destination channel.`);
    const s = archive.block(h0 - 1), d = decodeBlock(await orderer.fetch(h0 - 1));
    if (!s.isConfig) {
      const why = sameContent(s, d);
      if (why) throw new RbError(Exit.Mismatch, `destination block ${h0 - 1} is not the source's (${why}): the destination has diverged. Reset it.`);
    } else if (prior?.lastAligned !== h0 - 1) {
      // A recorded config tip was already bound to both hashes above. An unrecorded one is a config update that
      // committed just before the process wrote its state: bind it to the recorded prefix, then recompute exactly
      // what this source config block should have produced.
      if (!prior || prior.lastAligned !== h0 - 2) {
        throw new RbError(
          Exit.Mismatch,
          `destination block ${h0 - 1} is an unrecorded config block and the state file does not bind block ${h0 - 2}. ` +
            'Its source cannot be proven; reset the destination channel.',
        );
      }
      if (!d.isConfig) {
        throw new RbError(Exit.Mismatch, `destination block ${h0 - 1} is not the source's config block. Reset it.`);
      }
      const preceding = decodeBlock(await orderer.fetch(h0 - 2));
      const configBlock = preceding.isConfig ? preceding.number : preceding.lastConfig;
      const before = dst.ctl.blockConfig(await orderer.fetch(configBlock));
      const expected = configStep(dst.ctl, ld, channel, before, archive.raw(h0 - 1), h0 - 1);
      if (expected.empty) {
        throw new RbError(Exit.Unaligned, `source config block ${h0 - 1} changes nothing the destination keeps, but the destination produced a block for it.`);
      }
      const diff = firstDiff(dst.ctl.blockConfig(d.bytes), expected.next);
      if (diff) {
        throw new RbError(Exit.Mismatch, `destination config block ${h0 - 1} differs from the source-derived config at ${diff}. Reset it.`);
      }
    }
    log(`block ${h0 - 1} matches the source`);
  }

  const writeState = (
    n: number,
    destinationDataHash: string,
    sourceDataHash: string,
  ): void => {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const st: State = {
      schema: 1,
      channel,
      destinationGenesis: genesisHash,
      archiveGenesis,
      lastAligned: n,
      lastDataHash: destinationDataHash,
      lastSourceDataHash: sourceDataHash,
      batchTimeout: ld.d.orderer.batchTimeout,
      mode,
      descriptorSha256: sha256(fs.readFileSync(ld.file)),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(st, null, 2));
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  const reportDir = path.join(ld.workDir, 'report');
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const report = fs.openSync(path.join(reportDir, `${channel}.ndjson`), 'a');
  const record = (o: object): void => { fs.writeSync(report, JSON.stringify(o) + '\n'); };

  const bundle = opts.bundle ? readBundle(opts.bundle) : undefined;
  if (bundle) {
    if (bundle.channel !== channel) throw new RbError(Exit.ChannelName, `the bundle is for channel "${bundle.channel}", not "${channel}"`);
    // every signature is checked before the first block is sent, not when its block comes up
    const todo = status(opts.bundle!, bundle).filter((s) => s.sourceBlock >= h0 && s.sourceBlock <= last && (s.missing.length || s.invalid.length));
    if (todo.length) throw new RbError(Exit.SignaturesMissing, `the bundle lacks signatures for ${todo.length} config block(s): ${todo.map((s) => `#${s.sourceBlock} needs ${[...s.missing, ...s.invalid.map((x) => x.mspId + ' (invalid)')].join(', ')}`).join('; ')}`);
  }
  const feed = orderer.feed(h0);
  // Cut markers are signed by a local org signer when the descriptor has one, else by the orderer reader, which is a
  // channel Writer like the bundle submitter. With every org signing by ceremony there is no local org signer.
  const markerSigner = dst.orgSigners.values().next().value ?? dst.reader;
  const t0 = Date.now();
  const rows: { total: number; ingest: number }[] = [];
  let configBlocks = 0, sent = 0;
  // cut-markers: blocks sent but not yet seen; verified in order by `verifyNext`
  const pending: { n: number; src: DecodedBlock; sentAt: number }[] = [];
  const verifyOne = async (): Promise<void> => {
    const p = pending.shift()!;
    const got = await feed.get(p.n, btMs * 4 + 60000).catch(() => {
      throw new RbError(Exit.BroadcastFailed, `block ${p.n} was accepted but not produced within ${(btMs * 4 + 60000) / 1000} s`);
    });
    const why = sameContent(p.src, decodeBlock(got.bytes));
    if (why) throw new RbError(Exit.Mismatch, `destination block ${p.n}: ${why} (the block was split or altered)`);
    record({ n: p.n, kind: 'TX', txs: p.src.txs.length, deliveredMs: got.at - p.sentAt, match: true });
    writeState(p.n, p.src.dataHash, p.src.dataHash);
  };
  const drain = async (): Promise<void> => { while (pending.length) await verifyOne(); };

  // ── a failed send ──
  const canRecover = mode === 'timeout';
  const maxResends = orderer.addresses.length + 1;
  const isUnavailable = (vs: { status: string }[]): number => vs.findIndex((v) => v.status === 'SERVICE_UNAVAILABLE');
  /** After a failed send of block n: another orderer, quiet for max(2.5 × BatchTimeout, 10 s), then what holds. */
  const recover = async (n: number, why: string, from = orderer.address): Promise<'lost' | 'cut'> => {
    let to: string;
    try { to = await orderer.failover(`send of block ${n} failed: ${why}`, 120000); }
    catch (e) { throw new RbError(Exit.Unreachable, `the send of block ${n} failed on ${from} (${why}) and ${(e as Error).message}. Rerun the same command once an orderer is back.`); }
    const quietMs = opts.failoverQuietMs ?? Math.max(btMs * 2.5, 10000);
    log(`#${n} send failed on ${from} (${why}); now on ${to}; waiting ${quietMs / 1000} s for anything still queued to be cut`);
    // Every reachable orderer is read: a follower can lag the leader by a block for a moment.
    let h = -1, since = Date.now();
    const until = Date.now() + quietMs + 120000;
    for (;;) {
      const hs = (await orderer.heights()).filter((x) => x.height !== undefined).map((x) => x.height!);
      const m = hs.length ? Math.max(...hs) : -1;
      if (m !== h) { h = m; since = Date.now(); }
      else if (h >= 0 && Date.now() - since >= quietMs) break;
      if (Date.now() > until) throw new RbError(Exit.Unreachable, `after the failed send of block ${n} the orderers did not settle (last height ${h})`);
      await sleep(Math.min(btMs, 1000));
    }
    if (h === n) { log(`#${n} nothing of it was cut: sending it again`); return 'lost'; }
    if (h === n + 1) { log(`#${n} it was cut before the failure: checking it`); return 'cut'; }
    throw new RbError(Exit.Mismatch, `after the failed send of block ${n} the destination is at height ${h}: the block was split. The channel must be reset.`);
  };
  /** Broadcast with recovery; `null` means block n was already cut (the caller checks it). */
  const send = async (n: number, envs: Buffer[]): Promise<{ status: string; info: string }[] | null> => {
    for (let resends = 0; ; resends++) {
      let why: string;
      try {
        const vs = await orderer.broadcast(envs);
        const u = isUnavailable(vs);
        if (u < 0 || !canRecover) return vs;
        why = `envelope ${u}: SERVICE_UNAVAILABLE ${vs[u].info}`;
      } catch (e) {
        why = `${(e as Error).message} after ${(e as { acked?: number }).acked ?? 0}/${envs.length} verdicts`;
        if (!canRecover) throw new RbError(Exit.BroadcastFailed, `broadcast of block ${n} failed: ${why}. Part of the block may be queued at the orderer (cut-markers mode does not time out a batch): do not retry; rerun the same command to see whether the destination is still aligned.`);
      }
      if (resends >= maxResends) throw new RbError(Exit.BroadcastFailed, `block ${n} could not be sent after ${resends} failovers (last: ${why})`);
      if ((await recover(n, why)) === 'cut') return null;
    }
  };
  /**
   * Timeout mode: send block n and wait for it. A block whose envelopes were all accepted but which never appears (the
   * node that accepted them died before passing them on) is recovered like a failed send. Returns the verdicts (null if
   * the block turned out to be cut already) and the delivered block; `got` is null when an envelope was refused.
   */
  const deliver = async (n: number, envs: Buffer[], waits: number[]): Promise<{ vs: { status: string; info: string }[] | null; got: FedBlock | null; ingest: number; sentAt: number }> => {
    for (let resends = 0; ; resends++) {
      const sentAt = Date.now();
      const vs = await send(n, envs);
      const sentTo = orderer.address;
      const ingest = Date.now() - sentAt;
      if (vs && vs.some((v) => v.status !== 'SUCCESS')) return { vs, got: null, ingest, sentAt };
      let got: FedBlock | null = null;
      for (const [i, w] of waits.entries()) {
        // A slow platform can cut late (seen once on a managed provider), so a second, longer wait follows; but not when the node
        // that accepted the envelopes no longer answers: then they are gone with it, or already passed on.
        if (i > 0 && canRecover && (await orderer.heights()).find((x) => x.address === sentTo)?.height === undefined) break;
        got = await feed.get(n, w).catch(() => null);
        if (got) break;
      }
      if (got) return { vs, got, ingest, sentAt };
      const why = `all envelopes accepted, but no block ${n} appeared`;
      if (!canRecover || resends >= maxResends) throw new RbError(Exit.BroadcastFailed, `block ${n} was ${why}`);
      if ((await recover(n, why, sentTo)) === 'cut') return { vs, got: await feed.get(n, 30000), ingest, sentAt };
    }
  };

  try {
    for (let n = h0; n <= last; n++) {
      const raw = archive.raw(n);
      const src = decodeBlock(raw);
      const tStart = Date.now();

      if (src.isConfig) {
        await drain();
        let step: { updateBytes: Buffer; next: ConfigJson; signers: string[]; changed: string[] };
        let env: Buffer;
        const bs = bundle?.steps.find((x) => x.sourceBlock === n);
        if (bundle) {
          if (!bs) throw new RbError(Exit.SignaturesMissing, `the bundle has no update for config block ${n}`);
          // the bundle was computed against a config; the destination must be in exactly that config now
          const d = firstDiff(cur, stepBefore(opts.bundle!, bs));
          if (d) throw new RbError(Exit.Mismatch, `the destination's config before block ${n} is not the one the bundle was computed against (${d}): export and sign again`);
          step = { updateBytes: stepUpdate(opts.bundle!, bs), next: stepAfter(opts.bundle!, bs), signers: bs.signers, changed: bs.changed };
          // the submitter only signs the outer envelope; it must be a channel Writer (the orderer reader is one)
          env = configUpdateEnvelope(dst.reader, channel, step.updateBytes, stepSignatures(opts.bundle!, bundle, bs));
        } else {
          const cs = configStep(dst.ctl, ld, channel, cur, raw, n);
          if (cs.empty) throw new RbError(Exit.Unaligned, `source config block ${n} changes nothing the destination keeps, so no destination block would be made for it: block numbers cannot line up`);
          const ids = cs.signers.map((m) => {
            const id = dst.orgSigners.get(m) ?? (m === dst.platformAdmin?.mspId ? dst.platformAdmin : m === dst.ordererAdmin?.mspId ? dst.ordererAdmin : undefined);
            if (!id) throw new RbError(Exit.SignaturesMissing, `config block ${n} needs a signature from ${m}, and the descriptor holds no key for it${ld.d.orgs[m]?.signer.mode === 'ceremony' ? ' (it signs by ceremony: run with --bundle)' : ''}`);
            return id;
          });
          step = cs;
          env = configUpdateEnvelope(ids[0], channel, cs.updateBytes, ids.map((id) => configSignature(id, cs.updateBytes)));
        }
        const ti = Date.now();
        const { vs, got: g } = await deliver(n, [env], [60000]);
        if (!g) throw new RbError(Exit.Rejected, `config update for block ${n} refused: ${vs![0].status} ${vs![0].info}`);
        const got = g;
        const diff = firstDiff(dst.ctl.blockConfig(got.bytes), step.next);
        if (diff) throw new RbError(Exit.Mismatch, `the committed config of block ${n} differs from the one computed: ${diff}`);
        cur = step.next as ConfigJson;
        configBlocks++; sent++;
        record({ n, kind: 'CONFIG', signers: step.signers, changed: step.changed, ingestMs: Date.now() - ti, totalMs: Date.now() - tStart });
        writeState(n, decodeBlock(got.bytes).dataHash, src.dataHash);
        log(`#${n} CONFIG mirrored (${step.changed.join(',') || 'channel'}; signed by ${step.signers.join(', ')})`);
        continue;
      }

      const envs = src.txs.map((t) => t.envelope);
      if (mode === 'cut-markers') envs.push(cutMarker(markerSigner, channel));
      if (mode === 'cut-markers') {
        const ti = Date.now();
        const verdicts = (await send(n, envs))!; // no recovery in this mode: send() throws instead of returning null
        const ingest = Date.now() - ti;
        const bad = verdicts.findIndex((v) => v.status !== 'SUCCESS');
        if (bad >= 0) throw new RbError(Exit.Rejected, `block ${n}: envelope ${bad}${bad < src.txs.length ? ` (tx ${src.txs[bad].txId})` : ' (cut marker)'} refused: ${verdicts[bad].status} ${verdicts[bad].info}`);
        sent++;
        pending.push({ n, src, sentAt: ti });
        if (pending.length > (opts.window ?? 32)) await verifyOne();
        rows.push({ total: Date.now() - tStart, ingest });
      } else {
        const r = await deliver(n, envs, [btMs * (opts.waitFactor ?? 3) + 5000, 60000]);
        if (!r.got) {
          const bad = r.vs!.findIndex((v) => v.status !== 'SUCCESS');
          throw new RbError(Exit.Rejected, `block ${n}: envelope ${bad} (tx ${src.txs[bad].txId}) refused: ${r.vs![bad].status} ${r.vs![bad].info}`);
        }
        sent++;
        const why = sameContent(src, decodeBlock(r.got.bytes));
        if (why) throw new RbError(Exit.Mismatch, `destination block ${n}: ${why} (the block was split: raise BatchTimeout or BatchSize; the channel must be reset)`);
        rows.push({ total: Date.now() - tStart, ingest: r.ingest });
        record({ n, kind: 'TX', txs: src.txs.length, ingestMs: r.ingest, deliveredMs: r.got.at - r.sentAt, totalMs: Date.now() - tStart, match: true });
        writeState(n, src.dataHash, src.dataHash);
      }
      if (rows.length % 100 === 0) log(`  ${rows.length} tx blocks, last #${n}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
    await drain();
  } finally {
    feed.close();
    fs.closeSync(report);
  }
  const totals = rows.map((r) => r.total), ingests = rows.map((r) => r.ingest);
  return {
    channel, mode, startHeight: h0, endHeight: await reachableHeight(dst), blocksSent: sent, txBlocks: rows.length, configBlocks,
    seconds: (Date.now() - t0) / 1000,
    ...(rows.length && { perTxBlockMs: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95), max: Math.max(...totals) }, ingestMs: { p50: percentile(ingests, 0.5), max: Math.max(...ingests) } }),
    reconnects: orderer.stats.reconnects,
    failovers: orderer.stats.failovers,
  };
}
