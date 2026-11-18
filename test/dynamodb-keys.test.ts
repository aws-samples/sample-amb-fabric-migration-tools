// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  padBlockNumber,
  padTxIndex,
  historySortKey,
  privateHistorySortKey,
  keyPartitionKey,
  metadataPartitionKey,
  metadataSortKey,
  parseKeyPartitionKey,
} from '../src/replay/adapters/dynamodb-keys';

describe('dynamodb-keys', () => {
  describe('padBlockNumber', () => {
    it('pads zero to 12 digits', () => {
      expect(padBlockNumber(0)).toBe('000000000000');
    });

    it('pads a typical block number', () => {
      expect(padBlockNumber(42)).toBe('000000000042');
    });

    it('handles large block numbers', () => {
      expect(padBlockNumber(999999999999)).toBe('999999999999');
    });
  });

  describe('padTxIndex', () => {
    it('pads zero to 4 digits', () => {
      expect(padTxIndex(0)).toBe('0000');
    });

    it('pads a typical tx index', () => {
      expect(padTxIndex(5)).toBe('0005');
    });

    it('handles max 4-digit value', () => {
      expect(padTxIndex(9999)).toBe('9999');
    });
  });

  describe('historySortKey', () => {
    it('builds padded sort key', () => {
      expect(historySortKey(42, 3, 'abc123')).toBe(
        '000000000042#0003#abc123',
      );
    });

    it('sorts block 9 before block 10 lexicographically', () => {
      const sk9 = historySortKey(9, 0, 'zzz');
      const sk10 = historySortKey(10, 0, 'aaa');
      expect(sk9 < sk10).toBe(true);
    });

    it('sorts by txIndex within the same block', () => {
      const sk1 = historySortKey(5, 1, 'zzz');
      const sk2 = historySortKey(5, 2, 'aaa');
      expect(sk1 < sk2).toBe(true);
    });
  });

  describe('privateHistorySortKey', () => {
    it('appends collection to sort key', () => {
      expect(privateHistorySortKey(42, 3, 'abc123', 'col1')).toBe(
        '000000000042#0003#abc123#col1',
      );
    });
  });

  describe('metadataPartitionKey', () => {
    it('pads block number in partition key', () => {
      expect(metadataPartitionKey('ch1', 42)).toBe(
        'ch1#000000000042',
      );
    });
  });

  describe('metadataSortKey', () => {
    it('pads txIndex before txId', () => {
      expect(metadataSortKey(0, 'txabc')).toBe('0000#txabc');
    });
  });

  describe('keyPartitionKey', () => {
    it('joins channel, chaincode, collection and key', () => {
      expect(keyPartitionKey('ch1', 'mycc', 'col1', 'asset1')).toBe(
        'ch1#mycc#col1#asset1',
      );
    });

    it('leaves the collection field empty for public state', () => {
      expect(keyPartitionKey('ch1', 'mycc', '', 'asset1')).toBe(
        'ch1#mycc##asset1',
      );
    });

    it('gives every key its own partition', () => {
      const keys = ['a', 'b', 'c'].map((k) => keyPartitionKey('ch1', 'mycc', '', k));
      expect(new Set(keys).size).toBe(3);
    });
  });

  describe('parseKeyPartitionKey', () => {
    it('round-trips a public key', () => {
      expect(parseKeyPartitionKey(keyPartitionKey('ch1', 'mycc', '', 'asset1'))).toEqual({
        channel: 'ch1', chaincode: 'mycc', collection: '', storedKey: 'asset1',
      });
    });

    it('round-trips a private key', () => {
      expect(parseKeyPartitionKey(keyPartitionKey('ch1', 'mycc', 'col1', 'asset1'))).toEqual({
        channel: 'ch1', chaincode: 'mycc', collection: 'col1', storedKey: 'asset1',
      });
    });

    it('recovers a key that itself contains the separator', () => {
      // Only the ledger key may contain '#' under Fabric's naming rules, and it
      // comes last — so the remainder is the key however many parts it splits into.
      expect(parseKeyPartitionKey('ch1#mycc##a#b#c')).toEqual({
        channel: 'ch1', chaincode: 'mycc', collection: '', storedKey: 'a#b#c',
      });
    });

    it('recovers a key that starts with the separator', () => {
      expect(parseKeyPartitionKey('ch1#mycc###suffix')).toEqual({
        channel: 'ch1', chaincode: 'mycc', collection: '', storedKey: '#suffix',
      });
    });

    it('rejects a key with a field missing', () => {
      expect(parseKeyPartitionKey('ch1#mycc#col1')).toBeUndefined();
    });

    it('rejects an empty ledger key, which Fabric does not allow', () => {
      expect(parseKeyPartitionKey('ch1#mycc#col1#')).toBeUndefined();
    });

    it('rejects an attribute that is not a string', () => {
      // The caller reads whatever a Scan hands back, including items nothing
      // in this toolkit wrote.
      expect(parseKeyPartitionKey(undefined)).toBeUndefined();
      expect(parseKeyPartitionKey(42)).toBeUndefined();
      expect(parseKeyPartitionKey({ pk: 'ch1#mycc##k1' })).toBeUndefined();
    });

    it('rejects a list whose one element would parse if it were coerced', () => {
      // A DynamoDB list attribute of a single string stringifies to that
      // string, so a type check is the only thing standing between a Scan and
      // an extra key reported off an item this toolkit did not write.
      expect(parseKeyPartitionKey(['ch1#mycc##k1'])).toBeUndefined();
    });
  });
});
