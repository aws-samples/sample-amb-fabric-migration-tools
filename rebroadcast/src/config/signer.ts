/**
 * Signing without the `peer` binary: ECDSA P-256 / SHA-256, DER, low-S (Fabric rejects high-S; Node returns one about
 * half the time — measured 50.5–51.3 % of 2,000), ConfigSignature, the CONFIG_UPDATE envelope, the cut marker.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { common, msp } from '@hyperledger/fabric-protos';
import { Timestamp } from 'google-protobuf/google/protobuf/timestamp_pb';
import { u8 } from '../util/misc';

const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551'); // P-256 group order
export const N_HALF = N >> 1n;
const big = (b: Uint8Array): bigint => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
function derInt(v: bigint): Buffer {
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([2, b.length]), b]);
}
export const derSig = (r: bigint, s: bigint): Buffer => {
  const a = derInt(r), b = derInt(s);
  return Buffer.concat([Buffer.from([0x30, a.length + b.length]), a, b]);
};
/** {r, s} of a DER ECDSA P-256 signature. */
export function parseDer(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30 || der[2] !== 0x02) throw new Error('not a DER ECDSA signature');
  const rl = der[3], sl = der[5 + rl];
  return { r: big(der.subarray(4, 4 + rl)), s: big(der.subarray(6 + rl, 6 + rl + sl)) };
}

/** ieee-p1363 output gives r and s directly; s is folded into the lower half. */
export function signLowS(key: crypto.KeyObject, data: Uint8Array): Buffer {
  const raw = crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  const r = big(raw.subarray(0, 32));
  let s = big(raw.subarray(32));
  if (s > N_HALF) s = N - s;
  return derSig(r, s);
}

/** Fabric's rule: a valid ECDSA signature with s <= N/2. */
export function verifyFabric(certPem: Uint8Array, data: Uint8Array, der: Uint8Array): { ok: boolean; why: string } {
  if (parseDer(der).s > N_HALF) return { ok: false, why: 'high-S' };
  const ok = crypto.verify('sha256', data, new crypto.X509Certificate(Buffer.from(certPem)).publicKey, der);
  return { ok, why: ok ? '' : 'signature does not verify' };
}

export interface Identity {
  mspId: string;
  certPem: Buffer;
  key: crypto.KeyObject;
  /** SerializedIdentity bytes. */
  creator: Buffer;
}

export function identity(mspId: string, certFile: string, keyFile: string): Identity {
  const certPem = fs.readFileSync(certFile);
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const cert = new crypto.X509Certificate(certPem);
  if (!cert.checkPrivateKey(key)) throw new Error(`${path.basename(keyFile)} is not the key of ${path.basename(certFile)}`);
  const id = new msp.SerializedIdentity();
  id.setMspid(mspId);
  id.setIdBytes(certPem);
  return { mspId, certPem, key, creator: Buffer.from(id.serializeBinary()) };
}

export function signatureHeader(id: Identity, nonce = crypto.randomBytes(24)): Buffer {
  const sh = new common.SignatureHeader();
  sh.setCreator(id.creator);
  sh.setNonce(nonce);
  return Buffer.from(sh.serializeBinary());
}

/** ConfigSignature over (signature_header || config_update), as `peer channel signconfigtx` makes it. */
export function configSignature(id: Identity, updateBytes: Uint8Array): common.ConfigSignature {
  const sh = signatureHeader(id);
  const sig = new common.ConfigSignature();
  sig.setSignatureHeader(sh);
  sig.setSignature(signLowS(id.key, Buffer.concat([sh, Buffer.from(updateBytes)])));
  return sig;
}

/** Who signed a ConfigSignature, and does it hold over these update bytes. */
export function checkConfigSignature(sig: common.ConfigSignature, updateBytes: Uint8Array): { mspId: string; certPem: Buffer; ok: boolean; why: string } {
  const sh = common.SignatureHeader.deserializeBinary(sig.getSignatureHeader_asU8());
  const who = msp.SerializedIdentity.deserializeBinary(sh.getCreator_asU8());
  const certPem = u8(who.getIdBytes_asU8());
  return { mspId: who.getMspid(), certPem, ...verifyFabric(certPem, Buffer.concat([u8(sig.getSignatureHeader_asU8()), Buffer.from(updateBytes)]), sig.getSignature_asU8()) };
}

export function channelHeader(type: number, channel: string, txId = '', tlsCertHash?: Buffer, extension?: Uint8Array): Buffer {
  const now = Date.now();
  const ts = new Timestamp();
  ts.setSeconds(Math.floor(now / 1000));
  ts.setNanos((now % 1000) * 1e6);
  const ch = new common.ChannelHeader();
  ch.setType(type);
  ch.setVersion(0);
  ch.setChannelId(channel);
  ch.setTxId(txId);
  ch.setEpoch(0);
  ch.setTimestamp(ts);
  if (tlsCertHash) ch.setTlsCertHash(tlsCertHash);
  if (extension) ch.setExtension$(extension);
  return Buffer.from(ch.serializeBinary());
}

/** A signed envelope: header type, channel, data, signed by `id`. */
export function signedEnvelope(id: Identity, type: number, channel: string, data: Uint8Array, opts: { txId?: boolean; tlsCertHash?: Buffer } = {}): Buffer {
  const nonce = crypto.randomBytes(24);
  const txId = opts.txId ? crypto.createHash('sha256').update(Buffer.concat([nonce, id.creator])).digest('hex') : ''; // protoutil.ComputeTxID
  const hdr = new common.Header();
  hdr.setChannelHeader(channelHeader(type, channel, txId, opts.tlsCertHash));
  hdr.setSignatureHeader(signatureHeader(id, nonce));
  const pl = new common.Payload();
  pl.setHeader(hdr);
  pl.setData(data);
  const payload = Buffer.from(pl.serializeBinary());
  const env = new common.Envelope();
  env.setPayload(payload);
  env.setSignature(signLowS(id.key, payload));
  return Buffer.from(env.serializeBinary());
}

/** The CONFIG_UPDATE envelope: the update plus its signatures, itself signed by the submitter. */
export function configUpdateEnvelope(submitter: Identity, channel: string, updateBytes: Uint8Array, sigs: common.ConfigSignature[]): Buffer {
  const cue = new common.ConfigUpdateEnvelope();
  cue.setConfigUpdate(updateBytes);
  cue.setSignaturesList(sigs);
  return signedEnvelope(submitter, common.HeaderType.CONFIG_UPDATE, channel, cue.serializeBinary(), { txId: true });
}

/** The MESSAGE envelope the patched orderer treats as "cut the block here" and never writes (design §4.1). */
export function cutMarker(id: Identity, channel: string): Buffer {
  return signedEnvelope(id, common.HeaderType.MESSAGE, channel, Buffer.from('fabric-migration-cut'));
}

/** Does `certPem` chain directly to one of these base64 roots (as in an MSP config)? */
export function chainsTo(certPem: Uint8Array, rootsB64: string[]): boolean {
  const c = new crypto.X509Certificate(Buffer.from(certPem));
  return rootsB64.some((r) => {
    const root = new crypto.X509Certificate(Buffer.from(r, 'base64'));
    return c.checkIssued(root) && c.verify(root.publicKey);
  });
}
