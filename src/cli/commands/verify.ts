import { Command } from 'commander';
import * as fs from 'fs';
import { ReplayConfig } from '../../types';
import { createLogger } from '../../utils/logger';
// Type-only: erased at compile time, so the verifier's heavy deps
// (pg, AWS SDK) still load lazily via the dynamic import below.
import type {
  VerifyEntry,
  VerifySummary,
} from '../../verification/verify-runner';

const logger = createLogger('cli:verify');

export const verifyCommand = new Command('verify')
  .description('Verify destination state matches extracted data')
  .requiredOption(
    '--input-dir <dir>',
    'Directory containing extraction output',
  )
  .requiredOption(
    '--config <path>',
    'Path to replay config JSON',
  )
  .option(
    '--channels <channels...>',
    'Subset of channels to verify',
  )
  .option(
    '--concurrency <n>',
    'Destination queries in flight. Each compared key costs a round trip, so ' +
      'a remote destination needs this well above 1; entries are still ' +
      'reported in source order',
    (value: string) => Number.parseInt(value, 10),
    16,
  )
  .option(
    '--redact-values',
    'Show a SHA-256 prefix and length instead of value excerpts in mismatch ' +
      'details, so output can be forwarded (e.g. to an AI assistant) without ' +
      'carrying ledger values',
  )
  .option(
    '--output <format>',
    'Output format: table (default) or json (one JSON object per line)',
    'table',
  )
  .action(async (opts) => {
    if (!fs.existsSync(opts.config)) {
      logger.error({ path: opts.config }, 'Config file not found');
      process.exitCode = 2;
      return;
    }

    const config: ReplayConfig = JSON.parse(
      fs.readFileSync(opts.config, 'utf-8'),
    );

    const asJson = opts.output === 'json';
    const { runVerification } = await import('../../verification/verify-runner');
    const s = await runVerification(opts.inputDir, config, {
      channels: opts.channels,
      onEntry: asJson ? writeJsonEntry : printEntry,
      concurrency: opts.concurrency,
      redactValues: opts.redactValues === true,
    });

    if (asJson) {
      process.stdout.write(JSON.stringify({ summary: s }) + '\n');
    } else {
      printSummary(s);
    }

    // Extras count as work done: the sweep asks its question of the whole
    // channel, so a run whose forward pass skipped every record still learned
    // something if keys came back that nothing accounts for.
    const checked = s.match + s.mismatch + s.missing + s.error + s.extra;

    if (checked === 0) {
      console.log(
        '\n  Nothing was verified: no records were queried on the ' +
        `destination (${s.skip} skipped). Check that the extraction ` +
        'output contains state files for the channels in scope and that ' +
        'read functions are mapped for their chaincodes.\n',
      );
      process.exitCode = 2;
      return;
    }

    if (s.mismatch > 0 || s.missing > 0 || s.extra > 0) {
      process.exitCode = 1;
    } else if (s.error > 0) {
      process.exitCode = 2;
    }
  });

/** Explanation printed for each skip reason, keyed by SkipReason. */
const SKIP_EXPLANATIONS: Record<string, string> = {
  'composite-key':
    'keys containing \\0 — NOT verified. A destination read function takes a ' +
    'single key argument, so composite keys cannot be queried individually. ' +
    'Confirm your destination chaincode rebuilds its own indexes.',
  'no-read-function':
    'no readFunctions entry for this chaincode namespace. Namespaces that ' +
    'are not in the manifest (for example lscc, _lifecycle) appear in ' +
    'reconstructed state; map them if they hold application data.',
  'no-private-read-function':
    'no privateReadFunctions entry for this chaincode. Private state was ' +
    'replayed but not verified.',
  'no-history-read-function':
    'no historyReadFunctions entry for this chaincode. Replayed history was ' +
    'not verified.',
  'no-key-listing':
    'this chaincode namespace was not swept for keys the extraction does not ' +
    'account for, because its readFunctions entry names your own contract ' +
    'rather than the migration contract. Point it at the migration contract ' +
    'to have the namespace swept.',
  'no-private-history-api':
    'private history was replayed into this collection and cannot be read ' +
    'back. Fabric exposes no private-data history API — GetHistoryForKey ' +
    'covers public state only — so no destination contract can answer for it ' +
    'and no config setting changes this. The current values of these keys ' +
    'were verified; the versions behind them were not.',
};

