import {
  DynamoDBClient,
  CreateTableCommand,
  CreateTableCommandInput,
  DescribeTableCommand,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ReplayRecord,
  StateDeleteRecord,
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
import { toColumnValue } from '../../utils/value-codec';
import {
  historySortKey,
  privateHistorySortKey,
  keyPartitionKey,
  metadataPartitionKey,
  metadataSortKey,
} from './dynamodb-keys';
import { GroupedRecords, groupByType } from './record-grouper';

const logger = createLogger('dynamodb-adapter');

/** DynamoDB BatchWriteItem hard limit. */
const DYNAMO_BATCH_LIMIT = 25;

/** BatchWriteItem attempts before unprocessed items become a hard failure. */
const UNPROCESSED_MAX_ATTEMPTS = 6;

/**
 * BatchWriteItem requests in flight at once within one `batchWrite`.
 *
 * Eight requests is 200 items on the wire, against the AWS SDK's default Node
 * agent limit of 50 sockets — so the ceiling here is the concurrency, not the
 * connection pool. Serial chunking was the other half of the state-write
 * bottleneck: with each ledger key now on its own partition there is capacity to
 * write into, and a single request at a time leaves it unused.
 *
 * Not a flag. The right value is a property of the SDK's agent and DynamoDB's
 * per-request limit rather than of any one destination, and a knob here would be
 * one more thing to tune to reach the same place.
 */
const BATCH_CONCURRENCY = 8;

/** Backoff before the first retry of unprocessed items. Doubles each attempt. */
const UNPROCESSED_BASE_DELAY_MS = 100;

/** One guarded UpdateItem: apply `set` unless `attribute` is already wider. */
interface MonotoneUpdate {
  attribute: string;
  set: string;
  /** True when the stored value is narrower than the incoming one. */
  widens: string;
  values: Record<string, string | number>;
}

export interface DynamoDBAdapterConfig {
  region: string;
  stateTable: string;
  historyTable?: string;
  metadataTable?: string;
  identityTable?: string;
  privateHashTable?: string;
  endpoint?: string;
}

export class DynamoDBAdapter {
  private readonly client: DynamoDBClient;
  private readonly docClient: DynamoDBDocumentClient;
  private readonly config: DynamoDBAdapterConfig;

  constructor(config: DynamoDBAdapterConfig) {
    this.config = config;
    this.client = new DynamoDBClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
    this.docClient = DynamoDBDocumentClient.from(this.client);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing DynamoDB tables');
    await this.ensureStateTable();
    if (this.config.historyTable) await this.ensureHistoryTable();
    if (this.config.metadataTable) await this.ensureMetadataTable();
    if (this.config.identityTable) await this.ensureIdentityTable();
    if (this.config.privateHashTable) await this.ensurePrivateHashTable();
    logger.info('DynamoDB tables ready');
  }

  async replayBatch(records: ReplayRecord[]): Promise<void> {
    const grouped = groupByType(records);
    this.assertTablesConfigured(grouped);

    try {
      await this.writeStateRecords(grouped.publicState, grouped.privateState);

      if (grouped.publicHistory.length + grouped.privateHistory.length > 0) {
        await this.writeHistoryRecords(grouped.publicHistory, grouped.privateHistory);
      }
      if (grouped.blockMetadata.length > 0) {
        await this.writeMetadataRecords(grouped.blockMetadata);
      }
      if (grouped.identity.length > 0) {
        await this.writeIdentityRecords(grouped.identity);
      }
      if (grouped.privateHash.length > 0) {
        await this.writePrivateHashRecords(grouped.privateHash);
      }
      if (grouped.stateDelete.length > 0) {
        await this.deleteStateRecords(grouped.stateDelete);
      }
    } catch (err) {
      if (err instanceof ReplayError) throw err;
      throw new ReplayError('DynamoDB batch replay failed', err as Error);
    }
  }

  /**
   * Reject a batch carrying records that have nowhere to go.
   *
   * Each optional table backs one record type. Writing state while silently
   * dropping history leaves a destination that looks complete and passes a
   * state-only verify, so an unconfigured table is a hard error the moment a
   * record needs it — not a reason to skip the record.
   *
   * @param grouped Records of the current batch, grouped by type.
   * @throws ReplayError naming every missing table and the types that need it.
   */
  private assertTablesConfigured(grouped: GroupedRecords): void {
    const missing: string[] = [];

    if (
      grouped.publicHistory.length + grouped.privateHistory.length > 0 &&
      !this.config.historyTable
    ) {
      missing.push('historyTable (public_history, private_history)');
    }
    if (grouped.blockMetadata.length > 0 && !this.config.metadataTable) {
      missing.push('metadataTable (block_metadata)');
    }
    if (grouped.identity.length > 0 && !this.config.identityTable) {
      missing.push('identityTable (identity)');
    }
    if (grouped.privateHash.length > 0 && !this.config.privateHashTable) {
      missing.push('privateHashTable (private_hash)');
    }

    if (missing.length === 0) return;

    throw new ReplayError(
      'The extraction contains record types with no configured DynamoDB ' +
        `table: ${missing.join('; ')}. Add them under "dynamodb" in the replay ` +
        'config, or restrict the input to the tiers you intend to replay. ' +
        'Refusing to continue: these records would otherwise be discarded and ' +
        'the destination would look complete.',
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
    logger.info('DynamoDB client destroyed');
  }

  // ── State (BatchWriteItem — upsert semantics required) ──

  /**
   * Upsert current state, one item per ledger key.
   *
   * A `PutRequest` replaces the whole item, which is the upsert this needs: a
   * channel replayed twice, or a later extraction covering the same keys,
   * converges on the last value written instead of failing or merging. That is
   * the property the serial `PutItem` loop this replaced had, and the only
   * reason state ever went out one item at a time.
   *
   * Public and private state share the table and go out together. They cannot
   * collide: public items carry an empty collection in their partition key and
   * Fabric has no collection named `''`.
   *
   * @param publicState Public state records, in file order.
   * @param privateState Private state records, in file order.
   */
  private async writeStateRecords(
    publicState: PublicStateRecord[],
    privateState: PrivateStateRecord[],
  ): Promise<void> {
    const items = [
      ...publicState.map((r) => ({
        pk: keyPartitionKey(r.channel, r.chaincode, '', encodeStorageKey(r.key)),
        ...this.valueAttributes(r),
        updatedAt: new Date().toISOString(),
      })),
      ...privateState.map((r) => ({
        pk: keyPartitionKey(r.channel, r.chaincode, r.collection, encodeStorageKey(r.key)),
        ...this.valueAttributes(r),
        updatedAt: new Date().toISOString(),
      })),
    ];

    await this.batchWrite(this.config.stateTable, items);
  }

  /** `replay --since`: drop the state items of keys deleted in the replayed range. */
  private async deleteStateRecords(deletes: StateDeleteRecord[]): Promise<void> {
    const keys = [...new Set(deletes.map((d) => keyPartitionKey(d.channel, d.chaincode, d.collection ?? '', encodeStorageKey(d.key))))];
    for (const chunk of this.chunkArray(keys, DYNAMO_BATCH_LIMIT)) {
      await this.writeChunk(this.config.stateTable, chunk.map((pk) => ({ DeleteRequest: { Key: { pk } } })));
    }
  }

  // ── History (BatchWriteItem) ──

  private async writeHistoryRecords(
    publicHistory: PublicHistoryRecord[],
    privateHistory: PrivateHistoryRecord[],
  ): Promise<void> {
    const items = [
      ...publicHistory.map((r) => ({
        pk: `${r.channel}#${r.chaincode}#${encodeStorageKey(r.key)}`,
        sk: historySortKey(r.blockNumber, r.txIndex, r.txId),
        ...this.valueAttributes(r),
        blockNumber: r.blockNumber,
        txIndex: r.txIndex,
        timestamp: r.timestamp,
        isDelete: r.isDelete,
        collection: '',
        creatorMspId: r.creator.mspId,
        creatorCn: r.creator.commonName,
      })),
      ...privateHistory.map((r) => ({
        pk: `${r.channel}#${r.chaincode}#${encodeStorageKey(r.key)}`,
        sk: privateHistorySortKey(r.blockNumber, r.txIndex, r.txId, r.collection),
        ...this.valueAttributes(r),
        blockNumber: r.blockNumber,
        txIndex: r.txIndex,
        timestamp: r.timestamp,
        isDelete: r.isDelete,
        collection: r.collection,
        creatorMspId: r.creator?.mspId ?? null,
        creatorCn: r.creator?.commonName ?? null,
      })),
    ];

    await this.batchWrite(this.config.historyTable!, items);
  }

  // ── Block metadata (BatchWriteItem) ──

  private async writeMetadataRecords(records: BlockMetadataRecord[]): Promise<void> {
    const items = records.map((r) => ({
      pk: metadataPartitionKey(r.channel, r.blockNumber),
      sk: metadataSortKey(r.txIndex, r.txId),
      timestamp: r.timestamp,
      chaincodeId: r.chaincodeId,
      keysWritten: r.keysWritten.map(encodeStorageKey),
      keysDeleted: r.keysDeleted.map(encodeStorageKey),
      creatorMspId: r.creator.mspId,
      creatorCn: r.creator.commonName,
    }));

    await this.batchWrite(this.config.metadataTable!, items);
  }

  // ── Private hashes (BatchWriteItem) ──

  /**
   * Write the hash of every private write, keyed by ledger key then time.
   *
   * The key is in the partition key for the same reason state's is: at tier 3
   * this table takes one item per private write — more items than state, which
   * holds one per live key — and a partition key of channel, chaincode and
   * collection put every collection's whole history on one partition.
   *
   * What remains in the sort key is purely temporal, which is exactly
   * {@link historySortKey}: the hash table and the history table now order a
   * key's versions the same way, and one function says how.
   *
   * @param records Private-hash records, in file order.
   */
  private async writePrivateHashRecords(
    records: PrivateHashRecord[],
  ): Promise<void> {
    const items = records.map((r) => ({
      pk: keyPartitionKey(r.channel, r.chaincode, r.collection, encodeStorageKey(r.key)),
      sk: historySortKey(r.blockNumber, r.txIndex, r.txId),
      hash: r.hash,
      blockNumber: r.blockNumber,
      txIndex: r.txIndex,
    }));

    await this.batchWrite(
      this.config.privateHashTable!,
      items,
    );
  }

  // ── Identities (UpdateItem — monotone upsert) ──

  /**
   * Upsert identity aggregates so that replaying the same file twice, or five
   * members' exports of the same channel, converges on the same figures.
   *
   * Every attribute moves in one direction only: `firstSeenBlock` earlier,
   * `lastSeenBlock` and `txCount` later. Identity records are derived from
   * public block data, so members agree on what they both saw — but they may
   * export different ranges of it, and whichever replays last must not narrow
   * what is already there. `txCount` is assigned rather than added for the
   * same reason: adding would inflate the figure once per member replayed.
   *
   * DynamoDB has no `LEAST`/`GREATEST`, so each attribute gets its own guarded
   * update. This mirrors the PostgreSQL adapter attribute for attribute.
   */
  private async writeIdentityRecords(records: IdentityRecord[]): Promise<void> {
    for (const r of records) {
      const key = { pk: `${r.mspId}#${r.certFingerprint}` };
      // Listed first, so on a fresh key this is the update that creates the
      // item and the descriptive attributes ride along with it.
      const updates: MonotoneUpdate[] = [
        {
          attribute: 'firstSeenBlock',
          set: 'commonName = :cn, org = :org, firstSeenBlock = :v',
          widens: 'firstSeenBlock > :v',
          values: { ':cn': r.commonName, ':org': r.org, ':v': r.firstSeenBlock },
        },
        {
          attribute: 'lastSeenBlock',
          set: 'lastSeenBlock = :v',
          widens: 'lastSeenBlock < :v',
          values: { ':v': r.lastSeenBlock },
        },
        {
          attribute: 'txCount',
          set: 'txCount = :v',
          widens: 'txCount < :v',
          values: { ':v': r.txCount },
        },
      ];

      for (const update of updates) {
        await this.updateIfWider(key, update);
      }
    }
  }

  /**
   * Apply one monotone update, treating a failed condition as success.
   *
   * `ConditionalCheckFailedException` is the expected outcome when another
   * member's export already carried a wider figure, so it is not an error —
   * the destination already holds the value this update was trying to reach.
   *
   * @param key Identity primary key.
   * @param update The attribute to widen and the condition under which to do it.
   */
  private async updateIfWider(
    key: { pk: string },
    update: MonotoneUpdate,
  ): Promise<void> {
    try {
      await this.docClient.send(
        new UpdateCommand({
          TableName: this.config.identityTable!,
          Key: key,
          UpdateExpression: `SET ${update.set}`,
          ConditionExpression: `attribute_not_exists(${update.attribute}) OR ${update.widens}`,
          ExpressionAttributeValues: update.values,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
    }
  }

  // ── Helpers ──

  /**
   * The `value` / `valueEncoding` attributes for a record.
   *
   * Values are stored exactly as the codec renders them, so a binary value
   * arrives as base64 with a marker rather than as mojibake.
   *
   * @param record Any record carrying `value` and optional `valueEncoding`.
   */
  private valueAttributes(
    record: PublicStateRecord | PrivateStateRecord | PublicHistoryRecord | PrivateHistoryRecord,
  ): { value: string; valueEncoding: string | null } {
    const v = toColumnValue(record);
    return { value: v.value, valueEncoding: v.encoding };
  }

  /**
   * Write items to one table, 25 to a request, several requests at a time.
   *
   * Duplicates are collapsed first, then the chunks go out in waves of
   * {@link BATCH_CONCURRENCY}. Concurrency is safe precisely because of the
   * collapse: it leaves each primary key in at most one chunk, so no two
   * in-flight requests contend for the same item and the result does not depend
   * on which request lands first.
   *
   * Waves rather than a worker pool. Every chunk is 25 items of broadly similar
   * size, so the idle time a wave boundary costs is small, and a wave is three
   * lines where a pool is a queue and a set of workers to drain it.
   *
   * A failing chunk leaves its wave's siblings in flight, and some of their
   * writes will land after the error propagates. That is harmless: every write
   * here is an idempotent upsert and replay resumes from the last checkpoint, so
   * the re-run writes them again.
   *
   * @param tableName Destination table.
   * @param items Items in file order, keyed by `pk` and an optional `sk`.
   */
  private async batchWrite(tableName: string, items: Record<string, any>[]): Promise<void> {
    const chunks = [
      ...this.chunkArray(this.dedupeByPrimaryKey(items), DYNAMO_BATCH_LIMIT),
    ];

    for (const wave of this.chunkArray(chunks, BATCH_CONCURRENCY)) {
      await Promise.all(
        wave.map((chunk) => this.writeChunk(
          tableName,
          chunk.map((item) => ({ PutRequest: { Item: item } })),
        )),
      );
    }
  }

  /**
   * Collapse items sharing a primary key, keeping the last of each.
   *
   * `BatchWriteItem` rejects an entire request with `ValidationException` when
   * two of its requests carry the same primary key, where the serial `PutItem`
   * loop the state path used to run was last-wins. A resumed extraction appends
   * to its NDJSON files, so a batch can legitimately carry the same record twice
   * — and one such pair would otherwise fail all 25 items sharing its chunk.
   *
   * Last-wins is the right survivor for every table here. State is an upsert and
   * the files are in ledger order, so the later record holds the current value.
   * The append-only tables key on a block, transaction index and transaction ID,
   * which one ledger write occupies alone; duplicates there are the same record
   * twice, so either copy will do.
   *
   * Collapsing precedes chunking, which is what makes the outcome independent of
   * batch size — collapsing per chunk would still collide whenever a duplicated
   * pair straddled two chunks.
   *
   * The map key is JSON rather than a joined string. A ledger key can hold any
   * byte but NUL and reaches `pk` unescaped, so whether a separator is safe
   * depends on the sort-key format of every table that calls this — a fact
   * outside the function, and one that changes. JSON's escaping is injective
   * whatever the fields hold, so the argument does not have to be made.
   *
   * @param items Items for one table, in file order.
   * @returns One item per (`pk`, `sk`), in first-seen order.
   */
  private dedupeByPrimaryKey(items: Record<string, any>[]): Record<string, any>[] {
    const byKey = new Map<string, Record<string, any>>();
    for (const item of items) {
      byKey.set(JSON.stringify([item.pk, item.sk ?? null]), item);
    }
    return [...byKey.values()];
  }

  /**
   * Write one BatchWriteItem chunk, retrying whatever DynamoDB declines.
   *
   * BatchWriteItem returns HTTP 200 while handing back `UnprocessedItems` when
   * a partition is throttled. Ignoring that field silently drops records, so
   * unprocessed items are retried with exponential backoff and become a hard
   * failure if they survive every attempt.
   *
   * @param tableName Destination table.
   * @param requests Up to 25 PutRequest wrappers.
   * @throws ReplayError if items remain unwritten after UNPROCESSED_MAX_ATTEMPTS.
   */
  private async writeChunk(
    tableName: string,
    requests: Record<string, any>[],
  ): Promise<void> {
    let pending = requests;

    for (let attempt = 1; ; attempt++) {
      const response = await this.docClient.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      const unprocessed = response.UnprocessedItems?.[tableName] ?? [];
      if (unprocessed.length === 0) return;

      if (attempt >= UNPROCESSED_MAX_ATTEMPTS) {
        throw new ReplayError(
          `DynamoDB left ${unprocessed.length} of ${requests.length} item(s) ` +
            `unwritten in ${tableName} after ${UNPROCESSED_MAX_ATTEMPTS} attempts. ` +
            'This is write throttling: switch the table to PAY_PER_REQUEST or ' +
            'raise its provisioned write capacity, then re-run — replay resumes ' +
            'from the last checkpoint.',
        );
      }

      pending = unprocessed;
      const delayMs = UNPROCESSED_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        { table: tableName, unprocessed: pending.length, attempt, delayMs },
        'DynamoDB returned unprocessed items — retrying after backoff',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  private *chunkArray<T>(arr: T[], size: number): Generator<T[]> {
    for (let i = 0; i < arr.length; i += size) {
      yield arr.slice(i, i + size);
    }
  }

  // ── Table creation helpers ──

  /**
   * The state table: one item per ledger key, keyed by partition alone.
   *
   * No sort key. The whole primary key is `pk`, which is what puts each ledger
   * key on a partition of its own — see {@link keyPartitionKey} for what that
   * buys and what it costs.
   */
  private async ensureStateTable(): Promise<void> {
    const params: CreateTableCommandInput = {
      TableName: this.config.stateTable,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    };
    await this.createTableIfNotExists(params);
  }

  private async ensureHistoryTable(): Promise<void> {
    const params: CreateTableCommandInput = {
      TableName: this.config.historyTable!,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    };
    await this.createTableIfNotExists(params);
  }

  private async ensureMetadataTable(): Promise<void> {
    const params: CreateTableCommandInput = {
      TableName: this.config.metadataTable!,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    };
    await this.createTableIfNotExists(params);
  }

  private async ensurePrivateHashTable(): Promise<void> {
    const params: CreateTableCommandInput = {
      TableName: this.config.privateHashTable!,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    };
    await this.createTableIfNotExists(params);
  }

  private async ensureIdentityTable(): Promise<void> {
    const params: CreateTableCommandInput = {
      TableName: this.config.identityTable!,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
    };
    await this.createTableIfNotExists(params);
  }

  private async createTableIfNotExists(params: CreateTableCommandInput): Promise<void> {
    try {
      await this.client.send(new CreateTableCommand(params));
      logger.info({ table: params.TableName }, 'DynamoDB table created — waiting for ACTIVE');
      await this.waitForTableActive(params.TableName!);
    } catch (err) {
      if (err instanceof ResourceInUseException) {
        logger.debug({ table: params.TableName }, 'DynamoDB table already exists — skipping');
        return;
      }
      throw err;
    }
  }

  private async waitForTableActive(
    tableName: string,
    maxAttempts = 30,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const resp = await this.client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      if (resp.Table?.TableStatus === 'ACTIVE') return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new ReplayError(
      `Table ${tableName} not ACTIVE after ${maxAttempts}s`,
    );
  }
}
