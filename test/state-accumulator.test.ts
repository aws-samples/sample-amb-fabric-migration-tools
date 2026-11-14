import {
  InMemoryStateAccumulator,
  LevelDbStateAccumulator,
  HybridStateAccumulator,
  createStateAccumulator,
  keyChargeBytes,
} from '../src/extraction/state-accumulator';
import { PublicStateRecord, FabricIdentity } from '../src/types';
import { EncodedValue } from '../src/utils/value-codec';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

async function drainAll(acc: { drain(channelId: string): AsyncIterable<PublicStateRecord> }, channelId = 'ch1'): Promise<PublicStateRecord[]> {
  const records: PublicStateRecord[] = [];
  for await (const r of acc.drain(channelId)) {
    records.push(r);
  }
  return records;
}

/** A UTF-8 text value in the shape the accumulators take. */
function text(value: string): EncodedValue {
  return { value };
}

const creator: FabricIdentity = {
  mspId: 'Org1MSP',
  commonName: 'admin',
  org: 'Org1',
  certFingerprint: 'sha256:abc123',
};

// ─── InMemoryStateAccumulator ───

describe('InMemoryStateAccumulator', () => {
  let acc: InMemoryStateAccumulator;

  beforeEach(() => {
    acc = new InMemoryStateAccumulator();
  });

  afterEach(async () => {
    await acc.close();
  });

  it('starts empty', () => {
    expect(acc.keyCount()).toBe(0);
    expect(acc.estimatedMemoryBytes()).toBe(0);
    expect(acc.activeBackend()).toBe('memory');
  });

  it('put adds a key and tracks count', async () => {
    await acc.put('mycc', 'key1', text('{"val":1}'));
    expect(acc.keyCount()).toBe(1);
    expect(acc.estimatedMemoryBytes()).toBeGreaterThan(0);
  });

  it('put overwrites existing key without changing count', async () => {
    await acc.put('mycc', 'key1', text('v1'));
    await acc.put('mycc', 'key1', text('v2'));
    expect(acc.keyCount()).toBe(1);

    const records = await drainAll(acc);
    expect(records).toHaveLength(1);
    expect(records[0].value).toBe('v2');
  });

  it('put preserves creator identity', async () => {
    await acc.put('mycc', 'key1', text('val'), creator);
    const records = await drainAll(acc);
    expect(records[0].creator).toEqual(creator);
  });

  it('delete removes an existing key', async () => {
    await acc.put('mycc', 'key1', text('val'));
    await acc.delete('mycc', 'key1');
    expect(acc.keyCount()).toBe(0);
    const records = await drainAll(acc);
    expect(records).toHaveLength(0);
  });

  it('delete is a no-op for nonexistent key', async () => {
    await acc.delete('mycc', 'nokey');
    expect(acc.keyCount()).toBe(0);
  });

  it('delete is a no-op for nonexistent namespace', async () => {
    await acc.delete('nocc', 'nokey');
    expect(acc.keyCount()).toBe(0);
  });

  it('handles multiple namespaces', async () => {
    await acc.put('cc1', 'k1', text('v1'));
    await acc.put('cc2', 'k1', text('v2'));
    await acc.put('cc2', 'k2', text('v3'));
    expect(acc.keyCount()).toBe(3);

    const records = await drainAll(acc);
    expect(records).toHaveLength(3);
    const byChaincode = records.reduce((m, r) => {
      m[r.chaincode] = (m[r.chaincode] || 0) + 1;
      return m;
    }, {} as Record<string, number>);
    expect(byChaincode['cc1']).toBe(1);
    expect(byChaincode['cc2']).toBe(2);
  });

  it('drain yields records with correct channel and type', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    const records = await drainAll(acc, 'mychannel');
    expect(records[0]._type).toBe('public_state');
    expect(records[0].channel).toBe('mychannel');
    expect(records[0].chaincode).toBe('mycc');
    expect(records[0].key).toBe('k1');
    expect(records[0].value).toBe('v1');
  });

  it('drain is non-destructive (can drain twice)', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    const first = await drainAll(acc);
    const second = await drainAll(acc);
    expect(first).toEqual(second);
  });

  it('memory estimate adjusts on overwrite with different value size', async () => {
    await acc.put('mycc', 'key1', text('short'));
    const before = acc.estimatedMemoryBytes();
    await acc.put('mycc', 'key1', text('a much longer value string'));
    const after = acc.estimatedMemoryBytes();
    expect(after).toBeGreaterThan(before);
  });

  it('memory estimate decreases on delete', async () => {
    await acc.put('mycc', 'key1', text('value'));
    const before = acc.estimatedMemoryBytes();
    await acc.delete('mycc', 'key1');
    expect(acc.estimatedMemoryBytes()).toBeLessThan(before);
  });

  // A channel's namespaces are held in the same map as its keys, so a chaincode
  // costs what its name costs — small per chaincode, but it is what the capacity
  // estimate reuses to predict the promotion threshold.
  it('charges each namespace it holds', async () => {
    const oneNamespace = new InMemoryStateAccumulator();
    const twoNamespaces = new InMemoryStateAccumulator();
    await oneNamespace.put('cc', 'k1', text('v'));
    await oneNamespace.put('cc', 'k2', text('v'));
    await twoNamespaces.put('cc', 'k1', text('v'));
    await twoNamespaces.put('another-cc', 'k2', text('v'));

    expect(twoNamespaces.estimatedMemoryBytes() - oneNamespace.estimatedMemoryBytes()).toBe(
      keyChargeBytes('another-cc'.length),
    );
    await oneNamespace.close();
    await twoNamespaces.close();
  });

  it('estimatedMemoryBytes never goes negative', async () => {
    await acc.put('mycc', 'k', text('v'));
    await acc.delete('mycc', 'k');
    expect(acc.estimatedMemoryBytes()).toBeGreaterThanOrEqual(0);
  });

  /**
   * Bytes the estimate attributes to creators alone: the same puts with and
   * without an identity differ by nothing else.
   */
  async function creatorCharge(
    keys: number,
    identityFor: (i: number) => FabricIdentity,
  ): Promise<number> {
    const withCreator = new InMemoryStateAccumulator();
    const without = new InMemoryStateAccumulator();
    for (let i = 0; i < keys; i++) {
      await withCreator.put('mycc', `k${i}`, text('v'), identityFor(i));
      await without.put('mycc', `k${i}`, text('v'));
    }
    const charge = withCreator.estimatedMemoryBytes() - without.estimatedMemoryBytes();
    await withCreator.close();
    await without.close();
    return charge;
  }

  it('counts a creator identity in the memory estimate', async () => {
    expect(await creatorCharge(1, () => creator)).toBeGreaterThan(0);
  });

  it('charges a shared creator object once however many keys it wrote', async () => {
    expect(await creatorCharge(50, () => creator)).toBe(await creatorCharge(1, () => creator));
  });

  it('charges each distinct creator object it retains', async () => {
    // Same field lengths for every identity, so 50 of them cost exactly 50×.
    const distinct = (i: number): FabricIdentity => ({
      ...creator,
      commonName: `admin${String(i).padStart(2, '0')}`,
    });
    const one = await creatorCharge(1, distinct);
    expect(await creatorCharge(50, distinct)).toBe(50 * one);
  });

  it('does not credit back a creator another key still holds', async () => {
    /** Bytes deleting one of two keys takes off the estimate. */
    const freedByDelete = async (identity?: FabricIdentity): Promise<number> => {
      const target = new InMemoryStateAccumulator();
      await target.put('mycc', 'k1', text('v'), identity);
      await target.put('mycc', 'k2', text('v'), identity);
      const before = target.estimatedMemoryBytes();
      await target.delete('mycc', 'k1');
      const freed = before - target.estimatedMemoryBytes();
      await target.close();
      return freed;
    };

    // Only the entry's own bytes come off: k2 still holds the identity.
    expect(await freedByDelete(creator)).toBe(await freedByDelete(undefined));
    expect(await freedByDelete(creator)).toBeGreaterThan(0);
  });

  it('charges an identity with longer fields more', async () => {
    const long: FabricIdentity = {
      ...creator,
      certFingerprint: 'sha256:' + 'ab'.repeat(32),
    };
    expect(await creatorCharge(1, () => long)).toBeGreaterThan(
      await creatorCharge(1, () => creator),
    );
  });

  it('close clears all state', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    await acc.close();
    expect(acc.keyCount()).toBe(0);
    expect(acc.estimatedMemoryBytes()).toBe(0);
  });

  it('getRawMap exposes internal map', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    const raw = acc.getRawMap();
    expect(raw.size).toBe(1);
    expect(raw.get('mycc')?.get('k1')?.value).toBe('v1');
  });
});

