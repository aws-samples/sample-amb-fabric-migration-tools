// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as v8 from 'v8';
import {
  HeapBudget,
  assertBudgetFitsHeap,
  readHeapBudget,
  requiredHeapMb,
} from '../src/extraction/heap-budget';

/** A budget on a host with memory to spare, so only the ceiling is in question. */
function budget(overrides: Partial<HeapBudget> = {}): HeapBudget {
  return { memoryLimitMb: 512, heapCeilingMb: 4144, hostMemoryMb: 18_432, ...overrides };
}

/** The ceiling Node reports when started with `--max-old-space-size=<mb>`. */
function ceilingWithFlag(maxOldSpaceMb: number): number {
  const out = execFileSync(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceMb}`,
      '-p',
      'Math.floor(require("v8").getHeapStatistics().heap_size_limit / 1024 / 1024)',
    ],
    { encoding: 'utf-8' },
  );
  return Number(out.trim());
}

function messageFor(overrides: Partial<HeapBudget>): string {
  try {
    assertBudgetFitsHeap(budget(overrides));
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the budget to be refused');
}

describe('heap ceiling against --memory-limit', () => {
  test('accepts a ceiling with room for the budget', () => {
    expect(() => assertBudgetFitsHeap(budget())).not.toThrow();
  });

  test('accepts a ceiling exactly twice the budget', () => {
    expect(() =>
      assertBudgetFitsHeap(budget({ memoryLimitMb: 2048, heapCeilingMb: 4096 })),
    ).not.toThrow();
  });

  test('refuses a ceiling a megabyte short of the headroom', () => {
    expect(() =>
      assertBudgetFitsHeap(budget({ memoryLimitMb: 2048, heapCeilingMb: 4095 })),
    ).toThrow(/--memory-limit 2048/);
  });

  test('names the budget, the heap it needs, and the heap it has', () => {
    const message = messageFor({ memoryLimitMb: 4096, heapCeilingMb: 4144 });

    expect(message).toContain('--memory-limit 4096');
    expect(message).toContain('8192 MiB V8 heap');
    expect(message).toContain('this process has 4144 MiB');
  });

  test('says the promotion is what a low ceiling costs', () => {
    expect(messageFor({ memoryLimitMb: 4096, heapCeilingMb: 4144 })).toMatch(
      /LevelDB promotion .* happens at 4096 MB/,
    );
  });

  test('gives the NODE_OPTIONS line that would hold the budget', () => {
    expect(messageFor({ memoryLimitMb: 4096, heapCeilingMb: 4144 })).toContain(
      'NODE_OPTIONS=--max-old-space-size=8192',
    );
  });

  test('offers a budget the ceiling it has can hold', () => {
    expect(messageFor({ memoryLimitMb: 4096, heapCeilingMb: 4144 })).toContain(
      'lower --memory-limit to 2072 or below',
    );
  });

  test('never offers a budget below a megabyte', () => {
    expect(messageFor({ memoryLimitMb: 8, heapCeilingMb: 1 })).toContain(
      'lower --memory-limit to 1 or below',
    );
  });

  test('refuses to recommend a ceiling the host cannot back', () => {
    const message = messageFor({
      memoryLimitMb: 4096,
      heapCeilingMb: 2096,
      hostMemoryMb: 8192,
    });

    expect(message).not.toContain('NODE_OPTIONS');
    expect(message).toContain('This host has 8192 MiB of memory');
    expect(message).toContain('lower --memory-limit to 1048 or below');
  });

  test('recommends a ceiling that fits within three quarters of host memory', () => {
    // 8192 MiB of heap on a 16 GiB host: the ceiling is the fix, not the budget.
    expect(
      messageFor({ memoryLimitMb: 4096, heapCeilingMb: 2096, hostMemoryMb: 16_384 }),
    ).toContain('NODE_OPTIONS=--max-old-space-size=8192');
  });

  test('points at the sizing table either way', () => {
    expect(messageFor({ memoryLimitMb: 4096, heapCeilingMb: 4144 })).toContain(
      'docs/tuning.md#heap-size',
    );
    expect(
      messageFor({ memoryLimitMb: 4096, heapCeilingMb: 2096, hostMemoryMb: 8192 }),
    ).toContain('docs/tuning.md#heap-size');
  });

  // The message quotes a --max-old-space-size value, and the flag is in MiB while
  // --memory-limit is quoted in MB: a run started the way the refusal says must
  // pass the same check, or the advice sends an operator in a circle.
  test('the ceiling the message asks for is one that passes', () => {
    const memoryLimitMb = 512;
    const heapCeilingMb = ceilingWithFlag(requiredHeapMb(memoryLimitMb));

    expect(heapCeilingMb).toBeGreaterThanOrEqual(requiredHeapMb(memoryLimitMb));
    expect(() =>
      assertBudgetFitsHeap(budget({ memoryLimitMb, heapCeilingMb })),
    ).not.toThrow();
  });
});

describe('readHeapBudget', () => {
  test('reports the ceiling and host memory of this process, in MiB', () => {
    const read = readHeapBudget(512);

    expect(read.memoryLimitMb).toBe(512);
    expect(read.heapCeilingMb).toBe(
      Math.floor(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
    );
    expect(read.hostMemoryMb).toBe(Math.floor(os.totalmem() / 1024 / 1024));
  });

  // Every ceiling V8 reports on a real host is a whole number of MiB, so only a
  // fake one shows whether the conversion truncates or hands the refusal message
  // a fraction. The spy goes through the module object rather than the namespace
  // imported above, whose properties the interop helper leaves non-configurable.
  test('floors a ceiling reported between whole megabytes', () => {
    const v8Module = jest.requireActual<typeof v8>('v8');
    const spy = jest.spyOn(v8Module, 'getHeapStatistics').mockReturnValue({
      ...v8Module.getHeapStatistics(),
      heap_size_limit: 1536 * 1024 * 1024 + 700 * 1024,
    });

    try {
      expect(readHeapBudget(512).heapCeilingMb).toBe(1536);
    } finally {
      spy.mockRestore();
    }
  });

  test('reads a ceiling large enough to be a heap and not a byte count', () => {
    expect(readHeapBudget(512).heapCeilingMb).toBeGreaterThan(64);
    expect(readHeapBudget(512).heapCeilingMb).toBeLessThan(os.totalmem() / 1024 / 1024);
  });
});
