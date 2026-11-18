// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  formatPreflightRefusal,
  listPrivateWriteTargets,
  preflightCollections,
  PrivateWriteTarget,
  WriteBlocker,
} from '../src/replay/collection-preflight';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { ChaincodeInfo, CollectionConfig } from '../src/types';

// ─── Fixtures ───

/** A collection config, defaulting to the shape a member-only one has. */
function collection(
  name: string,
  overrides: Partial<CollectionConfig> = {},
): CollectionConfig {
  return {
    name,
    policy: "OR('Org1MSP.member')",
    requiredPeerCount: 0,
    maxPeerCount: 1,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    ...overrides,
  };
}

function chaincode(
  name: string,
  collections: CollectionConfig[] = [],
): ChaincodeInfo {
  return { name, version: '1.0', sequence: 1, collections };
}

/** Definitions read from the one destination channel these targets name. */
function definitionsOf(...defs: ChaincodeInfo[]): Map<string, ChaincodeInfo[]> {
  return new Map([['dest1', defs]]);
}

/** A target that is not mapped, so source and destination names agree. */
function target(
  overrides: Partial<PrivateWriteTarget> = {},
): PrivateWriteTarget {
  const collection = overrides.collection ?? 'col1';
  return {
    channel: 'ch1',
    destChannel: 'dest1',
    chaincode: 'mycc',
    collection,
    destCollection: collection,
    ...overrides,
  };
}

/** Every collection is written by the top-level identity. */
const alwaysOrg1 = () => 'Org1MSP';

describe('listPrivateWriteTargets', () => {
  let root: string;
  let layout: FileLayoutManager;
  let reader: NdjsonReader;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
    layout = new FileLayoutManager(root);
    reader = new NdjsonReader();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Write a private state file whose records name the pair that owns it. */
  function privateState(
    channel: string,
    chaincode: string,
    collection: string,
  ): void {
    writeFile(
      path.join(root, layout.privateStatePath(channel, chaincode, collection)),
      JSON.stringify({
        _type: 'private_state', channel, chaincode, collection,
        key: 'k1', value: 'v1',
      }) + '\n',
    );
  }

  function privateHistory(
    channel: string,
    chaincode: string,
    collection: string,
  ): void {
    writeFile(
      path.join(root, layout.privateHistoryPath(channel, chaincode, collection)),
      JSON.stringify({
        _type: 'private_history', channel, chaincode, collection,
        key: 'k1', value: 'v1', txId: 'tx1', txIndex: 0, blockNumber: 1,
        timestamp: '', isDelete: false,
      }) + '\n',
    );
  }

  function writeFile(full: string, body: string): void {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }

  const pairs = [{ channel: 'ch1', destChannel: 'dest1' }];

  function targets(suffix = '-state.ndjson'): Promise<PrivateWriteTarget[]> {
    return listPrivateWriteTargets(reader, layout, pairs, suffix, (c) => c);
  }

  it('names the chaincode each collection belongs to', async () => {
    privateState('ch1', 'mycc', 'col1');

    await expect(targets()).resolves.toEqual([
      {
        channel: 'ch1', destChannel: 'dest1', chaincode: 'mycc',
        collection: 'col1', destCollection: 'col1',
      },
    ]);
  });

  /**
   * The source name identifies the file, so it has to survive; the destination
   * name is what every check and every write uses. Losing either one replays
   * the wrong file or writes to the wrong collection.
   */
  it('carries both the source name and the mapped destination name', async () => {
    privateState('ch1', 'mycc', '_implicit_org_Org1MSP');

    const found = await listPrivateWriteTargets(
      reader, layout, pairs, '-state.ndjson',
      (c) => (c === '_implicit_org_Org1MSP' ? '_implicit_org_Org9MSP' : c),
    );

    expect(found).toEqual([
      {
        channel: 'ch1', destChannel: 'dest1', chaincode: 'mycc',
        collection: '_implicit_org_Org1MSP',
        destCollection: '_implicit_org_Org9MSP',
      },
    ]);
  });

  /**
   * An empty file submits nothing, so a collection it names cannot fail.
   * Refusing on one would block runs over collections that carry no data —
   * including every collection this member was never authorized to read.
   */
  it('ignores a collection whose file holds no records', async () => {
    writeFile(
      path.join(root, layout.privateStatePath('ch1', 'mycc', 'empty')),
      '',
    );
    privateState('ch1', 'mycc', 'col1');

    const found = await targets();

    expect(found.map((t) => t.collection)).toEqual(['col1']);
  });

  it('yields nothing for a channel with no private files', async () => {
    await expect(targets()).resolves.toEqual([]);
  });

  /**
   * On Fabric 2.x every chaincode on a channel has its own
   * `_implicit_org_<MSPID>` under the same name, and a destination that declares
   * one chaincode is not thereby declaring the other — so each needs its own
   * check, and each has its own file to be found in.
   */
  it('yields one target per chaincode sharing a collection name', async () => {
    privateState('ch1', 'assets', '_implicit_org_Org1MSP');
    privateState('ch1', 'trades', '_implicit_org_Org1MSP');

    const found = await targets();

    expect(found.map((t) => t.chaincode)).toEqual(['assets', 'trades']);
  });

  it('reads history files when history is what will be replayed', async () => {
    privateState('ch1', 'mycc', 'col1');
    privateHistory('ch1', 'mycc', 'hist');

    const found = await targets('-history.ndjson');

    expect(found.map((t) => t.collection)).toEqual(['hist']);
  });

  it('carries each source channel its own destination', async () => {
    privateState('ch1', 'mycc', 'col1');
    privateState('ch2', 'mycc', 'col2');

    const found = await listPrivateWriteTargets(
      reader,
      layout,
      [
        { channel: 'ch1', destChannel: 'dest1' },
        { channel: 'ch2', destChannel: 'dest2' },
      ],
      '-state.ndjson',
      (c) => c,
    );

    expect(found.map((t) => [t.collection, t.destChannel])).toEqual([
      ['col1', 'dest1'],
      ['col2', 'dest2'],
    ]);
  });
});

