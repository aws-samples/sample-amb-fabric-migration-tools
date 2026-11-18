// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Contract } from '@hyperledger/fabric-gateway';
import { collectionLabel } from './collection-routing';
import { PrivateWriteTarget } from './collection-preflight';

/**
 * The function every private write target is probed with. A single write's
 * endorsement plan is the batch's: both write one collection of one chaincode
 * and nothing else.
 */
const PROBE_FUNCTION = 'ImportPrivateData';
/**
 * Never committed: the probe endorses and stops. No leading underscore —
 * CouchDB state databases refuse such keys, which made an earlier spelling
 * fail every probe live.
 */
const PROBE_KEY = 'fabric-amb-extractor-preflight';
const PROBE_VALUE = new TextEncoder().encode('preflight');

/** A destination collection whose writes would be refused at endorsement. */
export interface EndorsementBlocker extends PrivateWriteTarget {
  /** What the gateway or the endorsing peers said. */
  detail: string;
  /** The gateway refused to plan it, as opposed to a peer refusing it. */
  planning: boolean;
}

/**
 * Endorse one write per destination collection, and submit none of them.
 *
 * The definition pre-flight reads policies; this asks the destination. It is
 * the only check that sees what the gateway will actually do with a write —
 * which orgs its endorsement plan needs, whether their peers are reachable,
 * whether the collection's distribution policy lets the private value be
 * sent to them, and whether the migration contract on each endorser accepts
 * the submitter. Each of those otherwise surfaces at the first private write,
 * which for a Tier 3 history replay is a destination reset.
 *
 * Measured live: under a chaincode policy of `AND` over every channel member,
 * a collection whose members are a subset of the channel cannot be written at
 * all — the gateway refuses to send its private value to the peers of orgs
 * outside the collection, and the policy needs them. The definition
 * pre-flight passed; the first `onlyA` write failed with `FAILED_PRECONDITION:
 * requires endorsement from organisation(s) that are not in the distribution
 * policy of the private data collection(s)`.
 *
 * Endorsing is a simulation. Nothing is ordered or committed, so the ledger is
 * untouched; the endorsing peers hold the probe value in their transient
 * stores until those purge it.
 *
 * @param contractFor The contract a write to the target goes through — the
 *   same resolution the adapter uses, identity and `ownerEndorsement` included.
 */
export async function probePrivateEndorsements(
  targets: PrivateWriteTarget[],
  contractFor: (target: PrivateWriteTarget) => Contract,
): Promise<EndorsementBlocker[]> {
  const blockers: EndorsementBlocker[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const key = [target.destChannel, target.chaincode, target.destCollection].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await contractFor(target)
        .newProposal(PROBE_FUNCTION, {
          arguments: [target.destCollection, PROBE_KEY],
          transientData: { private_value: PROBE_VALUE },
        })
        .endorse();
    } catch (err) {
      blockers.push({ ...target, ...describe(err) });
    }
  }

  return blockers;
}

/** The gateway's reason, with each endorser's own where it gave them. */
function describe(err: unknown): { detail: string; planning: boolean } {
  const e = err as { code?: number; details?: Array<{ mspId?: string; message?: string }>; message?: string };
  const peers = (e.details ?? [])
    .map((d) => `${d.mspId ?? 'peer'}: ${d.message ?? ''}`.trim())
    .filter((d) => d.length > 0);
  const message = e.message ?? String(err);
  return {
    detail: peers.length > 0 ? `${message} (${peers.join('; ')})` : message,
    // gRPC FAILED_PRECONDITION: the gateway could not build an endorsement
    // plan, before any peer ran the chaincode.
    planning: e.code === 9,
  };
}

/** Explain a refused endorsement probe and what to change. */
export function formatEndorsementRefusal(blockers: EndorsementBlocker[]): string {
  const lines = blockers.map(
    (b) => `  ${b.channel}/${b.chaincode}/` +
      `${collectionLabel(b.collection, b.destCollection)} on ${b.destChannel}: ${b.detail}`,
  );

  const remedies: string[] = [];
  if (blockers.some((b) => /distribution policy/.test(b.detail))) {
    remedies.push(
      'A collection whose members cannot satisfy the chaincode\'s endorsement ' +
      'policy on their own cannot be written through the Fabric Gateway: the ' +
      'policy needs peers of orgs outside the collection, and the gateway will ' +
      'not send them its private values. Give each such collection its own ' +
      'endorsementPolicy in the destination collection config, naming its ' +
      'members — the destination application needs that to write it too.',
    );
  }
  if (blockers.some((b) => !b.planning)) {
    remedies.push(
      'Where an endorsing peer refused the write, its reason is quoted above: ' +
      'commonly the migration contract\'s writer list not naming the ' +
      'submitting MSP, or the submitter not being admitted to the collection.',
    );
  }

  return (
    `${blockers.length} destination collection(s) refused a probe ` +
    'endorsement — nothing was submitted, and the run is refusing to start:\n' +
    `${lines.join('\n')}` +
    (remedies.length > 0 ? `\n${remedies.join('\n')}` : '')
  );
}