/**
 * Printed once when the destination key sweep found keys the extraction does
 * not account for. Named causes, because the count alone does not say where to
 * look and every cause has a different fix.
 */
const EXTRA_EXPLANATION =
  'public keys at the destination that no extracted record accounts for. ' +
  'Either the destination was not empty before replay, or a source delete ' +
  'was replayed as a write, or a mapped write function stored the value ' +
  'under a different key. Private state is not swept — one member\'s ' +
  'extraction is not the whole collection set.';

const STATUS_TAGS: Record<string, string> = {
  match: 'MATCH',
  mismatch: 'MISMATCH',
  missing: 'MISSING',
  extra: 'EXTRA',
};

/**
 * One entry as NDJSON, written as the verifier produces it.
 *
 * One object per line rather than one array over the whole run: the entries are
 * never all in memory at once, and a document that has to be closed cannot be
 * written by something that streams. It also lifts a ceiling — `JSON.stringify`
 * of a whole run's entries is a string, and Node refuses one over about 512 MiB.
 * The last line is the summary, under a `summary` key so a reader can tell it
 * from an entry.
 */
function writeJsonEntry(entry: VerifyEntry): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/** One entry as a table row, skips left for the summary to count. */
function printEntry(entry: VerifyEntry): void {
  if (entry.status === 'skip') return;
  const tag = STATUS_TAGS[entry.status] ?? 'ERROR';
  const detail = entry.detail ? ` — ${entry.detail}` : '';
  // A sweep failure belongs to no one key. Which scope it belongs to depends
  // on the destination: a whole channel for the two databases, one chaincode
  // namespace on it for a Fabric destination.
  const where = entry.key
    ? `${entry.key} (${entry.chaincode})`
    : [entry.channel, entry.chaincode].filter(Boolean).join('/');
  console.log(`  [${tag}] ${printable(where + detail)}`);
}

/**
 * Control characters spelled out, so a table row stays text. Composite keys carry
 * U+0000 separators, and `grep` treats output holding one as binary and hides the
 * match. `\0` is how the rest of the output already writes them; `--output json`
 * keeps the exact bytes.
 */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
    c === '\u0000' ? '\\0' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

function printSummary(s: VerifySummary): void {
  const parts = [
    `${s.match} match`,
    `${s.mismatch} mismatch`,
    `${s.missing} missing`,
    `${s.error} error`,
  ];
  // Only when found: a namespace whose readFunctions entry names another
  // contract is not swept at all, so a printed "0 extra" would claim a check
  // that never ran. The no-key-listing skips below say which.
  if (s.extra > 0) parts.push(`${s.extra} extra`);
  if (s.skip > 0) parts.push(`${s.skip} skipped`);
  console.log(`\n  ${parts.join(', ')}`);

  if (s.extra > 0) {
    console.log('\n  Extra (at the destination, not in the extraction):');
    console.log(`    ${s.extra} × ${EXTRA_EXPLANATION}`);
  }

  if (s.skip === 0) return;

  console.log('\n  Skipped (not verified):');
  for (const [reason, count] of Object.entries(s.skipsByReason)) {
    if (!count) continue;
    const explanation = SKIP_EXPLANATIONS[reason] ?? reason;
    console.log(`    ${count} × ${reason}: ${explanation}`);
    const affected = s.skipTargets[reason as keyof typeof s.skipTargets];
    if (affected?.length) {
      console.log(`      affected: ${printable(affected.join(', '))}`);
    }
  }
  console.log('');
}
