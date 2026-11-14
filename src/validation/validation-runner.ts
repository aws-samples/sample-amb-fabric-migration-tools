import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ChannelInfo,
  CollectionConfig,
  Manifest,
  MigrationTier,
  BlockMetadataRecord,
  PrivateHistoryRecord,
  PublicHistoryRecord,
  PrivateHashRecord,
  PrivateStateRecord,
} from '../types';
import { collectionPolicyIncludes } from '../extraction/private-data/collection-policy';
import { FileLayoutManager } from '../output/file-layout-manager';
import {
  PrivateCollectionRef,
  indexPrivateFiles,
} from '../output/private-file-index';
import { NdjsonReader } from '../replay/ndjson-reader';
import { ExtractorError } from '../utils/errors';
import { RecordOrderingChecker } from '../utils/record-ordering';
import { decodeLedgerValue } from '../utils/value-codec';

export interface ValidationResult {
  check: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string;
}

/**
 * Every MSP the extraction could have read private data as.
 *
 * A merged directory has no single extracting MSP, so `mergedFrom` replaces
 * `mspId` in one. The distinction decides whether a missing private value is
 * expected: in a single-member extraction, a collection the member is not in is
 * a value it was never sent, but in a merged one the value is only out of reach
 * if *every* contributing MSP was excluded.
 *
 * @param manifest Extraction manifest, merged or single-member.
 * @returns MSP IDs, empty when the manifest records none.
 */
function extractingMspIds(manifest: Manifest): string[] {
  if (manifest.mergedFrom?.length) {
    return manifest.mergedFrom
      .map((m) => m.mspId)
      .filter((id): id is string => id !== undefined);
  }
  return manifest.mspId ? [manifest.mspId] : [];
}

/**
 * Narrow the manifest's channels to those named by `--channels`.
 *
 * An unknown name is refused rather than filtered out. Filtering leaves an empty
 * list, every check below is per channel, and the run then reports a passing
 * manifest check and exits 0 having validated nothing — which reads as a green
 * light to replay. `verify` refuses the same mistake the same way.
 *
 * @param manifest Extraction manifest for the input directory.
 * @param channels Channel IDs from `--channels`, or `undefined` for all.
 * @returns The channels to validate, never empty when `channels` is given.
 * @throws ExtractorError naming the unknown channels and the manifest's own.
 */
function selectChannels(
  manifest: Manifest,
  channels: string[] | undefined,
): ChannelInfo[] {
  if (!channels) return manifest.channels;

  const known = manifest.channels.map((c) => c.channelId);
  const unknown = channels.filter((c) => !known.includes(c));
  if (unknown.length > 0) {
    throw new ExtractorError(
      '--channels named channel(s) that are not in the manifest: ' +
        `${unknown.join(', ')}. Manifest channels: ` +
        `${known.length > 0 ? known.join(', ') : '(none)'}. ` +
        'Every check is per channel, so validating none of them would report ' +
        'success for an extraction nothing was read from.',
      'VALIDATION_ERROR',
    );
  }

  return manifest.channels.filter((c) => channels.includes(c.channelId));
}

/** Options that change what one directory is validated against. */
export interface ValidationOptions {
  /**
   * Other members' extraction directories, when this one is being validated as one of several that will be merged. A
   * private value or private-history block this member lacks but one of these holds is accounted for rather than
   * failed: a member that joined the channel later never received the earlier values. The merged output is still
   * validated whole, so a value nobody holds still fails there. Absent, every check is judged on this directory alone.
   */
  otherMembers?: string[];
}

/**
 * Run all validation checks against an extraction output directory.
 * Returns results without printing — the caller decides how to display.
 */
export async function runValidation(
  inputDir: string,
  channels?: string[],
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  const layout = new FileLayoutManager(inputDir);
  const reader = new NdjsonReader();
  const results: ValidationResult[] = [];

  if (!fs.existsSync(layout.manifestPath)) {
    throw new Error(
      `No manifest.json found at ${layout.manifestPath}`,
    );
  }

  const manifest: Manifest = JSON.parse(
    fs.readFileSync(layout.manifestPath, 'utf-8'),
  );
  results.push({
    check: 'Manifest',
    status: 'pass',
    message: 'manifest.json found and parseable',
  });

  const channelsToValidate = selectChannels(manifest, channels);
  if (channelsToValidate.length === 0) {
    // Reachable only with no --channels, since an unknown name is refused
    // above: the manifest itself lists no channel. Every check below is
    // per-channel, so without this the run reports one passing check on the
    // manifest and exits 0 over an extraction that holds nothing.
    results.push({
      check: 'Channels',
      status: 'fail',
      message: 'manifest.json lists no channels — nothing was validated',
      details:
        'Every check below the manifest is per channel. Re-run extract, or ' +
        'point --input-dir at the directory it actually wrote to.',
    });
    return results;
  }

  for (const channel of channelsToValidate) {
    results.push(
      ...await validateChannel(
        inputDir, layout, reader, channel, extractingMspIds(manifest),
        options.otherMembers ?? [],
      ),
    );
  }

  // Identities file check
  const identitiesPath = path.join(inputDir, layout.identitiesPath);
  if (fs.existsSync(identitiesPath)) {
    const count = await reader.count(identitiesPath);
    results.push({
      check: 'Identities',
      status: 'pass',
      message: `${count} identity records found`,
    });
  } else {
    results.push({
      check: 'Identities',
      status: 'skip',
      message: 'No identities.ndjson — normal for Tier 1',
    });
  }

  return results;
}

/**
 * Format validation results as a printable summary string.
 */
