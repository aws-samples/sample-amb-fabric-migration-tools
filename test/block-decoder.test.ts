// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';
import { decodeProtobufBlock } from '../src/extraction/block-decoder';

const fabproto6 = require('fabric-protos');

/**
 * Build a minimal protobuf-encoded block with configurable transactions.
 *
 * `data_hash` defaults to the real hash of the envelopes, as Fabric computes
 * it; pass `dataHash` to build a block whose header does not match.
 */
function buildProtobufBlock(opts: {
  blockNumber: number;
  previousHash?: Buffer;
  dataHash?: Buffer;
  envelopes?: Uint8Array[];
  validationCodes?: number[];
}): Buffer {
  const envelopes = opts.envelopes ?? [];
  const header = fabproto6.common.BlockHeader.create({
    number: opts.blockNumber,
    previous_hash: opts.previousHash ?? Buffer.alloc(32, 0xaa),
    data_hash: opts.dataHash ?? crypto.createHash('sha256')
      .update(Buffer.concat(envelopes.map((e) => Buffer.from(e)))).digest(),
  });

  const metadata: Uint8Array[] = [
    Buffer.alloc(0), // SIGNATURES
    Buffer.alloc(0), // LAST_CONFIG
    Buffer.from(opts.validationCodes ?? []),
    Buffer.alloc(0), // COMMIT_HASH
  ];

  const block = fabproto6.common.Block.create({
    header,
    data: { data: envelopes },
    metadata: { metadata },
  });

  return Buffer.from(fabproto6.common.Block.encode(block).finish());
}

/**
 * Build a protobuf-encoded endorser transaction envelope.
 */
function buildEndorserEnvelope(opts: {
  txId: string;
  chaincodeId: string;
  writes: Array<{ key: string; value: string; isDelete?: boolean }>;
  mspId?: string;
  certPem?: string;
  hashedWrites?: Array<{
    collectionName: string;
    keyHash: Buffer;
    valueHash: Buffer;
  }>;
}): Uint8Array {
  // Build KVRWSet
  const kvWrites = opts.writes.map((w) =>
    fabproto6.kvrwset.KVWrite.create({
      key: w.key,
      value: Buffer.from(w.value, 'utf-8'),
      is_delete: w.isDelete ?? false,
    }),
  );
  const kvRwSet = fabproto6.kvrwset.KVRWSet.encode(
    fabproto6.kvrwset.KVRWSet.create({ writes: kvWrites }),
  ).finish();

  // Build collection hashed rwsets
  const collHashRwSets = (opts.hashedWrites ?? []).map((hw) => {
    const hashedRwSet = fabproto6.kvrwset.HashedRWSet.encode(
      fabproto6.kvrwset.HashedRWSet.create({
        hashed_writes: [
          fabproto6.kvrwset.KVWriteHash.create({
            key_hash: hw.keyHash,
            value_hash: hw.valueHash,
          }),
        ],
      }),
    ).finish();
    return fabproto6.rwset.CollectionHashedReadWriteSet.create({
      collection_name: hw.collectionName,
      hashed_rwset: hashedRwSet,
    });
  });

  // Build TxReadWriteSet
  const txRwSet = fabproto6.rwset.TxReadWriteSet.encode(
    fabproto6.rwset.TxReadWriteSet.create({
      data_model: 0,
      ns_rwset: [
        fabproto6.rwset.NsReadWriteSet.create({
          namespace: opts.chaincodeId,
          rwset: kvRwSet,
          collection_hashed_rwset: collHashRwSets,
        }),
      ],
    }),
  ).finish();

  // Build ChaincodeAction
  const ccAction = fabproto6.protos.ChaincodeAction.encode(
    fabproto6.protos.ChaincodeAction.create({ results: txRwSet }),
  ).finish();

  // Build ProposalResponsePayload
  const prp = fabproto6.protos.ProposalResponsePayload.encode(
    fabproto6.protos.ProposalResponsePayload.create({
      extension: ccAction,
    }),
  ).finish();

  // Build ChaincodeInvocationSpec for chaincode_proposal_payload
  const invSpec = fabproto6.protos.ChaincodeInvocationSpec.encode(
    fabproto6.protos.ChaincodeInvocationSpec.create({
      chaincode_spec: fabproto6.protos.ChaincodeSpec.create({
        chaincode_id: fabproto6.protos.ChaincodeID.create({
          name: opts.chaincodeId,
        }),
      }),
    }),
  ).finish();

  // Build ChaincodeProposalPayload
  const cpp = fabproto6.protos.ChaincodeProposalPayload.encode(
    fabproto6.protos.ChaincodeProposalPayload.create({ input: invSpec }),
  ).finish();

  // Build ChaincodeActionPayload
  const cap = fabproto6.protos.ChaincodeActionPayload.encode(
    fabproto6.protos.ChaincodeActionPayload.create({
      chaincode_proposal_payload: cpp,
      action: fabproto6.protos.ChaincodeEndorsedAction.create({
        proposal_response_payload: prp,
      }),
    }),
  ).finish();

  // Build Transaction
  const tx = fabproto6.protos.Transaction.encode(
    fabproto6.protos.Transaction.create({
      actions: [
        fabproto6.protos.TransactionAction.create({ payload: cap }),
      ],
    }),
  ).finish();

  // Build creator identity
  const creator = fabproto6.msp.SerializedIdentity.encode(
    fabproto6.msp.SerializedIdentity.create({
      mspid: opts.mspId ?? 'Org1MSP',
      id_bytes: Buffer.from(opts.certPem ?? 'test-cert'),
    }),
  ).finish();

  // Build headers
  const channelHeader = fabproto6.common.ChannelHeader.encode(
    fabproto6.common.ChannelHeader.create({
      type: 3, // ENDORSER_TRANSACTION
      tx_id: opts.txId,
      timestamp: fabproto6.google.protobuf.Timestamp.create({
        seconds: 1704067200, // 2024-01-01T00:00:00Z
        nanos: 0,
      }),
      channel_id: 'test-channel',
    }),
  ).finish();

  const signatureHeader = fabproto6.common.SignatureHeader.encode(
    fabproto6.common.SignatureHeader.create({ creator }),
  ).finish();

  const payload = fabproto6.common.Payload.encode(
    fabproto6.common.Payload.create({
      header: fabproto6.common.Header.create({
        channel_header: channelHeader,
        signature_header: signatureHeader,
      }),
      data: tx,
    }),
  ).finish();

  return fabproto6.common.Envelope.encode(
    fabproto6.common.Envelope.create({ payload }),
  ).finish();
}

