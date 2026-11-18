// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * `probe` (design §8): how long the destination takes to ingest a block's worth of envelopes, measured on a SCRATCH
 * channel, so the batch timeout can be chosen before a one-shot channel is at stake.
 *
 * The orderer starts a batch's timer at its first envelope, so a block splits if its envelopes take longer than
 * BatchTimeout to arrive. The sender cannot see that happen in advance; this measures it. Bursts copy the sizes of the
 * archive's largest blocks (by count and by bytes); their envelopes are well-formed and signed by a channel Writer,
 * with filler payloads (peers mark them invalid, which on a scratch channel does not matter).
 *
 * The scratch channel is first given the batch settings `run` would use (one config update), then each burst is sent
 * on one Broadcast stream, and the blocks it produced are read back: one block holding all of it, or a split.
 */
import * as crypto from 'crypto';
import { common } from '@hyperledger/fabric-protos';
import { Archive } from '../archive/reader';
import { Destination, liveConfig, reachableHeight } from '../destination';
import { decodeBlock } from '../fabric/blocks';
import { clone, durationMs, percentile } from '../util/misc';
import { configSignature, configUpdateEnvelope, signLowS, Identity } from '../config/signer';
import { Exit, RbError } from '../util/errors';

export interface ProbeResult {
  scratch: string;
  batchTimeout: string;
  bursts: number;
  shapes: { txs: number; bytes: number }[];
  ingestMs: { p50: number; p95: number; p99: number; max: number };
  splits: number;
  recommendedBatchTimeout: string;
  note: string;
}

/** An ENDORSER_TRANSACTION-typed envelope of about `bytes` (payload + signature), with a filler body. */
function fillerEnvelope(id: Identity, channel: string, bytes: number): Buffer {
  const nonce = crypto.randomBytes(24);
  const ch = new common.ChannelHeader();
  ch.setType(common.HeaderType.ENDORSER_TRANSACTION);
  ch.setChannelId(channel);
  ch.setTxId(crypto.createHash('sha256').update(Buffer.concat([nonce, id.creator])).digest('hex'));
  const sh = new common.SignatureHeader();
  sh.setCreator(id.creator);
  sh.setNonce(nonce);
  const hdr = new common.Header();
  hdr.setChannelHeader(ch.serializeBinary());
  hdr.setSignatureHeader(sh.serializeBinary());
  const overhead = hdr.serializeBinary().length + 80;
  const pl = new common.Payload();
  pl.setHeader(hdr);
  pl.setData(crypto.randomBytes(Math.max(16, bytes - overhead)));
  const payload = Buffer.from(pl.serializeBinary());
  const env = new common.Envelope();
  env.setPayload(payload);
  env.setSignature(signLowS(id.key, payload));
  return Buffer.from(env.serializeBinary());
}

/** The block shapes to copy: the largest blocks by transaction count and by bytes, without duplicates. */
export function shapes(archive: Archive, n: number): { txs: number; sizes: number[] }[] {
  const all: { n: number; txs: number; bytes: number; sizes: number[] }[] = [];
  for (let i = 0; i < archive.height; i++) {
    const b = archive.block(i);
    if (b.isConfig) continue;
    const sizes = b.txs.map((t) => t.cutterBytes);
    all.push({ n: i, txs: sizes.length, bytes: sizes.reduce((a, c) => a + c, 0), sizes });
  }
  const pick = new Map<number, { txs: number; sizes: number[] }>();
  for (const x of [...all].sort((a, b) => b.txs - a.txs).slice(0, Math.ceil(n / 2))) pick.set(x.n, x);
  for (const x of [...all].sort((a, b) => b.bytes - a.bytes)) { if (pick.size >= n) break; pick.set(x.n, x); }
  return [...pick.values()];
}

