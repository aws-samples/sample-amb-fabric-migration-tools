// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { adviseReplay, formatAdvice } from '../src/advise/replay-advisor';
import { checkChaincode } from '../src/advise/chaincode-check';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { Manifest, ReplayConfig } from '../src/types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advise-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function manifest(channels: Manifest['channels']): Manifest {
  const m: Manifest = { networkId: 'n', memberId: 'm-LEAD', region: 'us-east-1', stateDb: 'CouchDB', extractedAt: '', channels };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return m;
}
function write(rel: string, records: unknown[]): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const layout = () => new FileLayoutManager(dir);
const SECRET = 'SECRET-VALUE-9931';

/** n keys, the first one `deep` versions deep. */
function history(ch: string, n: number, deep: number, cc = 'cc') {
  const out = [];
  for (let v = 0; v < deep; v++) out.push({ _type: 'public_history', channel: ch, chaincode: cc, key: 'hot-KEY-NAME', value: SECRET, blockNumber: v, txIndex: 0, txId: `t${v}`, isDelete: false });
  for (let k = 0; k < n; k++) out.push({ _type: 'public_history', channel: ch, chaincode: cc, key: `k${k}`, value: SECRET, blockNumber: 1, txIndex: k, txId: `u${k}`, isDelete: false });
  return out;
}

function cfg(cc: Partial<NonNullable<ReplayConfig['chaincode']>> = {}, top: Partial<ReplayConfig> = {}): ReplayConfig {
  return { adapter: 'chaincode', inputDir: dir, ...top,
    chaincode: { connectionProfilePath: 'p', mspId: 'Org1MSP', certPath: 'c', keyPath: 'k', channelMapping: { a: 'a', b: 'b' }, replayHistory: true, ...cc } };
}

describe('adviseReplay', () => {
  beforeEach(() => {
    manifest([{ channelId: 'a', ledgerHeight: 10, chaincodes: [{ name: 'cc', version: '1', sequence: 1, collections: [] }] },
      { channelId: 'b', ledgerHeight: 10, chaincodes: [{ name: 'cc', version: '1', sequence: 1, collections: [] }] }]);
    write(layout().publicHistoryPath('a'), history('a', 50, 1000));
    write(layout().publicHistoryPath('b'), history('b', 50, 10));
  });

  it('profiles depth and makes the deep channel depth-bound at the given latency', async () => {
    const a = await adviseReplay({ inputDir: dir, config: cfg({ concurrency: 32, channelConcurrency: 2 }), commitLatencyMs: 320 });
    expect(a.profile.totals.maxVersions).toBe(1000);
    const chA = a.estimate.perChannel.find((p) => p.channelId === 'a')!;
    expect(chA.bound).toBe('depth');
    expect(chA.seconds).toBeCloseTo(1000 * 0.32, 0);
    expect(a.estimate.totalSeconds).toBeCloseTo(chA.seconds, 0);
    expect(a.findings.map((f) => f.id)).toContain('depth-bound');
  });

  it('recommends running channels in parallel and more concurrency, with the saving', async () => {
    const a = await adviseReplay({ inputDir: dir, config: cfg({}), commitLatencyMs: 300 });
    const ids = a.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['channel-concurrency', 'concurrency-low', 'unbound', 'one-shot']));
    expect(a.recommended.chaincode.channelConcurrency).toBe(2);
    expect(a.estimate.recommendedTotalSeconds).toBeLessThan(a.estimate.totalSeconds);
  });

  it('says when the latency is an assumption', async () => {
    const a = await adviseReplay({ inputDir: dir, config: cfg() });
    expect(a.estimate.commitLatencyMeasured).toBe(false);
    expect(a.findings.map((f) => f.id)).toContain('latency-assumed');
    expect(formatAdvice(a)).toContain('ASSUMED');
  });

  it('flags configs replay would refuse or misread', async () => {
    write(layout().privateHistoryPath('a', 'cc', '_implicit_org_m-BBB'), [{ _type: 'private_history', channel: 'a', chaincode: 'cc', collection: '_implicit_org_m-BBB', key: 'p', value: SECRET, blockNumber: 1, txIndex: 0, txId: 't', isDelete: false }]);
    const a = await adviseReplay({ inputDir: dir, config: cfg({ channelMapping: { a: 'a' } }), commitLatencyMs: 300 });
    const ids = a.findings.filter((f) => f.level !== 'info').map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['implicit-unmapped', 'channel-unmapped']));
    expect(a.findings.find((f) => f.id === 'implicit-unmapped')!.level).toBe('error');
  });

  it('flags replayHistory with no history to replay', async () => {
    fs.rmSync(path.join(dir, layout().publicHistoryPath('a')));
    fs.rmSync(path.join(dir, layout().publicHistoryPath('b')));
    write(layout().publicStatePath('a'), [{ _type: 'public_state', channel: 'a', chaincode: 'cc', key: 'k', value: SECRET }]);
    const a = await adviseReplay({ inputDir: dir, config: cfg(), commitLatencyMs: 300 });
    expect(a.findings[0]).toMatchObject({ level: 'error', id: 'history-without-history' });
  });

  /** Output goes to an assistant: shapes only. */
  it('never reports a key or a value', async () => {
    const a = await adviseReplay({ inputDir: dir, config: cfg(), commitLatencyMs: 300 });
    const text = JSON.stringify(a) + formatAdvice(a);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('hot-KEY-NAME');
  });
});

