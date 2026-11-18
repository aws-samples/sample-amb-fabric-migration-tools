// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as os from 'os';
import * as v8 from 'v8';
import { ExtractionError } from '../utils/errors';

const MIB = 1024 * 1024;

/**
 * Heap a run needs for every megabyte of state it is allowed to accumulate.
 *
 * Measured on a test machine (Node 22): an
 * accumulator filled to a 192 MiB estimate holds 178 MiB of live heap and peaks
 * at 191 MiB while it promotes to LevelDB, and the same fill dies at
 * `--max-old-space-size=192` but survives at 208. The accumulator alone
 * therefore needs about 1.1x its budget; the rest of the factor pays for the
 * block being reconstructed, the prefetched blocks behind it, and the headroom
 * V8 needs to collect garbage rather than thrash against its ceiling.
 */
const HEAP_HEADROOM_FACTOR = 2;

/**
 * Share of host memory a heap ceiling recommended here may occupy.
 *
 * Above it the advice is worse than the problem it solves: a ceiling the host
 * cannot back is paid for in swap, or in the kernel's OOM killer ending the run
 * with no message at all, rather than in a LevelDB promotion.
 */
const MAX_HOST_MEMORY_FRACTION = 0.75;

/** What a run may accumulate, against what V8 and the host allow it. */
export interface HeapBudget {
  /** `--memory-limit`: the accumulator budget for every channel together. */
  memoryLimitMb: number;
  /** V8's heap ceiling for this process. */
  heapCeilingMb: number;
  /** Physical memory on this host. */
  hostMemoryMb: number;
}

/**
 * Read this process's heap ceiling and the host's memory.
 *
 * Separate from the checking so the arithmetic and the message can be exercised
 * for hosts this one is not.
 *
 * @param memoryLimitMb The run's `--memory-limit`, for all channels together.
 * @returns The budget, with both environment figures in MiB.
 */
export function readHeapBudget(memoryLimitMb: number): HeapBudget {
  return {
    memoryLimitMb,
    heapCeilingMb: Math.floor(v8.getHeapStatistics().heap_size_limit / MIB),
    hostMemoryMb: Math.floor(os.totalmem() / MIB),
  };
}

/** Heap, in MiB, a run needs to hold `memoryLimitMb` of accumulated state. */
export function requiredHeapMb(memoryLimitMb: number): number {
  return memoryLimitMb * HEAP_HEADROOM_FACTOR;
}

/**
 * Refuse a `--memory-limit` this process cannot hold.
 *
 * A budget above the heap ceiling does not merely risk an out-of-memory: it
 * disarms the mechanism that exists to prevent one. State spills to LevelDB when
 * the accumulators reach the budget, so a ceiling below the budget makes that a
 * threshold the process dies before crossing — hours into a walk, at the one
 * moment the accumulator is at its largest.
 *
 * @param budget The run's budget and the limits of the process running it.
 * @throws ExtractionError When the ceiling cannot hold the budget, carrying the
 *   `NODE_OPTIONS` line that would hold it, or — where that ceiling would not
 *   fit the host's memory — the flags that lower the budget instead.
 */
export function assertBudgetFitsHeap(budget: HeapBudget): void {
  const requiredMb = requiredHeapMb(budget.memoryLimitMb);
  if (budget.heapCeilingMb >= requiredMb) return;

  throw new ExtractionError(
    `--memory-limit ${budget.memoryLimitMb} lets the state accumulators reach ` +
      `${budget.memoryLimitMb} MB, which needs a ${requiredMb} MiB V8 heap; this ` +
      `process has ${budget.heapCeilingMb} MiB. The LevelDB promotion that keeps a ` +
      `walk inside that budget happens at ${budget.memoryLimitMb} MB, so the heap ` +
      `would run out before the spill it exists to trigger. ${remedy(budget, requiredMb)}`,
  );
}

/**
 * How to make the run fit: a larger ceiling where the host can back one, and the
 * flags that lower the budget where it cannot.
 */
function remedy(budget: HeapBudget, requiredMb: number): string {
  const affordableMb = Math.max(1, Math.floor(budget.heapCeilingMb / HEAP_HEADROOM_FACTOR));
  const lower =
    `lower --memory-limit to ${affordableMb} or below, or extract with ` +
    '--state-backend leveldb (docs/tuning.md#heap-size sizes both)';

  if (requiredMb > budget.hostMemoryMb * MAX_HOST_MEMORY_FRACTION) {
    return (
      `This host has ${budget.hostMemoryMb} MiB of memory, so a ${requiredMb} MiB ` +
      `ceiling would swap or be killed by the kernel rather than promote to ` +
      `LevelDB: ${lower}.`
    );
  }

  return (
    `Either start the process with NODE_OPTIONS=--max-old-space-size=${requiredMb}, ` +
    `which no flag can change once it is running, or ${lower}.`
  );
}
