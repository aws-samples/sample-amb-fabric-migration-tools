// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';

describe('CheckpointManager', () => {
  let tmpDir: string;
  let manager: CheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    manager = new CheckpointManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns null for non-existent checkpoint', () => {
    expect(manager.load('mychannel', 'block-walk')).toBeNull();
  });

  test('returns -1 for non-existent block number', () => {
    expect(manager.getLastBlockNumber('mychannel', 'block-walk')).toBe(-1);
  });

  test('saves and loads a checkpoint', () => {
    manager.save({
      channel: 'mychannel',
      strategy: 'block-walk',
      lastBlockNumber: 42,
      updatedAt: '',
    });

    const loaded = manager.load('mychannel', 'block-walk');
    expect(loaded).not.toBeNull();
    expect(loaded!.lastBlockNumber).toBe(42);
    expect(loaded!.updatedAt).toBeTruthy();
  });

  test('updates block number', () => {
    manager.updateBlock('mychannel', 'block-walk', 10);
    expect(manager.getLastBlockNumber('mychannel', 'block-walk')).toBe(10);

    manager.updateBlock('mychannel', 'block-walk', 20);
    expect(manager.getLastBlockNumber('mychannel', 'block-walk')).toBe(20);
  });

  test('saves and retrieves bookmark', () => {
    manager.updateBookmark('mychannel', 'public-state', 'bookmark-abc');
    expect(manager.getBookmark('mychannel', 'public-state')).toBe('bookmark-abc');
  });

  test('preserves bookmark when updating block number', () => {
    manager.save({
      channel: 'mychannel',
      strategy: 'public-state',
      lastBlockNumber: 5,
      lastBookmark: 'bm-123',
      updatedAt: '',
    });

    manager.updateBlock('mychannel', 'public-state', 10);
    expect(manager.getBookmark('mychannel', 'public-state')).toBe('bm-123');
    expect(manager.getLastBlockNumber('mychannel', 'public-state')).toBe(10);
  });

  test('writes checkpoint file atomically', () => {
    manager.updateBlock('mychannel', 'block-walk', 100);

    const filePath = path.join(tmpDir, 'mychannel-block-walk.json');
    expect(fs.existsSync(filePath)).toBe(true);

    // No .tmp file should remain
    const tmpFile = filePath + '.tmp';
    expect(fs.existsSync(tmpFile)).toBe(false);

    // File should be valid JSON
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.lastBlockNumber).toBe(100);
  });

  test('caches loaded checkpoints', () => {
    manager.updateBlock('ch1', 'block-walk', 50);

    // Load twice — second should come from cache
    const first = manager.load('ch1', 'block-walk');
    const second = manager.load('ch1', 'block-walk');
    expect(first).toEqual(second);
  });

  test('handles multiple channels independently', () => {
    manager.updateBlock('channel-a', 'block-walk', 100);
    manager.updateBlock('channel-b', 'block-walk', 200);

    expect(manager.getLastBlockNumber('channel-a', 'block-walk')).toBe(100);
    expect(manager.getLastBlockNumber('channel-b', 'block-walk')).toBe(200);
  });

  // recordBlock() exists so a block walk can advance 8M times without paying a
  // stringify-write-rename per block. The value stays exact in memory; only the
  // file waits.
  describe('recordBlock and flush', () => {
    /** lastBlockNumber as a run that has only the files would read it. */
    function onDisk(channel: string, strategy: string): number {
      return new CheckpointManager(tmpDir).getLastBlockNumber(channel, strategy);
    }

    test('recordBlock advances the checkpoint without touching the file', () => {
      manager.recordBlock('mychannel', 'block-walk', 7);

      expect(manager.getLastBlockNumber('mychannel', 'block-walk')).toBe(7);
      expect(fs.existsSync(path.join(tmpDir, 'mychannel-block-walk.json'))).toBe(false);
    });

    test('flush writes the last block recorded, in one write', () => {
      const written = jest.spyOn(manager, 'save');

      for (let block = 0; block < 50; block++) {
        manager.recordBlock('mychannel', 'block-walk', block);
      }
      expect(written).not.toHaveBeenCalled();

      manager.flush();

      expect(written).toHaveBeenCalledTimes(1);
      expect(onDisk('mychannel', 'block-walk')).toBe(49);
    });

    test('flush covers every checkpoint that advanced', () => {
      manager.recordBlock('channel-a', 'block-walk', 11);
      manager.recordBlock('channel-b', 'block-walk', 22);
      manager.recordBlock('channel-a', 'pvtdata-delivery', 33);

      manager.flush();

      expect(onDisk('channel-a', 'block-walk')).toBe(11);
      expect(onDisk('channel-b', 'block-walk')).toBe(22);
      expect(onDisk('channel-a', 'pvtdata-delivery')).toBe(33);
    });

    test('flush writes nothing when no block was recorded since the last one', () => {
      manager.recordBlock('mychannel', 'block-walk', 5);
      manager.flush();

      const written = jest.spyOn(manager, 'save');
      manager.flush();

      expect(written).not.toHaveBeenCalled();
    });

    test('an immediate updateBlock leaves nothing pending behind it', () => {
      manager.recordBlock('mychannel', 'block-walk', 5);
      manager.updateBlock('mychannel', 'block-walk', 6);

      const written = jest.spyOn(manager, 'save');
      manager.flush();

      expect(written).not.toHaveBeenCalled();
      expect(onDisk('mychannel', 'block-walk')).toBe(6);
    });

    test('recordBlock preserves a bookmark the file already holds', () => {
      manager.save({
        channel: 'mychannel',
        strategy: 'public-state',
        lastBlockNumber: 5,
        lastBookmark: 'bm-123',
        updatedAt: '',
      });

      manager.recordBlock('mychannel', 'public-state', 10);
      manager.flush();

      expect(new CheckpointManager(tmpDir).getBookmark('mychannel', 'public-state')).toBe('bm-123');
    });
  });
});
