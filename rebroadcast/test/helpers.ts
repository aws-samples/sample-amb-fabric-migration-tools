// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { common, msp } from '@hyperledger/fabric-protos';

/** A throwaway P-256 CA and an admin certificate it issued (openssl), plus an unrelated key. */
export function makePki(): { dir: string; caCert: string; cert: string; key: string; otherKey: string; caB64: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-pki-'));
  const f = (n: string): string => path.join(dir, n);
  const run = (...a: string[]): void => { execFileSync('openssl', a, { stdio: 'pipe' }); };
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('ca.key'));
  run('req', '-new', '-x509', '-key', f('ca.key'), '-subj', '/CN=test-ca', '-days', '30', '-out', f('ca.pem'));
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('admin.ec'));
  run('pkcs8', '-topk8', '-nocrypt', '-in', f('admin.ec'), '-out', f('admin.key'));
  run('req', '-new', '-key', f('admin.key'), '-subj', '/CN=admin', '-out', f('admin.csr'));
  run('x509', '-req', '-in', f('admin.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '30', '-out', f('admin.pem'));
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('other.ec'));
  run('pkcs8', '-topk8', '-nocrypt', '-in', f('other.ec'), '-out', f('other.key'));
  return {
    dir, caCert: f('ca.pem'), cert: f('admin.pem'), key: f('admin.key'), otherKey: f('other.key'),
    caB64: fs.readFileSync(f('ca.pem')).toString('base64'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** An envelope on `channel` with a creator, as an endorser transaction would carry (the signature is filler). */
export function envelope(channel: string, txId: string, type: number = common.HeaderType.ENDORSER_TRANSACTION, data = Buffer.from(txId)): Buffer {
  const ch = new common.ChannelHeader();
  ch.setType(type as common.HeaderTypeMap[keyof common.HeaderTypeMap]);
  ch.setChannelId(channel);
  ch.setTxId(txId);
  const id = new msp.SerializedIdentity();
  id.setMspid('OrgA');
  id.setIdBytes(Buffer.from('not a certificate'));
  const sh = new common.SignatureHeader();
  sh.setCreator(id.serializeBinary());
  sh.setNonce(Buffer.from('n'));
  const h = new common.Header();
  h.setChannelHeader(ch.serializeBinary());
  h.setSignatureHeader(sh.serializeBinary());
  const pl = new common.Payload();
  pl.setHeader(h);
  pl.setData(data);
  const env = new common.Envelope();
  env.setPayload(pl.serializeBinary());
  env.setSignature(Buffer.from('sig'));
  return Buffer.from(env.serializeBinary());
}

/** A hash-linked chain of blocks: block 0 holds a CONFIG envelope, the rest `txPerBlock` transactions each. */
export function chain(channel: string, height: number, txPerBlock = 2): Buffer[] {
  const { headerHash } = require('../src/fabric/blocks') as typeof import('../src/fabric/blocks');
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let n = 0; n < height; n++) {
    const envs = n === 0 ? [envelope(channel, '', common.HeaderType.CONFIG)] : Array.from({ length: txPerBlock }, (_, i) => envelope(channel, `tx-${n}-${i}`));
    const dataHash = crypto.createHash('sha256').update(Buffer.concat(envs)).digest();
    const hdr = new common.BlockHeader();
    hdr.setNumber(n);
    hdr.setPreviousHash(prev);
    hdr.setDataHash(dataHash);
    const data = new common.BlockData();
    data.setDataList(envs);
    const md = new common.BlockMetadata();
    md.setMetadataList([Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(envs.length), Buffer.alloc(0), Buffer.alloc(0)]);
    const b = new common.Block();
    b.setHeader(hdr);
    b.setData(data);
    b.setMetadata(md);
    out.push(Buffer.from(b.serializeBinary()));
    prev = Buffer.from(headerHash(n, prev, dataHash), 'hex');
  }
  return out;
}

/** Write an archive in the layout `extract --save-blocks` produces. */
export function writeArchive(root: string, channel: string, blocks: Buffer[]): string {
  const dir = path.join(root, channel);
  fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  const lines: string[] = [];
  blocks.forEach((b, n) => {
    fs.writeFileSync(path.join(dir, 'blocks', `${n}.block`), b);
    lines.push(`${crypto.createHash('sha256').update(b).digest('hex')}  ${n}.block`);
  });
  const digest = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'blocks', 'blocks.sha256'), digest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 1, kind: 'fabric-block-archive', channel, firstBlock: 0, lastBlock: blocks.length - 1, blockCount: blocks.length, ledgerHeight: blocks.length,
    digestFile: 'blocks.sha256', digestFileSha256: crypto.createHash('sha256').update(digest).digest('hex'), complete: true,
  }));
  return dir;
}
