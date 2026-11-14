import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Contract } from '@hyperledger/fabric-gateway';
import {
  DestinationIntent,
  FN_GET_PLAN,
  FN_GET_RECEIPT,
  FN_IMPORT_HISTORY,
  FN_INITIALIZE,
  PROTOCOL_VERSION,
  SourceIdentity,
  frameHistoryBatch,
  intentDigest,
  operationId,
  parsePlan,
  parseReceipt,
} from '../src/replay/history-import/protocol';
import { probeHistoryImportProtocol } from '../src/replay/history-import/preflight';
import { resolveHistoryImport } from '../src/replay/history-import/config';
import {
  HistoryImportMismatchError,
  HistoryImportPlanMismatchError,
  ResilientHistoryReplayer,
} from '../src/replay/history-import/replayer';
import { PublicHistoryRecord, ReplayConfig } from '../src/types';

// The client half of the resilient history-import protocol. The wire contract
// it drives is exercised in migration-contract.test.ts, which runs the shipped
// Node contract; these prove the client's own guarantees: the two commitments'
// stability and separation, the receipt parser, the pre-flight probe, config
// validation, and the reconciliation a lost commit response turns on.

/** A fixed HMAC key. The digests are deterministic under it. */
const KEY = Buffer.alloc(32, 7);

// ── The two commitments ───

describe('operation ID and intent commitment', () => {
  const source: SourceIdentity = {
    sourceNetworkId: 'n-1',
    sourceChannel: 'ch1',
    blockNumber: 5,
    txIndex: 2,
    txId: 'tx-1',
    chaincode: 'cc',
    collection: '',
    key: 'k1',
  };

  /** An intent over one value, holding the other fields fixed. */
  function destIntent(value: Buffer): DestinationIntent {
    return {
      destChannel: 'dest-ch1', chaincode: 'cc', collection: '', key: 'k1',
      isDelete: false, value,
    };
  }

  it('is 32 bytes and stable for the same source identity', () => {
    const first = operationId(KEY, source);
    const again = operationId(KEY, { ...source });

    expect(first).toHaveLength(32);
    expect(first.equals(again)).toBe(true);
  });

  it('depends on the source identity, not the destination value', () => {
    // The operation ID keys the receipt across runs and destinations, so it
    // must not move when the value written does. Two different intents share
    // one operation ID.
    const id = operationId(KEY, source);
    const intentA = intentDigest(KEY, destIntent(Buffer.from('a')));
    const intentB = intentDigest(KEY, destIntent(Buffer.from('b')));

    expect(id.equals(operationId(KEY, source))).toBe(true);
    expect(intentA.equals(intentB)).toBe(false);
  });

  it('changes when any source-identity field changes', () => {
    const id = operationId(KEY, source);

    expect(id.equals(operationId(KEY, { ...source, blockNumber: 6 }))).toBe(false);
    expect(id.equals(operationId(KEY, { ...source, key: 'k2' }))).toBe(false);
  });

  it('never equals the intent for the same inputs (domain separation)', () => {
    // Distinct domain tags keep the two keyed digests from ever colliding.
    const id = operationId(KEY, source);
    const intent = intentDigest(KEY, {
      destChannel: '', chaincode: 'cc', collection: '', key: 'k1',
      isDelete: false, value: Buffer.alloc(0),
    });

    expect(id.equals(intent)).toBe(false);
  });

  it('binds the write/delete distinction into the intent', () => {
    const write = intentDigest(KEY, destIntent(Buffer.alloc(0)));
    const remove = intentDigest(KEY, {
      ...destIntent(Buffer.alloc(0)),
      isDelete: true,
    });

    expect(write.equals(remove)).toBe(false);
  });
});

// ── Public history batch framing ───

describe('frameHistoryBatch', () => {
  it('encodes the delete flag for a tombstone', () => {
    const key = 'gone';
    const framed = frameHistoryBatch([{
      operationId: Buffer.alloc(32, 1),
      intent: Buffer.alloc(32, 2),
      key,
      value: Buffer.alloc(0),
      isDelete: true,
    }]);
    const flagAt = 4 + 32 + 32 + 4 + Buffer.byteLength(key);

    expect(framed.readUInt8(flagAt)).toBe(1);
  });
});