// ─── LevelDbStateAccumulator ───

describe('LevelDbStateAccumulator', () => {
  let acc: LevelDbStateAccumulator;
  const dataDir = path.join(os.tmpdir(), 'test-state-acc');

  beforeEach(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    acc = new LevelDbStateAccumulator(dataDir);
  });

  afterEach(async () => {
    await acc.close();
    // cleanup any leftover dirs
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Swallowed on purpose: `force` already absorbs ENOENT, so what is left
      // is a LevelDB directory the platform still holds open. A tmpdir that
      // outlives the run is not a test failure.
    }
  });

  it('reports leveldb backend', () => {
    expect(acc.activeBackend()).toBe('leveldb');
  });

  it('starts with zero keys', () => {
    expect(acc.keyCount()).toBe(0);
  });

  it('returns fixed memory estimate', () => {
    expect(acc.estimatedMemoryBytes()).toBe(4 * 1024 * 1024);
  });

  it('put and drain round-trip correctly', async () => {
    await acc.put('mycc', 'k1', text('v1'), creator);
    expect(acc.keyCount()).toBe(1);

    const records = await drainAll(acc);
    expect(records).toHaveLength(1);
    expect(records[0].key).toBe('k1');
    expect(records[0].value).toBe('v1');
    expect(records[0].creator).toEqual(creator);
  });

  it('put overwrites without incrementing key count', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    await acc.put('mycc', 'k1', text('v2'));
    expect(acc.keyCount()).toBe(1);

    const records = await drainAll(acc);
    expect(records[0].value).toBe('v2');
  });

  it('delete removes key and decrements count', async () => {
    await acc.put('mycc', 'k1', text('v1'));
    await acc.delete('mycc', 'k1');
    expect(acc.keyCount()).toBe(0);

    const records = await drainAll(acc);
    expect(records).toHaveLength(0);
  });

  it('delete is a no-op for nonexistent key', async () => {
    await acc.delete('mycc', 'nokey');
    expect(acc.keyCount()).toBe(0);
  });

  it('handles multiple namespaces with null-byte separator', async () => {
    await acc.put('cc1', 'k1', text('v1'));
    await acc.put('cc2', 'k1', text('v2'));
    expect(acc.keyCount()).toBe(2);

    const records = await drainAll(acc);
    expect(records).toHaveLength(2);
    const keys = records.map(r => `${r.chaincode}:${r.key}`).sort();
    expect(keys).toEqual(['cc1:k1', 'cc2:k1']);
  });

  it('streamFrom populates from in-memory map', async () => {
    const stateMap = new Map<string, Map<string, { value: string; creator?: FabricIdentity }>>();
    const inner = new Map();
    inner.set('k1', { value: 'v1' });
    inner.set('k2', { value: 'v2' });
    stateMap.set('mycc', inner);

    await acc.streamFrom(stateMap);
    expect(acc.keyCount()).toBe(2);

    const records = await drainAll(acc);
    expect(records).toHaveLength(2);
    // streamFrom clears the source map to release memory
    expect(stateMap.size).toBe(0);
  });

  it('close is idempotent', async () => {
    await acc.close();
    await acc.close(); // should not throw
  });
});

