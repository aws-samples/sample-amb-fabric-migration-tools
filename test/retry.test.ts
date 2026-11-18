// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ConnectionError } from '../src/utils/errors';
import {
  DEFAULT_RETRY,
  PROBE_RETRY,
  retryDelayMs,
  withRetry,
} from '../src/utils/retry';
import { FabricVersionDetector } from '../src/discovery/version-detector';

const warnings: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
const errors: Array<{ ctx: Record<string, unknown>; msg: string }> = [];

jest.mock('../src/utils/logger', () => {
  const noop = (): void => {};
  const entry = (
    ctx: unknown,
    message?: string,
  ): { ctx: Record<string, unknown>; msg: string } =>
    typeof ctx === 'string'
      ? { ctx: {}, msg: ctx }
      : { ctx: ctx as Record<string, unknown>, msg: message ?? '' };
  const make = () => ({
    warn: (ctx: unknown, message?: string): void => {
      warnings.push(entry(ctx, message));
    },
    error: (ctx: unknown, message?: string): void => {
      errors.push(entry(ctx, message));
    },
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

/** Delays in milliseconds, so a whole test costs less than a tenth of a second. */
const FAST = { budgetMs: 60, baseDelayMs: 4, maxDelayMs: 8 };

beforeEach(() => {
  warnings.length = 0;
  errors.length = 0;
});

/** A call that always fails, with the attempt count it reached. */
function alwaysFails(error: Error): { fn: () => Promise<never>; attempts: () => number } {
  let attempts = 0;
  return {
    fn: async () => {
      attempts++;
      throw error;
    },
    attempts: () => attempts,
  };
}

/**
 * A call that fails `times` times and then succeeds.
 *
 * What ends the loop is the call, not the clock, so a test using this asserts
 * on how the loop spaced its attempts without depending on how many real
 * milliseconds a loaded machine leaves it. A budget wide enough that the clock
 * cannot end the loop first is the other half of that.
 */
function failsThenSucceeds(
  times: number,
  error: Error,
): { fn: () => Promise<string>; attempts: () => number } {
  let attempts = 0;
  return {
    fn: async () => {
      attempts++;
      if (attempts <= times) throw error;
      return 'ok';
    },
    attempts: () => attempts,
  };
}

/** A budget no scheduling delay can exhaust, for a call that ends its own loop. */
const UNBOUNDED = { budgetMs: 60_000, baseDelayMs: 4, maxDelayMs: 8 };

/** A gRPC error as grpc-js throws it: a numeric status code beside the message. */
function grpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('failures worth waiting out', () => {
  it('retries a peer that is restarting', async () => {
    const call = alwaysFails(new Error('14 UNAVAILABLE: no connection established'));

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow('UNAVAILABLE');
    expect(call.attempts()).toBeGreaterThan(1);
  });

  it('retries a restart the legacy SDK has wrapped in one of our errors', async () => {
    const call = alwaysFails(
      new ConnectionError('Query qscc.GetChainInfo failed: 14 UNAVAILABLE: connection dropped'),
    );

    await expect(withRetry(call.fn, 'getHeight', FAST)).rejects.toThrow(ConnectionError);
    expect(call.attempts()).toBeGreaterThan(1);
  });

  // The classification lists what is permanent, not what is transient, so a peer
  // message nobody anticipated is waited out rather than ending the walk.
  it('retries a failure nobody classified', async () => {
    const call = alwaysFails(new Error('something the peer has never said before'));

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow('never said before');
    expect(call.attempts()).toBeGreaterThan(1);
  });

  it('retries a deadline the peer blew through', async () => {
    const call = alwaysFails(grpcError(4, 'DEADLINE_EXCEEDED'));

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow('DEADLINE_EXCEEDED');
    expect(call.attempts()).toBeGreaterThan(1);
  });

  it('retries a peer that is refusing work under load', async () => {
    const call = alwaysFails(grpcError(8, 'RESOURCE_EXHAUSTED'));

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow('RESOURCE_EXHAUSTED');
    expect(call.attempts()).toBeGreaterThan(1);
  });

  // The gateway SDK reports a restart as a status code with a bare message, and
  // 14 is the code a peer that is down answers with — the whole point of the budget.
  it('retries a restart that arrives as a status code and nothing else', async () => {
    const call = alwaysFails(grpcError(14, 'no connection established'));

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow('no connection');
    expect(call.attempts()).toBeGreaterThan(1);
  });
});

describe('failures no wait will fix', () => {
  /** Attempts made before the error was rethrown. */
  async function attemptsFor(error: Error): Promise<number> {
    const call = alwaysFails(error);
    await expect(withRetry(call.fn, 'call', FAST)).rejects.toBe(error);
    return call.attempts();
  }

  it('does not retry an identity the peer refuses', async () => {
    expect(await attemptsFor(new Error('2 UNKNOWN: PERMISSION_DENIED: access to ch1'))).toBe(1);
  });

  it('does not retry a gRPC status that arrives as a code and nothing else', async () => {
    expect(await attemptsFor(grpcError(16, 'rpc error'))).toBe(1);
  });

  it('does not retry a CA that rejected the enrollment secret', async () => {
    expect(
      await attemptsFor(new Error('Enrollment failed: Authorization failure')),
    ).toBe(1);
  });

  it('does not retry an AWS call the caller is not allowed to make', async () => {
    const denied = Object.assign(new Error('User is not authorized to perform this action'), {
      name: 'AccessDeniedException',
    });

    expect(await attemptsFor(denied)).toBe(1);
  });

  it('does not retry a resource the control plane says is absent', async () => {
    expect(await attemptsFor(new ConnectionError('Network nd-ABSENT not found'))).toBe(1);
  });

  // The legacy path reports this as text, and it is the message that sends the
  // discoverer to lscc — so waiting on it delays a fallback that is already decided.
  it('does not retry a system chaincode the peer has never heard of', async () => {
    expect(
      await attemptsFor(new Error('UNIMPLEMENTED: unknown service protos.Gateway')),
    ).toBe(1);
  });

  // The legacy path wraps peer errors, and connect failures wrap the cause, so a
  // permanent failure can be a layer or two down from the message.
  it('finds a permanent failure wrapped as a cause', async () => {
    const wrapped = new ConnectionError(
      'CA enrollment failed',
      new Error('response: Authentication failure for user admin'),
    );

    expect(await attemptsFor(wrapped)).toBe(1);
  });

  it('classifies an error whose cause chain points back at itself', async () => {
    const looping = new Error('the peer is unreachable');
    Object.assign(looping, { cause: looping });
    const call = alwaysFails(looping);

    await expect(withRetry(call.fn, 'call', FAST)).rejects.toBe(looping);
    expect(call.attempts()).toBeGreaterThan(1);
  });
});

describe('the retry budget', () => {
  it('hands back the value from the attempt that worked', async () => {
    let attempts = 0;
    const fn = async (): Promise<string> => {
      attempts++;
      if (attempts < 3) throw new Error('14 UNAVAILABLE');
      return 'block';
    };

    expect(await withRetry(fn, 'fetchBlock', FAST)).toBe('block');
    expect(attempts).toBe(3);
  });

  // Three attempts was C7's defect: the tolerance has to be a span of time,
  // because that is what a peer restart occupies. That the span is what ends the
  // loop is `spends the whole budget before giving up`; this is that no count
  // ends it earlier.
  it('does not give up at a fixed number of attempts', async () => {
    const call = failsThenSucceeds(5, new Error('14 UNAVAILABLE'));

    expect(await withRetry(call.fn, 'fetchBlock', UNBOUNDED)).toBe('ok');
    expect(call.attempts()).toBe(6);
  });

  it('waits out an outage that ends inside the budget', async () => {
    const endsAt = Date.now() + 30;
    const fn = async (): Promise<string> => {
      if (Date.now() < endsAt) throw new Error('14 UNAVAILABLE: peer restarting');
      return 'back';
    };

    expect(await withRetry(fn, 'fetchBlock', { ...FAST, budgetMs: 2_000 })).toBe('back');
  });

  it('spends the whole budget before giving up', async () => {
    const call = alwaysFails(new Error('14 UNAVAILABLE'));
    const startedAt = Date.now();

    await expect(withRetry(call.fn, 'fetchBlock', FAST)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FAST.budgetMs);
  });

  // Without the clip the last sleep would run past the deadline the caller set —
  // a 30 s ceiling would overshoot a budget with 2 s left in it.
  it('clips the last delay to what is left of the budget', async () => {
    jest.useFakeTimers();
    try {
      const call = alwaysFails(new Error('14 UNAVAILABLE'));
      const budgetMs = 300;
      const retrying = withRetry(
        call.fn,
        'fetchBlock',
        { budgetMs, baseDelayMs: 5_000, maxDelayMs: 30_000 },
      );
      const assertion = expect(retrying).rejects.toThrow();

      await jest.runAllTimersAsync();
      await assertion;

      // The wait it logged, not the wall clock it took: unclipped, the first
      // delay alone would be 2.5 s of a 300 ms budget.
      expect(warnings).toHaveLength(1);
      expect(warnings[0].ctx.delayMs).toBeLessThanOrEqual(budgetMs);
      expect(call.attempts()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('makes a single attempt when the caller allows no time for a second', async () => {
    const call = alwaysFails(new Error('14 UNAVAILABLE'));

    await expect(withRetry(call.fn, 'fetchBlock', { ...FAST, budgetMs: 0 })).rejects.toThrow();
    expect(call.attempts()).toBe(1);
  });

  it('rethrows the error the last attempt raised, not a summary of it', async () => {
    const error = new ConnectionError('Query qscc.GetChainInfo failed: 14 UNAVAILABLE');
    const call = alwaysFails(error);

    await expect(withRetry(call.fn, 'getHeight', FAST)).rejects.toBe(error);
  });
});

describe('what a stalled run says in the log', () => {
  it('names the call, the wait and the budget on every retry', async () => {
    const call = alwaysFails(new Error('14 UNAVAILABLE'));

    await expect(withRetry(call.fn, 'fetchBlock(ch1#4210)', FAST)).rejects.toThrow();

    const retry = warnings.find((w) => /Retrying/.test(w.msg));
    expect(retry?.ctx).toMatchObject({ label: 'fetchBlock(ch1#4210)', budgetMs: 60 });
    expect(retry!.ctx.delayMs).toBeGreaterThan(0);
    expect(warnings.length).toBe(call.attempts() - 1);
  });

  // Backing away from a peer that is not answering is the point of the doubling,
  // and the loop has to feed the attempt number in for that to happen.
  it('waits longer after each failure', async () => {
    const call = failsThenSucceeds(3, new Error('14 UNAVAILABLE'));

    await withRetry(call.fn, 'fetchBlock', {
      ...UNBOUNDED, baseDelayMs: 10, maxDelayMs: 1_000,
    });

    // Half of each delay is jittered, so the third wait's floor of 20ms is what
    // clears the first's ceiling of 10ms — comparing adjacent waits would fail
    // on an unlucky draw.
    const delays = warnings.map((w) => w.ctx.delayMs as number);
    expect(delays).toHaveLength(3);
    expect(delays[2]).toBeGreaterThan(delays[0]);
  });

  it('reports the budget it exhausted, once, with the attempts it made', async () => {
    const call = alwaysFails(new Error('14 UNAVAILABLE'));

    await expect(withRetry(call.fn, 'getHeight(ch1)', FAST)).rejects.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toMatch(/budget exhausted/);
    expect(errors[0].ctx).toMatchObject({ label: 'getHeight(ch1)', attempts: call.attempts() });
    expect(errors[0].ctx.elapsedMs).toBeGreaterThanOrEqual(FAST.budgetMs);
  });

  it('says nothing at error level about a failure it never retried', async () => {
    const call = alwaysFails(new Error('PERMISSION_DENIED'));

    await expect(withRetry(call.fn, 'getHeight(ch1)', FAST)).rejects.toThrow();

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe('the delay between attempts', () => {
  const opts = { budgetMs: 180_000, baseDelayMs: 1_000, maxDelayMs: 30_000 };

  it('doubles per attempt', () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, opts, 1))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('stops doubling at the ceiling', () => {
    expect(retryDelayMs(10, opts, 1)).toBe(30_000);
  });

  it('holds the ceiling however long the outage lasts', () => {
    expect(retryDelayMs(100, opts, 1)).toBe(30_000);
  });

  // Half fixed, half random: enough to pull eight channel walkers apart without
  // letting a low draw bring them all back at once.
  it('never waits less than half the delay it is spacing out', () => {
    expect(retryDelayMs(1, opts, 0)).toBe(500);
    expect(retryDelayMs(4, opts, 0)).toBe(4_000);
  });

  it('spreads the wait across the jittered half', () => {
    expect(retryDelayMs(1, opts, 0.5)).toBe(750);
  });

  it('draws the jitter itself when the caller does not', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.25);

    try {
      expect(retryDelayMs(2, opts)).toBe(1_250);
    } finally {
      random.mockRestore();
    }
  });
});

describe('the budgets call sites choose', () => {
  // C7's premise: an AMB peer restart takes 30-120 s, and everything else about
  // this module is in service of surviving one, so the number is the contract.
  it('waits out a two-minute peer restart by default', () => {
    expect(DEFAULT_RETRY.budgetMs).toBeGreaterThanOrEqual(120_000);
  });

  // A budget of minutes must not become one long sleep: the peer has to be
  // probed often enough that the run resumes soon after it comes back.
  it('probes at least every half minute while it waits', () => {
    expect(DEFAULT_RETRY.maxDelayMs).toBeLessThanOrEqual(30_000);
  });

  it('gives a probe with a fallback seconds rather than minutes', () => {
    expect(PROBE_RETRY.budgetMs).toBeLessThan(DEFAULT_RETRY.budgetMs / 10);
  });

  // Version detection ends in assumed capabilities either way, so a peer that
  // will not answer it must not hold the connection up for three minutes.
  it('does not spend the walk budget detecting a version it can assume', async () => {
    jest.useFakeTimers();
    try {
      const network = {
        getContract: () => ({
          evaluateTransaction: async () => {
            throw new Error('14 UNAVAILABLE: cscc is not answering');
          },
          submitTransaction: async () => new Uint8Array(),
        }),
      };
      const startedAt = Date.now();
      const detecting = new FabricVersionDetector().detect(network, 'ch1');
      const assertion = expect(detecting).rejects.toThrow('UNAVAILABLE');

      await jest.runAllTimersAsync();
      await assertion;

      expect(Date.now() - startedAt).toBeLessThan(DEFAULT_RETRY.budgetMs / 10);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(PROBE_RETRY.budgetMs);
    } finally {
      jest.useRealTimers();
    }
  });
});
