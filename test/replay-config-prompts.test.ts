import { Interface } from 'readline/promises';
import { promptReplayConfig } from '../src/cli/replay-config-prompts';
import { Manifest } from '../src/types';
import { assertCollectionRouting } from '../src/replay/collection-routing';
import {
  expandCollectionMapping,
  withOrgRouting,
} from '../src/replay/org-routing';

// ── Fixtures ──

/**
 * A readline stand-in that answers questions from a script.
 *
 * The wizard's only use of `Interface` is `question()`, and its questions are
 * asked in a fixed order, so a queue of answers is the whole seam. An empty
 * string takes the default the wizard offers, exactly as pressing Enter does.
 */
function scriptedInterface(answers: string[]): {
  rl: Interface;
  asked: string[];
} {
  const asked: string[] = [];
  const queue = [...answers];
  const rl = {
    question: async (prompt: string): Promise<string> => {
      asked.push(prompt.trim().replace(/:$/, ''));
      if (queue.length === 0) {
        throw new Error(`No scripted answer for: ${prompt.trim()}`);
      }
      return queue.shift() as string;
    },
  };
  return { rl: rl as unknown as Interface, asked };
}

/** Answers up to the chaincode function maps, which every test scripts itself. */
const UP_TO_KEY_MAPPING = [
  '3',                // adapter: chaincode
  'profile.json',     // connection profile
  'Org1MSP',          // MSP ID
  'cert.pem',         // certificate
  'key.pem',          // private key
  '',                 // accept the default channel mapping
  '',                 // accept the default concurrency
];

/**
 * Two channels deploying one chaincode name, with a collection on only one, and
 * a second chaincode beside it on one of them.
 *
 * The shape row 2.8 exists for: `marketplace` on `trades-ch` is a different
 * deployment from `marketplace` on `orders-ch`, only the latter has private data
 * to verify, and `orders-ch` needs both of its chaincodes under one channel key.
 */
function manifest(): Manifest {
  const chaincode = (name: string, collections: string[]) => ({
    name,
    version: '1.0',
    sequence: 1,
    collections: collections.map((collectionName) => ({
      name: collectionName,
      policy: "OR('Org1MSP.member')",
      requiredPeerCount: 0,
      maxPeerCount: 1,
      blockToLive: 0,
      memberOnlyRead: true,
      memberOnlyWrite: true,
    })),
  });

  return {
    networkId: 'nd-TEST',
    memberId: 'm-TEST',
    region: 'us-east-1',
    stateDb: 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z',
    channels: [
      {
        channelId: 'orders-ch',
        ledgerHeight: 1,
        chaincodes: [
          chaincode('marketplace', ['col1']),
          chaincode('ledger', []),
        ],
      },
      {
        channelId: 'trades-ch',
        ledgerHeight: 1,
        chaincodes: [chaincode('marketplace', [])],
      },
    ],
  };
}

async function generate(answers: string[]) {
  const { rl } = scriptedInterface([...UP_TO_KEY_MAPPING, ...answers]);
  const config = await promptReplayConfig(rl, '/out', 'us-east-1', manifest());
  return config.chaincode!;
}

// ── Generated function maps ──
//
// Row 2.8. The wizard writes the config every later command reads, so a flat map
// here is a run that resolves nothing: `replay` falls back to `PutState` for
// every record and `verify` refuses to start.

