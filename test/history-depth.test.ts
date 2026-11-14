import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatHistoryDepth, measureHistoryDepth } from '../src/output/history-depth';

function file(records: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
  const p = path.join(dir, 'public-history.ndjson');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

const h = (chaincode: string, key: string) =>
  ({ _type: 'public_history', channel: 'ch1', chaincode, key, value: 'v', txId: 't', blockNumber: 1, txIndex: 0, timestamp: '', isDelete: false });

describe('measureHistoryDepth', () => {
  it('finds the most-written key', async () => {
    const d = await measureHistoryDepth(file([h('a', 'k1'), h('a', 'k2'), h('a', 'k2'), h('a', 'k2')]));
    expect(d).toEqual({ versions: 4, keys: 2, maxVersions: 3, deepestKey: 'a/k2' });
  });

  /** One key name in two chaincodes is two keys with separate histories. */
  it('counts a key name per chaincode', async () => {
    const d = await measureHistoryDepth(file([h('a', 'k'), h('b', 'k'), h('b', 'k')]));
    expect(d.keys).toBe(2);
    expect(d.maxVersions).toBe(2);
    expect(d.deepestKey).toBe('b/k');
  });

  it('reports an empty file as no history', async () => {
    const p = file([]);
    fs.writeFileSync(p, '');
    expect(formatHistoryDepth(await measureHistoryDepth(p))).toBe('no history');
  });

  it('escapes the NUL in a composite key', () => {
    expect(formatHistoryDepth({ versions: 2, keys: 1, maxVersions: 2, deepestKey: 'a/\u0000t\u0000x\u0000' }))
      .toBe('2 versions over 1 keys, deepest 2 (a/\\0t\\0x\\0)');
  });
});
