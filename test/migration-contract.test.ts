import * as fs from 'fs';
import * as path from 'path';
import { Contract } from 'fabric-contract-api';
import { GRPC_MAX_RECEIVE_BYTES } from '../src/types';
import { DEFAULT_MIGRATION_CONTRACT } from '../src/replay/function-mapping';
import {
  BATCH_DELETE,
  BATCH_ENTRY_HEADER_BYTES,
  BATCH_HEADER_BYTES,
  BATCH_WRITE,
  MAX_BATCH_BYTES,
  PUBLIC_BATCH_TRANSIENT,
  PRIVATE_BATCH_TRANSIENT,
  frameStateBatch,
  framedBatchEntryBytes,
} from '../src/replay/state-batch';
import {
  HISTORY_ENTRY_TRANSIENT,
  KIND_PRIVATE_WRITE,
  KIND_PUBLIC_DELETE,
  KIND_PUBLIC_WRITE,
  OP_ID_BYTES,
  PUBLIC_HISTORY_BATCH_TRANSIENT,
  frameHistoryBatch,
  frameHistoryEnvelope,
} from '../src/replay/history-import/protocol';

// ── The migration contract, in three languages ───
//
// Row 2.12. One wire contract has three implementations, maintained by hand,
// so nothing else checks that a function added to one language reached the
// other two, or that a write added later carries the access control the other
// writes have. These read the sources, because a guard and a constant are
// declarations and one reader can check a declaration in all three languages.
// Compiling them is a separate gate — `scripts/compile-migration-stubs.sh`
// builds the Go and Java copies, in CI where those toolchains exist.

const CONTRACT_DIR = path.resolve(
  __dirname, '..', 'sample', 'chaincode', 'migration_contract',
);

const go = fs.readFileSync(
  path.join(CONTRACT_DIR, 'go', 'migration.go'), 'utf-8',
);
const node = fs.readFileSync(
  path.join(CONTRACT_DIR, 'node', 'migration.js'), 'utf-8',
);
const java = fs.readFileSync(
  path.join(CONTRACT_DIR, 'java', 'MigrationContract.java'), 'utf-8',
);

/** The functions the replay and verify commands call, and who may call them. */
const WRITE_FUNCTIONS = [
  'PutState',
  'PutStateBatch',
  'ImportPrivateData',
  'ImportPrivateDataBatch',
  'DeleteState',
  'DeletePrivateData',
  // Resilient idempotent Tier 3 history import (protocol idempotent-v1). Every
  // one is guarded like the writes above: they mutate the ledger, so an MSP
  // WRITER_MSP_IDS does not name may not call them.
  'InitializeHistoryImport',
  'ImportHistory',
  'ImportHistoryBatch',
];

const READ_FUNCTIONS = [
  'GetKeyHistory',
  'ReadState',
  'ReadPrivateData',
  'ReadPrivateDataHash',
  'ListKeys',
  // The read half of the history-import protocol: a plan lookup, a receipt
  // lookup and a protocol descriptor. Reads, so they are not gated — the
  // client's pre-flight probe and reconciliation call them as any identity.
  'GetHistoryImportPlan',
  'GetHistoryImportReceipt',
  'HistoryImportProtocol',
];

/**
 * Positional arguments each caller sends, `ctx` excluded.
 *
 * `chaincode-adapter.ts` builds these for the writes, `verify-runner.ts` for
 * the reads. A parameter added to the contract on one side alone is not a type
 * error anywhere — the arguments cross as a `string[]`, and the peer fails the
 * transaction at invocation time.
 */
const CALLER_ARGUMENTS: Array<[string, number]> = [
  ['PutState', 1],
  ['PutStateBatch', 0],
  ['ImportPrivateData', 2],
  ['ImportPrivateDataBatch', 1],
  ['DeleteState', 1],
  ['DeletePrivateData', 2],
  ['GetKeyHistory', 1],
  ['ReadState', 1],
  ['ReadPrivateData', 2],
  ['ReadPrivateDataHash', 2],
  ['ListKeys', 2],
  // History-import protocol. The client half is src/replay/history-import:
  // the replayer submits InitializeHistoryImport(scope, planDigest),
  // ImportHistory(scope, planDigest, operationId, intentDigest) with the
  // envelope in transient, and ImportHistoryBatch(scope, planDigest) with the
  // framed batch in transient; the pre-flight probe evaluates
  // HistoryImportProtocol() and reconciliation GetHistoryImportReceipt(scope,
  // operationId). GetHistoryImportPlan(scope) is read by the same protocol.
  ['InitializeHistoryImport', 2],
  ['ImportHistory', 4],
  ['ImportHistoryBatch', 2],
  ['GetHistoryImportPlan', 1],
  ['GetHistoryImportReceipt', 2],
  ['HistoryImportProtocol', 0],
];

/** The SCREAMING_SNAKE name of a constant, as Go declares it. */
function goConstant(name: string): string {
  return name.toLowerCase().replace(/_(\w)/g, (_, c) => c.toUpperCase());
}

/** The value of a `4` or `2 * 1024 * 1024` style declaration. */
function constantValue(declaration: string): number {
  return declaration
    .split('*')
    .reduce((product, term) => product * Number(term), 1);
}

