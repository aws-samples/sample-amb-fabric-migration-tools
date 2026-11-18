// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractOptions, MigrationTier } from '../src/types';
import { checkProcessOptions, childArgs, runChannelProcesses } from '../src/extraction/extract-processes';
import { identityPartPath, writeIdentityRegistry } from '../src/extraction/identity-parts';
import { markStateReconstructionComplete } from '../src/extraction/state-completion';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { toExtractOptions } from '../src/cli/commands/extract';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'procs-test-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const opts = (extra: Partial<ExtractOptions> = {}): ExtractOptions => ({
  manifest: '', tier: MigrationTier.FullHistory, outputDir: root, batchSize: 100, strategy: 'auto',
  concurrency: 1, stateBackend: 'auto', memoryLimitMb: 3000, prefetchBuffer: 8, ...extra,
});

const ident = (msp: string, fp: string, first: number, last: number, n: number): string =>
  JSON.stringify({ _type: 'identity', mspId: msp, certFingerprint: fp, commonName: 'x', firstSeenBlock: first, lastSeenBlock: last, txCount: n });

describe('--processes', () => {
  it('builds each child from the parent arguments, one channel and a share of the memory limit', () => {
    const argv = ['/usr/bin/node', '/app/dist/cli/index.js', 'extract', '--manifest', 'm.json', '--tier', '3',
      '--channels', 'a', 'b', 'c', '--processes', '3', '--memory-limit=3000', '--output-dir', 'out', '--save-blocks', 'bk'];
    expect(childArgs(argv, 'b', 1000, 'channel-b/identities.part')).toEqual([
      'extract', '--manifest', 'm.json', '--tier', '3', '--output-dir', 'out', '--save-blocks', 'bk',
      '--channels', 'b', '--memory-limit', '1000', '--identities-out', 'channel-b/identities.part',
    ]);
  });

  it('parses the flag and refuses combinations that would share a file', () => {
    expect(toExtractOptions({ processes: 4 }).processes).toBe(4);
    expect(() => checkProcessOptions(opts({ processes: 4 }))).not.toThrow();
    expect(() => checkProcessOptions(opts({ processes: 1, extend: true }))).not.toThrow();
    expect(() => checkProcessOptions(opts({ processes: 0 }))).toThrow(/positive integer/);
    expect(() => checkProcessOptions(opts({ processes: 2, extend: true }))).toThrow(/--extend/);
    expect(() => checkProcessOptions(opts({ processes: 2, concurrency: 4 }))).toThrow(/replaces --concurrency/);
  });

  it('writes identities.ndjson from the part of every completed channel, replacing it', async () => {
    const layout = new FileLayoutManager(root);
    const put = (ch: string, lines: string[], complete = true): void => {
      const p = path.join(root, identityPartPath(layout, ch));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, lines.join('\n') + '\n');
      if (complete) markStateReconstructionComplete(root, layout, ch);
    };
    put('a', [ident('Org1MSP', 'f1', 2, 9, 5), ident('Org2MSP', 'f2', 3, 3, 1)]);
    put('b', [ident('Org1MSP', 'f1', 1, 4, 2)]);
    put('c', [ident('Org3MSP', 'f3', 1, 1, 1)], false); // unfinished: not in the registry
    fs.writeFileSync(path.join(root, 'identities.ndjson'), 'stale\n');
    expect(writeIdentityRegistry(root, layout.identitiesPath)).toBe(2);
    const out = fs.readFileSync(path.join(root, 'identities.ndjson'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(out.find((r) => r.mspId === 'Org1MSP')).toMatchObject({ firstSeenBlock: 1, lastSeenBlock: 9, txCount: 7 });
    expect(out.find((r) => r.mspId === 'Org2MSP')).toMatchObject({ txCount: 1 });
  });

  it('refuses to rebuild identities.ndjson when a completed channel has no part', () => {
    const layout = new FileLayoutManager(root);
    markStateReconstructionComplete(root, layout, 'a');
    expect(() => writeIdentityRegistry(root, layout.identitiesPath)).toThrow(/marked complete .* no identity part/s);
  });

  it('runs one child per channel, at most n at once, and fails naming the channels whose child failed', async () => {
    // A stand-in CLI: records its arguments and overlap, writes a part, fails for channel "bad".
    const stub = path.join(root, 'stub.js'), log = path.join(root, 'log');
    fs.writeFileSync(stub, `
      const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
      const ch = a[a.indexOf('--channels') + 1], part = a[a.indexOf('--identities-out') + 1], out = a[a.indexOf('--output-dir') + 1];
      fs.appendFileSync(${JSON.stringify(log)}, 'start ' + ch + '\\n');
      setTimeout(() => {
        fs.mkdirSync(path.dirname(path.join(out, part)), { recursive: true });
        fs.writeFileSync(path.join(out, part), ${JSON.stringify(ident('Org1MSP', 'f', 1, 1, 1))} + '\\n');
        if (ch !== 'bad') {
          fs.mkdirSync(path.join(out, 'channel-' + ch, 'checkpoints'), { recursive: true });
          fs.writeFileSync(path.join(out, 'channel-' + ch, 'checkpoints', 'state-reconstruction.complete'), JSON.stringify({ channelId: ch }));
        }
        fs.appendFileSync(${JSON.stringify(log)}, 'end ' + ch + '\\n');
        process.exit(ch === 'bad' ? 1 : 0);
      }, 150);`);
    const argv = (chs: string[]): string[] => ['node', stub, 'extract', '--output-dir', root, '--channels', ...chs, '--processes', '2'];

    await runChannelProcesses(opts({ processes: 2 }), ['a', 'b', 'c'], argv(['a', 'b', 'c']));
    const events = fs.readFileSync(log, 'utf-8').trim().split('\n');
    let open = 0, peak = 0;
    for (const e of events) { open += e.startsWith('start') ? 1 : -1; peak = Math.max(peak, open); }
    expect(peak).toBe(2);
    expect(events.filter((e) => e.startsWith('end')).length).toBe(3);
    expect(fs.readFileSync(path.join(root, 'identities.ndjson'), 'utf-8').trim().split('\n')).toHaveLength(1);

    fs.rmSync(path.join(root, 'identities.ndjson'));
    await expect(runChannelProcesses(opts({ processes: 2 }), ['a', 'bad'], argv(['a', 'bad']))).rejects.toThrow(/1 channel\(s\): bad/);
    expect(fs.existsSync(path.join(root, 'identities.ndjson'))).toBe(false);
  });
});