describe('promptReplayConfig — chaincode function maps', () => {
  it('keys the accepted defaults by channel and chaincode', async () => {
    const cc = await generate([
      '',  // accept the default write mapping
      '',  // accept the default verify functions
      '',  // no Tier 3 history
    ]);

    expect(cc.keyMapping).toEqual({
      'orders-ch': { marketplace: 'PutState', ledger: 'PutState' },
      'trades-ch': { marketplace: 'PutState' },
    });
    expect(cc.readFunctions).toEqual({
      'orders-ch': {
        marketplace: 'MigrationContract:ReadState',
        ledger: 'MigrationContract:ReadState',
      },
      'trades-ch': { marketplace: 'MigrationContract:ReadState' },
    });
    expect(cc.historyReadFunctions).toEqual({
      'orders-ch': {
        marketplace: 'MigrationContract:GetKeyHistory',
        ledger: 'MigrationContract:GetKeyHistory',
      },
      'trades-ch': { marketplace: 'MigrationContract:GetKeyHistory' },
    });
  });

  /**
   * A private read function is only wanted where the collection is: asked for
   * both channels, the entry for the one without a collection would make
   * `verify` require a function the destination has nothing to answer with.
   */
  it('offers a private read function only where a collection is declared', async () => {
    const cc = await generate(['', '', '']);

    expect(cc.privateReadFunctions).toEqual({
      'orders-ch': { marketplace: 'MigrationContract:ReadPrivateData' },
    });
  });

  it('asks per channel and chaincode when the defaults are declined', async () => {
    const cc = await generate([
      'n',              // decline the default write mapping
      'ImportOrder',    // orders-ch/marketplace
      'ImportLedger',   // orders-ch/ledger
      'ImportTrade',    // trades-ch/marketplace
      'n',              // decline the default verify functions
      'ReadOrder',      // orders-ch/marketplace public
      'ReadOrderPvt',   // orders-ch/marketplace private (it has a collection)
      'GetOrderHist',   // orders-ch/marketplace history
      'ReadLedger',     // orders-ch/ledger public
      'GetLedgerHist',  // orders-ch/ledger history
      'ReadTrade',      // trades-ch/marketplace public
      'GetTradeHist',   // trades-ch/marketplace history
      '',               // no Tier 3 history
    ]);

    expect(cc.keyMapping).toEqual({
      'orders-ch': { marketplace: 'ImportOrder', ledger: 'ImportLedger' },
      'trades-ch': { marketplace: 'ImportTrade' },
    });
    expect(cc.readFunctions).toEqual({
      'orders-ch': { marketplace: 'ReadOrder', ledger: 'ReadLedger' },
      'trades-ch': { marketplace: 'ReadTrade' },
    });
    expect(cc.privateReadFunctions).toEqual({
      'orders-ch': { marketplace: 'ReadOrderPvt' },
    });
    expect(cc.historyReadFunctions).toEqual({
      'orders-ch': { marketplace: 'GetOrderHist', ledger: 'GetLedgerHist' },
      'trades-ch': { marketplace: 'GetTradeHist' },
    });
  });

  /** Each question names the deployment, since the name alone is ambiguous. */
  it('names the channel in the questions it asks per deployment', async () => {
    const { rl, asked } = scriptedInterface([
      ...UP_TO_KEY_MAPPING,
      'n', 'ImportOrder', 'ImportLedger', 'ImportTrade', '', '',
    ]);

    await promptReplayConfig(rl, '/out', 'us-east-1', manifest());

    expect(asked).toContain('Function for "orders-ch/marketplace" [PutState]');
    expect(asked).toContain('Function for "trades-ch/marketplace" [PutState]');
  });

  /**
   * `verify` refuses to start unless every chaincode in the manifest has a read
   * function, so a deployment left blank has to keep its default rather than be
   * omitted — a config missing one entry is a config verify rejects.
   */
  it('keeps the default for a deployment answered blank', async () => {
    const cc = await generate([
      '',               // accept the default write mapping
      'n',              // decline the default verify functions
      '',               // orders-ch/marketplace public
      '',               // orders-ch/marketplace private
      '',               // orders-ch/marketplace history
      '',               // orders-ch/ledger public
      '',               // orders-ch/ledger history
      'ReadTrade',      // trades-ch/marketplace public
      '',               // trades-ch/marketplace history
      '',               // no Tier 3 history
    ]);

    expect(cc.readFunctions).toEqual({
      'orders-ch': {
        marketplace: 'MigrationContract:ReadState',
        ledger: 'MigrationContract:ReadState',
      },
      'trades-ch': { marketplace: 'ReadTrade' },
    });
    expect(cc.privateReadFunctions).toEqual({
      'orders-ch': { marketplace: 'MigrationContract:ReadPrivateData' },
    });
  });
});