/** Where each language declares a contract function, and how it guards one. */
const LANGUAGES = [
  {
    name: 'go',
    source: go,
    signature: (fn: string) =>
      new RegExp(`^func \\(m \\*MigrationContract\\) ${fn}\\(`, 'm'),
    declared: /^func \(m \*MigrationContract\) (\w+)\(/gm,
    guard: 'requireWriter(ctx)',
    emptyList: 'var writerMSPIDs = []string{}',
    historyCap: /^const maxHistoryValueBytes = (\d+) \* 1024 \* 1024$/m,
    capName: 'maxHistoryValueBytes',
    constant: (name: string) => new RegExp(
      `^\\s*(?:const )?${goConstant(name)}\\s+= ([\\d *]+)$`, 'm',
    ),
  },
  {
    name: 'node',
    source: node,
    signature: (fn: string) => new RegExp(`^  async ${fn}\\(ctx`, 'm'),
    declared: /^ {2}async (\w+)\(ctx/gm,
    guard: 'requireWriter(ctx);',
    emptyList: 'const WRITER_MSP_IDS = [];',
    historyCap: /^const MAX_HISTORY_VALUE_BYTES = (\d+) \* 1024 \* 1024;$/m,
    capName: 'MAX_HISTORY_VALUE_BYTES',
    constant: (name: string) => new RegExp(
      `^const ${name} = ([\\d *]+);$`, 'm',
    ),
  },
  {
    name: 'java',
    source: java,
    signature: (fn: string) =>
      new RegExp(`^    public (?:void|String) ${fn}\\(final Context ctx`, 'm'),
    declared: /^ {4}public (?:void|String) (\w+)\(final Context ctx/gm,
    guard: 'requireWriter(ctx);',
    emptyList: 'private static final List<String> WRITER_MSP_IDS = List.of();',
    historyCap:
      /^ {4}private static final long MAX_HISTORY_VALUE_BYTES =\n?\s*(\d+)L \* 1024 \* 1024;$/m,
    capName: 'MAX_HISTORY_VALUE_BYTES',
    constant: (name: string) => new RegExp(
      `^    private static final int ${name} = ([\\d *]+);$`, 'm',
    ),
  },
];

/**
 * One function's body, by counting braces from its signature.
 *
 * Sliced rather than parsed because the assertions are about which calls a
 * body makes, and three languages that all delimit with braces need one
 * reader between them.
 */
function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start < 0) throw new Error(`no signature matching ${signature}`);

  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe('migration contract parity', () => {
  const functions = [...WRITE_FUNCTIONS, ...READ_FUNCTIONS];

  describe.each(LANGUAGES)('$name', ({ source, signature }) => {
    it.each(functions)('declares %s', (fn) => {
      expect(source).toMatch(signature(fn));
    });
  });

  it.each(LANGUAGES)('$name declares nothing else', ({ source, declared }) => {
    // The assertions above name only the functions this repo calls, so a
    // function added to one language alone would pass every one of them. The
    // wire contract is the whole set, not a subset: an extra callable write on
    // one destination is a way in that the other two do not have.
    expect([...source.matchAll(declared)].map((m) => m[1]).sort())
      .toEqual([...functions].sort());
  });
});

describe('migration contract write access control', () => {
  describe.each(LANGUAGES)('$name', (lang) => {
    it.each(WRITE_FUNCTIONS)('%s refuses an MSP that is not a writer', (fn) => {
      const body = functionBody(lang.source, lang.signature(fn));
      expect(body).toContain(lang.guard);
    });

    it.each(READ_FUNCTIONS)('%s does not gate reads', (fn) => {
      // Deliberate: verify may run as an identity that must not write, and a
      // guard copied onto a read function would fail verification instead.
      const body = functionBody(lang.source, lang.signature(fn));
      expect(body).not.toContain(lang.guard);
    });

    it('ships with no writer, so an unset list refuses every write', () => {
      // The shipped list is empty rather than an example, which a real
      // destination would inherit as a default nobody chose.
      expect(lang.source).toContain(lang.emptyList);
    });
  });
});

// ── The bounded history read ───
//
// M7's second claim. Fabric has no paginated history API, so a key deep enough
// to overflow the peer's gRPC message limit can only be refused — and it has to
// be refused at the same depth in all three languages, or the same destination
// answers or fails depending on which file was packaged.

describe('migration contract history bound', () => {
  it.each(LANGUAGES)('$name declares the cap', ({ source, historyCap }) => {
    expect(source).toMatch(historyCap);
  });

  it('caps all three at the same size', () => {
    const caps = LANGUAGES.map(
      ({ source, historyCap }) => source.match(historyCap)?.[1],
    );

    expect(caps).toEqual([caps[0], caps[0], caps[0]]);
    expect(Number(caps[0])).toBeGreaterThan(0);
  });

  it('is a depth the tool\'s own gRPC client will accept', () => {
    // The cap exists so that a history read fits in one gRPC message, and every
    // entry is base64 — so it is the *client's* receive limit the cap has to
    // clear, not the peer's. grpc-js defaults to 4 MiB, under half of this.
    const [{ source, historyCap }] = LANGUAGES;
    const cap = Number(source.match(historyCap)?.[1]) * 1024 * 1024;

    expect(GRPC_MAX_RECEIVE_BYTES).toBeGreaterThan(Math.ceil(cap / 3) * 4);
  });

  it.each(LANGUAGES)('$name compares against it in GetKeyHistory', (lang) => {
    // The comparison, not just the name: all three quote the cap in the refusal
    // they raise, so a bound that is declared, named in that message and never
    // enforced would read as applied. That is worse than no bound — the doc
    // comment and the message both claim a refusal that cannot happen.
    const body = functionBody(lang.source, lang.signature('GetKeyHistory'));

    expect(body).toContain(`total > ${lang.capName}`);
  });
});

// ── The batch framing ───
//
// C8. `src/replay/state-batch.ts` is the only encoder and the three parsers are
// hand written, so a width that drifts in one language is a compile error
// nowhere: it is a destination that mis-parses every batch it accepts, and the
// keys it silently mangles are the migrated data.

/** Width of one length field: an entry header is two of them and the flag. */
const LENGTH_BYTES = (BATCH_ENTRY_HEADER_BYTES - 1) / 2;

/** Framing constants every language has to agree with the encoder on. */
const BATCH_CONSTANTS: Array<[string, number]> = [
  ['MAX_BATCH_BYTES', MAX_BATCH_BYTES],
  ['BATCH_HEADER_BYTES', BATCH_HEADER_BYTES],
  ['BATCH_LENGTH_BYTES', LENGTH_BYTES],
  ['BATCH_WRITE', BATCH_WRITE],
  ['BATCH_DELETE', BATCH_DELETE],
];

describe('migration contract batch framing', () => {
  describe.each(LANGUAGES)('$name', ({ source, constant, signature }) => {
    it.each(BATCH_CONSTANTS)('declares %s as %d', (name, expected) => {
      const declared = source.match(constant(name))?.[1];

      expect(declared).toBeDefined();
      expect(constantValue(declared as string)).toBe(expected);
    });

    it('reads the batch from the transient entry the adapter sends', () => {
      // The call, not the name anywhere in the file: all three name the entry
      // in a doc comment too, so a contract reading the batch from some other
      // key would still match on its own prose.
      const body = functionBody(source, signature('PutStateBatch'));

      expect(body).toMatch(
        new RegExp(`transientValue\\(ctx, ['"]${PUBLIC_BATCH_TRANSIENT}['"]\\)`),
      );
    });

    it('refuses a batch that names one key twice', () => {
      // What history fidelity rests on: a transaction records one version per
      // key, so a batch holding two versions of one key would commit the last
      // and lose the earlier ones with no error raised anywhere.
      expect(source).toContain('twice, at entry ');
    });
  });

  it.each(LANGUAGES)('$name reads a private batch from its own entry, into one collection', (lang) => {
    const body = functionBody(lang.source, lang.signature('ImportPrivateDataBatch'));

    expect(body).toMatch(
      new RegExp(`transientValue\\(ctx, ['"]${PRIVATE_BATCH_TRANSIENT}['"]\\)`),
    );
    expect(body).toMatch(/parseBatch\(/);
    expect(body).toMatch(/[Pp]utPrivateData\(collection, entry\.key, entry\.value\)/);
    expect(body).toMatch(/[Dd]el(?:ete)?PrivateData\(collection, entry\.key\)/);
  });

  it.each(LANGUAGES)('$name writes and deletes what it parsed', (lang) => {
    // A parser that dropped the flag would turn every source tombstone into a
    // write of the empty value, which verify reports as a mismatch on a key the
    // source does not have.
    const body = functionBody(lang.source, lang.signature('PutStateBatch'));

    expect(body).toMatch(/[Dd]el(?:ete)?State\(entry\.key\)/);
    expect(body).toMatch(/[Pp]utState\(entry\.key, entry\.value\)/);
  });
});

// ── The Node contract, executed ───
//
// One of the three implementations runs here, against the contract API the
// customer deploys against: `fabric-contract-api` is a devDependency, so
// `require('fabric-contract-api')` inside the stub resolves to the real package
// and `npm ci` is the only thing that has to have run. That is one claim more
// than the source assertions above can make — the guard refuses before the stub
// is touched, rather than the call merely being present. Go and Java compile in
// CI but run nowhere; the three are held together by the parity assertions.

const { MigrationContract } =
  require('../sample/chaincode/migration_contract/node/migration');

// The peer does not call these functions by any name this repo holds: it loads
// the module, finds the contract under the name the class handed its base
// constructor, and invokes prototype methods positionally. The hand-written
// `Contract` that stood in for the real package before it was a devDependency
// left all three of those unobservable.
describe('the shipped Node contract, as the peer loads it', () => {
  it('extends the base class the customer installs', () => {
    expect(MigrationContract.prototype instanceof Contract).toBe(true);
  });

  it('answers to the name every caller addresses', () => {
    // Every call resolves server-side on this string. Rename it and they all
    // fail at the peer with a contract-not-found the tool reports as a
    // chaincode that was never committed.
    expect(new MigrationContract().getName()).toBe(DEFAULT_MIGRATION_CONTRACT);
  });

  it('exposes the wire contract and nothing else', () => {
    // Stronger than the source regex, which reads `async <name>(ctx`: a helper
    // declared without `async`, or with a differently named first parameter, is
    // invisible to that and is still an invokable transaction on the peer.
    expect(
      Object.getOwnPropertyNames(MigrationContract.prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual([...WRITE_FUNCTIONS, ...READ_FUNCTIONS].sort());
  });

  it.each(CALLER_ARGUMENTS)(
    '%s takes the %i arguments its caller sends',
    (fn, count) => {
      expect(MigrationContract.prototype[fn]).toHaveLength(count + 1);
    },
  );
});

/**
 * A history iterator in `fabric-shim`'s shape: one `next()` per modification,
 * `done` on the call past the last, and a `close()` the contract must reach.
 */
function historyIterator(values: Buffer[]) {
  let i = 0;
  return {
    close: jest.fn(async () => undefined),
    next: async () => {
      if (i >= values.length) return { done: true };
      const value = values[i++];
      return { value: { value, isDelete: value.length === 0 }, done: false };
    },
  };
}

/** A transaction context whose client presents `mspId`. */
function context(mspId: string, history: Buffer[] = []) {
  const iterator = historyIterator(history);
  const stub = {
    putState: jest.fn(),
    putPrivateData: jest.fn(),
    deleteState: jest.fn(),
    deletePrivateData: jest.fn(),
    getState: jest.fn(async () => Buffer.from('value')),
    getPrivateDataHash: jest.fn(async () => Buffer.from('hashbytes')),
    getHistoryForKey: jest.fn(async () => iterator),
    getTransient: (): Map<string, Buffer> => new Map([
      ['public_value', Buffer.from('value')],
      ['private_value', Buffer.from('value')],
    ]),
  };
  return { stub, iterator, clientIdentity: { getMSPID: () => mspId } };
}

describe('the shipped Node contract', () => {
  const writes: Array<[string, (c: any, ctx: any) => Promise<void>, string]> = [
    ['PutState', (c, ctx) => c.PutState(ctx, 'k'), 'putState'],
    // Nothing is put in this context's transient map, so this also pins the
    // order: the guard refuses before the batch is read, let alone written.
    ['PutStateBatch', (c, ctx) => c.PutStateBatch(ctx), 'putState'],
    [
      'ImportPrivateData',
      (c, ctx) => c.ImportPrivateData(ctx, 'coll', 'k'),
      'putPrivateData',
    ],
    [
      'ImportPrivateDataBatch',
      (c, ctx) => c.ImportPrivateDataBatch(ctx, 'coll'),
      'putPrivateData',
    ],
    ['DeleteState', (c, ctx) => c.DeleteState(ctx, 'k'), 'deleteState'],
    [
      'DeletePrivateData',
      (c, ctx) => c.DeletePrivateData(ctx, 'coll', 'k'),
      'deletePrivateData',
    ],
  ];

  it.each(writes)('refuses %s with an empty writer list', async (
    _name, call, stubMethod,
  ) => {
    const ctx = context('Org9MSP');

    await expect(call(new MigrationContract(), ctx)).rejects.toThrow(
      /Org9MSP may not write migration data: WRITER_MSP_IDS is empty/,
    );
    expect((ctx.stub as any)[stubMethod]).not.toHaveBeenCalled();
  });

  it('says where to set the list', async () => {
    // The refusal is the shipped state, so the message has to carry the fix.
    await expect(
      new MigrationContract().PutState(context('Org9MSP'), 'k'),
    ).rejects.toThrow(/Set it in migration.js/);
  });

  it('still reads for an MSP that may not write', async () => {
    const value = await new MigrationContract().ReadState(
      context('Org9MSP'), 'k',
    );

    expect(value).toBe(Buffer.from('value').toString('base64'));
  });

  // Row 2.12's other half. The hash read is what verify falls back to for a
  // collection its one identity is not a member of, so it must answer for an
  // MSP that can neither write nor read the values.
  it('answers ReadPrivateDataHash for an MSP that may not write', async () => {
    const ctx = context('Org9MSP');

    const hash = await new MigrationContract().ReadPrivateDataHash(
      ctx, 'coll', 'k',
    );

    expect(hash).toBe(Buffer.from('hashbytes').toString('base64'));
    expect(ctx.stub.getPrivateDataHash).toHaveBeenCalledWith('coll', 'k');
  });

  it('refuses a private hash the destination does not hold', async () => {
    // Empty means the key is not there, which has to read as absent rather
    // than as a hash of nothing: verify keeps its own `missing` for this.
    const ctx = context('Org1MSP');
    ctx.stub.getPrivateDataHash = jest.fn(async () => Buffer.alloc(0));

    await expect(
      new MigrationContract().ReadPrivateDataHash(ctx, 'coll', 'k'),
    ).rejects.toThrow(/private data coll\/k does not exist/);
  });

  it('returns a short history with its values and delete flags', async () => {
    const ctx = context('Org1MSP', [Buffer.from('v1'), Buffer.alloc(0)]);

    const parsed = JSON.parse(
      await new MigrationContract().GetKeyHistory(ctx, 'k'),
    );

    expect(parsed).toEqual([
      { value: Buffer.from('v1').toString('base64'), isDelete: false },
      { value: '', isDelete: true },
    ]);
    expect(ctx.iterator.close).toHaveBeenCalled();
  });

  describe('the history bound', () => {
    /** Two versions whose values together exceed any plausible cap. */
    const deep = () => [
      Buffer.alloc(5 * 1024 * 1024, 1),
      Buffer.alloc(5 * 1024 * 1024, 2),
    ];

    it('refuses a history too deep to return in one response', async () => {
      // Naming the key and the version is the whole value of refusing: there
      // is no paginated history API, so the operator's only move is to check
      // this key by hand, and a transport error would name neither.
      await expect(
        new MigrationContract().GetKeyHistory(context('Org1MSP', deep()), 'k'),
      ).rejects.toThrow(/history for k exceeds \d+ value bytes at version 2/);
    });

    it('closes the iterator it refuses to drain', async () => {
      const ctx = context('Org1MSP', deep());

      await expect(
        new MigrationContract().GetKeyHistory(ctx, 'k'),
      ).rejects.toThrow();

      expect(ctx.iterator.close).toHaveBeenCalled();
    });

    it('answers a history that exactly reaches the cap', async () => {
      // The cap is what may be returned, not what is too much. Refusing here
      // would make the documented bound off by one version.
      const cap = Number(
        node.match(/^const MAX_HISTORY_VALUE_BYTES = (\d+) \* 1024 \* 1024;$/m)
          ?.[1],
      ) * 1024 * 1024;
      const ctx = context('Org1MSP', [Buffer.alloc(cap, 3)]);

      const result = await new MigrationContract().GetKeyHistory(ctx, 'k');

      expect(result.startsWith('[{"value":"')).toBe(true);
    });
  });
});

// ── The Node parser, against the encoder ───
//
// The one place in this repo where what `src/replay/state-batch.ts` writes is
// read back by a contract that ships. Go and Java parse the same framing by
// hand; the assertions above are what holds them to it.

/**
 * The shipped contract, loaded from source with a writer list.
 *
 * As packaged it refuses every MSP, so the parser behind the guard cannot be
 * reached at all. The sample destination substitutes this same declaration with
 * `sed` before it deploys the Go contract; this does it in memory.
 */
function contractWithWriter(mspId: string): any {
  const patched = node.replace(
    'const WRITER_MSP_IDS = [];', `const WRITER_MSP_IDS = ['${mspId}'];`,
  );
  if (patched === node) {
    throw new Error('the writer list is no longer declared as shipped');
  }

  const loaded = { exports: {} as any };
  new Function('module', 'exports', 'require', patched)(
    loaded, loaded.exports, require,
  );
  return new loaded.exports.MigrationContract();
}

/** A writer's context whose transient map carries `framed`. */
function batchContext(framed: Buffer) {
  const ctx = context('Org1MSP');
  ctx.stub.getTransient = () => new Map([[PUBLIC_BATCH_TRANSIENT, framed]]);
  return ctx;
}

describe('the shipped Node contract, parsing a batch', () => {
  const writes = [
    { key: 'alpha', value: Buffer.from('one'), isDelete: false },
    { key: 'beta', value: Buffer.from([0xff, 0x00, 0xfe]), isDelete: false },
  ];

  it('writes every entry the encoder framed', async () => {
    const ctx = batchContext(frameStateBatch(writes));

    await contractWithWriter('Org1MSP').PutStateBatch(ctx);

    expect(ctx.stub.putState.mock.calls).toEqual([
      ['alpha', Buffer.from('one')],
      ['beta', Buffer.from([0xff, 0x00, 0xfe])],
    ]);
    expect(ctx.stub.deleteState).not.toHaveBeenCalled();
  });

  it('deletes a tombstone rather than writing an empty value', async () => {
    // The two are different ledger facts and verify compares them, so a
    // tombstone that arrived as a write of no bytes would be a mismatch on
    // every deleted key.
    const ctx = batchContext(frameStateBatch([
      writes[0], { key: 'gone', value: Buffer.alloc(0), isDelete: true },
    ]));

    await contractWithWriter('Org1MSP').PutStateBatch(ctx);

    expect(ctx.stub.deleteState.mock.calls).toEqual([['gone']]);
    expect(ctx.stub.putState.mock.calls).toEqual([['alpha', Buffer.from('one')]]);
  });

  it('carries a value no argument could', async () => {
    // The reason a batch travels as transient bytes: this value is not valid
    // UTF-8, and a String argument would reach putState as U+FFFD.
    const value = Buffer.from([0x80, 0xc3, 0x28]);
    const ctx = batchContext(frameStateBatch([{ key: 'k', value, isDelete: false }]));

    await contractWithWriter('Org1MSP').PutStateBatch(ctx);

    expect(ctx.stub.putState.mock.calls[0][1].equals(value)).toBe(true);
  });

  it('writes a private batch into the one collection it names', async () => {
    const ctx = context('Org1MSP');
    ctx.stub.getTransient = () => new Map([[PRIVATE_BATCH_TRANSIENT, frameStateBatch([
      writes[1], { key: 'gone', value: Buffer.alloc(0), isDelete: true },
    ])]]);

    await contractWithWriter('Org1MSP').ImportPrivateDataBatch(ctx, 'coll');

    expect(ctx.stub.putPrivateData.mock.calls).toEqual([
      ['coll', 'beta', Buffer.from([0xff, 0x00, 0xfe])],
    ]);
    expect(ctx.stub.deletePrivateData.mock.calls).toEqual([['coll', 'gone']]);
  });

  it('refuses a private batch naming one key twice', async () => {
    const ctx = context('Org1MSP');
    ctx.stub.getTransient = () => new Map([[PRIVATE_BATCH_TRANSIENT,
      frameStateBatch([writes[0], writes[0]])]]);

    await expect(contractWithWriter('Org1MSP').ImportPrivateDataBatch(ctx, 'coll'))
      .rejects.toThrow(/twice/);
    expect(ctx.stub.putPrivateData).not.toHaveBeenCalled();
  });

  it('refuses a missing batch rather than writing nothing', async () => {
    await expect(
      contractWithWriter('Org1MSP').PutStateBatch(context('Org1MSP')),
    ).rejects.toThrow(/public_batch not found in transient data/);
  });

  describe('refusals', () => {
    /** A framed batch, with one byte of it altered. */
    function corrupt(framed: Buffer, at: number, byte: number): Buffer {
      const copy = Buffer.from(framed);
      copy.writeUInt8(byte, at);
      return copy;
    }

    const framed = frameStateBatch(writes);

    const cases: Array<[string, Buffer, RegExp]> = [
      [
        'a key named twice',
        frameStateBatch([writes[0], writes[0]]),
        /batch names key alpha twice, at entry 1/,
      ],
      [
        'a value cut short',
        framed.subarray(0, framed.length - 1),
        /entry 1 declares a 3-byte value but only 2 bytes remain/,
      ],
      [
        'a blob that ends after a key',
        frameStateBatch([writes[0]]).subarray(
          0, BATCH_HEADER_BYTES + LENGTH_BYTES + writes[0].key.length,
        ),
        /entry 0 ends before its write\/delete flag/,
      ],
      [
        'a blob that ends between entries',
        framed.subarray(
          0, BATCH_HEADER_BYTES + framedBatchEntryBytes(writes[0]) + 2,
        ),
        /entry 1 ends before its key length/,
      ],
      [
        'bytes left over',
        Buffer.concat([framed, Buffer.from([0])]),
        /batch has 1 bytes left over after its 2 entries/,
      ],
      [
        'no entries',
        frameStateBatch([]),
        /batch declares no entries/,
      ],
      [
        'more entries than could fit',
        corrupt(framed, 3, 100),
        /batch declares 100 entries, which cannot fit in \d+ bytes/,
      ],
      [
        'a delete carrying a value',
        frameStateBatch([{ ...writes[0], isDelete: true }]),
        /entry 0 is a delete carrying 3 value bytes/,
      ],
      [
        'a flag that is neither',
        corrupt(framed, BATCH_HEADER_BYTES + 4 + 'alpha'.length, 7),
        /entry 0 has flag 7, which is neither a write \(0\) nor a delete \(1\)/,
      ],
      [
        'more bytes than a transaction can order',
        frameStateBatch([
          { key: 'k', value: Buffer.alloc(MAX_BATCH_BYTES), isDelete: false },
        ]),
        /exceeds the \d+-byte limit.*lower chaincode.writeBatchSize/,
      ],
    ];

    it.each(cases)('refuses %s', async (_name, blob, message) => {
      const ctx = batchContext(blob);

      await expect(
        contractWithWriter('Org1MSP').PutStateBatch(ctx),
      ).rejects.toThrow(message);
      // Nothing partial: a framing disagreement leaves the destination holding
      // none of the batch, so the whole of it is retried rather than a prefix
      // being reported as replayed.
      expect(ctx.stub.putState).not.toHaveBeenCalled();
      expect(ctx.stub.deleteState).not.toHaveBeenCalled();
    });
  });
});

describe('the sample destination renders a writer list', () => {
  const script = fs.readFileSync(
    path.resolve(
      __dirname, '..', 'sample', 'scripts', 'destination',
      'setup-test-network.sh',
    ),
    'utf-8',
  );

  it('substitutes the declaration the Go contract still has', () => {
    // The E2E destination gets its MSP IDs from a sed on this exact line. A
    // renamed declaration would leave the deployed contract refusing every
    // write, and the run would fail at the first replayed key instead of here.
    const declaration = 'var writerMSPIDs = []string{}';
    expect(go).toContain(`\n${declaration}\n`);
    expect(script).toContain(declaration.replace('[]', '\\[\\]'));
  });

  it('names both orgs whose identities submit', () => {
    // Org2's identity replays org2OnlyData through Org1's gateway, so the
    // gateway's org alone is not the set of MSPs that write.
    expect(script).toContain('[]string{"Org1MSP", "Org2MSP"}');
  });
});

// ── The Node contract, running the resilient history-import protocol ───
//
// The protocol is what makes a failed or interrupted Tier 3 history replay safe
// to re-run: each mutation is paired with a receipt keyed by an operation ID
// over the immutable source record, and the receipt is read and written in the
// same transaction as the mutation. The source assertions above prove the six
// functions are declared, guarded, and take the arguments their callers send;
// these run the shipped Node contract against a stateful stub to prove the
// behaviour the client half (src/replay/history-import) depends on.
//
// operationId, intentDigest and planDigest are opaque hex to the contract — it
// stores and compares them without recomputing — so these feed fixed 64-hex
// strings and 32-byte digests rather than real HMACs.

/** A scope: 64 lowercase hex characters, in range. */
const HISTORY_SCOPE = 'ab12'.repeat(16);

/** A plan digest: 64 lowercase hex characters. */
const HISTORY_PLAN = 'cd'.repeat(32);

/**
 * A transaction context whose ledger persists across calls.
 *
 * The plan and receipt records the protocol relies on are read back in later
 * transactions — a re-init must see the stored plan, a retry the stored receipt
 * — so unlike `context()` above this one backs `getState`/`putState` with a map
 * that outlives one call. `createCompositeKey` joins its parts the way the peer
 * does, so the plan key and each receipt key stay distinct.
 */
function historyContext(
  mspId = 'Org1MSP',
  transient: Record<string, Buffer> = {},
) {
  const publicState = new Map<string, Buffer>();
  const privateState = new Map<string, Buffer>();
  const stub = {
    createCompositeKey: (objectType: string, attrs: string[]) =>
      [objectType, ...attrs].join('\x00'),
    getState: jest.fn(async (key: string) =>
      publicState.get(key) ?? Buffer.alloc(0),
    ),
    putState: jest.fn(async (key: string, value: Buffer) => {
      publicState.set(key, Buffer.from(value));
    }),
    deleteState: jest.fn(async (key: string) => {
      publicState.delete(key);
    }),
    putPrivateData: jest.fn(async (coll: string, key: string, value: Buffer) => {
      privateState.set(`${coll}\x00${key}`, Buffer.from(value));
    }),
    deletePrivateData: jest.fn(async (coll: string, key: string) => {
      privateState.delete(`${coll}\x00${key}`);
    }),
    getTransient: () => new Map<string, Buffer>(Object.entries(transient)),
  };
  return {
    stub, publicState, privateState, clientIdentity: { getMSPID: () => mspId },
  };
}

/** The keys `putState` was called with for one ledger key, in order. */
function writeCount(ctx: ReturnType<typeof historyContext>, key: string): number {
  return ctx.stub.putState.mock.calls.filter(([k]) => k === key).length;
}

describe('the shipped Node contract, initializing a plan', () => {
  it('records the plan and reads it back under the scope', async () => {
    const ctx = historyContext();
    const c = contractWithWriter('Org1MSP');

    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);

    expect(JSON.parse(await c.GetHistoryImportPlan(ctx, HISTORY_SCOPE))).toEqual({
      scope: HISTORY_SCOPE,
      protocol: 'idempotent-v1',
      planDigest: HISTORY_PLAN,
    });
  });

  it('treats a matching re-initialization as a no-op', async () => {
    // A restarted run calls it again; the same digest must not be a second
    // write, so a re-run is free to re-initialize before importing.
    const ctx = historyContext();
    const c = contractWithWriter('Org1MSP');

    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);
    const putsAfterFirst = ctx.stub.putState.mock.calls.length;
    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);

    expect(ctx.stub.putState.mock.calls.length).toBe(putsAfterFirst);
  });

  it('refuses a different plan under a scope that already has one', async () => {
    // Two plans sharing one set of receipts would mix; a new plan needs a new
    // scope. This is the refusal the client surfaces as a hard failure.
    const ctx = historyContext();
    const c = contractWithWriter('Org1MSP');

    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);

    await expect(
      c.InitializeHistoryImport(ctx, HISTORY_SCOPE, 'ef'.repeat(32)),
    ).rejects.toThrow(/different digest/);
  });

  it('refuses a plan read for a scope that has none', async () => {
    await expect(
      contractWithWriter('Org1MSP').GetHistoryImportPlan(historyContext(), HISTORY_SCOPE),
    ).rejects.toThrow(/no history import plan/);
  });

  it('refuses to import before the plan is initialized', async () => {
    // ImportHistory reads the plan into its read set first, so an import that
    // arrives before InitializeHistoryImport is refused rather than applied
    // against no plan.
    const ctx = historyContext('Org1MSP', {
      [HISTORY_ENTRY_TRANSIENT]:
        frameHistoryEnvelope(KIND_PUBLIC_WRITE, '', 'k1', Buffer.from('v1')),
    });

    await expect(
      contractWithWriter('Org1MSP').ImportHistory(
        ctx, HISTORY_SCOPE, HISTORY_PLAN, 'aa'.repeat(32), 'bb'.repeat(32),
      ),
    ).rejects.toThrow(/no history import plan/);
  });
});

describe('the shipped Node contract, importing one history record', () => {
  const OP = 'aa'.repeat(32);
  const INTENT = 'bb'.repeat(32);

  /** A context and contract with the plan already initialized. */
  async function initialized(transient: Record<string, Buffer>) {
    const ctx = historyContext('Org1MSP', transient);
    const c = contractWithWriter('Org1MSP');
    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);
    return { ctx, c };
  }

  it('applies a public write and records its intent as the receipt', async () => {
    const { ctx, c } = await initialized({
      [HISTORY_ENTRY_TRANSIENT]:
        frameHistoryEnvelope(KIND_PUBLIC_WRITE, '', 'k1', Buffer.from('v1')),
    });

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);

    expect(ctx.stub.putState).toHaveBeenCalledWith('k1', Buffer.from('v1'));
    expect(
      JSON.parse(await c.GetHistoryImportReceipt(ctx, HISTORY_SCOPE, OP)),
    ).toEqual({
      scope: HISTORY_SCOPE, operationId: OP, exists: true, intentDigest: INTENT,
    });
  });

  it('does not re-apply a record whose receipt already matches', async () => {
    // The idempotency guarantee: a submit that timed out but committed, or a
    // restart from a stale checkpoint, re-submits the same operation, which
    // must be a no-op rather than a second history version.
    const { ctx, c } = await initialized({
      [HISTORY_ENTRY_TRANSIENT]:
        frameHistoryEnvelope(KIND_PUBLIC_WRITE, '', 'k1', Buffer.from('v1')),
    });

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);
    expect(writeCount(ctx, 'k1')).toBe(1);

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);
    expect(writeCount(ctx, 'k1')).toBe(1);
  });

  it('refuses the same operation carrying a different intent', async () => {
    // A different value already imported for this operation is a divergence no
    // re-run can reconcile; the contract refuses rather than overwriting.
    const { ctx, c } = await initialized({
      [HISTORY_ENTRY_TRANSIENT]:
        frameHistoryEnvelope(KIND_PUBLIC_WRITE, '', 'k1', Buffer.from('v1')),
    });

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);

    await expect(
      c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, 'cc'.repeat(32)),
    ).rejects.toThrow(/different intent/);
    expect(writeCount(ctx, 'k1')).toBe(1);
  });

  it('applies a public delete as a tombstone', async () => {
    const { ctx, c } = await initialized({
      [HISTORY_ENTRY_TRANSIENT]:
        frameHistoryEnvelope(KIND_PUBLIC_DELETE, '', 'gone', Buffer.alloc(0)),
    });

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);

    expect(ctx.stub.deleteState).toHaveBeenCalledWith('gone');
  });

  it('carries a private collection and key only in the transient envelope', async () => {
    // A private collection name and key must never reach the public
    // transaction arguments, and the value — here not valid UTF-8 — could not
    // survive as a string argument. All three travel length-delimited in the
    // envelope.
    const collection = 'org1-private';
    const key = 'secret-key';
    const value = Buffer.from([0x80, 0x00, 0xff]);
    const envelope = frameHistoryEnvelope(
      KIND_PRIVATE_WRITE, collection, key, value,
    );
    const { ctx, c } = await initialized({
      [HISTORY_ENTRY_TRANSIENT]: envelope,
    });

    await c.ImportHistory(ctx, HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT);

    expect(ctx.stub.putPrivateData).toHaveBeenCalledWith(collection, key, value);
    // The identifiers live in the envelope, not the arguments.
    expect(envelope.includes(Buffer.from(collection, 'utf-8'))).toBe(true);
    expect(envelope.includes(Buffer.from(key, 'utf-8'))).toBe(true);
    for (const arg of [HISTORY_SCOPE, HISTORY_PLAN, OP, INTENT]) {
      expect(arg).not.toContain(collection);
      expect(arg).not.toContain(key);
    }
  });
});

