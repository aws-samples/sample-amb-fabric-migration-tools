// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  BATCH_DELETE,
  BATCH_HEADER_BYTES,
  BATCH_WRITE,
  PRIVATE_BATCH_TRANSIENT,
  PUBLIC_BATCH_TRANSIENT,
  StateBatchEntry,
} from '../../src/replay/state-batch';

/**
 * An independent reader of the batch framing, for suites that assert what a
 * submission actually carried.
 *
 * The toolkit only ever encodes: the three readers that matter are the contract
 * implementations under `sample/chaincode/migration_contract`, and
 * `migration-contract.test.ts` is what holds them to this framing. This one
 * exists so an adapter or orchestrator test can ask which keys and values a
 * transaction wrote without reaching for a contract.
 *
 * Deliberately strict about nothing: it assumes what the encoder produced, and
 * a blob it cannot read throws out of the test that fed it.
 */
export function decodeStateBatch(framed: Buffer): StateBatchEntry[] {
  const entries: StateBatchEntry[] = [];
  const count = framed.readUInt32BE(0);
  let pos = BATCH_HEADER_BYTES;

  for (let i = 0; i < count; i++) {
    const keyLength = framed.readUInt32BE(pos);
    const key = framed.subarray(pos + 4, pos + 4 + keyLength).toString('utf-8');
    const flag = framed[pos + 4 + keyLength];
    const valueAt = pos + 4 + keyLength + 1;
    const valueLength = framed.readUInt32BE(valueAt);
    const value = framed.subarray(valueAt + 4, valueAt + 4 + valueLength);

    if (flag !== BATCH_WRITE && flag !== BATCH_DELETE) {
      throw new Error(`entry ${i} of the batch has flag ${flag}`);
    }
    entries.push({ key, value, isDelete: flag === BATCH_DELETE });
    pos = valueAt + 4 + valueLength;
  }

  return entries;
}

/**
 * The ledger keys one submission writes.
 *
 * The key is the last argument on the single-record paths — `[key]` for public
 * data, `[collection, key]` for private — and inside the framed blob on the
 * batched ones (`[]` public, `[collection]` private), so a mock that decides anything per key has to look in both.
 */
export function writtenKeys(
  args: string[],
  transient?: Record<string, Uint8Array>,
): string[] {
  const framed =
    transient?.[PUBLIC_BATCH_TRANSIENT] ?? transient?.[PRIVATE_BATCH_TRANSIENT];
  if (framed) {
    return decodeStateBatch(Buffer.from(framed)).map((entry) => entry.key);
  }
  return args.length > 0 ? [args[args.length - 1]] : [];
}
