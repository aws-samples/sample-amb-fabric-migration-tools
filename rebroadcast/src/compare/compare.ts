/**
 * `compare`: the destination's blocks against the archive, block by block.
 *   via the orderer: transaction count, data_hash and transaction IDs by position (what the orderer can show)
 *   via a peer:      the same, plus the validation code of every transaction and the commit hash, i.e. the peer
 *                    reached the same verdicts and the same state as the source's peers
 * Config blocks differ by construction (destination orderer group, added roots) and are counted, not compared.
 */
import { Archive } from '../archive/reader';
import { Destination, reachableHeight } from '../destination';
import { decodeBlock } from '../fabric/blocks';
import { Exit, RbError } from '../util/errors';

export interface CompareSummary {
  via: string; compared: number; txBlocks: number; configBlocks: number; differ: { n: number; why: string }[];
  destinationHeight: number; archiveHeight: number;
  /** Via a peer: transaction blocks whose source block carries no commit hash, so the hash could not be compared. */
  commitHashUnchecked: number;
}

export async function compare(archive: Archive, dst: Destination, via: 'orderer' | number, log: (s: string) => void): Promise<CompareSummary> {
  const src = via === 'orderer' ? dst.orderer : dst.peers[via];
  if (!src) throw new RbError(Exit.Usage, `the descriptor has no peer ${via}`);
  const viaName = via === 'orderer' ? 'orderer' : `peer ${dst.ld.d.peers![via].address}`;
  let h: number;
  if (via === 'orderer') {
    h = await reachableHeight(dst);
  } else {
    try {
      h = await src.height();
    } catch (e) {
      const message = (e as Error).message;
      if (/Deliver status FORBIDDEN/.test(message)) {
        const ordererHeight = await reachableHeight(dst);
        throw new RbError(
          Exit.Behind,
          `${viaName} refused ${dst.ld.d.peers![via].reader.msp} (Deliver FORBIDDEN) before its height could be read; ` +
            `the orderer is at height ${ordererHeight} of archive height ${archive.height}. The peer may not yet have ` +
            'committed the config block that adds this org; an invalid reader identity or ACL produces the same status. ' +
            'Check the reader and peer logs, then wait for catch-up if the identity is valid.',
        );
      }
      throw new RbError(Exit.Unreachable, `${viaName}: ${message}`);
    }
  }
  const upTo = Math.min(h, archive.height);
  const out: CompareSummary = { via: viaName, compared: 0, txBlocks: 0, configBlocks: 0, differ: [], destinationHeight: h, archiveHeight: archive.height, commitHashUnchecked: 0 };
  const feed = src.feed(0);
  // A peer refuses Deliver to an org its channel config does not yet name. An org added by a later config block is
  // therefore refused by its own peer until that peer has committed that block: the peer is behind, not unreachable.
  const behindOrRethrow = (e: Error): never => {
    if (via !== 'orderer' && /Deliver status FORBIDDEN/.test(e.message) && h < archive.height) {
      throw new RbError(
        Exit.Behind,
        `${viaName} refused ${dst.ld.d.peers![via].reader.msp} (Deliver FORBIDDEN) at height ${h} of ${archive.height}. ` +
          'The peer is behind; if this org was added later, it cannot use that reader until it commits the adding ' +
          'config block. An invalid reader identity or ACL produces the same status, so check those if catch-up does not resolve it.',
      );
    }
    throw e;
  };
  try {
    for (let n = 0; n < upTo; n++) {
      const d = decodeBlock((await feed.get(n, 60000).catch(behindOrRethrow)).bytes);
      const s = archive.block(n);
      out.compared++;
      if (s.isConfig || d.isConfig) {
        out.configBlocks++;
        if (s.isConfig !== d.isConfig) out.differ.push({ n, why: `config block on one side only` });
        continue;
      }
      out.txBlocks++;
      const why: string[] = [];
      if (d.txs.length !== s.txs.length) why.push(`${d.txs.length} txs vs ${s.txs.length}`);
      if (d.dataHash !== s.dataHash) why.push('data_hash');
      const idDiff = s.txs.findIndex((t, i) => d.txs[i]?.txId !== t.txId);
      if (idDiff >= 0) why.push(`tx ${idDiff} id`);
      if (via !== 'orderer') {
        if (s.validationFlags.length && Buffer.compare(s.validationFlags, d.validationFlags) !== 0) {
          const i = s.txs.findIndex((t, k) => t.code !== d.txs[k]?.code);
          why.push(`validation code of tx ${i} (${s.txs[i]?.code} vs ${d.txs[i]?.code})`);
        }
        // A peer adds commit hashes from block 1, or after a block that has one, so a ledger that started on a
        // Fabric version without them has none on any block. Nothing to compare there; a fresh destination has one.
        if (!s.commitHash) out.commitHashUnchecked++;
        else if (s.commitHash !== d.commitHash) why.push(d.commitHash ? 'commit hash' : 'commit hash missing from destination');
      }
      if (why.length) out.differ.push({ n, why: why.join(', ') });
      if (n && n % 500 === 0) log(`  compared ${n} blocks`);
    }
  } finally {
    feed.close();
  }
  return out;
}
