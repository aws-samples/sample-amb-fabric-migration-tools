import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { applyUpdate } from '../src/config/chain';
import { Bundle, checkBundle, describeChange, importSignatures, readBundle, sign, status, stepSignatures } from '../src/ceremony/bundle';
import { Configtxlator } from '../src/config/configtxlator';
import { identity } from '../src/config/signer';
import { Exit } from '../src/util/errors';
import { canon, sha256 } from '../src/util/misc';
import { makePki } from './helpers';

const hasCtl = ((): boolean => { try { execFileSync('configtxlator', ['version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
const pkiA = makePki(), pkiB = makePki();
afterAll(() => { pkiA.cleanup(); pkiB.cleanup(); });

const org = (name: string, root: string, version = '0') => ({ version, mod_policy: 'Admins', groups: {}, policies: {}, values: { MSP: { version: '0', mod_policy: 'Admins', value: { type: 0, config: { name, root_certs: [root] } } } } });
const cfg = (orgs: Record<string, unknown>, appVersion = '1') => ({ sequence: '1', channel_group: { version: '0', mod_policy: 'Admins', values: {}, policies: {}, groups: { Application: { version: appVersion, mod_policy: 'Admins', values: {}, policies: {}, groups: orgs }, Orderer: { version: '0', mod_policy: 'Admins', values: {}, policies: {}, groups: {} } } } });

/** A one-step bundle: OrgA, alone in the channel, adds OrgB. OrgA must sign. */
function makeBundle(): { dir: string; b: Bundle } {
  const dir = fs.mkdtempSync(path.join(pkiA.dir, 'bundle-'));
  for (const d of ['updates', 'configs', 'signatures']) fs.mkdirSync(path.join(dir, d));
  const before = cfg({ OrgA: org('OrgA', pkiA.caB64) });
  let after: ReturnType<typeof cfg> = cfg({ OrgA: org('OrgA', pkiA.caB64), OrgB: org('OrgB', pkiB.caB64) }, '2');
  after.sequence = '2';
  let upd: Buffer = Buffer.from('opaque update bytes') as Buffer;
  if (hasCtl) {
    upd = new Configtxlator().encode('common.ConfigUpdate', {
      channel_id: 'ch1',
      read_set: { groups: { Application: { groups: { OrgA: { version: '0' } }, version: '1' } } },
      write_set: { groups: { Application: { version: '2', mod_policy: 'Admins', groups: { OrgA: { version: '0' }, OrgB: org('OrgB', pkiB.caB64) } } } },
    });
    after = applyUpdate(before, new Configtxlator().decode('common.ConfigUpdate', upd));   // as export records it
  }
  fs.writeFileSync(path.join(dir, 'updates/1.pb'), upd);
  fs.writeFileSync(path.join(dir, 'configs/start.json'), JSON.stringify(before));
  fs.writeFileSync(path.join(dir, 'configs/1.json'), JSON.stringify(after));
  const b: Bundle = {
    schema: 1, kind: 'fabric-rebroadcast-config-bundle', channel: 'ch1', profile: 'self-managed', archive: { height: 3 }, startsAt: 1,
    startConfigSha256: sha256(canon(before)), createdAt: 'now',
    steps: [{ sourceBlock: 1, update: 'updates/1.pb', updateSha256: sha256(upd), signers: ['OrgA'], changed: ['Application'], changes: describeChange(before, after), before: 'configs/start.json', after: 'configs/1.json' }],
  };
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(b));
  return { dir, b };
}

describe('config-signing ceremony bundle', () => {
  it('describes a change in words', () => {
    const { b } = makeBundle();
    expect(b.steps[0].changes).toEqual(['+ Channel/Application/OrgB (added)']);
  });

  it('sign without --yes writes nothing; with it, one file per step the org signs, which verifies', () => {
    const { dir, b } = makeBundle();
    const id = identity('OrgA', pkiA.cert, pkiA.key);
    expect(sign(dir, b, id, false)).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, 'signatures'))).toEqual([]);
    sign(dir, b, id, true);
    expect(status(dir, b)).toEqual([{ sourceBlock: 1, needs: ['OrgA'], valid: ['OrgA'], missing: [], invalid: [] }]);
    expect(stepSignatures(dir, b, b.steps[0])).toHaveLength(1);
  });

  it('refuses to sign as an org with a certificate its MSP does not accept', () => {
    const { dir, b } = makeBundle();
    expect(() => sign(dir, b, identity('OrgA', pkiB.cert, pkiB.key), true)).toThrow(/does not chain to OrgA's roots/);
  });

  it('reports a missing signature, and run would stop with exit 10', () => {
    const { dir, b } = makeBundle();
    expect(status(dir, b)[0].missing).toEqual(['OrgA']);
    try { stepSignatures(dir, b, b.steps[0]); fail('expected exit 10'); } catch (e) { expect((e as { code: Exit }).code).toBe(Exit.SignaturesMissing); }
  });

  it('import refuses a forged signature, an org that is not a signer, and a file claiming another org', () => {
    const { dir, b } = makeBundle();
    const donor = makeBundle();
    sign(donor.dir, donor.b, identity('OrgA', pkiA.cert, pkiA.key), true);
    const f = JSON.parse(fs.readFileSync(path.join(donor.dir, 'signatures', fs.readdirSync(path.join(donor.dir, 'signatures'))[0]), 'utf8'));
    f.updateSha256 = b.steps[0].updateSha256;
    const out = path.join(pkiA.dir, `sigs-${Date.now()}`);
    fs.mkdirSync(out);
    const sig = Buffer.from(f.signature, 'base64');
    sig[sig.length - 3] ^= 0x01;                                          // one bit of s
    fs.writeFileSync(path.join(out, 'forged.json'), JSON.stringify({ ...f, signature: sig.toString('base64') }));
    fs.writeFileSync(path.join(out, 'not-a-signer.json'), JSON.stringify({ ...f, mspId: 'OrgB' }));
    fs.writeFileSync(path.join(out, 'other-step.json'), JSON.stringify({ ...f, sourceBlock: 7 }));
    const r = importSignatures(dir, b, [out]);
    expect(r.imported).toEqual([]);
    const why = Object.fromEntries(r.refused.map((x) => [path.basename(x.file), x.why]));
    expect(why['forged.json']).toMatch(/does not verify|high-S/);
    expect(why['not-a-signer.json']).toMatch(/OrgB is not a signer/);
    expect(why['other-step.json']).toMatch(/no step for source block 7/);
    expect(fs.readdirSync(path.join(dir, 'signatures'))).toEqual([]);
  });

  it('refuses a bundle whose update bytes changed after export', () => {
    const { dir } = makeBundle();
    fs.appendFileSync(path.join(dir, 'updates/1.pb'), 'x');
    expect(() => readBundle(dir)).toThrow(/does not match the hash recorded/);
  });

  (hasCtl ? it : it.skip)('a signer re-derives what the bytes do, and refuses a bundle whose recorded result they do not produce', () => {
    const { dir, b } = makeBundle();
    const ctl = new Configtxlator();
    expect(checkBundle(dir, b, ctl).get(1)).toEqual(['+ Channel/Application/OrgB (added)']);
    // the exporter claims a result the bytes do not give
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'configs/1.json'), 'utf8'));
    delete after.channel_group.groups.Application.groups.OrgB;
    fs.writeFileSync(path.join(dir, 'configs/1.json'), JSON.stringify(after));
    expect(() => checkBundle(dir, b, ctl)).toThrow(/does not produce the recorded result/);
  });
});