describe('the shipped Node contract, importing a public history batch', () => {
  /** Frame a batch and set it as the transient the contract reads. */
  function setBatch(
    ctx: ReturnType<typeof historyContext>,
    entries: Array<{
      operationId: Buffer; intent: Buffer; key: string;
      value: Buffer; isDelete: boolean;
    }>,
  ) {
    ctx.stub.getTransient = () => new Map<string, Buffer>([
      [PUBLIC_HISTORY_BATCH_TRANSIENT, frameHistoryBatch(entries)],
    ]);
  }

  it('applies only the new entries when a batch overlaps an applied one', async () => {
    // A batch resubmitted after a partial failure holds entries that already
    // landed and entries that did not; the receipt check makes the former
    // no-ops and applies only the latter.
    const ctx = historyContext('Org1MSP');
    const c = contractWithWriter('Org1MSP');
    await c.InitializeHistoryImport(ctx, HISTORY_SCOPE, HISTORY_PLAN);

    const a = {
      operationId: Buffer.alloc(OP_ID_BYTES, 1), intent: Buffer.alloc(32, 0x11),
      key: 'kA', value: Buffer.from('a'), isDelete: false,
    };
    const b = {
      operationId: Buffer.alloc(OP_ID_BYTES, 2), intent: Buffer.alloc(32, 0x22),
      key: 'kB', value: Buffer.from('b'), isDelete: false,
    };
    setBatch(ctx, [a, b]);
    await c.ImportHistoryBatch(ctx, HISTORY_SCOPE, HISTORY_PLAN);
    expect(writeCount(ctx, 'kA')).toBe(1);
    expect(writeCount(ctx, 'kB')).toBe(1);

    const cEntry = {
      operationId: Buffer.alloc(OP_ID_BYTES, 3), intent: Buffer.alloc(32, 0x33),
      key: 'kC', value: Buffer.from('c'), isDelete: false,
    };
    setBatch(ctx, [a, cEntry]);
    await c.ImportHistoryBatch(ctx, HISTORY_SCOPE, HISTORY_PLAN);
    expect(writeCount(ctx, 'kA')).toBe(1); // already applied, a no-op
    expect(writeCount(ctx, 'kC')).toBe(1); // new, applied
  });
});

