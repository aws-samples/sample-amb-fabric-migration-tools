import * as crypto from 'crypto';
import { nodeEcdsaSigner, useNodeSigner } from '../src/connection/node-signer';
import { ADMIN_CERT_PEM } from './helpers/test-certs';

const { User } = require('fabric-common');

const ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

function p256(): { keyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicKey };
}

/** s from a DER ECDSA signature. */
function sOf(der: Buffer): bigint {
  const rLen = der[3];
  const sLen = der[5 + rLen];
  return BigInt('0x' + der.subarray(6 + rLen, 6 + rLen + sLen).toString('hex'));
}

describe('nodeEcdsaSigner', () => {
  it('produces DER signatures that verify, always with low s', () => {
    const { keyPem, publicKey } = p256();
    const sign = nodeEcdsaSigner(keyPem)!;
    for (let i = 0; i < 200; i++) {
      const msg = crypto.randomBytes(64);
      const sig = sign(msg);
      expect(sig[0]).toBe(0x30);
      expect(crypto.verify('sha256', msg, publicKey, sig)).toBe(true);
      expect(sOf(sig) <= ORDER / 2n).toBe(true);
    }
  });

  it('declines keys that are not P-256', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(nodeEcdsaSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toBeUndefined();
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(nodeEcdsaSigner(rsa.export({ type: 'pkcs8', format: 'pem' }) as string)).toBeUndefined();
  });
});

describe('useNodeSigner on a fabric-common User', () => {
  // createUser parses the certificate but never checks that it matches the key.
  it('replaces the signing path: signatures verify and fabric-common\'s CryptoSuite is not called', () => {
    const { keyPem, publicKey } = p256();
    const user = User.createUser('admin', '', 'Org1MSP', ADMIN_CERT_PEM, keyPem);
    const suite = user.getSigningIdentity()._cryptoSuite;
    const spy = jest.spyOn(suite, 'sign');
    expect(useNodeSigner(user, keyPem)).toBe(true);
    const msg = Buffer.from('proposal bytes');
    const sig = Buffer.from(user.getSigningIdentity().sign(msg));
    expect(crypto.verify('sha256', msg, publicKey, sig)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

