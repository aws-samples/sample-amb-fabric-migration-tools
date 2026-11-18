// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BATCH_DELETE,
  BATCH_ENTRY_HEADER_BYTES,
  BATCH_HEADER_BYTES,
  BATCH_WRITE,
  StateBatchEntry,
  frameStateBatch,
  framedBatchEntryBytes,
} from '../src/replay/state-batch';
import { decodeStateBatch } from './helpers/state-batch';

// ─── The batch framing ───
//
// Row 3.7. This is the only encoder, and the three readers are the migration
// contracts in Go, Node, and Java — none of which this repo can run. So the
// framing is pinned here by its bytes, not just by a round trip through a reader
// that shares this module's assumptions: `migration-contract.test.ts` holds the
// three implementations to the same constants and the same field order, and what
// is asserted below is what they will find on the wire.

/** Width of the entry count and of each length field, per the framing. */
const LENGTH_BYTES = (BATCH_ENTRY_HEADER_BYTES - 1) / 2;

function write(key: string, value: string): StateBatchEntry {
  return { key, value: Buffer.from(value, 'utf-8'), isDelete: false };
}

function tombstone(key: string): StateBatchEntry {
  return { key, value: Buffer.alloc(0), isDelete: true };
}

describe('frameStateBatch', () => {
  it('round-trips writes, tombstones, and bytes that are not UTF-8', () => {
    const entries: StateBatchEntry[] = [
      write('alpha', 'first'),
      tombstone('beta'),
      { key: 'gamma', value: Buffer.from([0x00, 0xff, 0xfe, 0x80]), isDelete: false },
    ];

    expect(decodeStateBatch(frameStateBatch(entries))).toEqual(entries);
  });

  /**
   * The adapter decides whether one more entry fits before it frames anything,
   * so an estimate below the truth would submit a transaction over the cap and
   * have the orderer reject the whole batch.
   */
  it('adds exactly what framedBatchEntryBytes predicts per entry', () => {
    const entries = [write('alpha', 'first'), tombstone('beta')];
    const predicted = entries.reduce(
      (total, entry) => total + framedBatchEntryBytes(entry),
      BATCH_HEADER_BYTES,
    );

    expect(frameStateBatch(entries)).toHaveLength(predicted);
    expect(
      frameStateBatch(entries).length - frameStateBatch([entries[0]]).length,
    ).toBe(framedBatchEntryBytes(entries[1]));
  });

  /**
   * The one width and order all three contract languages read without a
   * library. A little-endian count reads back as tens of millions of entries
   * here, which a parser refuses as a count that cannot fit — the failure is
   * loud, but it is every batch of more than 255 writes.
   */
  it('writes the entry count as unsigned 32-bit big-endian', () => {
    const entries = Array.from(
      { length: 258 },
      (_, i) => write(`k${i}`, `v${i}`),
    );

    expect([...frameStateBatch(entries).subarray(0, BATCH_HEADER_BYTES)])
      .toEqual([0x00, 0x00, 0x01, 0x02]);
  });

  it('writes each length as unsigned 32-bit big-endian', () => {
    const key = 'k'.repeat(300);
    const framed = frameStateBatch([write(key, 'v'.repeat(300))]);
    const keyLengthAt = BATCH_HEADER_BYTES;
    const valueLengthAt = keyLengthAt + LENGTH_BYTES + key.length + 1;

    expect([...framed.subarray(keyLengthAt, keyLengthAt + LENGTH_BYTES)])
      .toEqual([0x00, 0x00, 0x01, 0x2c]);
    expect([...framed.subarray(valueLengthAt, valueLengthAt + LENGTH_BYTES)])
      .toEqual([0x00, 0x00, 0x01, 0x2c]);
  });

  /**
   * A Go or Java parser advances by the byte count, so a length in JavaScript's
   * UTF-16 code units would leave it reading the next entry from inside this
   * key — and every entry after it is then garbage.
   */
  it('counts a key in UTF-8 bytes, not in code units', () => {
    const key = 'ключ\u{1F511}';
    const framed = frameStateBatch([write(key, 'v')]);

    expect(key.length).toBe(6);
    expect(framed.readUInt32BE(BATCH_HEADER_BYTES)).toBe(12);
    expect(framedBatchEntryBytes(write(key, 'v')))
      .toBe(BATCH_ENTRY_HEADER_BYTES + 12 + 1);
    expect(decodeStateBatch(framed)[0].key).toBe(key);
  });

  /**
   * A tombstone and a write of the empty value are different ledger facts —
   * verify compares `isDelete` — so the encoding cannot make them the same
   * bytes.
   */
  it('distinguishes a tombstone from a write of no bytes', () => {
    const empty = frameStateBatch([write('k', '')]);
    const deleted = frameStateBatch([tombstone('k')]);
    const flagAt = BATCH_HEADER_BYTES + LENGTH_BYTES + 1;

    expect(deleted).toHaveLength(empty.length);
    expect(empty[flagAt]).toBe(BATCH_WRITE);
    expect(deleted[flagAt]).toBe(BATCH_DELETE);
    expect(decodeStateBatch(empty)[0].isDelete).toBe(false);
    expect(decodeStateBatch(deleted)[0].isDelete).toBe(true);
  });

  /** Entries stay in the order given: a key's versions arrive in write order. */
  it('frames entries in the order it was given them', () => {
    const entries = ['a', 'b', 'c', 'd'].map((k) => write(k, `v-${k}`));

    expect(decodeStateBatch(frameStateBatch(entries)).map((e) => e.key))
      .toEqual(['a', 'b', 'c', 'd']);
  });
});
