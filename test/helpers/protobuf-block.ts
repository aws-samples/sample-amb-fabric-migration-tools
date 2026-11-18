// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Encode the decoded-block objects the walker tests build into the protobuf
 * bytes qscc actually serves.
 *
 * The walker accepts only protobuf, because its content check hashes the raw
 * envelope bytes against the header's `data_hash`. Tests describe blocks in the
 * decoded shape (`header`, `data.data[i].payload…`, `metadata.metadata`) since
 * that is what they assert on; these helpers turn that shape into real bytes.
 *
 * `sealBlock` sets `header.data_hash` to the hash of the block's encoded
 * transactions, which is what makes a block self-consistent. A test that
 * changes a block's contents afterwards without resealing it is building the
 * tampered block the walker must refuse.
 */
import * as crypto from 'crypto';

const fp = require('fabric-protos');

/** Bytes from any form a test fixture holds them in. */
function bytes(v: unknown): Buffer {
  if (v === undefined || v === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'utf-8');
  if (Array.isArray(v)) return Buffer.from(v);
  const asJsonBuffer = v as { type?: string; data?: number[] };
  if (asJsonBuffer.type === 'Buffer' && Array.isArray(asJsonBuffer.data)) return Buffer.from(asJsonBuffer.data);
  throw new Error(`protobuf-block: cannot turn ${JSON.stringify(v)} into bytes`);
}

function hex(v: string | undefined): Buffer {
  return v ? Buffer.from(v, 'hex') : Buffer.alloc(0);
}

function timestamp(iso: string | undefined): any {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return fp.google.protobuf.Timestamp.create({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 });
}

function encodeNsRwSet(ns: any): any {
  const kv = fp.kvrwset.KVRWSet.encode(fp.kvrwset.KVRWSet.create({
    writes: (ns.rwset?.writes ?? []).map((w: any) => fp.kvrwset.KVWrite.create({
      key: w.key ?? '', value: bytes(w.value), is_delete: w.is_delete ?? false,
    })),
  })).finish();

  const hashed = (ns.collection_hashed_rwset ?? []).map((c: any) => fp.rwset.CollectionHashedReadWriteSet.create({
    collection_name: c.collection_name ?? '',
    hashed_rwset: fp.kvrwset.HashedRWSet.encode(fp.kvrwset.HashedRWSet.create({
      hashed_writes: (c.hashed_rwset?.hashed_writes ?? []).map((hw: any) => fp.kvrwset.KVWriteHash.create({
        key_hash: bytes(hw.key_hash), value_hash: bytes(hw.value_hash), is_delete: hw.is_delete ?? false,
      })),
    })).finish(),
  }));

  return fp.rwset.NsReadWriteSet.create({ namespace: ns.namespace ?? '', rwset: kv, collection_hashed_rwset: hashed });
}

function encodeAction(action: any): any {
  const p = action?.payload ?? {};
  const name = p.chaincode_proposal_payload?.input?.chaincode_spec?.chaincode_id?.name;
  const cpp = name === undefined ? Buffer.alloc(0) : fp.protos.ChaincodeProposalPayload.encode(
    fp.protos.ChaincodeProposalPayload.create({
      input: fp.protos.ChaincodeInvocationSpec.encode(fp.protos.ChaincodeInvocationSpec.create({
        chaincode_spec: fp.protos.ChaincodeSpec.create({ chaincode_id: fp.protos.ChaincodeID.create({ name }) }),
      })).finish(),
    }),
  ).finish();

  const results = fp.rwset.TxReadWriteSet.encode(fp.rwset.TxReadWriteSet.create({
    data_model: 0,
    ns_rwset: (p.action?.proposal_response_payload?.extension?.results?.ns_rwset ?? []).map(encodeNsRwSet),
  })).finish();
  const prp = fp.protos.ProposalResponsePayload.encode(fp.protos.ProposalResponsePayload.create({
    extension: fp.protos.ChaincodeAction.encode(fp.protos.ChaincodeAction.create({ results })).finish(),
  })).finish();

  return fp.protos.TransactionAction.create({
    payload: fp.protos.ChaincodeActionPayload.encode(fp.protos.ChaincodeActionPayload.create({
      chaincode_proposal_payload: cpp,
      action: fp.protos.ChaincodeEndorsedAction.create({ proposal_response_payload: prp }),
    })).finish(),
  });
}

/** One transaction envelope, from its decoded shape. */
export function encodeEnvelope(tx: any): Uint8Array {
  const header = tx?.payload?.header ?? {};
  const ch = header.channel_header ?? {};
  const actions = tx?.payload?.data?.actions ?? [];
  const creator = header.signature_header?.creator;

  const channelHeader = fp.common.ChannelHeader.encode(fp.common.ChannelHeader.create({
    type: ch.type ?? 3, // ENDORSER_TRANSACTION unless the fixture says otherwise
    tx_id: ch.tx_id ?? '',
    timestamp: timestamp(ch.timestamp),
    channel_id: ch.channel_id ?? '',
  })).finish();
  const signatureHeader = fp.common.SignatureHeader.encode(fp.common.SignatureHeader.create({
    creator: creator ? fp.msp.SerializedIdentity.encode(fp.msp.SerializedIdentity.create({
      mspid: creator.mspid ?? '', id_bytes: bytes(creator.id_bytes),
    })).finish() : Buffer.alloc(0),
  })).finish();

  const payload = fp.common.Payload.encode(fp.common.Payload.create({
    header: fp.common.Header.create({ channel_header: channelHeader, signature_header: signatureHeader }),
    data: fp.protos.Transaction.encode(fp.protos.Transaction.create({ actions: actions.map(encodeAction) })).finish(),
  })).finish();

  return fp.common.Envelope.encode(fp.common.Envelope.create({ payload })).finish();
}

function envelopesOf(block: any): Uint8Array[] {
  return (block.data?.data ?? []).map((tx: any) => (tx instanceof Uint8Array ? tx : encodeEnvelope(tx)));
}

/** SHA-256 over the block's encoded envelopes, as Fabric computes `data_hash`. */
export function blockDataHash(block: any): string {
  const hash = crypto.createHash('sha256');
  for (const envelope of envelopesOf(block)) hash.update(envelope);
  return hash.digest('hex');
}

/** Set the block's `data_hash` from its contents, and return it. */
export function sealBlock<T>(block: T): T {
  (block as any).header.data_hash = blockDataHash(block);
  return block;
}

/**
 * The block as qscc serves it. The header is encoded as given, so a block whose
 * contents were changed after `sealBlock` keeps its stale `data_hash`.
 * `data.data` entries may be decoded transactions or raw envelope bytes.
 */
export function encodeBlock(block: any): Buffer {
  const metadata = (block.metadata?.metadata ?? []).map((m: unknown) => bytes(m));
  while (metadata.length < 4) metadata.push(Buffer.alloc(0));

  return Buffer.from(fp.common.Block.encode(fp.common.Block.create({
    header: fp.common.BlockHeader.create({
      number: Number(block.header?.number ?? 0),
      previous_hash: hex(block.header?.previous_hash),
      data_hash: hex(block.header?.data_hash),
    }),
    data: fp.common.BlockData.create({ data: envelopesOf(block) }),
    metadata: fp.common.BlockMetadata.create({ metadata }),
  })).finish());
}
