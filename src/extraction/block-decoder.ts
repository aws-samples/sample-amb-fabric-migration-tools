import * as crypto from 'crypto';
import { ExtractionError } from '../utils/errors';
import { createLogger } from '../utils/logger';

const logger = createLogger('block-decoder');

// Lazy-loaded fabric-protos (transitive dep via fabric-ca-client).
// Same pattern as channel-discoverer.ts and legacy-fabric-gateway.ts.
let fabproto6: any = null;
function getFabricProtos(): any {
  if (!fabproto6) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fabproto6 = require('fabric-protos');
    } catch {
      throw new ExtractionError(
        'fabric-protos package is required for protobuf block decoding. ' +
          'It should be installed as a transitive dependency of fabric-ca-client.',
      );
    }
  }
  return fabproto6;
}

/**
 * Decode raw protobuf block bytes into the JSON structure that
 * BlockParser.parseBlock() and FabricVersionDetector expect.
 *
 * Replaces the internal fabric-common/lib/BlockDecoder dependency
 * with direct protobuf decoding via fabric-protos.
 */
export function decodeProtobufBlock(buf: Buffer): any {
  const fp = getFabricProtos();

  let blockProto: any;
  try {
    blockProto = fp.common.Block.decode(buf);
  } catch (err) {
    throw new ExtractionError(
      `Failed to decode protobuf block: ${(err as Error).message}`,
    );
  }

  const header = decodeBlockHeader(blockProto.header);
  verifyBlockDataHash(header, blockProto.data?.data ?? []);

  return {
    header,
    data: decodeBlockData(fp, blockProto.data),
    metadata: decodeBlockMetadata(blockProto.metadata),
  };
}

/**
 * Refuse a block whose transactions are not the ones its header commits to.
 *
 * The walk's hash chain links each header to the one before it, but a header
 * covers its transactions only through `data_hash`. Without this check a block
 * could carry any transactions under a correct header and still pass the chain
 * check. Fabric computes the hash as SHA-256 over the envelope bytes joined in
 * order (`protoutil.BlockDataHash` in 2.x, `BlockData.Hash` in 1.4).
 *
 * @param header Decoded header, hashes as hex.
 * @param envelopes The block's raw envelope bytes, in block order.
 * @throws ExtractionError if the hashes differ.
 */
function verifyBlockDataHash(
  header: { number?: number; data_hash?: string },
  envelopes: Uint8Array[],
): void {
  const hash = crypto.createHash('sha256');
  for (const envelope of envelopes) hash.update(envelope);
  const computed = hash.digest('hex');

  if (computed !== header.data_hash) {
    throw new ExtractionError(
      `Block ${header.number ?? '?'}: its ${envelopes.length} transaction(s) hash ` +
        `to ${computed}, but its header records data_hash ` +
        `${header.data_hash || '(none)'}. The peer served transactions that are ` +
        'not the ones the block header commits to, so nothing can be extracted ' +
        'from this block.',
    );
  }
}

function decodeBlockHeader(header: any): any {
  if (!header) return {};
  return {
    number: toLong(header.number),
    previous_hash: toHex(header.previous_hash),
    data_hash: toHex(header.data_hash),
  };
}

/**
 * Decode every envelope, keeping each at its position in the block.
 *
 * The position is what the TRANSACTIONS_FILTER is indexed by, so an envelope
 * that cannot be decoded keeps its slot as `{ decodeError }` rather than being
 * dropped. Dropping it would shift every later transaction onto its
 * neighbour's validation code. Whether the failure matters is the parser's
 * call: a transaction the peer marked invalid can hold a malformed envelope,
 * and a valid one cannot be skipped.
 */
function decodeBlockData(fp: any, data: any): any {
  if (!data?.data) return { data: [] };

  const envelopes = data.data.map((envBytes: Uint8Array) => {
    try {
      return decodeEnvelope(fp, envBytes);
    } catch (err) {
      return { decodeError: (err as Error).message };
    }
  });

  return { data: envelopes };
}

function decodeBlockMetadata(metadata: any): any {
  if (!metadata?.metadata) return { metadata: [] };

  const result: any[] = [];
  for (let i = 0; i < metadata.metadata.length; i++) {
    if (i === 2 && metadata.metadata[2]) {
      // TRANSACTIONS_FILTER: convert to number array
      result.push(Array.from(metadata.metadata[2]));
    } else {
      result.push(metadata.metadata[i]);
    }
  }
  return { metadata: result };
}