export function formatValidationResults(
  results: ValidationResult[],
): string {
  const lines: string[] = [];
  let failures = 0;

  for (const r of results) {
    const icon =
      r.status === 'pass'
        ? 'PASS'
        : r.status === 'fail'
          ? 'FAIL'
          : r.status === 'warn'
            ? 'WARN'
            : 'SKIP';
    lines.push(`  [${icon}] ${r.check}: ${r.message}`);
    if (r.details) lines.push(`         ${r.details}`);
    if (r.status === 'fail') failures++;
  }

  const total = results.length;
  const passed = results.filter((r) => r.status === 'pass').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  lines.push(
    `\n  ${passed}/${total} passed, ${failures} failed, ` +
      `${warned} warnings, ${skipped} skipped`,
  );

  return lines.join('\n');
}

// ── Per-channel validation phases ──

async function validateChannel(
  inputDir: string,
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channel: ChannelInfo,
  manifestMspIds: string[],
  otherMembers: string[] = [],
): Promise<ValidationResult[]> {
  const { channelId, ledgerHeight } = channel;
  const results: ValidationResult[] = [];
  const loaded = loadChannelMetadata(inputDir, layout, channelId);
  const mspIds = loaded.metadata?.extractedByMspId
    ? [loaded.metadata.extractedByMspId]
    : manifestMspIds;

  results.push(
    ...await validateFormatAndIntegrity(
      inputDir, layout, reader, channelId,
    ),
  );

  const blockMetadataPath = path.join(
    inputDir, layout.blockMetadataPath(channelId),
  );
  if (fs.existsSync(blockMetadataPath)) {
    results.push(
      await checkBlockCompleteness({
        reader,
        filePath: blockMetadataPath,
        channelId,
        ledgerHeight,
        expectedGaps: loaded.metadata?.blocksWithoutMetadata,
      }),
    );
  } else {
    results.push({
      check: `Block completeness (${channelId})`,
      status: 'skip',
      message:
        'No block-metadata.ndjson — skipping (Tier 1 extraction)',
    });
  }

  results.push(
    ...await validateOrdering(inputDir, layout, reader, channelId),
  );
  results.push(
    ...await validateCompleteness(
      inputDir, layout, reader, channel, mspIds, loaded.metadata?.tier,
      otherMembers,
    ),
  );
  results.push(
    ...await checkPrivateDataHashes(
      reader, inputDir, layout, channelId,
    ),
  );
  results.push(
    ...await checkPrivateValueCoverage({
      reader,
      baseDir: inputDir,
      layout,
      channel,
      extractingMspIds: mspIds,
      otherMembers,
    }),
  );
  results.push(loaded.result);

  return results;
}

/** Fields of a channel's metadata.json that validation depends on. */
interface ChannelMetadataFile {
  /** Extraction tier decides which artifacts are mandatory. */
  tier?: MigrationTier;
  /** MSP ID the extraction ran as — decides private data visibility. */
  extractedByMspId?: string;
  /** Blocks the extractor recorded as legitimately producing no metadata. */
  blocksWithoutMetadata?: number[];
}

interface ChannelMetadataLoad {
  metadata?: ChannelMetadataFile;
  /** Presence/parse check for the file itself. */
  result: ValidationResult;
}

function loadChannelMetadata(
  inputDir: string,
  layout: FileLayoutManager,
  channelId: string,
): ChannelMetadataLoad {
  const check = `Channel metadata (${channelId})`;
  const metadataPath = path.join(
    inputDir, layout.channelMetadataPath(channelId),
  );

  if (!fs.existsSync(metadataPath)) {
    return {
      result: {
        check,
        status: 'fail',
        message: 'No metadata.json — extraction is incomplete',
      },
    };
  }

  try {
    const metadata = JSON.parse(
      fs.readFileSync(metadataPath, 'utf-8'),
    ) as ChannelMetadataFile;
    return {
      metadata,
      result: { check, status: 'pass', message: 'metadata.json present' },
    };
  } catch (err) {
    return {
      result: {
        check,
        status: 'fail',
        message: 'metadata.json is present but unparseable',
        details: (err as Error).message,
      },
    };
  }
}

async function validateFormatAndIntegrity(
  inputDir: string,
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channelId: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  const ndjsonFiles = findNdjsonFiles(
    inputDir, layout.channelDir(channelId),
  );
  for (const file of ndjsonFiles) {
    results.push(
      await validateNdjsonFile(reader, file.path, file.name),
    );
  }

  const publicStatePath = path.join(
    inputDir, layout.publicStatePath(channelId),
  );
  if (fs.existsSync(publicStatePath)) {
    results.push(
      await checkDuplicates(reader, publicStatePath, channelId),
    );
  }

  for (const psf of layout.listPrivateFiles(
    channelId, '-state.ndjson',
  )) {
    const pvtStatePath = path.join(
      inputDir, layout.channelDir(channelId), psf,
    );
    results.push(
      await checkPrivateStateDuplicates(
        reader, pvtStatePath, channelId, psf,
      ),
    );
  }

  return results;
}

async function validateOrdering(
  inputDir: string,
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channelId: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const channelDir = path.join(
    inputDir, layout.channelDir(channelId),
  );

  const historyPath = path.join(
    inputDir, layout.publicHistoryPath(channelId),
  );
  if (fs.existsSync(historyPath)) {
    results.push(
      await checkRecordOrdering(
        reader, historyPath,
        `Record ordering (${channelId}/public-history)`,
      ),
    );
  }

  const blockMetadataPath = path.join(
    inputDir, layout.blockMetadataPath(channelId),
  );
  if (fs.existsSync(blockMetadataPath)) {
    results.push(
      await checkRecordOrdering(
        reader, blockMetadataPath,
        `Record ordering (${channelId}/block-metadata)`,
      ),
    );
  }

  for (const hf of layout.listPrivateFiles(
    channelId, '-hashes.ndjson',
  )) {
    results.push(
      await checkRecordOrdering(
        reader, path.join(channelDir, hf),
        `Record ordering (${channelId}/${hf})`,
      ),
    );
  }

  for (const hf of layout.listPrivateFiles(
    channelId, '-history.ndjson',
  )) {
    results.push(
      await checkRecordOrdering(
        reader, path.join(channelDir, hf),
        `Record ordering (${channelId}/${hf})`,
      ),
    );
  }

  return results;
}

