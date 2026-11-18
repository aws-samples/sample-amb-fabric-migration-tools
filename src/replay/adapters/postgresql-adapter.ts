// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Pool } from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import {
  ReplayRecord,
  PublicStateRecord,
  PublicHistoryRecord,
  PrivateStateRecord,
  PrivateHistoryRecord,
  PrivateHashRecord,
  BlockMetadataRecord,
  IdentityRecord,
} from '../../types';
import { ReplayError } from '../../utils/errors';
import { encodeStorageKey } from '../../utils/key-codec';
import { createLogger } from '../../utils/logger';
import { ColumnValue, toColumnValue } from '../../utils/value-codec';
import { groupByType } from './record-grouper';

const logger = createLogger('postgresql-adapter');

const DDL = `
CREATE TABLE IF NOT EXISTS fabric_state (
  channel TEXT NOT NULL,
  chaincode TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB,
  value_encoding TEXT,
  collection TEXT DEFAULT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fabric_history (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  chaincode TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB,
  value_encoding TEXT,
  tx_id TEXT NOT NULL,
  block_number BIGINT,
  tx_index INTEGER,
  timestamp TIMESTAMPTZ,
  is_delete BOOLEAN DEFAULT FALSE,
  collection TEXT,
  creator_msp_id TEXT,
  creator_cn TEXT,
  creator_fingerprint TEXT
);

ALTER TABLE fabric_history
  ADD COLUMN IF NOT EXISTS tx_index INTEGER;

CREATE TABLE IF NOT EXISTS fabric_private_hashes (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  chaincode TEXT NOT NULL,
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,
  block_number BIGINT,
  tx_id TEXT
);

CREATE TABLE IF NOT EXISTS fabric_identities (
  msp_id TEXT NOT NULL,
  cert_fingerprint TEXT NOT NULL,
  common_name TEXT,
  org TEXT,
  first_seen_block BIGINT,
  last_seen_block BIGINT,
  tx_count BIGINT,
  PRIMARY KEY (msp_id, cert_fingerprint)
);

CREATE TABLE IF NOT EXISTS fabric_block_metadata (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  tx_id TEXT NOT NULL,
  timestamp TIMESTAMPTZ,
  chaincode_id TEXT,
  keys_written TEXT[],
  keys_deleted TEXT[],
  creator_msp_id TEXT,
  creator_cn TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_state_unique ON fabric_state(channel, chaincode, key, COALESCE(collection, ''));
CREATE INDEX IF NOT EXISTS idx_fabric_state_channel ON fabric_state(channel);
CREATE INDEX IF NOT EXISTS idx_fabric_history_key ON fabric_history(channel, chaincode, key);
CREATE INDEX IF NOT EXISTS idx_fabric_history_tx ON fabric_history(tx_id);
CREATE INDEX IF NOT EXISTS idx_fabric_history_block ON fabric_history(block_number);
CREATE INDEX IF NOT EXISTS idx_fabric_history_source_order ON fabric_history(channel, chaincode, key, block_number, tx_index, tx_id);
CREATE INDEX IF NOT EXISTS idx_fabric_block_metadata_block ON fabric_block_metadata(channel, block_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_history_unique ON fabric_history(channel, chaincode, key, tx_id, COALESCE(collection, ''));
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_private_hashes_unique ON fabric_private_hashes(channel, chaincode, collection, key, tx_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_block_metadata_unique ON fabric_block_metadata(channel, block_number, tx_id);
`;

/** Max parameters per PostgreSQL query ($1..$N). pg uses int16 internally. */
const PG_MAX_PARAMS = 32_000;

/**
 * Separator for the composite keys duplicate folding groups on.
 *
 * Fabric restricts channel, chaincode and collection names to
 * `[A-Za-z0-9._-]`, so none of them can contain U+001F. Only the ledger key is
 * arbitrary bytes, and it goes last — which makes the joined string
 * unambiguous without escaping anything.
 */
const FOLD_SEP = String.fromCharCode(0x1f);

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/**
 * Refuse a PostgreSQL connection that would send ledger values to another
 * host without certificate-verified TLS. Loopback hosts and Unix sockets are
 * allowed as they are; anything else needs `sslmode=verify-full` (or another
 * setting under which pg checks the certificate and hostname), unless the
 * config sets `postgresql.allowInsecure`.
 *
 * The check reads the settings as pg itself parses them, including
 * `PGHOST` and `PGSSLMODE`, so it agrees with what the connection will do.
 */