describe('checkChaincode', () => {
  const SHIPPED = path.join(__dirname, '..', 'sample', 'chaincode', 'migration_contract', 'go', 'migration.go');
  let src: string;

  function goPackage(writers: string, opts: { register?: boolean; v2?: boolean } = {}) {
    src = path.join(dir, 'cc');
    fs.mkdirSync(path.join(src, 'migration'), { recursive: true });
    fs.writeFileSync(path.join(src, 'go.mod'), `module x\nrequire github.com/hyperledger/fabric-contract-api-go${opts.v2 ? '/v2 v2.0.0' : ' v1.1.1'}\n`);
    fs.writeFileSync(path.join(src, 'main.go'), opts.register === false
      ? 'package main\nfunc main() { contractapi.NewChaincode(&App{}) }\n'
      : 'package main\nfunc main() { contractapi.NewChaincode(&App{}, &migration.MigrationContract{}) }\n');
    fs.writeFileSync(path.join(src, 'migration', 'migration.go'),
      fs.readFileSync(SHIPPED, 'utf-8').replace(/^var writerMSPIDs = \[\]string\{\}$/m, `var writerMSPIDs = []string{${writers}}`));
    fs.writeFileSync(path.join(src, 'collections_config.json'), JSON.stringify([
      { name: 'shared', policy: "OR('Org1MSP.member','Org2MSP.member')", requiredPeerCount: 0, maxPeerCount: 2, blockToLive: 0, memberOnlyWrite: true,
        endorsementPolicy: { signaturePolicy: "AND('Org1MSP.peer','Org2MSP.peer')" } },
    ]));
    fs.mkdirSync(path.join(src, 'META-INF/statedb/couchdb/indexes'), { recursive: true });
  }
  const m = () => manifest([{ channelId: 'ch1', ledgerHeight: 1, chaincodes: [{ name: 'app', version: '1', sequence: 1, collections: [
    { name: 'shared', policy: "OR('m-A.member','m-B.member')", requiredPeerCount: 0, maxPeerCount: 2, blockToLive: 0, memberOnlyRead: true, memberOnlyWrite: true },
  ] }] }]);
  const config = cfg({ mspMapping: { 'm-A': 'Org1MSP', 'm-B': 'Org2MSP' }, orgIdentities: { Org2MSP: { certPath: 'c', keyPath: 'k' } } });
  const errors = (r: ReturnType<typeof checkChaincode>) => r.findings.filter((f) => f.level === 'error').map((f) => f.id);

  it('passes a ready package', () => {
    goPackage('"Org1MSP", "Org2MSP"');
    const r = checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config, endorsement: 'and' });
    expect(errors(r)).toEqual([]);
    expect(r.writers).toEqual(['Org1MSP', 'Org2MSP']);
    expect(r.findings.find((f) => f.id === 'contract-revision')!.level).toBe('info');
  });

  it.each([
    ['a name the source does not have', () => checkChaincode({ sourceDir: src, name: 'app-v2', manifest: m(), config }), 'name'],
    ['an empty writer list', () => { goPackage(''); return checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }); }, 'writers-empty'],
    ['a writer the config submits as missing', () => { goPackage('"Org1MSP"'); return checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }); }, 'writers-missing'],
    ['an unregistered contract', () => { goPackage('"Org1MSP", "Org2MSP"', { register: false }); return checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }); }, 'not-registered'],
    ['contract-api v2', () => { goPackage('"Org1MSP", "Org2MSP"', { v2: true }); return checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }); }, 'go-dependency'],
  ])('refuses %s', (_label, run, id) => {
    goPackage('"Org1MSP", "Org2MSP"');
    expect(errors(run())).toContain(id);
  });

  it('flags a modified contract, source MSPs, purging and a missing collection-level policy', () => {
    goPackage('"Org1MSP", "Org2MSP"');
    fs.appendFileSync(path.join(src, 'migration', 'migration.go'), '\n// local edit\nfunc Extra() {}\n');
    fs.writeFileSync(path.join(src, 'collections_config.json'), JSON.stringify([
      { name: 'shared', policy: "OR('m-A.member','Org2MSP.member')", requiredPeerCount: 0, maxPeerCount: 2, blockToLive: 50, memberOnlyWrite: true },
    ]));
    const r = checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config, endorsement: 'majority' });
    const ids = r.findings.map((f) => `${f.level}:${f.id}`);
    expect(ids).toEqual(expect.arrayContaining(['warn:contract-revision', 'error:collection-source-msp', 'warn:collection-purges', 'error:collection-endorsement']));
  });

  it('refuses a source collection the destination config does not declare', () => {
    goPackage('"Org1MSP", "Org2MSP"');
    fs.writeFileSync(path.join(src, 'collections_config.json'), JSON.stringify([{ name: 'other', policy: "OR('Org1MSP.member')" }]));
    expect(errors(checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }))).toContain('collection-undeclared');
  });

  it('refuses a missing migration contract', () => {
    goPackage('"Org1MSP"');
    fs.rmSync(path.join(src, 'migration'), { recursive: true });
    expect(errors(checkChaincode({ sourceDir: src, name: 'app', manifest: m(), config }))).toContain('contract-missing');
  });
});