async function validateCompleteness(
  inputDir: string,
  layout: FileLayoutManager,
  reader: NdjsonReader,
  channel: ChannelInfo,
  extractingMspIds: string[],
  tier?: MigrationTier,
  otherMembers: string[] = [],
): Promise<ValidationResult[]> {
  const { channelId } = channel;
  const results: ValidationResult[] = [];

  const blockMetadataPath = path.join(
    inputDir, layout.blockMetadataPath(channelId),
  );
  const historyPath = path.join(
    inputDir, layout.publicHistoryPath(channelId),
  );
  if (fs.existsSync(blockMetadataPath)) {
    results.push(
      await checkHistoryCompleteness(
        reader, blockMetadataPath, historyPath, channelId, tier,
      ),
    );
  }

  const pvtCollections = await discoverPrivateCollections(
    reader, layout, channelId,
  );
  for (const ref of pvtCollections) {
    const pvtHashesPath = path.join(
      inputDir,
      layout.privateHashesPath(channelId, ref.chaincode, ref.collection),
    );
    const pvtHistoryPath = path.join(
      inputDir,
      layout.privateHistoryPath(channelId, ref.chaincode, ref.collection),
    );
    results.push(
      await checkPrivateHistoryCompleteness(
        reader, pvtHashesPath, pvtHistoryPath, channel, ref,
        extractingMspIds, tier,
        otherMembers.map((dir) => path.join(
          dir, layout.privateHistoryPath(channelId, ref.chaincode, ref.collection),
        )),
      ),
    );
  }

  return results;
}

// ── Internal helpers ──

function findNdjsonFiles(
  baseDir: string,
  channelDir: string,
): Array<{ path: string; name: string }> {
  const fullDir = path.join(baseDir, channelDir);
  if (!fs.existsSync(fullDir)) return [];

  return fs
    .readdirSync(fullDir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => ({
      path: path.join(fullDir, f),
      name: `${channelDir}/${f}`,
    }));
}

async function validateNdjsonFile(
  reader: NdjsonReader,
  filePath: string,
  label: string,
): Promise<ValidationResult> {
  let count = 0;

  for await (const _record of reader.stream(filePath)) {
    count++;
  }

  if (count === 0) {
    return {
      check: `NDJSON (${label})`,
      status: 'warn',
      message: 'File is empty',
    };
  }

  return {
    check: `NDJSON (${label})`,
    status: 'pass',
    message: `${count} valid records`,
  };
}

async function checkDuplicates(
  reader: NdjsonReader,
  filePath: string,
  channelId: string,
): Promise<ValidationResult> {
  const seen = new Set<string>();
  let duplicates = 0;

  for await (const record of reader.stream(filePath)) {
    const r = record as any;
    const key = `${r.channel}:${r.chaincode}:${r.key}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
    }
  }

  if (duplicates > 0) {
    return {
      check: `Duplicates (${channelId}/public-state)`,
      status: 'warn',
      message: `${duplicates} duplicate keys found (may be from crash-recovery resume)`,
    };
  }

  return {
    check: `Duplicates (${channelId}/public-state)`,
    status: 'pass',
    message: 'No duplicate keys',
  };
}

async function checkPrivateStateDuplicates(
  reader: NdjsonReader,
  filePath: string,
  channelId: string,
  fileName: string,
): Promise<ValidationResult> {
  const seen = new Set<string>();
  let duplicates = 0;

  for await (const record of reader.stream(filePath)) {
    const r = record as PrivateStateRecord;
    const key = `${r.collection}:${r.chaincode}:${r.key}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
    }
  }

  const label = `Duplicates (${channelId}/${fileName})`;
  if (duplicates > 0) {
    return {
      check: label,
      status: 'warn',
      message: `${duplicates} duplicate keys found (may be from crash-recovery resume)`,
    };
  }

  return { check: label, status: 'pass', message: 'No duplicate keys' };
}

interface BlockCompletenessInput {
  reader: NdjsonReader;
  filePath: string;
  channelId: string;
  ledgerHeight: number;
  /**
   * Blocks the extractor recorded as producing no block metadata — config
   * blocks and blocks whose every transaction was invalidated. Undefined when
   * the extraction output does not record them, in which case a real gap
   * cannot be told apart from an expected one.
   */
  expectedGaps?: number[];
}

interface BlockGapCounts {
  expected: number;
  unexplained: number;
  /** First few unexplained gaps, for the failure details. */
  sample: number[];
}

