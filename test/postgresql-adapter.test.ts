import { assertPostgresqlTls, PostgresqlAdapter, toJsonbLiteral } from '../src/replay/adapters/postgresql-adapter';
import {
  BlockMetadataRecord,
  IdentityRecord,
  PrivateHashRecord,
  PrivateHistoryRecord,
  PrivateStateRecord,
  PublicHistoryRecord,
  PublicStateRecord,
} from '../src/types';
import { ReplayError } from '../src/utils/errors';

// ── Mock pg ──
// jest.mock factories are hoisted above variable declarations, so the mock
// Pool reaches the shared spies through a closure that resolves at call time.
const mockClientQuery = jest.fn();
const mockPoolQuery = jest.fn();
const mockRelease = jest.fn();
const mockEnd = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(function (this: any) {
    this.query = (...args: any[]) => mockPoolQuery(...args);
    this.end = (...args: any[]) => mockEnd(...args);
    this.connect = () =>
      Promise.resolve({
        query: (...args: any[]) => mockClientQuery(...args),
        release: (...args: any[]) => mockRelease(...args),
      });
  }),
}));

// ── Helpers ──

/** U+0000, Fabric's only composite-key separator. */
const NUL = String.fromCharCode(0);

interface Insert {
  sql: string;
  values: any[];
}

/** Every INSERT issued on the client, in order, excluding BEGIN/COMMIT/ROLLBACK. */
function inserts(): Insert[] {
  return mockClientQuery.mock.calls
    .filter((call) => Array.isArray(call[1]))
    .map((call) => ({ sql: call[0] as string, values: call[1] as any[] }));
}

/** The single INSERT targeting `table`. Fails the test if there isn't exactly one. */
function insertInto(table: string): Insert {
  const matches = inserts().filter((i) => i.sql.includes(`INTO ${table}`));
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Statements issued without parameters, i.e. the transaction control ones. */
function controlStatements(): string[] {
  return mockClientQuery.mock.calls
    .filter((call) => !Array.isArray(call[1]))
    .map((call) => call[0] as string);
}

function makePublicState(
  key: string,
  value = `v-${key}`,
  valueEncoding?: 'base64',
): PublicStateRecord {
  const rec: PublicStateRecord = {
    _type: 'public_state',
    channel: 'ch1',
    chaincode: 'mycc',
    key,
    value,
  };
  if (valueEncoding) rec.valueEncoding = valueEncoding;
  return rec;
}

function makePrivateState(key: string, value = `pv-${key}`): PrivateStateRecord {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value,
  };
}

