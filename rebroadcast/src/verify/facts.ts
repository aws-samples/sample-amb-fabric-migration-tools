/**
 * The ledger facts a destination must hold, rebuilt from the archive's blocks exactly as a committing peer applies
 * them: only VALID endorser transactions (the source peer's validation codes, metadata[2]), every public write and
 * delete in ledger order, and the private-data hashes from each transaction's hashed rwset.
 */
import { common, ledger, peer } from '@hyperledger/fabric-protos';
import { Archive } from '../archive/reader';
import { Exit, RbError } from '../util/errors';
import { hex, u8 } from '../util/misc';

export interface Version { txId: string; value: Buffer; isDelete: boolean }
export interface Facts {
  /** namespace → key → the final write (a delete has an empty value). */
  state: Map<string, Map<string, Version>>;
  /** namespace → key → every VALID write, oldest first. */
  history: Map<string, Map<string, Version[]>>;
  /** "namespace/collection" → key hash (hex) → value hash (hex), live keys only. */
  privateHashes: Map<string, Map<string, string>>;
  /** "namespace/collection" → key hash (hex) → block of its last write, live keys only: when blockToLive expires it. */
  privateWriteBlock: Map<string, Map<string, number>>;
  /** The archive's last block number. */
  lastBlock: number;
  validTxs: number;
  skippedTxs: number;
}

const SYSTEM = new Set(['_lifecycle', 'lscc', 'cscc', 'qscc']);

export interface ValidAction { block: number; txId: string; rw: ledger.rwset.TxReadWriteSet }

/** Every chaincode action of every VALID endorser transaction, in ledger order; counts the rest. */
export function* validActions(archive: Archive, counts?: { valid: number; skipped: number }): Generator<ValidAction> {
  for (let n = 0; n < archive.height; n++) {
    const b = archive.block(n);
    if (b.isConfig) continue;
    for (const t of b.txs) {
      if (t.type !== 'ENDORSER_TRANSACTION') continue;
      if (t.code === undefined) throw new RbError(Exit.Usage, `block ${n} carries no validation codes: verify needs blocks as a source PEER committed them (metadata[2]), not orderer blocks`);
      if (t.code !== 'VALID') { if (counts) counts.skipped++; continue; }
      if (counts) counts.valid++;
      const pl = common.Payload.deserializeBinary(common.Envelope.deserializeBinary(t.envelope).getPayload_asU8());
      for (const a of peer.Transaction.deserializeBinary(pl.getData_asU8()).getActionsList()) {
        const cap = peer.ChaincodeActionPayload.deserializeBinary(a.getPayload_asU8());
        const prp = peer.ProposalResponsePayload.deserializeBinary(cap.getAction()!.getProposalResponsePayload_asU8());
        const ca = peer.ChaincodeAction.deserializeBinary(prp.getExtension_asU8());
        yield { block: n, txId: t.txId, rw: ledger.rwset.TxReadWriteSet.deserializeBinary(ca.getResults_asU8()) };
      }
    }
  }
}

export function rebuildFacts(archive: Archive): Facts {
  const f: Facts = { state: new Map(), history: new Map(), privateHashes: new Map(), privateWriteBlock: new Map(), lastBlock: archive.height - 1, validTxs: 0, skippedTxs: 0 };
  const sub = <K, V>(m: Map<string, Map<K, V>>, k: string): Map<K, V> => { let x = m.get(k); if (!x) m.set(k, (x = new Map())); return x; };
  const counts = { valid: 0, skipped: 0 };
  for (const { block, txId, rw } of validActions(archive, counts)) {
    for (const ns of rw.getNsRwsetList()) {
      const name = ns.getNamespace();
      if (SYSTEM.has(name)) continue;
      for (const w of ledger.rwset.kvrwset.KVRWSet.deserializeBinary(ns.getRwset_asU8()).getWritesList()) {
        const v: Version = { txId, value: u8(w.getValue_asU8()), isDelete: w.getIsDelete() };
        sub(f.state, name).set(w.getKey(), v);
        const h = sub(f.history, name);
        const list = h.get(w.getKey());
        if (list) list.push(v); else h.set(w.getKey(), [v]);
      }
      for (const c of ns.getCollectionHashedRwsetList()) {
        const g = `${name}/${c.getCollectionName()}`;
        const m = sub(f.privateHashes, g), wb = sub(f.privateWriteBlock, g);
        for (const hw of ledger.rwset.kvrwset.HashedRWSet.deserializeBinary(c.getHashedRwset_asU8()).getHashedWritesList()) {
          const kh = hex(hw.getKeyHash_asU8());
          if (hw.getIsDelete()) { m.delete(kh); wb.delete(kh); }
          else { m.set(kh, hex(hw.getValueHash_asU8())); wb.set(kh, block); }
        }
      }
    }
  }
  f.validTxs = counts.valid;
  f.skippedTxs = counts.skipped;
  return f;
}
