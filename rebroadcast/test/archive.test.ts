// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Archive } from '../src/archive/reader';
import { decodeBlock } from '../src/fabric/blocks';
import { Exit } from '../src/util/errors';
import { parseDeliverResponse } from '../src/orderer/client';
import { chain, writeArchive } from './helpers';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-arch-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('archive reader', () => {
  it('opens the layout extract --save-blocks writes, from the root or the channel directory, and verifies it', () => {
    writeArchive(tmp, 'ch1', chain('ch1', 6));
    const a = new Archive(tmp, 'ch1');
    expect(a.height).toBe(6);
    expect(a.channel).toBe('ch1');
    expect(a.verify()).toBe(6);
    expect(new Archive(path.join(tmp, 'ch1')).height).toBe(6);
  });

  it('refuses a block that differs from its sealed digest', () => {
    const dir = writeArchive(tmp, 'ch1', chain('ch1', 4));
    fs.writeFileSync(path.join(dir, 'blocks', '2.block'), chain('ch1', 4, 3)[2]);
    expect(() => new Archive(tmp, 'ch1').verify()).toThrow(/block 2 does not match its sealed digest/);
  });

  it('refuses a broken hash chain even where digests agree (a bare directory)', () => {
    const blocks = chain('ch1', 4);
    blocks[2] = chain('ch1', 4, 3)[2];
    blocks.forEach((b, n) => fs.writeFileSync(path.join(tmp, `${n}.block`), b));
    const a = new Archive(tmp);
    expect(a.warnings[0]).toMatch(/no manifest/);
    expect(() => a.verify()).toThrow(/block 2: previous_hash does not match block 1/);
  });

  it('refuses a digest list altered after sealing', () => {
    const dir = writeArchive(tmp, 'ch1', chain('ch1', 3));
    fs.appendFileSync(path.join(dir, 'blocks', 'blocks.sha256'), '\n');
    expect(() => new Archive(tmp, 'ch1')).toThrow(/does not match the digest recorded/);
  });

  it('refuses an archive not sealed as complete', () => {
    const dir = writeArchive(tmp, 'ch1', chain('ch1', 3));
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, complete: false }));
    expect(() => new Archive(tmp, 'ch1')).toThrow(/not sealed as complete/);
  });

  it('refuses another channel\'s archive with the channel-name exit code', () => {
    const dir = writeArchive(tmp, 'ch2', chain('ch2', 3));
    try { new Archive(dir, 'ch1'); fail('expected a refusal'); } catch (e) { expect((e as { code: Exit }).code).toBe(Exit.ChannelName); }
  });

  it('decodes what the tool needs and keeps the envelopes byte-exact', () => {
    const blocks = chain('ch1', 3, 4);
    const b = decodeBlock(blocks[1]);
    expect(b).toMatchObject({ number: 1, isConfig: false });
    expect(b.txs.map((t) => t.txId)).toEqual(['tx-1-0', 'tx-1-1', 'tx-1-2', 'tx-1-3']);
    expect(b.txs[0]).toMatchObject({ channel: 'ch1', mspId: 'OrgA', type: 'ENDORSER_TRANSACTION', code: 'VALID' });
    expect(decodeBlock(blocks[0]).isConfig).toBe(true);
  });
});

describe('Deliver responses', () => {
  it('reads a status', () => {
    expect(parseDeliverResponse(Buffer.from([0x08, 200, 1]))).toEqual({ status: 'SUCCESS' });
    expect(parseDeliverResponse(Buffer.from([0x08, 0xf7, 0x03]))).toEqual({ status: 'SERVICE_UNAVAILABLE' });
  });
  it('takes a block\'s bytes without decoding, with a multi-byte length', () => {
    const block = Buffer.alloc(300, 7);
    const r = parseDeliverResponse(Buffer.concat([Buffer.from([0x12, 0xac, 0x02]), block]));
    expect(r.block!.equals(block)).toBe(true);
  });
});
