import {
  decodeLedgerValue,
  encodeLedgerValue,
  fromColumnValue,
  isTextValue,
  toColumnValue,
} from '../src/utils/value-codec';
import { ExtractionError } from '../src/utils/errors';

/** U+0000, kept as a code point so this file stays free of control chars. */
const NUL = String.fromCharCode(0);

describe('encodeLedgerValue', () => {
  it('keeps plain UTF-8 text unmarked', () => {
    expect(encodeLedgerValue('{"owner":"alice"}')).toEqual({
      value: '{"owner":"alice"}',
    });
  });

  it('keeps multi-byte UTF-8 unmarked', () => {
    expect(encodeLedgerValue('日本語 — émoji 🎉')).toEqual({
      value: '日本語 — émoji 🎉',
    });
  });

  it('returns an empty value for empty input', () => {
    expect(encodeLedgerValue(Buffer.alloc(0))).toEqual({ value: '' });
    expect(encodeLedgerValue('')).toEqual({ value: '' });
    expect(encodeLedgerValue(null)).toEqual({ value: '' });
    expect(encodeLedgerValue(undefined)).toEqual({ value: '' });
  });

  it('base64-encodes bytes that are not valid UTF-8', () => {
    // 0xff is never a legal UTF-8 lead byte, so this cannot round-trip as text
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x42]);
    expect(encodeLedgerValue(bytes)).toEqual({
      value: bytes.toString('base64'),
      valueEncoding: 'base64',
    });
  });

  it('base64-encodes text that is valid UTF-8 but contains NUL', () => {
    const composite = `color~id${NUL}blue${NUL}asset1`;
    const encoded = encodeLedgerValue(composite);

    expect(encoded.valueEncoding).toBe('base64');
    expect(encoded.value).not.toContain(NUL);
    expect(decodeLedgerValue(encoded).toString('utf-8')).toBe(composite);
  });

  it('base64-encodes lone surrogates rather than mangling them', () => {
    // WTF-8 of an unpaired surrogate: utf-8 decode replaces it with U+FFFD,
    // so the byte round-trip check fails and base64 takes over.
    const bytes = Buffer.from([0xed, 0xa0, 0x80]);
    const encoded = encodeLedgerValue(bytes);

    expect(encoded.valueEncoding).toBe('base64');
    expect(decodeLedgerValue(encoded)).toEqual(bytes);
  });

  it('accepts a Uint8Array without copying semantics changing the value', () => {
    const bytes = new Uint8Array([0x68, 0x69]);
    expect(encodeLedgerValue(bytes)).toEqual({ value: 'hi' });
  });

  it('serializes a non-string, non-buffer value as JSON', () => {
    expect(encodeLedgerValue({ a: 1 })).toEqual({ value: '{"a":1}' });
  });

  it('round-trips every byte value through base64', () => {
    const allBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(decodeLedgerValue(encodeLedgerValue(allBytes))).toEqual(allBytes);
  });
});

describe('decodeLedgerValue', () => {
  it('decodes text as UTF-8', () => {
    expect(decodeLedgerValue({ value: 'hi' })).toEqual(Buffer.from('hi'));
  });

  it('decodes base64 back to exact bytes', () => {
    expect(
      decodeLedgerValue({ value: 'AP/+Qg==', valueEncoding: 'base64' }),
    ).toEqual(Buffer.from([0x00, 0xff, 0xfe, 0x42]));
  });

  it('returns empty for an empty value regardless of marker', () => {
    expect(decodeLedgerValue({ value: '' })).toEqual(Buffer.alloc(0));
    expect(
      decodeLedgerValue({ value: '', valueEncoding: 'base64' }),
    ).toEqual(Buffer.alloc(0));
  });

  it('refuses an unknown encoding instead of guessing', () => {
    expect(() =>
      decodeLedgerValue({ value: 'x', valueEncoding: 'gzip' as any }),
    ).toThrow(ExtractionError);
    expect(() =>
      decodeLedgerValue({ value: 'x', valueEncoding: 'gzip' as any }),
    ).toThrow(/Unknown valueEncoding 'gzip'/);
  });
});

describe('isTextValue', () => {
  it('is true only for unmarked values', () => {
    expect(isTextValue({ value: 'hi' })).toBe(true);
    expect(isTextValue({ value: 'aGk=', valueEncoding: 'base64' })).toBe(false);
  });

  it('refuses an unknown encoding', () => {
    expect(() => isTextValue({ value: 'x', valueEncoding: 'hex' as any })).toThrow(
      ExtractionError,
    );
  });
});

