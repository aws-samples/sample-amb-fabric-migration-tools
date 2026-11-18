// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Run `work` over every item of `source` with at most `limit` in flight, and
 * hand each item's results to `emit` in source order.
 *
 * Order is kept by awaiting the oldest item before emitting, so a slow item
 * holds back the emission of the ones after it but not their work: up to
 * `limit` items are always running. Memory is bounded by `limit` — the source
 * is pulled only as a slot frees up, so a file of millions of records is never
 * read ahead.
 *
 * A rejected item rejects the whole call once it reaches the head of the
 * window; callers that want a failure reported per item catch it in `work`.
 *
 * @param limit Items in flight. 1 is plain sequential iteration.
 */
export async function forEachOrdered<T, R>(
  source: AsyncIterable<T> | Iterable<T>,
  limit: number,
  work: (item: T) => Promise<R>,
  emit: (result: R) => void,
): Promise<void> {
  const window: Promise<R>[] = [];
  for await (const item of source as AsyncIterable<T>) {
    const running = work(item);
    // Observed now so a rejection waiting behind the head of the window is not
    // reported as unhandled (which ends the process); awaiting it below still
    // rejects.
    running.catch(() => undefined);
    window.push(running);
    if (window.length >= limit) emit(await (window.shift() as Promise<R>));
  }
  while (window.length > 0) emit(await (window.shift() as Promise<R>));
}
