// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { logger } from './logger';

/** How long a call keeps trying, and how it spaces the attempts. */
export interface RetryOptions {
  /** Wall clock allowed for the whole call — attempts and delays together. */
  budgetMs: number;
  /** Delay before the second attempt. Doubles per attempt up to `maxDelayMs`. */
  baseDelayMs: number;
  /** Ceiling on a single delay, so a long budget still probes regularly. */
  maxDelayMs: number;
}

/**
 * Wide enough to sit out a peer restart.
 *
 * An AMB peer restart — a maintenance window, an instance replacement, a node
 * version upgrade — takes 30-120 seconds, during which every call fails with
 * `UNAVAILABLE`. A block walk over eight channels runs for hours, so a restart
 * is an expected event rather than an exceptional one, and a run that dies on it
 * costs the whole extraction. Three minutes covers the documented window with
 * margin while still failing a genuinely dead endpoint inside a coffee break;
 * beyond that the answer is to resume from the checkpoint, not to hold the run
 * open indefinitely.
 */
export const DEFAULT_RETRY: RetryOptions = {
  budgetMs: 180_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * For a probe whose failure the caller already recovers from.
 *
 * Version detection falls back to assumed capabilities, so waiting three minutes
 * to learn what a peer will not tell us buys nothing: the run would proceed the
 * same way, three minutes later.
 */
export const PROBE_RETRY: RetryOptions = { ...DEFAULT_RETRY, budgetMs: 5_000 };

/**
 * gRPC status codes that describe the request, not the moment.
 *
 * `UNAVAILABLE` (14), `DEADLINE_EXCEEDED` (4), `RESOURCE_EXHAUSTED` (8) and
 * `ABORTED` (10) are deliberately absent — those are what a restarting or
 * loaded peer returns, and they are the reason the budget exists.
 */
const PERMANENT_GRPC_CODES = new Set([
  3, // INVALID_ARGUMENT
  5, // NOT_FOUND
  7, // PERMISSION_DENIED
  12, // UNIMPLEMENTED
  16, // UNAUTHENTICATED
]);

/**
 * Text that identifies a failure no wait will fix, matched case-insensitively
 * against the error's name, message and causes.
 *
 * The gRPC tokens are here as well as in `PERMANENT_GRPC_CODES` because the
 * legacy SDK path wraps peer errors in a `ConnectionError` whose message quotes
 * the status but whose `code` is our own string. The last three are the strings
 * `chaincode-discoverer` and `gateway-factory` already treat as "use the other
 * path" — by their own logic, waiting cannot change the answer.
 */
const PERMANENT_MARKERS = [
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'UNIMPLEMENTED',
  'INVALID_ARGUMENT',
  'authorization failure',
  'authentication failure',
  'access denied',
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'ValidationException',
  'not found',
  'could not find chaincode',
  'does not support the Gateway',
].map((marker) => marker.toLowerCase());

/** Causes walked when classifying, enough for a wrapped-and-rewrapped error. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Whether waiting could change the outcome.
 *
 * The classification is a list of failures known to be permanent rather than a
 * list of failures known to be transient, and the direction is the load-bearing
 * choice: an unrecognised error is retried. An allowlist would turn any peer
 * message nobody anticipated into an immediate failure at hour 20 of a walk,
 * which is the outcome this whole module exists to avoid, while the cost of the
 * inverse — waiting out the budget on a permanent failure nobody listed — is
 * bounded by `budgetMs` and visible in the log.
 *
 * @param err The error an attempt threw.
 * @returns True when the same call would fail the same way however long it waits.
 */
function isPermanent(err: Error): boolean {
  const parts: string[] = [];

  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth <= MAX_CAUSE_DEPTH; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'number' && PERMANENT_GRPC_CODES.has(code)) return true;

    parts.push(current.name, current.message);
    current = (current as { cause?: unknown }).cause;
  }

  const haystack = parts.join(' ').toLowerCase();
  return PERMANENT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Delay before the next attempt: exponential, capped, and half jittered.
 *
 * Half of each delay is fixed and half is random, which spreads the eight
 * channel walkers of a `--concurrency 8` run — plus every other member
 * extracting at the same time — off a shared schedule, so a peer coming back up
 * is not met by all of them at once. Half rather than all of it stays fixed so
 * the attempts still walk away from a struggling peer instead of clustering
 * near zero.
 *
 * @param attempt The attempt that just failed, counting from 1.
 * @param opts The delays to grow between.
 * @param jitter Fraction of the jittered half to use; the default is random.
 * @returns Milliseconds to wait, between half and all of the exponential delay.
 */
export function retryDelayMs(
  attempt: number,
  opts: RetryOptions,
  jitter: number = Math.random(),
): number {
  const exponential = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  const fixed = exponential / 2;
  return Math.round(fixed + jitter * fixed);
}

/**
 * Run `fn`, retrying transient failures until the budget is spent.
 *
 * Attempts are not counted: the bound is wall clock, including the time the
 * calls themselves take, so the tolerance a caller asks for is the tolerance it
 * gets whatever the jitter draws and however slowly the peer fails. The last
 * delay is clipped to what is left of the budget, so the final attempt lands at
 * the deadline rather than short of it.
 *
 * @param fn The call to make. Must be safe to repeat: the calls wrapped today are
 *   peer and AMB control-plane reads, plus a CA enrollment that a failed attempt
 *   does not consume.
 * @param label Identifies the call in the retry and exhaustion logs.
 * @param options Overrides for {@link DEFAULT_RETRY}.
 * @returns Whatever `fn` returns on the attempt that succeeds.
 * @throws The error from the last attempt, unchanged, when the failure is
 *   permanent or the budget runs out.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as Error;

      if (isPermanent(error)) {
        logger.debug(
          { attempt, label, error: error.message },
          'Not retrying — the failure is permanent',
        );
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = opts.budgetMs - elapsedMs;

      if (remainingMs <= 0) {
        logger.error(
          { attempts: attempt, label, elapsedMs, budgetMs: opts.budgetMs, error: error.message },
          'Retry budget exhausted',
        );
        throw error;
      }

      const delayMs = Math.min(retryDelayMs(attempt, opts), remainingMs);
      logger.warn(
        { attempt, label, delayMs, elapsedMs, budgetMs: opts.budgetMs, error: error.message },
        'Retrying after a transient failure',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
