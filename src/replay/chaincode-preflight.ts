// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { Network } from '@hyperledger/fabric-gateway';
import { ChaincodeInfo, ReplayConfig } from '../types';
import { FileLayoutManager } from '../output/file-layout-manager';
import { PrivateWriteTarget } from './collection-preflight';
import {
  DEFAULT_MIGRATION_CONTRACT,
  mappedFunction,
  parseQualifiedFunction,
} from './function-mapping';
import { NdjsonReader } from './ndjson-reader';

/**
 * The migration contract's key listing, used here only to make it answer.
 *
 * The wire contract is `sample/chaincode/migration_contract/README.md`; the
 * verify runner names the same function for its reverse key sweep. It is the one
 * read the contract offers that succeeds against any destination: `ReadState`
 * needs a key that already exists, and everything else is a submit.
 */
const LIST_KEYS_FUNCTION = 'ListKeys';

/**
 * Keys asked for when probing. One is enough to prove the contract answers, and
 * a range query carries every value in the page from the peer to the chaincode,
 * so the smallest page is also the cheapest question.
 */
const PROBE_PAGE_SIZE = 1;

/** One chaincode a replay will write into, on one channel pair. */
export interface DeploymentTarget {
  /** Source channel the records came from. */
  channel: string;
  /** Destination channel they will be written to. */
  destChannel: string;
  /** Chaincode name, which is also its state namespace on both networks. */
  chaincode: string;
  /**
   * Whether this deployment has private data in scope.
   *
   * Private writes always go through the migration contract — the value travels
   * as transient data under the contract's own wire convention and cannot be
   * pointed elsewhere — so this decides whether the contract has to answer even
   * where every public write is mapped to an application contract.
   */
  hasPrivateData: boolean;
}

/**
 * Why a destination chaincode cannot take the writes addressed to it.
 *
 * chaincode-missing    — the destination channel has no chaincode of that name,
 *                        so there is no state namespace to write into.
 * contract-unanswered  — the chaincode is committed but the configured migration
 *                        contract did not answer, so every write to it fails.
 */
export type DeploymentBlockerKind = 'chaincode-missing' | 'contract-unanswered';

export interface DeploymentBlocker extends DeploymentTarget {
  kind: DeploymentBlockerKind;
  detail: string;
}

export interface DeploymentPreflightResult {
  blockers: DeploymentBlocker[];
  /** What could not be established, one note per unresolved question. */
  unchecked: string[];
  /** Deployments whose migration contract answered. */
  checked: number;
}

/** Committed chaincodes on a destination channel, as the lifecycle reports them. */
export type DestinationLookup = (
  destChannel: string,
) => Promise<ChaincodeInfo[]>;

/**
 * Ask one destination chaincode's migration contract to answer.
 *
 * @returns null when it answered, or the reason it did not.
 */
export type ContractProbe = (
  destChannel: string,
  chaincode: string,
) => Promise<string | null>;

/** Committed chaincode definitions per destination channel. */
export interface DestinationDefinitions {
  /**
   * One entry per destination channel that answered. A channel absent from the
   * map would not answer, which `unchecked` accounts for — so a caller that
   * finds nothing under a channel must not read it as "nothing is committed".
   */
  byChannel: Map<string, ChaincodeInfo[]>;
  /** One note per destination channel whose definitions could not be read. */
  unchecked: string[];
}

/**
 * Read what every destination channel has committed, once.
 *
 * Both halves of the pre-flight ask about the same definitions — which
 * chaincodes exist, and which collections they declare — so they are read up
 * front and shared. Asking twice would also admit a destination that answered
 * one question and not the other, which no report could describe.
 *
 * A channel that will not answer is left out rather than treated as empty. It is
 * worth reporting and is not grounds to refuse: a lifecycle query the client
 * cannot make says nothing about whether the chaincode itself works, and the
 * probe below establishes that without it.
 */
export async function readDestinationDefinitions(
  destChannels: string[],
  lookup: DestinationLookup,
): Promise<DestinationDefinitions> {
  const byChannel = new Map<string, ChaincodeInfo[]>();
  const unchecked: string[] = [];

  for (const destChannel of [...new Set(destChannels)]) {
    try {
      byChannel.set(destChannel, await lookup(destChannel));
    } catch (err) {
      unchecked.push(
        `destination channel ${destChannel}: could not read committed ` +
        `chaincodes (${(err as Error).message}), so neither the chaincode ` +
        'names committed there nor collection membership was checked',
      );
    }
  }

  return { byChannel, unchecked };
}

