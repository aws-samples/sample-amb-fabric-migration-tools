# Re-broadcast: moving a Fabric channel block by block

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

This toolkit has two ways to move an AMB Fabric channel to another Fabric network. **Replay** (`amb-migrate replay`)
writes the extracted keys and values through chaincode. **Re-broadcast** (`fabric-rebroadcast`, in
[`rebroadcast/`](../rebroadcast/README.md)) re-sends the source channel's original signed transactions, unchanged and in
order, to a new ordering service, so the destination's block *N* holds the same transactions as the source's block *N*.

## Replay or re-broadcast

| | Replay (`amb-migrate replay`) | Re-broadcast (`fabric-rebroadcast`) |
|---|---|---|
| Destination | Fabric 2.4+, PostgreSQL or DynamoDB | Fabric 2.5 only |
| Transaction IDs, creators, signatures, endorsements, timestamps | New: every write is a migration transaction | **Kept** (the original envelopes) |
| `GetHistoryForKey` | One entry per key, or every version's value with `replayHistory` (new txIds and timestamps) | **Identical**, txIds and timestamps included |
| Invalid transactions and their validation codes | Not carried | **Kept**, in their positions |
| Block numbers and positions | Not kept | **Kept** |
| Per-block peer commit hash | n/a | **Identical** |
| Config blocks | n/a | Re-created and re-signed by the destination's admins |
| Block header hashes, orderer signatures | New chain | New chain: they differ from block 1 on |
| Private-data hashes | Written fresh | **Identical** (in the read-write sets) |
| Private-data current values | Written by replay | Re-imported at the end (`tip import-private`) |
| Private-data value history; values purged by `blockToLive` | Lost | Lost |
| Channel names, MSP IDs | Can be remapped | **Must stay the same** |
| Merge, split or rename channels or orgs | Yes | No |
| Destination must be empty and take no other writes during the run | Recommended | **Required** |
| Inputs | An extraction (`extract`, every member's private data merged) | The block archive (`extract --save-blocks`) plus each member's private values |

**Choose re-broadcast** when the destination is Fabric, the channel and MSP names can stay, and applications or
auditors rely on the original transaction IDs, signers or key history. **Choose replay** for a non-Fabric destination,
when channels or orgs must change, or when only current state (with or without its value history) matters.

Neither path makes the new chain a proof of the old one: it has its own block 0, header hashes and orderer signatures.
The proof that history is complete and in order is the archive of the original blocks, signed by the source's
orderers, which `compare` checks the destination against block by block. Keep that archive. `check-archive` verifies
its digests, data hashes and hash chain, but not the orderers' signatures it carries
([known limitations](known-limitations.md#trust-in-the-source-peer)). `run` repeats those checks before it sends
anything.

## Prerequisites

- **Block archive** of every channel, from `amb-migrate extract --save-blocks <dir>` (add `--blocks-only` to skip the
  extraction itself). It holds ledger values: protect it like the extraction output. One member's archive is enough:
  every member's peer serves the same blocks.
- **Private values** from every member that holds private data: an extraction per member, against its own peer
  (`private-*-state.ndjson`). Any tier writes them; Tier 3 also writes the private-hash files `validate` checks them
  against. The member that keeps the archive gets both from one run: `extract --tier 3 ... --save-blocks <dir>`.
  [Fabric destinations: replay or re-broadcast](decision-guide.md#fabric-destinations-replay-or-re-broadcast) sets out
  what each path needs from extraction.
- **Destination**: Fabric 2.5 orderers (Raft, channel participation) and peers, one org per source member **with the
  same MSP ID**. It must be empty: nothing else may write to the channel until the run and the tip phase are complete.
  - Orderer `BatchSize` at least the largest source block (`plan` checks it) and `BatchTimeout` of at least 500 ms
    (`probe` measures the right value).
  - Destination peers: `CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD=0s` during the run. Peers otherwise wait for
    private data no peer has, and commit far behind the orderer.
  - Optional patched orderer ([`rebroadcast/orderer-patch/`](../rebroadcast/orderer-patch/), against Fabric v2.5.14):
    `cut-markers` mode sends ahead instead of waiting out `BatchTimeout` per block (with
    `ORDERER_MIGRATION_CUT_MARKERS=true` on every orderer), and
    `ORDERER_MIGRATION_SKIP_EXPIRATION=true` accepts transactions whose signer certificate has since expired, which a
    stock orderer refuses. Use it during the migration window only.
- **Admin keys** of the orgs that must sign each config update, held locally or signed by each member in a ceremony
  ([signing kit](../rebroadcast/docs/signing-kit.md)).
- **Chaincode source** for every chaincode, with the [migration contract](../sample/chaincode/migration_contract/README.md)
  added, to redeploy at the next sequence. AMB does not export chaincode packages.
- `configtxlator` from Fabric 2.5 on `PATH`, Node 22.

## End to end

```bash
cd rebroadcast && npm ci && npm run build && npm link     # installs fabric-rebroadcast
A=./archive; D=./dest.json; C=mychannel                   # descriptor format: rebroadcast/README.md

fabric-rebroadcast check-archive $A --channel $C         # digests and hash chain
fabric-rebroadcast plan $A --dest $D --channel $C        # who signs each config block, batch sizes, estimate
fabric-rebroadcast genesis $A --dest $D --out g.block    # self-managed: join the orderers and peers with it
fabric-rebroadcast probe $A --dest $D --scratch scratch  # optional: measures BatchTimeout on a throwaway channel
fabric-rebroadcast run $A --dest $D --channel $C         # resumable: re-run the same command
fabric-rebroadcast compare $A --dest $D --channel $C --via 0   # every block, codes and commit hash, via a peer
```

To keep the cutover short, run while the source is still live. Then stop writes, run `amb-migrate discover` again and
`amb-migrate extract --save-blocks <dir> --blocks-only` on the same archive directory, which continues from the last
archived block, and run `run` again: it sends only the new blocks. Each member also runs `extract --extend` on its
extraction, so the private values imported below include those written since its first pass.

Then the tip phase, which makes the destination writable:

```bash
fabric-rebroadcast tip config --dest $D --channel $C --yes          # managed-provider destinations only
fabric-rebroadcast tip chaincode-check $A --dest $D --channel $C    # prints the approve/commit commands at the next sequence
# approve and commit each chaincode as printed, with the migration contract in its package
fabric-rebroadcast tip import-private $A --dest $D --channel $C --private <member output> --yes   # once per org
```

Then each member that holds private data verifies, through its own peer, with the same extraction output it gave
`import-private`:

```bash
fabric-rebroadcast verify $A --dest $D --channel $C --peer <this member's peer> --private <this member's output>
```

`verify` rebuilds the ledger from the archive and checks every key's state and history, every delete, extra keys,
and each private value against the hash in the blocks and the destination. Nothing is sampled.

Private data is checked by collection. A member's run must cover every collection that member can read. Verify knows
which member it is from the `metadata.json` in the extraction output, and from the verifying peer's org. A live
private key in such a collection with no value in `--private` fails the run (exit 6). The failure names the
collection and the members who can read it. Collections only other members can read are listed at the end, under
"still to verify", with the member who has to verify each. The gate is that every member named there gets exit 0
from its own run. No member's plaintext leaves that member's host, and no merge is needed.

- **A peer missing values.** A member's own peer can lack values of a collection it reads, for example after it
  committed blocks while far behind and gossip never reconciled them; `amb-migrate validate` reports this as private
  values with no explanation. Its `verify` then fails on that collection. Another reader of the collection can hand
  over just that collection's `private-<chaincode>-<collection>-state.ndjson`: put it in a directory beside the member's
  own output and pass the directory to `--private`. Nothing else of the other reader's data is shared, and the
  member's scope does not change, because scope comes from the `metadata.json` files.
- **blockToLive.** Keys that a collection's `blockToLive` purged at the source by the archive's last block are counted
  as "purged at source", not failed. No extraction can hold them. Compare the counts with the loss the data owners
  accepted.
- **Accepted loss.** For collections whose unchecked keys the data owners accepted in writing, add
  `--accept-unchecked <collection,...>`. Accepted collections are reported, and included in `--json`. Acceptance
  applies only to collections the verifying member can read: other members' collections stay on the "still to verify"
  list.
- **Public-only check.** Without `--private`, `--accept-unchecked all` lets a run that checks public state and history
  pass, for example in a rehearsal. Without either flag, a run with live private keys fails.
- **One operator holding every member's output** (a managed-provider destination, where the platform org holds all
  private data): give a directory holding each member's output, or a merged one. A merged output stands for every
  member.

Every command, its exit codes and the descriptor format are in the [rebroadcast README](../rebroadcast/README.md).

## What has been tested

Measured on AMB Fabric 2.2 and 1.4 source channels (up to five orgs, a few thousand blocks, private data and invalid
transactions) into Fabric 2.5 destinations on Docker and on Kubernetes (EKS), stock and patched orderers, with
`compare` and `verify` matching on every block and key; and on a synthetic 1-million-transaction channel through a
three-node Raft orderer, including an orderer failure mid-run and revoked signers. The cutover top-up was run from an AMB
Fabric 2.2 channel to a five-org destination: two rounds of new transactions, each archived with `--blocks-only` into the
same directory and sent by a resumed `run`, with `compare` matching every block. On the same channel, the `blockToLive`
rule `verify` uses picked out exactly the keys the AMB peers had purged. On EKS (three Raft orderers, one per AZ),
from AMB Fabric 2.2 channels: one orderer and then all three killed mid-run, with the run recovering by itself and
`compare` matching every block; transactions whose signer certificate had expired, refused by the stock orderer and
accepted by the patched one, the run resuming at the refused block; and the tip phase through `verify`
([EKS runbook](eks-fabric-runbook.md)). Limits and untested cases are in
[Known limitations](known-limitations.md#block-level-re-broadcast). Sizing figures are in
[Tuning](tuning.md#re-broadcast).

## AMB 1.4 sources

Blocks, history and provenance carry over unchanged. Two differences: an `lscc` chaincode must be upgraded to a new
version at the tip (no code change for plain Go chaincode), and private values can be read back only through
chaincode, byte-exact on LevelDB peers but not on CouchDB peers, which re-serialise JSON.