async function checkBlockCompleteness(
  input: BlockCompletenessInput,
): Promise<ValidationResult> {
  const { channelId, ledgerHeight, expectedGaps } = input;
  const check = `Block completeness (${channelId})`;
  const blockNumbers = new Set<number>();

  for await (const record of input.reader.stream(input.filePath)) {
    const r = record as any;
    if (typeof r.blockNumber === 'number') {
      blockNumbers.add(r.blockNumber);
    }
  }

  if (blockNumbers.size === 0) {
    return {
      check,
      status: 'warn',
      message: 'No block numbers found in metadata',
    };
  }

  let maxBlock = 0;
  blockNumbers.forEach((n) => {
    if (n > maxBlock) maxBlock = n;
  });

  // Classify out to the end of the ledger `discover` measured, not to the last
  // block this extraction happens to hold. A walk cut short — a crash, an OOM
  // kill, a SIGTERM — stops at some maxBlock and leaves everything above it
  // missing, and a range ending at maxBlock cannot see that, because it compares
  // the extraction against itself. That shortfall used to reach
  // `blockCoverageResult` as a `warn`, and `validate` exits 0 on warnings and
  // prints "Next steps: run replay". A truncated tail is the likeliest gap there
  // is and the only unbounded one, so it is classified exactly like an interior
  // gap: blocks walked but empty are in blocksWithoutMetadata, blocks never
  // reached are in neither file. An extraction can also run past the height
  // discover recorded, since the ledger keeps growing, so the range ends at
  // whichever of the two reaches further.
  const lastBlock = Number.isFinite(ledgerHeight)
    ? Math.max(maxBlock, ledgerHeight - 1)
    : maxBlock;

  const gaps = classifyBlockGaps(blockNumbers, lastBlock, expectedGaps);

  if (gaps.unexplained > 0) {
    return blockGapFailure(check, gaps, lastBlock, expectedGaps !== undefined);
  }

  if (gaps.expected > 0 && expectedGaps === undefined) {
    return {
      check,
      status: 'warn',
      message: 'Blocks 0..1 missing (genesis/config only — no user transactions)',
    };
  }

  return blockCoverageResult(check, maxBlock, ledgerHeight, gaps.expected);
}

/**
 * Split the gaps in 0..lastBlock into ones the extractor accounted for and ones
 * it did not. Blocks 0 (genesis) and 1 (initial config) never carry user
 * transactions, so they are always expected.
 */
function classifyBlockGaps(
  blockNumbers: Set<number>,
  lastBlock: number,
  expectedGaps?: number[],
): BlockGapCounts {
  const expectedSet = new Set(expectedGaps ?? []);
  const counts: BlockGapCounts = { expected: 0, unexplained: 0, sample: [] };

  for (let i = 0; i <= lastBlock; i++) {
    if (blockNumbers.has(i)) continue;
    if (i <= 1 || expectedSet.has(i)) {
      counts.expected++;
      continue;
    }
    counts.unexplained++;
    if (counts.sample.length < 10) counts.sample.push(i);
  }

  return counts;
}

function blockGapFailure(
  check: string,
  gaps: BlockGapCounts,
  lastBlock: number,
  gapsRecorded: boolean,
): ValidationResult {
  const suffix =
    gaps.unexplained > gaps.sample.length
      ? ` (and ${gaps.unexplained - gaps.sample.length} more)`
      : '';
  const hint = gapsRecorded
    ? 'These blocks are not in the extraction\'s blocksWithoutMetadata list, ' +
      'so they were not walked — re-run extract for this channel.'
    : 'This extraction output does not record which blocks legitimately have ' +
      'no metadata (config blocks, fully-invalidated blocks), so expected ' +
      'gaps cannot be told apart from lost blocks. Re-run extract to record them.';

  return {
    check,
    status: 'fail',
    message: `${gaps.unexplained} unexplained missing blocks in range 0..${lastBlock}`,
    details: `First gaps: [${gaps.sample.join(', ')}]${suffix}. ${hint}`,
  };
}

/**
 * Report a range with nothing unexplained left in it.
 *
 * The percentage is still worth printing, since a channel whose tail is all
 * config blocks does read as short of the ledger height, but it no longer
 * decides the status: `classifyBlockGaps` has already walked the whole ledger
 * range, so a shortfall the extraction cannot account for has failed above. The
 * threshold this used to apply is what let a 1%-complete extraction pass as a
 * warning — it measured the size of the shortfall and never asked whether the
 * extraction could explain it.
 */
function blockCoverageResult(
  check: string,
  maxBlock: number,
  ledgerHeight: number,
  expectedGaps: number,
): ValidationResult {
  const coverage = ((maxBlock + 1) / ledgerHeight) * 100;
  const gapNote =
    expectedGaps > 0
      ? ` — ${expectedGaps} block(s) hold no metadata by design (config or ` +
        'fully-invalidated blocks)'
      : '';

  return {
    check,
    status: 'pass',
    message:
      `Blocks 0..${maxBlock} covered (${coverage.toFixed(1)}% of ledger ` +
      `height ${ledgerHeight})${gapNote}`,
  };
}

