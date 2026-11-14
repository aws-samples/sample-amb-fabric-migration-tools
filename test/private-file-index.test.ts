import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import {
  comparePrivateCollections,
  indexPrivateFiles,
} from '../src/output/private-file-index';
import { NdjsonReader } from '../src/replay/ndjson-reader';

let root: string;
let layout: FileLayoutManager;
let reader: NdjsonReader;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'private-index-test-'));
  layout = new FileLayoutManager(root);
  reader = new NdjsonReader();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write NDJSON lines to a path relative to the output root. */
function write(relative: string, lines: unknown[]): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    lines.map((l) => JSON.stringify(l)).join('\n'),
    'utf-8',
  );
}

function stateRecord(chaincode: string, collection: string, key = 'k1'): object {
  return {
    _type: 'private_state',
    channel: 'ch1',
    chaincode,
    collection,
    key,
    value: 'v1',
  };
}

// ── Naming ──

describe('FileLayoutManager private paths', () => {
  it('names the chaincode and the collection', () => {
    expect(layout.privateStatePath('ch1', 'assets', 'col1'))
      .toBe(path.join('channel-ch1', 'private-assets-col1-state.ndjson'));
    expect(layout.privateHistoryPath('ch1', 'assets', 'col1'))
      .toBe(path.join('channel-ch1', 'private-assets-col1-history.ndjson'));
    expect(layout.privateHashesPath('ch1', 'assets', 'col1'))
      .toBe(path.join('channel-ch1', 'private-assets-col1-hashes.ndjson'));
  });

  /**
   * The reason the chaincode is in the name at all: on Fabric 2.x every chaincode
   * on a channel holds an `_implicit_org_<MSPID>` of the same name, and one file
   * per collection put all of them together.
   */
  it('gives two chaincodes sharing a collection name separate files', () => {
    expect(layout.privateStatePath('ch1', 'assets', '_implicit_org_Org1MSP'))
      .not.toBe(layout.privateStatePath('ch1', 'trades', '_implicit_org_Org1MSP'));
  });

  it('gives the same pair the same name every time it asks', () => {
    expect(layout.privateStatePath('ch1', 'assets', 'col1'))
      .toBe(layout.privateStatePath('ch1', 'assets', 'col1'));
  });

  it('separates the same pair on different channels', () => {
    expect(layout.privateStatePath('ch1', 'assets', 'col1'))
      .not.toBe(layout.privateStatePath('ch2', 'assets', 'col1'));
  });

  /**
   * `sanitize` maps several names onto one, so a name built from two sanitized
   * fields cannot promise one file holds one pair. A merged file is exactly the
   * collision this layout exists to prevent, so the second claimant is refused
   * rather than appended to the first.
   */
  it('refuses a filename a second pair would share', () => {
    layout.privateStatePath('ch1', 'assets', 'col:1');

    expect(() => layout.privateStatePath('ch1', 'assets', 'col/1')).toThrow(
      /both resolve to private-assets-col_1-state.ndjson on channel ch1/,
    );
  });

  it('names both pairs and the remedy in the refusal', () => {
    layout.privateStatePath('ch1', 'assets', 'col:1');

    expect(() => layout.privateStatePath('ch1', 'assets', 'col/1')).toThrow(
      /Chaincode "assets" collection "col\/1" and chaincode "assets" collection "col:1"/,
    );
    expect(() => layout.privateStatePath('ch1', 'assets', 'col/1')).toThrow(
      /Rename one collection at the source/,
    );
  });

  /**
   * A collision is per file, so two pairs colliding on their state files must not
   * be reported against a history file neither has claimed.
   */
  it('tracks each kind of file separately', () => {
    layout.privateStatePath('ch1', 'assets', 'col:1');

    expect(() => layout.privateHistoryPath('ch1', 'assets', 'col/1'))
      .not.toThrow();
  });

  it('does not collide two pairs on different channels', () => {
    layout.privateStatePath('ch1', 'assets', 'col:1');

    expect(() => layout.privateStatePath('ch2', 'assets', 'col/1')).not.toThrow();
  });
});

// ── Reading back ──