// ── Generated delete functions ──
//
// Row 2.10. A write mapped to the application's own contract is usually there
// because that function maintains something besides the key. Its tombstone
// replayed as the migration contract's `DeleteState` removes the key and leaves
// the rest referring to it, so the wizard asks for the pair together — and only
// then, since a write on the migration contract already pairs with `DeleteState`.

describe('promptReplayConfig — delete functions', () => {
  it('asks for a delete beside a write on an application contract', async () => {
    const { rl, asked } = scriptedInterface([
      ...UP_TO_KEY_MAPPING,
      'n',                         // decline the default write mapping
      'SampleAssets:StoreAsset',   // orders-ch/marketplace write
      'SampleAssets:RemoveAsset',  // orders-ch/marketplace delete
      'ImportLedger',              // orders-ch/ledger write
      'ImportTrade',               // trades-ch/marketplace write
      '',                          // accept the default verify functions
      '',                          // no Tier 3 history
    ]);

    const config = await promptReplayConfig(rl, '/out', 'us-east-1', manifest());

    expect(config.chaincode!.deleteMapping).toEqual({
      'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' },
    });
    expect(asked).toContain(
      'Delete function for "orders-ch/marketplace" [DeleteState]',
    );
  });

  /** Nothing to decide: the migration contract's write pairs with its delete. */
  it('asks for no delete when every write stays on the migration contract',
    async () => {
      const { rl, asked } = scriptedInterface([
        ...UP_TO_KEY_MAPPING,
        'n', 'ImportOrder', 'ImportLedger', 'ImportTrade', '', '',
      ]);

      const config = await promptReplayConfig(
        rl, '/out', 'us-east-1', manifest(),
      );

      expect(config.chaincode!.deleteMapping).toBeUndefined();
      expect(asked.join('\n')).not.toMatch(/Delete function/);
    });

  it('omits deleteMapping when the default write mapping is accepted', async () => {
    const cc = await generate(['', '', '']);

    expect(cc.deleteMapping).toBeUndefined();
  });

  /**
   * Keyed like `keyMapping`, and a blank answer takes `DeleteState` — which is
   * still an answer: the entry records that the key is all there is to remove.
   */
  it('keys each answered delete by channel and chaincode', async () => {
    const cc = await generate([
      'n',
      'SampleAssets:StoreAsset', 'SampleAssets:RemoveAsset',
      'ImportLedger',
      'Trades:StoreTrade', '',
      '',
      '',
    ]);

    expect(cc.deleteMapping).toEqual({
      'orders-ch': { marketplace: 'SampleAssets:RemoveAsset' },
      'trades-ch': { marketplace: 'DeleteState' },
    });
    expect(cc.keyMapping).toEqual({
      'orders-ch': {
        marketplace: 'SampleAssets:StoreAsset', ledger: 'ImportLedger',
      },
      'trades-ch': { marketplace: 'Trades:StoreTrade' },
    });
  });
});

// ── Generated channel mapping ──
//
// Row 2.9. The wizard used to offer "Map all channels to a single destination?",
// which writes a config `replay` now refuses: one destination channel is one
// ledger, and two source channels' copies of a shared key overwrite each other
// on it. The same merge is reachable by typing one destination name twice.