async function checkHistoryCompleteness(
  reader: NdjsonReader,
  blockMetadataPath: string,
  historyPath: string,
  channelId: string,
  tier?: MigrationTier,
): Promise<ValidationResult> {
  const blocksWithWrites = new Map<number, boolean>();
  for await (const record of reader.stream(blockMetadataPath)) {
    const r = record as BlockMetadataRecord;
    if (typeof r.blockNumber !== 'number') continue;
    const hasWrites =
      r.keysWritten?.length > 0 || r.keysDeleted?.length > 0;
    if (hasWrites || !blocksWithWrites.has(r.blockNumber)) {
      blocksWithWrites.set(
        r.blockNumber,
        blocksWithWrites.get(r.blockNumber) || hasWrites,
      );
    }
  }

  if (!fs.existsSync(historyPath)) {
    const writesExist = [...blocksWithWrites.values()].some(Boolean);
    const required = tier === MigrationTier.FullHistory && writesExist;
    return {
      check: `History completeness (${channelId})`,
      status: required ? 'fail' : tier === MigrationTier.FullHistory ? 'pass' : 'skip',
      message: required
        ? 'Tier 3 metadata records public writes, but public-history.ndjson is missing'
        : tier === MigrationTier.FullHistory
          ? 'No public writes recorded — no public history file required'
          : 'No public-history.ndjson — expected for Tier 1/2 extraction',
    };
  }

  const historyBlocks = new Set<number>();
  for await (const record of reader.stream(historyPath)) {
    const r = record as PublicHistoryRecord;
    if (typeof r.blockNumber === 'number') {
      historyBlocks.add(r.blockNumber);
    }
  }

  const gapBlocks: number[] = [];
  let gapCount = 0;
  for (const [blockNum, hasWrites] of blocksWithWrites) {
    if (hasWrites && !historyBlocks.has(blockNum)) {
      gapCount++;
      if (gapBlocks.length < 10) gapBlocks.push(blockNum);
    }
  }

  if (gapCount > 0) {
    gapBlocks.sort((a, b) => a - b);
    const suffix =
      gapCount > 10 ? ` (and ${gapCount - 10} more)` : '';
    return {
      check: `History completeness (${channelId})`,
      status: 'fail',
      message: `${gapCount} blocks have writes in metadata but no history records`,
      details: `Missing blocks: [${gapBlocks.join(', ')}]${suffix}`,
    };
  }

  return {
    check: `History completeness (${channelId})`,
    status: 'pass',
    message: `History covers all ${blocksWithWrites.size} blocks from metadata`,
  };
}

/**
 * Check that every block with a hashed private write in this collection has
 * private history behind it.
 *
 * Two absences are expected rather than defects, and are the same two the
 * value-coverage check excuses: a collection whose policy names none of the
 * extracting MSPs is delivered to them as hashes only, so it has no history
 * at all; and a block past the collection's `blockToLive` horizon has had its
 * values purged from every peer, so no history can be recovered for it. Both
 * were reported as failures, which on a multi-member channel is every other
 * member's collection — a validation nobody could pass.
 */
async function checkPrivateHistoryCompleteness(
  reader: NdjsonReader,
  hashesPath: string,
  historyPath: string,
  channel: ChannelInfo,
  ref: PrivateCollectionRef,
  extractingMspIds: string[],
  tier?: MigrationTier,
  otherHistoryPaths: string[] = [],
): Promise<ValidationResult> {
  const { channelId } = channel;
  const label =
    `Private history completeness (${channelId}/${ref.chaincode}/` +
    `${ref.collection})`;
  const config = findCollectionConfig(channel, ref.chaincode, ref.collection);
  const unauthorized = config !== undefined &&
    extractingMspIds.length > 0 &&
    !extractingMspIds.some((mspId) =>
      collectionPolicyIncludes(config.policy, mspId),
    );
  const purgedBefore = config && config.blockToLive > 0
    ? channel.ledgerHeight - config.blockToLive
    : -1;

  if (!fs.existsSync(hashesPath)) {
    return {
      check: label,
      status: 'skip',
      message: 'No private hashes file — cannot cross-reference',
    };
  }

  const hashBlocks = new Set<number>();
  for await (const record of reader.stream(hashesPath)) {
    const r = record as PrivateHashRecord;
    if (typeof r.blockNumber === 'number') {
      hashBlocks.add(r.blockNumber);
    }
  }

  if (unauthorized) {
    return {
      check: label,
      status: 'pass',
      message:
        'Hashes only — no extracting MSP is in the collection policy, so no ' +
        'private history is expected',
    };
  }

  // Blocks whose values every peer has already purged cannot have history.
  for (const block of [...hashBlocks]) {
    if (block < purgedBefore) hashBlocks.delete(block);
  }

  if (!fs.existsSync(historyPath)) {
    const required =
      tier === MigrationTier.FullHistory && hashBlocks.size > 0;
    return {
      check: label,
      status: required ? 'fail' : tier === MigrationTier.FullHistory ? 'pass' : 'skip',
      message: required
        ? 'Tier 3 private hashes contain writes, but private history is missing'
        : tier === MigrationTier.FullHistory
          ? 'Private hash file is empty — no private history file required'
          : 'No private history file — expected for Tier 1/2 extraction',
    };
  }

  if (hashBlocks.size === 0) {
    return {
      check: label,
      status: 'skip',
      message: purgedBefore >= 0
        ? 'Every hashed write is past blockToLive — no history is recoverable'
        : 'Hash file has no block numbers',
    };
  }

  const historyBlocks = new Set<number>();
  for await (const record of reader.stream(historyPath)) {
    const r = record as any;
    if (typeof r.blockNumber === 'number') {
      historyBlocks.add(r.blockNumber);
    }
  }

  let missing: number[] = [];
  for (const block of hashBlocks) {
    if (!historyBlocks.has(block)) missing.push(block);
  }

  // A block this member has no history for but another member's extraction does: the value never reached this
  // member's peer (it joined the channel later). The merged output is validated whole.
  let heldElsewhere = 0;
  if (missing.length > 0 && otherHistoryPaths.length > 0) {
    const other = new Set<number>();
    for (const file of otherHistoryPaths) {
      if (!fs.existsSync(file)) continue;
      for await (const record of reader.stream(file)) {
        const r = record as any;
        if (typeof r.blockNumber === 'number') other.add(r.blockNumber);
      }
    }
    const still = missing.filter((b) => !other.has(b));
    heldElsewhere = missing.length - still.length;
    missing = still;
  }

  if (missing.length > 0) {
    missing.sort((a, b) => a - b);
    const shown = missing.slice(0, 10);
    return {
      check: label,
      status: 'fail',
      message: `${missing.length} blocks in hashes file missing from private history`,
      details: `Missing blocks: [${shown.join(', ')}]${missing.length > shown.length ? ' …' : ''}.` +
        (otherHistoryPaths.length === 0 ? ' If this member joined the channel after those writes, validate with --other-members <the other members\' directories>, or validate the merged output.' : ''),
    };
  }

  if (heldElsewhere > 0) {
    return {
      check: label,
      status: 'pass',
      message:
        `Private history covers ${hashBlocks.size - heldElsewhere} of ${hashBlocks.size} blocks from hashes; ` +
        `${heldElsewhere} held by another member's extraction`,
    };
  }

  return {
    check: label,
    status: 'pass',
    message: `Private history covers all ${hashBlocks.size} blocks from hashes`,
  };
}

