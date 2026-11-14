/** What each command is allowed to touch (design §6.4); an operator's guard policy can be checked against this list. */
export const COMMANDS = [
  { name: 'check-archive', class: 'read-only', reads: ['archive'], writes: [] },
  { name: 'plan', class: 'read-only', reads: ['archive', 'descriptor', 'destination (Deliver)'], writes: ['<workDir>/plan/<channel>.json'] },
  { name: 'genesis', class: 'local', reads: ['archive', 'descriptor', 'genesisTemplate'], writes: ['--out'] },
  { name: 'run', class: 'production', reads: ['archive', 'descriptor', 'destination', '--bundle'], writes: ['destination channel', '<workDir>/state/<channel>.json', '<workDir>/report/<channel>.ndjson'] },
  { name: 'compare', class: 'read-only', reads: ['archive', 'descriptor', 'destination (Deliver)'], writes: [] },
  { name: 'sign-config export', class: 'read-only', reads: ['archive', 'descriptor', 'destination (Deliver)'], writes: ['--out bundle'] },
  { name: 'sign-config sign', class: 'gated', reads: ['bundle', '--key (one org\'s admin key)'], writes: ['bundle/signatures (with --yes)'] },
  { name: 'sign-config import', class: 'local', reads: ['signature files'], writes: ['bundle/signatures'] },
  { name: 'sign-config verify', class: 'read-only', reads: ['bundle'], writes: [] },
  { name: 'probe', class: 'scratch-write', reads: ['archive', 'descriptor', 'scratch channel'], writes: ['scratch channel (filler transactions, one config update)'] },
  { name: 'verify', class: 'read-only', reads: ['archive', 'descriptor', 'destination peer', 'private values (optional)'], writes: [] },
  { name: 'tip config', class: 'gated', reads: ['descriptor', 'destination'], writes: ['one config update (with --yes)'] },
  { name: 'tip chaincode-check', class: 'read-only', reads: ['archive', 'descriptor', 'destination peer'], writes: ['collection config files (with --write-collections)'] },
  { name: 'tip import-private', class: 'gated', reads: ['archive', 'descriptor', 'private values', 'destination peers'], writes: ['private data transactions (with --yes)'] },
  { name: 'commands', class: 'read-only', reads: [], writes: [] },
] as const;
