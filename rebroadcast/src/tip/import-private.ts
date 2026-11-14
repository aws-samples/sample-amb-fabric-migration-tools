/**
 * `tip import-private` (design §9, option (a): the tool's own importer, independent of the replay path).
 *
 * Re-broadcast restores every private-data HASH (they are in the blocks), never a value: values never touched the
 * orderer. This writes them back through the migration contract's `ImportPrivateDataBatch(collection)`, values in
 * transient data, as one writer identity endorsed by the given destination peers.
 *
 *   - every input value must hash to the live hash the blocks hold for its key, or nothing is written (exit 6)
 *   - keys whose destination VALUE already equals it are skipped, so a re-run resumes (the hash cannot tell: replay
 *     put every hash there already)
 *   - one collection per transaction; ordinary collections first, the writer's implicit collection next, collections
 *     with a blockToLive last (their expiry window starts at the import)
 *   - another org's implicit collection is skipped: only that org's peers can endorse it (run again as that org)
 *   - each transaction is waited for on the first endorsing peer; a group stops at its first failure
 * Without `yes` it only reports the plan.
 */
import { Archive } from '../archive/reader';
import { Destination } from '../destination';
import { Endorser, buildProposal, transactionEnvelope } from '../fabric/endorser';
import { decodeBlock } from '../fabric/blocks';
import { Peer } from '../orderer/client';
import { rebuildFacts } from '../verify/facts';
import { PrivateRecord } from '../verify/verify';
import { Definition, destinationDefinition, sourceDefinitions } from './chaincode';
import { Exit, RbError } from '../util/errors';
import { sha256, sameJson } from '../util/misc';

