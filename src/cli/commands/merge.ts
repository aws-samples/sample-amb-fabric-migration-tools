import { Command } from 'commander';
import { CoverageMatrixRow } from '../../merge/coverage-matrix';
import { MergeReport, MergeRunner } from '../../merge/merge-runner';
import { ExtractorError } from '../../utils/errors';
import { createLogger } from '../../utils/logger';

const logger = createLogger('cli:merge');

export const mergeCommand = new Command('merge')
  .description(
    'Combine per-member extractions into one directory, with a cross-member ' +
      'private data coverage matrix',
  )
  .requiredOption(
    '--input-dirs <dirs...>',
    'One extraction directory per member (at least two)',
  )
  .requiredOption(
    '--output-dir <dir>',
    'Directory for the merged extraction (must be empty or absent)',
  )
  .action(async (opts) => {
    logger.info(
      { inputDirs: opts.inputDirs, outputDir: opts.outputDir },
      'Starting merge',
    );

    const report = await runMerge(opts.inputDirs, opts.outputDir);
    if (!report) return;

    printReport(report);
    if (!report.ok) {
      process.exitCode = 1;
      return;
    }
    printNextSteps(opts.outputDir);
  });

/**
 * Run the merge, reporting a refusal as a message rather than a stack trace.
 *
 * Every way this command declines to run — members at different ledger heights,
 * public files that disagree, an output directory that already holds records —
 * ends in a sentence saying what to do about it. An unhandled rejection would
 * bury that sentence in a Node stack trace, which is the one place an operator
 * is least likely to read it.
 *
 * @returns The report, or `null` when the merge refused and `exitCode` is set.
 */
async function runMerge(
  inputDirs: string[],
  outputDir: string,
): Promise<MergeReport | null> {
  try {
    return await new MergeRunner({ inputDirs, outputDir }).run();
  } catch (error) {
    if (error instanceof ExtractorError) {
      console.error(`\nmerge failed: ${error.message}\n`);
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}

function printReport(report: MergeReport): void {
  console.log('\nMerge Results:\n');
  console.log(
    `  Members: ${report.members.map((m) => m.memberId).join(', ')}`,
  );
  console.log(`  Identities: ${report.identities}`);

  for (const channel of report.channels) {
    const c = channel.counts;
    console.log(`\n  ${channel.channelId} (height ${channel.ledgerHeight})`);
    console.log(
      `    private state ${c.privateState}, history ${c.privateHistory}, ` +
        `hashes ${c.privateHashes}`,
    );
    console.log('    Private data coverage:');
    for (const row of channel.coverage) {
      console.log(`      ${formatCoverageRow(row)}`);
    }
  }

  printWarnings(report);
  printBlockers(report);
}

/**
 * One coverage row: what the merge holds, who supplied it, and why not.
 *
 * `needsAttention` is marked so the rows a coordinator must resolve stand out
 * from the ones that are merely reported.
 */
function formatCoverageRow(row: CoverageMatrixRow): string {
  const from =
    row.contributedValues.length > 0
      ? ` from ${row.contributedValues.join('+')}`
      : '';
  const reason = row.reason ? ` (${row.reason})` : '';
  const flag = row.needsAttention ? '  <-- needs attention' : '';
  return (
    `${row.chaincode}/${row.collection}: ${row.outcome}${from}${reason}${flag}`
  );
}

function printWarnings(report: MergeReport): void {
  if (report.warnings.length === 0) return;
  console.log(`\n  Warnings (${report.warnings.length}):`);
  for (const warning of report.warnings) {
    console.log(`    - ${warning}`);
  }
}

/**
 * Print what stops a sign-off, and what to do about it.
 *
 * Both blockers mean the same thing in different places: the merge cannot say
 * what the combined extraction holds. A value conflict means two members
 * disagree about one key; an unexplained or indeterminate collection means
 * nobody has established why data is missing. Neither is loss a data owner can
 * accept, because neither states what was lost.
 */
function printBlockers(report: MergeReport): void {
  if (report.ok) return;
  console.log('');

  if (report.conflicts.length > 0) {
    console.log(`  ${report.conflicts.length} private key(s) differ between members:`);
    for (const conflict of report.conflicts.slice(0, 10)) {
      const members = Object.keys(conflict.digests).join(' vs ');
      console.log(
        `    ${conflict.channel}/${conflict.chaincode}/` +
          `${conflict.collection}/${conflict.key}: ${members} ` +
          `(kept ${conflict.kept})`,
      );
    }
    if (report.conflicts.length > 10) {
      console.log(
        `    ... ${report.conflicts.length - 10} more in merge-report.json`,
      );
    }
    console.log(
      '  Two members cannot hold different values for one key at one ledger ' +
        'height. Re-extract both at the agreed height before replaying.',
    );
  }

  const blocked = report.channels.flatMap((c) =>
    c.coverage.filter((row) => row.needsAttention).map((row) => ({
      channel: c.channelId,
      row,
    })),
  );
  if (blocked.length > 0) {
    console.log(`  ${blocked.length} collection(s) have no established cause:`);
    for (const { channel, row } of blocked) {
      console.log(
        `    ${channel}/${row.chaincode}/${row.collection}: ${row.reason}`,
      );
    }
    console.log(
      '  An unexplained collection is not accepted purge loss. Confirm which ' +
        'MSP is in each policy and re-extract from a member that is, or ' +
        'record why the data is gone before signing off.',
    );
  }

  console.log('');
}

function printNextSteps(outputDir: string): void {
  console.log('\nNext steps:');
  console.log(`  1. Validate the merged output:`);
  console.log(
    `     node dist/cli/index.js validate --input-dir ${outputDir}`,
  );
  console.log('  2. Generate a replay config:');
  console.log(
    `     node dist/cli/index.js generate-replay-config --input-dir ${outputDir}`,
  );
  console.log(
    '  3. Replay the merged directory — not the per-member ones, which each ' +
      'hold only their own private data.',
  );
  console.log('');
}
