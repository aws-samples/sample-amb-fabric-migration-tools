// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { BlockParser } from '../src/extraction/block-parser';
import { ADMIN_CERT_FINGERPRINT, ADMIN_CERT_PEM } from './helpers/test-certs';

describe('BlockParser', () => {
  const parser = new BlockParser();

  const makeBlock = (overrides: any = {}) => ({
    header: { number: '5', data_hash: 'abc123', ...overrides.header },
    data: {
      data: [
        {
          payload: {
            header: {
              channel_header: {
                tx_id: 'tx-001',
                timestamp: '2024-01-15T10:30:00Z',
              },
              signature_header: {
                creator: {
                  mspid: 'Org1MSP',
                  id_bytes: ADMIN_CERT_PEM,
                },
              },
            },
            data: {
              actions: [
                {
                  payload: {
                    chaincode_proposal_payload: {
                      input: {
                        chaincode_spec: {
                          chaincode_id: { name: 'mycc' },
                        },
                      },
                    },
                    action: {
                      proposal_response_payload: {
                        extension: {
                          results: {
                            ns_rwset: [
                              {
                                namespace: 'mycc',
                                rwset: {
                                  writes: [
                                    { key: 'asset1', value: '{"color":"blue"}', is_delete: false },
                                    { key: 'asset2', value: '', is_delete: true },
                                  ],
                                },
                                collection_hashed_rwset: [],
                              },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
      ...overrides.data,
    },
    metadata: {
      metadata: [[], [], [0]], // tx at index 0 is valid (code 0)
      ...overrides.metadata,
    },
  });

  test('parses a valid block with one transaction', () => {
    const block = makeBlock();
    const parsed = parser.parseBlock(block);

    expect(parsed.blockNumber).toBe(5);
    expect(parsed.dataHash).toBe('abc123');
    expect(parsed.transactions).toHaveLength(1);

    const tx = parsed.transactions[0];
    expect(tx.txId).toBe('tx-001');
    expect(tx.timestamp).toBe('2024-01-15T10:30:00Z');
    expect(tx.chaincodeId).toBe('mycc');
    expect(tx.writes).toHaveLength(2);
    expect(tx.writes[0]).toEqual({
      namespace: 'mycc',
      key: 'asset1',
      value: '{"color":"blue"}',
      isDelete: false,
    });
    expect(tx.writes[1]).toEqual({
      namespace: 'mycc',
      key: 'asset2',
      value: '',
      isDelete: true,
    });
  });

  test('extracts creator identity', () => {
    const block = makeBlock();
    const parsed = parser.parseBlock(block);
    const creator = parsed.transactions[0].creator;

    expect(creator.mspId).toBe('Org1MSP');
    expect(creator.commonName).toBe('admin');
    expect(creator.org).toBe('org1.example.com');
    expect(creator.certFingerprint).toBe(ADMIN_CERT_FINGERPRINT);
  });

  test('filters invalid transactions', () => {
    const block = makeBlock({
      metadata: { metadata: [[], [], [1]] }, // tx validation code 1 = invalid
    });
    const parsed = parser.parseBlock(block);

    expect(parsed.transactions).toHaveLength(0);
  });

  test('skips lscc namespace writes', () => {
    const block = makeBlock();
    block.data.data[0].payload.data.actions[0].payload.action.proposal_response_payload.extension.results.ns_rwset.unshift(
      {
        namespace: 'lscc',
        rwset: { writes: [{ key: 'mycc', value: 'lifecycle-data', is_delete: false }] },
        collection_hashed_rwset: [],
      },
    );

    const parsed = parser.parseBlock(block);
    // Should only have writes from 'mycc' namespace, not 'lscc'
    expect(parsed.transactions[0].writes.every((w) => w.namespace === 'mycc')).toBe(true);
  });

  test('handles empty block', () => {
    const block = {
      header: { number: '0' },
      data: { data: [] },
      metadata: { metadata: [[], [], []] },
    };
    const parsed = parser.parseBlock(block);

    expect(parsed.blockNumber).toBe(0);
    expect(parsed.transactions).toHaveLength(0);
  });

  test('converts to history records', () => {
    const block = makeBlock();
    const parsed = parser.parseBlock(block);
    const records = parser.toHistoryRecords(parsed, 'mychannel');

    expect(records).toHaveLength(2);
    expect(records[0]._type).toBe('public_history');
    expect(records[0].channel).toBe('mychannel');
    expect(records[0].key).toBe('asset1');
    expect(records[0].blockNumber).toBe(5);
    expect(records[0].creator.mspId).toBe('Org1MSP');
  });

  test('converts to metadata records', () => {
    const block = makeBlock();
    const parsed = parser.parseBlock(block);
    const records = parser.toMetadataRecords(parsed, 'mychannel');

    expect(records).toHaveLength(1);
    expect(records[0]._type).toBe('block_metadata');
    expect(records[0].keysWritten).toEqual(['asset1']);
    expect(records[0].keysDeleted).toEqual(['asset2']);
  });

  // ── TRANSACTIONS_FILTER: fail closed ──

  describe('validation codes', () => {
    /** Replace the write set with a single write carrying `value`. */
    function blockWithFilter(filter: unknown) {
      const block = makeBlock();
      (block.metadata as any).metadata = [[], [], filter];
      return block;
    }

    test('accepts a Buffer filter', () => {
      const parsed = parser.parseBlock(blockWithFilter(Buffer.from([0])));
      expect(parsed.transactions).toHaveLength(1);
    });

    test('accepts a Uint8Array filter', () => {
      const parsed = parser.parseBlock(blockWithFilter(new Uint8Array([0])));
      expect(parsed.transactions).toHaveLength(1);
    });

    test('skips a transaction with any non-zero code', () => {
      // 11 = MVCC_READ_CONFLICT: endorsed, ordered, but never committed
      const parsed = parser.parseBlock(blockWithFilter([11]));
      expect(parsed.transactions).toHaveLength(0);
    });

    test('aborts when the filter is absent', () => {
      expect(() => parser.parseBlock(blockWithFilter(undefined))).toThrow(
        /TRANSACTIONS_FILTER holds an unrecognised value/,
      );
    });

    test('aborts when the filter is an empty array', () => {
      // The pre-Gate-1 behaviour: an empty filter admitted every transaction
      expect(() => parser.parseBlock(blockWithFilter([]))).toThrow(
        /TRANSACTIONS_FILTER holds 0 code\(s\)/,
      );
    });

    test('aborts when the filter is shorter than the transaction list', () => {
      const block = makeBlock();
      block.data.data.push(JSON.parse(JSON.stringify(block.data.data[0])));
      (block.metadata as any).metadata = [[], [], [0]];

      expect(() => parser.parseBlock(block)).toThrow(
        /2 transaction\(s\).*holds 1 code\(s\)/s,
      );
    });

    test('aborts when the filter is an unrecognised shape', () => {
      expect(() => parser.parseBlock(blockWithFilter('AA=='))).toThrow(
        /unrecognised value/,
      );
    });

    test('names the block number in the abort message', () => {
      expect(() => parser.parseBlock(blockWithFilter(null))).toThrow(/Block 5 /);
    });

    test('allows a block with no transactions and no filter', () => {
      const parsed = parser.parseBlock({
        header: { number: '0' },
        data: { data: [] },
        metadata: {},
      });
      expect(parsed.transactions).toHaveLength(0);
    });
  });

  // ── Unreadable transactions: fail closed when committed ──

  describe('transactions that cannot be read', () => {
    test('stops on a valid transaction the decoder could not decode', () => {
      const block = makeBlock();
      block.data.data.unshift({ decodeError: 'invalid wire type 7' } as any);
      (block.metadata as any).metadata = [[], [], [0, 0]];

      expect(() => parser.parseBlock(block)).toThrow(
        /Block 5, transaction 0: the peer marked it valid, but it could not be decoded \(invalid wire type 7\)/,
      );
    });

    test('skips an invalid transaction the decoder could not decode, keeping later indices', () => {
      // A malformed envelope the peer rejected (2 = BAD_PAYLOAD) holds a slot
      // in the filter like any other; the transaction after it stays index 1.
      const block = makeBlock();
      block.data.data.unshift({ decodeError: 'invalid wire type 7' } as any);
      (block.metadata as any).metadata = [[], [], [2, 0]];

      const parsed = parser.parseBlock(block);
      expect(parsed.transactions).toHaveLength(1);
      expect(parsed.transactions[0].txIndex).toBe(1);
      expect(parsed.transactions[0].txId).toBe('tx-001');
    });

    test('stops on a valid transaction that cannot be parsed', () => {
      const block = makeBlock();
      (block.data.data[0].payload.data as any).actions = 5; // not iterable

      expect(() => parser.parseBlock(block)).toThrow(
        /Block 5, transaction 0: the peer marked it valid, but it could not be parsed/,
      );
    });
  });

  // ── Value encoding ──

  describe('write values', () => {
    /** A block whose single write carries `value`. */
    function blockWithValue(value: unknown) {
      const block = makeBlock();
      block.data.data[0].payload.data.actions[0].payload.action
        .proposal_response_payload.extension.results.ns_rwset[0].rwset.writes = [
        { key: 'asset1', value, is_delete: false },
      ] as any;
      return block;
    }

    test('leaves a UTF-8 value unmarked', () => {
      const write = parser.parseBlock(blockWithValue('{"a":1}')).transactions[0].writes[0];

      expect(write.value).toBe('{"a":1}');
      expect(write.valueEncoding).toBeUndefined();
    });

    test('base64-encodes a value that is not valid UTF-8', () => {
      const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0xff]);
      const write = parser.parseBlock(blockWithValue(bytes)).transactions[0].writes[0];

      expect(write.valueEncoding).toBe('base64');
      expect(Buffer.from(write.value, 'base64')).toEqual(bytes);
    });

    test('carries the encoding marker onto history records', () => {
      const bytes = Buffer.from([0x00, 0xff]);
      const parsed = parser.parseBlock(blockWithValue(bytes));
      const records = parser.toHistoryRecords(parsed, 'mychannel');

      expect(records[0].valueEncoding).toBe('base64');
      expect(Buffer.from(records[0].value, 'base64')).toEqual(bytes);
    });

    test('omits the marker from serialized history records for text', () => {
      const parsed = parser.parseBlock(blockWithValue('plain'));
      const records = parser.toHistoryRecords(parsed, 'mychannel');

      expect(JSON.parse(JSON.stringify(records[0]))).not.toHaveProperty(
        'valueEncoding',
      );
    });
  });
});
