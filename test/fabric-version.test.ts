import { Manifest } from '../src/types';
import {
  assessPrivateDataSupport,
  supportsImplicitCollections,
} from '../src/utils/fabric-version';
import { ExtractionError } from '../src/utils/errors';

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    networkId: 'n-TEST',
    memberId: 'm-TEST',
    region: 'us-east-1',
    stateDb: 'CouchDB',
    extractedAt: '2026-01-01T00:00:00.000Z',
    channels: [],
    ...overrides,
  };
}

describe('assessPrivateDataSupport', () => {
  test.each(['2.0', '2.2', '2.5', '3.0', '10.1'])(
    'reports support on FrameworkVersion %s',
    (ambFrameworkVersion) => {
      const support = assessPrivateDataSupport(manifest({ ambFrameworkVersion }));

      expect(support.supported).toBe(true);
      expect(support.frameworkVersion).toBe(ambFrameworkVersion);
      expect(support.reason).toContain('DeliverWithPrivateData');
    },
  );

  test.each(['1.2', '1.4', '1.4.12'])(
    'reports no support on FrameworkVersion %s',
    (ambFrameworkVersion) => {
      const support = assessPrivateDataSupport(manifest({ ambFrameworkVersion }));

      expect(support.supported).toBe(false);
      expect(support.frameworkVersion).toBe(ambFrameworkVersion);
      expect(support.reason).toContain('hashes from the block walk are the ceiling');
    },
  );

  test('tolerates surrounding whitespace', () => {
    expect(
      assessPrivateDataSupport(manifest({ ambFrameworkVersion: ' 2.2 ' })).supported,
    ).toBe(true);
  });

  // Both defaults lose data — assuming support calls an RPC that may not exist,
  // assuming none abandons private data that was recoverable — so an
  // unestablished version must stop the run rather than pick one.
  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses to guess when the version is %s', (_label, ambFrameworkVersion) => {
    expect(() =>
      assessPrivateDataSupport(manifest({ ambFrameworkVersion })),
    ).toThrow(ExtractionError);
    expect(() =>
      assessPrivateDataSupport(manifest({ ambFrameworkVersion })),
    ).toThrow(/ambFrameworkVersion/);
  });

  test('refuses a version it cannot compare against 2.0', () => {
    expect(() =>
      assessPrivateDataSupport(manifest({ ambFrameworkVersion: 'LATEST' })),
    ).toThrow(/not a Fabric version this tool can compare/);
  });

  // Channel capability is a property of the channel, the RPC is a property of
  // the binary: a 2.2 peer serves DeliverWithPrivateData on a channel still at
  // V1_2, so the capability must not stand in for the version.
  test('ignores fabricCapabilities entirely', () => {
    const support = assessPrivateDataSupport(
      manifest({
        ambFrameworkVersion: '2.2',
        fabricCapabilities: {
          application: 'V1_2',
          channel: 'V1_3',
          orderer: 'V1_1',
        },
      }),
    );

    expect(support.supported).toBe(true);
  });

  test('does not fall back to fabricVersion', () => {
    expect(() =>
      assessPrivateDataSupport(manifest({ fabricVersion: '2.x' })),
    ).toThrow(ExtractionError);
  });
});

describe('supportsImplicitCollections', () => {
  test.each(['2.0', '2.2', '2.5'])('is true for %s', (version) => {
    expect(supportsImplicitCollections(version)).toBe(true);
  });

  test.each(['1.2', '1.4'])('is false for %s', (version) => {
    expect(supportsImplicitCollections(version)).toBe(false);
  });

  // Synthesizing nothing is the safe answer for an unrecognised version:
  // inventing collections would report losses for data that never existed.
  test.each(['', 'unknown', 'v2.2'])(
    'is false for the unparseable version %p',
    (version) => {
      expect(supportsImplicitCollections(version)).toBe(false);
    },
  );
});
