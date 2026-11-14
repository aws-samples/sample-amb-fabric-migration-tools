# Known limitations

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

What the toolkit does not do yet, or has not been tested against. Open work is tracked as GitHub issues. Constraints
that come from Amazon Managed Blockchain rather than from this toolkit are in [AMB constraints](amb-constraints.md).

## Tested against

- **Sources:** AMB Hyperledger Fabric 2.2 networks with up to five members, several channels, private data
  collections (including one with `blockToLive`), and ledgers of a few thousand blocks per channel. AMB 1.4 for
  block-level re-broadcast. No AMB 1.2 network, and no real 1.2 or 1.4 block bytes in the test fixtures.
- **Destinations:** self-managed Fabric 2.5 (Docker on EC2, and Kubernetes): history replay, `verify`, resume and the
  destination guards. PostgreSQL: one live end-to-end run (replay, `verify`, re-run); CI uses a mocked client.
  DynamoDB: unit tests with a mocked client only, never against a real table.
- **Scale:** measured throughput and a duration model are in [Tuning](tuning.md). Ledgers of millions of blocks have
  not been extracted end to end.

## Extraction

- `extract --processes` cannot be combined with `--extend` yet; extend in one process.
- `replay --since` needs a Tier 2 or 3 extraction (Tier 3 when the channel has private data), and finds a Tier 2
  public key's chaincode from the transaction that wrote it, so a write made by one chaincode into another's namespace
  is attributed to the calling chaincode.
- `discover` chooses `_lifecycle` or `lscc` from the text of a refused query. That text has not been checked against a
  real 1.2 peer.
- With `--fabric-mode auto` or `gateway` (not the default, `legacy`), a transient `UNAVAILABLE` while connecting makes the
  tool fall back to the legacy SDK. The legacy SDK works with every AMB version, so this costs nothing but a log warning.
- No artifact records which peer node an extraction ran against beyond the `--node-id` given.
- A source peer that committed blocks while far behind the orderer can lack those blocks' private data until gossip
  reconciliation fetches it, and loses it for good when no peer of the collection kept it (with `requiredPeerCount:
  0`, a value can exist only in the endorsing peer's transient store, which Fabric purges every
  `transientstoreMaxBlockRetention` blocks). `extract` leaves a key whose latest write it has no value for out of
  current state rather than giving it an earlier value, and logs the collections and blocks affected. `validate` then
  reports private history completeness and keys with no value and no explanation. Before the final pass, check that
  the peer's height equals the orderer's and that `validate` passes on an `--extend`ed copy; if not, wait for
  reconciliation or extract the collection from another member's peer and merge.

## Trust in the source peer

What extraction checks about the blocks a peer serves, and what it takes on the peer's word.

- **Checked, every block.** Each header links to the one before it (the hash chain), and each block's transactions
  hash to its header's `data_hash`. A transaction the peer marked valid that cannot be decoded or parsed stops the
  walk. Private values are checked against the hashes recorded on chain, by `validate` and again by `merge`.
- **Taken from the peer: transaction validity.** Which transactions committed is recorded in block metadata, which no
  hash covers. The peer computed it when it committed the block and applied the same verdicts to its own state
  database, so any read through that peer, by this tool or otherwise, trusts it to the same degree.
- **Not checked: orderer signatures.** Neither `amb-migrate` nor `fabric-rebroadcast` (including `check-archive`)
  verifies the orderers' signatures on blocks. So a peer that serves a chain consistent with itself from block 0, but
  not the network's, would be accepted.
- **What limits that.** In a multi-member migration where members extract from their own peers, `merge` refuses when
  members' public files or private-hash files differ, so one peer serving another chain is caught there. The
  [cutover runbook](cutover-rehearsal-runbook.md) also requires every member to report the same `walkTip` header hash
  per channel. A single-member extraction has no second copy to compare against.

## Replay and verify

- Fabric replay reproduces keys and values, not the transactions that wrote them: destination history carries the
  migration's transaction IDs, timestamps and creator. See
  [History and provenance fidelity](replay-config-reference.md#history-and-provenance-fidelity). Re-broadcast keeps them.
- Identity-mapped replay (submitting each record as a mapped destination identity) is not built.
- Private history, block metadata, identities and private hashes are written to PostgreSQL and DynamoDB but not
  checked by `verify` ([#2](https://github.com/aws-samples/sample-amb-fabric-migration-tools/issues/2)). SQL checks
  for them are in the README.
- DynamoDB state replay writes one item per call; it has not been measured against a real table.
- Replayed values are not checked against the destination's transaction payload limit before they are sent
  ([#3](https://github.com/aws-samples/sample-amb-fabric-migration-tools/issues/3)).
- The migration contract stubs for Go, Java and Node compile and are unit tested; only the Go stub has run on a peer.
- A history replay without `historyImport` cannot be resumed after an interruption: it refuses rather than duplicate
  history, and the destination must be reset. Use `historyImport` for a replay that may be interrupted.

## Block-level re-broadcast

The `rebroadcast/` tool (`fabric-rebroadcast`) re-submits the original signed transactions to a new orderer. It is tested as described in [Re-broadcast](rebroadcast.md#what-has-been-tested). Known limits:

- Private-data values are not carried by blocks; they are re-imported at the tip, so private history is not kept.
- Signers whose certificates have expired are refused by a stock orderer (`plan` reports them as `BLOCKING
  [E6-expired-signers]`; `run` stops with exit 3, `broadcast client identity expired`, at the first one). The patched
  orderer with `ORDERER_MIGRATION_SKIP_EXPIRATION=true` accepts them; both were run on EKS
  ([EKS runbook](eks-fabric-runbook.md#expired-signers)). Peers do not check signer expiry when they validate.
- Not yet tested across separate hosts at scale, or with an orderer-only source config block. The signing ceremony and
  tip phase have run together on Kubernetes for five orgs, with private-data reconciliation between destination peers
  ([EKS runbook](eks-fabric-runbook.md#five-orgs-and-private-data-reconciliation)).
- `tip chaincode-check` confirms the migration contract answers, not that its writer list names every org that will
  run `import-private`: an org left out is refused only at its own import.
