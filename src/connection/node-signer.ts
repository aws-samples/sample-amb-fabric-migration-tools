// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';

/** Order n of the P-256 group, for the low-S rule Fabric enforces. */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

/**
 * Sign a Fabric message with Node's own ECDSA (OpenSSL) instead of fabric-common's.
 *
 * fabric-common signs with the `elliptic` package, which has an unpatched flaw (CVE-2025-14505): some signatures are
 * computed with a truncated nonce, and a faulty signature together with a correct one over the same input can reveal
 * the private key. This signer produces what fabric-common would: SHA-256 over the message, an ECDSA P-256 signature
 * with `s` in the lower half of the group order (Fabric rejects the other half), DER-encoded.
 *
 * @param keyPem The identity's private key, PEM.
 * @returns A function from message bytes to the DER signature, or `undefined` for a key that is not P-256, in which
 *   case the caller keeps fabric-common's signer.
 */
export function nodeEcdsaSigner(keyPem: string): ((message: Uint8Array) => Buffer) | undefined {
  const key = crypto.createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return undefined;
  return (message: Uint8Array): Buffer => {
    const raw = crypto.sign('sha256', message, { key, dsaEncoding: 'ieee-p1363' });
    const r = BigInt('0x' + raw.subarray(0, 32).toString('hex'));
    let s = BigInt('0x' + raw.subarray(32).toString('hex'));
    if (s > P256_ORDER / 2n) s = P256_ORDER - s;
    return derSignature(r, s);
  };
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }`. */
function derSignature(r: bigint, s: bigint): Buffer {
  const int = (v: bigint): Buffer => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    let b = Buffer.from(hex, 'hex');
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Make a fabric-common `User` sign with {@link nodeEcdsaSigner}. Everything fabric-common signs for this user
 * (proposals, transactions, deliver requests) goes through `SigningIdentity.sign`, so this is the one place to replace.
 *
 * @returns Whether the signer was replaced (false for a key that is not P-256).
 */
export function useNodeSigner(user: { getSigningIdentity(): { sign: (msg: Uint8Array, opts?: unknown) => Buffer } }, keyPem: string): boolean {
  const sign = nodeEcdsaSigner(keyPem);
  if (!sign) return false;
  user.getSigningIdentity().sign = (msg: Uint8Array): Buffer => sign(msg);
  return true;
}