// ─── HybridStateAccumulator ───

describe('HybridStateAccumulator', () => {
  it('starts with memory backend on auto', () => {
    const acc = new HybridStateAccumulator({
      backend: 'auto',
      memoryLimitBytes: 10_000,
    });
    expect(acc.activeBackend()).toBe('memory');
    acc.close();
  });

  it('starts with leveldb backend when configured', async () => {
    const dataDir = path.join(os.tmpdir(), 'test-hybrid-leveldb');
    fs.mkdirSync(dataDir, { recursive: true });
    const acc = new HybridStateAccumulator({
      backend: 'leveldb',
      memoryLimitBytes: 10_000,
      dataDir,
    });
    expect(acc.activeBackend()).toBe('leveldb');
    await acc.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Swallowed on purpose: `force` already absorbs ENOENT, so what is left
      // is a LevelDB directory the platform still holds open. A tmpdir that
      // outlives the run is not a test failure.
    }
  });

  it('counts memory held beside it against the same threshold', async () => {
    // The private pass's map, while it runs during the walk
    let alsoHeld = 0;
    const acc = new HybridStateAccumulator({
      backend: 'auto',
      memoryLimitBytes: 10_000,
      alsoHeldBytes: () => alsoHeld,
    });

    await acc.put('mycc', 'a', text('v'));
    expect(acc.activeBackend()).toBe('memory');

    alsoHeld = 10_000;
    await acc.put('mycc', 'b', text('v'));
    expect(acc.activeBackend()).toBe('leveldb');
    expect((await drainAll(acc)).map((r) => r.key).sort()).toEqual(['a', 'b']);

    await acc.close();
  });

  it('promotes from memory to leveldb when threshold exceeded', async () => {
    const acc = new HybridStateAccumulator({
      backend: 'auto',
      memoryLimitBytes: 500, // very low threshold to trigger promotion
    });

    expect(acc.activeBackend()).toBe('memory');

    // Put enough data to exceed 500 bytes
    for (let i = 0; i < 10; i++) {
      await acc.put('mycc', `key${i}`, text(`value-${i}-${'x'.repeat(50)}`));
    }

    expect(acc.activeBackend()).toBe('leveldb');
    expect(acc.keyCount()).toBe(10);

    // Data survives promotion
    const records = await drainAll(acc);
    expect(records).toHaveLength(10);

    await acc.close();
  });

  it('promotes on creator bytes that a value-only estimate misses', async () => {
    const fill = async (acc: HybridStateAccumulator, withCreators: boolean) => {
      for (let i = 0; i < 20; i++) {
        const identity: FabricIdentity = {
          ...creator,
          commonName: `admin${String(i).padStart(2, '0')}`,
        };
        await acc.put('mycc', `key${i}`, text('v'), withCreators ? identity : undefined);
      }
    };

    // 20 small keys and values stay under the limit; 20 unshared identities do not.
    const valuesOnly = new HybridStateAccumulator({ backend: 'auto', memoryLimitBytes: 5000 });
    await fill(valuesOnly, false);
    expect(valuesOnly.activeBackend()).toBe('memory');

    const withCreators = new HybridStateAccumulator({ backend: 'auto', memoryLimitBytes: 5000 });
    await fill(withCreators, true);
    expect(withCreators.activeBackend()).toBe('leveldb');
    expect(withCreators.keyCount()).toBe(20);
    expect(await drainAll(withCreators)).toHaveLength(20);

    await valuesOnly.close();
    await withCreators.close();
  });

  it('preserves data integrity through promotion', async () => {
    const acc = new HybridStateAccumulator({
      backend: 'auto',
      memoryLimitBytes: 500,
    });

    await acc.put('cc1', 'k1', text('before-promotion'), creator);

    // Force promotion by adding lots of data
    for (let i = 0; i < 20; i++) {
      await acc.put('cc2', `k${i}`, text('x'.repeat(100)));
    }

    expect(acc.activeBackend()).toBe('leveldb');

    // Original data should still be accessible
    const records = await drainAll(acc);
    const original = records.find(r => r.chaincode === 'cc1' && r.key === 'k1');
    expect(original).toBeDefined();
    expect(original!.value).toBe('before-promotion');
    expect(original!.creator).toEqual(creator);

    await acc.close();
  });

  it('delete works after promotion', async () => {
    const acc = new HybridStateAccumulator({
      backend: 'auto',
      memoryLimitBytes: 500,
    });

    await acc.put('mycc', 'k1', text('v1'));

    // Force promotion
    for (let i = 0; i < 20; i++) {
      await acc.put('mycc', `pad${i}`, text('x'.repeat(100)));
    }
    expect(acc.activeBackend()).toBe('leveldb');

    await acc.delete('mycc', 'k1');
    const records = await drainAll(acc);
    const deleted = records.find(r => r.key === 'k1');
    expect(deleted).toBeUndefined();

    await acc.close();
  });
});

