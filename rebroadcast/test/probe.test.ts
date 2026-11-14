import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Archive } from '../src/archive/reader';
import { shapes } from '../src/plan/probe';
import { chain, writeArchive } from './helpers';

describe('probe burst shapes', () => {
  it('copies the archive\'s largest blocks by count and by bytes, without duplicates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-probe-'));
    try {
      const blocks = [...chain('ch1', 2, 1), ...chain('ch1', 3, 9).slice(2), ...chain('ch1', 4, 4).slice(3)];
      // relink is unnecessary for shapes(): it reads blocks, it does not verify the chain
      writeArchive(tmp, 'ch1', blocks);
      const s = shapes(new Archive(tmp, 'ch1'), 4);
      expect(s.map((x) => x.txs).sort((a, b) => b - a)).toEqual([9, 4, 1]);
      expect(s.every((x) => x.sizes.length === x.txs && x.sizes.every((b) => b > 0))).toBe(true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