export async function probe(archive: Archive, dst: Destination, opts: { bursts: number; log: (s: string) => void }): Promise<ProbeResult> {
  const { ld, channel, orderer, ctl } = dst;
  const bt = ld.d.orderer.batchTimeout, btMs = durationMs(bt);
  const writer = dst.reader;
  await reachableHeight(dst);

  // 1. the scratch channel gets the batch settings `run` would set
  const { config: cur } = await liveConfig(dst);
  const target = clone(cur);
  const ord = target.channel_group.groups.Orderer.values;
  ord.BatchTimeout.value.timeout = bt;
  if (ld.d.ordererOverrides?.BatchSize) Object.assign(ord.BatchSize.value, ld.d.ordererOverrides.BatchSize);
  const upd = ctl.computeUpdate(channel, cur, target);
  const feedFrom = await orderer.height();
  const feed = orderer.feed(feedFrom);
  let next = feedFrom;
  try {
    if (upd.length) {
      const admin = dst.ordererAdmin;
      if (!admin) throw new RbError(Exit.SignaturesMissing, 'changing the scratch channel\'s batch settings needs the orderer org (self-managed) or platform (provider) admin in the descriptor');
      const [v] = await orderer.broadcast([configUpdateEnvelope(admin, channel, upd, [configSignature(admin, upd)])]);
      if (v.status !== 'SUCCESS') throw new RbError(Exit.Rejected, `the scratch channel refused the batch settings: ${v.status} ${v.info}`);
      await feed.get(next++, 30000);
      opts.log(`scratch channel ${channel}: BatchTimeout ${bt}${ld.d.ordererOverrides?.BatchSize ? `, BatchSize ${JSON.stringify(ld.d.ordererOverrides.BatchSize)}` : ''}`);
    }
    const maxCount = Number(ord.BatchSize.value.max_message_count);

    // 2. bursts shaped like the archive's largest blocks
    const sh = shapes(archive, Math.min(opts.bursts, 40));
    const ingest: number[] = [];
    let splits = 0, sent = 0;
    for (let i = 0; i < opts.bursts; i++) {
      const s = sh[i % sh.length];
      const k = Math.min(s.txs, maxCount);
      const envs = s.sizes.slice(0, k).map((b) => fillerEnvelope(writer, channel, b));
      const t0 = Date.now();
      const verdicts = await orderer.broadcast(envs);
      ingest.push(Date.now() - t0);
      const bad = verdicts.find((v) => v.status !== 'SUCCESS');
      if (bad) throw new RbError(Exit.Rejected, `the scratch channel refused a probe envelope: ${bad.status} ${bad.info}`);
      let seen = 0, blocks = 0;
      while (seen < k) { seen += decodeBlock((await feed.get(next++, btMs * 4 + 30000)).bytes).txs.length; blocks++; }
      if (blocks > 1) splits++;
      sent++;
      if (sent % 10 === 0) opts.log(`  ${sent}/${opts.bursts} bursts; ingest p99 so far ${percentile(ingest, 0.99)} ms; splits ${splits}`);
    }
    const p99 = percentile(ingest, 0.99);
    const rec = Math.max(500, Math.ceil((3 * p99) / 100) * 100);
    return {
      scratch: channel, batchTimeout: bt, bursts: sent, shapes: sh.map((s) => ({ txs: s.txs, bytes: s.sizes.reduce((a, c) => a + c, 0) })),
      ingestMs: { p50: percentile(ingest, 0.5), p95: percentile(ingest, 0.95), p99, max: Math.max(...ingest) }, splits,
      recommendedBatchTimeout: rec >= 1000 && rec % 1000 === 0 ? `${rec / 1000}s` : `${rec}ms`,
      note: `ingest = first envelope sent to last verdict received, from this machine; a block splits when ingest exceeds BatchTimeout. Recommended = max(500 ms, 3 × p99). ${splits ? `${splits} of ${sent} bursts SPLIT at ${bt}: do not run at this BatchTimeout.` : `no split in ${sent} bursts at ${bt}.`}`,
    };
  } finally {
    feed.close();
  }
}