describe('the shipped Node contract, describing the protocol', () => {
  it('answers HistoryImportProtocol with the descriptor the client probes', async () => {
    // The pre-flight probe (src/replay/history-import/preflight.ts) refuses a
    // destination whose descriptor does not name this exact protocol version.
    expect(
      JSON.parse(
        await contractWithWriter('Org1MSP').HistoryImportProtocol(historyContext()),
      ),
    ).toEqual({
      protocol: 'idempotent-v1',
      digestBytes: OP_ID_BYTES,
      planObjectType: 'fabric-amb-extractor-history-plan-v1',
      receiptObjectType: 'fabric-amb-extractor-history-receipt-v1',
      entryTransient: HISTORY_ENTRY_TRANSIENT,
      batchTransient: PUBLIC_HISTORY_BATCH_TRANSIENT,
      maxBatchBytes: MAX_BATCH_BYTES,
    });
  });

  it('reports an absent receipt as exists:false with no intent', async () => {
    // Reconciliation reads this as "no readable receipt" and preserves the
    // original failure, so exists:false must carry no intentDigest.
    const receipt = JSON.parse(
      await contractWithWriter('Org1MSP').GetHistoryImportReceipt(
        historyContext(), HISTORY_SCOPE, 'aa'.repeat(32),
      ),
    );

    expect(receipt).toEqual({
      scope: HISTORY_SCOPE, operationId: 'aa'.repeat(32), exists: false,
    });
    expect(receipt.intentDigest).toBeUndefined();
  });
});
