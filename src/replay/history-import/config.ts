// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Validate and resolve `chaincode.historyImport`, the opt-in to resilient,
 * idempotent Tier 3 history replay.
 *
 * Everything here runs before the destination is contacted: an invalid scope,
 * an unreadable key, a mode this build does not implement, or a public mapping
 * the protocol cannot honour is a refusal to start, not a per-record failure.
 */
import * as fs from 'fs';
import { ReplayConfig } from '../../types';
import { ReplayError } from '../../utils/errors';
import {
  DEFAULT_MIGRATION_CONTRACT,
  parseQualifiedFunction,
} from '../function-mapping';
import { PROTOCOL_VERSION } from './protocol';

type ChaincodeConfig = NonNullable<ReplayConfig['chaincode']>;

/** Scope: lowercase hex, 32–64 characters. */
const SCOPE_PATTERN = /^[0-9a-f]{32,64}$/;

/** Raw key length, in bytes. */
const RAW_KEY_BYTES = 32;

/** Hex key length, in characters. */
const HEX_KEY_CHARS = 64;

/** A validated, ready-to-use resilient history-import context. */
export interface ResilientHistoryContext {
  mode: typeof PROTOCOL_VERSION;
  /** Lowercase-hex scope namespacing the plan and receipts on the destination. */
  scope: string;
  /** The 32-byte HMAC key. Never leaves the client. */
  key: Buffer;
}

/**
 * Resolve the resilient history-import context, or `null` when the feature is
 * not configured (legacy replay is unchanged).
 *
 * @throws ReplayError when `historyImport` is present but invalid, or when the
 *   surrounding config cannot support it.
 */
export function resolveHistoryImport(
  ccConfig: ChaincodeConfig,
): ResilientHistoryContext | null {
  const raw = ccConfig.historyImport;
  if (raw === undefined) return null;

  if (!ccConfig.replayHistory) {
    throw new ReplayError(
      'chaincode.historyImport is set but chaincode.replayHistory is not. ' +
      'Resilient idempotent replay applies to Tier 3 history records only, so ' +
      'it is valid only with replayHistory: true.',
    );
  }

  if (raw.mode !== PROTOCOL_VERSION) {
    throw new ReplayError(
      `chaincode.historyImport.mode must be '${PROTOCOL_VERSION}', got ` +
      `${JSON.stringify(raw.mode)}. This build implements no other mode.`,
    );
  }

  if (typeof raw.scope !== 'string' || !SCOPE_PATTERN.test(raw.scope)) {
    throw new ReplayError(
      'chaincode.historyImport.scope must be 32–64 lowercase hex characters, ' +
      `got ${JSON.stringify(raw.scope)}. The scope namespaces this migration's ` +
      'plan and receipts on the destination contract.',
    );
  }

  const key = loadKey(raw.keyPath);
  assertNoApplicationMappings(ccConfig);

  return { mode: raw.mode, scope: raw.scope, key };
}

/**
 * Load the HMAC key from a file of 32 raw bytes or 64 hex characters.
 *
 * The two forms are told apart by length, which is unambiguous: a raw key is
 * exactly 32 bytes on disk, a hex key is 64 characters (any surrounding
 * whitespace trimmed first, so an editor's trailing newline is tolerated).
 *
 * @throws ReplayError when the file is missing or is neither form.
 */
function loadKey(keyPath: unknown): Buffer {
  if (typeof keyPath !== 'string' || keyPath.length === 0) {
    throw new ReplayError(
      'chaincode.historyImport.keyPath must be a path to a file holding the ' +
      '32-byte HMAC key (32 raw bytes or 64 hex characters).',
    );
  }

  let contents: Buffer;
  try {
    contents = fs.readFileSync(keyPath);
  } catch (err) {
    throw new ReplayError(
      `chaincode.historyImport.keyPath (${keyPath}) could not be read`,
      err as Error,
    );
  }

  if (contents.length === RAW_KEY_BYTES) return contents;

  const text = contents.toString('utf-8').trim();
  if (new RegExp(`^[0-9a-fA-F]{${HEX_KEY_CHARS}}$`).test(text)) {
    return Buffer.from(text, 'hex');
  }

  throw new ReplayError(
    `chaincode.historyImport.keyPath (${keyPath}) must contain exactly ` +
    `${RAW_KEY_BYTES} raw bytes or ${HEX_KEY_CHARS} hex characters. ` +
    `It holds ${contents.length} bytes, which is neither.`,
  );
}

/**
 * Refuse a resilient run whose public writes or deletes are mapped to an
 * application contract.
 *
 * Resilient history replay submits every public mutation through the migration
 * contract's `ImportHistory`/`ImportHistoryBatch`, which carry the operation ID
 * and intent commitment the idempotency protocol needs. An application's own
 * function knows nothing of that protocol, so a mapping pointing at one cannot
 * be honoured — it is refused rather than silently ignored or silently bypassing
 * the idempotency guarantee.
 *
 * @throws ReplayError naming every offending mapping entry.
 */
function assertNoApplicationMappings(ccConfig: ChaincodeConfig): void {
  const contract = ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
  const offenders: string[] = [];

  const scan = (mapName: 'keyMapping' | 'deleteMapping'): void => {
    const map = ccConfig[mapName];
    for (const [channel, byChaincode] of Object.entries(map ?? {})) {
      for (const [chaincode, fn] of Object.entries(byChaincode)) {
        if (!parseQualifiedFunction(fn, contract).isMigrationContract) {
          offenders.push(`chaincode.${mapName}["${channel}"]["${chaincode}"] = ${JSON.stringify(fn)}`);
        }
      }
    }
  };
  scan('keyMapping');
  scan('deleteMapping');

  if (offenders.length === 0) return;

  throw new ReplayError(
    'chaincode.historyImport requires every public write and delete to go ' +
    `through the ${contract} migration contract, but these map to an ` +
    `application contract:\n  ${offenders.join('\n  ')}\n` +
    'Resilient replay submits public history through ImportHistory / ' +
    'ImportHistoryBatch, which carry the operation ID and intent commitment ' +
    'the idempotency protocol depends on; an application function cannot ' +
    'participate in it. Point these at the migration contract, or remove ' +
    'chaincode.historyImport to use non-resilient history replay.',
  );
}
