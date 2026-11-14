import * as crypto from 'crypto';
import { FabricIdentity } from '../types';
import { createLogger } from './logger';

const logger = createLogger('cert-parser');

const UNKNOWN_MSP = 'unknown';

/**
 * Identity cache, keyed by MSP ID + certificate bytes.
 *
 * `parseCreator` runs once per transaction — millions of times on a tall
 * ledger — but a network has only a handful of signing identities, so the
 * hit rate is effectively 100%. Cleared wholesale when it grows past the
 * bound rather than tracking recency.
 */
const identityCache = new Map<string, FabricIdentity>();
const IDENTITY_CACHE_MAX = 4096;

/** Warn once per distinct parse failure instead of once per transaction. */
const warnedParseErrors = new Set<string>();

/**
 * Parse a Fabric creator object (from block headers) into a FabricIdentity.
 *
 * Handles both camelCase and snake_case field names emitted by different
 * Fabric SDK versions. The certificate is parsed as X.509 — DER or PEM — so
 * the subject DN is read from the parsed structure and the fingerprint is
 * SHA-256 over the DER bytes, matching `openssl x509 -fingerprint -sha256`.
 *
 * A certificate that will not parse yields an empty common name and org,
 * and a fingerprint over the raw bytes so distinct identities stay distinct.
 *
 * @param creatorObj `signature_header.creator` from a decoded block.
 * @returns The identity, with `mspId: 'unknown'` when the creator is absent.
 */
export function parseCreator(creatorObj: any): FabricIdentity {
  if (!creatorObj) {
    return { mspId: UNKNOWN_MSP, certFingerprint: '', commonName: '', org: '' };
  }

  const mspId = creatorObj.mspid ?? creatorObj.Mspid ?? UNKNOWN_MSP;
  const certBytes = toCertBytes(creatorObj.id_bytes ?? creatorObj.IdBytes);

  if (certBytes.length === 0) {
    return { mspId, certFingerprint: '', commonName: '', org: '' };
  }

  const cacheKey = `${mspId}:${certBytes.toString('base64')}`;
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;

  const identity = buildIdentity(mspId, certBytes);

  if (identityCache.size >= IDENTITY_CACHE_MAX) identityCache.clear();
  identityCache.set(cacheKey, identity);

  return identity;
}

function buildIdentity(mspId: string, certBytes: Buffer): FabricIdentity {
  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(certBytes);
  } catch (err) {
    const message = (err as Error).message;
    if (!warnedParseErrors.has(message)) {
      warnedParseErrors.add(message);
      logger.warn(
        { mspId, error: message },
        'Creator certificate did not parse as X.509 — identity will have no ' +
          'common name or org. Its fingerprint is taken over the raw bytes.',
      );
    }
    return {
      mspId,
      certFingerprint: `sha256:${sha256Hex(certBytes)}`,
      commonName: '',
      org: '',
    };
  }

  const subject = parseSubject(cert.subject);
  return {
    mspId,
    certFingerprint: `sha256:${normalizeFingerprint(cert.fingerprint256)}`,
    commonName: subject.get('CN') ?? '',
    org: subject.get('O') ?? '',
  };
}

/**
 * Split an X.509 subject DN into its relative distinguished names.
 *
 * Node renders `subject` one RDN per line; older releases and some inputs use
 * comma separation. The first occurrence of an attribute wins, matching how
 * Fabric treats the leaf CN.
 */
function parseSubject(subject: string): Map<string, string> {
  const parts = subject.includes('\n') ? subject.split('\n') : subject.split(',');
  const rdns = new Map<string, string>();

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toUpperCase();
    if (rdns.has(name)) continue;
    rdns.set(name, part.slice(eq + 1).trim());
  }

  return rdns;
}

/** `AB:CD:...` from Node's fingerprint accessors to bare lowercase hex. */
function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').toLowerCase();
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function toCertBytes(raw: unknown): Buffer {
  if (raw === null || raw === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf-8');
  return Buffer.alloc(0);
}
