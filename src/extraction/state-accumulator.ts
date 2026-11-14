import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Level } from 'level';
import { PublicStateRecord, FabricIdentity } from '../types';
import { createLogger } from '../utils/logger';
import { EncodedValue } from '../utils/value-codec';

const logger = createLogger('state-accumulator');

/**
 * Separator used to encode namespace + key into a single LevelDB key.
 * Null byte ensures no key collision between namespaces.
 */
const NS_SEP = '\x00';

/** V8 overhead for one map entry or one small object, in bytes. */
const OBJECT_OVERHEAD = 70;

/** V8 overhead for one string header, in bytes. */
const STRING_OVERHEAD = 40;

/**
 * Bytes charged for one live key or namespace, excluding its value.
 *
 * Exported because the capacity estimator has to predict the number that
 * triggers a LevelDB promotion, which is this accounting rather than real heap:
 * `--memory-limit` is compared against `estimatedMemoryBytes()`, and a second
 * guess at the same overhead in the estimator would drift from it silently.
 *
 * @param keyBytes UTF-8 length of the key or namespace.
 * @returns The map entry, the string header and the string itself.
 */
export function keyChargeBytes(keyBytes: number): number {
  return OBJECT_OVERHEAD + STRING_OVERHEAD + keyBytes;
}

export type StateBackend = 'auto' | 'memory' | 'leveldb';

export interface StateAccumulatorOptions {
  backend: StateBackend;
  /** Memory threshold in bytes before auto-promoting to LevelDB. Default: 512MB. */
  memoryLimitBytes: number;
  /** Directory for LevelDB storage. Default: os.tmpdir(). */
  dataDir?: string;
  /**
   * Bytes held in memory alongside the accumulator that count against the same
   * threshold: the private-data map, when the private pass runs during the walk.
   * The `auto` backend promotes once both together reach `memoryLimitBytes`.
   */
  alsoHeldBytes?: () => number;
}

// ── Interface ──

/** Encoded value + optional creator identity for a single state entry. */
export interface StateEntry extends EncodedValue {
  creator?: FabricIdentity;
}

export interface StateAccumulator {
  /** Apply a write: set the value (and creator) for namespace:key. */
  put(
    namespace: string,
    key: string,
    value: EncodedValue,
    creator?: FabricIdentity,
  ): Promise<void>;
  /** Apply a delete: remove the key from the namespace. */
  delete(namespace: string, key: string): Promise<void>;
  /** Iterate all accumulated state as PublicStateRecords for the given channel. */
  drain(channelId: string): AsyncIterable<PublicStateRecord>;
  /** Current estimated memory usage in bytes. */
  estimatedMemoryBytes(): number;
  /** Total number of live keys across all namespaces. */
  keyCount(): number;
  /** Which backend is currently active. */
  activeBackend(): 'memory' | 'leveldb';
  /** Clean up resources (close DB, remove temp files). */
  close(): Promise<void>;
}

// ── In-memory backend ──

export class InMemoryStateAccumulator implements StateAccumulator {
  private stateMap = new Map<string, Map<string, StateEntry>>();
  private keys = 0;
  private estimatedBytes = 0;
  /**
   * Creator objects already charged to the estimate.
   *
   * `parseCreator` caches identities, so one object is normally shared by every
   * key a signing identity ever wrote: charging each entry for a whole identity
   * would overstate a five-identity network by ~350 B per key. Charging each
   * distinct object once is accurate for both regimes — a network whose signers
   * fit the parse cache costs one identity, and one whose signers do not costs
   * what it actually retains.
   *
   * Weak so counting does not itself retain what it counts. Nothing is
   * subtracted when an entry is overwritten or deleted: another entry may hold
   * the same object, and over-counting a freed identity promotes to LevelDB
   * early where under-counting it runs the heap out.
   */
  private countedCreators = new WeakSet<FabricIdentity>();

  put(
    namespace: string,
    key: string,
    value: EncodedValue,
    creator?: FabricIdentity,
  ): Promise<void> {
    let nsMap = this.stateMap.get(namespace);
    if (!nsMap) {
      nsMap = new Map();
      this.stateMap.set(namespace, nsMap);
      this.estimatedBytes += keyChargeBytes(Buffer.byteLength(namespace, 'utf-8'));
    }

    const existing = nsMap.get(key);
    if (existing) {
      this.estimatedBytes -= Buffer.byteLength(existing.value, 'utf-8');
    } else {
      this.keys++;
      this.estimatedBytes += keyChargeBytes(Buffer.byteLength(key, 'utf-8'));
    }

    nsMap.set(key, { value: value.value, valueEncoding: value.valueEncoding, creator });
    this.estimatedBytes += Buffer.byteLength(value.value, 'utf-8');
    this.estimatedBytes += this.chargeCreator(creator);
    return Promise.resolve();
  }

