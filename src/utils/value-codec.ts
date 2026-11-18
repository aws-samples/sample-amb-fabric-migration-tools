// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ExtractionError } from './errors';

/**
 * Encoding marker for a ledger value that is not representable as UTF-8 text.
 *
 * Absence of the marker means the record's `value` string *is* the value,
 * and is guaranteed to contain no NUL (U+0000).
 */
export type ValueEncoding = 'base64';

/** The value-bearing half of an extraction record. */
export interface EncodedValue {
  value: string;
  valueEncoding?: ValueEncoding;
}

/** A value ready to bind to a text or JSONB column. */
export interface ColumnValue {
  /** String to store. Never contains NUL. */
  value: string;
  /** `null` when `value` is the literal value; `'base64'` when it is encoded. */
  encoding: ValueEncoding | null;
}

const EMPTY = Buffer.alloc(0);

/** U+0000. Written as a code point so the source stays free of control chars. */
const NUL = String.fromCharCode(0);

/** Introducer of a JSON `\uXXXX` escape. */
const UNICODE_ESCAPE_PREFIX = '\\u';

/** Length of a `\uXXXX` escape. */
const UNICODE_ESCAPE_LEN = 6;

const BACKSLASH = '\\';

/**
 * Encode a raw ledger value for storage in an NDJSON extraction record.
 *
 * Fabric values are arbitrary byte strings. Most chaincode writes JSON, but
 * nothing stops it writing protobuf, gzip, or a raw hash. UTF-8 is used only
 * when the bytes round-trip byte-identically and contain no NUL; everything
 * else is base64 with an explicit `valueEncoding` marker.
 *
 * Excluding NUL from the text form is deliberate: PostgreSQL TEXT and JSONB
 * columns reject it, so this guarantees every unmarked value is storable
 * as-is on every destination.
 *
 * @param raw Value from a decoded block, private-data payload, or fixture.
 * @returns The record fields describing the value.
 */
export function encodeLedgerValue(raw: unknown): EncodedValue {
  const bytes = toBuffer(raw);
  if (bytes.length === 0) return { value: '' };

  if (!bytes.includes(0)) {
    const text = bytes.toString('utf-8');
    if (Buffer.from(text, 'utf-8').equals(bytes)) return { value: text };
  }

  return { value: bytes.toString('base64'), valueEncoding: 'base64' };
}

/**
 * Recover the exact bytes a ledger value was extracted from.
 *
 * @param rec Record carrying `value` and optional `valueEncoding`.
 * @returns The original value bytes.
 * @throws ExtractionError if `valueEncoding` names an unknown encoding.
 */
export function decodeLedgerValue(rec: EncodedValue): Buffer {
  assertKnownEncoding(rec.valueEncoding);
  if (!rec.value) return EMPTY;
  if (rec.valueEncoding === 'base64') return Buffer.from(rec.value, 'base64');
  return Buffer.from(rec.value, 'utf-8');
}

/**
 * True when the value is UTF-8 text, and so meaningful to compare as JSON
 * or a string. False for base64-encoded binary.
 */
export function isTextValue(rec: EncodedValue): boolean {
  assertKnownEncoding(rec.valueEncoding);
  return rec.valueEncoding === undefined;
}

/**
 * Project a record's value onto a NUL-free string plus its encoding.
 *
 * Re-asserts the codec invariant rather than trusting it: a record whose
 * `value` contains NUL without a marker is promoted to base64 instead of
 * being handed to a column that would reject it.
 *
 * NUL is also rejected in its JSON-escaped form. Chaincode that marshals a
 * struct holding a composite key emits `\u0000` inside the document, which
 * JSON permits but PostgreSQL JSONB refuses — and refusing it aborts the
 * whole insert, so the value is base64-encoded instead. Unpaired surrogate
 * escapes are refused for the same reason.
 */