// ─── createStateAccumulator factory ───

describe('createStateAccumulator', () => {
  it('returns InMemoryStateAccumulator for memory backend', async () => {
    const acc = createStateAccumulator({ backend: 'memory' });
    expect(acc.activeBackend()).toBe('memory');
    await acc.close();
  });

  it('returns LevelDbStateAccumulator for leveldb backend', async () => {
    const acc = createStateAccumulator({ backend: 'leveldb' });
    expect(acc.activeBackend()).toBe('leveldb');
    await acc.close();
  });

  it('returns HybridStateAccumulator for auto backend', async () => {
    const acc = createStateAccumulator({ backend: 'auto' });
    // Starts in memory mode
    expect(acc.activeBackend()).toBe('memory');
    await acc.close();
  });

  it('defaults to auto backend', async () => {
    const acc = createStateAccumulator();
    expect(acc.activeBackend()).toBe('memory'); // auto starts in memory
    await acc.close();
  });

  it('respects custom memory limit', async () => {
    const acc = createStateAccumulator({ backend: 'auto', memoryLimitBytes: 200 });
    for (let i = 0; i < 10; i++) {
      await acc.put('mycc', `k${i}`, text('x'.repeat(50)));
    }
    expect(acc.activeBackend()).toBe('leveldb');
    await acc.close();
  });
});