/** The migration contract's batch framing: u32 count, then per entry u32 key length, key, u8 flag (0 write), u32 value length, value. */
export function frameBatch(entries: { key: string; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  parts.push(u32(entries.length));
  for (const e of entries) { const k = Buffer.from(e.key, 'utf8'); parts.push(u32(k.length), k, Buffer.from([0]), u32(e.value.length), e.value); }
  return Buffer.concat(parts);
}

export interface GroupReport { group: string; records: number; present: number; toWrite: number; written: number; txs: number; skipped?: string; failed?: string; blockToLive: number }
export interface ImportResult { channel: string; writer: string; endorsers: string[]; groups: GroupReport[]; written: number; txs: number; applied: boolean }

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

/** Follows a peer's chain and answers "what code did transaction X get". */
class CommitWatcher {
  private next: number;
  private readonly seen = new Map<string, string>();
  private feed;
  constructor(peer: Peer, from: number) { this.next = from; this.feed = peer.feed(from); }
  async wait(txId: string, timeoutMs = 90000): Promise<string> {
    const until = Date.now() + timeoutMs;
    while (!this.seen.has(txId)) {
      if (Date.now() > until) throw new Error(`transaction ${txId.slice(0, 16)}… not committed within ${timeoutMs / 1000} s`);
      const b = decodeBlock((await this.feed.get(this.next++, Math.max(1000, until - Date.now()))).bytes);
      for (const t of b.txs) this.seen.set(t.txId, t.code ?? 'UNKNOWN');
    }
    return this.seen.get(txId)!;
  }
  close(): void { this.feed.close(); }
}

export async function importPrivate(
  archive: Archive, dst: Destination, endorsers: Endorser[], watchPeer: Peer, records: PrivateRecord[],
  opts: { yes: boolean; batch: number; concurrency: number; log: (s: string) => void },
): Promise<ImportResult> {
  const writer = endorsers[0].identity;
  const facts = rebuildFacts(archive);
  const btl = new Map<string, number>();
  for (const d of sourceDefinitions(archive).values()) for (const c of d.collections) btl.set(`${d.name}/${c.name}`, c.blockToLive);

  // 1. Every value must be the one the blocks committed.
  const bad = records.filter((r) => facts.privateHashes.get(`${r.chaincode}/${r.collection}`)?.get(sha256(r.key)) !== sha256(r.value));
  if (bad.length) throw new RbError(Exit.Mismatch, `${bad.length} input value(s) do not hash to the live hash in the blocks (first: ${bad[0].chaincode}/${bad[0].collection}/${JSON.stringify(bad[0].key)}); is this the right extraction, of this channel? Nothing written`);

  // 2. Group and order.
  const groups = new Map<string, PrivateRecord[]>();
  for (const r of records) { const g = `${r.chaincode}/${r.collection}`; groups.set(g, [...(groups.get(g) ?? []), r]); }
  const rank = (g: string): number => ((btl.get(g) ?? 0) > 0 ? 2 : g.includes('/_implicit_org_') ? 1 : 0);
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const result: ImportResult = { channel: dst.channel, writer: writer.mspId, endorsers: endorsers.map((e) => e.endpoint.address), groups: [], written: 0, txs: 0, applied: opts.yes };
  const watcher = opts.yes ? new CommitWatcher(watchPeer, await watchPeer.height()) : undefined;
  const defs = new Map<string, Definition | undefined>();
  try {
    for (const g of order) {
      const rows = groups.get(g)!;
      const [cc, coll] = [rows[0].chaincode, rows[0].collection];
      const rep: GroupReport = { group: g, records: rows.length, present: 0, toWrite: 0, written: 0, txs: 0, blockToLive: btl.get(g) ?? 0 };
      result.groups.push(rep);
      if (coll.startsWith('_implicit_org_') && coll !== `_implicit_org_${writer.mspId}`) {
        rep.skipped = `${coll.slice('_implicit_org_'.length)}'s implicit collection: only that org's peers can endorse writes to it; run import-private as that org through its peer`;
        continue;
      }
      const def = defs.has(cc) ? defs.get(cc) : await destinationDefinition(endorsers[0], cc).catch(() => undefined);
      defs.set(cc, def);
      const cdef = def?.collections.find((c) => c.name === coll);
      if (cdef?.memberOnlyWrite && cdef.policy.msps.length && !cdef.policy.msps.includes(writer.mspId)) {
        rep.skipped = `${writer.mspId} is not a member of ${coll} (memberOnlyWrite; members ${cdef.policy.msps.join(', ')}): run import-private as a member through its peer`;
        continue;
      }
      // 3. Skip what is already there (makes a re-run a resume). The VALUE is read: after a re-broadcast every hash is
      //    already on the destination (it is in the blocks) whether or not the value was ever written.
      const todo: PrivateRecord[] = [];
      await pool(rows, opts.concurrency, async (r) => {
        const v = await endorsers[0].query(cc, ['MigrationContract:ReadPrivateData', coll, r.key]);
        if (v.status === 200) { const got = Buffer.from(v.payload.toString('utf8'), 'base64'); if (got.equals(r.value) || sameJson(got, r.value)) rep.present++; }
        else todo.push(r);
      });
      rep.toWrite = todo.length;
      if (!opts.yes || !todo.length) continue;
      todo.sort((a, b) => (a.key < b.key ? -1 : 1));
      for (let i = 0; i < todo.length; i += opts.batch) {
        const part = todo.slice(i, i + opts.batch);
        try {
          const p = buildProposal(writer, dst.channel, cc, ['MigrationContract:ImportPrivateDataBatch', coll], endorsers[0].tlsHash, { private_batch: frameBatch(part) });
          const responses = await Promise.all(endorsers.map((e) => e.process(p.signed)));
          const refused = responses.findIndex((r) => (r.getResponse()?.getStatus() ?? 0) !== 200);
          if (refused >= 0) throw new Error(`endorsement refused by ${endorsers[refused].endpoint.address}: ${responses[refused].getResponse()?.getMessage().slice(0, 200)}`);
          const [v] = await dst.orderer.broadcast([transactionEnvelope(writer, p, responses)]);
          if (v.status !== 'SUCCESS') throw new Error(`orderer: ${v.status} ${v.info}`);
          const code = await watcher!.wait(p.txId);
          if (code !== 'VALID') throw new Error(`transaction ${p.txId.slice(0, 16)}… committed as ${code}`);
          rep.written += part.length; rep.txs++;
        } catch (e) {
          rep.failed = (e as Error).message;
          break;
        }
      }
      result.written += rep.written; result.txs += rep.txs;
      opts.log(`  ${g}: ${rep.written}/${rep.toWrite} written in ${rep.txs} txs${rep.present ? `, ${rep.present} already present` : ''}${rep.failed ? ` | STOPPED: ${rep.failed}` : ''}`);
    }
  } finally {
    watcher?.close();
  }
  return result;
}