export function assertPostgresqlTls(connectionString: string, allowInsecure = false): void {
  const parsed = parseConnectionString(connectionString);
  const host = parsed.host || process.env.PGHOST || 'localhost';
  if (host.startsWith('/') || LOOPBACK.test(host)) return;

  const envMode = process.env.PGSSLMODE;
  const ssl = parsed.ssl ?? (envMode && ['require', 'verify-ca', 'verify-full'].includes(envMode) ? true : undefined);
  const verified = ssl === true || (typeof ssl === 'object' && ssl !== null
    && (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized !== false
    && (ssl as { checkServerIdentity?: unknown }).checkServerIdentity === undefined);
  if (verified) return;

  if (allowInsecure) {
    logger.warn({ host }, 'PostgreSQL connection without certificate-verified TLS (postgresql.allowInsecure)');
    return;
  }
  throw new ReplayError(
    `PostgreSQL host ${host} is not local and the connection string does not verify its TLS certificate. ` +
      'Add sslmode=verify-full (and sslrootcert=<CA file> for a private CA), ' +
      'or set postgresql.allowInsecure to accept an unverified connection.',
  );
}

export class PostgresqlAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, allowExitOnIdle: true });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing PostgreSQL schema');
    await this.pool.query(DDL);
    logger.info('PostgreSQL schema ready');
  }

  async replayBatch(records: ReplayRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const grouped = groupByType(records);

      if (grouped.publicState.length > 0) {
        await this.insertPublicState(client, grouped.publicState);
      }
      if (grouped.privateState.length > 0) {
        await this.insertPrivateState(client, grouped.privateState);
      }
      if (grouped.publicHistory.length > 0) {
        await this.insertPublicHistory(client, grouped.publicHistory);
      }
      if (grouped.privateHistory.length > 0) {
        await this.insertPrivateHistory(client, grouped.privateHistory);
      }
      if (grouped.privateHash.length > 0) {
        await this.insertPrivateHashes(client, grouped.privateHash);
      }
      if (grouped.blockMetadata.length > 0) {
        await this.insertBlockMetadata(client, grouped.blockMetadata);
      }
      if (grouped.identity.length > 0) {
        await this.insertIdentities(client, grouped.identity);
      }
      // After the upserts, so a key written and then deleted in one batch ends deleted.
      for (const d of grouped.stateDelete) {
        await client.query(
          `DELETE FROM fabric_state WHERE channel = $1 AND chaincode = $2 AND key = $3 AND COALESCE(collection, '') = $4`,
          [d.channel, d.chaincode, encodeStorageKey(d.key), d.collection ?? ''],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // The CLI prints only the message, so the driver's reason has to be in it.
      throw new ReplayError(`Batch replay failed: ${(err as Error).message}`, err as Error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('PostgreSQL connection pool closed');
  }

  // ── Multi-row insert methods ──

  private async insertPublicState(
    client: any,
    records: PublicStateRecord[],
  ): Promise<void> {
    const COLS = 5;
    for (const chunk of this.chunk(foldStateRecords(records), COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => {
        const v = toColumnValue(r);
        return [
          r.channel, r.chaincode, encodeStorageKey(r.key),
          toJsonbLiteral(v), v.encoding,
        ];
      });
      await client.query(
        `INSERT INTO fabric_state (channel, chaincode, key, value, value_encoding)
         SELECT v.channel, v.chaincode, v.key, v.value::JSONB, v.value_encoding
         FROM (VALUES ${placeholders})
           AS v(channel, chaincode, key, value, value_encoding)
         ON CONFLICT (channel, chaincode, key, COALESCE(collection, ''))
         DO UPDATE SET value = EXCLUDED.value,
                       value_encoding = EXCLUDED.value_encoding,
                       updated_at = NOW()`,
        values,
      );
    }
  }

  private async insertPrivateState(
    client: any,
    records: PrivateStateRecord[],
  ): Promise<void> {
    const COLS = 6;
    for (const chunk of this.chunk(foldStateRecords(records), COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => {
        const v = toColumnValue(r);
        return [
          r.channel, r.chaincode, encodeStorageKey(r.key),
          toJsonbLiteral(v), v.encoding, r.collection,
        ];
      });
      await client.query(
        `INSERT INTO fabric_state
         (channel, chaincode, key, value, value_encoding, collection)
         SELECT v.channel, v.chaincode, v.key, v.value::JSONB,
                v.value_encoding, v.collection
         FROM (VALUES ${placeholders})
           AS v(channel, chaincode, key, value, value_encoding, collection)
         ON CONFLICT (channel, chaincode, key, COALESCE(collection, ''))
         DO UPDATE SET value = EXCLUDED.value,
                       value_encoding = EXCLUDED.value_encoding,
                       updated_at = NOW()`,
        values,
      );
    }
  }

  private async insertPublicHistory(
    client: any,
    records: PublicHistoryRecord[],
  ): Promise<void> {
    const COLS = 12;
    for (const chunk of this.chunk(records, COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => {
        const v = toColumnValue(r);
        return [
          r.channel, r.chaincode, encodeStorageKey(r.key),
          toJsonbLiteral(v), v.encoding,
          r.txId, r.blockNumber, r.txIndex, r.timestamp || null, r.isDelete,
          r.creator.mspId, r.creator.commonName,
        ];
      });
      await client.query(
        `INSERT INTO fabric_history
         (channel, chaincode, key, value, value_encoding, tx_id, block_number, tx_index, timestamp, is_delete, creator_msp_id, creator_cn)
         SELECT channel, chaincode, key, value::JSONB, value_encoding, tx_id,
                block_number::BIGINT, tx_index::INTEGER,
                timestamp::TIMESTAMPTZ, is_delete::BOOLEAN,
                creator_msp_id, creator_cn
         FROM (VALUES ${placeholders})
           AS v(channel, chaincode, key, value, value_encoding, tx_id, block_number, tx_index, timestamp, is_delete, creator_msp_id, creator_cn)
         ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }

  private async insertPrivateHistory(
    client: any,
    records: PrivateHistoryRecord[],
  ): Promise<void> {
    const COLS = 14;
    for (const chunk of this.chunk(records, COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => {
        const v = toColumnValue(r);
        return [
          r.channel, r.chaincode, encodeStorageKey(r.key),
          toJsonbLiteral(v), v.encoding,
          r.txId, r.blockNumber, r.txIndex, r.timestamp || null,
          r.isDelete, r.collection,
          r.creator?.mspId || null, r.creator?.commonName || null,
          r.creator?.certFingerprint || null,
        ];
      });
      await client.query(
        `INSERT INTO fabric_history
         (channel, chaincode, key, value, value_encoding, tx_id, block_number, tx_index, timestamp, is_delete, collection, creator_msp_id, creator_cn, creator_fingerprint)
         SELECT channel, chaincode, key, value::JSONB, value_encoding, tx_id,
                block_number::BIGINT, tx_index::INTEGER,
                timestamp::TIMESTAMPTZ, is_delete::BOOLEAN,
                collection, creator_msp_id, creator_cn, creator_fingerprint
         FROM (VALUES ${placeholders})
           AS v(channel, chaincode, key, value, value_encoding, tx_id, block_number, tx_index, timestamp, is_delete, collection, creator_msp_id, creator_cn, creator_fingerprint)
         ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }

  private async insertPrivateHashes(
    client: any,
    records: PrivateHashRecord[],
  ): Promise<void> {
    const COLS = 7;
    for (const chunk of this.chunk(records, COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => [
        r.channel, r.chaincode, r.collection, r.key, r.hash,
        r.blockNumber, r.txId,
      ]);
      await client.query(
        `INSERT INTO fabric_private_hashes
         (channel, chaincode, collection, key, hash, block_number, tx_id)
         SELECT channel, chaincode, collection, key, hash,
                block_number::BIGINT, tx_id
         FROM (VALUES ${placeholders})
           AS v(channel, chaincode, collection, key, hash, block_number, tx_id)
         ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }

  private async insertBlockMetadata(
    client: any,
    records: BlockMetadataRecord[],
  ): Promise<void> {
    const COLS = 9;
    for (const chunk of this.chunk(records, COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => [
        r.channel, r.blockNumber, r.txId, r.timestamp || null,
        r.chaincodeId,
        r.keysWritten.map(encodeStorageKey),
        r.keysDeleted.map(encodeStorageKey),
        r.creator.mspId, r.creator.commonName,
      ]);
      await client.query(
        `INSERT INTO fabric_block_metadata
         (channel, block_number, tx_id, timestamp, chaincode_id, keys_written, keys_deleted, creator_msp_id, creator_cn)
         SELECT channel, block_number::BIGINT, tx_id,
                timestamp::TIMESTAMPTZ, chaincode_id,
                keys_written::TEXT[], keys_deleted::TEXT[],
                creator_msp_id, creator_cn
         FROM (VALUES ${placeholders})
           AS v(channel, block_number, tx_id, timestamp, chaincode_id, keys_written, keys_deleted, creator_msp_id, creator_cn)
         ON CONFLICT DO NOTHING`,
        values,
      );
    }
  }

  /**
   * Upsert identity aggregates idempotently.
   *
   * Identity records are derived from public block data, so every peer that
   * holds a channel produces the same counts. Replaying the same file twice,
   * or two orgs' exports of the same channel, must not inflate `tx_count` —
   * hence GREATEST rather than addition. LEAST/GREATEST on the block bounds
   * make the result independent of the order files are replayed in.
   */
  private async insertIdentities(
    client: any,
    records: IdentityRecord[],
  ): Promise<void> {
    const COLS = 7;
    for (const chunk of this.chunk(foldIdentities(records), COLS)) {
      const { placeholders, values } = this.buildValues(chunk, COLS, (r) => [
        r.mspId, r.certFingerprint, r.commonName, r.org,
        r.firstSeenBlock, r.lastSeenBlock, r.txCount,
      ]);
      await client.query(
        `INSERT INTO fabric_identities
         (msp_id, cert_fingerprint, common_name, org, first_seen_block, last_seen_block, tx_count)
         SELECT msp_id, cert_fingerprint, common_name, org,
                first_seen_block::BIGINT, last_seen_block::BIGINT, tx_count::BIGINT
         FROM (VALUES ${placeholders})
           AS v(msp_id, cert_fingerprint, common_name, org, first_seen_block, last_seen_block, tx_count)
         ON CONFLICT (msp_id, cert_fingerprint)
         DO UPDATE SET
           first_seen_block = LEAST(fabric_identities.first_seen_block, EXCLUDED.first_seen_block),
           last_seen_block = GREATEST(fabric_identities.last_seen_block, EXCLUDED.last_seen_block),
           tx_count = GREATEST(fabric_identities.tx_count, EXCLUDED.tx_count)`,
        values,
      );
    }
  }

  // ── Helpers ──

  /**
   * Build multi-row VALUES clause and flat parameter array.
   * Returns e.g. "($1,$2,$3),($4,$5,$6)" for 2 rows x 3 cols.
   *
   * @throws ReplayError if `toRow` yields a row that is not `colCount` wide.
   */
  private buildValues<T>(
    records: T[],
    colCount: number,
    toRow: (record: T, index: number) => any[],
  ): { placeholders: string; values: any[] } {
    const values: any[] = [];
    const rows: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const row = toRow(records[i], i);
      // Placeholder numbers come from colCount but their count comes from the
      // row, so a mismatch would silently bind every later row one column off.
      if (row.length !== colCount) {
        throw new ReplayError(
          `Row ${i} yielded ${row.length} value(s) for a ${colCount}-column ` +
            'insert. This is a bug in the adapter: the row builder and the ' +
            'column list have drifted apart.',
        );
      }
      const base = i * colCount;
      const params = row.map((_, c) => `$${base + c + 1}`);
      rows.push(`(${params.join(',')})`);
      values.push(...row);
    }
    return { placeholders: rows.join(','), values };
  }

  /**
   * Splits records into chunks that fit within PG_MAX_PARAMS.
   */
  private *chunk<T>(records: T[], colCount: number): Generator<T[]> {
    const maxPerChunk = Math.floor(PG_MAX_PARAMS / colCount);
    for (let i = 0; i < records.length; i += maxPerChunk) {
      yield records.slice(i, i + maxPerChunk);
    }
  }
}

/**
 * Collapse repeated state keys, keeping the last write to each.
 *
 * `ON CONFLICT ... DO UPDATE` raises `21000, cannot affect row a second time`
 * when one statement proposes the same constrained values twice, and that
 * aborts the whole transaction. A resumed extraction appends to its NDJSON
 * files, so a batch can legitimately carry the same key more than once.
 *
 * The last occurrence wins: the files are in ledger order, so the later record
 * holds the current value. Folding runs before chunking, which is what makes
 * the outcome independent of batch size — folding per chunk would still collide
 * whenever a duplicated pair straddled two statements.
 *
 * Only the `DO UPDATE` tables need this. The append-only history tables use
 * `DO NOTHING`, which tolerates duplicates within a statement, and folding
 * there would discard real ledger entries.
 *
 * @param records State records for one insert, in file order.
 * @returns One record per (channel, chaincode, collection, key).
 */
function foldStateRecords<
  T extends { channel: string; chaincode: string; key: string; collection?: string },
>(records: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const r of records) {
    byKey.set([r.channel, r.chaincode, r.collection ?? '', r.key].join(FOLD_SEP), r);
  }
  return [...byKey.values()];
}

/**
 * Collapse repeated identities, merging their aggregates.
 *
 * Same `21000` hazard as {@link foldStateRecords}, but last-wins would be wrong
 * here: the surviving row has to carry the aggregate the statement's
 * LEAST/GREATEST would have produced had the duplicates arrived separately.
 *
 * @param records Identity records for one insert.
 * @returns One record per (mspId, certFingerprint).
 */
function foldIdentities(records: IdentityRecord[]): IdentityRecord[] {
  const byIdentity = new Map<string, IdentityRecord>();
  for (const r of records) {
    const foldKey = [r.mspId, r.certFingerprint].join(FOLD_SEP);
    const seen = byIdentity.get(foldKey);
    byIdentity.set(
      foldKey,
      seen === undefined
        ? r
        : {
          ...r,
          firstSeenBlock: Math.min(seen.firstSeenBlock, r.firstSeenBlock),
          lastSeenBlock: Math.max(seen.lastSeenBlock, r.lastSeenBlock),
          txCount: Math.max(seen.txCount, r.txCount),
        },
    );
  }
  return [...byIdentity.values()];
}

/**
 * Render a ledger value as a JSONB literal.
 *
 * A base64-encoded value becomes a JSON string holding the base64 — never
 * parsed, since base64 of `123` would otherwise land as a JSON number and lose
 * the encoding round-trip. A text value is passed through when JSONB will take
 * it, and otherwise quoted as a JSON string, which is lossless: the document
 * text survives verbatim inside the string.
 *
 * `toColumnValue` guarantees the input contains no U+0000 in either form, and
 * no unpaired surrogate escape, all of which JSONB rejects.
 *
 * Exported because `verify` reads these columns back and has to know what
 * shape they were written in — PostgreSQL renormalises JSONB on the way in,
 * so a byte comparison against the source value would not hold.
 *
 * @param v Column-ready value from `toColumnValue`.
 * @returns A JSON document string, or `null` for an empty value.
 */
export function toJsonbLiteral(v: ColumnValue): string | null {
  if (!v.value) return null;
  if (v.encoding !== null) return JSON.stringify(v.value);
  return isJsonbSafeDocument(v.value) ? v.value : JSON.stringify(v.value);
}

/** Digits PostgreSQL `numeric` holds left of the decimal point. */
const MAX_NUMERIC_INT_DIGITS = 131_072;

/** Digits PostgreSQL `numeric` holds right of the decimal point. */
const MAX_NUMERIC_FRAC_DIGITS = 16_383;

/** A JSON number literal. Applied only after string literals are removed. */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * True when the string can be handed to a JSONB column verbatim.
 *
 * `JSON.parse` succeeding is necessary but not sufficient. It also accepts
 * numbers larger than the `numeric` type JSONB stores them in — it reads
 * `1e1000000` as `Infinity` and reports success, where `jsonb_in` fails with
 * `22003, value overflows numeric format` and takes the whole transaction with
 * it. The other two things JSONB refuses and `JSON.parse` allows, U+0000 and
 * unpaired surrogate escapes, are already gone: `toColumnValue` routes those
 * values to base64.
 *
 * @param text Candidate document.
 */
function isJsonbSafeDocument(text: string): boolean {
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return !hasOversizedNumber(text);
}

/**
 * True when any JSON number in the document needs more digits than `numeric`
 * holds on either side of the decimal point.
 *
 * The exponent is folded into the digit counts, so `1e999999` and `1e-999999`
 * are caught as readily as a literal run of digits.
 *
 * @param text A document that has already parsed as JSON.
 */
function hasOversizedNumber(text: string): boolean {
  for (const [literal] of withoutStringLiterals(text).matchAll(JSON_NUMBER)) {
    const [mantissa, exponent = '0'] = literal.split(/[eE]/);
    const [intPart, fracPart = ''] = mantissa.replace('-', '').split('.');
    const exp = Number(exponent);
    if (
      intPart.replace(/^0+/, '').length + exp > MAX_NUMERIC_INT_DIGITS ||
      fracPart.length - exp > MAX_NUMERIC_FRAC_DIGITS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `text` with every JSON string literal replaced by an empty one.
 *
 * Digits inside a string are not numbers and must not be measured — a base64
 * blob or a hex hash would otherwise read as an enormous integer. Escapes are
 * honoured so `\"` does not close the literal early.
 *
 * @param text A document that has already parsed as JSON.
 */
function withoutStringLiterals(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch === '"' ? '""' : ch;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === '"') inString = false;
  }
  return out;
}
