// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { discoverCommand } from '../src/cli/commands/discover';
import { extractCommand } from '../src/cli/commands/extract';
import { captureFixturesCommand } from '../src/cli/commands/capture-fixtures';

const CONNECTION_DIR = path.join(__dirname, '../src/connection');

/** $HOME roots a default path; it is not a setting anyone points at this tool. */
const NOT_A_SETTING = new Set(['HOME']);

/**
 * The environment variables the connection path reads, from the code itself.
 *
 * Grepped rather than listed so that a variable added to `src/connection` is
 * one the assertions below immediately start demanding, instead of one that
 * quietly becomes a way to configure the tool that `--help` never mentions.
 */
function envVarsTheConnectionPathReads(): string[] {
  const found = new Set<string>();
  for (const file of fs.readdirSync(CONNECTION_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(CONNECTION_DIR, file), 'utf-8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!NOT_A_SETTING.has(match[1])) {
        found.add(match[1]);
      }
    }
  }
  return [...found].sort();
}

/**
 * `migrate` walks the same path but prompts for the MSP path and region rather
 * than naming them in `--help`, so it is not one of these.
 */
const CREDENTIAL_COMMANDS: Array<[string, Command]> = [
  ['discover', discoverCommand],
  ['extract', extractCommand],
  ['capture-fixtures', captureFixturesCommand],
];

describe('credentials by environment variable', () => {
  const expected = envVarsTheConnectionPathReads();

  it('reads the three documented variables out of the connection code', () => {
    // Not toEqual: a fourth variable should fail the help assertions below,
    // not this one. Pinning these three keeps the grep from going vacuous.
    expect(expected).toEqual(
      expect.arrayContaining(['CA_ENROLLMENT_SECRET', 'MSP_PATH', 'TLS_CA_CERT']),
    );
  });

  it.each(CREDENTIAL_COMMANDS)('%s --help names every one of them', (_name, command) => {
    const help = command.helpInformation();

    for (const variable of expected) {
      expect(help).toContain(`$${variable}`);
    }
  });

  it('tells capture-fixtures users the variables are the only way in', () => {
    // The other two take --msp-path and --tls-cert; this one takes neither, so
    // its help has to say so or the command looks impossible to authenticate.
    const help = captureFixturesCommand.helpInformation();

    expect(help).toContain('no credential flags');
    expect(captureFixturesCommand.options.map((o) => o.attributeName())).not.toContain('mspPath');
  });
});