/**
 * List the chaincodes a chaincode replay will write into.
 *
 * Driven by the records on disk rather than by the manifest, for the reason the
 * private targets are: a chaincode the extraction named but wrote nothing for
 * has nothing to fail at, and refusing a migration over it would demand a
 * destination deployment that no record needs. The manifest is not even a safe
 * bound on the scan — `merge` already treats it as possibly stale — so the
 * public file is read to its end.
 *
 * That is one extra pass over the largest file in the extraction, which is worth
 * it: the pass that follows submits a transaction per record and waits for it to
 * commit, so reading the file again costs a fraction of what one avoided run
 * does.
 *
 * @param reader Shared NDJSON reader.
 * @param layout Layout rooted at the extraction directory being replayed.
 * @param pairs Source/destination channel pairs in scope for this run.
 * @param replayHistory Whether the run replays history, which decides both the
 *   public file it reads and which private files the targets came from.
 * @param privateTargets Private write targets, from `listPrivateWriteTargets`.
 * @returns One deployment per `(channel, chaincode)`, ordered by chaincode name
 *   so reports built from it are reproducible.
 */
export async function listDeployments(
  reader: NdjsonReader,
  layout: FileLayoutManager,
  pairs: Array<{ channel: string; destChannel: string }>,
  replayHistory: boolean,
  privateTargets: PrivateWriteTarget[],
): Promise<DeploymentTarget[]> {
  const deployments: DeploymentTarget[] = [];

  for (const { channel, destChannel } of pairs) {
    const withPrivate = new Set(
      privateTargets
        .filter((target) => target.channel === channel)
        .map((target) => target.chaincode),
    );
    const names = new Set(withPrivate);

    const publicPath = path.join(
      layout.baseDir,
      replayHistory
        ? layout.publicHistoryPath(channel)
        : layout.publicStatePath(channel),
    );
    for await (const record of reader.stream(publicPath)) {
      const named = record as { chaincode?: string };
      if (named.chaincode) names.add(named.chaincode);
    }

    for (const chaincode of [...names].sort()) {
      deployments.push({
        channel,
        destChannel,
        chaincode,
        hasPrivateData: withPrivate.has(chaincode),
      });
    }
  }

  return deployments;
}

/**
 * Confirm every destination chaincode exists and answers, before the first write.
 *
 * A chaincode name is its state namespace on both networks and nothing here
 * renames one, so a destination that spells a chaincode differently — or has not
 * committed it at all — fails on every record with a peer-side error that names
 * no cause. The same is true of a chaincode committed without the migration
 * contract registered beside its own.
 *
 * The probe is cached per `(destChannel, chaincode)`, so a chaincode reached from
 * two source channels mapped onto one destination is asked once and reported per
 * source channel — the channel is what an operator has to act on.
 */
export async function preflightDeployments(
  deployments: DeploymentTarget[],
  ccConfig: NonNullable<ReplayConfig['chaincode']>,
  definitions: Map<string, ChaincodeInfo[]>,
  probe: ContractProbe,
): Promise<DeploymentPreflightResult> {
  const contract = ccConfig.migrationContract ?? DEFAULT_MIGRATION_CONTRACT;
  const blockers: DeploymentBlocker[] = [];
  const unchecked = new Set<string>();
  const probed = new Map<string, string | null>();
  let checked = 0;

  for (const deployment of deployments) {
    const defs = definitions.get(deployment.destChannel);
    if (defs !== undefined && !defs.some((d) => d.name === deployment.chaincode)) {
      blockers.push(missingChaincode(deployment, defs));
      continue;
    }

    if (!invokesMigrationContract(ccConfig, deployment, contract)) {
      unchecked.add(applicationContractNote(deployment, contract));
      continue;
    }

    const failure = await probeOnce(probed, probe, deployment);
    if (failure === null) checked++;
    else blockers.push(unansweredContract(deployment, failure, contract));
  }

  return { blockers, unchecked: [...unchecked], checked };
}

/**
 * Whether replay will call the migration contract for one deployment.
 *
 * Private data always does. A public write does unless `keyMapping` sends it to
 * another contract, and a delete unless `deleteMapping` does — and a run that
 * does not replay history submits no delete at all, so its `deleteMapping` says
 * nothing about which contract has to answer.
 *
 * A deployment whose every call goes to an application contract is left
 * unprobed: the migration contract need not be registered for it, and this tool
 * defines no function it could call on a contract it does not define.
 */