// ── The receipt parser ───

describe('parseReceipt', () => {
  const hex = 'ab'.repeat(32);

  function answer(obj: unknown): Buffer {
    return Buffer.from(JSON.stringify(obj), 'utf-8');
  }

  it('returns the intent bytes of an existing receipt', () => {
    const buf = parseReceipt(answer({ exists: true, intentDigest: hex }));

    expect(buf?.toString('hex')).toBe(hex);
  });

  it('returns null when the receipt does not exist', () => {
    expect(parseReceipt(answer({ exists: false }))).toBeNull();
  });

  it('returns null when exists is true but no intent is present', () => {
    expect(parseReceipt(answer({ exists: true }))).toBeNull();
  });

  it('returns null for a non-hex or wrong-length intent', () => {
    expect(parseReceipt(answer({ exists: true, intentDigest: 'zz'.repeat(32) })))
      .toBeNull();
    expect(parseReceipt(answer({ exists: true, intentDigest: 'ab'.repeat(31) })))
      .toBeNull();
    expect(parseReceipt(answer({ exists: true, intentDigest: hex.toUpperCase() })))
      .toBeNull();
  });

  it('returns null for a malformed or empty answer', () => {
    expect(parseReceipt(Buffer.from('not json', 'utf-8'))).toBeNull();
    expect(parseReceipt(Buffer.from('', 'utf-8'))).toBeNull();
  });
});


// ── The plan parser ───

describe('parsePlan', () => {
  it('returns the stored lowercase plan digest', () => {
    const digest = 'ab'.repeat(32);
    expect(parsePlan(Buffer.from(JSON.stringify({ planDigest: digest }))))
      .toBe(digest);
  });

  it('returns null for missing or malformed plan evidence', () => {
    expect(parsePlan(Buffer.alloc(0))).toBeNull();
    expect(parsePlan(Buffer.from('{}'))).toBeNull();
    expect(parsePlan(Buffer.from(JSON.stringify({ planDigest: 'AB'.repeat(32) }))))
      .toBeNull();
    expect(parsePlan(Buffer.from('not-json'))).toBeNull();
  });
});
// ── The pre-flight probe ───

describe('probeHistoryImportProtocol', () => {
  /** A Contract whose evaluate returns bytes. */
  function probeContract(behaviour: () => Uint8Array): Contract {
    return { evaluateTransaction: jest.fn(async () => behaviour()) } as unknown as Contract;
  }

  it('passes a contract that declares the required protocol', async () => {
    const contract = probeContract(() =>
      Buffer.from(JSON.stringify({ protocol: PROTOCOL_VERSION })),
    );

    expect(await probeHistoryImportProtocol(contract, PROTOCOL_VERSION)).toBeNull();
  });

  it('refuses a contract whose evaluate errors', async () => {
    const contract = {
      evaluateTransaction: jest.fn(async () => {
        throw new Error('no such function HistoryImportProtocol');
      }),
    } as unknown as Contract;

    expect(await probeHistoryImportProtocol(contract, PROTOCOL_VERSION))
      .toMatch(/did not answer/);
  });

  it('refuses a contract that declares a different protocol version', async () => {
    const contract = probeContract(() =>
      Buffer.from(JSON.stringify({ protocol: 'other-v9' })),
    );

    expect(await probeHistoryImportProtocol(contract, PROTOCOL_VERSION))
      .toMatch(/does not declare the required protocol version/);
  });

  it('refuses a non-JSON answer', async () => {
    const contract = probeContract(() => Buffer.from('garbage', 'utf-8'));

    expect(await probeHistoryImportProtocol(contract, PROTOCOL_VERSION))
      .toMatch(/does not declare/);
  });
});

// ── Config validation ───

