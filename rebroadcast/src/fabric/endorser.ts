/**
 * Chaincode queries without the `peer` binary or a Gateway: a signed proposal to a peer's Endorser service
 * (`/protos.Endorser/ProcessProposal`), whose response is read and never submitted. Used by `verify` to call the
 * migration contract's read functions.
 */
import * as crypto from 'crypto';
import * as grpc from '@grpc/grpc-js';
import { common, peer } from '@hyperledger/fabric-protos';
import { channelHeader, Identity, signatureHeader, signLowS } from '../config/signer';
import { EndpointOpts } from '../orderer/client';
import { sleep } from '../util/misc';

const ident = (b: Buffer): Buffer => b;
const EndorserClient = grpc.makeGenericClientConstructor({
  ProcessProposal: { path: '/protos.Endorser/ProcessProposal', requestStream: false, responseStream: false, requestSerialize: ident, requestDeserialize: ident, responseSerialize: ident, responseDeserialize: ident },
}, 'Endorser');

export interface QueryResult { status: number; message: string; payload: Buffer }

export interface BuiltProposal {
  signed: Buffer;
  txId: string;
  /** The proposal's Header and its payload WITHOUT the transient map: what the transaction carries. */
  header: common.Header;
  strippedPayload: Buffer;
}

/** A SignedProposal invoking `cc` with `args` on `channel`, signed by `id`; `transient` reaches the endorsers only. */
export function buildProposal(id: Identity, channel: string, cc: string, args: (string | Buffer)[], tlsCertHash?: Buffer, transient?: Record<string, Buffer>): BuiltProposal {
  const nonce = crypto.randomBytes(24);
  const txId = crypto.createHash('sha256').update(Buffer.concat([nonce, id.creator])).digest('hex');
  const ccId = new peer.ChaincodeID();
  ccId.setName(cc);
  const ext = new peer.ChaincodeHeaderExtension();
  ext.setChaincodeId(ccId);
  const hdr = new common.Header();
  hdr.setChannelHeader(channelHeader(common.HeaderType.ENDORSER_TRANSACTION, channel, txId, tlsCertHash, ext.serializeBinary()));
  hdr.setSignatureHeader(signatureHeader(id, nonce));
  const input = new peer.ChaincodeInput();
  input.setArgsList(args.map((a) => (typeof a === 'string' ? Buffer.from(a) : a)));
  const spec = new peer.ChaincodeSpec();
  spec.setType(peer.ChaincodeSpec.Type.GOLANG);
  spec.setChaincodeId(ccId);
  spec.setInput(input);
  const cis = new peer.ChaincodeInvocationSpec();
  cis.setChaincodeSpec(spec);
  const cpp = new peer.ChaincodeProposalPayload();
  cpp.setInput(cis.serializeBinary());
  const strippedPayload = Buffer.from(cpp.serializeBinary());
  for (const [k, v] of Object.entries(transient ?? {})) cpp.getTransientmapMap().set(k, v);
  const prop = new peer.Proposal();
  prop.setHeader(hdr.serializeBinary());
  prop.setPayload(cpp.serializeBinary());
  const bytes = Buffer.from(prop.serializeBinary());
  const sp = new peer.SignedProposal();
  sp.setProposalBytes(bytes);
  sp.setSignature(signLowS(id.key, bytes));
  return { signed: Buffer.from(sp.serializeBinary()), txId, header: hdr, strippedPayload };
}

export const signedProposal = (id: Identity, channel: string, cc: string, args: (string | Buffer)[], tlsCertHash?: Buffer): Buffer => buildProposal(id, channel, cc, args, tlsCertHash).signed;

/**
 * The transaction envelope for an endorsed proposal: every endorser must have returned the same response payload.
 * Signed by the proposal's creator.
 */
export function transactionEnvelope(id: Identity, p: BuiltProposal, responses: peer.ProposalResponse[]): Buffer {
  const prp = Buffer.from(responses[0].getPayload_asU8());
  for (const r of responses.slice(1)) if (!prp.equals(Buffer.from(r.getPayload_asU8()))) throw new Error('endorsers returned different results (the chaincode is not deterministic, or the peers\' states differ)');
  const cea = new peer.ChaincodeEndorsedAction();
  cea.setProposalResponsePayload(prp);
  cea.setEndorsementsList(responses.map((r) => r.getEndorsement()!));
  const cap = new peer.ChaincodeActionPayload();
  cap.setChaincodeProposalPayload(p.strippedPayload);
  cap.setAction(cea);
  const ta = new peer.TransactionAction();
  ta.setHeader(p.header.getSignatureHeader_asU8());
  ta.setPayload(cap.serializeBinary());
  const tx = new peer.Transaction();
  tx.setActionsList([ta]);
  const pl = new common.Payload();
  pl.setHeader(p.header);
  pl.setData(tx.serializeBinary());
  const payload = Buffer.from(pl.serializeBinary());
  const env = new common.Envelope();
  env.setPayload(payload);
  env.setSignature(signLowS(id.key, payload));
  return Buffer.from(env.serializeBinary());
}

export class Endorser {
  private readonly client: grpc.Client & { ProcessProposal: (req: Buffer, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r?: Buffer) => void) => void };
  private readonly tlsCertHash?: Buffer;
  constructor(readonly endpoint: EndpointOpts, readonly channel: string, private readonly id: Identity) {
    const o = endpoint;
    const opts: grpc.ChannelOptions = { ...(o.serverName && { 'grpc.ssl_target_name_override': o.serverName, 'grpc.default_authority': o.serverName }), 'grpc.max_receive_message_length': 128 * 1024 * 1024 };
    this.client = new EndorserClient(o.address, grpc.credentials.createSsl(o.tlsCa, o.clientKey ?? null, o.clientCert ?? null), opts) as unknown as typeof this.client;
    this.tlsCertHash = o.clientCert ? crypto.createHash('sha256').update(new crypto.X509Certificate(o.clientCert).raw).digest() : undefined;
  }

  get mspId(): string { return this.id.mspId; }
  get identity(): Identity { return this.id; }
  get tlsHash(): Buffer | undefined { return this.tlsCertHash; }

  /** One evaluation. Transport errors are retried (with back-off); a chaincode error is a result, not an exception. */
  async query(cc: string, args: (string | Buffer)[], timeoutMs = 30000): Promise<QueryResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(cc, args, timeoutMs);
      } catch (e) {
        const se = e as grpc.ServiceError;
        if (attempt >= 5 || ![grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.RESOURCE_EXHAUSTED].includes(se.code)) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  private async once(cc: string, args: (string | Buffer)[], timeoutMs: number): Promise<QueryResult> {
    const pr = await this.process(signedProposal(this.id, this.channel, cc, args, this.tlsCertHash), timeoutMs);
    const r = pr.getResponse();
    return { status: r?.getStatus() ?? 0, message: r?.getMessage() ?? '', payload: Buffer.from(r?.getPayload_asU8() ?? []) };
  }

  /** Send a signed proposal (built by anyone) and return the peer's full response, including its endorsement. */
  process(signed: Buffer, timeoutMs = 60000): Promise<peer.ProposalResponse> {
    return new Promise((resolve, reject) => {
      this.client.ProcessProposal(signed, new grpc.Metadata(), { deadline: Date.now() + timeoutMs }, (err, buf) => {
        if (err) return reject(err);
        resolve(peer.ProposalResponse.deserializeBinary(buf!));
      });
    });
  }

  close(): void { this.client.close(); }
}
