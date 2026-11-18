#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Diagnostic: fetch blocks 0-2 and verify hash chain.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fabproto6 = require('fabric-protos');

const mspPath = process.env.MSP_PATH || process.env.CORE_PEER_MSPCONFIGPATH;
const mspId = process.env.CORE_PEER_LOCALMSPID || process.env.MEMBER_ID;
const peerAddr = process.env.CORE_PEER_ADDRESS;
const tlsCertFile = process.env.TLS_CA_CERT || process.env.CORE_PEER_TLS_ROOTCERT_FILE;
const channelName = process.env.CHANNEL_NAME || 'mychannel';

if (!mspPath || !mspId || !peerAddr || !tlsCertFile) {
  console.error('Required: MSP_PATH, CORE_PEER_LOCALMSPID, CORE_PEER_ADDRESS, TLS_CA_CERT');
  process.exit(1);
}

const grpc = require('@grpc/grpc-js');
const elliptic = require('elliptic');
const ec = new elliptic.ec('p256');

// Read identity
const certPEM = fs.readFileSync(path.join(mspPath, 'signcerts', 'cert.pem'), 'utf-8');
const keystoreDir = path.join(mspPath, 'keystore');
const keyFile = fs.readdirSync(keystoreDir).filter(f => !f.startsWith('.'))[0];
const keyPEM = fs.readFileSync(path.join(keystoreDir, keyFile), 'utf-8');
const tlsPem = fs.readFileSync(tlsCertFile, 'utf-8');

// Parse private key for signing
const keyObj = crypto.createPrivateKey(keyPEM);
const jwk = keyObj.export({ format: 'jwk' });
const prvKeyHex = Buffer.from(jwk.d, 'base64url').toString('hex');
const signKey = ec.keyFromPrivate(prvKeyHex, 'hex');

function buildSignedProposal(fcn, args) {
  const serializedIdentity = fabproto6.msp.SerializedIdentity.encode(
    fabproto6.msp.SerializedIdentity.create({ mspid: mspId, id_bytes: Buffer.from(certPEM) })
  ).finish();

  const nonce = crypto.randomBytes(24);
  const txIdHash = crypto.createHash('sha256');
  txIdHash.update(nonce);
  txIdHash.update(serializedIdentity);
  const txId = txIdHash.digest('hex');

  const chaincodeInput = fabproto6.protos.ChaincodeInput.create({
    args: [Buffer.from(fcn), ...args.map(a => Buffer.from(a))],
  });
  const chaincodeSpec = fabproto6.protos.ChaincodeSpec.create({
    type: fabproto6.protos.ChaincodeSpec.Type.GOLANG,
    chaincode_id: fabproto6.protos.ChaincodeID.create({ name: 'qscc' }),
    input: chaincodeInput,
  });
  const chaincodeInvocationSpec = fabproto6.protos.ChaincodeInvocationSpec.create({ chaincode_spec: chaincodeSpec });
  const ccProposalPayload = fabproto6.protos.ChaincodeProposalPayload.create({
    input: fabproto6.protos.ChaincodeInvocationSpec.encode(chaincodeInvocationSpec).finish(),
  });

  const channelHeader = fabproto6.common.ChannelHeader.create({
    type: fabproto6.common.HeaderType.ENDORSER_TRANSACTION,
    channel_id: channelName,
    tx_id: txId,
    timestamp: fabproto6.google.protobuf.Timestamp.create({ seconds: Math.floor(Date.now() / 1000) }),
    extension: fabproto6.protos.ChaincodeHeaderExtension.encode(
      fabproto6.protos.ChaincodeHeaderExtension.create({ chaincode_id: fabproto6.protos.ChaincodeID.create({ name: 'qscc' }) })
    ).finish(),
  });

  const signatureHeader = fabproto6.common.SignatureHeader.create({ creator: serializedIdentity, nonce });
  const header = fabproto6.common.Header.create({
    channel_header: fabproto6.common.ChannelHeader.encode(channelHeader).finish(),
    signature_header: fabproto6.common.SignatureHeader.encode(signatureHeader).finish(),
  });

  const proposal = fabproto6.protos.Proposal.create({
    header: fabproto6.common.Header.encode(header).finish(),
    payload: fabproto6.protos.ChaincodeProposalPayload.encode(ccProposalPayload).finish(),
  });
  const proposalBytes = fabproto6.protos.Proposal.encode(proposal).finish();

  const digest = crypto.createHash('sha256').update(proposalBytes).digest();
  let sig = ec.sign(digest, signKey);
  const halfOrder = ec.n.shrn(1);
  if (sig.s.cmp(halfOrder) > 0) sig.s = ec.n.sub(sig.s);
  const signature = Buffer.from(sig.toDER());

  return Buffer.from(fabproto6.protos.SignedProposal.encode(
    fabproto6.protos.SignedProposal.create({ proposal_bytes: proposalBytes, signature })
  ).finish());
}