describe('resolveHistoryImport', () => {
  let tmpDir: string;
  let keyFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-import-'));
    keyFile = path.join(tmpDir, 'key.hex');
    fs.writeFileSync(keyFile, 'ab'.repeat(32)); // 64 hex characters
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const SCOPE = 'ab'.repeat(16); // 32 lowercase hex characters

  /** A chaincode config with the given overrides. */
  function cc(overrides: Record<string, unknown>): NonNullable<ReplayConfig['chaincode']> {
    return {
      connectionProfilePath: '', mspId: 'Org1MSP', certPath: '', keyPath: '',
      channel: 'ch1', ...overrides,
    } as NonNullable<ReplayConfig['chaincode']>;
  }

  function historyImport(overrides: Record<string, unknown> = {}) {
    return { mode: 'idempotent-v1', scope: SCOPE, keyPath: keyFile, ...overrides };
  }

  it('returns null when historyImport is not configured', () => {
    expect(resolveHistoryImport(cc({}))).toBeNull();
  });

  it('resolves a valid config to a context carrying the loaded key', () => {
    const ctx = resolveHistoryImport(
      cc({ replayHistory: true, historyImport: historyImport() }),
    );

    expect(ctx).not.toBeNull();
    expect(ctx?.mode).toBe(PROTOCOL_VERSION);
    expect(ctx?.scope).toBe(SCOPE);
    expect(ctx?.key.equals(Buffer.from('ab'.repeat(32), 'hex'))).toBe(true);
  });

  it('refuses historyImport without replayHistory', () => {
    expect(() => resolveHistoryImport(cc({ historyImport: historyImport() })))
      .toThrow(/replayHistory/);
  });

  it('refuses an unimplemented mode', () => {
    expect(() => resolveHistoryImport(
      cc({ replayHistory: true, historyImport: historyImport({ mode: 'idempotent-v2' }) }),
    )).toThrow(/mode must be/);
  });

  it('refuses a malformed scope', () => {
    expect(() => resolveHistoryImport(
      cc({ replayHistory: true, historyImport: historyImport({ scope: 'TOO-SHORT' }) }),
    )).toThrow(/scope must be/);
  });

  it('refuses a missing key path', () => {
    expect(() => resolveHistoryImport(cc({
      replayHistory: true,
      historyImport: historyImport({ keyPath: '' }),
    }))).toThrow(/keyPath must be a path/);
  });

  it('refuses an unreadable key path', () => {
    expect(() => resolveHistoryImport(cc({
      replayHistory: true,
      historyImport: historyImport({ keyPath: path.join(tmpDir, 'missing') }),
    }))).toThrow(/could not be read/);
  });

  it('refuses a public mapping that points at an application contract', () => {
    // A resilient run must submit every public mutation through the migration
    // contract's ImportHistory, so a keyMapping naming an application function
    // is refused before the destination is contacted.
    expect(() => resolveHistoryImport(cc({
      replayHistory: true,
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
      historyImport: historyImport(),
    }))).toThrow(/application contract/);
  });
});

// ── The replayer's reconciliation ───