  delete(namespace: string, key: string): Promise<void> {
    const nsMap = this.stateMap.get(namespace);
    if (nsMap) {
      const existing = nsMap.get(key);
      if (existing) {
        this.estimatedBytes -=
          keyChargeBytes(Buffer.byteLength(key, 'utf-8')) +
          Buffer.byteLength(existing.value, 'utf-8');
        nsMap.delete(key);
        this.keys--;
      }
    }
    return Promise.resolve();
  }

  /**
   * Bytes to add for an entry's creator: the object and its strings the first
   * time it is seen, nothing on every later entry that shares it.
   */
  private chargeCreator(creator?: FabricIdentity): number {
    if (!creator || this.countedCreators.has(creator)) return 0;
    this.countedCreators.add(creator);

    let bytes = OBJECT_OVERHEAD;
    for (const field of [
      creator.mspId,
      creator.certFingerprint,
      creator.commonName,
      creator.org,
    ]) {
      bytes += STRING_OVERHEAD + Buffer.byteLength(field, 'utf-8');
    }
    return bytes;
  }

  async *drain(channelId: string): AsyncIterable<PublicStateRecord> {
    for (const [namespace, keyValues] of this.stateMap) {
      for (const [key, entry] of keyValues) {
        yield {
          _type: 'public_state',
          channel: channelId,
          chaincode: namespace,
          key,
          value: entry.value,
          valueEncoding: entry.valueEncoding,
          creator: entry.creator,
        };
      }
    }
  }

  estimatedMemoryBytes(): number {
    return Math.max(0, this.estimatedBytes);
  }

  keyCount(): number {
    return this.keys;
  }

  activeBackend(): 'memory' {
    return 'memory';
  }

  /** Expose the raw map for bulk drain into LevelDB during promotion. */
  getRawMap(): Map<string, Map<string, StateEntry>> {
    return this.stateMap;
  }

  close(): Promise<void> {
    this.stateMap.clear();
    this.keys = 0;
    this.estimatedBytes = 0;
    return Promise.resolve();
  }
}

// ── LevelDB backend ──

export class LevelDbStateAccumulator implements StateAccumulator {
  private db: Level<string, string>;
  private dbPath: string;
  private keys = 0;
  private closed = false;