/**
 * Build a protobuf-encoded config block envelope.
 */
function buildConfigEnvelope(
  capabilities: Record<string, string[]>,
  applicationMspIds: string[] = [],
): Uint8Array {
  const buildCapValue = (caps: string[]) => {
    const capMap: Record<string, any> = {};
    for (const c of caps) {
      capMap[c] = fabproto6.common.Capability.create({});
    }
    return fabproto6.common.ConfigValue.create({
      value: fabproto6.common.Capabilities.encode(
        fabproto6.common.Capabilities.create({ capabilities: capMap }),
      ).finish(),
    });
  };

  const groups: Record<string, any> = {};
  if (capabilities.application) {
    const applicationGroups: Record<string, any> = {};
    for (const [index, mspId] of applicationMspIds.entries()) {
      const fabricMsp = fabproto6.msp.FabricMSPConfig.create({ name: mspId });
      const mspConfig = fabproto6.msp.MSPConfig.create({
        type: 0,
        config: fabproto6.msp.FabricMSPConfig.encode(fabricMsp).finish(),
      });
      applicationGroups[`Org${index + 1}`] = fabproto6.common.ConfigGroup.create({
        values: {
          MSP: fabproto6.common.ConfigValue.create({
            value: fabproto6.msp.MSPConfig.encode(mspConfig).finish(),
          }),
        },
      });
    }
    groups['Application'] = fabproto6.common.ConfigGroup.create({
      groups: applicationGroups,
      values: { Capabilities: buildCapValue(capabilities.application) },
    });
  }
  if (capabilities.orderer) {
    groups['Orderer'] = fabproto6.common.ConfigGroup.create({
      values: { Capabilities: buildCapValue(capabilities.orderer) },
    });
  }

  const channelValues: Record<string, any> = {};
  if (capabilities.channel) {
    channelValues['Capabilities'] = buildCapValue(capabilities.channel);
  }

  const config = fabproto6.common.Config.create({
    channel_group: fabproto6.common.ConfigGroup.create({
      groups,
      values: channelValues,
    }),
  });

  const configEnvelope = fabproto6.common.ConfigEnvelope.create({ config });
  const configData = fabproto6.common.ConfigEnvelope.encode(
    configEnvelope,
  ).finish();

  const channelHeader = fabproto6.common.ChannelHeader.encode(
    fabproto6.common.ChannelHeader.create({
      type: 1, // CONFIG
      channel_id: 'test-channel',
    }),
  ).finish();

  const signatureHeader = fabproto6.common.SignatureHeader.encode(
    fabproto6.common.SignatureHeader.create({
      creator: fabproto6.msp.SerializedIdentity.encode(
        fabproto6.msp.SerializedIdentity.create({ mspid: 'OrdererMSP' }),
      ).finish(),
    }),
  ).finish();

  const payload = fabproto6.common.Payload.encode(
    fabproto6.common.Payload.create({
      header: fabproto6.common.Header.create({
        channel_header: channelHeader,
        signature_header: signatureHeader,
      }),
      data: configData,
    }),
  ).finish();

  return fabproto6.common.Envelope.encode(
    fabproto6.common.Envelope.create({ payload }),
  ).finish();
}