describe('preflightCollections — destination purge windows', () => {
  /** A destination that purges replayed data before the run can finish. */
  it('reports a destination collection with blockToLive above zero', () => {
    const result = preflightCollections(
      [target({ collection: 'ephemeral' })],
      definitionsOf(chaincode('mycc', [collection('ephemeral', { blockToLive: 40 })])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.purging).toEqual([
      expect.objectContaining({ destCollection: 'ephemeral', blockToLive: 40 }),
    ]);
  });

  it('reports nothing for a collection that never purges', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [collection('col1')])),
      alwaysOrg1,
    );

    expect(result.purging).toEqual([]);
  });

  /** The destination's window decides, under the name replay writes to. */
  it('reads the window of the mapped destination collection', () => {
    const result = preflightCollections(
      [target({ collection: 'src', destCollection: 'dst' })],
      definitionsOf(chaincode('mycc', [
        collection('src', { blockToLive: 0 }),
        collection('dst', { blockToLive: 7 }),
      ])),
      alwaysOrg1,
    );

    expect(result.purging.map((p) => p.blockToLive)).toEqual([7]);
  });
});

describe('preflightCollections', () => {
  it('refuses an implicit collection submitted as another org', () => {
    const result = preflightCollections(
      [target({ collection: '_implicit_org_Org2MSP' })],
      definitionsOf(chaincode('mycc')),
      alwaysOrg1,
    );

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].kind).toBe('not-a-member');
    expect(result.blockers[0].detail).toContain('admits only Org2MSP');
    expect(result.blockers[0].mspId).toBe('Org1MSP');
  });

  /**
   * The name settles it, so the refusal must not depend on the destination's
   * definitions having been read — a `_lifecycle` that answered nothing cannot
   * turn a certain denial into a target passed over in silence.
   */
  it('decides an implicit collection with no definitions read at all', () => {
    const result = preflightCollections(
      [target({ collection: '_implicit_org_Org2MSP' })],
      new Map(),
      alwaysOrg1,
    );

    expect(result.blockers[0].kind).toBe('not-a-member');
  });

  /**
   * Measured live on Fabric 2.5: Org1MSP, holding no Org2MSP credentials,
   * wrote `_implicit_org_Org2MSP` and the transaction was VALID whenever an
   * Org2MSP peer endorsed it — the collection's endorsement policy names the
   * owner's peers, and implicit collections leave memberOnlyWrite off. Only
   * an endorsement by Org1MSP's own peer was refused.
   */
  it('accepts another org\'s implicit collection under ownerEndorsement', () => {
    const result = preflightCollections(
      [target({ collection: '_implicit_org_Org2MSP' })],
      definitionsOf(chaincode('mycc')),
      alwaysOrg1,
      true,
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
  });

  /**
   * The setting is about implicit collections only. An explicit collection
   * with memberOnlyWrite is checked against the submitter by the peer, and no
   * choice of endorser changes who submitted.
   */
  it('still refuses an explicit memberOnlyWrite collection under ownerEndorsement', () => {
    const result = preflightCollections(
      [target({ collection: 'onlyOrg2' })],
      definitionsOf(chaincode('mycc', [
        collection('onlyOrg2', {
          policy: "OR('Org2MSP.member')", memberOnlyWrite: true,
        }),
      ])),
      alwaysOrg1,
      true,
    );

    expect(result.blockers.map((b) => b.kind)).toEqual(['not-a-member']);
  });

  /** The callback is asked per channel, so one name can pass on one and fail on another. */
  it('checks a collection name against the identity for its own channel', () => {
    const policyOrg4 = definitionsOf(chaincode('mycc', [
      collection('pairAB', { policy: "OR('Org4MSP.member')", memberOnlyWrite: true }),
    ]));
    const definitions = new Map([
      ['dest1', policyOrg4.get('dest1') as ChaincodeInfo[]],
      ['dest2', policyOrg4.get('dest1') as ChaincodeInfo[]],
    ]);

    const result = preflightCollections(
      [target({ collection: 'pairAB', destChannel: 'dest1' }),
        target({ collection: 'pairAB', destChannel: 'dest2' })],
      definitions,
      (_c, destChannel) => (destChannel === 'dest2' ? 'Org4MSP' : 'Org1MSP'),
    );

    expect(result.blockers.map((b) => b.destChannel)).toEqual(['dest1']);
  });

  it('accepts an implicit collection submitted by its owner', () => {
    const result = preflightCollections(
      [target({ collection: '_implicit_org_Org1MSP' })],
      definitionsOf(chaincode('mycc')),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
  });

  /**
   * The reason 2.6 exists: the identity that writes a collection is the one
   * configured for it, so an org that owns a collection can supply its own
   * credentials instead of the whole migration failing as one MSP.
   */
  it('checks each collection against the identity configured for it', () => {
    const result = preflightCollections(
      [
        target({ collection: '_implicit_org_Org1MSP' }),
        target({ collection: '_implicit_org_Org2MSP' }),
      ],
      definitionsOf(chaincode('mycc')),
      (collection) =>
        collection === '_implicit_org_Org2MSP' ? 'Org2MSP' : 'Org1MSP',
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(2);
  });

  /**
   * The destination name is the one the peer sees, so it is the one the
   * identity has to be chosen for: an operator supplying credentials for
   * `_implicit_org_Org9MSP` has named the collection replay will submit to,
   * not the source collection that no longer exists anywhere.
   */
  it('picks the identity by the destination collection name', () => {
    const mspIdFor = jest.fn(() => 'Org9MSP');

    const result = preflightCollections(
      [target({
        collection: '_implicit_org_Org1MSP',
        destCollection: '_implicit_org_Org9MSP',
      })],
      definitionsOf(chaincode('mycc')),
      mspIdFor,
    );

    expect(mspIdFor).toHaveBeenCalledWith('_implicit_org_Org9MSP', 'dest1');
    expect(result.blockers).toEqual([]);
  });

  /**
   * Whose collection it was at the source decides nothing. Mapped onto an
   * explicit destination collection, an implicit one is bound by that
   * collection's policy — so a run that would be refused under the source name
   * proceeds under the destination's.
   */
  it('binds a mapped implicit collection to the destination policy', () => {
    const result = preflightCollections(
      [target({
        collection: '_implicit_org_Org2MSP',
        destCollection: 'shared',
      })],
      definitionsOf(chaincode('mycc', [
        collection('shared', { policy: "OR('Org1MSP.member')" }),
      ])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
  });

  /**
   * Bound by the destination collection's policy means bound by its refusals
   * too. Deciding from the source name that no definition need be checked would
   * accept a run the destination denies every write of.
   */
  it('refuses a mapped implicit collection the destination excludes', () => {
    const result = preflightCollections(
      [target({
        collection: '_implicit_org_Org1MSP',
        destCollection: 'shared',
      })],
      definitionsOf(chaincode('mycc', [
        collection('shared', { policy: "OR('Org2MSP.member')" }),
      ])),
      alwaysOrg1,
    );

    expect(result.blockers[0].kind).toBe('not-a-member');
    expect(result.blockers[0].detail).toContain("OR('Org2MSP.member')");
  });

  /**
   * 2.17's own check: existence is established under the name replay will use.
   * Checking the source name would pass a run whose every write then fails on a
   * collection the destination chaincode does not declare.
   */
  it('refuses when the destination declares no mapped collection', () => {
    const result = preflightCollections(
      [target({ collection: 'col1', destCollection: 'renamed' })],
      definitionsOf(chaincode('mycc', [collection('col1')])),
      alwaysOrg1,
    );

    expect(result.blockers[0].kind).toBe('collection-missing');
    expect(result.blockers[0].detail).toContain('declares no collection renamed');
  });

  it('accepts a mapped collection the destination does declare', () => {
    const result = preflightCollections(
      [target({ collection: 'col1', destCollection: 'renamed' })],
      definitionsOf(chaincode('mycc', [collection('renamed')])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('refuses a member-only collection the submitter is not named in', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [
        collection('col1', { policy: "OR('Org2MSP.member')" }),
      ])),
      alwaysOrg1,
    );

    expect(result.blockers[0].kind).toBe('not-a-member');
    expect(result.blockers[0].detail).toContain("OR('Org2MSP.member')");
    expect(result.blockers[0].detail).toContain('memberOnlyWrite is on');
  });

  it('accepts a member-only collection the submitter is named in', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [
        collection('col1', { policy: "OR('Org1MSP.member', 'Org2MSP.peer')" }),
      ])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.checked).toBe(1);
  });

  /**
   * Without `memberOnlyWrite` the peer does not check the submitter's org, so
   * the write succeeds. Refusing it would block a replay Fabric permits; saying
   * nothing would hide that the values must reach a peer of another org to be
   * stored at all.
   */
  it('notes rather than refuses a non-member write the peer allows', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [
        collection('col1', {
          policy: "OR('Org2MSP.member')",
          memberOnlyWrite: false,
        }),
      ])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.unchecked).toHaveLength(1);
    expect(result.unchecked[0]).toContain('another org endorsing them');
    expect(result.checked).toBe(1);
  });

  it('names both ends of a mapping in that note', () => {
    const result = preflightCollections(
      [target({ collection: 'col1', destCollection: 'shared' })],
      definitionsOf(chaincode('mycc', [
        collection('shared', {
          policy: "OR('Org2MSP.member')",
          memberOnlyWrite: false,
        }),
      ])),
      alwaysOrg1,
    );

    expect(result.unchecked[0]).toContain('ch1/mycc/col1 → shared:');
  });

  /**
   * `collectionPolicyIncludes` fails open, and the pre-flight inherits that: a
   * policy nobody can read is not evidence of a denial, and refusing on one
   * would block a correct migration over an unparsed protobuf.
   */
  it('does not refuse when the destination policy could not be read', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [collection('col1', { policy: '' })])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
  });

  it('refuses when the chaincode declares no such collection', () => {
    const result = preflightCollections(
      [target()],
      definitionsOf(chaincode('mycc', [collection('other')])),
      alwaysOrg1,
    );

    expect(result.blockers[0].kind).toBe('collection-missing');
    expect(result.blockers[0].detail).toContain('declares no collection col1');
    expect(result.blockers[0].detail).toContain('other');
  });

  it('reports every blocker, not the first', () => {
    const result = preflightCollections(
      [
        target({ collection: 'col1' }),
        target({ collection: 'col2' }),
        target({ collection: '_implicit_org_Org2MSP' }),
      ],
      definitionsOf(chaincode('mycc')),
      alwaysOrg1,
    );

    expect(result.blockers.map((b) => b.collection)).toEqual([
      'col1', 'col2', '_implicit_org_Org2MSP',
    ]);
  });

  /**
   * A definition that is not there is not a definition declaring nothing. Both
   * ways it goes missing are reported by the checks that ran first — an
   * unreadable channel by `readDestinationDefinitions`, an uncommitted chaincode
   * by `preflightDeployments` — so refusing here would name the wrong cause.
   */
  it('passes over a chaincode whose definition was not read', () => {
    const result = preflightCollections(
      [target({ chaincode: 'assets' })],
      definitionsOf(chaincode('mycc', [collection('col1')])),
      alwaysOrg1,
    );

    expect(result.blockers).toEqual([]);
    expect(result.unchecked).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('passes over a destination channel that answered nothing', () => {
    const result = preflightCollections([target()], new Map(), alwaysOrg1);

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(0);
  });

  /**
   * Found by destination channel, not by source. Two source channels mapped onto
   * different destinations have different definitions, so keying by the source
   * name would check a collection against the wrong channel's chaincode.
   */
  it('reads each target against its own destination channel', () => {
    const result = preflightCollections(
      [target(), target({ channel: 'ch2', destChannel: 'dest2' })],
      new Map([
        ['dest1', [chaincode('mycc', [collection('col1')])]],
        ['dest2', [chaincode('mycc', [
          collection('col1', { policy: "OR('Org2MSP.member')" }),
        ])]],
      ]),
      alwaysOrg1,
    );

    expect(result.blockers.map((b) => b.destChannel)).toEqual(['dest2']);
    expect(result.checked).toBe(1);
  });
});

