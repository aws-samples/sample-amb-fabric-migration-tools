/**
 * Talking to an ordering service (and a peer's Deliver service) with @grpc/grpc-js alone. The client definitions use
 * identity (de)serialisers, so a block is exactly the bytes the server sent and an envelope exactly the bytes in the
 * archive; messages are decoded only where a field is needed (spikes S1/S4).
 *
 *   broadcast()  one stream per call: raw envelopes in, one verdict per envelope, in order. Never retried.
 *   feed()       ONE persistent Deliver stream following the chain, reconnecting from the next unseen block.
 *   fetch()      one block (or the newest) on a short-lived stream.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as grpc from '@grpc/grpc-js';
import { common, orderer as ab } from '@hyperledger/fabric-protos';
import { Identity, signedEnvelope } from '../config/signer';
import { sleep } from '../util/misc';

const ident = (b: Buffer): Buffer => b;
const duplex = (p: string): grpc.MethodDefinition<Buffer, Buffer> => ({
  path: p, requestStream: true, responseStream: true,
  requestSerialize: ident, requestDeserialize: ident, responseSerialize: ident, responseDeserialize: ident,
});
const OrdererClient = grpc.makeGenericClientConstructor({ Broadcast: duplex('/orderer.AtomicBroadcast/Broadcast'), Deliver: duplex('/orderer.AtomicBroadcast/Deliver') }, 'AtomicBroadcast');
const PeerClient = grpc.makeGenericClientConstructor({ Deliver: duplex('/protos.Deliver/Deliver') }, 'Deliver');
type Duplex = grpc.ClientDuplexStream<Buffer, Buffer>;

const STATUS: Record<number, string> = Object.fromEntries(Object.entries(common.Status).map(([k, v]) => [v as number, k]));
export const statusName = (n: number): string => STATUS[n] ?? String(n);

/**
 * DeliverResponse (orderer and peer alike) is `oneof { Status status = 1; Block block = 2; ... }`: read the tag and take
 * the block's bytes without decoding it.
 */
