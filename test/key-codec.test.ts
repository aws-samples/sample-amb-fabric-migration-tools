// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { decodeStorageKey, encodeStorageKey } from '../src/utils/key-codec';

/** U+0000, kept as a code point so this file stays free of control chars. */
const NUL = String.fromCharCode(0);

describe('encodeStorageKey', () => {
  it('passes an ordinary key through so plain SQL still finds it', () => {
    expect(encodeStorageKey('asset1')).toBe('asset1');
  });

  it('passes a key with tildes through — only NUL forces escaping', () => {
    // Fabric composite keys use `~` in the object type by convention, but the
    // separator is NUL. A `~` alone is storable.
    expect(encodeStorageKey('color~id')).toBe('color~id');
  });

  it('escapes a composite key', () => {
    const key = `color~id${NUL}blue${NUL}asset1`;
    const stored = encodeStorageKey(key);

    expect(stored).toBe('b64:' + Buffer.from(key, 'utf-8').toString('base64'));
    expect(stored).not.toContain(NUL);
  });

  it('escapes a key that already starts with the b64: marker', () => {
    // Without this the mapping would be ambiguous: a literal `b64:x` key and
    // the escaped form of some other key could collide.
    expect(encodeStorageKey('b64:abc')).toBe(
      'b64:' + Buffer.from('b64:abc', 'utf-8').toString('base64'),
    );
  });

  it('escapes a key that is only a NUL', () => {
    expect(encodeStorageKey(NUL)).toBe(
      'b64:' + Buffer.from(NUL, 'utf-8').toString('base64'),
    );
  });

  it('leaves the empty key alone', () => {
    expect(encodeStorageKey('')).toBe('');
  });

  it('preserves multi-byte characters in an unescaped key', () => {
    expect(encodeStorageKey('資産1')).toBe('資産1');
  });
});

describe('decodeStorageKey', () => {
  it('passes an unescaped key through', () => {
    expect(decodeStorageKey('asset1')).toBe('asset1');
  });

  it('decodes an escaped key', () => {
    const key = `a${NUL}b`;
    expect(decodeStorageKey(encodeStorageKey(key))).toBe(key);
  });
});

describe('key-codec round-trip', () => {
  const keys = [
    'asset1',
    '',
    'color~id',
    `color~id${NUL}blue${NUL}asset1`,
    `${NUL}leading`,
    `trailing${NUL}`,
    `${NUL}${NUL}`,
    'b64:notreallybase64',
    'b64:',
    '資産~id' + NUL + '青',
    'key with spaces and "quotes"',
  ];

  it.each(keys)('round-trips %j', (key) => {
    expect(decodeStorageKey(encodeStorageKey(key))).toBe(key);
  });

  it('never yields a storage key containing NUL', () => {
    for (const key of keys) {
      expect(encodeStorageKey(key)).not.toContain(NUL);
    }
  });

  it('maps distinct keys to distinct storage keys', () => {
    const stored = keys.map(encodeStorageKey);
    expect(new Set(stored).size).toBe(keys.length);
  });
});