describe('formatPreflightRefusal', () => {
  function blocker(overrides: Partial<WriteBlocker>): WriteBlocker {
    return {
      ...target(overrides),
      mspId: 'Org1MSP',
      kind: 'not-a-member',
      detail: 'would be written as Org1MSP',
      ...overrides,
    };
  }

  it('offers ownerEndorsement for an implicit collection only', () => {
    const implicit = formatPreflightRefusal([
      blocker({ collection: '_implicit_org_Org2MSP' }),
    ]);
    const explicit = formatPreflightRefusal([
      blocker({ collection: 'onlyOrg2' }),
    ]);

    expect(implicit).toContain('chaincode.ownerEndorsement: true');
    expect(explicit).not.toContain('ownerEndorsement');
  });

  it('names every collection and what is wrong with it', () => {
    const message = formatPreflightRefusal([
      blocker({ collection: 'col1', detail: 'first detail' }),
      blocker({ collection: 'col2', detail: 'second detail' }),
    ]);

    expect(message).toContain('2 destination collection(s)');
    expect(message).toContain('ch1/mycc/col1: first detail');
    expect(message).toContain('ch1/mycc/col2: second detail');
  });

  /**
   * A mapped collection has two names, and an operator needs both: the source
   * name to find the file and the config entry, the destination name to know
   * which collection is actually refusing the write.
   */
  it('shows both names for a mapped collection', () => {
    const message = formatPreflightRefusal([
      blocker({ collection: 'col1', destCollection: 'renamed' }),
    ]);

    expect(message).toContain('ch1/mycc/col1 → renamed:');
  });

  /**
   * Each remedy is a different job — supplying credentials, committing a
   * collection — so a run that hit one must not be told to do both. Each kind is
   * checked alone, since a remedy printed unconditionally is only visible in the
   * runs that did not call for it.
   */
  it.each([
    ['not-a-member', 'collectionIdentities'],
    ['collection-missing', 'collection config that includes it'],
  ] as const)('gives only the %s remedy for a %s blocker', (kind, remedy) => {
    const others = ['collectionIdentities', 'collection config that includes it']
      .filter((r) => r !== remedy);

    const message = formatPreflightRefusal([blocker({ kind })]);

    expect(message).toContain(remedy);
    for (const other of others) expect(message).not.toContain(other);
  });

  /**
   * A collection the destination does not declare has two ways out, and 2.17
   * added the second. Naming only the first sends an operator to re-commit a
   * chaincode where a config entry would have done.
   */
  it('offers both ways out of a missing destination collection', () => {
    const message = formatPreflightRefusal([
      blocker({ kind: 'collection-missing' }),
    ]);

    expect(message).toContain('collection config that includes it');
    expect(message).toContain('chaincode.collectionMapping entry');
  });

  it('gives every remedy a mixed set of blockers calls for', () => {
    const message = formatPreflightRefusal([
      blocker({ kind: 'not-a-member' }),
      blocker({ kind: 'collection-missing' }),
    ]);

    expect(message).toContain('collectionIdentities');
    expect(message).toContain('collection config that includes it');
  });
});