describe('indexPrivateFiles', () => {
  it('reads the pair from the records, not the filename', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col1'), [
      stateRecord('assets', 'col1'),
    ]);

    await expect(indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson'))
      .resolves.toEqual([
        {
          file: 'private-assets-col1-state.ndjson',
          chaincode: 'assets',
          collection: 'col1',
        },
      ]);
  });

  /**
   * The names on disk are sanitized and the ones in the records are not, so a
   * consumer that parsed the filename would look up a collection the destination
   * has never heard of.
   */
  it('reports the unsanitized names the records carry', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col:1'), [
      stateRecord('assets', 'col:1'),
    ]);

    const found = await indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson');

    expect(found[0].collection).toBe('col:1');
    expect(found[0].file).toBe('private-assets-col_1-state.ndjson');
  });

  it('indexes only the kind of file asked for', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col1'), [
      stateRecord('assets', 'col1'),
    ]);
    write(layout.privateHashesPath('ch1', 'assets', 'col2'), [
      {
        _type: 'private_hash', channel: 'ch1', chaincode: 'assets',
        collection: 'col2', key: 'h1', hash: 'abc', blockNumber: 1,
        txId: 'tx1', txIndex: 0,
      },
    ]);

    const found = await indexPrivateFiles(reader, layout, 'ch1', '-hashes.ndjson');

    expect(found.map((f) => f.collection)).toEqual(['col2']);
  });

  /**
   * An empty file is what "this collection has no data" looks like on disk — a
   * member that was never authorized to read it, or one whose blockToLive window
   * has passed. Attributing it would make every consumer check a collection that
   * has nothing to check.
   */
  it('yields nothing for a file with no records', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'empty'), []);

    await expect(indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson'))
      .resolves.toEqual([]);
  });

  it('yields nothing for a channel directory that does not exist', async () => {
    await expect(indexPrivateFiles(reader, layout, 'nosuch', '-state.ndjson'))
      .resolves.toEqual([]);
  });

  /**
   * A record missing either field cannot be attributed, and the filename cannot
   * stand in for it. Leaving the file out is the safe reading: a consumer given a
   * guessed pair would compare one chaincode's data against another's.
   */
  it('leaves out a file whose records name no chaincode', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col1'), [
      { _type: 'private_state', channel: 'ch1', collection: 'col1', key: 'k1' },
    ]);

    await expect(indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson'))
      .resolves.toEqual([]);
  });

  it('leaves out a file whose records name no collection', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col1'), [
      { _type: 'private_state', channel: 'ch1', chaincode: 'assets', key: 'k1' },
    ]);

    await expect(indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson'))
      .resolves.toEqual([]);
  });

  /** A leading record that names nothing must not condemn the whole file. */
  it('skips past records that name nothing to one that does', async () => {
    write(layout.privateStatePath('ch1', 'assets', 'col1'), [
      { _type: 'private_state', channel: 'ch1', key: 'k1' },
      stateRecord('assets', 'col1', 'k2'),
    ]);

    const found = await indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson');

    expect(found.map((f) => f.chaincode)).toEqual(['assets']);
  });

  /**
   * Directory order is the filesystem's business, and two members' extractions
   * have to produce comparable reports — so the order is the pair's, not the
   * directory's.
   */
  /**
   * The directory listing is handed back in the order it comes off the
   * filesystem, which is nobody's contract. It is reversed here so the ordering
   * asserted below is the index's own and not the filesystem's.
   */
  it('orders by chaincode then collection', async () => {
    const files: string[] = [];
    for (const [chaincode, collection] of [
      ['assets', 'col1'], ['assets', 'col2'], ['trades', 'col1'],
    ]) {
      const relative = layout.privateStatePath('ch1', chaincode, collection);
      write(relative, [stateRecord(chaincode, collection)]);
      files.push(path.basename(relative));
    }
    jest.spyOn(layout, 'listPrivateFiles').mockReturnValue(files.reverse());

    const found = await indexPrivateFiles(reader, layout, 'ch1', '-state.ndjson');

    expect(found.map((f) => [f.chaincode, f.collection])).toEqual([
      ['assets', 'col1'], ['assets', 'col2'], ['trades', 'col1'],
    ]);
  });
});

describe('comparePrivateCollections', () => {
  it('orders by chaincode before collection', () => {
    expect(comparePrivateCollections(
      { chaincode: 'a', collection: 'z' },
      { chaincode: 'b', collection: 'a' },
    )).toBeLessThan(0);
  });

  it('falls back to the collection when the chaincode matches', () => {
    expect(comparePrivateCollections(
      { chaincode: 'a', collection: 'z' },
      { chaincode: 'a', collection: 'a' },
    )).toBeGreaterThan(0);
  });

  it('treats the same pair as equal', () => {
    expect(comparePrivateCollections(
      { chaincode: 'a', collection: 'b' },
      { chaincode: 'a', collection: 'b' },
    )).toBe(0);
  });
});