describe('ResilientHistoryReplayer reconciliation', () => {
  const context = {
    mode: PROTOCOL_VERSION as typeof PROTOCOL_VERSION,
    scope: 'ab'.repeat(16),
    key: Buffer.alloc(32, 9),
  };
  const PLAN = 'cd'.repeat(32);
  const DEST_CHANNEL = 'dest-ch1';
  const value = Buffer.from('v1');

  const record: PublicHistoryRecord = {
    _type: 'public_history',
    channel: 'ch1',
    chaincode: 'cc',
    key: 'k1',
    value: 'v1',
    txId: 'tx-1',
    txIndex: 0,
    blockNumber: 3,
    timestamp: '2026-01-01T00:00:00Z',
    isDelete: false,
    creator: {
      mspId: 'Org1MSP', certFingerprint: 'sha256:a', commonName: 'admin', org: 'org1',
    },
  };

  /** The intent the replayer will compute for this record and value. */
  const expectedIntent = intentDigest(context.key, {
    destChannel: DEST_CHANNEL, chaincode: 'cc', collection: '', key: 'k1',
    isDelete: false, value,
  });

  function newReplayer(): ResilientHistoryReplayer {
    return new ResilientHistoryReplayer({
      context, planDigest: PLAN, sourceNetworkId: 'n-1', destChannel: DEST_CHANNEL,
    });
  }

  /**
   * A Contract whose submit optionally fails on ImportHistory (a lost commit
   * response), and whose evaluate returns a receipt answer or throws.
   */
  function contractStub(opts: {
    failImport?: boolean;
    failInitialize?: boolean;
    receipt?: string;
    receiptThrows?: boolean;
    plan?: string;
  }) {
    const evaluate = jest.fn(async (fn: string, _scope: string, _op: string) => {
      if (fn === FN_GET_PLAN) {
        return Buffer.from(opts.plan ?? '', 'utf-8');
      }
      if (opts.receiptThrows) throw new Error('receipt read failed');
      return Buffer.from(opts.receipt ?? '', 'utf-8');
    });
    const contract = {
      newProposal: (fn: string, _options: { arguments: string[]; transientData?: unknown }) => ({
        endorse: async () => ({
          submit: async () => {
            if (opts.failInitialize && fn === FN_INITIALIZE) {
              throw new Error('initialization response lost');
            }
            if (opts.failImport && fn === FN_IMPORT_HISTORY) {
              throw new Error('commit response lost');
            }
            return {
              getStatus: async () => ({
                successful: true, code: 0, blockNumber: 1n, transactionId: 'tx',
              }),
            };
          },
        }),
      }),
      evaluateTransaction: evaluate,
    } as unknown as Contract;
    return { contract, evaluate };
  }

  const submission = { record, value, isDelete: false };

  it('accepts initialization whose response was lost when the stored plan matches', async () => {
    const { contract, evaluate } = contractStub({
      failInitialize: true,
      plan: JSON.stringify({ planDigest: PLAN }),
    });

    await expect(newReplayer().submitEntry(contract, submission)).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith(FN_GET_PLAN, context.scope);
  });

  it('aborts when initialization finds the scope bound to another plan', async () => {
    const { contract } = contractStub({
      failInitialize: true,
      plan: JSON.stringify({ planDigest: 'ef'.repeat(32) }),
    });

    await expect(newReplayer().submitEntry(contract, submission))
      .rejects.toThrow(HistoryImportPlanMismatchError);
  });

  it('returns without reconciling when the submit commits', async () => {
    const { contract, evaluate } = contractStub({});

    await expect(newReplayer().submitEntry(contract, submission)).resolves.toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('treats a lost commit response as success when the receipt matches', async () => {
    // The commit-response-loss case: the transaction committed but the client
    // saw an error. The receipt records this run's intent, so the write is
    // reported as landed and the queue advances.
    const { contract, evaluate } = contractStub({
      failImport: true,
      receipt: JSON.stringify({ exists: true, intentDigest: expectedIntent.toString('hex') }),
    });

    await expect(newReplayer().submitEntry(contract, submission)).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledWith(FN_GET_RECEIPT, context.scope, expect.any(String));
  });

  it('preserves the failure when no receipt exists', async () => {
    const { contract } = contractStub({
      failImport: true,
      receipt: JSON.stringify({ exists: false }),
    });

    await expect(newReplayer().submitEntry(contract, submission))
      .rejects.toThrow(/Failed to replay public history/);
  });

  it('preserves the failure when the receipt cannot be read', async () => {
    const { contract } = contractStub({ failImport: true, receiptThrows: true });

    await expect(newReplayer().submitEntry(contract, submission))
      .rejects.toThrow(/Failed to replay public history/);
  });

  it('aborts with a mismatch error when the receipt commits a different intent', async () => {
    const { contract } = contractStub({
      failImport: true,
      receipt: JSON.stringify({ exists: true, intentDigest: 'ff'.repeat(32) }),
    });

    await expect(newReplayer().submitEntry(contract, submission))
      .rejects.toThrow(HistoryImportMismatchError);
  });
});
