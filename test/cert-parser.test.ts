import * as crypto from 'crypto';
import { parseCreator } from '../src/utils/cert-parser';
import {
  ADMIN_CERT_FINGERPRINT,
  ADMIN_CERT_PEM,
  CLIENT_CERT_FINGERPRINT,
  CLIENT_CERT_PEM,
} from './helpers/test-certs';

/** DER form of a PEM certificate, as a Fabric block delivers it over gRPC. */
function toDer(pem: string): Buffer {
  return Buffer.from(
    pem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s/g, ''),
    'base64',
  );
}

describe('parseCreator — X.509 parsing', () => {
  it('reads CN and O from a PEM certificate', () => {
    const identity = parseCreator({ mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM });

    expect(identity).toEqual({
      mspId: 'Org1MSP',
      commonName: 'admin',
      org: 'org1.example.com',
      certFingerprint: ADMIN_CERT_FINGERPRINT,
    });
  });

  it('reads the same identity from the DER form', () => {
    const identity = parseCreator({
      mspid: 'Org1MSP',
      id_bytes: toDer(ADMIN_CERT_PEM),
    });

    expect(identity.commonName).toBe('admin');
    expect(identity.org).toBe('org1.example.com');
    expect(identity.certFingerprint).toBe(ADMIN_CERT_FINGERPRINT);
  });

  it('accepts a Uint8Array of DER bytes', () => {
    const der = toDer(CLIENT_CERT_PEM);
    const identity = parseCreator({
      mspid: 'Org2MSP',
      id_bytes: new Uint8Array(der),
    });

    expect(identity.commonName).toBe('client');
    expect(identity.certFingerprint).toBe(CLIENT_CERT_FINGERPRINT);
  });

  it('produces a fingerprint matching openssl -fingerprint -sha256', () => {
    const expected = crypto
      .createHash('sha256')
      .update(toDer(ADMIN_CERT_PEM))
      .digest('hex');

    expect(parseCreator({ mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM })
      .certFingerprint).toBe(`sha256:${expected}`);
  });

  it('reads snake_case and camelCase creator fields alike', () => {
    const snake = parseCreator({ mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM });
    const camel = parseCreator({ Mspid: 'Org1MSP', IdBytes: ADMIN_CERT_PEM });

    expect(camel).toEqual(snake);
  });

  it('distinguishes two identities that differ only by certificate', () => {
    const admin = parseCreator({ mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM });
    const client = parseCreator({ mspid: 'Org1MSP', id_bytes: CLIENT_CERT_PEM });

    expect(admin.certFingerprint).not.toBe(client.certFingerprint);
  });
});

describe('parseCreator — degraded inputs', () => {
  it('reports mspId unknown for an absent creator', () => {
    expect(parseCreator(undefined)).toEqual({
      mspId: 'unknown',
      certFingerprint: '',
      commonName: '',
      org: '',
    });
  });

  it('reports an empty fingerprint when id_bytes is missing', () => {
    expect(parseCreator({ mspid: 'Org1MSP' })).toEqual({
      mspId: 'Org1MSP',
      certFingerprint: '',
      commonName: '',
      org: '',
    });
  });

  it('reports mspId unknown when only a certificate is present', () => {
    expect(parseCreator({ id_bytes: ADMIN_CERT_PEM }).mspId).toBe('unknown');
  });

  it('falls back to a raw-bytes fingerprint for an unparseable certificate', () => {
    const junk = '-----BEGIN CERTIFICATE-----\nnot-a-cert\n-----END CERTIFICATE-----';
    const identity = parseCreator({ mspid: 'Org1MSP', id_bytes: junk });

    expect(identity.commonName).toBe('');
    expect(identity.org).toBe('');
    // Distinct identities must stay distinct even when neither parses
    expect(identity.certFingerprint).toBe(
      'sha256:' + crypto.createHash('sha256').update(junk, 'utf-8').digest('hex'),
    );
  });

  it('keeps unparseable certificates distinct from one another', () => {
    const a = parseCreator({ mspid: 'Org1MSP', id_bytes: 'garbage-a' });
    const b = parseCreator({ mspid: 'Org1MSP', id_bytes: 'garbage-b' });

    expect(a.certFingerprint).not.toBe(b.certFingerprint);
    expect(a.certFingerprint).not.toBe('');
  });

  it('ignores an id_bytes of an unusable type', () => {
    expect(parseCreator({ mspid: 'Org1MSP', id_bytes: { nested: 1 } })).toEqual({
      mspId: 'Org1MSP',
      certFingerprint: '',
      commonName: '',
      org: '',
    });
  });
});

describe('parseCreator — caching', () => {
  it('returns the identical cached object for a repeated creator', () => {
    const creator = { mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM };

    expect(parseCreator(creator)).toBe(parseCreator(creator));
  });

  it('caches per MSP ID, not per certificate alone', () => {
    const org1 = parseCreator({ mspid: 'Org1MSP', id_bytes: ADMIN_CERT_PEM });
    const org2 = parseCreator({ mspid: 'Org2MSP', id_bytes: ADMIN_CERT_PEM });

    expect(org1.mspId).toBe('Org1MSP');
    expect(org2.mspId).toBe('Org2MSP');
    expect(org1.certFingerprint).toBe(org2.certFingerprint);
  });
});