function makePublicHistory(key: string, value = 'v1'): PublicHistoryRecord {
  return {
    _type: 'public_history',
    channel: 'ch1',
    chaincode: 'mycc',
    key,
    value,
    txId: 'tx1',
    txIndex: 0,
    blockNumber: 7,
    timestamp: '2024-01-01T00:00:00Z',
    isDelete: false,
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

function makePrivateHistory(key: string, value = 'pv1'): PrivateHistoryRecord {
  return {
    _type: 'private_history',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    value,
    txId: 'tx1',
    blockNumber: 7,
    txIndex: 0,
    timestamp: '2024-01-01T00:00:00Z',
    isDelete: false,
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

function makePrivateHash(key: string): PrivateHashRecord {
  return {
    _type: 'private_hash',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key,
    hash: 'deadbeef',
    blockNumber: 7,
    txId: 'tx1',
    txIndex: 0,
  };
}

function makeBlockMetadata(
  keysWritten: string[],
  keysDeleted: string[] = [],
): BlockMetadataRecord {
  return {
    _type: 'block_metadata',
    channel: 'ch1',
    blockNumber: 7,
    txId: 'tx1',
    txIndex: 0,
    timestamp: '2024-01-01T00:00:00Z',
    chaincodeId: 'mycc',
    keysWritten,
    keysDeleted,
    creator: { mspId: 'Org1MSP', commonName: 'admin', org: 'org1', certFingerprint: 'fp1' },
  };
}

function makeIdentity(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    _type: 'identity',
    mspId: 'Org1MSP',
    certFingerprint: 'fp1',
    commonName: 'admin',
    org: 'org1',
    firstSeenBlock: 3,
    lastSeenBlock: 10,
    txCount: 5,
    ...overrides,
  };
}

// ── Tests ──

describe('PostgresqlAdapter', () => {
  let adapter: PostgresqlAdapter;

  beforeEach(() => {
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockPoolQuery.mockReset();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockEnd.mockReset();
    mockEnd.mockResolvedValue(undefined);
    adapter = new PostgresqlAdapter('postgres://localhost/test');
  });

  describe('initialize', () => {
    it('declares a value_encoding sidecar on both value-bearing tables', async () => {
      await adapter.initialize();

      const ddl = mockPoolQuery.mock.calls[0][0] as string;
      expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS fabric_state[^;]*value_encoding TEXT/s);
      expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS fabric_history[^;]*value_encoding TEXT/s);
    });

    it('persists the source transaction index for canonical history order', async () => {
      await adapter.initialize();

      const ddl = mockPoolQuery.mock.calls[0][0] as string;
      expect(ddl).toContain('tx_index INTEGER');
      expect(ddl).toMatch(
        /ALTER TABLE fabric_history\s+ADD COLUMN IF NOT EXISTS tx_index INTEGER/,
      );
      expect(ddl).toContain(
        'idx_fabric_history_source_order ON fabric_history(channel, chaincode, key, block_number, tx_index, tx_id)',
      );
    });

    it('keys public and private state apart by collection', async () => {
      await adapter.initialize();

      // Without COALESCE, a NULL collection would make every public-state row
      // distinct from every other and the upsert would never fire.
      expect(mockPoolQuery.mock.calls[0][0]).toContain(
        "idx_fabric_state_unique ON fabric_state(channel, chaincode, key, COALESCE(collection, ''))",
      );
    });
  });

  describe('key escaping', () => {
    it('stores a composite key in its base64 form', async () => {
      const key = `color~id${NUL}blue${NUL}asset1`;
      await adapter.replayBatch([makePublicState(key)]);

      const expected = 'b64:' + Buffer.from(key, 'utf-8').toString('base64');
      expect(insertInto('fabric_state').values[2]).toBe(expected);
    });

    it('stores an ordinary key verbatim so plain SQL still finds it', async () => {
      await adapter.replayBatch([makePublicState('asset1')]);

      expect(insertInto('fabric_state').values[2]).toBe('asset1');
    });

    it('escapes a key that already starts with the b64 marker', async () => {
      // Otherwise decoding is ambiguous: a literal `b64:...` key would be
      // read back as base64 of something else.
      await adapter.replayBatch([makePublicState('b64:notreallyencoded')]);

      expect(insertInto('fabric_state').values[2]).toBe(
        'b64:' + Buffer.from('b64:notreallyencoded', 'utf-8').toString('base64'),
      );
    });

    it('escapes keys on every value-bearing table', async () => {
      const key = `ns${NUL}a`;
      const escaped = 'b64:' + Buffer.from(key, 'utf-8').toString('base64');
      await adapter.replayBatch([
        makePublicState(key),
        makePrivateState(key),
        makePublicHistory(key),
        makePrivateHistory(key),
      ]);

      const stateInserts = inserts().filter((i) => i.sql.includes('INTO fabric_state'));
      const historyInserts = inserts().filter((i) => i.sql.includes('INTO fabric_history'));
      expect(stateInserts).toHaveLength(2);
      expect(historyInserts).toHaveLength(2);
      for (const insert of [...stateInserts, ...historyInserts]) {
        expect(insert.values[2]).toBe(escaped);
      }
    });

    it('escapes the key lists on block metadata', async () => {
      const written = `color~id${NUL}blue`;
      const deleted = `color~id${NUL}red`;
      await adapter.replayBatch([makeBlockMetadata([written, 'plain'], [deleted])]);

      const { values } = insertInto('fabric_block_metadata');
      expect(values[5]).toEqual([
        'b64:' + Buffer.from(written, 'utf-8').toString('base64'),
        'plain',
      ]);
      expect(values[6]).toEqual(['b64:' + Buffer.from(deleted, 'utf-8').toString('base64')]);
    });

    it('leaves private-hash keys alone', async () => {
      // These are hex digests of the real key, so they cannot contain NUL and
      // escaping them would only make them unrecognisable to `verify`.
      await adapter.replayBatch([makePrivateHash('a1b2c3')]);

      expect(insertInto('fabric_private_hashes').values[3]).toBe('a1b2c3');
    });
  });

  describe('value encoding', () => {
    it('never applies key escaping to a value', async () => {
      // A value can hold NUL for reasons of its own. It gets base64-encoded via
      // value_encoding, not tagged with the key codec's `b64:` marker.
      await adapter.replayBatch([makePublicState('asset1', `raw${NUL}bytes`)]);

      const { values } = insertInto('fabric_state');
      expect(values[3]).not.toContain('b64:');
      expect(values[4]).toBe('base64');
      expect(JSON.parse(values[3] as string)).toBe(
        Buffer.from(`raw${NUL}bytes`, 'utf-8').toString('base64'),
      );
    });

    it('passes a JSON value through and leaves the encoding null', async () => {
      await adapter.replayBatch([makePublicState('asset1', '{"color":"blue"}')]);

      const { values } = insertInto('fabric_state');
      expect(values[3]).toBe('{"color":"blue"}');
      expect(values[4]).toBeNull();
    });

    it('quotes a non-JSON text value so JSONB accepts it', async () => {
      await adapter.replayBatch([makePublicState('asset1', 'hello')]);

      const { values } = insertInto('fabric_state');
      expect(values[3]).toBe('"hello"');
      expect(values[4]).toBeNull();
    });

    it('marks an already-base64 record and stores the base64 as a JSON string', async () => {
      const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0xff]);
      await adapter.replayBatch([
        makePublicState('asset1', bytes.toString('base64'), 'base64'),
      ]);

      const { values } = insertInto('fabric_state');
      expect(values[4]).toBe('base64');
      expect(Buffer.from(JSON.parse(values[3] as string), 'base64')).toEqual(bytes);
    });

    it('promotes a value carrying a JSON-escaped NUL to base64', async () => {
      // What Go's json.Marshal emits for a struct field holding a composite
      // key. JSON permits it; PostgreSQL JSONB rejects it outright.
      const value = '{"ref":"color~id\\u0000blue"}';
      await adapter.replayBatch([makePublicState('asset1', value)]);

      const { values } = insertInto('fabric_state');
      expect(values[4]).toBe('base64');
      expect(Buffer.from(JSON.parse(values[3] as string), 'base64').toString('utf-8')).toBe(
        value,
      );
    });

    it('binds a null JSONB literal for a deleted key', async () => {
      await adapter.replayBatch([makePublicState('asset1', '')]);

      const { values } = insertInto('fabric_state');
      expect(values[3]).toBeNull();
      expect(values[4]).toBeNull();
    });

    it('encodes key and value independently', async () => {
      const key = `color~id${NUL}blue`;
      const bytes = Buffer.from([0x00, 0xff]);
      await adapter.replayBatch([
        makePublicState(key, bytes.toString('base64'), 'base64'),
      ]);

      const { values } = insertInto('fabric_state');
      expect(values[2]).toBe('b64:' + Buffer.from(key, 'utf-8').toString('base64'));
      expect(Buffer.from(JSON.parse(values[3] as string), 'base64')).toEqual(bytes);
    });

    it('carries source txIndex onto history rows', async () => {
      await adapter.replayBatch([{
        ...makePublicHistory('asset1'),
        txIndex: 6,
      }]);

      const { sql, values } = insertInto('fabric_history');
      expect(sql).toContain('tx_index');
      expect(values[7]).toBe(6);
    });

    it('carries the encoding onto history rows', async () => {
      await adapter.replayBatch([makePrivateHistory('asset1', `bin${NUL}ary`)]);

      const { values } = insertInto('fabric_history');
      expect(values[4]).toBe('base64');
      expect(values[10]).toBe('col1');
    });
  });

  describe('identity idempotency', () => {
    it('takes the widest block range and the larger tx_count on conflict', async () => {
      await adapter.replayBatch([makeIdentity()]);

      const { sql } = insertInto('fabric_identities');
      expect(sql).toContain(
        'first_seen_block = LEAST(fabric_identities.first_seen_block, EXCLUDED.first_seen_block)',
      );
      expect(sql).toContain(
        'last_seen_block = GREATEST(fabric_identities.last_seen_block, EXCLUDED.last_seen_block)',
      );
      expect(sql).toContain(
        'tx_count = GREATEST(fabric_identities.tx_count, EXCLUDED.tx_count)',
      );
    });

    it('does not accumulate tx_count', async () => {
      // Every peer holding the channel derives the same counts from the same
      // blocks, so summing would inflate them once per org replayed.
      await adapter.replayBatch([makeIdentity()]);

      expect(insertInto('fabric_identities').sql).not.toMatch(/tx_count\s*=[^,]*\+/);
    });

    it('binds identical values when the same batch is replayed twice', async () => {
      const batch = [makeIdentity({ txCount: 5 })];
      await adapter.replayBatch(batch);
      const first = insertInto('fabric_identities').values;

      mockClientQuery.mockClear();
      await adapter.replayBatch(batch);

      expect(insertInto('fabric_identities').values).toEqual(first);
      expect(first.slice(4)).toEqual([3, 10, 5]);
    });
  });

  // ON CONFLICT DO UPDATE raises 21000 "cannot affect row a second time" when
  // one statement proposes the same constrained values twice, aborting the whole
  // transaction. A resumed extraction appends duplicate records, so the adapter
  // has to collapse them before they reach a statement.
  describe('duplicate folding', () => {
    it('emits one row per identity when a batch repeats one', async () => {
      await adapter.replayBatch([
        makeIdentity({ firstSeenBlock: 3, lastSeenBlock: 10, txCount: 5 }),
        makeIdentity({ firstSeenBlock: 12, lastSeenBlock: 40, txCount: 7 }),
      ]);

      const { sql, values } = insertInto('fabric_identities');
      expect(values).toHaveLength(7);
      expect(sql).not.toContain('$8');
      // Widest range and the larger count, matching the SQL's LEAST/GREATEST.
      expect(values.slice(4)).toEqual([3, 40, 7]);
    });

    it('keeps identities apart when only the fingerprint differs', async () => {
      await adapter.replayBatch([
        makeIdentity({ certFingerprint: 'fp1' }),
        makeIdentity({ certFingerprint: 'fp2' }),
      ]);

      expect(insertInto('fabric_identities').values).toHaveLength(14);
    });

    it('emits one row per public state key when a batch repeats one', async () => {
      // private-*-state.ndjson and the walk outputs both append on resume.
      await adapter.replayBatch([
        makePublicState('k1', 'stale'),
        makePublicState('k1', 'fresh'),
      ]);

      const { values } = insertInto('fabric_state');
      expect(values).toHaveLength(5);
      // Last write wins: the file is ordered, so the later record is current.
      expect(values[3]).toBe('"fresh"');
    });

    it('emits one row per private state key when a batch repeats one', async () => {
      await adapter.replayBatch([
        makePrivateState('pk1', 'stale'),
        makePrivateState('pk1', 'fresh'),
      ]);

      const { values } = insertInto('fabric_state');
      expect(values).toHaveLength(6);
      expect(values[3]).toBe('"fresh"');
    });

    it('does not fold a public and a private key that share a name', async () => {
      // Distinct rows: the unique index keys on COALESCE(collection, '').
      await adapter.replayBatch([makePublicState('k1'), makePrivateState('k1')]);

      const stateInserts = inserts().filter((i) => i.sql.includes('INTO fabric_state'));
      expect(stateInserts).toHaveLength(2);
      expect(stateInserts.map((i) => i.values.length)).toEqual([5, 6]);
    });

    it('folds regardless of where a duplicate falls relative to a chunk edge', async () => {
      // Folding before chunking is what makes the result batch-size independent:
      // fold-per-chunk would still collide whenever a pair spans two statements.
      const records = [
        ...Array.from({ length: 6400 }, (_, i) => makePublicState(`k${i}`)),
        makePublicState('k0', 'fresh'),
      ];
      await adapter.replayBatch(records);

      const stateInserts = inserts().filter((i) => i.sql.includes('INTO fabric_state'));
      expect(stateInserts.map((i) => i.values.length)).toEqual([32_000]);
    });

    it('leaves history duplicates alone', async () => {
      // History inserts are append-only with DO NOTHING, which tolerates
      // duplicates within a statement — folding would drop real ledger entries.
      await adapter.replayBatch([
        makePublicHistory('k1', 'v1'),
        makePublicHistory('k1', 'v1'),
      ]);

      expect(insertInto('fabric_history').values).toHaveLength(24);
    });
  });

  describe('parameter chunking', () => {
    it('splits a batch that would exceed the parameter limit', async () => {
      // 5 columns per public-state row, 32 000 parameters per statement.
      const records = Array.from({ length: 6401 }, (_, i) => makePublicState(`k${i}`));
      await adapter.replayBatch(records);

      const stateInserts = inserts().filter((i) => i.sql.includes('INTO fabric_state'));
      expect(stateInserts.map((i) => i.values.length)).toEqual([32_000, 5]);
    });

    it('keeps placeholders and parameters in step across chunks', async () => {
      const records = Array.from({ length: 2910 }, (_, i) => makePublicHistory(`k${i}`));
      await adapter.replayBatch(records);

      const historyInserts = inserts().filter((i) => i.sql.includes('INTO fabric_history'));
      expect(historyInserts).toHaveLength(2);
      for (const { sql, values } of historyInserts) {
        expect(values.length).toBeLessThanOrEqual(32_000);
        // The last placeholder must name the last parameter, and no gaps before it.
        expect(sql).toContain(`$${values.length})`);
        expect(sql).not.toContain(`$${values.length + 1}`);
      }
    });

    it('issues one statement when the batch fits', async () => {
      const records = Array.from({ length: 100 }, (_, i) => makePublicState(`k${i}`));
      await adapter.replayBatch(records);

      expect(inserts()).toHaveLength(1);
      expect(inserts()[0].values).toHaveLength(500);
    });
  });

  describe('transaction handling', () => {
    it('commits after inserting every record type', async () => {
      await adapter.replayBatch([
        makePublicState('k1'),
        makePrivateState('k1'),
        makePublicHistory('k1'),
        makePrivateHistory('k1'),
        makePrivateHash('a1'),
        makeBlockMetadata(['k1']),
        makeIdentity(),
      ]);

      expect(controlStatements()).toEqual(['BEGIN', 'COMMIT']);
      expect(inserts()).toHaveLength(7);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('rolls back and wraps the cause when an insert fails', async () => {
      const cause = new Error('duplicate key value violates unique constraint');
      mockClientQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT') ? Promise.reject(cause) : Promise.resolve({ rows: [] }),
      );

      await expect(adapter.replayBatch([makePublicState('k1')])).rejects.toThrow(ReplayError);
      expect(controlStatements()).toEqual(['BEGIN', 'ROLLBACK']);
    });

    it('preserves the underlying error for diagnosis', async () => {
      const cause = new Error('value too long for type character varying');
      mockClientQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT') ? Promise.reject(cause) : Promise.resolve({ rows: [] }),
      );

      await expect(adapter.replayBatch([makePublicState('k1')])).rejects.toMatchObject({
        code: 'REPLAY_ERROR',
        cause,
        // The CLI prints only the message, so the driver's reason must be in it.
        message: 'Batch replay failed: value too long for type character varying',
      });
    });

    it('releases the client even when the batch fails', async () => {
      mockClientQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT') ? Promise.reject(new Error('boom')) : Promise.resolve({ rows: [] }),
      );

      await expect(adapter.replayBatch([makePublicState('k1')])).rejects.toThrow();
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('skips the insert for every type absent from the batch', async () => {
      await adapter.replayBatch([makeIdentity()]);

      expect(inserts()).toHaveLength(1);
      expect(inserts()[0].sql).toContain('INTO fabric_identities');
    });

    it('opens and commits a transaction for an empty batch', async () => {
      await adapter.replayBatch([]);

      expect(controlStatements()).toEqual(['BEGIN', 'COMMIT']);
      expect(inserts()).toHaveLength(0);
    });
  });

  describe('close', () => {
    it('drains the pool', async () => {
      await adapter.close();

      expect(mockEnd).toHaveBeenCalledTimes(1);
    });
  });
});

