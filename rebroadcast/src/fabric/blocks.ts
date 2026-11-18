// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Block decoding with @hyperledger/fabric-protos. Only the fields the tool needs are read; the raw bytes
 * (the whole block, each envelope) are kept untouched, because they are what gets re-sent and compared.
 */
import * as crypto from 'crypto';
import { common, msp, peer } from '@hyperledger/fabric-protos';
import { hex, u8 } from '../util/misc';

const HEADER: Record<number, string> = { 0: 'MESSAGE', 1: 'CONFIG', 2: 'CONFIG_UPDATE', 3: 'ENDORSER_TRANSACTION', 4: 'ORDERER_TRANSACTION', 5: 'DELIVER_SEEK_INFO', 6: 'CHAINCODE_PACKAGE' };
const CODE_NAME: Record<number, string> = Object.fromEntries(Object.entries(peer.TxValidationCode).map(([k, v]) => [v as number, k]));
export const codeName = (n: number): string => CODE_NAME[n] ?? String(n);

export interface Tx {
  index: number;
  type: string;
  txId: string;
  channel: string;
  /** Creator MSP ID; empty for orderer-produced envelopes without a creator. */
  mspId: string;
  /** Creator certificate expiry (ISO), when the creator is an X.509 identity. */
  notAfter?: string;
  /** Validation code recorded by the committing peer (metadata[2]); absent in an orderer's block. */
  code?: string;
  /** The envelope exactly as stored in the block. */
  envelope: Buffer;
  /** len(payload) + len(signature): what the orderer's block cutter counts. */
  cutterBytes: number;
}

export interface DecodedBlock {
  number: number;
  dataHash: string;
  previousHash: string;
  isConfig: boolean;
  txs: Tx[];
  /** metadata[2], the transaction filter: one validation code per tx (peer blocks only). */
  validationFlags: Buffer;
  /** metadata[4], the commit hash (peer blocks only, when enabled). */
  commitHash: string;
  /** Index of the last config block, from the orderer metadata (metadata[1] in 2.x). */
  lastConfig: number;
  raw: common.Block;
  bytes: Buffer;
}

export function decodeBlock(bytes: Uint8Array): DecodedBlock {
  const b = common.Block.deserializeBinary(bytes);
  const h = b.getHeader();
  if (!h) throw new Error('block has no header');
  const md = (b.getMetadata()?.getMetadataList() ?? []).map(u8);
  const flags = md[2] ?? Buffer.alloc(0);
  const txs: Tx[] = (b.getData()?.getDataList() ?? []).map((raw, i) => {
    const envBytes = u8(raw);
    const env = common.Envelope.deserializeBinary(envBytes);
    const pl = common.Payload.deserializeBinary(env.getPayload_asU8());
    const ph = pl.getHeader();
    const ch = ph ? common.ChannelHeader.deserializeBinary(ph.getChannelHeader_asU8()) : undefined;
    const sh = ph ? common.SignatureHeader.deserializeBinary(ph.getSignatureHeader_asU8()) : undefined;
    let mspId = '';
    let notAfter: string | undefined;
    const creator = sh?.getCreator_asU8();
    if (creator && creator.length) {
      const id = msp.SerializedIdentity.deserializeBinary(creator);
      mspId = id.getMspid();
      try {
        notAfter = new Date(new crypto.X509Certificate(u8(id.getIdBytes_asU8())).validTo).toISOString();
      } catch {
        /* not an X.509 creator */
      }
    }
    return {
      index: i,
      type: HEADER[ch?.getType() ?? -1] ?? String(ch?.getType()),
      txId: ch?.getTxId() ?? '',
      channel: ch?.getChannelId() ?? '',
      mspId,
      notAfter,
      code: i < flags.length ? codeName(flags[i]) : undefined,
      envelope: envBytes,
      cutterBytes: env.getPayload_asU8().length + env.getSignature_asU8().length,
    };
  });
  let lastConfig = 0;
  if (md[1] && md[1].length) {
    try {
      const m = common.Metadata.deserializeBinary(md[1]);
      lastConfig = common.LastConfig.deserializeBinary(m.getValue_asU8()).getIndex();
    } catch {
      /* not present */
    }
  }
  let commitHash = '';
  if (md[4] && md[4].length) {
    try {
      commitHash = hex(common.Metadata.deserializeBinary(md[4]).getValue_asU8());
    } catch {
      /* not present */
    }
  }
  return {
    number: Number(h.getNumber()),
    dataHash: hex(h.getDataHash_asU8()),
    previousHash: hex(h.getPreviousHash_asU8()),
    isConfig: txs.length === 1 && txs[0].type === 'CONFIG',
    txs,
    validationFlags: flags,
    commitHash,
    lastConfig,
    raw: b,
    bytes: Buffer.from(bytes),
  };
}

/** The channel a block belongs to: the channel header of its first envelope. */
export function blockChannel(bytes: Uint8Array): string {
  const d = decodeBlock(bytes);
  return d.txs[0]?.channel ?? '';
}

/** SHA-256 over the ASN.1 DER header (number, previous_hash, data_hash): what the next block's previous_hash holds. */
export function headerHash(number: number, previousHash: Buffer, dataHash: Buffer): string {
  const len = (tag: number, n: number): Buffer =>
    n < 128 ? Buffer.from([tag, n]) : n < 256 ? Buffer.from([tag, 0x81, n]) : Buffer.from([tag, 0x82, (n >> 8) & 0xff, n & 0xff]);
  const int = (v: number): Buffer => {
    let h = BigInt(v).toString(16);
    if (h.length % 2) h = '0' + h;
    let b = Buffer.from(h, 'hex');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([len(0x02, b.length), b]);
  };
  const oct = (b: Buffer): Buffer => Buffer.concat([len(0x04, b.length), b]);
  const body = Buffer.concat([int(number), oct(previousHash), oct(dataHash)]);
  return crypto.createHash('sha256').update(Buffer.concat([len(0x30, body.length), body])).digest('hex');
}

/** SHA-256 over the concatenated envelopes: what the header's data_hash must be. */
export function computedDataHash(b: DecodedBlock): string {
  return crypto.createHash('sha256').update(Buffer.concat(b.txs.map((t) => t.envelope))).digest('hex');
}