describe('toColumnValue', () => {
  it('passes text through with no encoding marker', () => {
    expect(toColumnValue({ value: '{"a":1}' })).toEqual({
      value: '{"a":1}',
      encoding: null,
    });
  });

  it('passes a base64 value through with its marker', () => {
    expect(toColumnValue({ value: 'AP8=', valueEncoding: 'base64' })).toEqual({
      value: 'AP8=',
      encoding: 'base64',
    });
  });

  it('promotes a literal NUL to base64 even when the record is unmarked', () => {
    const result = toColumnValue({ value: `a${NUL}b` });

    expect(result.encoding).toBe('base64');
    expect(result.value).not.toContain(NUL);
    expect(Buffer.from(result.value, 'base64').toString('utf-8')).toBe(`a${NUL}b`);
  });

  it('promotes a JSON-escaped NUL to base64', () => {
    // What Go's json.Marshal emits for a struct field holding a composite key.
    // JSON permits it; PostgreSQL JSONB rejects it and aborts the whole insert.
    const marshalled = '{"key":"color~id\\u0000blue"}';
    const result = toColumnValue({ value: marshalled });

    expect(result.encoding).toBe('base64');
    expect(Buffer.from(result.value, 'base64').toString('utf-8')).toBe(marshalled);
  });

  it('leaves an escaped backslash followed by u0000 as text', () => {
    // `\\u0000` is a literal backslash then `u0000` — no parser reads it as NUL
    const literal = '{"path":"C:\\\\u0000notnul"}';
    expect(toColumnValue({ value: literal })).toEqual({
      value: literal,
      encoding: null,
    });
  });

  it('detects a NUL escape after an odd run of backslashes', () => {
    // Three backslashes then `u0000`: the third one escapes, so this is NUL
    const value = '{"k":"\\\\\\u0000"}';
    expect(value).toContain('\\\\\\u0000');
    expect(toColumnValue({ value }).encoding).toBe('base64');
  });

  // JSONB refuses a Unicode escape it cannot materialise as a character, with
  // `22P05, unsupported Unicode escape sequence`. JSON.parse accepts every one
  // of these, so it cannot stand in for the check.
  it('promotes an unpaired high-surrogate escape to base64', () => {
    // What JSON.stringify emits for a string cut mid-emoji.
    const value = '{"s":"\\ud83d"}';
    const result = toColumnValue({ value });

    expect(result.encoding).toBe('base64');
    expect(Buffer.from(result.value, 'base64').toString('utf-8')).toBe(value);
  });

  it('promotes an unpaired low-surrogate escape to base64', () => {
    expect(toColumnValue({ value: '{"s":"\\udc4d"}' }).encoding).toBe('base64');
  });

  it('promotes a high surrogate followed by a plain character to base64', () => {
    expect(toColumnValue({ value: '{"s":"\\ud83dx"}' }).encoding).toBe('base64');
  });

  it('promotes two high surrogates in a row to base64', () => {
    expect(toColumnValue({ value: '{"s":"\\ud83d\\ud83d"}' }).encoding).toBe('base64');
  });

  it('leaves a valid surrogate pair as text', () => {
    // U+1F44D as JSON writes it. JSONB materialises this fine.
    const value = '{"s":"\\ud83d\\udc4d"}';
    expect(toColumnValue({ value })).toEqual({ value, encoding: null });
  });

  it('leaves a run of valid surrogate pairs as text', () => {
    // Each low surrogate has to find the high surrogate immediately before it,
    // not merely somewhere earlier in the string.
    const value = '{"s":"\\ud83d\\udc4d\\ud83d\\ude00"}';
    expect(toColumnValue({ value }).encoding).toBeNull();
  });

  it('leaves an ordinary BMP escape as text', () => {
    const value = '{"s":"caf\\u00e9"}';
    expect(toColumnValue({ value })).toEqual({ value, encoding: null });
  });

  it('leaves an escaped backslash before a surrogate escape as text', () => {
    // `\\ud83d` is a literal backslash then `ud83d` — not an escape at all.
    const value = '{"path":"C:\\\\ud83d"}';
    expect(toColumnValue({ value })).toEqual({ value, encoding: null });
  });

  it('treats a missing value as empty text', () => {
    expect(toColumnValue({ value: undefined as any })).toEqual({
      value: '',
      encoding: null,
    });
  });

  it('refuses an unknown encoding', () => {
    expect(() =>
      toColumnValue({ value: 'x', valueEncoding: 'utf16' as any }),
    ).toThrow(ExtractionError);
  });
});

describe('fromColumnValue', () => {
  it('round-trips a text column', () => {
    const rec = fromColumnValue('{"a":1}', null);
    expect(rec).toEqual({ value: '{"a":1}' });
    expect(isTextValue(rec)).toBe(true);
  });

  it('round-trips a base64 column', () => {
    const rec = fromColumnValue('AP8=', 'base64');
    expect(rec).toEqual({ value: 'AP8=', valueEncoding: 'base64' });
    expect(decodeLedgerValue(rec)).toEqual(Buffer.from([0x00, 0xff]));
  });

  it('treats null and undefined as an empty text value', () => {
    expect(fromColumnValue(null, null)).toEqual({ value: '' });
    expect(fromColumnValue(undefined, undefined)).toEqual({ value: '' });
  });

  it('refuses an unknown stored encoding', () => {
    expect(() => fromColumnValue('x', 'rot13')).toThrow(ExtractionError);
  });

  it('survives a full extract → store → read-back cycle for binary', () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]);
    const extracted = encodeLedgerValue(bytes);
    const column = toColumnValue(extracted);
    const readBack = fromColumnValue(column.value, column.encoding);

    expect(decodeLedgerValue(readBack)).toEqual(bytes);
  });

  it('survives a full cycle for a value holding an escaped NUL', () => {
    const marshalled = '{"key":"a\\u0000b"}';
    const extracted = encodeLedgerValue(marshalled);
    const column = toColumnValue(extracted);
    const readBack = fromColumnValue(column.value, column.encoding);

    expect(decodeLedgerValue(readBack).toString('utf-8')).toBe(marshalled);
  });
});
