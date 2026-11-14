import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readNewestHashBlock } from '../src/extraction/private-data/newest-hash-block';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newest-hash-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(lines: string[]): string {
  const full = path.join(tmpDir, 'hashes.ndjson');
  fs.writeFileSync(full, lines.join('\n') + '\n', 'utf-8');
  return full;
}

function hashRecord(blockNumber: number): string {
  return JSON.stringify({
    _type: 'private_hash',
    channel: 'ch1',
    chaincode: 'mycc',
    collection: 'col1',
    key: `k-${blockNumber}`,
    hash: `h-${blockNumber}`,
    blockNumber,
    txId: `tx-${blockNumber}`,
    txIndex: 0,
  });
}

describe('readNewestHashBlock', () => {
  it('reads the block number of the only record', () => {
    expect(readNewestHashBlock(write([hashRecord(7)]))).toBe(7);
  });

  it('reads the last record rather than the first', () => {
    const full = write([hashRecord(1), hashRecord(4), hashRecord(9)]);

    expect(readNewestHashBlock(full)).toBe(9);
  });

  it('reads block zero rather than treating it as absent', () => {
    // A genesis-block write is a real block number, and confusing it with "no
    // block" would hand the purge window a collection it cannot explain.
    expect(readNewestHashBlock(write([hashRecord(0)]))).toBe(0);
  });

  it('reads the last record of a file longer than the tail window', () => {
    // Forces the read to start mid-file, so the first line in the window is a
    // fragment. Records are ~200 bytes and the window is 8 KB.
    const records = Array.from({ length: 200 }, (_, i) => hashRecord(i));

    const full = write(records);

    expect(fs.statSync(full).size).toBeGreaterThan(8192);
    expect(readNewestHashBlock(full)).toBe(199);
  });

  it('returns undefined for a missing file', () => {
    expect(
      readNewestHashBlock(path.join(tmpDir, 'nope.ndjson')),
    ).toBeUndefined();
  });

  it('returns undefined for an empty file', () => {
    const full = path.join(tmpDir, 'empty.ndjson');
    fs.writeFileSync(full, '', 'utf-8');

    expect(readNewestHashBlock(full)).toBeUndefined();
  });

  it('returns undefined for a file of only whitespace', () => {
    const full = path.join(tmpDir, 'blank.ndjson');
    fs.writeFileSync(full, '\n\n  \n', 'utf-8');

    expect(readNewestHashBlock(full)).toBeUndefined();
  });

  it('returns undefined when the last line is a truncated record', () => {
    const full = path.join(tmpDir, 'partial.ndjson');
    fs.writeFileSync(full, hashRecord(3) + '\n{"_type":"private_ha', 'utf-8');

    // A run killed mid-write. Reporting the earlier block would be wrong too:
    // the file is unreliable, so the horizon check does not run.
    expect(readNewestHashBlock(full)).toBeUndefined();
  });

  it('returns undefined when the last record has no block number', () => {
    expect(
      readNewestHashBlock(write([JSON.stringify({ _type: 'private_hash' })])),
    ).toBeUndefined();
  });

  it('returns undefined when the block number is not a number', () => {
    expect(
      readNewestHashBlock(write([JSON.stringify({ blockNumber: '9' })])),
    ).toBeUndefined();
  });

  it('returns undefined for a directory', () => {
    expect(readNewestHashBlock(tmpDir)).toBeUndefined();
  });
});
