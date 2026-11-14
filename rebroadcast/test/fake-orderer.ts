/**
 * An in-process stand-in for an ordering service, enough to drive `run` through its invariants:
 * Broadcast (one verdict per envelope, optional rejections and faults), a block cutter (a batch closes `batchMs` after
 * its last envelope, or at `maxCount` envelopes), and Deliver (newest / one block / follow from N). Several nodes can
 * share one chain, as a Raft cluster's do.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as grpc from '@grpc/grpc-js';
import { common, orderer as ab } from '@hyperledger/fabric-protos';
import { headerHash } from '../src/fabric/blocks';

const ident = (b: Buffer): Buffer => b;
const duplex = (p: string) => ({ path: p, requestStream: true, responseStream: true, requestSerialize: ident, requestDeserialize: ident, responseSerialize: ident, responseDeserialize: ident });

export interface FakeOpts {
  batchMs?: number; maxCount?: number; reject?: (env: Buffer, i: number) => string | null;
  /** called once, on the first `newest` request */ onFirstNewest?: () => void;
  /** crash this node when it has received this many envelopes: 'lost' = what it accepted in that stream never reaches the chain; 'forwarded' = it does */
  crashAt?: { envelope: number; fate: 'lost' | 'forwarded'; afterVerdict?: boolean };
  /** answer SERVICE_UNAVAILABLE (and keep nothing) for envelopes with index in [from, to) */
  unavailable?: { from: number; to: number };
}

/** The ordered chain several nodes share, as the nodes of one Raft cluster do: one block cutter, one ledger. */
export class FakeChain {
  blocks: Buffer[] = [];
  pending: Buffer[] = [];
  private timer?: NodeJS.Timeout;
  followers = new Set<{ call: grpc.ServerDuplexStream<Buffer, Buffer>; next: number }>();
  nodes = 0;
  constructor(genesis: Buffer, private o: { batchMs?: number; maxCount?: number } = {}) { this.blocks.push(genesis); }

  enqueue(env: Buffer): void {
    this.pending.push(env);
    clearTimeout(this.timer);
    if (this.o.maxCount && this.pending.length >= this.o.maxCount) return this.cut();
    this.timer = setTimeout(() => this.cut(), this.o.batchMs ?? 40);
  }
  /** Close the current batch into a block (also used by tests to inject a stray block). */
  cut(envs?: Buffer[]): void {
    const data = envs ?? this.pending.filter((e) => !isCutMarker(e));
    if (!envs) this.pending = [];
    if (!data.length) return;
    const n = this.blocks.length;
    const prev = common.Block.deserializeBinary(this.blocks[n - 1]).getHeader()!;
    const prevHash = Buffer.from(headerHash(n - 1, Buffer.from(prev.getPreviousHash_asU8()), Buffer.from(prev.getDataHash_asU8())), 'hex');
    const hdr = new common.BlockHeader();
    hdr.setNumber(n); hdr.setPreviousHash(prevHash); hdr.setDataHash(crypto.createHash('sha256').update(Buffer.concat(data)).digest());
    const bd = new common.BlockData(); bd.setDataList(data);
    const md = new common.BlockMetadata(); md.setMetadataList([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)]);
    const b = new common.Block(); b.setHeader(hdr); b.setData(bd); b.setMetadata(md);
    this.blocks.push(Buffer.from(b.serializeBinary()));
    for (const f of this.followers) this.flush(f);
  }
  flush(f: { call: grpc.ServerDuplexStream<Buffer, Buffer>; next: number }): void {
    while (f.next < this.blocks.length) f.call.write(blockResponse(this.blocks[f.next++]));
  }
  stop(): void { clearTimeout(this.timer); }
}

/** One orderer node: Broadcast (one verdict per envelope, optional rejections and faults) and Deliver, over a chain. */
export class FakeOrderer {
  readonly chain: FakeChain;
  private server = new grpc.Server();
  private mine = new Set<{ call: grpc.ServerDuplexStream<Buffer, Buffer>; next: number }>();
  received = 0;
  port = 0;
  stopped = false;

