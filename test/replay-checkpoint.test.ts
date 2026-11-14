import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ReplayCheckpointManager,
  checkpointFileName,
} from '../src/replay/replay-checkpoint-manager';
import { ReplayError } from '../src/utils/errors';

describe('ReplayCheckpointManager', () => {
  let tmpDir: string;
  let manager: ReplayCheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-checkpoint-test-'));
    manager = new ReplayCheckpointManager(tmpDir, 'postgresql');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const checkpointPath = (adapter: string): string =>
    path.join(tmpDir, checkpointFileName(adapter));

  describe('load()', () => {
    it('returns null when no checkpoint file exists', () => {
      expect(manager.load()).toBeNull();
    });

    it('returns checkpoint after update()', () => {
      manager.update('ch1/public-state', 500);
      const cp = manager.load();
      expect(cp).not.toBeNull();
      expect(cp!.lastFile).toBe('ch1/public-state');
      expect(cp!.recordsCompleted).toBe(500);
    });

    it('ignores a checkpoint belonging to a different adapter', () => {
      const other = new ReplayCheckpointManager(tmpDir, 'chaincode');
      other.update('ch1/public-state', 500);

      // Each adapter has its own file, so the chaincode run is invisible here
      expect(manager.load()).toBeNull();
    });

    it('throws when this adapter file names a different adapter', () => {
      // Only reachable by copying or hand-editing the file. Silently ignoring it
      // would discard a dirtyFile marker, so refuse instead.
      fs.writeFileSync(
        checkpointPath('postgresql'),
        JSON.stringify({
          version: 2,
          adapter: 'chaincode',
          lastFile: 'ch1/public-history',
          recordsCompleted: 500,
          files: ['ch1/public-history'],
          updatedAt: new Date().toISOString(),
          dirtyFile: 'ch1/public-history',
        }),
        'utf-8',
      );

      expect(() => manager.load()).toThrow(ReplayError);
      expect(() => manager.load()).toThrow(/names adapter 'chaincode'/);
    });

    it('refuses a legacy checkpoint without file-set binding', () => {
      fs.writeFileSync(
        checkpointPath('postgresql'),
        JSON.stringify({
          version: 1,
          adapter: 'postgresql',
          lastFile: 'ch1/public-history',
          recordsCompleted: 500,
          updatedAt: new Date().toISOString(),
        }),
        'utf-8',
      );

      expect(() => manager.load()).toThrow(/uses version 1.*requires version 2/s);
    });

    it('caches loaded checkpoint in memory', () => {
      manager.update('ch1/public-state', 100);

      const first = manager.load();
      const second = manager.load();
      expect(first).toBe(second); // same object reference from cache
    });

    it('throws ReplayError when checkpoint file is malformed', () => {
      fs.writeFileSync(checkpointPath('postgresql'), 'not valid json', 'utf-8');

      // Bypass the in-memory cache with a fresh manager
      const fresh = new ReplayCheckpointManager(tmpDir, 'postgresql');
      expect(() => fresh.load()).toThrow(/Failed to load replay checkpoint/);
    });
  });

  describe('update()', () => {
    it('writes checkpoint file with correct fields', () => {
      manager.update('identities', 1000);

      const cpPath = checkpointPath('postgresql');
      expect(fs.existsSync(cpPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
      expect(data.version).toBe(2);
      expect(data.adapter).toBe('postgresql');
      expect(data.lastFile).toBe('identities');
      expect(data.recordsCompleted).toBe(1000);
      expect(data.files).toEqual(['identities']);
      expect(data.updatedAt).toBeTruthy();
    });

    it('writes atomically — no .tmp file remains after update', () => {
      manager.update('ch1/public-state', 500);

      expect(fs.existsSync(checkpointPath('postgresql') + '.tmp')).toBe(false);
    });

    it('overwrites previous checkpoint on subsequent calls', () => {
      manager.update('ch1/public-state', 500);
      manager.update('ch1/public-state', 1000);

      const cp = manager.load();
      expect(cp!.recordsCompleted).toBe(1000);
    });

    it('advances to the next file', () => {
      manager.update('ch1/public-state', 5000);
      manager.update('ch1/public-history', 2000);

      const cp = manager.load();
      expect(cp!.lastFile).toBe('ch1/public-history');
      expect(cp!.recordsCompleted).toBe(2000);
    });
  });

  describe('clear()', () => {
    it('removes checkpoint file', () => {
      manager.update('ch1/public-state', 100);
      manager.clear();

      expect(fs.existsSync(checkpointPath('postgresql'))).toBe(false);
    });

    it('is safe to call when no checkpoint exists', () => {
      expect(() => manager.clear()).not.toThrow();
    });

    it('returns null from load() after clear()', () => {
      manager.update('ch1/public-state', 100);
      manager.clear();

      expect(manager.load()).toBeNull();
    });
  });

  describe('shouldSkipFile()', () => {
    const allFiles = ['identities', 'ch1/public-state', 'ch1/public-history', 'ch1/block-metadata'];

    it('returns false when no checkpoint exists', () => {
      expect(manager.shouldSkipFile('identities', allFiles)).toBe(false);
      expect(manager.shouldSkipFile('ch1/public-state', allFiles)).toBe(false);
    });

    it('returns false for the file currently in the checkpoint', () => {
      manager.update('ch1/public-state', 500, allFiles);
      // The checkpoint file itself may still be partially done — don't skip it
      expect(manager.shouldSkipFile('ch1/public-state', allFiles)).toBe(false);
    });

    it('returns true for files before the checkpointed file', () => {
      manager.update('ch1/public-history', 1000, allFiles);
      expect(manager.shouldSkipFile('identities', allFiles)).toBe(true);
      expect(manager.shouldSkipFile('ch1/public-state', allFiles)).toBe(true);
    });

    it('returns false for files at or after the checkpointed file', () => {
      manager.update('ch1/public-state', 500, allFiles);
      expect(manager.shouldSkipFile('ch1/public-state', allFiles)).toBe(false);
      expect(manager.shouldSkipFile('ch1/public-history', allFiles)).toBe(false);
      expect(manager.shouldSkipFile('ch1/block-metadata', allFiles)).toBe(false);
    });

    it('refuses when a new input file appears before the checkpoint', () => {
      manager.update('ch1/public-history', 1000, allFiles);
      const changed = [
        'identities', 'ch1/new-private-state',
        'ch1/public-state', 'ch1/public-history', 'ch1/block-metadata',
      ];
      expect(() => manager.shouldSkipFile('identities', changed))
        .toThrow(/input files changed/);
    });

    it('refuses when the checkpoint file order changes', () => {
      manager.update('ch1/public-history', 1000, allFiles);
      const reordered = [...allFiles].reverse();
      expect(() => manager.shouldSkipFile('identities', reordered))
        .toThrow(/input files changed/);
    });
  });

  describe('getResumeOffset()', () => {
    it('returns 0 when no checkpoint exists', () => {
      expect(manager.getResumeOffset('ch1/public-state')).toBe(0);
    });

    it('returns 0 for a file different from the checkpointed file', () => {
      manager.update('ch1/public-history', 2000);
      expect(manager.getResumeOffset('ch1/public-state')).toBe(0);
    });

    it('returns recordsCompleted for the checkpointed file', () => {
      manager.update('ch1/public-state', 45000);
      expect(manager.getResumeOffset('ch1/public-state')).toBe(45000);
    });

    it('reflects updated value after a second update on the same file', () => {
      manager.update('ch1/public-state', 500);
      manager.update('ch1/public-state', 1000);
      expect(manager.getResumeOffset('ch1/public-state')).toBe(1000);
    });
  });

  // The three targets are replayed from the same input directory, usually one
  // after another. A shared checkpoint file let each run overwrite the previous
  // target's state — including the dirtyFile marker that makes a failed Tier 3
  // history replay refuse to resume.
  describe('cross-adapter isolation', () => {
    let chaincode: ReplayCheckpointManager;

    beforeEach(() => {
      chaincode = new ReplayCheckpointManager(tmpDir, 'chaincode');
    });

    it('gives each adapter its own file', () => {
      chaincode.update('ch1/public-history', 300);
      manager.update('ch1/public-state', 700);

      expect(fs.existsSync(checkpointPath('chaincode'))).toBe(true);
      expect(fs.existsSync(checkpointPath('postgresql'))).toBe(true);
      expect(chaincode.getResumeOffset('ch1/public-history')).toBe(300);
      expect(manager.getResumeOffset('ch1/public-state')).toBe(700);
    });

    it("keeps a dirty marker when another adapter's replay updates progress", () => {
      chaincode.markDirty('ch1/public-history');
      manager.update('ch1/public-state', 500);

      const reread = new ReplayCheckpointManager(tmpDir, 'chaincode');
      expect(reread.getDirtyFile()).toBe('ch1/public-history');
    });

    it("keeps a dirty marker when another adapter's replay completes", () => {
      chaincode.markDirty('ch1/public-history');
      manager.update('ch1/public-state', 500);
      manager.clear();

      const reread = new ReplayCheckpointManager(tmpDir, 'chaincode');
      expect(reread.getDirtyFile()).toBe('ch1/public-history');
      expect(fs.existsSync(checkpointPath('chaincode'))).toBe(true);
    });

    it("does not resume one adapter from another adapter's progress", () => {
      chaincode.update('ch1/public-history', 900);

      expect(manager.load()).toBeNull();
      expect(manager.getResumeOffset('ch1/public-history')).toBe(0);
      expect(manager.shouldSkipFile('identities', ['identities', 'ch1/public-history'])).toBe(
        false,
      );
    });
  });
});
