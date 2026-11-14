import { ReplayConfig } from '../src/types';
import {
  expandCollectionIdentities,
  expandCollectionMapping,
  withOrgRouting,
} from '../src/replay/org-routing';
import { assertCollectionRouting } from '../src/replay/collection-routing';

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

function config(overrides: Partial<ChaincodeConfig> = {}): ChaincodeConfig {
  return {
    connectionProfilePath: 'org1-profile.json',
    mspId: 'Org1MSP',
    certPath: 'org1-cert.pem',
    keyPath: 'org1-key.pem',
    ...overrides,
  };
}

/** Eight members, the shape this shorthand exists for. */
const EIGHT = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [`m-SRC${i}`, `Org${i + 1}MSP`]),
);

describe('expandCollectionMapping', () => {
  it('derives one implicit collection entry per member', () => {
    const mapping = expandCollectionMapping(config({ mspMapping: EIGHT }));

    expect(Object.keys(mapping!)).toHaveLength(8);
    expect(mapping!['_implicit_org_m-SRC0']).toBe('_implicit_org_Org1MSP');
    expect(mapping!['_implicit_org_m-SRC7']).toBe('_implicit_org_Org8MSP');
  });

  it('lets an explicit collectionMapping entry win', () => {
    const mapping = expandCollectionMapping(config({
      mspMapping: { 'm-SRC0': 'Org1MSP' },
      collectionMapping: { '_implicit_org_m-SRC0': 'customCollection' },
    }));

    expect(mapping).toEqual({ '_implicit_org_m-SRC0': 'customCollection' });
  });

  it('keeps explicit entries for declared collections beside derived ones', () => {
    const mapping = expandCollectionMapping(config({
      mspMapping: { 'm-SRC0': 'Org1MSP' },
      collectionMapping: { colA: 'colB' },
    }));

    expect(mapping).toEqual({
      '_implicit_org_m-SRC0': '_implicit_org_Org1MSP',
      colA: 'colB',
    });
  });

  /** A blank value resolves back to the source name, so it is not an entry. */
  it('skips a member mapped to a blank MSP ID', () => {
    expect(expandCollectionMapping(config({ mspMapping: { 'm-SRC0': '' } })))
      .toBeUndefined();
  });

  it('returns undefined when there is nothing to route', () => {
    expect(expandCollectionMapping(config())).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = config({ mspMapping: EIGHT, collectionMapping: { a: 'b' } });
    const twice = { ...once, collectionMapping: expandCollectionMapping(once) };

    expect(expandCollectionMapping(twice)).toEqual(expandCollectionMapping(once));
  });

  /** The routing check must accept what the shorthand produces. */
  it('satisfies the routing check for every member\'s implicit collection', () => {
    const cc = withOrgRouting({
      adapter: 'chaincode', inputDir: '/in', chaincode: config({ mspMapping: EIGHT }),
    }).chaincode!;

    expect(() => assertCollectionRouting(
      cc, Object.keys(EIGHT).map((m) => `_implicit_org_${m}`),
    )).not.toThrow();
  });

  /** Still refused: two members onto one MSP merge two collections' keys. */
  it('leaves two members mapped to one MSP to the merge refusal', () => {
    const cc = withOrgRouting({
      adapter: 'chaincode',
      inputDir: '/in',
      chaincode: config({ mspMapping: { 'm-A': 'Org1MSP', 'm-B': 'Org1MSP' } }),
    }).chaincode!;

    expect(() => assertCollectionRouting(
      cc, ['_implicit_org_m-A', '_implicit_org_m-B'],
    )).toThrow(/same destination collection/);
  });

  /** A typo in a member ID is not silent: its collection stays unmapped. */
  it('leaves an unmapped member to the routing refusal, which names mspMapping', () => {
    const cc = withOrgRouting({
      adapter: 'chaincode',
      inputDir: '/in',
      chaincode: config({ mspMapping: { 'm-TYPO': 'Org1MSP' } }),
    }).chaincode!;

    expect(() => assertCollectionRouting(cc, ['_implicit_org_m-A']))
      .toThrow(/mspMapping.*"m-A"/s);
  });
});

describe('expandCollectionIdentities', () => {
  const ORG2 = { certPath: 'org2-cert.pem', keyPath: 'org2-key.pem' };

  it('derives an identity for each org\'s implicit collection', () => {
    expect(expandCollectionIdentities(config({ orgIdentities: { Org2MSP: ORG2 } })))
      .toEqual({ '_implicit_org_Org2MSP': { mspId: 'Org2MSP', ...ORG2 } });
  });

  it('resolves an MSP ID reference to that org\'s credentials', () => {
    const identities = expandCollectionIdentities(config({
      orgIdentities: { Org2MSP: { ...ORG2, connectionProfilePath: 'org2.json' } },
      collectionIdentities: { colA: 'Org2MSP' },
    }));

    expect(identities.colA).toEqual({
      mspId: 'Org2MSP', ...ORG2, connectionProfilePath: 'org2.json',
    });
  });

  it('resolves a reference to the top-level MSP to the top-level identity', () => {
    expect(expandCollectionIdentities(config({
      collectionIdentities: { colA: 'Org1MSP' },
    })).colA).toEqual({
      mspId: 'Org1MSP',
      certPath: 'org1-cert.pem',
      keyPath: 'org1-key.pem',
      connectionProfilePath: 'org1-profile.json',
    });
  });

  it('passes a full identity through untouched', () => {
    const full = { mspId: 'Org3MSP', certPath: 'c', keyPath: 'k' };

    expect(expandCollectionIdentities(config({
      collectionIdentities: { colA: full },
    })).colA).toBe(full);
  });

  it('lets an explicit entry override the derived one', () => {
    const full = { mspId: 'Org3MSP', certPath: 'c', keyPath: 'k' };

    expect(expandCollectionIdentities(config({
      orgIdentities: { Org2MSP: ORG2 },
      collectionIdentities: { '_implicit_org_Org2MSP': full },
    }))['_implicit_org_Org2MSP']).toBe(full);
  });

  it('refuses a reference to an unknown org, naming the collection and the org', () => {
    expect(() => expandCollectionIdentities(config({
      collectionIdentities: { colA: 'Org9MSP' },
    }))).toThrow(/collectionIdentities\["colA"\] names "Org9MSP"/);
  });

  it('refuses an org entry missing its cert or key, naming every missing field', () => {
    expect(() => expandCollectionIdentities(config({
      orgIdentities: { Org2MSP: { certPath: '', keyPath: '' } },
    }))).toThrow(/orgIdentities\["Org2MSP"\] is missing certPath, keyPath/);
  });

  it('is idempotent', () => {
    const cc = config({
      orgIdentities: { Org2MSP: ORG2 },
      collectionIdentities: { colA: 'Org2MSP' },
    });
    const once = expandCollectionIdentities(cc);

    expect(expandCollectionIdentities({ ...cc, collectionIdentities: once }))
      .toEqual(once);
  });
});

describe('withOrgRouting', () => {
  it('leaves a database config untouched', () => {
    const pg: ReplayConfig = {
      adapter: 'postgresql', inputDir: '/in', postgresql: { connectionString: 'x' },
    };

    expect(withOrgRouting(pg)).toBe(pg);
  });

  it('does not mutate the config it was given', () => {
    const cc = config({ mspMapping: { 'm-A': 'Org1MSP' } });
    withOrgRouting({ adapter: 'chaincode', inputDir: '/in', chaincode: cc });

    expect(cc.collectionMapping).toBeUndefined();
  });
});