export function parseDeliverResponse(buf: Buffer): { status?: string; block?: Buffer } {
  const tag = buf[0];
  let pos = 1, len = 0, shift = 0;
  for (;;) {
    const b = buf[pos++];
    len += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  if (tag === 0x08) return { status: statusName(len) }; // a varint field: the value itself
  if (tag === 0x12) return { block: buf.subarray(pos, pos + len) };
  throw new Error(`unexpected DeliverResponse field (tag ${tag})`);
}
export const blockNumber = (bytes: Uint8Array): number => Number(common.Block.deserializeBinary(bytes).getHeader()!.getNumber());

export interface EndpointOpts {
  address: string;
  serverName?: string;
  tlsCa: Buffer;
  clientCert?: Buffer;
  clientKey?: Buffer;
  /** Fabric refuses pings more often than ServerMinInterval (60 s default) and then drops the connection: keep this above it. */
  keepaliveMs?: number;
}

function channelOpts(o: EndpointOpts): grpc.ChannelOptions {
  return {
    ...(o.serverName && { 'grpc.ssl_target_name_override': o.serverName, 'grpc.default_authority': o.serverName }),
    'grpc.keepalive_time_ms': o.keepaliveMs ?? 120000,
    'grpc.keepalive_timeout_ms': 10000,
    'grpc.keepalive_permit_without_calls': 1,
    'grpc.max_receive_message_length': 128 * 1024 * 1024,
    'grpc.max_send_message_length': 128 * 1024 * 1024,
  };
}
const creds = (o: EndpointOpts): grpc.ChannelCredentials => grpc.credentials.createSsl(o.tlsCa, o.clientKey ?? null, o.clientCert ?? null);

export function endpointFrom(e: { address: string; tlsCa: string; clientCert?: string; clientKey?: string; sni?: string }, p: (x: string) => string): EndpointOpts {
  return {
    address: e.address,
    serverName: e.sni ?? e.address.split(':')[0],
    tlsCa: fs.readFileSync(p(e.tlsCa)),
    clientCert: e.clientCert ? fs.readFileSync(p(e.clientCert)) : undefined,
    clientKey: e.clientKey ? fs.readFileSync(p(e.clientKey)) : undefined,
  };
}

export interface Stats { reconnects: number; failovers: { at: number; from: string; to: string; why: string }[]; streamErrors: { at: number; code: string; msg: string }[] }

interface Target { address: string; client: grpc.Client & { Deliver: () => Duplex }; tlsCertHash?: Buffer }

/**
 * Deliver from a peer or an orderer: the request is the same signed SeekInfo envelope. Holds one client per endpoint of
 * the service (orderers: every node; any one serves the channel) and uses one at a time; a failed read or stream moves to
 * the next.
 */
class DeliverSource {
  readonly stats: Stats = { reconnects: 0, failovers: [], streamErrors: [] };
  protected readonly targets: Target[];
  private active = 0;
  constructor(
    eps: EndpointOpts[],
    make: (o: EndpointOpts) => grpc.Client & { Deliver: () => Duplex },
    readonly channel: string,
    private readonly reader: Identity,
  ) {
    if (!eps.length) throw new Error('no endpoints');
    // With mutual TLS the request must carry the hash of the client certificate it is sent over.
    this.targets = eps.map((o) => ({ address: o.address, client: make(o), tlsCertHash: o.clientCert ? crypto.createHash('sha256').update(new crypto.X509Certificate(o.clientCert).raw).digest() : undefined }));
  }

  get address(): string { return this.targets[this.active].address; }
  get activeIndex(): number { return this.active; }
  get addresses(): string[] { return this.targets.map((t) => t.address); }
  protected get client(): grpc.Client & { Deliver: () => Duplex } { return this.targets[this.active].client; }

  /** Use the next endpoint (no-op with one). */
  rotate(why: string): void {
    if (this.targets.length < 2) return;
    const from = this.address;
    this.active = (this.active + 1) % this.targets.length;
    this.stats.failovers.push({ at: Date.now(), from, to: this.address, why: why.slice(0, 120) });
  }

  seekRequest(from: number | 'newest', to?: number, target = this.active): Buffer {
    const pos = (n: number | 'newest'): ab.SeekPosition => {
      const sp = new ab.SeekPosition();
      if (n === 'newest') sp.setNewest(new ab.SeekNewest());
      else { const s = new ab.SeekSpecified(); s.setNumber(n); sp.setSpecified(s); }
      return sp;
    };
    const si = new ab.SeekInfo();
    si.setStart(pos(from));
    if (from === 'newest') { si.setStop(pos('newest')); si.setBehavior(ab.SeekInfo.SeekBehavior.FAIL_IF_NOT_READY); }
    else if (to !== undefined) { si.setStop(pos(to)); si.setBehavior(ab.SeekInfo.SeekBehavior.FAIL_IF_NOT_READY); }
    else { si.setStop(pos(Number.MAX_SAFE_INTEGER)); si.setBehavior(ab.SeekInfo.SeekBehavior.BLOCK_UNTIL_READY); }
    return signedEnvelope(this.reader, common.HeaderType.DELIVER_SEEK_INFO, this.channel, si.serializeBinary(), { tlsCertHash: this.targets[target].tlsCertHash });
  }

  deliverStream(): Duplex { return this.client.Deliver(); }

  /**
   * One block by number, or the newest. Retries the transient SERVICE_UNAVAILABLE an orderer answers while it starts
   * or elects, and a node that cannot be reached, moving to the next endpoint each time.
   */
  async fetch(which: number | 'newest', timeoutMs = 15000): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchOnce(which, timeoutMs, this.active);
      } catch (e) {
        if (attempt >= 6 || !/SERVICE_UNAVAILABLE|UNAVAILABLE|timed out/.test((e as Error).message)) throw e;
        this.rotate(`fetch: ${(e as Error).message}`);
        await sleep(500 * (attempt + 1));
      }
    }
  }

  private fetchOnce(which: number | 'newest', timeoutMs: number, target: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const call = this.targets[target].client.Deliver();
      let done = false;
      const finish = (f: () => void): void => { if (!done) { done = true; clearTimeout(timer); call.cancel(); f(); } };
      const timer = setTimeout(() => finish(() => reject(new Error(`fetch ${which} timed out`))), timeoutMs);
      call.on('data', (buf: Buffer) => {
        const r = parseDeliverResponse(buf);
        if (r.block) finish(() => resolve(Buffer.from(r.block!)));
        else if (r.status !== 'SUCCESS') finish(() => reject(new Error(`Deliver status ${r.status}`)));
      });
      call.on('error', (e: grpc.ServiceError) => finish(() => reject(new Error(`Deliver: ${e.code === grpc.status.UNAVAILABLE ? 'UNAVAILABLE ' : ''}${e.details || e.message}`))));
      call.write(which === 'newest' ? this.seekRequest('newest', undefined, target) : this.seekRequest(which, which, target));
    });
  }

  /** Ledger height = newest block number + 1. */
  async height(): Promise<number> {
    return blockNumber(await this.fetch('newest')) + 1;
  }

  /** Every endpoint's height, without retries: an unreachable one is reported, not waited for. */
  async heights(timeoutMs = 5000): Promise<{ address: string; height?: number; error?: string }[]> {
    return Promise.all(this.targets.map(async (t, i) => {
      try { return { address: t.address, height: blockNumber(await this.fetchOnce('newest', timeoutMs, i)) + 1 }; }
      catch (e) { return { address: t.address, error: (e as Error).message.slice(0, 120) }; }
    }));
  }

  /** Move to the next endpoint that answers; with one endpoint, wait for it. Throws when none answers within `timeoutMs`. */
  async failover(why: string, timeoutMs = 60000): Promise<string> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      this.rotate(why);
      try { await this.fetchOnce('newest', 5000, this.active); return this.address; }
      catch (e) { if (Date.now() > until) throw new Error(`no orderer of ${this.addresses.join(', ')} answered within ${timeoutMs / 1000} s (last: ${(e as Error).message})`); }
      await sleep(1000);
    }
  }

  feed(from: number): BlockFeed { return new BlockFeed(this, from); }
  close(): void { this.targets.forEach((t) => t.client.close()); }
}

