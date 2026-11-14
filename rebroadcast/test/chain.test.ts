import { applyUpdate, firstDiff, touchesOrdererOrChannel, appOrgs } from '../src/config/chain';

const org = (name: string, version = '0') => ({ version, mod_policy: 'Admins', groups: {}, values: { MSP: { version: '0', mod_policy: 'Admins', value: { config: { name } } } }, policies: {} });
const base = () => ({
  sequence: '3',
  channel_group: {
    version: '0', mod_policy: 'Admins', policies: {}, values: { Capabilities: { version: '0', mod_policy: 'Admins', value: { v: 1 } } },
    groups: {
      Application: { version: '1', mod_policy: 'Admins', policies: {}, values: { ACLs: { version: '0', mod_policy: 'Admins', value: { a: 1 } } }, groups: { A: org('A'), B: org('B') } },
      Orderer: { version: '0', mod_policy: 'Admins', policies: {}, groups: {}, values: { BatchTimeout: { version: '0', mod_policy: 'Admins', value: { timeout: '2s' } } } },
    },
  },
});

describe('applying a config update offline', () => {
  it('adds an org: the group version rises, every listed child is kept or taken, the sequence advances', () => {
    const cur = base();
    const upd = { write_set: { version: '0', groups: { Application: { version: '2', mod_policy: 'Admins', values: { ACLs: { version: '0' } }, policies: {}, groups: { A: { version: '0' }, B: { version: '0' }, C: org('C') } } } } };
    const next = applyUpdate(cur, upd);
    expect(next.sequence).toBe('4');
    expect(appOrgs(next).sort()).toEqual(['A', 'B', 'C']);
    // references (same version) keep the config's own copy, not the write set's stub
    expect(next.channel_group.groups.Application.groups.A).toEqual(org('A'));
    expect(next.channel_group.groups.Application.values.ACLs.value).toEqual({ a: 1 });
    // untouched siblings survive
    expect(next.channel_group.groups.Orderer).toEqual(cur.channel_group.groups.Orderer);
  });

  it('removes an org: a bumped group that leaves a child out deletes it', () => {
    const upd = { write_set: { version: '0', groups: { Application: { version: '2', mod_policy: 'Admins', values: { ACLs: { version: '0' } }, policies: {}, groups: { A: { version: '0' } } } } } };
    expect(appOrgs(applyUpdate(base(), upd))).toEqual(['A']);
  });

  it('changes one value: an unbumped group keeps children the write set leaves out', () => {
    const upd = { write_set: { version: '0', groups: { Orderer: { version: '0', values: { BatchTimeout: { version: '1', mod_policy: 'Admins', value: { timeout: '500ms' } } } } } } };
    const next = applyUpdate(base(), upd);
    expect(next.channel_group.groups.Orderer.values.BatchTimeout).toEqual({ version: '1', mod_policy: 'Admins', value: { timeout: '500ms' } });
    expect(appOrgs(next).sort()).toEqual(['A', 'B']);
  });

  it('says when an update needs the orderer org: Orderer group or channel-level values', () => {
    const cur = base();
    expect(touchesOrdererOrChannel(cur, { write_set: { version: '0', groups: { Orderer: { version: '0', values: { BatchTimeout: { version: '1' } } } } } })).toBe(true);
    expect(touchesOrdererOrChannel(cur, { write_set: { version: '0', values: { Capabilities: { version: '1' } } } })).toBe(true);
    expect(touchesOrdererOrChannel(cur, { write_set: { version: '0', groups: { Application: { version: '2' } } } })).toBe(false);
  });

  it('names the first differing path', () => {
    const a = base(), b = base();
    b.channel_group.groups.Orderer.values.BatchTimeout.value.timeout = '1s';
    expect(firstDiff(a, b)).toBe('/channel_group/groups/Orderer/values/BatchTimeout/value/timeout: 2s != 1s');
    expect(firstDiff(a, base())).toBeNull();
  });
});