describe('promptReplayConfig — channel mapping', () => {
  /** Script the channel-mapping questions, accepting every later default. */
  async function generateWithChannelAnswers(channelAnswers: string[]) {
    const { rl, asked } = scriptedInterface([
      '3', 'profile.json', 'Org1MSP', 'cert.pem', 'key.pem',
      ...channelAnswers,
      '',  // accept the default concurrency
      '',  // accept the default write mapping
      '',  // accept the default verify functions
      '',  // no Tier 3 history
    ]);
    const config = await promptReplayConfig(rl, '/out', 'us-east-1', manifest());
    return { cc: config.chaincode!, asked };
  }

  it('maps each source channel to its own name by default', async () => {
    const { cc } = await generateWithChannelAnswers(['']);

    expect(cc.channelMapping).toEqual({
      'orders-ch': 'orders-ch',
      'trades-ch': 'trades-ch',
    });
    expect(cc.channel).toBeUndefined();
  });

  it('asks per channel when the default mapping is declined', async () => {
    const { cc } = await generateWithChannelAnswers([
      'n', 'dest-orders', 'dest-trades',
    ]);

    expect(cc.channelMapping).toEqual({
      'orders-ch': 'dest-orders',
      'trades-ch': 'dest-trades',
    });
    expect(cc.channel).toBeUndefined();
  });

  /** The removed prompt. Its only product was a config replay refuses. */
  it('never offers to map every channel to a single destination', async () => {
    const { asked } = await generateWithChannelAnswers([
      'n', 'dest-orders', 'dest-trades',
    ]);

    expect(asked.join('\n')).not.toMatch(/single destination/);
  });

  it('asks again for a destination already given to another channel', async () => {
    const { cc, asked } = await generateWithChannelAnswers([
      'n', 'everything', 'everything', 'dest-trades',
    ]);

    expect(cc.channelMapping).toEqual({
      'orders-ch': 'everything',
      'trades-ch': 'dest-trades',
    });
    expect(asked).toContain('Destination for "trades-ch"');
  });

  /** A retry has no default, so an empty answer must not be taken as a name. */
  it('asks again for a destination left blank on the retry', async () => {
    const { cc } = await generateWithChannelAnswers([
      'n', 'everything', 'everything', '', 'dest-trades',
    ]);

    expect(cc.channelMapping).toEqual({
      'orders-ch': 'everything',
      'trades-ch': 'dest-trades',
    });
  });

  /** One source channel needs no map, and `channel` also renames it. */
  it('uses a single channel for a one-channel manifest', async () => {
    const { rl } = scriptedInterface([
      '3', 'profile.json', 'Org1MSP', 'cert.pem', 'key.pem',
      'n', 'dest-orders',
      '', '', '', '',
    ]);
    const oneChannel = manifest();
    oneChannel.channels = [oneChannel.channels[0]];

    const config = await promptReplayConfig(rl, '/out', 'us-east-1', oneChannel);

    expect(config.chaincode!.channel).toBe('dest-orders');
    expect(config.chaincode!.channelMapping).toBeUndefined();
  });
});

// ── Generated member mapping ──
//
// Row 2.17. `_implicit_org_<MSPID>` is named after the org that owns it, so a
// config that submits the source name writes into a collection the destination
// does not have, and only that org can write it. The wizard asks once per
// member — the one fact behind every implicit collection's routing and identity
// — and writes `mspMapping` and `orgIdentities` rather than a per-collection
// entry for each.

