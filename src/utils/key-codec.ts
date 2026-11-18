// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/** U+0000. Written as a code point so the source stays free of control chars. */
const NUL = String.fromCharCode(0);

/** Marks a stored key as base64 of the original key's UTF-8 bytes. */
const B64_PREFIX = 'b64:';

/**
 * Escape a Fabric state key for storage in a PostgreSQL TEXT column or a
 * DynamoDB key attribute.
 *
 * Fabric's `CreateCompositeKey` uses U+0000 as its only separator, so every
 * composite key contains a byte PostgreSQL TEXT rejects outright. Such keys
 * are stored as `b64:<base64 of the key's UTF-8 bytes>`. Ordinary keys are
 * stored verbatim so they stay readable and matchable by prefix — with plain
 * SQL at a PostgreSQL destination, and as a `Scan` filter at a DynamoDB one,
 * whose state table holds each key on its own partition and so has no ordered
 * range to query.
 *
 * Keys that already start with the literal `b64:` are escaped too, which is
 * what makes the mapping reversible.
 *
 * @param key Key exactly as it appeared on the source ledger.
 * @returns Storage form of the key, guaranteed free of NUL.
 */
export function encodeStorageKey(key: string): string {
  if (!key.includes(NUL) && !key.startsWith(B64_PREFIX)) return key;
  return B64_PREFIX + Buffer.from(key, 'utf-8').toString('base64');
}

/**
 * Reverse {@link encodeStorageKey}.
 *
 * @param stored Key as read back from a destination store.
 * @returns The original source-ledger key.
 */
export function decodeStorageKey(stored: string): string {
  if (!stored.startsWith(B64_PREFIX)) return stored;
  return Buffer.from(stored.slice(B64_PREFIX.length), 'base64').toString('utf-8');
}
