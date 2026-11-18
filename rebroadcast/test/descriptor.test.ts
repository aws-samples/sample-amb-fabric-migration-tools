// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { loadDescriptor } from '../src/descriptor';
import { transform } from '../src/config/transform';
import { makePki } from './helpers';

const pki = makePki();
afterAll(() => pki.cleanup());
const rel = (f: string): string => path.relative(pki.dir, f);

function write(d: object): string {
  const f = path.join(pki.dir, `d-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(d));
  return f;
}
const valid = (over: object = {}) => ({
  schema: 1, profile: 'self-managed',
  orderer: { mode: 'timeout', batchTimeout: '500ms', endpoints: [{ address: 'localhost:7050', tlsCa: rel(pki.caCert) }], reader: { msp: 'Ord', cert: rel(pki.cert), key: rel(pki.key) } },
  ordererOrg: { msp: 'Ord', admin: { cert: rel(pki.cert), key: rel(pki.key) } },
  orgs: { OrgA: { signer: { mode: 'local', cert: rel(pki.cert), key: rel(pki.key) }, rootCa: rel(pki.caCert), tlsRootCa: rel(pki.caCert), anchorPeers: [{ host: 'peer0.a', port: 7051 }] } },
  ordererOverrides: { BatchTimeout: '500ms', BatchSize: { max_message_count: 500 } },
  ...over,
});

describe('destination descriptor', () => {
  it('loads a valid descriptor and resolves paths against its own directory', () => {
    const ld = loadDescriptor(write(valid()));
    expect(ld.p(ld.d.orgs.OrgA.rootCa)).toBe(pki.caCert);
  });

  it.each([
    [{ extra: 1 }, /extra: unknown key/],
    [{ orderer: { mode: 'timeout', batchTimeout: '500ms', endpoints: [{ address: 'x:1', tlsCa: rel(pki.caCert), tslCa: 'typo' }], reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /orderer.endpoints\[0\].tslCa: unknown key/],
    [{ orderer: { mode: 'timeout', batchTimeout: '500ms', endpoints: [], reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /orderer.endpoints: needs at least one orderer/],
    [{ orderer: { mode: 'timeout', batchTimeout: '500ms', endpoints: [{ tlsCa: rel(pki.caCert) }], reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /orderer.endpoints\[0\].address: required/],
    [{ orderer: { mode: 'timeout', batchTimeout: '500ms', endpoints: [{ address: 'x:1', tlsCa: rel(pki.caCert) }, { address: 'x:1', tlsCa: rel(pki.caCert) }], reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /x:1 listed twice/],
    [{ orderer: { mode: 'timeout', batchTimeout: '500ms', endpoint: { address: 'x:1', tlsCa: rel(pki.caCert) }, reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /orderer.endpoint: unknown key/],
    [{ profile: 'provider' }, /platform: required/],
    [{ orderer: { mode: 'later', batchTimeout: '500ms', endpoints: [{ address: 'x:1', tlsCa: rel(pki.caCert) }], reader: { msp: 'O', cert: rel(pki.cert), key: rel(pki.key) } } }, /orderer.mode: must be one of/],
    [{ ordererOverrides: { BatchTimeout: '2s' } }, /must equal orderer.batchTimeout/],
    [{ orgs: { OrgA: { signer: { mode: 'local', cert: 'missing.pem', key: rel(pki.key) }, rootCa: rel(pki.caCert), tlsRootCa: rel(pki.caCert) } } }, /orgs.OrgA.signer.cert: missing.pem/],
  ])('refuses %j', (over, err) => {
    expect(() => loadDescriptor(write(valid(over)))).toThrow(err);
  });

  it('refuses cut markers on a provider (it would need the patched orderer)', () => {
    const d = valid({ profile: 'provider', platform: { msp: 'P', admin: { cert: rel(pki.cert), key: rel(pki.key) } } }) as ReturnType<typeof valid> & { orderer: { mode: string } };
    d.orderer.mode = 'cut-markers';
    expect(() => loadDescriptor(write(d))).toThrow(/cut-markers needs the patched orderer/);
  });
});

describe('config transform', () => {
  const src = () => ({
    sequence: '0',
    channel_group: {
      values: { OrdererAddresses: { value: { addresses: ['amb:30001'] } }, Capabilities: { value: { capabilities: { V2_0: {} } } } },
      groups: {
        Consortiums: {},
        Orderer: { values: { BatchTimeout: { value: { timeout: '2s' } }, BatchSize: { value: { max_message_count: 10 } } } },
        Application: {
          values: { Capabilities: { value: { capabilities: { V2_0: {} } } } },
          groups: { OrgA: { values: {
            MSP: { value: { config: { name: 'OrgA', root_certs: ['AMBROOT'], tls_root_certs: ['AMBTLS'], admins: ['AMBADMIN'], fabric_node_ous: { enable: true, admin_ou_identifier: { certificate: 'PIN', organizational_unit_identifier: 'admin' } } } } },
            AnchorPeers: { value: { anchor_peers: [{ host: 'amb-peer', port: 30003 }] } },
          } } },
        },
      },
    },
  });
  const dstCfg = () => ({
    channel_group: {
      values: { OrdererAddresses: { value: { addresses: ['dst:7050'] } }, Capabilities: { value: { capabilities: { V2_5: {} } } } },
      groups: { Orderer: { values: { BatchTimeout: { value: { timeout: '2s' } }, BatchSize: { value: { max_message_count: 10 } } } }, Application: { values: { Capabilities: { value: { capabilities: { V2_5: {} } } } } } },
    },
  });

  it('keeps the source\'s orgs, takes the destination\'s orderer, applies overrides, trusts our signer, unpins NodeOUs', () => {
    const ld = loadDescriptor(write(valid()));
    const out = transform(src(), dstCfg(), ld);
    const cg = out.channel_group;
    expect(cg.groups.Consortiums).toBeUndefined();
    expect(cg.values.OrdererAddresses.value.addresses).toEqual(['dst:7050']);
    expect(cg.groups.Orderer.values.BatchTimeout.value.timeout).toBe('500ms');
    expect(cg.groups.Orderer.values.BatchSize.value.max_message_count).toBe(500);
    const m = cg.groups.Application.groups.OrgA.values.MSP.value.config;
    expect(m.root_certs).toEqual(['AMBROOT', pki.caB64]);
    expect(m.tls_root_certs).toEqual(['AMBTLS', pki.caB64]);
    expect(m.admins).toEqual(['AMBADMIN', fs.readFileSync(pki.cert).toString('base64')]);
    expect(m.fabric_node_ous.admin_ou_identifier).toEqual({ organizational_unit_identifier: 'admin' });
    expect(cg.groups.Application.groups.OrgA.values.AnchorPeers.value.anchor_peers).toEqual([{ host: 'peer0.a', port: 7051 }]);
    // self-managed keeps the source's capability levels
    expect(cg.groups.Application.values.Capabilities.value.capabilities).toEqual({ V2_0: {} });
  });

  it('on a provider keeps the platform\'s capability levels and empties anchor peers', () => {
    const ld = loadDescriptor(write(valid({ profile: 'provider', platform: { msp: 'P', admin: { cert: rel(pki.cert), key: rel(pki.key) } } })));
    const out = transform(src(), dstCfg(), ld);
    expect(out.channel_group.groups.Application.values.Capabilities.value.capabilities).toEqual({ V2_5: {} });
    expect(out.channel_group.values.Capabilities.value.capabilities).toEqual({ V2_5: {} });
    expect(out.channel_group.groups.Application.groups.OrgA.values.AnchorPeers.value.anchor_peers).toEqual([]);
  });

  it('refuses a source org the descriptor does not cover', () => {
    const s = src();
    (s.channel_group.groups.Application.groups as Record<string, unknown>).OrgB = { values: { MSP: { value: { config: { name: 'OrgB' } } } } };
    expect(() => transform(s, dstCfg(), loadDescriptor(write(valid())))).toThrow(/no entry under "orgs" for source MSP OrgB/);
  });
});
