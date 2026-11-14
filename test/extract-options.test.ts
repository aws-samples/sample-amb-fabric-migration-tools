import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractCommand,
  parseInteger,
  selectChannels,
  toExtractOptions,
} from '../src/cli/commands/extract';
import { ExtractOptions, Manifest, MigrationTier } from '../src/types';

/**
 * The flags as commander hands them over, each with a value nothing else in the
 * object shares — a mapping that reads the wrong key cannot look right.
 */
const parsedFlags = {
  manifest: '/data/manifest.json',
  tier: 3,
  channels: ['ch0', 'ch1'],
  outputDir: '/data/out',
  batchSize: 250,
  strategy: 'block-reconstruction',
  concurrency: 8,
  stateBackend: 'leveldb',
  memoryLimit: 4096,
  prefetchBuffer: 16,
  stateDataDir: '/mnt/spill',
  // Connection flags, which describe where to extract from, not what to extract.
  region: 'us-west-2',
  networkId: 'n-EXAMPLE',
  memberId: 'm-EXAMPLE',
  nodeId: 'nd-EXAMPLE',
  mspPath: '/data/msp',
  tlsCert: '/data/tls.pem',
};

describe('parseInteger', () => {
  it('ignores Commander\'s previous/default value instead of treating it as a radix', () => {
    expect((parseInteger as any)('512', 512)).toBe(512);
    expect((parseInteger as any)('8', 1)).toBe(8);
  });
});

describe('toExtractOptions', () => {
  it('carries every flag that describes the extraction', () => {
    const expected: ExtractOptions = {
      manifest: '/data/manifest.json',
      nodeId: 'nd-EXAMPLE',
      tier: MigrationTier.FullHistory,
      channels: ['ch0', 'ch1'],
      outputDir: '/data/out',
      batchSize: 250,
      strategy: 'block-reconstruction',
      concurrency: 8,
      stateBackend: 'leveldb',
      memoryLimitMb: 4096,
      prefetchBuffer: 16,
      stateDataDir: '/mnt/spill',
    };

    expect(toExtractOptions(parsedFlags)).toEqual(expected);
  });

  it('leaves an unset spill directory unset, so the accumulator picks the default', () => {
    const unset = toExtractOptions({ ...parsedFlags, stateDataDir: undefined });
    expect(unset.stateDataDir).toBeUndefined();
  });

  it('carries --private-only, and leaves it unset when absent', () => {
    expect(toExtractOptions({ ...parsedFlags, privateOnly: true }).privateOnly)
      .toBe(true);
    expect(toExtractOptions(parsedFlags).privateOnly).toBeUndefined();
  });

  it('reads flags the extract command declares', () => {
    const declared = extractCommand.options.map((option) => option.attributeName());

    // Every key toExtractOptions reads, in the spelling commander produces.
    for (const flag of [
      'manifest',
      'nodeId',
      'tier',
      'channels',
      'outputDir',
      'batchSize',
      'strategy',
      'concurrency',
      'stateBackend',
      'memoryLimit',
      'prefetchBuffer',
      'stateDataDir',
      'privateOnly',
    ]) {
      expect(declared).toContain(flag);
    }
  });
});

describe('selectChannels', () => {
  const manifest = {
    networkId: 'n-EXAMPLE',
    channels: [
      { channelId: 'ch0', chaincodes: [], ledgerHeight: 4 },
      { channelId: 'ch1', chaincodes: [], ledgerHeight: 4 },
    ],
  } as unknown as Manifest;

  it('refuses a --channels name the manifest does not hold', () => {
    // Filtering the name out instead leaves nothing to walk, and the command
    // exits 0 over an output directory with no channel in it — indistinguishable
    // from a network that holds nothing.
    expect(() => selectChannels(manifest, ['ch0', 'ch7'])).toThrow(
      /not in the manifest: ch7\. Manifest channels: ch0, ch1/,
    );
  });

  it('names every unknown channel, not just the first', () => {
    expect(() => selectChannels(manifest, ['ch7', 'ch8'])).toThrow(
      /not in the manifest: ch7, ch8/,
    );
  });

  it('refuses a manifest with no channels at all', () => {
    const empty = { networkId: 'n-EXAMPLE', channels: [] } as unknown as Manifest;
    expect(() => selectChannels(empty, undefined)).toThrow(
      /lists no channels/,
    );
  });

  it('narrows to the named channels', () => {
    expect(selectChannels(manifest, ['ch1']).map((c) => c.channelId)).toEqual(
      ['ch1'],
    );
  });

  it('takes every channel when none is named', () => {
    expect(selectChannels(manifest, undefined).map((c) => c.channelId)).toEqual(
      ['ch0', 'ch1'],
    );
  });

  it('is reached by the command before it connects to anything', async () => {
    // The refusal is worth nothing if the action does its own filtering, and the
    // action is otherwise untestable because it needs a gateway. This is the one
    // window where it is not: the check runs before the first dynamic import, so
    // a bad --channels rejects without a network.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-select-'));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

    await expect(
      extractCommand.parseAsync([
        'node', 'extract',
        '--manifest', manifestPath,
        '--tier', '1',
        '--network-id', 'n-EXAMPLE',
        '--member-id', 'm-EXAMPLE',
        '--node-id', 'nd-EXAMPLE',
        '--output-dir', path.join(dir, 'out'),
        '--channels', 'ch7',
      ]),
    ).rejects.toThrow(/not in the manifest: ch7/);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
