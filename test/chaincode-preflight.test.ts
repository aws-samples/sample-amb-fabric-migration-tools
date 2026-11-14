import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Network } from '@hyperledger/fabric-gateway';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  ContractProbe,
  DeploymentBlocker,
  DeploymentTarget,
  formatDeploymentRefusal,
  listDeployments,
  migrationContractProbe,
  preflightDeployments,
  readDestinationDefinitions,
} from '../src/replay/chaincode-preflight';
import { PrivateWriteTarget } from '../src/replay/collection-preflight';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { ChaincodeInfo, ExtractionRecord, ReplayConfig } from '../src/types';
import { ReplayCheckpointManager } from '../src/replay/replay-checkpoint-manager';

// ─── Mocks ───
//
// For the whole-run block at the bottom. A refusal has to land before the first
// write, so what these record is every key that reached the orderer and every
// probe that reached a contract.

/** Ledger keys that reached the destination, in submission order. */
const writes: string[] = [];

/** `destChannel/chaincode` each probe asked about, in order. */
const probes: string[] = [];

/** Set false to make the destination's migration contract not answer. */
let contractAnswers = true;

/** Keys the destination's ListKeys reports, per test. */
let listedKeys: string[] = [];

/** Set to make every private probe endorsement fail with this error. */
let endorseRefusal: Error | undefined;

/** Proposals endorsed, as `function:key`, whether or not they were submitted. */
const endorsed: string[] = [];

/** A commit status the peer would report for a transaction that validated. */
const COMMITTED = {
  successful: true,
  code: 0,
  blockNumber: 1n,
  transactionId: 'tx-committed',
};

jest.mock('../src/connection/fabric-gateway', () => ({
  FabricGateway: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    getGatewayNetwork: jest.fn((channel: string) => ({
      getContract: jest.fn((chaincode: string) => ({
        evaluateTransaction: jest.fn(async (fn: string) => {
          if (chaincode === 'qscc' && fn === 'GetBlockByNumber') {
            return Buffer.from(`genesis-of-${channel}`);
          }
          probes.push(`${channel}/${chaincode}`);
          if (!contractAnswers) throw new Error('no such function ListKeys');
          return Buffer.from(JSON.stringify({ keys: listedKeys, bookmark: '' }), 'utf-8');
        }),
        newProposal: jest.fn((fn: string, opts: { arguments: string[] }) => ({
          endorse: async () => {
            endorsed.push(`${fn}:${opts.arguments[opts.arguments.length - 1]}`);
            if (endorseRefusal && fn === 'ImportPrivateData') throw endorseRefusal;
            return {
            submit: async () => {
              writes.push(opts.arguments[opts.arguments.length - 1]);
              return { getStatus: async () => COMMITTED };
            },
            };
          },
        })),
      })),
    })),
    disconnect: jest.fn(),
  })),
}));

/** What the destination channel reports committed, per test. */
let destinationChaincodes: ChaincodeInfo[] = [];

jest.mock('../src/discovery/chaincode-discoverer', () => ({
  ChaincodeDiscoverer: jest.fn().mockImplementation(() => ({
    queryCommitted: jest.fn(async () => destinationChaincodes),
  })),
}));

const warnings: string[] = [];

jest.mock('../src/utils/logger', () => {
  const noop = (): void => {};
  const warn = (ctx: unknown, message?: string): void => {
    warnings.push(message ?? String(ctx));
  };
  const make = () => ({
    warn, info: noop, debug: noop, error: noop, trace: noop, fatal: noop,
  });
  return { createLogger: make, setLogLevel: noop, logger: make() };
});

import { ReplayOrchestrator } from '../src/replay/replay-orchestrator';

// ─── Fixtures ───

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

/** The credentials every config carries, none of which this row is about. */
function config(overrides: Partial<ChaincodeConfig> = {}): ChaincodeConfig {
  return {
    connectionProfilePath: 'profile.json',
    mspId: 'Org1MSP',
    certPath: 'cert.pem',
    keyPath: 'key.pem',
    ...overrides,
  };
}

function committed(name: string): ChaincodeInfo {
  return { name, version: '1.0', sequence: 1, collections: [] };
}

/** A deployment carrying public data only, on the one mapped channel pair. */
function deployment(
  overrides: Partial<DeploymentTarget> = {},
): DeploymentTarget {
  return {
    channel: 'ch1',
    destChannel: 'dest1',
    chaincode: 'mycc',
    hasPrivateData: false,
    ...overrides,
  };
}

