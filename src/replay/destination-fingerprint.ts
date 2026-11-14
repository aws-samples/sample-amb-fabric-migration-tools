import * as crypto from 'crypto';
import { Network } from '@hyperledger/fabric-gateway';
import { ReplayError } from '../utils/errors';

/**
 * Destination fingerprints: which network a config is allowed to write to.
 *
 * A replay config names a connection profile, and a connection profile names a
 * host. Nothing in either says *which ledger* is behind that host, so a config
 * prepared and dry-run against a test destination writes to production as
 * soon as someone repoints the profile — or the dry-run destination is rebuilt
 * at the same address, and an attempt meant for the old one lands in the new.
 *
 * A channel's genesis block is the one thing that identifies its ledger: it is
 * created once, names the channel's founding orgs and orderers, and cannot
 * change. Its SHA-256 is the fingerprint. `chaincode.destinationFingerprint`
 * records one per destination channel, `replay` and `verify` read each
 * channel's genesis block before doing anything else, and any disagreement
 * stops the run. `fingerprint-destination` prints the map to paste in.
 */

/** Destination channel → hex SHA-256 of its genesis block. */
export type DestinationFingerprint = Record<string, string>;

/** Read a channel's genesis block through qscc and hash it. */
export async function fingerprintChannel(
  network: Network,
  destChannel: string,
): Promise<string> {
  const block = await network
    .getContract('qscc')
    .evaluateTransaction('GetBlockByNumber', destChannel, '0');
  return crypto.createHash('sha256').update(block).digest('hex');
}

/** Fingerprint every destination channel. */
export async function fingerprintDestination(
  networkFor: (destChannel: string) => Network,
  destChannels: string[],
): Promise<DestinationFingerprint> {
  const result: DestinationFingerprint = {};
  for (const destChannel of [...new Set(destChannels)].sort()) {
    result[destChannel] = await fingerprintChannel(networkFor(destChannel), destChannel);
  }
  return result;
}

/**
 * Refuse a run whose destination is not the one the config was made for.
 *
 * With no fingerprint configured nothing is checked and `false` is returned, so
 * the caller can warn: configs without one, such as those the sample test
 * networks write, keep working.
 *
 * @returns Whether a fingerprint was checked.
 * @throws ReplayError naming every channel that is missing from the map, does
 *   not answer, or answers with a different genesis block.
 */
export async function assertDestinationFingerprint(
  expected: DestinationFingerprint | undefined,
  networkFor: (destChannel: string) => Network,
  destChannels: string[],
): Promise<boolean> {
  if (expected === undefined) return false;

  const problems: string[] = [];
  for (const destChannel of [...new Set(destChannels)].sort()) {
    const want = expected[destChannel];
    if (!want) {
      problems.push(`${destChannel}: no entry in chaincode.destinationFingerprint`);
      continue;
    }
    let got: string;
    try {
      got = await fingerprintChannel(networkFor(destChannel), destChannel);
    } catch (err) {
      problems.push(`${destChannel}: could not read its genesis block (${(err as Error).message})`);
      continue;
    }
    if (got !== want.toLowerCase()) {
      problems.push(`${destChannel}: genesis block is ${got}, the config was made for ${want}`);
    }
  }

  if (problems.length > 0) {
    throw new ReplayError(
      'The destination is not the network this config was made for ' +
      '(chaincode.destinationFingerprint), so nothing will be read or written:\n' +
      problems.map((p) => `  ${p}`).join('\n') +
      '\nIf the destination was rebuilt on purpose, run fingerprint-destination ' +
      'against it and replace the map; otherwise check the connection profile.',
    );
  }
  return true;
}
