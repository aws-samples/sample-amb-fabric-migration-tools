import {
  formatCollectionPolicy,
  decodeCollectionConfigPackage,
} from '../src/discovery/chaincode-discoverer';

const fabproto6 = require('fabric-protos');

/** Encode an MSPRole as protobuf bytes (the format stored in MSPPrincipal.principal). */
function encodeMspRole(mspId: string, role: number): Uint8Array {
  return fabproto6.common.MSPRole.encode({ msp_identifier: mspId, role }).finish();
}

/** Build a SignaturePolicyEnvelope-shaped object with decoded MSPPrincipal entries. */
function buildPolicyConfig(
  identities: Array<{ mspId: string; role: number }>,
  rule: any,
): any {
  return {
    signature_policy: {
      identities: identities.map((id) => ({
        principal_classification: 0,
        principal: encodeMspRole(id.mspId, id.role),
      })),
      rule,
    },
  };
}

describe('formatCollectionPolicy', () => {
  test('OR policy with two orgs', () => {
    const policy = buildPolicyConfig(
      [
        { mspId: 'Org1MSP', role: 0 },
        { mspId: 'Org2MSP', role: 0 },
      ],
      { n_out_of: { n: 1, rules: [{ signed_by: 0 }, { signed_by: 1 }] } },
    );

    expect(formatCollectionPolicy(policy)).toBe(
      "OR('Org1MSP.member', 'Org2MSP.member')",
    );
  });

  test('AND policy with two orgs', () => {
    const policy = buildPolicyConfig(
      [
        { mspId: 'Org1MSP', role: 0 },
        { mspId: 'Org2MSP', role: 0 },
      ],
      { n_out_of: { n: 2, rules: [{ signed_by: 0 }, { signed_by: 1 }] } },
    );

    expect(formatCollectionPolicy(policy)).toBe(
      "AND('Org1MSP.member', 'Org2MSP.member')",
    );
  });

  test('OutOf policy (2-of-3)', () => {
    const policy = buildPolicyConfig(
      [
        { mspId: 'Org1MSP', role: 0 },
        { mspId: 'Org2MSP', role: 0 },
        { mspId: 'Org3MSP', role: 0 },
      ],
      {
        n_out_of: {
          n: 2,
          rules: [{ signed_by: 0 }, { signed_by: 1 }, { signed_by: 2 }],
        },
      },
    );

    expect(formatCollectionPolicy(policy)).toBe(
      "OutOf(2, 'Org1MSP.member', 'Org2MSP.member', 'Org3MSP.member')",
    );
  });

  test('single org policy', () => {
    const policy = buildPolicyConfig(
      [{ mspId: 'Org1MSP', role: 0 }],
      { signed_by: 0 },
    );

    expect(formatCollectionPolicy(policy)).toBe("'Org1MSP.member'");
  });

  test('different MSP role types', () => {
    const policy = buildPolicyConfig(
      [
        { mspId: 'Org1MSP', role: 1 }, // admin
        { mspId: 'Org2MSP', role: 3 }, // peer
        { mspId: 'Org3MSP', role: 2 }, // client
      ],
      {
        n_out_of: {
          n: 1,
          rules: [{ signed_by: 0 }, { signed_by: 1 }, { signed_by: 2 }],
        },
      },
    );

    expect(formatCollectionPolicy(policy)).toBe(
      "OR('Org1MSP.admin', 'Org2MSP.peer', 'Org3MSP.client')",
    );
  });

  test('nested policy: OR(AND(A,B), C)', () => {
    const policy = buildPolicyConfig(
      [
        { mspId: 'OrgA', role: 0 },
        { mspId: 'OrgB', role: 0 },
        { mspId: 'OrgC', role: 0 },
      ],
      {
        n_out_of: {
          n: 1,
          rules: [
            {
              n_out_of: {
                n: 2,
                rules: [{ signed_by: 0 }, { signed_by: 1 }],
              },
            },
            { signed_by: 2 },
          ],
        },
      },
    );

    expect(formatCollectionPolicy(policy)).toBe(
      "OR(AND('OrgA.member', 'OrgB.member'), 'OrgC.member')",
    );
  });

  test('null policy config returns empty string', () => {
    expect(formatCollectionPolicy(null)).toBe('');
    expect(formatCollectionPolicy(undefined)).toBe('');
  });

  test('policy config without signature_policy returns empty string', () => {
    expect(formatCollectionPolicy({})).toBe('');
    expect(formatCollectionPolicy({ other: 'field' })).toBe('');
  });

  test('JSON-decoded policy with object principals', () => {
    const policy = {
      signature_policy: {
        identities: [
          {
            principal_classification: 0,
            principal: { msp_identifier: 'Org1MSP', role: 'MEMBER' },
          },
          {
            principal_classification: 0,
            principal: { msp_identifier: 'Org2MSP', role: 'ADMIN' },
          },
        ],
        rule: {
          n_out_of: {
            n: 1,
            rules: [{ signed_by: 0 }, { signed_by: 1 }],
          },
        },
      },
    };

    expect(formatCollectionPolicy(policy)).toBe(
      "OR('Org1MSP.member', 'Org2MSP.admin')",
    );
  });

  test('JSON-decoded policy with camelCase field names', () => {
    const policy = {
      signaturePolicy: {
        identities: [
          {
            principal_classification: 0,
            principal: { mspIdentifier: 'MyOrg', role: 'PEER' },
          },
        ],
        rule: { signed_by: 0 },
      },
    };

    expect(formatCollectionPolicy(policy)).toBe("'MyOrg.peer'");
  });

  test('JSON-decoded policy with base64-encoded principal', () => {
    const roleBytes = encodeMspRole('Org1MSP', 0);
    const base64 = Buffer.from(roleBytes).toString('base64');

    const policy = {
      signature_policy: {
        identities: [
          { principal_classification: 0, principal: base64 },
        ],
        rule: { signed_by: 0 },
      },
    };

    expect(formatCollectionPolicy(policy)).toBe("'Org1MSP.member'");
  });
});

