import * as crypto from 'crypto';
import * as fs from 'fs';
import { common } from '@hyperledger/fabric-protos';
import {
  N_HALF, chainsTo, checkConfigSignature, configSignature, configUpdateEnvelope, cutMarker, derSig, identity, parseDer, signLowS, verifyFabric,
} from '../src/config/signer';
import { makePki } from './helpers';

const pki = makePki();
afterAll(() => pki.cleanup());
const N = (N_HALF << 1n) + 1n;

describe('low-S ECDSA', () => {
  const key = crypto.createPrivateKey(fs.readFileSync(pki.key));
  const cert = fs.readFileSync(pki.cert);
  const data = crypto.randomBytes(100);

  it('never returns a high-S signature, and every signature verifies', () => {
    for (let i = 0; i < 400; i++) {
      const d = signLowS(key, data);
      expect(parseDer(d).s <= N_HALF).toBe(true);
      expect(verifyFabric(cert, data, d)).toEqual({ ok: true, why: '' });
    }
  });

  it('Node on its own returns high-S signatures, which is why normalising is needed', () => {
    let high = 0;
    for (let i = 0; i < 200; i++) if (parseDer(crypto.sign('sha256', data, key)).s > N_HALF) high++;
    expect(high).toBeGreaterThan(40); // about half; the chance of fewer than 40 of 200 is negligible
  });

  it('refuses the mirror-image high-S signature, which plain ECDSA accepts', () => {
    const { r, s } = parseDer(signLowS(key, data));
    const high = derSig(r, N - s);
    expect(crypto.verify('sha256', data, new crypto.X509Certificate(cert).publicKey, high)).toBe(true);
    expect(verifyFabric(cert, data, high)).toEqual({ ok: false, why: 'high-S' });
  });

  it('refuses a signature over other data', () => {
    expect(verifyFabric(cert, Buffer.from('other'), signLowS(key, data)).ok).toBe(false);
  });
});

describe('identities and config signatures', () => {
  it('refuses a key that is not the certificate\'s', () => {
    expect(() => identity('OrgA', pki.cert, pki.otherKey)).toThrow(/is not the key of/);
  });

  it('signs a config update the way signconfigtx does, and says who signed', () => {
    const id = identity('OrgA', pki.cert, pki.key);
    const upd = crypto.randomBytes(300);
    const sig = configSignature(id, upd);
    expect(checkConfigSignature(sig, upd)).toMatchObject({ mspId: 'OrgA', ok: true });
    expect(checkConfigSignature(sig, Buffer.concat([upd, Buffer.from('x')])).ok).toBe(false);
  });

  it('builds a CONFIG_UPDATE envelope carrying the update bytes unchanged and every signature', () => {
    const id = identity('OrgA', pki.cert, pki.key);
    const upd = crypto.randomBytes(64);
    const env = common.Envelope.deserializeBinary(configUpdateEnvelope(id, 'ch1', upd, [configSignature(id, upd), configSignature(id, upd)]));
    const pl = common.Payload.deserializeBinary(env.getPayload_asU8());
    const ch = common.ChannelHeader.deserializeBinary(pl.getHeader()!.getChannelHeader_asU8());
    expect(ch.getType()).toBe(common.HeaderType.CONFIG_UPDATE);
    expect(ch.getChannelId()).toBe('ch1');
    expect(ch.getTxId()).toMatch(/^[0-9a-f]{64}$/);
    const cue = common.ConfigUpdateEnvelope.deserializeBinary(pl.getData_asU8());
    expect(Buffer.from(cue.getConfigUpdate_asU8()).equals(upd)).toBe(true);
    expect(cue.getSignaturesList()).toHaveLength(2);
    expect(verifyFabric(id.certPem, env.getPayload_asU8(), env.getSignature_asU8()).ok).toBe(true);
  });

  it('makes a cut marker: a signed MESSAGE envelope on the channel', () => {
    const id = identity('OrgA', pki.cert, pki.key);
    const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(cutMarker(id, 'ch1')).getPayload_asU8());
    expect(common.ChannelHeader.deserializeBinary(pl.getHeader()!.getChannelHeader_asU8()).getType()).toBe(common.HeaderType.MESSAGE);
    expect(Buffer.from(pl.getData_asU8()).toString()).toBe('fabric-migration-cut');
  });

  it('checks that a signer chains to an org\'s roots', () => {
    expect(chainsTo(fs.readFileSync(pki.cert), [pki.caB64])).toBe(true);
    expect(chainsTo(fs.readFileSync(pki.cert), [fs.readFileSync(pki.cert).toString('base64')])).toBe(false);
  });
});
