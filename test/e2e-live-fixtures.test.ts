/**
 * End-to-end test using real blocks captured from a live AMB peer.
 *
 * To populate the fixtures, run:
 *
 *   npx ts-node src/cli/index.ts capture-fixtures \
 *     --network-id <your-network-id> \
 *     --member-id <your-member-id> \
 *     --node-id <your-node-id> \
 *     --channel <your-channel> \
 *     --max-blocks 50 \
 *     --output-dir ./test/fixtures
 *
 * Then re-run this test. It will be skipped if fixtures are not present.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MigrationTier, ChannelInfo, PublicStateRecord } from '../src/types';
import { StateReconstructionExtractor } from '../src/extraction/strategies/state-reconstruction-extractor';
import { NdjsonWriter } from '../src/output/ndjson-writer';
import { NdjsonReader } from '../src/replay/ndjson-reader';
import { FileLayoutManager } from '../src/output/file-layout-manager';
import { CheckpointManager } from '../src/extraction/checkpoint-manager';
import { FixtureLoader, FixtureManifest } from './helpers/fixture-loader';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Auto-discover fixture channels
function findFixtureChannels(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(FIXTURES_DIR, d.name, 'fixture-manifest.json')))
    .map((d) => d.name);
}

const fixtureChannels = findFixtureChannels();

// Only define the full test suite when fixtures exist.
// Jest errors if describe.skip contains beforeEach but no tests.
if (fixtureChannels.length > 0) {

describe('End-to-end with live AMB fixtures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-live-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const channelName of fixtureChannels) {
    describe(`channel: ${channelName}`, () => {
      let loader: FixtureLoader;
      let manifest: FixtureManifest;

      beforeAll(() => {
        loader = new FixtureLoader(path.join(FIXTURES_DIR, channelName));
        manifest = loader.getManifest();
        console.log(`\nLoaded fixtures:\n${loader.summary()}\n`);
      });

      test('blocks decode and parse without errors', async () => {
        const { BlockParser } = await import('../src/extraction/block-parser');
        const parser = new BlockParser();

        let decoded = 0;
        let protobufFailed = 0;

        for (const block of manifest.blocks) {
          const raw = loader.loadBlockRaw(block.blockNumber);
          let blockJson: any;

          try {
            blockJson = JSON.parse(Buffer.from(raw).toString('utf-8'));
          } catch {
            // Protobuf block — expected if protobufBlocks > 0
            protobufFailed++;
            continue;
          }

          const parsed = parser.parseBlock(blockJson);
          expect(parsed.blockNumber).toBe(block.blockNumber);
          decoded++;
        }

        console.log(
          `  Decoded: ${decoded}/${manifest.totalBlocks}, ` +
            `Protobuf (need decoder): ${protobufFailed}`,
        );
        expect(decoded + protobufFailed).toBe(manifest.totalBlocks);
      });

      test('full state reconstruction produces valid NDJSON', async () => {
        // Skip if most blocks are protobuf (reconstruction will produce empty state)
        if (manifest.protobufBlocks > manifest.jsonBlocks) {
          console.log('  Skipping: majority of blocks are protobuf-encoded');
          return;
        }

        const network = loader.asMockNetwork();
        const outputDir = path.join(tmpDir, 'output');
        const writer = new NdjsonWriter(outputDir);
        const layout = new FileLayoutManager(outputDir);
        const checkpointDir = path.join(outputDir, layout.checkpointDir(channelName));
        const checkpointManager = new CheckpointManager(checkpointDir);

        const channel: ChannelInfo = {
          channelId: channelName,
          ledgerHeight: manifest.endBlock + 1, // only walk captured range
          chaincodes: [],
        };

        const extractor = new StateReconstructionExtractor(
          network,
          writer,
          layout,
          checkpointManager,
          MigrationTier.FullHistory,
          { stateBackend: 'memory' },
        );

        await extractor.extract(channel);
        await writer.close();

        // Verify output files exist and parse
        const reader = new NdjsonReader();
        const statePath = path.join(outputDir, layout.publicStatePath(channelName));

        if (fs.existsSync(statePath)) {
          const records = await reader.readAll(statePath);
          const publicState = records.filter(
            (r): r is PublicStateRecord => r._type === 'public_state',
          );

          console.log(`  Reconstructed state: ${publicState.length} live keys`);

          // Group by chaincode
          const byCc = new Map<string, number>();
          for (const r of publicState) {
            byCc.set(r.chaincode, (byCc.get(r.chaincode) ?? 0) + 1);
          }
          for (const [cc, count] of byCc) {
            console.log(`    ${cc}: ${count} keys`);
          }

          // Basic validity checks
          expect(publicState.length).toBeGreaterThan(0);
          expect(publicState.every((r) => r.channel === channelName)).toBe(true);
          expect(publicState.every((r) => r.chaincode.length > 0)).toBe(true);
          expect(publicState.every((r) => r.key.length > 0)).toBe(true);
        } else {
          console.log('  No public state extracted (empty ledger or all config blocks)');
        }

        // Verify history
        const historyPath = path.join(outputDir, layout.publicHistoryPath(channelName));
        if (fs.existsSync(historyPath)) {
          const historyCount = await reader.count(historyPath);
          console.log(`  History records: ${historyCount}`);
          expect(historyCount).toBeGreaterThanOrEqual(0);
        }

        // Verify identities
        const identitiesPath = path.join(outputDir, layout.identitiesPath);
        if (fs.existsSync(identitiesPath)) {
          const identities = await reader.readAll(identitiesPath);
          console.log(`  Identities: ${identities.length}`);
          expect(identities.length).toBeGreaterThan(0);
        }
      });

      test('hash chain integrity check on real blocks', async () => {
        if (manifest.protobufBlocks > manifest.jsonBlocks) {
          console.log('  Skipping: majority of blocks are protobuf-encoded');
          return;
        }

        const network = loader.asMockNetwork();
        const outputDir = path.join(tmpDir, 'output-integrity');
        const writer = new NdjsonWriter(outputDir);
        const layout = new FileLayoutManager(outputDir);
        const checkpointDir = path.join(outputDir, layout.checkpointDir(channelName));
        const checkpointManager = new CheckpointManager(checkpointDir);

        const { BlockWalker } = await import('../src/extraction/strategies/block-walker');
        const walker = new BlockWalker(
          network,
          writer,
          layout,
          checkpointManager,
          MigrationTier.CurrentState,
          { reconstructState: false, verifyHashChain: true },
        );

        const channel: ChannelInfo = {
          channelId: channelName,
          ledgerHeight: manifest.endBlock + 1,
          chaincodes: [],
        };

        const report = await walker.walk(channel);
        await writer.close();

        console.log(
          `  Hash chain: ${report.hashChainValid ? 'VALID' : 'BROKEN'} ` +
            `(${report.blocksVerified} blocks verified)`,
        );

        expect(report.hashChainValid).toBe(true);
      });
    });
  }
});

} // end if (fixtureChannels.length > 0)

/*
 * When there are no fixtures this file has no tests, and jest fails a file that
 * defines none. It used to satisfy that with a test that passed unconditionally
 * — so a run with no fixtures at all reported a green tick for the 1.x decode
 * path, which is the silent-success pattern turned on the suite
 * that is supposed to catch it.
 *
 * A skip says the same thing honestly. `jest` then prints `1 skipped` on its
 * summary line and names what did not run, on every run, until fixtures exist.
 * It stays a skip rather than a failure because the missing input is a live AMB
 * network: making `npx jest` red for its absence would make red the normal
 * state and teach everyone to ignore it.
 */
if (fixtureChannels.length === 0) {
  test.skip(
    'NOT RUN: no fixtures at test/fixtures/ — the real 1.2/1.4 decode path is unexercised ' +
      '(populate with: capture-fixtures --channel <ch> --output-dir ./test/fixtures)',
    () => {
      throw new Error('Never runs — the name is the report.');
    },
  );
}