describe('promptReplayConfig — member mapping', () => {
  /** One channel whose chaincodes share an implicit collection name. */
  function implicitManifest(): Manifest {
    const withCollections = (name: string, collections: string[]) => ({
      name,
      version: '1.0',
      sequence: 1,
      collections: collections.map((collectionName) => ({
        name: collectionName,
        policy: "OR('Org1MSP.member')",
        requiredPeerCount: 0,
        maxPeerCount: 1,
        blockToLive: 0,
        memberOnlyRead: true,
        memberOnlyWrite: true,
      })),
    });

    return {
      ...manifest(),
      channels: [{
        channelId: 'orders-ch',
        ledgerHeight: 1,
        chaincodes: [
          withCollections('marketplace', [
            '_implicit_org_Org1MSP', '_implicit_org_Org2MSP', 'col1',
          ]),
          withCollections('ledger', ['_implicit_org_Org1MSP']),
        ],
      }],
    };
  }

  /** Script the member questions, accepting every other default. */
  async function generateWithMemberAnswers(memberAnswers: string[]) {
    const { rl, asked } = scriptedInterface([
      '3', 'profile.json', 'Org1MSP', 'cert.pem', 'key.pem',
      '',  // accept the one-channel default
      ...memberAnswers,
      '',  // accept the default concurrency
      '',  // accept the default write mapping
      '',  // accept the default verify functions
      '',  // no Tier 3 history
    ]);
    const config = await promptReplayConfig(
      rl, '/out', 'us-east-1', implicitManifest(),
    );
    return { cc: config.chaincode!, asked };
  }

  /**
   * Written out even when it changes nothing: mapping a member to itself is a
   * decision rather than an unnoticed coincidence.
   */
  it('maps each member to its own MSP ID by default', async () => {
    const { cc } = await generateWithMemberAnswers(['', '']);

    expect(cc.mspMapping).toEqual({ Org1MSP: 'Org1MSP', Org2MSP: 'Org2MSP' });
    expect(cc.collectionMapping).toBeUndefined();
  });

  /** One question per member: every chaincode on the channel shares its collection. */
  it('asks once per member, not once per chaincode', async () => {
    const { asked } = await generateWithMemberAnswers([
      'n', 'Org7MSP', 'Org8MSP', '', '',
    ]);

    expect(asked.filter(
      (q) => q.startsWith('Destination MSP for "Org1MSP"'),
    )).toHaveLength(1);
  });

  it('asks per member when the default mapping is declined', async () => {
    const { cc } = await generateWithMemberAnswers([
      'n', 'Org7MSP', 'Org8MSP', '', '',
    ]);

    expect(cc.mspMapping).toEqual({ Org1MSP: 'Org7MSP', Org2MSP: 'Org8MSP' });
  });

  /**
   * The generated config has to be one `replay` accepts: every implicit
   * collection routed, and no two onto one destination.
   */
  it('generates a mapping replay routes every implicit collection through', async () => {
    const { cc } = await generateWithMemberAnswers([
      'n', 'Org7MSP', 'Org8MSP', '', '',
    ]);

    expect(expandCollectionMapping(cc)).toEqual({
      '_implicit_org_Org1MSP': '_implicit_org_Org7MSP',
      '_implicit_org_Org2MSP': '_implicit_org_Org8MSP',
    });
    expect(() => assertCollectionRouting(
      withOrgRouting({ adapter: 'chaincode', inputDir: '/out', chaincode: cc })
        .chaincode!,
      ['_implicit_org_Org1MSP', '_implicit_org_Org2MSP', 'col1'],
    )).not.toThrow();
  });

  /** Two members on one MSP would merge their implicit collections. */
  it('asks again for an MSP already given to another member, and says why', async () => {
    const printed: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => {
      printed.push(args.join(' '));
    });

    let result;
    try {
      result = await generateWithMemberAnswers([
        'n', 'Org7MSP', 'Org7MSP', 'Org8MSP', '', '',
      ]);
    } finally {
      log.mockRestore();
    }

    expect(result.cc.mspMapping).toEqual({ Org1MSP: 'Org7MSP', Org2MSP: 'Org8MSP' });
    expect(printed.join('\n')).toContain(
      '"Org7MSP" is already the destination for "Org1MSP"',
    );
    expect(printed.join('\n')).toContain('one keyspace');
  });

  /** A retry has no default, so an empty answer must not be taken as a name. */
  it('asks again for a destination MSP left blank on the retry', async () => {
    const { cc } = await generateWithMemberAnswers([
      'n', 'Org7MSP', 'Org7MSP', '', 'Org8MSP', '', '',
    ]);

    expect(cc.mspMapping).toEqual({ Org1MSP: 'Org7MSP', Org2MSP: 'Org8MSP' });
  });

  /** The top-level identity already writes as its own org. */
  it('asks for credentials only for orgs other than the top-level one', async () => {
    const { asked } = await generateWithMemberAnswers(['', '']);

    expect(asked).toContain('Certificate path for Org2MSP (blank to skip)');
    expect(asked.join('\n')).not.toContain('Certificate path for Org1MSP');
  });

  it('records each org\'s credentials once', async () => {
    const { cc } = await generateWithMemberAnswers([
      '', 'org2-cert.pem', 'org2-key.pem', 'org2-profile.json',
    ]);

    expect(cc.orgIdentities).toEqual({
      Org2MSP: {
        certPath: 'org2-cert.pem',
        keyPath: 'org2-key.pem',
        connectionProfilePath: 'org2-profile.json',
      },
    });
  });

  it('leaves the profile to the top-level default when accepted', async () => {
    const { cc } = await generateWithMemberAnswers([
      '', 'org2-cert.pem', 'org2-key.pem', '',
    ]);

    expect(cc.orgIdentities).toEqual({
      Org2MSP: { certPath: 'org2-cert.pem', keyPath: 'org2-key.pem' },
    });
  });

  /** A skipped org is left out rather than written half-configured. */
  it('omits orgIdentities when every org is skipped', async () => {
    const { cc } = await generateWithMemberAnswers(['', '']);

    expect(cc.orgIdentities).toBeUndefined();
  });

  /** Nothing to route, so nothing to ask — and no empty map in the config. */
  it('omits both maps when the manifest holds no implicit collection', async () => {
    const { rl, asked } = scriptedInterface([...UP_TO_KEY_MAPPING, '', '', '']);

    const config = await promptReplayConfig(rl, '/out', 'us-east-1', manifest());

    expect(config.chaincode!.mspMapping).toBeUndefined();
    expect(config.chaincode!.orgIdentities).toBeUndefined();
    expect(asked.join('\n')).not.toMatch(/member mapping/);
  });
});

