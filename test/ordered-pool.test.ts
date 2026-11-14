import { forEachOrdered } from '../src/utils/ordered-pool';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* numbers(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) yield i;
}

describe('forEachOrdered', () => {
  it('emits in source order even when later items finish first', async () => {
    const out: number[] = [];
    await forEachOrdered(numbers(6), 3, async (i) => { await sleep((6 - i) * 5); return i; }, (r) => out.push(r));
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps exactly `limit` items in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachOrdered(numbers(20), 4, async (i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return i;
    }, () => undefined);
    expect(peak).toBe(4);
  });

  it('runs sequentially at a limit of 1', async () => {
    const events: string[] = [];
    await forEachOrdered(numbers(3), 1, async (i) => {
      events.push(`start ${i}`); await sleep(1); events.push(`end ${i}`); return i;
    }, () => undefined);
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
  });

  /** A file of millions of records must not be read ahead of the window. */
  it('pulls from the source only as slots free up', async () => {
    let pulled = 0;
    async function* counting(): AsyncGenerator<number> {
      for (let i = 0; i < 100; i++) { pulled++; yield i; }
    }
    let maxAhead = 0;
    let emitted = 0;
    await forEachOrdered(counting(), 5, async (i) => {
      maxAhead = Math.max(maxAhead, pulled - emitted);
      await sleep(1);
      return i;
    }, () => { emitted++; });
    expect(maxAhead).toBeLessThanOrEqual(5);
  });

  /** A rejection behind the head must not crash the process as unhandled. */
  it('rejects with a failure from an item behind the head', async () => {
    await expect(forEachOrdered(numbers(3), 3, async (i) => {
      if (i === 2) throw new Error('boom');
      await sleep(10);
      return i;
    }, () => undefined)).rejects.toThrow('boom');
  });
});