function invokesMigrationContract(
  ccConfig: NonNullable<ReplayConfig['chaincode']>,
  deployment: DeploymentTarget,
  contract: string,
): boolean {
  if (deployment.hasPrivateData) return true;

  const { channel, chaincode } = deployment;
  const write = mappedFunction(ccConfig.keyMapping, channel, chaincode);
  if (write === undefined) return true;
  if (parseQualifiedFunction(write, contract).isMigrationContract) return true;

  if (!ccConfig.replayHistory) return false;
  const remove = mappedFunction(ccConfig.deleteMapping, channel, chaincode);
  if (remove === undefined) return true;
  return parseQualifiedFunction(remove, contract).isMigrationContract;
}

/** Probe a `(destChannel, chaincode)` at most once, whatever the answer. */
async function probeOnce(
  probed: Map<string, string | null>,
  probe: ContractProbe,
  deployment: DeploymentTarget,
): Promise<string | null> {
  const key = `${deployment.destChannel}/${deployment.chaincode}`;
  const cached = probed.get(key);
  if (cached !== undefined) return cached;

  const failure = await probe(deployment.destChannel, deployment.chaincode);
  probed.set(key, failure);
  return failure;
}

function missingChaincode(
  deployment: DeploymentTarget,
  defs: ChaincodeInfo[],
): DeploymentBlocker {
  return {
    ...deployment,
    kind: 'chaincode-missing',
    detail:
      `no chaincode named ${deployment.chaincode} is committed on ` +
      `${deployment.destChannel} (it has ${defs.length}: ` +
      `${defs.map((d) => d.name).join(', ') || 'none'})`,
  };
}

function unansweredContract(
  deployment: DeploymentTarget,
  failure: string,
  contract: string,
): DeploymentBlocker {
  return {
    ...deployment,
    kind: 'contract-unanswered',
    detail:
      `${deployment.chaincode} is committed on ${deployment.destChannel}, but ` +
      `${contract} did not answer ${LIST_KEYS_FUNCTION} there: ${failure}`,
  };
}

function applicationContractNote(
  deployment: DeploymentTarget,
  contract: string,
): string {
  return (
    `${deployment.channel}/${deployment.chaincode}: every write is mapped to ` +
    `a contract other than ${contract}, so whether the destination's own ` +
    'contract answers was not established — nothing here knows a function to ' +
    'call on it'
  );
}

/**
 * Build a probe over the gateway and identity the writes themselves will use.
 *
 * That is what makes a failed probe grounds to refuse rather than to warn: it is
 * the same connection, the same peer and the same chaincode the first record
 * would reach, so a contract that will not answer here will not take a write
 * either. An evaluate does not exercise the contract's writer allow-list, which
 * gates submits only — the first replayed key reports that, naming the MSP.
 *
 * The answer is checked and not just awaited, because a contract that answered
 * with something else is not the migration contract, and the writes go to the
 * same name.
 */
export function migrationContractProbe(
  networkFor: (destChannel: string) => Network,
  contract: string,
): ContractProbe {
  return async (destChannel, chaincode) => {
    try {
      const page = await networkFor(destChannel)
        .getContract(chaincode, contract)
        .evaluateTransaction(
          LIST_KEYS_FUNCTION, String(PROBE_PAGE_SIZE), '',
        );
      return keyPageProblem(page);
    } catch (err) {
      return (err as Error).message;
    }
  };
}

/** How a page of keys failed to be one, or null if it is one. */
function keyPageProblem(answer: Uint8Array): string | null {
  const text = Buffer.from(answer).toString('utf-8');
  try {
    const page = JSON.parse(text);
    if (!Array.isArray(page?.keys) || typeof page?.bookmark !== 'string') {
      return `it answered ${text.slice(0, 200)}, not a page of keys`;
    }
  } catch {
    return `it answered ${text.slice(0, 200)}, which is not JSON`;
  }
  return null;
}

/**
 * Explain a refused pre-flight and what to change.
 *
 * Grouped by remedy rather than by channel, like the collection refusal:
 * committing a chaincode that is not there and registering a contract on one
 * that is are two different jobs.
 */