/** Definitions read from the one destination channel these tests name. */
function definitionsOf(...defs: ChaincodeInfo[]): Map<string, ChaincodeInfo[]> {
  return new Map([['dest1', defs]]);
}

/** A probe that answers, recording what it was asked about. */
function answeringProbe(): jest.Mock<Promise<string | null>, [string, string]> {
  return jest.fn(async (_destChannel: string, _chaincode: string) => null);
}

/** A page of keys, as the migration contract's `ListKeys` returns one. */
function keyPage(keys: string[] = [], bookmark = ''): Uint8Array {
  return Buffer.from(JSON.stringify({ keys, bookmark }), 'utf-8');
}

// ─── Reading what the destination has committed ───

describe('readDestinationDefinitions', () => {
  it('reports what each destination channel has committed', async () => {
    const result = await readDestinationDefinitions(
      ['dest1'], async () => [committed('mycc')],
    );

    expect(result.byChannel.get('dest1')).toEqual([committed('mycc')]);
    expect(result.unchecked).toEqual([]);
  });

  /**
   * Both halves of the pre-flight ask about these definitions, and a lifecycle
   * query is a round trip to the peer — so two source channels mapped onto one
   * destination must not pay for it twice.
   */
  it('reads each destination channel once, however many sources map onto it', async () => {
    const lookup = jest.fn(async () => [committed('mycc')]);

    await readDestinationDefinitions(['dest1', 'dest1'], lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  /**
   * Left out rather than recorded empty. A query the client cannot make says
   * nothing about what is committed, and reading it as "nothing" would refuse
   * every chaincode in the run.
   */
  it('leaves a channel that would not answer out of the map', async () => {
    const result = await readDestinationDefinitions(['dest1'], async () => {
      throw new Error('UNIMPLEMENTED');
    });

    expect(result.byChannel.has('dest1')).toBe(false);
    expect(result.unchecked).toHaveLength(1);
    expect(result.unchecked[0]).toContain('dest1');
    expect(result.unchecked[0]).toContain('UNIMPLEMENTED');
  });

  it('keeps reading the other channels after one fails', async () => {
    const result = await readDestinationDefinitions(
      ['dest1', 'dest2'],
      async (destChannel) => {
        if (destChannel === 'dest1') throw new Error('UNIMPLEMENTED');
        return [committed('mycc')];
      },
    );

    expect(result.byChannel.get('dest2')).toEqual([committed('mycc')]);
    expect(result.unchecked).toHaveLength(1);
  });
});

// ─── Listing what the run will write into ───

describe('listDeployments', () => {
  let root: string;
  let layout: FileLayoutManager;
  let reader: NdjsonReader;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployments-test-'));
    layout = new FileLayoutManager(root);
    reader = new NdjsonReader();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeRecords(relPath: string, records: ExtractionRecord[]): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8',
    );
  }

  function publicState(chaincode: string, key = 'k1'): ExtractionRecord {
    return {
      _type: 'public_state', channel: 'ch1', chaincode, key, value: 'v1',
    };
  }

  /** A private target, as `listPrivateWriteTargets` reports one. */
  function privateTarget(
    chaincode: string,
    channel = 'ch1',
  ): PrivateWriteTarget {
    return {
      channel,
      destChannel: 'dest1',
      chaincode,
      collection: 'col1',
      destCollection: 'col1',
    };
  }

  const pairs = [{ channel: 'ch1', destChannel: 'dest1' }];

  function deployments(
    replayHistory = false,
    privateTargets: PrivateWriteTarget[] = [],
  ): Promise<DeploymentTarget[]> {
    return listDeployments(
      reader, layout, pairs, replayHistory, privateTargets,
    );
  }

  it('names every chaincode the public records name', async () => {
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('trades'), publicState('assets'),
    ]);

    const found = await deployments();

    expect(found.map((d) => d.chaincode)).toEqual(['assets', 'trades']);
  });

  it('names a chaincode once, however many records it holds', async () => {
    writeRecords(layout.publicStatePath('ch1'), [
      publicState('mycc', 'k1'), publicState('mycc', 'k2'),
    ]);

    const found = await deployments();

    expect(found).toEqual([deployment()]);
  });

  /**
   * A chaincode whose public file is empty still has private data to write, and
   * a private write goes to the migration contract like any other — so leaving
   * it out would skip the only check its records get.
   */
  it('names a chaincode that has private data and no public records', async () => {
    writeRecords(layout.publicStatePath('ch1'), []);

    const found = await deployments(false, [privateTarget('vault')]);

    expect(found).toEqual([
      deployment({ chaincode: 'vault', hasPrivateData: true }),
    ]);
  });

  /**
   * The flag decides whether the migration contract has to answer for a
   * deployment whose public writes are mapped to an application contract, so a
   * chaincode with data on both paths has to carry it.
   */
  it('marks a chaincode that has both public and private data', async () => {
    writeRecords(layout.publicStatePath('ch1'), [publicState('mycc')]);

    const found = await deployments(false, [privateTarget('mycc')]);

    expect(found).toEqual([deployment({ hasPrivateData: true })]);
  });

  /**
   * A collection on one channel says nothing about the same chaincode on
   * another. Attributing it to both would demand the migration contract on a
   * deployment whose every write is mapped away from it.
   */
  it('attributes private data to the channel it came from', async () => {
    writeRecords(layout.publicStatePath('ch1'), [publicState('mycc')]);
    writeRecords(layout.publicStatePath('ch2'), [publicState('mycc')]);

    const found = await listDeployments(
      reader,
      layout,
      [
        { channel: 'ch1', destChannel: 'dest1' },
        { channel: 'ch2', destChannel: 'dest2' },
      ],
      false,
      [privateTarget('mycc', 'ch2')],
    );

    expect(found.map((d) => [d.channel, d.hasPrivateData])).toEqual([
      ['ch1', false], ['ch2', true],
    ]);
  });

  it('reads the history file when history is what will be replayed', async () => {
    writeRecords(layout.publicStatePath('ch1'), [publicState('state-only')]);
    writeRecords(layout.publicHistoryPath('ch1'), [{
      _type: 'public_history', channel: 'ch1', chaincode: 'history-only',
      key: 'k1', value: 'v1', txId: 'tx1', txIndex: 0, blockNumber: 1,
      timestamp: '2026-01-01T00:00:00Z', isDelete: false,
      creator: {
        mspId: 'Org1MSP', commonName: 'admin', org: 'org1',
        certFingerprint: 'fp1',
      },
    }]);

    const found = await deployments(true);

    expect(found.map((d) => d.chaincode)).toEqual(['history-only']);
  });

  it('carries each source channel its own destination', async () => {
    writeRecords(layout.publicStatePath('ch1'), [publicState('mycc')]);
    writeRecords(layout.publicStatePath('ch2'), [publicState('mycc')]);

    const found = await listDeployments(
      reader,
      layout,
      [
        { channel: 'ch1', destChannel: 'dest1' },
        { channel: 'ch2', destChannel: 'dest2' },
      ],
      false,
      [],
    );

    expect(found.map((d) => d.destChannel)).toEqual(['dest1', 'dest2']);
  });

  /**
   * A channel whose files carry nothing writes nothing, so it has no deployment
   * to check — refusing over a destination it never touches would block a
   * migration that had nothing to fail at.
   */
  it('yields nothing for a channel with no records at all', async () => {
    writeRecords(layout.publicStatePath('ch1'), []);

    await expect(deployments()).resolves.toEqual([]);
  });
});

