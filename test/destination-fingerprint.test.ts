import * as crypto from 'crypto';
import {
  assertDestinationFingerprint,
  fingerprintDestination,
} from '../src/replay/destination-fingerprint';
import { configuredDestChannels } from '../src/cli/commands/fingerprint-destination';

const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');

/** A network whose qscc returns a genesis block named after the channel. */
function networkFor(genesis: Record<string, string>) {
  const calls: string[][] = [];
  const fn = (destChannel: string) => ({
    getContract: (name: string) => ({
      evaluateTransaction: async (...args: string[]) => {
        calls.push([destChannel, name, ...args]);
        const block = genesis[destChannel];
        if (block === undefined) throw new Error('channel not found');
        return Buffer.from(block);
      },
    }),
  }) as any;
  return { fn, calls };
}

describe('fingerprintDestination', () => {
  it('hashes each channel\'s block 0 through qscc', async () => {
    const { fn, calls } = networkFor({ a: 'genesis-a', b: 'genesis-b' });

    expect(await fingerprintDestination(fn, ['b', 'a', 'b'])).toEqual({
      a: sha('genesis-a'), b: sha('genesis-b'),
    });
    expect(calls).toContainEqual(['a', 'qscc', 'GetBlockByNumber', 'a', '0']);
    expect(calls).toHaveLength(2);
  });
});

describe('assertDestinationFingerprint', () => {
  const { fn } = networkFor({ a: 'genesis-a', b: 'genesis-b' });

  it('checks nothing, and says so, when no fingerprint is configured', async () => {
    await expect(assertDestinationFingerprint(undefined, fn, ['a'])).resolves.toBe(false);
  });

  it('passes a destination whose genesis blocks match', async () => {
    await expect(assertDestinationFingerprint(
      { a: sha('genesis-a'), b: sha('genesis-b').toUpperCase() }, fn, ['a', 'b'],
    )).resolves.toBe(true);
  });

  /** A rebuilt destination at the same address has a new genesis block. */
  it('refuses a channel whose genesis block differs, naming both hashes', async () => {
    await expect(assertDestinationFingerprint({ a: sha('old-a') }, fn, ['a']))
      .rejects.toThrow(new RegExp(`a: genesis block is ${sha('genesis-a')}, the config was made for ${sha('old-a')}`));
  });

  it('refuses a channel the map does not name, and one that will not answer', async () => {
    const err = await assertDestinationFingerprint(
      { a: sha('genesis-a'), c: 'x' }, fn, ['a', 'b', 'c'],
    ).catch((e: Error) => e.message);

    expect(err).toContain('b: no entry in chaincode.destinationFingerprint');
    expect(err).toContain('c: could not read its genesis block');
    expect(err).not.toMatch(/\n {2}a:/);
  });
});

describe('configuredDestChannels', () => {
  it('reads channelMapping values, deduplicated, or the single channel', () => {
    expect(configuredDestChannels({ channelMapping: { s1: 'd2', s2: 'd1', s3: 'd2' } } as any))
      .toEqual(['d1', 'd2']);
    expect(configuredDestChannels({ channel: 'd' } as any)).toEqual(['d']);
  });
});