export function toColumnValue(rec: EncodedValue): ColumnValue {
  assertKnownEncoding(rec.valueEncoding);
  const raw = rec.value ?? '';

  if (rec.valueEncoding === 'base64') return { value: raw, encoding: 'base64' };
  if (!raw.includes(NUL) && !hasJsonbHostileEscape(raw)) {
    return { value: raw, encoding: null };
  }

  return { value: Buffer.from(raw, 'utf-8').toString('base64'), encoding: 'base64' };
}

/**
 * Rebuild an EncodedValue from a destination row read back for verification.
 *
 * @param value Stored string, or null/undefined for an absent value.
 * @param encoding Stored encoding marker, or null/undefined for text.
 */
export function fromColumnValue(
  value: string | null | undefined,
  encoding: string | null | undefined,
): EncodedValue {
  const rec: EncodedValue = { value: value ?? '' };
  if (encoding) {
    assertKnownEncoding(encoding);
    rec.valueEncoding = encoding as ValueEncoding;
  }
  return rec;
}

/**
 * True when `text` contains a JSON escape that PostgreSQL JSONB rejects:
 * U+0000, or a surrogate that is not part of a valid pair.
 *
 * `JSON.parse` accepts both, so it cannot be used to decide whether a literal
 * is safe to cast to JSONB. JavaScript strings are UTF-16 code units and allow
 * a lone surrogate; `jsonb_in` materialises the string and refuses one with
 * `22P05, unsupported Unicode escape sequence`. The `::json` cast does *not*
 * refuse it — `json` validates syntax only — so only `jsonb` enforces this.
 *
 * Refusing an escape sends the value down the base64 path, which round-trips
 * losslessly, so a false positive costs representation and never data.
 *
 * @param text Candidate string for a JSONB column.
 */
function hasJsonbHostileEscape(text: string): boolean {
  for (const at of unescapedUnicodeEscapes(text)) {
    const code = parseInt(text.slice(at + 2, at + 6), 16);
    if (Number.isNaN(code)) continue;

    if (code === 0) return true;

    if (isHighSurrogate(code)) {
      // Valid only when a low-surrogate escape follows immediately.
      const nextAt = at + UNICODE_ESCAPE_LEN;
      const next = parseInt(text.slice(nextAt + 2, nextAt + UNICODE_ESCAPE_LEN), 16);
      const paired =
        text.slice(nextAt, nextAt + 2) === UNICODE_ESCAPE_PREFIX && isLowSurrogate(next);
      if (!paired) return true;
    } else if (isLowSurrogate(code)) {
      // Reached on its own, so it was not consumed as a pair's tail.
      const prevAt = at - UNICODE_ESCAPE_LEN;
      const prev = parseInt(text.slice(prevAt + 2, at), 16);
      const paired =
        prevAt >= 0 &&
        text.slice(prevAt, prevAt + 2) === UNICODE_ESCAPE_PREFIX &&
        isHighSurrogate(prev);
      if (!paired) return true;
    }
  }
  return false;
}

/**
 * Offsets of every escape introduced by an unescaped backslash.
 *
 * Parity matters: in a doubled backslash the first escapes the second, leaving
 * a literal backslash followed by `uXXXX`, which no JSON parser reads as an
 * escape at all.
 *
 * @param text String to scan.
 */
function* unescapedUnicodeEscapes(text: string): Generator<number> {
  for (
    let at = text.indexOf(UNICODE_ESCAPE_PREFIX);
    at >= 0;
    at = text.indexOf(UNICODE_ESCAPE_PREFIX, at + 1)
  ) {
    let backslashes = 0;
    for (let i = at - 1; i >= 0 && text[i] === BACKSLASH; i--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) yield at;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function assertKnownEncoding(encoding: string | undefined | null): void {
  if (encoding === undefined || encoding === null) return;
  if (encoding === 'base64') return;
  throw new ExtractionError(
    `Unknown valueEncoding '${encoding}'. Supported: base64, or omit the ` +
      'field for UTF-8 text. The record was likely written by a different ' +
      'version of this tool — re-extract rather than replaying it.',
  );
}

function toBuffer(raw: unknown): Buffer {
  if (raw === null || raw === undefined) return EMPTY;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf-8');
  return Buffer.from(JSON.stringify(raw), 'utf-8');
}