// Connect
const peerUrl = peerAddr.includes('://') ? peerAddr.replace('grpcs://', '') : peerAddr;
const hostname = peerUrl.split(':')[0];
const channelCreds = grpc.credentials.createSsl(Buffer.from(tlsPem));
const endorserServiceDef = {
  ProcessProposal: {
    path: '/protos.Endorser/ProcessProposal',
    requestStream: false, responseStream: false,
    requestSerialize: (buf) => buf,
    requestDeserialize: (buf) => buf,
    responseSerialize: (buf) => buf,
    responseDeserialize: (buf) => fabproto6.protos.ProposalResponse.decode(buf),
  },
};
const client = grpc.makeGenericClientConstructor(endorserServiceDef, 'Endorser');
const endorser = new client(peerUrl, channelCreds, { 'grpc.ssl_target_name_override': hostname });

function sendProposal(signedBytes) {
  return new Promise((resolve, reject) => {
    endorser.ProcessProposal(signedBytes, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

async function fetchBlock(blockNum) {
  const sp = buildSignedProposal('GetBlockByNumber', [channelName, blockNum.toString()]);
  const response = await sendProposal(sp);
  if (response.response?.status !== 200) {
    throw new Error(`Block ${blockNum}: status ${response.response?.status} ${response.response?.message}`);
  }
  return Buffer.from(response.response.payload);
}

// ASN.1 DER encoding helpers (matching Go's protoutil.BlockHeaderHash)
function asn1LengthPrefix(tag, length) {
  if (length < 128) return Buffer.from([tag, length]);
  if (length < 256) return Buffer.from([tag, 0x81, length]);
  return Buffer.from([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}
function asn1Integer(value) {
  if (value === 0) return Buffer.from([0x02, 0x01, 0x00]);
  const hex = value.toString(16);
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  let bytes = Buffer.from(paddedHex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return Buffer.concat([asn1LengthPrefix(0x02, bytes.length), bytes]);
}
function asn1OctetString(data) {
  return Buffer.concat([asn1LengthPrefix(0x04, data.length), data]);
}
function blockHeaderHash(blockNumber, previousHash, dataHash) {
  const numberBuf = asn1Integer(blockNumber);
  const prevBuf = asn1OctetString(previousHash.length ? Buffer.from(previousHash, 'hex') : Buffer.alloc(0));
  const dataBuf = asn1OctetString(dataHash.length ? Buffer.from(dataHash, 'hex') : Buffer.alloc(0));
  const contentLen = numberBuf.length + prevBuf.length + dataBuf.length;
  const seqHeader = asn1LengthPrefix(0x30, contentLen);
  const derEncoded = Buffer.concat([seqHeader, numberBuf, prevBuf, dataBuf]);
  return crypto.createHash('sha256').update(derEncoded).digest('hex');
}

(async () => {
  console.log('=== HASH CHAIN VERIFICATION (ASN.1 header hash) ===\n');

  let lastHeaderHash = '';
  for (let i = 0; i < 5; i++) {
    const blockBytes = await fetchBlock(i);
    const blockProto = fabproto6.common.Block.decode(blockBytes);

    const prevHash = Buffer.from(blockProto.header.previous_hash).toString('hex');
    const dataHash = Buffer.from(blockProto.header.data_hash).toString('hex');
    const blockNum = Number(blockProto.header.number);

    const headerHash = blockHeaderHash(blockNum, prevHash, dataHash);

    console.log(`Block ${blockNum}:`);
    console.log(`  previous_hash:     ${prevHash || '(empty)'}`);
    console.log(`  data_hash:         ${dataHash}`);
    console.log(`  header_hash:       ${headerHash}`);
    if (i > 0) {
      console.log(`  prev block hash:   ${lastHeaderHash}`);
      console.log(`  chain links:       ${prevHash === lastHeaderHash}`);
    }
    console.log();
    lastHeaderHash = headerHash;
  }

  // Now test what BlockDecoder returns
  console.log('=== BLOCKDECODER OUTPUT ===\n');
  const BlockDecoder = require('fabric-common/lib/BlockDecoder');

  for (let i = 0; i < 3; i++) {
    const blockBytes = await fetchBlock(i);
    const decoded = BlockDecoder.decode(blockBytes);

    const prevHash = decoded.header.previous_hash;
    const dataHash = decoded.header.data_hash;

    console.log(`Block ${i} via BlockDecoder:`);
    console.log(`  previous_hash type: ${typeof prevHash}, isBuffer: ${Buffer.isBuffer(prevHash)}, isUint8Array: ${prevHash instanceof Uint8Array}`);
    console.log(`  previous_hash hex: ${Buffer.from(prevHash).toString('hex') || '(empty)'}`);
    console.log(`  data_hash type: ${typeof dataHash}, isBuffer: ${Buffer.isBuffer(dataHash)}, isUint8Array: ${dataHash instanceof Uint8Array}`);
    console.log(`  data_hash hex: ${Buffer.from(dataHash).toString('hex')}`);
    console.log();
  }

  endorser.close();
})().catch(err => { console.error(err); process.exit(1); });