// ── The writer list reminder ──
//
// Row 2.12. The migration contract refuses every write until its writer list
// names the MSP the run submits as, and it ships empty. A config generated here
// is complete and still a failed run away from replaying anything, so the wizard
// says so while the operator is still looking at the MSP ID they just typed.

describe('promptReplayConfig — writer list reminder', () => {
  let printed: string[];
  let log: jest.SpyInstance;

  beforeEach(() => {
    printed = [];
    log = jest.spyOn(console, 'log').mockImplementation((...args) => {
      printed.push(args.join(' '));
    });
  });

  afterEach(() => {
    log.mockRestore();
  });

  it('names the MSP ID the run submits as', async () => {
    await generate(['', '', '']);

    const reminder = printed.join('\n');
    expect(reminder).toMatch(/Org1MSP in its writer list/);
    expect(reminder).toMatch(/writerMSPIDs/);
    expect(reminder).toMatch(/WRITER_MSP_IDS/);
    expect(reminder).toMatch(/collectionIdentities/);
  });

  /** The wizard asks for one identity; a cross-member run writes as several. */
  it('names the MSP ID that was answered, not a default', async () => {
    const { rl } = scriptedInterface([
      '3', 'profile.json', 'Org7MSP', 'cert.pem', 'key.pem',
      '', '', '', '', '',
    ]);

    await promptReplayConfig(rl, '/out', 'us-east-1', manifest());

    expect(printed.join('\n')).toMatch(/Org7MSP in its writer list/);
  });

  /** There is no contract to edit, so the reminder would be noise. */
  it('is not printed for a database destination', async () => {
    const { rl } = scriptedInterface(['1', 'postgresql://localhost/db']);

    await promptReplayConfig(rl, '/out', 'us-east-1', manifest());

    expect(printed.join('\n')).not.toMatch(/writer list/);
  });
});