describe('assertPostgresqlTls', () => {
  const env = { PGHOST: process.env.PGHOST, PGSSLMODE: process.env.PGSSLMODE };
  beforeEach(() => { delete process.env.PGHOST; delete process.env.PGSSLMODE; });
  afterAll(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it.each([
    'postgresql://u:p@localhost:5432/d',
    'postgresql://u@127.0.0.1/d',
    'postgresql://u@[::1]/d',
    'postgresql:///d',
    'postgresql://u@%2Fvar%2Frun%2Fpostgresql/d',
  ])('allows a local connection without TLS: %s', (cs) => {
    expect(() => assertPostgresqlTls(cs)).not.toThrow();
  });

  it.each([
    'postgresql://u@db.example.com/d?sslmode=verify-full',
    'postgresql://u@db.example.com/d?ssl=true',
  ])('allows a remote connection that verifies the certificate: %s', (cs) => {
    expect(() => assertPostgresqlTls(cs)).not.toThrow();
  });

  it.each([
    'postgresql://u:p@db.example.com/d',
    'postgresql://u@db.example.com/d?sslmode=disable',
    'postgresql://u@db.example.com/d?sslmode=no-verify',
    'postgresql://u@db.example.com/d?uselibpqcompat=true&sslmode=require',
  ])('refuses a remote connection that does not verify the certificate: %s', (cs) => {
    expect(() => assertPostgresqlTls(cs)).toThrow(/sslmode=verify-full/);
  });

  it('reads PGHOST and PGSSLMODE as pg does', () => {
    process.env.PGHOST = 'db.example.com';
    expect(() => assertPostgresqlTls('postgresql:///d')).toThrow(ReplayError);
    process.env.PGSSLMODE = 'verify-full';
    expect(() => assertPostgresqlTls('postgresql:///d')).not.toThrow();
  });

  it('accepts an unverified remote connection only with allowInsecure', () => {
    expect(() => assertPostgresqlTls('postgresql://u@db.example.com/d', true)).not.toThrow();
  });
});

describe('toJsonbLiteral', () => {
  it('returns null for an empty value', () => {
    expect(toJsonbLiteral({ value: '', encoding: null })).toBeNull();
  });

  it('quotes base64 rather than parsing it', () => {
    // Buffer.from('123').toString('base64') is 'MTIz', but base64 of some
    // values is all digits — parsing would land a JSON number in the column
    // and the decode back to bytes would no longer round-trip.
    const numeric = Buffer.from([0xd3, 0x5d, 0xb7]).toString('base64');
    expect(numeric).toMatch(/^\d+=*$/);
    expect(toJsonbLiteral({ value: numeric, encoding: 'base64' })).toBe(`"${numeric}"`);
  });

  it('passes a JSON object through untouched', () => {
    expect(toJsonbLiteral({ value: '{"a":1}', encoding: null })).toBe('{"a":1}');
  });

  it('passes a JSON array through untouched', () => {
    expect(toJsonbLiteral({ value: '[1,2,3]', encoding: null })).toBe('[1,2,3]');
  });

  it('passes a bare JSON scalar through untouched', () => {
    expect(toJsonbLiteral({ value: '42', encoding: null })).toBe('42');
  });

  it('quotes text that is not JSON', () => {
    expect(toJsonbLiteral({ value: 'not json at all', encoding: null })).toBe(
      '"not json at all"',
    );
  });

  it('escapes a quote in non-JSON text', () => {
    expect(toJsonbLiteral({ value: 'say "hi"', encoding: null })).toBe('"say \\"hi\\""');
  });

  it('quotes text that only looks like the start of a document', () => {
    expect(toJsonbLiteral({ value: '{"unterminated":', encoding: null })).toBe(
      '"{\\"unterminated\\":"',
    );
  });

  // JSONB stores JSON numbers as `numeric`, which holds 131 072 digits before
  // the decimal point and 16 383 after. JSON.parse reads anything larger as
  // Infinity and reports success, so it cannot stand in for the check —
  // jsonb_in fails with `22003, value overflows numeric format` and takes the
  // surrounding transaction with it. Quoting keeps the document text intact.
  describe('numbers numeric cannot hold', () => {
    it('quotes a document whose exponent overflows numeric', () => {
      expect(JSON.parse('{"n":1e1000000}').n).toBe(Infinity);
      expect(toJsonbLiteral({ value: '{"n":1e1000000}', encoding: null })).toBe(
        '"{\\"n\\":1e1000000}"',
      );
    });

    it('quotes a document whose negative exponent overflows numeric', () => {
      expect(toJsonbLiteral({ value: '{"n":1e-1000000}', encoding: null })).toBe(
        '"{\\"n\\":1e-1000000}"',
      );
    });

    it('quotes a document with more integer digits than numeric holds', () => {
      const huge = `{"n":${'9'.repeat(131_073)}}`;
      expect(toJsonbLiteral({ value: huge, encoding: null })).toBe(JSON.stringify(huge));
    });

    it('quotes a document with more fractional digits than numeric holds', () => {
      const huge = `{"n":0.${'9'.repeat(16_384)}}`;
      expect(toJsonbLiteral({ value: huge, encoding: null })).toBe(JSON.stringify(huge));
    });

    it('passes a number at the integer limit through', () => {
      const atLimit = `{"n":${'9'.repeat(131_072)}}`;
      expect(toJsonbLiteral({ value: atLimit, encoding: null })).toBe(atLimit);
    });

    it('passes a number at the fractional limit through', () => {
      const atLimit = `{"n":0.${'9'.repeat(16_383)}}`;
      expect(toJsonbLiteral({ value: atLimit, encoding: null })).toBe(atLimit);
    });

    it('passes an exponent numeric can hold through', () => {
      expect(toJsonbLiteral({ value: '{"n":1.5e300}', encoding: null })).toBe(
        '{"n":1.5e300}',
      );
    });

    it('ignores digits inside a string', () => {
      // A hex hash or base64 blob would otherwise read as an enormous integer.
      const doc = `{"hash":"${'9'.repeat(200_000)}"}`;
      expect(toJsonbLiteral({ value: doc, encoding: null })).toBe(doc);
    });

    it('ignores digits inside a string that contains an escaped quote', () => {
      // A mishandled `\"` would end the literal early and expose the digits.
      const doc = `{"s":"say \\"${'9'.repeat(200_000)}\\""}`;
      expect(toJsonbLiteral({ value: doc, encoding: null })).toBe(doc);
    });

    it('still sees a number after a string that ends in an escaped backslash', () => {
      // `\\` closes with the following quote; the number after it is real.
      const doc = '{"p":"C:\\\\","n":1e1000000}';
      expect(JSON.parse(doc).p).toBe('C:\\');
      expect(toJsonbLiteral({ value: doc, encoding: null })).toBe(JSON.stringify(doc));
    });

    it('leaves an ordinary document alone', () => {
      const doc = '{"a":1,"b":-2.5,"c":[3,4e5],"d":"6"}';
      expect(toJsonbLiteral({ value: doc, encoding: null })).toBe(doc);
    });

    it('quotes a bare oversized scalar', () => {
      expect(toJsonbLiteral({ value: '1e1000000', encoding: null })).toBe('"1e1000000"');
    });
  });
});