describe('decodeCollectionConfigPackage', () => {
  test('decodes protobuf-encoded CollectionConfigPackage with policy', () => {
    const roleBytes = encodeMspRole('Org1MSP', 0);

    const pkg = fabproto6.protos.CollectionConfigPackage.create({
      config: [
        {
          static_collection_config: {
            name: 'myCollection',
            member_orgs_policy: {
              signature_policy: {
                identities: [
                  { principal_classification: 0, principal: roleBytes },
                ],
                rule: { signed_by: 0 },
              },
            },
            required_peer_count: 1,
            maximum_peer_count: 3,
            block_to_live: 100,
            member_only_read: true,
            member_only_write: false,
          },
        },
      ],
    });

    const encoded = fabproto6.protos.CollectionConfigPackage
      .encode(pkg)
      .finish();
    const result = decodeCollectionConfigPackage(encoded);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('myCollection');
    expect(result[0].policy).toBe("'Org1MSP.member'");
    expect(result[0].requiredPeerCount).toBe(1);
    expect(result[0].maxPeerCount).toBe(3);
    expect(result[0].blockToLive).toBe(100);
    expect(result[0].memberOnlyRead).toBe(true);
    expect(result[0].memberOnlyWrite).toBe(false);
  });

  test('decodes package with multiple collections', () => {
    const org1 = encodeMspRole('Org1MSP', 0);
    const org2 = encodeMspRole('Org2MSP', 0);

    const pkg = fabproto6.protos.CollectionConfigPackage.create({
      config: [
        {
          static_collection_config: {
            name: 'privateData',
            member_orgs_policy: {
              signature_policy: {
                identities: [
                  { principal_classification: 0, principal: org1 },
                  { principal_classification: 0, principal: org2 },
                ],
                rule: {
                  n_out_of: {
                    n: 1,
                    rules: [{ signed_by: 0 }, { signed_by: 1 }],
                  },
                },
              },
            },
            required_peer_count: 0,
            maximum_peer_count: 2,
          },
        },
        {
          static_collection_config: {
            name: 'secretData',
            member_orgs_policy: {
              signature_policy: {
                identities: [
                  { principal_classification: 0, principal: org1 },
                ],
                rule: { signed_by: 0 },
              },
            },
            required_peer_count: 1,
            maximum_peer_count: 1,
          },
        },
      ],
    });

    const encoded = fabproto6.protos.CollectionConfigPackage
      .encode(pkg)
      .finish();
    const result = decodeCollectionConfigPackage(encoded);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('privateData');
    expect(result[0].policy).toBe(
      "OR('Org1MSP.member', 'Org2MSP.member')",
    );
    expect(result[1].name).toBe('secretData');
    expect(result[1].policy).toBe("'Org1MSP.member'");
  });

  test('handles collection without policy gracefully', () => {
    const pkg = fabproto6.protos.CollectionConfigPackage.create({
      config: [
        {
          static_collection_config: {
            name: 'noPolicyCollection',
            required_peer_count: 0,
            maximum_peer_count: 1,
          },
        },
      ],
    });

    const encoded = fabproto6.protos.CollectionConfigPackage
      .encode(pkg)
      .finish();
    const result = decodeCollectionConfigPackage(encoded);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('noPolicyCollection');
    expect(result[0].policy).toBe('');
  });

  test('skips entries without static_collection_config', () => {
    const pkg = fabproto6.protos.CollectionConfigPackage.create({
      config: [{}],
    });

    const encoded = fabproto6.protos.CollectionConfigPackage
      .encode(pkg)
      .finish();
    const result = decodeCollectionConfigPackage(encoded);

    expect(result).toHaveLength(0);
  });
});