export class Orderer extends DeliverSource {
  constructor(eps: EndpointOpts | EndpointOpts[], channel: string, reader: Identity) {
    super(Array.isArray(eps) ? eps : [eps], (o) => new OrdererClient(o.address, creds(o), channelOpts(o)) as unknown as grpc.Client & { Deliver: () => Duplex }, channel, reader);
  }

  /** Send envelopes on a fresh stream to the active orderer; one {status, info} per envelope. Never retried here: part of a block may already be queued. */
  broadcast(envelopes: Buffer[], timeoutMs = 60000): Promise<{ status: string; info: string }[]> {
    return new Promise((resolve, reject) => {
      const out: { status: string; info: string }[] = [];
      const call = (this.client as unknown as { Broadcast: () => Duplex }).Broadcast();
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; call.cancel(); reject(Object.assign(new Error(`broadcast timed out after ${out.length}/${envelopes.length} verdicts`), { acked: out.length })); } }, timeoutMs);
      call.on('data', (buf: Buffer) => {
        const r = ab.BroadcastResponse.deserializeBinary(buf);
        out.push({ status: statusName(r.getStatus()), info: r.getInfo() });
        if (out.length === envelopes.length && !done) { done = true; clearTimeout(timer); call.end(); resolve(out); }
      });
      call.on('error', (e: Error) => { if (!done) { done = true; clearTimeout(timer); reject(Object.assign(e, { acked: out.length })); } });
      for (const e of envelopes) call.write(e);
    });
  }
}

export class Peer extends DeliverSource {
  constructor(o: EndpointOpts, channel: string, reader: Identity) {
    super([o], (x) => new PeerClient(x.address, creds(x), channelOpts(x)) as unknown as grpc.Client & { Deliver: () => Duplex }, channel, reader);
  }
}

