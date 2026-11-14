import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { PublicStateRecord } from '../src/types';

describe('NdjsonWriter', () => {
  let tmpDir: string;
  let writer: NdjsonWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-test-'));
    writer = new NdjsonWriter(tmpDir);
  });

  afterEach(async () => {
    await writer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes a single record', async () => {
    const record: PublicStateRecord = {
      _type: 'public_state',
      channel: 'mychannel',
      chaincode: 'mycc',
      key: 'asset1',
      value: '{"color":"blue"}',
    };

    await writer.write('test.ndjson', record);
    await writer.close();

    const content = fs.readFileSync(path.join(tmpDir, 'test.ndjson'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed._type).toBe('public_state');
    expect(parsed.key).toBe('asset1');
  });

  test('writes a batch of records', async () => {
    const records: PublicStateRecord[] = [
      { _type: 'public_state', channel: 'ch', chaincode: 'cc', key: 'k1', value: 'v1' },
      { _type: 'public_state', channel: 'ch', chaincode: 'cc', key: 'k2', value: 'v2' },
      { _type: 'public_state', channel: 'ch', chaincode: 'cc', key: 'k3', value: 'v3' },
    ];

    await writer.writeBatch('batch.ndjson', records);
    await writer.close();

    const content = fs.readFileSync(path.join(tmpDir, 'batch.ndjson'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  test('creates subdirectories as needed', async () => {
    const record: PublicStateRecord = {
      _type: 'public_state',
      channel: 'ch',
      chaincode: 'cc',
      key: 'k',
      value: 'v',
    };

    await writer.write('channel-mychannel/public-state.ndjson', record);
    await writer.close();

    const filePath = path.join(tmpDir, 'channel-mychannel', 'public-state.ndjson');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test('tracks record counts', async () => {
    const record: PublicStateRecord = {
      _type: 'public_state',
      channel: 'ch',
      chaincode: 'cc',
      key: 'k',
      value: 'v',
    };

    await writer.write('counted.ndjson', record);
    await writer.write('counted.ndjson', record);

    expect(writer.getRecordCount('counted.ndjson')).toBe(2);
  });

  test('appends to existing file', async () => {
    const record: PublicStateRecord = {
      _type: 'public_state',
      channel: 'ch',
      chaincode: 'cc',
      key: 'k',
      value: 'v',
    };

    await writer.write('append.ndjson', { ...record, key: 'k1' });
    await writer.write('append.ndjson', { ...record, key: 'k2' });
    await writer.close();

    const content = fs.readFileSync(path.join(tmpDir, 'append.ndjson'), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).key).toBe('k1');
    expect(JSON.parse(lines[1]).key).toBe('k2');
  });

  // ── syncAll ──

  describe('syncAll', () => {
    test('makes buffered records readable without closing the writer', async () => {
      await writer.write('durable.ndjson', rec('k1'));
      writer.syncAll();

      const content = fs.readFileSync(path.join(tmpDir, 'durable.ndjson'), 'utf-8');
      expect(content.trim().split('\n')).toHaveLength(1);
    });

    test('holds a real descriptor for a freshly created stream', async () => {
      // The writer owns the descriptor rather than waiting for the stream's
      // async 'open' event; without that, the first sync after a create would
      // be a silent no-op.
      await writer.write('fresh.ndjson', rec('k1'));

      const fds: Map<string, number> = (writer as any).fds;
      const fd = fds.get(path.join(tmpDir, 'fresh.ndjson'));
      expect(typeof fd).toBe('number');
      expect(() => fs.fstatSync(fd!)).not.toThrow();
    });

    test('is a no-op when nothing has been written', () => {
      expect(() => writer.syncAll()).not.toThrow();
    });

    test('warns but does not throw when a descriptor is unsyncable', async () => {
      await writer.write('sync-fail.ndjson', rec('k1'));

      // A descriptor that is no longer valid: fsync yields EBADF.
      const fds: Map<string, number> = (writer as any).fds;
      fds.set(path.join(tmpDir, 'phantom.ndjson'), 99_999);

      expect(() => writer.syncAll()).not.toThrow();
    });

    test('stops fsyncing a file whose stream was discarded', async () => {
      await writer.write('discarded.ndjson', rec('k1'));
      await writer.truncate('discarded.ndjson');

      // Truncate closes the descriptor; syncing it again would be EBADF.
      const fds: Map<string, number> = (writer as any).fds;
      expect(fds.has(path.join(tmpDir, 'discarded.ndjson'))).toBe(false);
    });
  });

  // ── truncate ──

  describe('truncate', () => {
    test('discards records written before the reset', async () => {
      await writer.write('reset.ndjson', rec('stale1'));
      await writer.write('reset.ndjson', rec('stale2'));

      await writer.truncate('reset.ndjson');
      await writer.write('reset.ndjson', rec('fresh'));
      await writer.close();

      const lines = readLines('reset.ndjson');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).key).toBe('fresh');
    });

    test('re-derived records do not land after the abandoned attempt', async () => {
      // Streams open in append mode, so a truncate that only reset the counter
      // would leave the file starting with the abandoned attempt's records.
      for (const key of ['a', 'b', 'c']) {
        await writer.write('replayed.ndjson', rec(key));
      }
      await writer.truncate('replayed.ndjson');
      for (const key of ['a', 'b']) {
        await writer.write('replayed.ndjson', rec(key));
      }
      await writer.close();

      expect(readLines('replayed.ndjson').map((l) => JSON.parse(l).key)).toEqual([
        'a',
        'b',
      ]);
    });

    test('resets the record count', async () => {
      await writer.write('counted-reset.ndjson', rec('k1'));
      expect(writer.getRecordCount('counted-reset.ndjson')).toBe(1);

      await writer.truncate('counted-reset.ndjson');
      expect(writer.getRecordCount('counted-reset.ndjson')).toBe(0);
    });

    test('truncates a file left behind by an earlier process', async () => {
      // No stream open for it: the writer has to fall back to the path.
      const orphan = path.join(tmpDir, 'orphan.ndjson');
      fs.writeFileSync(orphan, '{"_type":"public_state"}\n');

      await writer.truncate('orphan.ndjson');

      expect(fs.statSync(orphan).size).toBe(0);
    });

    test('is a no-op for a file that does not exist', async () => {
      await expect(writer.truncate('never-written.ndjson')).resolves.toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, 'never-written.ndjson'))).toBe(false);
    });

    test('clears a stored stream error so the file can be rewritten', async () => {
      await writer.write('errored.ndjson', rec('k1'));
      // Simulate the stream having failed: the writer latches the first error
      // and rethrows it on every later write to that file.
      const stream = (writer as any).streams.get(
        path.join(tmpDir, 'errored.ndjson'),
      ) as fs.WriteStream;
      stream.emit('error', new Error('ENOSPC'));

      await expect(writer.write('errored.ndjson', rec('k2'))).rejects.toThrow(
        'ENOSPC',
      );

      await writer.truncate('errored.ndjson');
      await expect(writer.write('errored.ndjson', rec('k3'))).resolves.toBeUndefined();
    });
  });

  // ── Failure reporting ──

  // write() resolves as soon as a chunk is accepted into the stream's buffer,
  // long before the descriptor sees it. The next write to the same path rethrows
  // the latched error, but the last write to a path has no successor — so
  // close() is the only place a failure on the final batch can surface.
  describe('close', () => {
    test('reports a write that failed after it was accepted', async () => {
      const failing = new NdjsonWriter(tmpDir);
      await failing.write('lost.ndjson', rec('k1'));
      await failStream(failing, 'lost.ndjson', 'ENOSPC');

      await expect(failing.close()).rejects.toThrow(
        /lost\.ndjson failed.*must not be replayed.*ENOSPC/s,
      );
    });

    test('closes the healthy streams before reporting the failure', async () => {
      const failing = new NdjsonWriter(tmpDir);
      await failing.write('healthy.ndjson', rec('ok'));
      await failing.write('broken.ndjson', rec('k1'));
      await failStream(failing, 'broken.ndjson', 'EIO');

      await expect(failing.close()).rejects.toThrow(/broken\.ndjson/);

      expect(readLines('healthy.ndjson')).toHaveLength(1);
    });

    test('resolves when every stream is healthy', async () => {
      const clean = new NdjsonWriter(tmpDir);
      await clean.write('clean.ndjson', rec('k1'));

      await expect(clean.close()).resolves.toBeUndefined();
    });

    test('does not hang on a stream that is already destroyed', async () => {
      // end() on a destroyed stream neither calls back nor emits, so waiting
      // for its callback would never resolve.
      const failing = new NdjsonWriter(tmpDir);
      await failing.write('gone.ndjson', rec('k1'));
      const fullPath = path.join(tmpDir, 'gone.ndjson');
      const stream = (failing as any).streams.get(fullPath) as fs.WriteStream;
      await new Promise<void>((resolve) => {
        stream.once('close', () => resolve());
        stream.destroy();
      });

      await expect(failing.close()).resolves.toBeUndefined();
    });
  });

  describe('closeDir', () => {
    test('flushes and closes the files under one directory and leaves the others open', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.write('channel-a/x.ndjson', rec('a1'));
      await w.write('channel-ab/x.ndjson', rec('ab1'));
      await w.write('channel-b/x.ndjson', rec('b1'));

      await w.closeDir('channel-a');

      expect(readLines('channel-a/x.ndjson')).toHaveLength(1);
      const open = [...(w as any).streams.keys()].map((p: string) => path.relative(tmpDir, p)).sort();
      expect(open).toEqual(['channel-ab/x.ndjson', 'channel-b/x.ndjson']); // a sibling prefix is not under it
      await w.write('channel-b/x.ndjson', rec('b2'));
      await w.close();
      expect(readLines('channel-b/x.ndjson')).toHaveLength(2);
    });

    test('reports a failed write under that directory only', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.write('channel-a/x.ndjson', rec('a1'));
      await w.write('channel-b/x.ndjson', rec('b1'));
      await failStream(w, 'channel-b/x.ndjson', 'EIO');

      await expect(w.closeDir('channel-a')).resolves.toBeUndefined();
      await expect(w.closeDir('channel-b')).rejects.toThrow(/channel-b\/x\.ndjson failed.*EIO/s);
    });
  });

  describe('rejecting unhonourable writes', () => {
    test('refuses a write while a truncate of the same file is in flight', async () => {
      // The truncate would discard it: write() resolves once the record is
      // buffered, and truncate destroys the stream without flushing.
      const w = new NdjsonWriter(tmpDir);
      await w.write('racing.ndjson', rec('k1'));

      const truncating = w.truncate('racing.ndjson');
      await expect(w.write('racing.ndjson', rec('k2'))).rejects.toThrow(
        /while it is being truncated/,
      );
      await truncating;

      await w.write('racing.ndjson', rec('k3'));
      await w.close();
      expect(readLines('racing.ndjson').map((l) => JSON.parse(l).key)).toEqual(['k3']);
    });

    test('allows writes again once the truncate has resolved', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.truncate('never-existed.ndjson');

      await expect(w.write('never-existed.ndjson', rec('k1'))).resolves.toBeUndefined();
      await w.close();
    });

    test('completes a truncate of a stream that already errored', async () => {
      // An errored stream has already emitted 'close'; waiting for another
      // would never resolve.
      const w = new NdjsonWriter(tmpDir);
      await w.write('broken.ndjson', rec('k1'));
      await failStream(w, 'broken.ndjson', 'EIO');

      await expect(w.truncate('broken.ndjson')).resolves.toBeUndefined();
      await w.close();
    });

    test('stops fsyncing a descriptor closed by a stream error', async () => {
      // autoDestroy has already closed it; syncing it again is EBADF on a file
      // that is beyond saving anyway.
      const w = new NdjsonWriter(tmpDir);
      await w.write('errored.ndjson', rec('k1'));
      await failStream(w, 'errored.ndjson', 'EIO');

      expect((w as any).fds.has(path.join(tmpDir, 'errored.ndjson'))).toBe(false);
      expect(() => w.syncAll()).not.toThrow();
    });
  });

  // ── Backpressure ──

  // A stream lives as long as the extraction, so anything a single write leaves
  // attached to it accumulates for the whole run.
  describe('backpressured writes', () => {
    test('retains no listener per write', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.write('backpressure.ndjson', rec('first'));
      const stream = streamFor(w, 'backpressure.ndjson');

      let drains = 0;
      stream.on('drain', () => {
        drains++;
      });
      for (let i = 0; i < 50; i++) {
        await w.write('backpressure.ndjson', overflowing(`k${i}`, stream));
      }

      // Without backpressure the assertions below hold trivially.
      expect(drains).toBe(50);
      expect(stream.listenerCount('error')).toBe(1); // the writer's own latch
      expect(stream.listenerCount('drain')).toBe(1); // this test's counter
      expect(stream.listenerCount('close')).toBe(0);

      await w.close();
      expect(readLines('backpressure.ndjson')).toHaveLength(51);
    });

    test('retains no listener per batch', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.write('batch-backpressure.ndjson', rec('first'));
      const stream = streamFor(w, 'batch-backpressure.ndjson');

      let drains = 0;
      stream.on('drain', () => {
        drains++;
      });
      for (let i = 0; i < 50; i++) {
        await w.writeBatch('batch-backpressure.ndjson', [overflowing(`k${i}`, stream)]);
      }

      expect(drains).toBe(50);
      expect(stream.listenerCount('error')).toBe(1);
      expect(stream.listenerCount('drain')).toBe(1);
      expect(stream.listenerCount('close')).toBe(0);
      await w.close();
    });

    test('rejects with the stream failure rather than waiting for a drain', async () => {
      const w = new NdjsonWriter(tmpDir);
      await w.write('doomed.ndjson', rec('first'));
      const stream = streamFor(w, 'doomed.ndjson');

      const pending = w.write('doomed.ndjson', overflowing('k1', stream));
      stream.destroy(new Error('ENOSPC'));

      await expect(pending).rejects.toThrow('ENOSPC');
      expect(stream.listenerCount('drain')).toBe(0);
      expect(stream.listenerCount('close')).toBe(0);
    });

    test('rejects when the stream is discarded under it, rather than hanging', async () => {
      // truncate() destroys the stream without an error, so neither 'drain' nor
      // 'error' will ever arrive for a record already waiting on it.
      const w = new NdjsonWriter(tmpDir);
      await w.write('pulled.ndjson', rec('first'));
      const stream = streamFor(w, 'pulled.ndjson');

      const pending = w.write('pulled.ndjson', overflowing('k1', stream));
      const truncating = w.truncate('pulled.ndjson');

      await expect(pending).rejects.toThrow(
        /pulled\.ndjson closed while a record was waiting to drain/,
      );
      await truncating;
    });
  });

  function streamFor(target: NdjsonWriter, filePath: string): fs.WriteStream {
    return (target as any).streams.get(path.join(tmpDir, filePath)) as fs.WriteStream;
  }

  /** A record whose line cannot fit in the stream's buffer, so write() defers. */
  function overflowing(key: string, stream: fs.WriteStream): PublicStateRecord {
    return { ...rec(key), value: 'x'.repeat(stream.writableHighWaterMark * 2) };
  }

  /** Destroy a file's stream with an error, as a full disk would. */
  async function failStream(
    target: NdjsonWriter,
    filePath: string,
    message: string,
  ): Promise<void> {
    const stream = (target as any).streams.get(
      path.join(tmpDir, filePath),
    ) as fs.WriteStream;
    await new Promise<void>((resolve) => {
      stream.once('close', () => resolve());
      stream.destroy(new Error(message));
    });
  }

  function rec(key: string): PublicStateRecord {
    return {
      _type: 'public_state',
      channel: 'ch',
      chaincode: 'cc',
      key,
      value: `v-${key}`,
    };
  }

  function readLines(filePath: string): string[] {
    const content = fs.readFileSync(path.join(tmpDir, filePath), 'utf-8');
    return content.trim() === '' ? [] : content.trim().split('\n');
  }
});