// ─── Tests ───

describe('decodeProtobufBlock', () => {
  it('decodes header fields with hex-string hashes', () => {
    const prevHash = Buffer.alloc(32, 0xaa);

    const blockBuf = buildProtobufBlock({
      blockNumber: 42,
      previousHash: prevHash,
    });

    const decoded = decodeProtobufBlock(blockBuf);

    expect(decoded.header.number).toBe(42);
    expect(decoded.header.previous_hash).toBe(prevHash.toString('hex'));
    // No transactions: the data hash is the SHA-256 of nothing
    expect(decoded.header.data_hash).toBe(
      crypto.createHash('sha256').digest('hex'),
    );
  });

  it('decodes an endorser transaction with writes', () => {
    const envelope = buildEndorserEnvelope({
      txId: 'tx-001',
      chaincodeId: 'mycc',
      writes: [
        { key: 'asset1', value: '{"color":"blue"}' },
        { key: 'asset2', value: 'deleted', isDelete: true },
      ],
    });

    const blockBuf = buildProtobufBlock({
      blockNumber: 5,
      envelopes: [envelope],
      validationCodes: [0],
    });

    const decoded = decodeProtobufBlock(blockBuf);
    const txPayload = decoded.data.data[0].payload;

    // Channel header
    expect(txPayload.header.channel_header.tx_id).toBe('tx-001');
    expect(txPayload.header.channel_header.type).toBe(3);
    expect(txPayload.header.channel_header.timestamp).toBe(
      '2024-01-01T00:00:00.000Z',
    );

    // Creator
    const creator = txPayload.header.signature_header.creator;
    expect(creator.mspid).toBe('Org1MSP');
    expect(Buffer.from(creator.id_bytes).toString()).toBe('test-cert');

    // Write set
    const nsRwSet =
      txPayload.data.actions[0].payload.action
        .proposal_response_payload.extension.results.ns_rwset[0];
    expect(nsRwSet.namespace).toBe('mycc');
    expect(nsRwSet.rwset.writes).toHaveLength(2);
    expect(nsRwSet.rwset.writes[0].key).toBe('asset1');
    expect(
      Buffer.from(nsRwSet.rwset.writes[0].value).toString('utf-8'),
    ).toBe('{"color":"blue"}');
    expect(nsRwSet.rwset.writes[0].is_delete).toBe(false);
    expect(nsRwSet.rwset.writes[1].is_delete).toBe(true);

    // Chaincode ID from proposal payload
    const ccId =
      txPayload.data.actions[0].payload.chaincode_proposal_payload
        .input.chaincode_spec.chaincode_id.name;
    expect(ccId).toBe('mycc');
  });

  it('decodes private data hashed writes', () => {
    const keyHash = Buffer.alloc(32, 0x11);
    const valueHash = Buffer.alloc(32, 0x22);

    const envelope = buildEndorserEnvelope({
      txId: 'tx-pvt',
      chaincodeId: 'mycc',
      writes: [{ key: 'k1', value: 'v1' }],
      hashedWrites: [
        { collectionName: 'collectionA', keyHash, valueHash },
      ],
    });

    const blockBuf = buildProtobufBlock({
      blockNumber: 10,
      envelopes: [envelope],
      validationCodes: [0],
    });

    const decoded = decodeProtobufBlock(blockBuf);
    const nsRwSet =
      decoded.data.data[0].payload.data.actions[0].payload.action
        .proposal_response_payload.extension.results.ns_rwset[0];

    expect(nsRwSet.collection_hashed_rwset).toHaveLength(1);
    const coll = nsRwSet.collection_hashed_rwset[0];
    expect(coll.collection_name).toBe('collectionA');
    expect(coll.hashed_rwset.hashed_writes).toHaveLength(1);

    const hw = coll.hashed_rwset.hashed_writes[0];
    expect(Buffer.from(hw.key_hash)).toEqual(keyHash);
    expect(Buffer.from(hw.value_hash)).toEqual(valueHash);
  });

  it('decodes config block with capabilities', () => {
    const configEnvelope = buildConfigEnvelope({
      application: ['V2_0'],
      channel: ['V2_0', 'V1_4_3'],
      orderer: ['V2_0'],
    }, ['Org1MSP', 'Org2MSP']);

    const blockBuf = buildProtobufBlock({
      blockNumber: 0,
      envelopes: [configEnvelope],
    });

    const decoded = decodeProtobufBlock(blockBuf);
    const configPayload = decoded.data.data[0].payload.data;

    // Navigate the same path version-detector uses
    const channelGroup = configPayload.config.channel_group;

    const appCaps =
      channelGroup.groups.Application.values.Capabilities.value
        .capabilities;
    expect(Object.keys(appCaps)).toEqual(['V2_0']);
    expect(
      Object.values<any>(channelGroup.groups.Application.groups)
        .map((org) => org.values.MSP.value.config.name)
        .sort(),
    ).toEqual(['Org1MSP', 'Org2MSP']);

    const chanCaps =
      channelGroup.values.Capabilities.value.capabilities;
    expect(Object.keys(chanCaps).sort()).toEqual(['V1_4_3', 'V2_0']);

    const ordCaps =
      channelGroup.groups.Orderer.values.Capabilities.value
        .capabilities;
    expect(Object.keys(ordCaps)).toEqual(['V2_0']);
  });

  it('decodes metadata validation codes as number array', () => {
    const envelope = buildEndorserEnvelope({
      txId: 'tx-1',
      chaincodeId: 'mycc',
      writes: [{ key: 'k', value: 'v' }],
    });

    const blockBuf = buildProtobufBlock({
      blockNumber: 3,
      envelopes: [envelope],
      validationCodes: [0, 10, 0],
    });

    const decoded = decodeProtobufBlock(blockBuf);
    expect(decoded.metadata.metadata[2]).toEqual([0, 10, 0]);
  });

  it('handles empty block with no transactions', () => {
    const blockBuf = buildProtobufBlock({ blockNumber: 1 });
    const decoded = decodeProtobufBlock(blockBuf);

    expect(decoded.header.number).toBe(1);
    expect(decoded.data.data).toEqual([]);
  });

  it('throws ExtractionError on corrupt input', () => {
    const garbage = Buffer.from('not-a-protobuf-block');

    expect(() => decodeProtobufBlock(garbage)).toThrow(
      /Failed to decode protobuf block/,
    );
  });

  describe('data hash', () => {
    const tx = (txId: string) => buildEndorserEnvelope({
      txId, chaincodeId: 'mycc', writes: [{ key: 'k', value: 'v' }],
    });

    it('accepts a block whose transactions hash to its data_hash', () => {
      // Hash computed independently: SHA-256 over the envelopes joined in order
      const envelopes = [tx('a'), tx('b')];
      const expected = crypto.createHash('sha256')
        .update(Buffer.concat(envelopes.map((e) => Buffer.from(e)))).digest();

      const decoded = decodeProtobufBlock(buildProtobufBlock({
        blockNumber: 7, envelopes, dataHash: expected, validationCodes: [0, 0],
      }));
      expect(decoded.header.data_hash).toBe(expected.toString('hex'));
    });

    it('refuses a block whose transactions do not match its header', () => {
      expect(() => decodeProtobufBlock(buildProtobufBlock({
        blockNumber: 7, envelopes: [tx('a')], dataHash: Buffer.alloc(32, 0xbb), validationCodes: [0],
      }))).toThrow(/Block 7: its 1 transaction\(s\) hash to [0-9a-f]{64}, but its header records data_hash b{64}/);
    });

    it('refuses transactions reordered under the same header', () => {
      const [a, b] = [tx('a'), tx('b')];
      const inOrder = crypto.createHash('sha256')
        .update(Buffer.concat([Buffer.from(a), Buffer.from(b)])).digest();

      expect(() => decodeProtobufBlock(buildProtobufBlock({
        blockNumber: 7, envelopes: [b, a], dataHash: inOrder, validationCodes: [0, 0],
      }))).toThrow(/not the ones the block header commits to/);
    });

    it('refuses a block with no data_hash', () => {
      expect(() => decodeProtobufBlock(buildProtobufBlock({
        blockNumber: 7, envelopes: [tx('a')], dataHash: Buffer.alloc(0), validationCodes: [0],
      }))).toThrow(/header records data_hash \(none\)/);
    });
  });

  it('keeps an envelope it cannot decode at its position', () => {
    // The TRANSACTIONS_FILTER is indexed by position, so dropping the bad
    // envelope would hand every later transaction its neighbour's code.
    const good = buildEndorserEnvelope({ txId: 'tx-after', chaincodeId: 'mycc', writes: [{ key: 'k', value: 'v' }] });
    const bad = fabproto6.common.Envelope.encode(
      fabproto6.common.Envelope.create({ payload: Buffer.from([0xff, 0xff, 0xff]) }),
    ).finish();

    const decoded = decodeProtobufBlock(buildProtobufBlock({
      blockNumber: 8, envelopes: [bad, good], validationCodes: [2, 0],
    }));

    expect(decoded.data.data).toHaveLength(2);
    expect(decoded.data.data[0].decodeError).toEqual(expect.any(String));
    expect(decoded.data.data[1].payload.header.channel_header.tx_id).toBe('tx-after');
  });
});
