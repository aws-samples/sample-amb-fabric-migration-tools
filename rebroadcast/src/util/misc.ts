// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as crypto from 'crypto';

export const sha256 = (b: Uint8Array | string): string => crypto.createHash('sha256').update(b).digest('hex');
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const u8 = (b: Uint8Array | string): Buffer => (typeof b === 'string' ? Buffer.from(b, 'base64') : Buffer.from(b));
export const hex = (b: Uint8Array | string): string => u8(b).toString('hex');

/** "500ms" / "2s" / "1.5s" → milliseconds. */
export function durationMs(d: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(d.trim());
  if (!m) throw new Error(`not a duration: "${d}" (use e.g. 500ms, 2s)`);
  return Number(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : 60000);
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Stable JSON: object keys sorted at every level (for comparing configs whose key order is not meaningful). */
export function canon(o: unknown): string {
  return JSON.stringify(sortKeys(o));
}
function sortKeys(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const k of Object.keys(o as object).sort()) r[k] = sortKeys((o as Record<string, unknown>)[k]);
    return r;
  }
  return o;
}

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

/**
 * Whether two values are the same JSON document. A CouchDB state database stores a JSON value as a document and
 * returns it re-serialised (keys sorted), so a key read through a CouchDB peer can differ in bytes from the value the
 * transaction wrote while the peer's commit hash, and its history, still match the source.
 */
export function sameJson(a: Buffer, b: Buffer): boolean {
  const canon = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(canon)
      : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])]))
        : x;
  try {
    const pa = JSON.parse(a.toString('utf8')), pb = JSON.parse(b.toString('utf8'));
    if (typeof pa !== 'object' || pa === null || typeof pb !== 'object' || pb === null) return false;
    return JSON.stringify(canon(pa)) === JSON.stringify(canon(pb));
  } catch {
    return false;
  }
}