  constructor(dataDir?: string) {
    this.dbPath = path.join(
      dataDir ?? os.tmpdir(),
      `fab-extract-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    this.db = new Level(this.dbPath, { valueEncoding: 'utf8' });
  }

  async put(
    namespace: string,
    key: string,
    value: EncodedValue,
    creator?: FabricIdentity,
  ): Promise<void> {
    const compositeKey = namespace + NS_SEP + key;
    const existing = await this.db.get(compositeKey).catch((err: any) => {
      if (err?.code === 'LEVEL_NOT_FOUND') return undefined;
      throw err;
    });
    if (existing === undefined) {
      this.keys++;
    }
    const entry: StateEntry = {
      value: value.value,
      valueEncoding: value.valueEncoding,
      creator,
    };
    await this.db.put(compositeKey, JSON.stringify(entry));
  }

  async delete(namespace: string, key: string): Promise<void> {
    const compositeKey = namespace + NS_SEP + key;
    const existing = await this.db.get(compositeKey).catch((err: any) => {
      if (err?.code === 'LEVEL_NOT_FOUND') return undefined;
      throw err;
    });
    if (existing !== undefined) {
      await this.db.del(compositeKey);
      this.keys--;
    }
  }

  async *drain(channelId: string): AsyncIterable<PublicStateRecord> {
    for await (const [compositeKey, raw] of this.db.iterator()) {
      const sepIndex = compositeKey.indexOf(NS_SEP);
      const namespace = compositeKey.slice(0, sepIndex);
      const key = compositeKey.slice(sepIndex + 1);
      const entry: StateEntry = JSON.parse(raw);
      yield {
        _type: 'public_state',
        channel: channelId,
        chaincode: namespace,
        key,
        value: entry.value,
        valueEncoding: entry.valueEncoding,
        creator: entry.creator,
      };
    }
  }

  estimatedMemoryBytes(): number {
    // LevelDB uses a small in-memory buffer (~4MB write buffer by default)
    // plus OS page cache. Actual memory footprint is minimal.
    return 4 * 1024 * 1024;
  }

  keyCount(): number {
    return this.keys;
  }

  activeBackend(): 'leveldb' {
    return 'leveldb';
  }

  /**
   * Stream entries from an in-memory map into LevelDB in fixed-size batches.
   *
   * Each namespace is cleared once it has been transferred, so a channel with a
   * single chaincode holds its whole map until the end — and does not need
   * twice the budget anyway, because a written batch is on disk rather than in
   * the heap. *Measured: a map filled to a 192 MiB
   * estimate peaks at 191 MiB of heap across the promotion.*
   */
  async streamFrom(stateMap: Map<string, Map<string, StateEntry>>): Promise<void> {
    await this.db.open();
    const BATCH_SIZE = 2000;
    let batch = this.db.batch();
    let batchCount = 0;

    for (const [namespace, keyValues] of stateMap) {
      for (const [key, entry] of keyValues) {
        batch.put(namespace + NS_SEP + key, JSON.stringify(entry));
        this.keys++;
        batchCount++;

        if (batchCount >= BATCH_SIZE) {
          await batch.write();
          batch = this.db.batch();
          batchCount = 0;
        }
      }
      // Clear each namespace after transfer to release memory
      keyValues.clear();
    }

    if (batchCount > 0) {
      await batch.write();
    }
    stateMap.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.close();
    // Clean up temp directory
    try {
      fs.rmSync(this.dbPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ dbPath: this.dbPath, error: (err as Error).message }, 'Failed to clean up LevelDB temp dir');
    }
  }
}

// ── Auto-promoting hybrid ──

export class HybridStateAccumulator implements StateAccumulator {
  private current: InMemoryStateAccumulator | LevelDbStateAccumulator;
  private promoted = false;
  private readonly memoryLimitBytes: number;
  private readonly dataDir?: string;
  private readonly alsoHeldBytes: () => number;

  constructor(options: StateAccumulatorOptions) {
    this.memoryLimitBytes = options.memoryLimitBytes;
    this.dataDir = options.dataDir;
    this.alsoHeldBytes = options.alsoHeldBytes ?? (() => 0);

    if (options.backend === 'leveldb') {
      this.current = new LevelDbStateAccumulator(options.dataDir);
      this.promoted = true;
    } else {
      this.current = new InMemoryStateAccumulator();
    }
  }

  async put(
    namespace: string,
    key: string,
    value: EncodedValue,
    creator?: FabricIdentity,
  ): Promise<void> {
    await this.current.put(namespace, key, value, creator);

    if (
      !this.promoted &&
      this.current.estimatedMemoryBytes() + this.alsoHeldBytes() >= this.memoryLimitBytes
    ) {
      await this.promote();
    }
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.current.delete(namespace, key);
  }

  drain(channelId: string): AsyncIterable<PublicStateRecord> {
    return this.current.drain(channelId);
  }

  estimatedMemoryBytes(): number {
    return this.current.estimatedMemoryBytes();
  }

  keyCount(): number {
    return this.current.keyCount();
  }

  activeBackend(): 'memory' | 'leveldb' {
    return this.current.activeBackend();
  }

  async close(): Promise<void> {
    await this.current.close();
  }

  private async promote(): Promise<void> {
    if (this.promoted) return;
    this.promoted = true;

    const memAccumulator = this.current as InMemoryStateAccumulator;
    const keyCount = memAccumulator.keyCount();
    const memoryMb = (memAccumulator.estimatedMemoryBytes() / (1024 * 1024)).toFixed(1);

    logger.warn(
      {
        keyCount,
        estimatedMemoryMb: memoryMb,
        alsoHeldMb: (this.alsoHeldBytes() / (1024 * 1024)).toFixed(1),
        memoryLimitMb: (this.memoryLimitBytes / (1024 * 1024)).toFixed(0),
      },
      'Memory threshold reached — promoting state accumulator from in-memory to LevelDB',
    );

    const levelAccumulator = new LevelDbStateAccumulator(this.dataDir);
    await levelAccumulator.streamFrom(memAccumulator.getRawMap());
    await memAccumulator.close();
    this.current = levelAccumulator;

    logger.info(
      { keyCount, backend: 'leveldb' },
      'State accumulator promotion complete',
    );
  }
}

// ── Factory ──

const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024; // 512 MB

export function createStateAccumulator(options?: Partial<StateAccumulatorOptions>): StateAccumulator {
  const resolved: StateAccumulatorOptions = {
    backend: options?.backend ?? 'auto',
    memoryLimitBytes: options?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES,
    dataDir: options?.dataDir,
    alsoHeldBytes: options?.alsoHeldBytes,
  };

  switch (resolved.backend) {
    case 'memory':
      return new InMemoryStateAccumulator();
    case 'leveldb':
      return new LevelDbStateAccumulator(resolved.dataDir);
    case 'auto':
    default:
      return new HybridStateAccumulator(resolved);
  }
}