  constructor(genesis: Buffer | FakeChain, private o: FakeOpts = {}) {
    this.chain = genesis instanceof FakeChain ? genesis : new FakeChain(genesis, o);
    this.chain.nodes++;
    this.server.addService({ Broadcast: duplex('/orderer.AtomicBroadcast/Broadcast'), Deliver: duplex('/orderer.AtomicBroadcast/Deliver') } as unknown as grpc.ServiceDefinition, {
      Broadcast: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
        const accepted: Buffer[] = [];
        call.on('data', (env: Buffer) => {
          if (this.stopped) return;
          const i = this.received++;
          const r = new ab.BroadcastResponse();
          const why = this.o.reject?.(env, i);
          if (why) { r.setStatus(common.Status.BAD_REQUEST); r.setInfo(why); }
          else if (this.o.unavailable && i >= this.o.unavailable.from && i < this.o.unavailable.to) { r.setStatus(common.Status.SERVICE_UNAVAILABLE); r.setInfo('no Raft leader'); }
          else { r.setStatus(common.Status.SUCCESS); this.chain.enqueue(env); accepted.push(env); }
          const crash = this.o.crashAt && this.received === this.o.crashAt.envelope ? this.o.crashAt : undefined;
          if (!crash || crash.afterVerdict) call.write(Buffer.from(r.serializeBinary()));
          if (crash) {
            if (crash.fate === 'lost') this.chain.pending = this.chain.pending.filter((e) => !accepted.includes(e));
            // after the last verdict the client may already have ended the stream; die a moment later, as a crash would
            if (crash.afterVerdict) setTimeout(() => this.stop(), 5); else this.stop();
          }
        });
        call.on('end', () => call.end());
        call.on('error', () => undefined);
      },
      Deliver: (call: grpc.ServerDuplexStream<Buffer, Buffer>) => {
        call.on('data', (envBytes: Buffer) => this.seek(call, envBytes));
        call.on('error', () => undefined);
      },
    });
  }

  get blocks(): Buffer[] { return this.chain.blocks; }
  cut(envs?: Buffer[]): void { this.chain.cut(envs); }

  async start(pki: { serverCert: string; serverKey: string; caCert: string }): Promise<void> {
    const creds = grpc.ServerCredentials.createSsl(fs.readFileSync(pki.caCert), [{ cert_chain: fs.readFileSync(pki.serverCert), private_key: fs.readFileSync(pki.serverKey) }], false);
    this.port = await new Promise((res, rej) => this.server.bindAsync('127.0.0.1:0', creds, (e, p) => (e ? rej(e) : res(p))));
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const f of this.mine) this.chain.followers.delete(f);
    this.server.forceShutdown();
    if (--this.chain.nodes === 0) this.chain.stop();
  }

  private seek(call: grpc.ServerDuplexStream<Buffer, Buffer>, envBytes: Buffer): void {
    const blocks = this.chain.blocks;
    const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(envBytes).getPayload_asU8());
    const si = ab.SeekInfo.deserializeBinary(pl.getData_asU8());
    const pos = (p: ab.SeekPosition | undefined): number => (p?.hasNewest() ? blocks.length - 1 : Number(p?.getSpecified()?.getNumber() ?? 0));
    if (si.getStart()?.hasNewest() && this.o.onFirstNewest) { const f = this.o.onFirstNewest; this.o.onFirstNewest = undefined; f(); }
    const start = pos(si.getStart()), stop = pos(si.getStop());
    if (si.getBehavior() === ab.SeekInfo.SeekBehavior.FAIL_IF_NOT_READY) {
      for (let n = start; n <= Math.min(stop, blocks.length - 1); n++) call.write(blockResponse(blocks[n]));
      call.write(Buffer.from([0x08, ...varint(start < blocks.length ? common.Status.SUCCESS : common.Status.NOT_FOUND)]));
      return;
    }
    const f = { call, next: start };
    this.chain.followers.add(f);
    this.mine.add(f);
    call.on('cancelled', () => { this.chain.followers.delete(f); this.mine.delete(f); });
    this.chain.flush(f);
  }
}

function varint(n: number): number[] { const out: number[] = []; while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return out; }
function blockResponse(b: Buffer): Buffer { return Buffer.concat([Buffer.from([0x12, ...varint(b.length)]), b]); }
function isCutMarker(env: Buffer): boolean {
  const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(env).getPayload_asU8());
  return common.ChannelHeader.deserializeBinary(pl.getHeader()!.getChannelHeader_asU8()).getType() === common.HeaderType.MESSAGE;
}

/** A server certificate for "localhost", issued by the test CA. */
export function serverCert(pkiDir: string): { serverCert: string; serverKey: string } {
  const f = (n: string): string => path.join(pkiDir, n);
  const run = (...a: string[]): void => { execFileSync('openssl', a, { stdio: 'pipe' }); };
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('srv.ec'));
  run('pkcs8', '-topk8', '-nocrypt', '-in', f('srv.ec'), '-out', f('srv.key'));
  run('req', '-new', '-key', f('srv.key'), '-subj', '/CN=localhost', '-out', f('srv.csr'));
  fs.writeFileSync(f('srv.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', f('srv.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '30', '-extfile', f('srv.ext'), '-out', f('srv.pem'));
  return { serverCert: f('srv.pem'), serverKey: f('srv.key') };
}