/**
 * The `(chaincode, collection)` pairs a channel has private hash files for.
 *
 * Hash files rather than state files because every check built on this compares
 * something against the hashed rwsets: a collection with no hashes has nothing
 * to check against. The pair is read from the records — see `indexPrivateFiles`
 * for why the filename cannot be parsed back.
 */
async function discoverPrivateCollections(
  reader: NdjsonReader,
  layout: FileLayoutManager,
  channelId: string,
): Promise<PrivateCollectionRef[]> {
  return indexPrivateFiles(reader, layout, channelId, '-hashes.ndjson');
}

async function checkPrivateDataHashes(
  reader: NdjsonReader,
  baseDir: string,
  layout: FileLayoutManager,
  channelId: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const ref of await discoverPrivateCollections(
    reader, layout, channelId,
  )) {
    results.push(
      await checkCollectionHashes(reader, baseDir, layout, channelId, ref),
    );
  }

  return results;
}

/** How one collection's extracted values compared against its hashes. */
interface HashComparison {
  matched: number;
  mismatched: number;
  /** State keys whose key hash appears in no hash record. */
  notInHashes: number;
}

/**
 * Cross-check one collection's extracted private values against the value
 * hashes the peer recorded on chain.
 *
 * Both files hold exactly one `(chaincode, collection)` pair, so the key hashes
 * being compared come from the same namespace. Comparing one chaincode's values
 * against another's hashes reports every key as a mismatch.
 */
async function checkCollectionHashes(
  reader: NdjsonReader,
  baseDir: string,
  layout: FileLayoutManager,
  channelId: string,
  ref: PrivateCollectionRef,
): Promise<ValidationResult> {
  const check =
    `Private data hashes (${channelId}/${ref.chaincode}/${ref.collection})`;
  const resolve = (relativePath: string): string =>
    path.join(baseDir, relativePath);
  const statePath = resolve(
    layout.privateStatePath(channelId, ref.chaincode, ref.collection),
  );

  if (!fs.existsSync(statePath)) {
    return {
      check,
      status: 'skip',
      message: 'Hash file exists but no state file to cross-check',
    };
  }

  const hashMap = new Map<string, string>();
  for await (const record of reader.stream(
    resolve(layout.privateHashesPath(channelId, ref.chaincode, ref.collection)),
  )) {
    const r = record as PrivateHashRecord;
    hashMap.set(r.key, r.hash);
  }
  if (hashMap.size === 0) {
    return { check, status: 'skip', message: 'Hash file is empty' };
  }

  return hashComparisonResult(
    check, await compareStateToHashes(reader, statePath, hashMap),
  );
}

/** Hash every extracted value and count how it compares to the chain's hash. */
async function compareStateToHashes(
  reader: NdjsonReader,
  statePath: string,
  hashMap: Map<string, string>,
): Promise<HashComparison> {
  const counts: HashComparison = {
    matched: 0, mismatched: 0, notInHashes: 0,
  };

  for await (const record of reader.stream(statePath)) {
    const r = record as PrivateStateRecord;
    const keyHash = crypto.createHash('sha256').update(r.key).digest('hex');
    const expected = hashMap.get(keyHash);

    if (expected === undefined) {
      counts.notInHashes++;
      continue;
    }

    const actual = crypto
      .createHash('sha256')
      .update(decodeLedgerValue(r))
      .digest('hex');
    if (actual === expected) {
      counts.matched++;
    } else {
      counts.mismatched++;
    }
  }

  return counts;
}

function hashComparisonResult(
  check: string,
  counts: HashComparison,
): ValidationResult {
  const { matched, mismatched, notInHashes } = counts;
  const total = matched + mismatched + notInHashes;

  if (mismatched > 0) {
    return {
      check,
      status: 'fail',
      message:
        `${mismatched}/${total} state records have value hash mismatches`,
      details:
        'Hashes are computed over the exact extracted value bytes and ' +
        'compared against the hashes the peer recorded on chain, so a ' +
        'mismatch means the private value does not match the ledger — ' +
        're-extract the affected collection.',
    };
  }

  if (notInHashes > total * 0.1 && notInHashes > 0) {
    return {
      check,
      status: 'warn',
      message:
        `${matched} matched, ${notInHashes} state keys not in hash file ` +
        '(possible extraction gap)',
    };
  }

  return {
    check,
    status: 'pass',
    message:
      `${matched} records verified, ${notInHashes} state keys without hashes`,
  };
}

// ── Private data value coverage ──

/** Why a key present in the hashed rwsets has no private value in state. */
type MissingValueReason =
  | 'expected-deleted'
  | 'expected-unauthorized'
  | 'expected-purged'
  | 'held-by-other-member'
  | 'unexplained';

const MISSING_VALUE_LABELS: Record<MissingValueReason, string> = {
  'expected-deleted': 'deleted before extraction',
  'expected-unauthorized': 'no extracting MSP is in the collection policy',
  'expected-purged': 'purged by blockToLive',
  'held-by-other-member': "value held by another member's extraction",
  unexplained: 'no explanation found',
};