export function formatDeploymentRefusal(blockers: DeploymentBlocker[]): string {
  const lines = blockers.map(
    (b) => `  ${b.channel}/${b.chaincode}: ${b.detail}`,
  );

  const remedies: string[] = [];
  if (blockers.some((b) => b.kind === 'chaincode-missing')) {
    remedies.push(
      'For a chaincode the destination channel does not have, commit it there ' +
      'under the same name the source used — a chaincode name is its state ' +
      'namespace and nothing here renames one — or map the source channel ' +
      'elsewhere in chaincode.channelMapping.',
    );
  }
  if (blockers.some((b) => b.kind === 'contract-unanswered')) {
    remedies.push(
      'For a chaincode whose migration contract did not answer, register the ' +
      'contract beside the destination chaincode\'s own and re-commit it ' +
      '(sample/chaincode/migration_contract/README.md), and check ' +
      'chaincode.migrationContract if the destination registers it under ' +
      'another name. Where the destination\'s own contract owns the writes ' +
      'instead, name its functions in chaincode.keyMapping and ' +
      'chaincode.deleteMapping — which is possible only for a chaincode with ' +
      'no private data, since a private write has no configurable function.',
    );
  }

  return (
    `${blockers.length} destination chaincode(s) cannot take the writes this ` +
    'run would send them, so this run is refusing to start:\n' +
    `${lines.join('\n')}\n` +
    `${remedies.join('\n')}`
  );
}

/**
 * Reads the first page of one destination namespace's public keys.
 *
 * @returns The number of keys on the page (0 for an empty namespace).
 */
export type KeyPageProbe = (
  destChannel: string,
  chaincode: string,
) => Promise<number>;

/** A destination namespace a one-shot history replay would append to. */
export interface OccupiedNamespace {
  channel: string;
  destChannel: string;
  chaincode: string;
}

/**
 * Find destination namespaces that already hold public keys.
 *
 * Only asked for a legacy Tier 3 history replay starting from no checkpoint.
 * That replay is one-shot: every write appends a history entry, so writing it
 * over a destination that already holds an earlier attempt — or another run's
 * data — duplicates every key's history, and `verify` then fails with nothing
 * left to do but reset. Measured nowhere because it cannot be undone; refused
 * here because it is cheap to see coming: one `ListKeys` page of size 1 per
 * namespace. Private collections cannot be listed and are not checked.
 *
 * A namespace that cannot be listed (an application contract owns the writes,
 * or the probe errors) is reported as unchecked, not occupied.
 */
export async function findOccupiedNamespaces(
  deployments: DeploymentTarget[],
  probe: KeyPageProbe,
): Promise<{ occupied: OccupiedNamespace[]; unchecked: string[] }> {
  const occupied: OccupiedNamespace[] = [];
  const unchecked: string[] = [];
  const seen = new Set<string>();

  for (const d of deployments) {
    const key = `${d.destChannel}\0${d.chaincode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (await probe(d.destChannel, d.chaincode) > 0) {
        occupied.push({ channel: d.channel, destChannel: d.destChannel, chaincode: d.chaincode });
      }
    } catch (err) {
      unchecked.push(
        `${d.channel}/${d.chaincode}: could not list ${d.chaincode}'s keys on ` +
        `${d.destChannel} (${(err as Error).message}), so whether the history ` +
        'replay would append to existing data was not checked',
      );
    }
  }
  return { occupied, unchecked };
}

/** A `KeyPageProbe` over the migration contract's `ListKeys`. */
export function keyPageProbe(
  networkFor: (destChannel: string) => Network,
  contract: string,
): KeyPageProbe {
  return async (destChannel, chaincode) => {
    const answer = await networkFor(destChannel)
      .getContract(chaincode, contract)
      .evaluateTransaction(LIST_KEYS_FUNCTION, String(PROBE_PAGE_SIZE), '');
    const problem = keyPageProblem(answer);
    if (problem) throw new Error(problem);
    return JSON.parse(Buffer.from(answer).toString('utf-8')).keys.length;
  };
}

/** Explain a refusal to append a one-shot history replay to existing data. */
export function formatOccupiedRefusal(occupied: OccupiedNamespace[]): string {
  return (
    `${occupied.length} destination namespace(s) already hold keys, and this ` +
    'is a Tier 3 history replay without chaincode.historyImport — one-shot: ' +
    'every write appends a history entry, so replaying over existing data ' +
    'duplicates history that cannot be removed. Refusing before the first ' +
    'write:\n' +
    occupied.map((o) => `  ${o.channel}/${o.chaincode} on ${o.destChannel}`).join('\n') +
    '\nReplay into a new or reset destination channel, or configure ' +
    'chaincode.historyImport, whose receipts make a re-run a no-op.'
  );
}