function decodeEnvelope(fp: any, envBytes: Uint8Array): any {
  const envelope = fp.common.Envelope.decode(envBytes);
  const payload = fp.common.Payload.decode(envelope.payload);
  const header = decodePayloadHeader(fp, payload.header);
  const type = header?.channel_header?.type ?? 0;

  let payloadData: any = null;
  if (type === 3 && payload.data?.length) {
    payloadData = decodeEndorserTx(fp, payload.data);
  } else if (type === 1 && payload.data?.length) {
    payloadData = decodeConfigPayload(fp, payload.data);
  }

  return {
    payload: {
      header,
      data: payloadData,
    },
  };
}

function decodePayloadHeader(fp: any, header: any): any {
  if (!header) return {};

  const channelHeader = header.channel_header?.length
    ? decodeChannelHeader(fp, header.channel_header)
    : {};

  const signatureHeader = header.signature_header?.length
    ? decodeSignatureHeader(fp, header.signature_header)
    : {};

  return { channel_header: channelHeader, signature_header: signatureHeader };
}

function decodeChannelHeader(fp: any, bytes: Uint8Array): any {
  const ch = fp.common.ChannelHeader.decode(bytes);
  return {
    type: ch.type,
    version: ch.version,
    timestamp: timestampToString(ch.timestamp),
    channel_id: ch.channel_id,
    tx_id: ch.tx_id,
    epoch: toLong(ch.epoch),
  };
}

function decodeSignatureHeader(fp: any, bytes: Uint8Array): any {
  const sh = fp.common.SignatureHeader.decode(bytes);
  const creator = sh.creator?.length
    ? decodeSerializedIdentity(fp, sh.creator)
    : { mspid: '', id_bytes: Buffer.alloc(0) };
  return { creator, nonce: sh.nonce };
}

function decodeSerializedIdentity(fp: any, bytes: Uint8Array): any {
  const id = fp.msp.SerializedIdentity.decode(bytes);
  return { mspid: id.mspid, id_bytes: id.id_bytes };
}

function decodeEndorserTx(fp: any, data: Uint8Array): any {
  const tx = fp.protos.Transaction.decode(data);
  const actions = (tx.actions ?? []).map((action: any) => {
    return decodeTxAction(fp, action);
  });
  return { actions };
}

function decodeTxAction(fp: any, action: any): any {
  const cap = fp.protos.ChaincodeActionPayload.decode(action.payload);

  const proposalPayload = cap.chaincode_proposal_payload?.length
    ? decodeChaincodeProposalPayload(fp, cap.chaincode_proposal_payload)
    : {};

  const endorsedAction = cap.action
    ? decodeEndorsedAction(fp, cap.action)
    : {};

  return {
    payload: {
      chaincode_proposal_payload: proposalPayload,
      action: endorsedAction,
    },
  };
}

function decodeChaincodeProposalPayload(fp: any, bytes: Uint8Array): any {
  const cpp = fp.protos.ChaincodeProposalPayload.decode(bytes);
  if (!cpp.input?.length) return {};

  const invSpec = fp.protos.ChaincodeInvocationSpec.decode(cpp.input);
  return {
    input: {
      chaincode_spec: {
        chaincode_id: {
          name: invSpec.chaincode_spec?.chaincode_id?.name ?? '',
        },
      },
    },
  };
}

function decodeEndorsedAction(fp: any, action: any): any {
  if (!action.proposal_response_payload?.length) return {};

  const prp = fp.protos.ProposalResponsePayload.decode(
    action.proposal_response_payload,
  );

  if (!prp.extension?.length) {
    return { proposal_response_payload: { extension: {} } };
  }

  const ccAction = fp.protos.ChaincodeAction.decode(prp.extension);
  const results = ccAction.results?.length
    ? decodeTxReadWriteSet(fp, ccAction.results)
    : { ns_rwset: [] };

  return {
    proposal_response_payload: {
      extension: { results },
    },
  };
}

function decodeTxReadWriteSet(fp: any, bytes: Uint8Array): any {
  const txRwSet = fp.rwset.TxReadWriteSet.decode(bytes);
  const nsRwSets = (txRwSet.ns_rwset ?? []).map((nsRw: any) => {
    return decodeNsReadWriteSet(fp, nsRw);
  });
  return { ns_rwset: nsRwSets };
}