interface PrivateCoverageContext {
  reader: NdjsonReader;
  baseDir: string;
  layout: FileLayoutManager;
  channel: ChannelInfo;
  /**
   * MSP IDs whose peers the extraction read private data from — one for a
   * single-member extraction, several for a directory produced by `merge`.
   * Empty when the output does not record any.
   */
  extractingMspIds: string[];
  /** Other members' directories, when validating one of several to be merged (see ValidationOptions). */
  otherMembers?: string[];
}

/** Latest hashed write seen for one (chaincode, key hash) pair. */
interface LatestHashWrite {
  chaincode: string;
  blockNumber: number;
  txIndex: number;
  /** True when the write carried no value hash, which marks a delete. */
  deleted: boolean;
}

/**
 * Check that every private key written on chain has a value in the extraction,
 * and classify the ones that do not.
 *
 * The hashed rwsets in the blocks name every private key ever written, whether
 * or not the extracting org could read its value. Comparing them against the
 * extracted private state is the only way to tell "we have all the private
 * data" from "we have the subset our MSP was allowed to see".
 */
async function checkPrivateValueCoverage(
  ctx: PrivateCoverageContext,
): Promise<ValidationResult[]> {
  const refs = await discoverPrivateCollections(
    ctx.reader, ctx.layout, ctx.channel.channelId,
  );
  const results: ValidationResult[] = [];

  for (const ref of refs) {
    const result = await checkCollectionValueCoverage(ctx, ref);
    if (result) results.push(result);
  }

  return results;
}

