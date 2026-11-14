const BLOCK_PAD_WIDTH = 12;
const TX_INDEX_PAD_WIDTH = 4;

/** Fields of a partition key that carries a ledger key. */
export interface KeyPartitionParts {
  channel: string;
  chaincode: string;
  /** Collection name, or '' for public state. */
  collection: string;
  /** Ledger key in its stored form — still `encodeStorageKey`d. */
  storedKey: string;
}

/**
 * Partition key for one ledger key: `channel#chaincode#collection#key`.
 *
 * The whole key is in the *partition* key, which is what keeps a chaincode's
 * state off a single partition. DynamoDB caps one partition key value at about
 * 1,000 writes per second however much capacity the table has, so a key that
 * distinguishes only channel and chaincode caps the entire state replay at that
 * rate — batching and parallelism cannot lift it, and PAY_PER_REQUEST does not
 * either. One partition key per ledger key spreads the writes across as many
 * partitions as DynamoDB cares to allocate.
 *
 * The cost is that an ordered range over a namespace is no longer expressible:
 * a `Query` needs the items it returns to share a partition key, which is the
 * very thing being avoided. A prefix match is still possible as a `Scan` filter,
 * and `verify` reads state by `GetItem` and sweeps by `Scan`, so nothing here
 * loses a capability — but an application reading the destination has only point
 * reads and scans.
 *
 * An empty collection means public state, which is the convention the previous
 * layout already used for its trailing field. Channel, chaincode and collection
 * names admit no `#` under Fabric's naming rules and the key comes last, so
 * {@link parseKeyPartitionKey} recovers a key that contains `#` itself.
 *
 * Used by the state table, where it is the whole primary key, and by the
 * private-hash table, where a temporal sort key follows it.
 *
 * @param channel Source channel.
 * @param chaincode Chaincode namespace.
 * @param collection Collection name, or '' for public state.
 * @param storedKey Ledger key, already through `encodeStorageKey`.
 */
export function keyPartitionKey(
  channel: string,
  chaincode: string,
  collection: string,
  storedKey: string,
): string {
  return `${channel}#${chaincode}#${collection}#${storedKey}`;
}

/**
 * Reverse {@link keyPartitionKey}.
 *
 * Anything that is not one of these keys is rejected rather than partly read:
 * the caller is a sweep over whatever the table holds, and reporting an item
 * under a key nobody wrote is worse than skipping it. Both malformed shapes
 * fall out of the same test — fewer than four fields leaves the remainder
 * empty, and so does a trailing separator with nothing after it. Fabric has no
 * empty key, so either way the item was not written by this tool.
 *
 * The type check is not defensive padding. A `Scan` hands back whatever the
 * attribute holds, and a DynamoDB list of one string stringifies to that
 * string — close enough to a partition key to be parsed if it were coerced.
 *
 * @param pk A partition key attribute as it was read back, of unknown type.
 * @returns The four fields, or undefined if `pk` is not one of these keys.
 */
export function parseKeyPartitionKey(pk: unknown): KeyPartitionParts | undefined {
  if (typeof pk !== 'string') return undefined;

  const parts = pk.split('#');
  const storedKey = parts.slice(3).join('#');
  if (storedKey === '') return undefined;

  return {
    channel: parts[0], chaincode: parts[1], collection: parts[2], storedKey,
  };
}

export function padBlockNumber(blockNumber: number): string {
  return String(blockNumber).padStart(BLOCK_PAD_WIDTH, '0');
}

export function padTxIndex(txIndex: number): string {
  return String(txIndex).padStart(TX_INDEX_PAD_WIDTH, '0');
}

export function historySortKey(
  blockNumber: number,
  txIndex: number,
  txId: string,
): string {
  return `${padBlockNumber(blockNumber)}#${padTxIndex(txIndex)}#${txId}`;
}

export function privateHistorySortKey(
  blockNumber: number,
  txIndex: number,
  txId: string,
  collection: string,
): string {
  return `${padBlockNumber(blockNumber)}#${padTxIndex(txIndex)}#${txId}#${collection}`;
}

export function metadataPartitionKey(
  channel: string,
  blockNumber: number,
): string {
  return `${channel}#${padBlockNumber(blockNumber)}`;
}

export function metadataSortKey(
  txIndex: number,
  txId: string,
): string {
  return `${padTxIndex(txIndex)}#${txId}`;
}
