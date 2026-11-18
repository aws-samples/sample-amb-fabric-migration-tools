// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * A destination opened from its descriptor: clients for its orderer and peers, and the identities the tool signs with.
 */
import { LoadedDescriptor, loadSigner } from './descriptor';
import { Identity } from './config/signer';
import { Configtxlator, ConfigJson } from './config/configtxlator';
import { Orderer, Peer, endpointFrom } from './orderer/client';
import { decodeBlock } from './fabric/blocks';
import { Exit, RbError } from './util/errors';

export interface Destination {
  ld: LoadedDescriptor;
  channel: string;
  orderer: Orderer;
  peers: Peer[];
  ctl: Configtxlator;
  /** Signs as a source org, keyed by the source MSP ID. */
  orgSigners: Map<string, Identity>;
  /** Signs changes to the Orderer group or channel-level values: the platform org on a provider, the orderer org when self-managed. */
  ordererAdmin?: Identity;
  /** Signs the first update on a provider, while the platform's org is the channel's only application org. */
  platformAdmin?: Identity;
  /** The orderer reader: signs Deliver requests, and submits bundle updates (a channel Writer). */
  reader: Identity;
  close(): void;
}

export function openDestination(ld: LoadedDescriptor, channel: string): Destination {
  const { d, p } = ld;
  const reader = loadSigner(ld, d.orderer.reader, d.orderer.reader.msp);
  const orderer = new Orderer(d.orderer.endpoints.map((e) => endpointFrom(e, p)), channel, reader);
  const peers = (d.peers ?? []).map((e) => new Peer(endpointFrom(e, p), channel, loadSigner(ld, e.reader, e.reader.msp)));
  const orgSigners = new Map<string, Identity>();
  for (const [mspId, o] of Object.entries(d.orgs)) if (o.signer.mode === 'local') orgSigners.set(mspId, loadSigner(ld, o.signer as { cert: string; key: string }, mspId));
  const platformAdmin = d.platform ? loadSigner(ld, d.platform.admin, d.platform.msp) : undefined;
  const ordererAdmin = d.profile === 'provider' ? platformAdmin : d.ordererOrg ? loadSigner(ld, d.ordererOrg.admin, d.ordererOrg.msp) : undefined;
  const ctl = new Configtxlator(d.configtxlator ? p(d.configtxlator.path) : 'configtxlator', d.configtxlator?.sha256);
  return {
    ld, channel, orderer, peers, ctl, orgSigners, ordererAdmin, platformAdmin, reader,
    close: () => { orderer.close(); peers.forEach((x) => x.close()); },
  };
}

/** Height, or exit 11 with the reason. */
export async function reachableHeight(dst: Destination): Promise<number> {
  try {
    return await dst.orderer.height();
  } catch (e) {
    const m = (e as Error).message;
    if (/NOT_FOUND/.test(m)) throw new RbError(Exit.Unreachable, `channel ${dst.channel} does not exist on the destination orderer ${dst.orderer.address} (or this reader may not see it): create it first`);
    throw new RbError(Exit.Unreachable, `cannot read channel ${dst.channel} from any destination orderer (${dst.orderer.addresses.join(', ')}): ${m}`);
  }
}

/**
 * Refuse to read through a peer that has not committed every block the orderer has.
 *
 * A peer commits behind the orderer (private-data pulls, CouchDB), and anything read through it before it catches up
 * describes an older ledger: a `verify` would report differences that are not there, a lifecycle step would wait for a
 * commit that has not happened, and an `import-private` plan would count present keys as missing.
 */
export async function requirePeersCaughtUp(dst: Destination, indexes: number[]): Promise<void> {
  const ordererHeight = await reachableHeight(dst);
  for (const i of indexes) {
    const p = dst.peers[i];
    if (!p) throw new RbError(Exit.Usage, `the descriptor has no peers[${i}]`);
    const h = await p.height().catch((e: Error) => { throw new RbError(Exit.Unreachable, `peer ${p.address}: ${e.message}`); });
    if (h < ordererHeight) {
      throw new RbError(Exit.Behind, `peer ${p.address} is at height ${h}, the orderer at ${ordererHeight}: wait until the peer has committed every block, then re-run`);
    }
  }
}

/** The destination's current channel config (from its last config block). */
export async function liveConfig(dst: Destination): Promise<{ config: ConfigJson; blockNumber: number }> {
  const newest = decodeBlock(await dst.orderer.fetch('newest'));
  const idx = newest.isConfig ? newest.number : newest.lastConfig;
  return { config: dst.ctl.blockConfig(await dst.orderer.fetch(idx)), blockNumber: idx };
}