async function checkCollectionValueCoverage(
  ctx: PrivateCoverageContext,
  ref: PrivateCollectionRef,
): Promise<ValidationResult | undefined> {
  const channelId = ctx.channel.channelId;
  const { chaincode, collection } = ref;
  const label =
    `Private value coverage (${channelId}/${chaincode}/${collection})`;
  const resolve = (relativePath: string): string =>
    path.join(ctx.baseDir, relativePath);

  const latest = await readLatestHashWrites(
    ctx.reader,
    resolve(ctx.layout.privateHashesPath(channelId, chaincode, collection)),
  );
  if (latest.size === 0) return undefined;

  const present = await readStateKeyHashes(
    ctx.reader,
    resolve(ctx.layout.privateStatePath(channelId, chaincode, collection)),
  );
  const deleted = await readDeletedKeyHashes(
    ctx.reader,
    resolve(ctx.layout.privateHistoryPath(channelId, chaincode, collection)),
  );

  const counts = new Map<MissingValueReason, number>();
  let unresolvable = false;

  // Values other members hold, read only when this member has a gap to explain.
  let elsewhere: Set<string> | undefined;
  const heldElsewhere = async (id: string): Promise<boolean> => {
    if (!ctx.otherMembers?.length) return false;
    if (!elsewhere) {
      elsewhere = new Set<string>();
      for (const dir of ctx.otherMembers) {
        for (const k of await readStateKeyHashes(
          ctx.reader, path.join(dir, ctx.layout.privateStatePath(channelId, chaincode, collection)),
        )) elsewhere.add(k);
      }
    }
    return elsewhere.has(id);
  };

  for (const [id, write] of latest) {
    if (present.has(id)) continue;
    const config = findCollectionConfig(
      ctx.channel, write.chaincode, collection,
    );
    let reason = classifyMissingValue({
      write,
      deletedInHistory: deleted.has(id),
      collection: config,
      ledgerHeight: ctx.channel.ledgerHeight,
      extractingMspIds: ctx.extractingMspIds,
    });
    if (reason === 'unexplained' && await heldElsewhere(id)) {
      reason = 'held-by-other-member';
    }
    if (reason === 'unexplained' && (!config || !ctx.extractingMspIds.length)) {
      unresolvable = true;
    }
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return buildCoverageResult(label, latest.size, counts, unresolvable, (ctx.otherMembers?.length ?? 0) > 0);
}

interface MissingValueFacts {
  write: LatestHashWrite;
  deletedInHistory: boolean;
  collection?: CollectionConfig;
  ledgerHeight: number;
  /** Every MSP the extraction could read private data as. May be empty. */
  extractingMspIds: string[];
}

/**
 * Explain one private key that has a hashed write but no extracted value.
 *
 * Deletion is checked first because it is the only reason the value is not
 * supposed to exist anywhere; the rest describe data that exists on the network
 * but is out of this extraction's reach.
 *
 * Non-membership has to hold for *every* extracting MSP. In a merged directory
 * one member being outside the policy explains nothing, because another member
 * inside it should have supplied the value — so a key missing there is
 * unexplained, not expected.
 */
function classifyMissingValue(
  facts: MissingValueFacts,
): MissingValueReason {
  if (facts.write.deleted || facts.deletedInHistory) {
    return 'expected-deleted';
  }

  const collection = facts.collection;
  if (!collection) return 'unexplained';

  if (
    facts.extractingMspIds.length > 0 &&
    !facts.extractingMspIds.some((mspId) =>
      collectionPolicyIncludes(collection.policy, mspId),
    )
  ) {
    return 'expected-unauthorized';
  }

  if (
    collection.blockToLive > 0 &&
    facts.write.blockNumber < facts.ledgerHeight - collection.blockToLive
  ) {
    return 'expected-purged';
  }

  return 'unexplained';
}

function findCollectionConfig(
  channel: ChannelInfo,
  chaincode: string,
  collection: string,
): CollectionConfig | undefined {
  return channel.chaincodes
    .find((cc) => cc.name === chaincode)
    ?.collections.find((c) => c.name === collection);
}

function buildCoverageResult(
  label: string,
  totalKeys: number,
  counts: Map<MissingValueReason, number>,
  unresolvable: boolean,
  judgedAgainstOthers = false,
): ValidationResult {
  const missing = [...counts.values()].reduce((sum, n) => sum + n, 0);
  if (missing === 0) {
    return {
      check: label,
      status: 'pass',
      message: `All ${totalKeys} private keys on chain have extracted values`,
    };
  }

  const breakdown = [...counts.entries()]
    .map(([reason, n]) => `${n} ${reason} (${MISSING_VALUE_LABELS[reason]})`)
    .join('; ');
  const unexplained = counts.get('unexplained') ?? 0;

  if (unexplained === 0) {
    return {
      check: label,
      status: 'pass',
      message:
        `${totalKeys - missing}/${totalKeys} private keys have values, ` +
        `${missing} accounted for`,
      details: breakdown,
    };
  }

  return {
    check: label,
    status: unresolvable ? 'warn' : 'fail',
    message:
      `${unexplained}/${totalKeys} private keys have no value and no ` +
      'explanation',
    details: unresolvable
      ? `${breakdown}. The extracting MSP ID or the collection policy is ` +
        'unknown, so an unauthorized collection cannot be ruled out — re-run ' +
        'discover so manifest.json records mspId.'
      : breakdown +
        (judgedAgainstOthers
          ? ''
          : '. If this member joined the channel after those writes, validate with --other-members ' +
            "<the other members' directories>, or validate the merged output."),
  };
}

/**
 * Index the last hashed write per (chaincode, key hash) from a hashes file.
 *
 * Fabric writes an empty value hash for a private delete, which is how a
 * deleted key is told apart from one whose value we could not read.
 */
async function readLatestHashWrites(
  reader: NdjsonReader,
  hashesPath: string,
): Promise<Map<string, LatestHashWrite>> {
  const latest = new Map<string, LatestHashWrite>();

  for await (const record of reader.stream(hashesPath)) {
    const r = record as PrivateHashRecord;
    if (!r.key) continue;
    const id = `${r.chaincode}\0${r.key}`;
    const previous = latest.get(id);
    if (previous && !isLaterWrite(r, previous)) continue;
    latest.set(id, {
      chaincode: r.chaincode,
      blockNumber: r.blockNumber,
      txIndex: r.txIndex ?? 0,
      deleted: !r.hash,
    });
  }

  return latest;
}

function isLaterWrite(
  record: PrivateHashRecord,
  previous: LatestHashWrite,
): boolean {
  if (record.blockNumber !== previous.blockNumber) {
    return record.blockNumber > previous.blockNumber;
  }
  return (record.txIndex ?? 0) >= previous.txIndex;
}

/** Key hashes that have an extracted private value. */
async function readStateKeyHashes(
  reader: NdjsonReader,
  statePath: string,
): Promise<Set<string>> {
  const present = new Set<string>();
  if (!fs.existsSync(statePath)) return present;

  for await (const record of reader.stream(statePath)) {
    const r = record as PrivateStateRecord;
    present.add(`${r.chaincode}\0${sha256Hex(r.key)}`);
  }

  return present;
}

/**
 * Key hashes whose latest private-history write was a delete. Private history
 * holds plaintext keys, so they are hashed here to line up with the hashed
 * rwsets. Records are assumed to be in block order, which `checkRecordOrdering`
 * validates separately.
 */
async function readDeletedKeyHashes(
  reader: NdjsonReader,
  historyPath: string,
): Promise<Set<string>> {
  const deleted = new Set<string>();
  if (!fs.existsSync(historyPath)) return deleted;

  for await (const record of reader.stream(historyPath)) {
    const r = record as PrivateHistoryRecord;
    const id = `${r.chaincode}\0${sha256Hex(r.key)}`;
    if (r.isDelete) {
      deleted.add(id);
    } else {
      deleted.delete(id);
    }
  }

  return deleted;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Verify that records in a file maintain monotonically non-decreasing
 * blockNumber, with non-decreasing txIndex within the same block.
 * Only checks records that have both `blockNumber` and `txIndex` fields.
 */
async function checkRecordOrdering(
  reader: NdjsonReader,
  filePath: string,
  label: string,
): Promise<ValidationResult> {
  const checker = new RecordOrderingChecker();
  let recordCount = 0;
  let firstViolationRecord = 0;
  let firstViolation: import('../utils/record-ordering').OrderingViolation | null = null;

  for await (const record of reader.stream(filePath)) {
    const r = record as any;
    if (typeof r.blockNumber !== 'number') continue;

    recordCount++;
    const txIdx = typeof r.txIndex === 'number' ? r.txIndex : 0;
    const v = checker.check(r.blockNumber, txIdx);

    if (v && !firstViolation) {
      firstViolation = v;
      firstViolationRecord = recordCount;
    }
  }

  if (recordCount === 0) {
    return { check: label, status: 'skip', message: 'No ordered records found' };
  }

  if (firstViolation) {
    const msg = firstViolation.type === 'block'
      ? `Block ordering violation at record ${firstViolationRecord}`
      : `Transaction ordering violation at record ${firstViolationRecord}`;
    const details = firstViolation.type === 'block'
      ? `blockNumber went from ${firstViolation.prevBlock} to ${firstViolation.currentBlock}`
      : `In block ${firstViolation.currentBlock}, txIndex went ` +
        `from ${firstViolation.prevTxIndex} to ${firstViolation.currentTxIndex}`;
    return { check: label, status: 'fail', message: msg, details };
  }

  return {
    check: label,
    status: 'pass',
    message: `${recordCount} records in correct block/tx order`,
  };
}