// ─── Refusing a destination that cannot take the writes ───

describe('preflightDeployments', () => {
  it('accepts a chaincode the destination has committed and answers for', async () => {
    const probe = answeringProbe();

    const result = await preflightDeployments(
      [deployment()], config(), definitionsOf(committed('mycc')), probe,
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
    expect(probe).toHaveBeenCalledWith('dest1', 'mycc');
  });

  /**
   * The defect this closes. A chaincode name is its state namespace on both
   * networks and nothing here renames one, so a destination that never committed
   * it fails on every record with a peer-side error naming no cause.
   */
  it('refuses a chaincode the destination channel has not committed', async () => {
    const result = await preflightDeployments(
      [deployment({ chaincode: 'assets' })],
      config(),
      definitionsOf(committed('mycc')),
      answeringProbe(),
    );

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].kind).toBe('chaincode-missing');
    expect(result.blockers[0].detail).toContain('no chaincode named assets');
    expect(result.blockers[0].detail).toContain('dest1');
    expect(result.blockers[0].detail).toContain('it has 1: mycc');
  });

  it('says so when the destination channel has nothing committed at all', async () => {
    const result = await preflightDeployments(
      [deployment()], config(), definitionsOf(), answeringProbe(),
    );

    expect(result.blockers[0].detail).toContain('it has 0: none');
  });

  it('does not probe a chaincode that is not there', async () => {
    const probe = answeringProbe();

    await preflightDeployments(
      [deployment({ chaincode: 'assets' })],
      config(),
      definitionsOf(committed('mycc')),
      probe,
    );

    expect(probe).not.toHaveBeenCalled();
  });

  /**
   * A contract that will not answer over the connection the writes will use will
   * not take a write either, so this is a refusal and not a note.
   */
  it('refuses a chaincode whose migration contract did not answer', async () => {
    const result = await preflightDeployments(
      [deployment()],
      config(),
      definitionsOf(committed('mycc')),
      async () => 'no such function ListKeys',
    );

    expect(result.blockers[0].kind).toBe('contract-unanswered');
    expect(result.blockers[0].detail).toContain('mycc is committed on dest1');
    expect(result.blockers[0].detail).toContain('MigrationContract');
    expect(result.blockers[0].detail).toContain('no such function ListKeys');
    expect(result.checked).toBe(0);
  });

  it('names the contract the config asked for in that refusal', async () => {
    const result = await preflightDeployments(
      [deployment()],
      config({ migrationContract: 'MyMigrator' }),
      definitionsOf(committed('mycc')),
      async () => 'nope',
    );

    expect(result.blockers[0].detail).toContain('MyMigrator did not answer');
  });

  /**
   * The lifecycle query and the probe establish different things. A destination
   * whose `_lifecycle` the client cannot read may still hold a chaincode that
   * answers, and that is worth finding out.
   */
  it('probes a chaincode whose destination channel would not answer', async () => {
    const probe = answeringProbe();

    const result = await preflightDeployments(
      [deployment()], config(), new Map(), probe,
    );

    expect(probe).toHaveBeenCalledWith('dest1', 'mycc');
    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('reports every blocker, not the first', async () => {
    const result = await preflightDeployments(
      [
        deployment({ chaincode: 'a' }),
        deployment({ chaincode: 'b' }),
        deployment({ chaincode: 'c' }),
      ],
      config(),
      definitionsOf(committed('b')),
      async () => 'unanswered',
    );

    expect(result.blockers.map((b) => [b.chaincode, b.kind])).toEqual([
      ['a', 'chaincode-missing'],
      ['b', 'contract-unanswered'],
      ['c', 'chaincode-missing'],
    ]);
  });

  /**
   * Two source channels mapped onto one destination reach one chaincode, and
   * asking it twice is a wasted round trip — but each source channel is still
   * reported, because the channel is what an operator has to act on.
   */
  it('probes a chaincode reached from two source channels once', async () => {
    const probe = jest.fn(async () => 'unanswered');

    const result = await preflightDeployments(
      [deployment(), deployment({ channel: 'ch2' })],
      config(),
      definitionsOf(committed('mycc')),
      probe,
    );

    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.blockers.map((b) => b.channel)).toEqual(['ch1', 'ch2']);
  });

  /**
   * One name, two namespaces. A chaincode of the same name on two destination
   * channels is two deployments, and one of them answering says nothing about
   * the other.
   */
  it('probes the same chaincode name on two destinations separately', async () => {
    const probe = jest.fn(
      async (destChannel: string) => (destChannel === 'dest2' ? 'nope' : null),
    );

    const result = await preflightDeployments(
      [deployment(), deployment({ channel: 'ch2', destChannel: 'dest2' })],
      config(),
      new Map([
        ['dest1', [committed('mycc')]],
        ['dest2', [committed('mycc')]],
      ]),
      probe,
    );

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.blockers.map((b) => b.destChannel)).toEqual(['dest2']);
    expect(result.checked).toBe(1);
  });
});