export interface FedBlock { n: number; bytes: Buffer; at: number }

/** A persistent, self-healing stream of blocks from `from` on, handed out strictly in order. */
export class BlockFeed {
  next: number;
  private queue: FedBlock[] = [];
  private waiters: { n: number; resolve: (b: FedBlock) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private call: Duplex | null = null;
  private closed = false;
  private reconnecting = false;
  private failure: Error | null = null;
  private failsHere = 0;
  private openedOn = -1;

  constructor(private readonly src: DeliverSource, from: number) {
    this.next = from;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const call = this.src.deliverStream();
    this.call = call;
    if (this.openedOn !== this.src.activeIndex) this.failsHere = 0;
    this.openedOn = this.src.activeIndex;
    const live = (): boolean => this.call === call; // events of a stream we replaced are not ours
    call.on('data', (buf: Buffer) => {
      if (!live()) return;
      let r: { status?: string; block?: Buffer };
      try { r = parseDeliverResponse(buf); } catch (e) { return this.fail(e as Error); }
      if (r.status) {
        if (r.status === 'SUCCESS') return;
        if (r.status === 'SERVICE_UNAVAILABLE' || r.status === 'INTERNAL_SERVER_ERROR') {
          this.src.stats.streamErrors.push({ at: Date.now(), code: r.status, msg: 'status' });
          return void this.reconnect();
        }
        return this.fail(new Error(`Deliver status ${r.status}`));
      }
      const n = blockNumber(r.block!);
      if (n < this.next + this.queue.length) return; // a block we already have, replayed after a reconnect
      this.failsHere = 0;
      this.queue.push({ n, bytes: Buffer.from(r.block!), at: Date.now() });
      this.pump();
    });
    call.on('error', (e: grpc.ServiceError) => {
      if (!live()) return;
      this.src.stats.streamErrors.push({ at: Date.now(), code: String(e.code), msg: String(e.details || e.message).slice(0, 100) });
      void this.reconnect();
    });
    call.on('end', () => { if (live() && !this.closed) void this.reconnect(); });
    call.write(this.src.seekRequest(this.next + this.queue.length));
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try { this.call?.cancel(); } catch { /* gone */ }
    // A stream that failed twice in a row on one node moves to the next (any orderer serves the same chain), unless
    // someone (run, after a failed send) has already moved on: then it simply reopens there.
    if (this.src.activeIndex === this.openedOn && ++this.failsHere >= 2) { this.failsHere = 0; this.src.rotate(`Deliver stream to ${this.src.address} failed twice`); }
    await sleep(Math.min(500 * 2 ** Math.min(this.src.stats.reconnects, 5), 8000));
    this.reconnecting = false;
    this.src.stats.reconnects++;
    this.open();
  }

  /** For tests and fault drills: drop the stream as a network failure would. */
  drop(): void { this.call?.cancel(); }

  private fail(e: Error): void { this.failure = e; this.pump(); }

  private pump(): void {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.failure) { this.waiters.shift(); clearTimeout(w.timer); w.reject(this.failure); continue; }
      const i = this.queue.findIndex((b) => b.n === w.n);
      if (i < 0) break;
      const b = this.queue[i];
      this.queue = this.queue.filter((x) => x.n > b.n);
      this.next = Math.max(this.next, b.n + 1);
      this.waiters.shift();
      clearTimeout(w.timer);
      w.resolve(b);
    }
  }

  /** Block `n`, waiting up to timeoutMs (rejects with `.timeout = true`). */
  get(n: number, timeoutMs = 30000): Promise<FedBlock> {
    return new Promise((resolve, reject) => {
      const w = {
        n, resolve, reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(Object.assign(new Error(`block ${n} not delivered within ${timeoutMs} ms`), { timeout: true }));
        }, timeoutMs),
      };
      this.waiters.push(w);
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    try { this.call?.cancel(); } catch { /* gone */ }
  }
}
