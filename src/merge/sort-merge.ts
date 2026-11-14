import { OrderingViolation, RecordOrderingChecker } from '../utils/record-ordering';

/** Any record positioned in the ledger by block and transaction index. */
export interface OrderedRecord {
  blockNumber: number;
  txIndex: number;
}

/** One member's record stream, labelled so violations can name the file. */
export interface LabelledStream<T> {
  /** Path the records were read from, used verbatim in error messages. */
  source: string;
  records: AsyncIterable<T>;
}

/** Reports an input stream that was not itself in ledger order. */
export type ViolationHandler = (
  source: string,
  violation: OrderingViolation,
) => void;

interface Cursor<T> {
  source: string;
  iterator: AsyncIterator<T>;
  checker: RecordOrderingChecker;
  head?: T;
}

/** Ledger order: block first, then transaction index within the block. */
export function compareLedgerOrder(a: OrderedRecord, b: OrderedRecord): number {
  return a.blockNumber - b.blockNumber || a.txIndex - b.txIndex;
}

/**
 * Merge already-sorted record streams into one stream in ledger order.
 *
 * Holds one record per input rather than reading any input into memory, so the
 * cost is bounded by the number of members and not by history length — the
 * files being merged are the largest an extraction produces.
 *
 * Each input is checked as it is consumed: a member whose file is not in ledger
 * order breaks the merge's only precondition, and the output would be silently
 * misordered. Reporting is left to the caller so it can name the member.
 *
 * Ties are broken by input order, making the output a deterministic function of
 * the directories given on the command line.
 *
 * @param streams One labelled stream per member.
 * @param onViolation Called for each out-of-order record, with its source.
 */
export async function* sortMerge<T extends OrderedRecord>(
  streams: LabelledStream<T>[],
  onViolation: ViolationHandler,
): AsyncGenerator<T> {
  const cursors: Cursor<T>[] = streams.map((stream) => ({
    source: stream.source,
    iterator: stream.records[Symbol.asyncIterator](),
    checker: new RecordOrderingChecker(),
  }));

  for (const cursor of cursors) {
    await advance(cursor, onViolation);
  }

  for (;;) {
    const next = lowestCursor(cursors);
    if (!next?.head) return;
    yield next.head;
    await advance(next, onViolation);
  }
}

async function advance<T extends OrderedRecord>(
  cursor: Cursor<T>,
  onViolation: ViolationHandler,
): Promise<void> {
  const result = await cursor.iterator.next();
  if (result.done) {
    cursor.head = undefined;
    return;
  }
  cursor.head = result.value;
  const violation = cursor.checker.check(
    result.value.blockNumber,
    result.value.txIndex,
  );
  if (violation) onViolation(cursor.source, violation);
}

function lowestCursor<T extends OrderedRecord>(
  cursors: Cursor<T>[],
): Cursor<T> | undefined {
  let lowest: Cursor<T> | undefined;
  for (const cursor of cursors) {
    if (!cursor.head) continue;
    if (!lowest || compareLedgerOrder(cursor.head, lowest.head!) < 0) {
      lowest = cursor;
    }
  }
  return lowest;
}

/**
 * Drops records already seen at the same ledger position.
 *
 * Members that share a collection deliver the same private write, so the merged
 * stream repeats every shared record once per member. Because `sortMerge` emits
 * in ledger order, duplicates of one write are always adjacent, so only the
 * current position has to be remembered — bounded by the widest transaction
 * rather than by the whole history.
 */
export class LedgerPositionDedupe {
  private position = '';
  private seen = new Set<string>();

  /**
   * @param record Record in ledger order.
   * @param identity What makes the record unique within its transaction.
   * @returns True the first time this record is offered, false for repeats.
   */
  accept(record: OrderedRecord, identity: string): boolean {
    const position = `${record.blockNumber}:${record.txIndex}`;
    if (position !== this.position) {
      this.position = position;
      this.seen.clear();
    }
    if (this.seen.has(identity)) return false;
    this.seen.add(identity);
    return true;
  }
}