// ─── Which deployments have to answer at all ───
//
// A `keyMapping` naming an application contract says that contract owns the
// write, which row 2.8 made a supported pattern. The migration contract need not
// be registered for a deployment whose every call goes elsewhere, and nothing
// here knows a function to call on a contract it does not define — so such a
// deployment is reported unchecked rather than refused.

describe('preflightDeployments — contract ownership', () => {
  async function probed(
    ccConfig: ChaincodeConfig,
    target = deployment(),
  ): Promise<{ probe: jest.Mock; unchecked: string[] }> {
    const probe = answeringProbe();
    const result = await preflightDeployments(
      [target], ccConfig, definitionsOf(committed('mycc')), probe,
    );
    return { probe, unchecked: result.unchecked };
  }

  it('probes a deployment with no keyMapping entry', async () => {
    const { probe } = await probed(config());

    expect(probe).toHaveBeenCalled();
  });

  it('probes a deployment mapped to the migration contract by name', async () => {
    const { probe } = await probed(config({
      keyMapping: { ch1: { mycc: 'MigrationContract:ImportOrder' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  it('probes a deployment whose mapping names a bare function', async () => {
    const { probe } = await probed(config({
      keyMapping: { ch1: { mycc: 'ImportOrder' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  it('probes a deployment mapped to the contract the config renamed', async () => {
    const { probe } = await probed(config({
      migrationContract: 'MyMigrator',
      keyMapping: { ch1: { mycc: 'MyMigrator:ImportOrder' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  it('leaves a deployment mapped entirely to an application contract unprobed', async () => {
    const { probe, unchecked } = await probed(config({
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
    }));

    expect(probe).not.toHaveBeenCalled();
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toContain('ch1/mycc');
    expect(unchecked[0]).toContain('MigrationContract');
  });

  /**
   * A mapping under another channel covers no record on this one, so it leaves
   * the write on the migration contract after all — which then has to answer.
   */
  it('probes a deployment whose mapping is under another channel', async () => {
    const { probe } = await probed(config({
      keyMapping: { 'other-ch': { mycc: 'SampleAssets:StoreAsset' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  /**
   * With history in scope the tombstone is a second call, and with no
   * `deleteMapping` entry it goes to the migration contract's `DeleteState` —
   * so the contract has to answer even though the write does not use it.
   */
  it('probes a mapped deployment whose deletes are not mapped', async () => {
    const { probe } = await probed(config({
      replayHistory: true,
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  it('leaves a deployment with both calls mapped away unprobed', async () => {
    const { probe } = await probed(config({
      replayHistory: true,
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
      deleteMapping: { ch1: { mycc: 'SampleAssets:RemoveAsset' } },
    }));

    expect(probe).not.toHaveBeenCalled();
  });

  it('probes a deployment whose delete is mapped to the migration contract', async () => {
    const { probe } = await probed(config({
      replayHistory: true,
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
      deleteMapping: { ch1: { mycc: 'DeleteState' } },
    }));

    expect(probe).toHaveBeenCalled();
  });

  /**
   * A private write carries its value as transient data under the migration
   * contract's own wire convention, so there is no function to point elsewhere —
   * the contract has to answer however the public writes are mapped.
   */
  it('probes a deployment with private data whatever the mapping says', async () => {
    const { probe } = await probed(
      config({
        replayHistory: true,
        keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
        deleteMapping: { ch1: { mycc: 'SampleAssets:RemoveAsset' } },
      }),
      deployment({ hasPrivateData: true }),
    );

    expect(probe).toHaveBeenCalled();
  });
});

// ─── Asking the contract to answer ───

describe('migrationContractProbe', () => {
  /** A network whose contract answers `answer`, recording how it was asked. */
  function networkAnswering(answer: Uint8Array | Error) {
    const evaluateTransaction = jest.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const getContract = jest.fn(() => ({ evaluateTransaction }));
    const networkFor = jest.fn(() => ({ getContract } as unknown as Network));
    return { networkFor, getContract, evaluateTransaction };
  }

  function probeWith(answer: Uint8Array | Error): {
    probe: ContractProbe;
    mocks: ReturnType<typeof networkAnswering>;
  } {
    const mocks = networkAnswering(answer);
    return {
      probe: migrationContractProbe(mocks.networkFor, 'MigrationContract'),
      mocks,
    };
  }

  it('answers null when the contract returns a page of keys', async () => {
    const { probe } = probeWith(keyPage(['a2V5MQ=='], 'bm90ZQ=='));

    await expect(probe('dest1', 'mycc')).resolves.toBeNull();
  });

  /**
   * An empty namespace is the normal case: a destination is migrated into
   * because it holds nothing yet, and `ListKeys` is the one read that still
   * answers there.
   */
  it('accepts an empty page from a namespace holding nothing', async () => {
    const { probe } = probeWith(keyPage());

    await expect(probe('dest1', 'mycc')).resolves.toBeNull();
  });

  /**
   * What makes a failure grounds to refuse: the same channel, chaincode and
   * contract the first record would reach, over the same connection.
   */
  it('asks the destination channel about the chaincode by name', async () => {
    const { probe, mocks } = probeWith(keyPage());

    await probe('dest1', 'mycc');

    expect(mocks.networkFor).toHaveBeenCalledWith('dest1');
    expect(mocks.getContract).toHaveBeenCalledWith('mycc', 'MigrationContract');
    expect(mocks.evaluateTransaction).toHaveBeenCalledWith('ListKeys', '1', '');
  });

  it('reports what a contract that is not there threw', async () => {
    const { probe } = probeWith(new Error('could not find chaincode mycc'));

    await expect(probe('dest1', 'mycc'))
      .resolves.toBe('could not find chaincode mycc');
  });

  /**
   * The answer is read, not just awaited: a contract registered under this name
   * that answers with something else is not the migration contract, and every
   * write is going to that same name.
   */
  it('rejects an answer that is not JSON', async () => {
    const { probe } = probeWith(Buffer.from('Unknown function', 'utf-8'));

    await expect(probe('dest1', 'mycc'))
      .resolves.toBe('it answered Unknown function, which is not JSON');
  });

  it.each([
    ['no keys at all', '{"bookmark":""}'],
    ['keys that are not a list', '{"keys":"k1","bookmark":""}'],
    ['no bookmark to page with', '{"keys":[]}'],
    ['a bookmark that is not a string', '{"keys":[],"bookmark":7}'],
    ['a page that is not an object', '["k1"]'],
    ['nothing at all', 'null'],
  ])('rejects JSON with %s', async (_case, body) => {
    const { probe } = probeWith(Buffer.from(body, 'utf-8'));

    await expect(probe('dest1', 'mycc'))
      .resolves.toBe(`it answered ${body}, not a page of keys`);
  });

  /**
   * A chaincode is free to answer with a megabyte, and this ends up in a refusal
   * an operator has to read.
   */
  it('truncates a long answer rather than quoting all of it', async () => {
    const { probe } = probeWith(Buffer.from('x'.repeat(5000), 'utf-8'));

    const failure = await probe('dest1', 'mycc');

    expect(failure).toBe(`it answered ${'x'.repeat(200)}, which is not JSON`);
  });
});

// ─── Explaining the refusal ───

describe('formatDeploymentRefusal', () => {
  function blocker(
    overrides: Partial<DeploymentBlocker> = {},
  ): DeploymentBlocker {
    return {
      ...deployment(overrides),
      kind: 'chaincode-missing',
      detail: 'no chaincode named mycc is committed on dest1',
      ...overrides,
    };
  }

  it('names every chaincode and what is wrong with it', () => {
    const message = formatDeploymentRefusal([
      blocker({ chaincode: 'assets', detail: 'first detail' }),
      blocker({ chaincode: 'trades', detail: 'second detail' }),
    ]);

    expect(message).toContain('2 destination chaincode(s)');
    expect(message).toContain('ch1/assets: first detail');
    expect(message).toContain('ch1/trades: second detail');
  });

  /**
   * Each remedy is a different job — committing a chaincode, registering a
   * contract on one already committed — so a run that hit one must not be told to
   * do both. Each kind is checked alone, since a remedy printed unconditionally
   * is only visible in the runs that did not call for it.
   */
  it.each([
    ['chaincode-missing', 'under the same name the source used'],
    ['contract-unanswered', 'register the contract beside'],
  ] as const)('gives only the %s remedy for that blocker', (kind, remedy) => {
    const others = ['under the same name the source used',
      'register the contract beside'].filter((r) => r !== remedy);

    const message = formatDeploymentRefusal([blocker({ kind })]);

    expect(message).toContain(remedy);
    for (const other of others) expect(message).not.toContain(other);
  });

  it('gives every remedy a mixed set of blockers calls for', () => {
    const message = formatDeploymentRefusal([
      blocker({ kind: 'chaincode-missing' }),
      blocker({ kind: 'contract-unanswered' }),
    ]);

    expect(message).toContain('under the same name the source used');
    expect(message).toContain('register the contract beside');
  });

  /**
   * A chaincode the destination does not have has a second way out: the source
   * channel it came from may be the wrong one to be replaying.
   */
  it('offers both ways out of a chaincode that is not committed', () => {
    const message = formatDeploymentRefusal([blocker()]);

    expect(message).toContain('under the same name the source used');
    expect(message).toContain('chaincode.channelMapping');
  });

  /**
   * Mapping the writes elsewhere is a way out only for a deployment with no
   * private data, since a private write has no configurable function — an
   * operator sent down that road for one would find no entry to write.
   */
  it('says a mapped-away write is no answer for private data', () => {
    const message = formatDeploymentRefusal([
      blocker({ kind: 'contract-unanswered' }),
    ]);

    expect(message).toContain('chaincode.keyMapping');
    expect(message).toContain('no private data');
  });
});

// ─── Through a whole replay run ───

describe('chaincode replay — destination pre-flight', () => {
  let tmpDir: string;
  let layout: FileLayoutManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-run-test-'));
    layout = new FileLayoutManager(tmpDir);
    writes.length = 0;
    probes.length = 0;
    warnings.length = 0;
    contractAnswers = true;
    listedKeys = [];
    endorseRefusal = undefined;
    endorsed.length = 0;
    destinationChaincodes = [committed('mycc')];
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(): void {
    fs.writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        networkId: 'nd-TEST',
        memberId: 'm-TEST',
        region: 'us-east-1',
        stateDb: 'CouchDB',
        extractedAt: '2026-01-01T00:00:00.000Z',
        channels: [{ channelId: 'ch1', chaincodes: [], ledgerHeight: 1 }],
      }),
      'utf-8',
    );
  }

  function writeRecords(relPath: string, records: ExtractionRecord[]): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(
      full, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8',
    );
  }

  /** A run carrying one public key in `mycc`, and no private data. */
  function setupPublic(): void {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), [{
      _type: 'public_state', channel: 'ch1', chaincode: 'mycc',
      key: 'k1', value: 'v1',
    }]);
  }

  /** A run carrying one private key in `vault`, and no public data. */
  function setupPrivate(): void {
    writeManifest();
    writeRecords(layout.publicStatePath('ch1'), []);
    writeRecords(layout.privateStatePath('ch1', 'vault', 'col1'), [{
      _type: 'private_state', channel: 'ch1', chaincode: 'vault',
      collection: 'col1', key: 'pk1', value: 'pv1',
    }]);
  }

  function run(overrides: Partial<ChaincodeConfig> = {}): Promise<any> {
    return new ReplayOrchestrator({
      adapter: 'chaincode',
      inputDir: tmpDir,
      chaincode: config({ channelMapping: { ch1: 'dest1' }, ...overrides }),
    }).run();
  }

  it('replays public data once the destination has the chaincode', async () => {
    setupPublic();

    const summary = await run();

    expect(summary.totalReplayed).toBe(1);
    expect(writes).toEqual(['k1']);
  });

  /**
   * F7, end to end: a public-only run is refused over a chaincode name the
   * destination does not have. Nothing about this needs private data, which is
   * why the check is not part of the private pre-flight.
   */
  it('refuses a public-only run whose chaincode is not committed', async () => {
    setupPublic();
    destinationChaincodes = [];

    await expect(run()).rejects.toThrow(
      /no chaincode named mycc is committed on dest1/,
    );
  });

  it('writes nothing to the destination when it refuses', async () => {
    setupPublic();
    destinationChaincodes = [];

    await expect(run()).rejects.toThrow();

    expect(writes).toEqual([]);
  });

  /**
   * A chaincode carrying only private data is in scope too. Its public file is
   * empty, so the records name it nowhere — but the value still goes to the
   * destination's migration contract, which needs the chaincode to be there.
   */
  it('refuses a private-only run whose chaincode is not committed', async () => {
    setupPrivate();
    destinationChaincodes = [];

    await expect(run()).rejects.toThrow(
      /no chaincode named vault is committed on dest1/,
    );
  });

  /**
   * The endorsement probe: one endorsed, never-submitted write per collection,
   * before the first real one. A refusal it gets stops the run with nothing
   * written — measured live, an AND chaincode policy over a collection with
   * fewer members than the policy needs is refused by the gateway this way.
   */
  it('probes each private collection with an endorsement it never submits', async () => {
    setupPrivate();
    destinationChaincodes = [{ ...committed('vault'), collections: [{
      name: 'col1', policy: "OR('Org1MSP.member')", requiredPeerCount: 0,
      maxPeerCount: 1, blockToLive: 0, memberOnlyRead: true, memberOnlyWrite: true,
    }] }];

    await run();

    expect(endorsed[0]).toBe('ImportPrivateData:fabric-amb-extractor-preflight');
    expect(writes).toEqual(['pk1']);
  });

  it('refuses the run, writing nothing, when the probe endorsement is refused', async () => {
    setupPrivate();
    destinationChaincodes = [{ ...committed('vault'), collections: [{
      name: 'col1', policy: "OR('Org1MSP.member')", requiredPeerCount: 0,
      maxPeerCount: 1, blockToLive: 0, memberOnlyRead: true, memberOnlyWrite: true,
    }] }];
    endorseRefusal = Object.assign(new Error(
      '9 FAILED_PRECONDITION: requires endorsement from organisation(s) that are ' +
      'not in the distribution policy of the private data collection(s): [col1]',
    ), { code: 9 });

    await expect(run()).rejects.toThrow(
      /refused a probe endorsement[\s\S]*ch1\/vault\/col1 on dest1[\s\S]*own endorsementPolicy/,
    );
    expect(writes).toEqual([]);
  });

  /** A run carrying one public history record in `mycc`. */
  function setupHistory(): void {
    writeManifest();
    writeRecords(layout.publicHistoryPath('ch1'), [{
      _type: 'public_history', channel: 'ch1', chaincode: 'mycc', key: 'k1',
      value: 'v1', txId: 'tx1', blockNumber: 1, txIndex: 0,
      timestamp: '2026-01-01T00:00:00.000Z', isDelete: false,
    } as ExtractionRecord]);
  }

  /**
   * A legacy history replay is one-shot: over a destination already holding
   * keys it appends a second history for every key, which nothing removes.
   */
  it('refuses a fresh history replay into a namespace that holds keys', async () => {
    setupHistory();
    listedKeys = ['k1'];

    await expect(run({ replayHistory: true })).rejects.toThrow(
      /already hold keys[\s\S]*ch1\/mycc on dest1[\s\S]*historyImport/,
    );
    expect(writes).toEqual([]);
  });

  it('replays history into an empty namespace', async () => {
    setupHistory();

    const summary = await run({ replayHistory: true });

    expect(summary.totalReplayed).toBe(1);
  });

  /** Current state overwrites; a non-empty destination is not refused for it. */
  it('does not refuse a current-state replay into a non-empty namespace', async () => {
    setupPublic();
    listedKeys = ['k-old'];

    await expect(run()).resolves.toMatchObject({ totalReplayed: 1 });
  });

  /** A resumed run expects its own earlier writes to be there. */
  it('does not refuse a history replay resuming from a checkpoint', async () => {
    setupHistory();
    listedKeys = ['k1'];
    const cp = new ReplayCheckpointManager(tmpDir, 'chaincode');
    cp.update('ch1/public-history', 0, ['ch1/public-history']);

    // The fixture's checkpoint names a file set the run then disagrees with,
    // which a later check refuses; what matters is that this one did not.
    const outcome = await run({ replayHistory: true }).catch((e: Error) => e);
    expect(String(outcome)).not.toMatch(/already hold keys/);
  });

  /**
   * The config is bound to one ledger. A destination rebuilt at the same
   * address — or a profile repointed at production — has a different genesis
   * block, and nothing is written.
   */
  it('refuses a destination whose genesis block is not the configured one', async () => {
    setupPublic();

    await expect(run({ destinationFingerprint: { dest1: 'aa'.repeat(32) } }))
      .rejects.toThrow(/not the network this config was made for[\s\S]*dest1: genesis block is/);
    expect(writes).toEqual([]);
    expect(probes).toEqual([]);
  });

  it('replays into the destination the fingerprint names', async () => {
    setupPublic();
    const hash = require('crypto').createHash('sha256').update('genesis-of-dest1').digest('hex');

    await expect(run({ destinationFingerprint: { dest1: hash } }))
      .resolves.toMatchObject({ totalReplayed: 1 });
  });

  it('refuses a run whose migration contract does not answer', async () => {
    setupPublic();
    contractAnswers = false;

    await expect(run()).rejects.toThrow(
      /MigrationContract did not answer ListKeys there/,
    );
    expect(writes).toEqual([]);
  });

  /**
   * The probe has to reach what the writes will reach, which is the destination
   * channel — probing the source channel would ask a network this run never
   * writes to, and pass whatever it answered off as the destination's.
   */
  it('probes the destination channel, not the source', async () => {
    setupPublic();

    await run();

    expect(probes).toEqual(['dest1/mycc']);
  });

  /**
   * Row 2.8 made an application contract a supported destination for the writes,
   * so a deployment mapped entirely onto one is not refused for a migration
   * contract it has no reason to register.
   */
  it('proceeds when every write is mapped to another contract', async () => {
    setupPublic();
    contractAnswers = false;

    const summary = await run({
      keyMapping: { ch1: { mycc: 'SampleAssets:StoreAsset' } },
    });

    expect(summary.totalReplayed).toBe(1);
    expect(probes).toEqual([]);
    expect(warnings.join('\n')).toContain('ch1/mycc: every write is mapped');
  });
});