function decodeNsReadWriteSet(fp: any, nsRw: any): any {
  const rwset = nsRw.rwset?.length
    ? decodeKVRWSet(fp, nsRw.rwset)
    : { writes: [] };

  const collHashRwSets = (nsRw.collection_hashed_rwset ?? []).map(
    (collRw: any) => {
      const hashedRwset = collRw.hashed_rwset?.length
        ? decodeHashedRWSet(fp, collRw.hashed_rwset)
        : { hashed_writes: [] };
      return {
        collection_name: collRw.collection_name,
        hashed_rwset: hashedRwset,
      };
    },
  );

  return {
    namespace: nsRw.namespace,
    rwset,
    collection_hashed_rwset: collHashRwSets,
  };
}

function decodeKVRWSet(fp: any, bytes: Uint8Array): any {
  const kvRwSet = fp.kvrwset.KVRWSet.decode(bytes);
  return {
    writes: (kvRwSet.writes ?? []).map((w: any) => ({
      key: w.key,
      value: w.value,
      is_delete: w.is_delete ?? false,
    })),
  };
}

function decodeHashedRWSet(fp: any, bytes: Uint8Array): any {
  const hRwSet = fp.kvrwset.HashedRWSet.decode(bytes);
  return {
    hashed_writes: (hRwSet.hashed_writes ?? []).map((hw: any) => ({
      key_hash: hw.key_hash,
      value_hash: hw.value_hash,
      is_delete: hw.is_delete ?? false,
    })),
  };
}

// ── CONFIG block decoding ──

function decodeConfigPayload(fp: any, data: Uint8Array): any {
  const configEnvelope = fp.common.ConfigEnvelope.decode(data);
  if (!configEnvelope.config) return {};

  return {
    config: {
      sequence: toLong(configEnvelope.config.sequence),
      channel_group: decodeConfigGroup(
        fp, configEnvelope.config.channel_group,
      ),
    },
  };
}

function decodeConfigGroup(fp: any, group: any): any {
  if (!group) return {};

  const groups: Record<string, any> = {};
  if (group.groups) {
    for (const [name, subGroup] of Object.entries(group.groups)) {
      groups[name] = decodeConfigGroup(fp, subGroup);
    }
  }

  const values: Record<string, any> = {};
  if (group.values) {
    for (const [name, configValue] of Object.entries(group.values)) {
      values[name] = decodeConfigValue(fp, name, configValue as any);
    }
  }

  return { groups, values, policies: group.policies ?? {} };
}

function decodeConfigValue(fp: any, key: string, cv: any): any {
  if (!cv?.value?.length) return { value: {} };

  if (key === 'Capabilities') {
    try {
      const caps = fp.common.Capabilities.decode(cv.value);
      return { value: { capabilities: caps.capabilities ?? {} } };
    } catch (err) {
      logger.debug(
        { error: (err as Error).message },
        'Failed to decode Capabilities value',
      );
      return { value: {} };
    }
  }

  if (key === 'MSP') {
    try {
      const mspConfig = fp.msp.MSPConfig.decode(cv.value);
      const fabricConfig = fp.msp.FabricMSPConfig.decode(mspConfig.config);
      return { value: { config: { name: fabricConfig.name ?? '' } } };
    } catch (err) {
      logger.debug(
        { error: (err as Error).message },
        'Failed to decode MSP value',
      );
      return { value: {} };
    }
  }

  // Pass through other config values without deep decoding.
  return { value: cv.value };
}

// ── Utility helpers ──

function toHex(bytes: Uint8Array | Buffer | null | undefined): string {
  if (!bytes || bytes.length === 0) return '';
  return Buffer.from(bytes).toString('hex');
}

function toLong(val: any): number {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  // protobufjs Long object
  if (typeof val.toNumber === 'function') return val.toNumber();
  return Number(val);
}

function timestampToString(
  ts: { seconds?: any; nanos?: number } | null | undefined,
): string {
  if (!ts) return '';
  const seconds = toLong(ts.seconds);
  const nanos = ts.nanos ?? 0;
  const millis = seconds * 1000 + Math.floor(nanos / 1e6);
  return new Date(millis).toISOString();
}
