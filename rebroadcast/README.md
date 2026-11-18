# fabric-rebroadcast

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Block-level migration of a Hyperledger Fabric channel. This tool re-sends the source channel's original signed transactions to a
Fabric 2.5 destination, unchanged and in order, so the destination's block *N* holds the same transactions as the source's block *N*,
in the same positions, with the same validation codes. Transaction IDs, signers, timestamps and key history stay the same. It is a new chain:
block 0, header hashes and orderer signatures are the destination's, and config blocks are re-created. The proof that history is complete
and in order is the archive of the original blocks (signed by AMB's orderers), not the new chain. Nothing in this tool verifies those
orderer signatures yet; see [known limitations](../docs/known-limitations.md#trust-in-the-source-peer).

Status: tested against self-managed and managed Fabric destinations — see
[what has been tested](../docs/rebroadcast.md#what-has-been-tested). User guide,
findings and procedure: [`../docs/rebroadcast.md`](../docs/rebroadcast.md).

This package is independent of the extractor. It has its own `package.json` and lockfile, and nothing in the root build, lint, test or
install includes it. The only contract between the two is the archive that `extract --save-blocks` writes.

## Install and build

```bash
cd rebroadcast
npm ci
npm run build && npm test
```

Needs Node 22+ and `configtxlator` (Fabric 2.5) on `PATH`, or pinned in the descriptor with its SHA-256.

## Commands

| Command | Class | What it does |
|---|---|---|
| `check-archive <archive> [--channel c]` | read-only | Checks sealed digests, data hashes and the hash chain (not orderer signatures) |
| `plan <archive> --dest d.json --channel c [--offline]` | read-only | Block survey, signer expiry, the config chain simulated offline (who signs each config block), batch-size preflight, estimate. Writes `plan/<c>.json`; exit 2 on a blocking finding |
| `genesis <archive> --dest d.json --out g.block` | local | Self-managed destinations only: the channel's genesis block. Join the orderers with it (`osnadmin channel join`), then `run` |
| `run <archive> --dest d.json --channel c` | **production** | The per-block loop, described below. Runs `check-archive`'s checks before contacting the destination, and refuses to resume from an archive other than the one the run started from (that archive extended, after the freeze, is accepted). Resumable: rerun the same command |
| `compare <archive> --dest d.json --channel c [--via orderer\|<peer index>]` | read-only | Compares every destination block with the archive. Via a peer it also compares validation codes and the commit hash; source blocks without a commit hash (a ledger that started on a Fabric version without them) are counted as not checked, not as differences |
| `sign-config export <archive> --dest d.json --channel c --out bundle/ [--offline]` | read-only | Computes every config update offline and writes a bundle: the update bytes (authoritative), who must sign each, and the config before and after |
| `sign-config sign <bundle> --msp M --cert c --key k [--yes]` | gated | One member, with its own key only. It decodes and re-applies every update, prints what each changes, and with `--yes` writes its signatures |
| `sign-config import <bundle> <files or dirs…>` | local | Copies signatures in. Each must sign this step's bytes, as a required org, with a certificate that chains to that org's roots |
| `sign-config verify <bundle>` | read-only | Per update: the signatures that are valid and those still missing. Exit 10 if any is missing |
| `run … --bundle <dir>` | **production** | Submits the bundle's updates and signatures unchanged. It refuses before sending anything if any signature is missing, and refuses at any config block whose destination config differs from the one the bundle was computed against |
| `probe <archive> --dest d.json --scratch s [--bursts n]` | scratch-channel writes | Sets the run's batch settings on a throwaway channel, then sends bursts shaped like the archive's largest blocks. Reports ingest percentiles and splits, and recommends a BatchTimeout of max(500 ms, 3 × p99). Exit 2 if any burst split |
| `tip config --dest d.json --channel c [--yes]` | gated | Provider, after `run`: adds the platform org back, restores its Application `Admins` and `LifecycleEndorsement` from block 0, sets `Endorsement` to ANY. Signed by the source orgs (local signers). Without `--yes`, prints the change. Idempotent |
| `tip chaincode-check <archive> --dest d.json --channel c [--peer i] [--write-collections dir]` | read-only | Per chaincode: the source definition rebuilt from the archive's `_lifecycle` writes, the destination's committed one, whether the migration contract answers, collection and endorsement policies that no destination peer can satisfy. While a definition is still the replayed one it prints the approve and commit commands at the next sequence and (with `--write-collections`) the collection files they name (provider: member policy rewritten to the platform org). Exit 2 unless every chaincode is ready. It never installs, approves or commits |
| `tip import-private <archive> --dest d.json --channel c --private <dir or ndjson> [--peers 0,1] [--yes]` | gated | Writes private values back through `ImportPrivateDataBatch`, one collection per transaction, endorsed by the given peers and submitted as the first one's reader. Every value must hash to the live hash in the blocks or nothing is written (exit 6). Keys whose value is already there are skipped, so a re-run resumes. Another org's implicit collection is skipped (exit 2): run it again as that org, through its peer. Expiring collections go last |
| `verify <archive> --dest d.json --channel c [--peer i] [--private <dir or ndjson>] [--accept-unchecked <collections\|all>]` | read-only | Full, not sampled: rebuilds the ledger facts from the archive (VALID transactions only) and checks every key's state, every source delete, a `ListKeys` sweep for extra and missing keys, every key's history, and each private value against the hash in the blocks and the destination's hash (and value where readable). A live private key with no value supplied fails the run when its collection is readable by the member verifying (from the extraction's `metadata.json` and the peer's org); with no input from a source org (a provider destination, or no `--private`), every collection must be covered. Other members' collections are listed as still to verify, and `blockToLive`-purged keys are counted apart. Uses the migration contract's read functions. Exit 6 on any difference |
| `commands` | read-only | Every command with its class and what it writes |

Every command takes `--json`. Output carries block numbers, counts, transaction IDs, MSP IDs and digests, never a ledger value or key
material.

## The per-block loop

For each source block in turn, `run` does the following:

- **Transaction block:** sends the original envelopes as raw bytes on one `Broadcast` stream and requires `SUCCESS` for each. It then
  takes the cut block from one persistent `Deliver` stream and requires the same transaction count and `data_hash` as the source block.
- **Config block:** computes the update that mirrors the source block onto the destination's current config. It signs the update as
  the orgs already in the channel (plus the orderer org when the Orderer group or a channel-level value changes), and checks the
  committed config equals the one it computed.

Two modes:

- `timeout` (stock orderer): waits for each block.
- `cut-markers` (patched orderer, self-managed only): sends ahead and verifies behind, within a window.

The patched orderer is built from the patch in [`orderer-patch/`](orderer-patch/) (against Fabric
v2.5.14). It adds the cut markers this mode reads, turned on by `ORDERER_MIGRATION_CUT_MARKERS=true` on every
orderer (without it a marker is an ordinary message and `cut-markers` mode cannot work), and an
`ORDERER_MIGRATION_SKIP_EXPIRATION` switch;
both are for the migration window only and should not be used for a general-purpose orderer. For expired signers
alone, a stock orderer with `General.Authentication.NoExpirationChecks: true` also works
([prerequisites](../docs/rebroadcast.md#prerequisites)).

The run stops on any violation, and never retries a send. Exit codes:

| Code | Meaning |
|---|---|
| 3 | Envelope rejected |
| 4 | Broadcast failed, or the block was not produced |
| 5 | Destination moved while idle (a partial batch was cut) |
| 6 | Content mismatch (split block, or a different config) |
| 7 | Destination ahead of the archive |
| 8 | Blocks cannot be aligned |
| 9 | Channel name mismatch |
| 10 | No key for a required signer |
| 11 | Destination unreachable |
| 13 | The destination or a peer is behind: it has not committed every block (`compare` compared only a prefix; `verify` and `tip` refuse to read through a lagging peer). `compare --via <peer>` also exits 13 when the peer refuses its reader (Deliver FORBIDDEN), which an org added by a later config block gets until its peer commits that block; an invalid reader identity gets the same refusal, so a retry loop on 13 should give up after a bounded wait |

State is kept in `state/<c>.json`, and each block gets a line in `report/<c>.ndjson`.

## Destination descriptor

The full schema is in `src/descriptor.ts`. Unknown keys are refused, and paths are relative to the descriptor file.

```json
{ "schema": 1, "profile": "self-managed",
  "orderer": { "mode": "timeout", "batchTimeout": "500ms",
               "endpoint": { "address": "orderer0:7050", "sni": "orderer0.example.com", "tlsCa": "tls/ca.pem" },
               "reader": { "msp": "OrdererMSP", "cert": "ord-admin.pem", "key": "ord-admin.key" } },
  "peers": [{ "address": "peer0:7051", "tlsCa": "tls/peer-ca.pem", "reader": { "msp": "<source MSP>", "cert": "…", "key": "…" } }],
  "ordererOrg": { "msp": "OrdererMSP", "admin": { "cert": "ord-admin.pem", "key": "ord-admin.key" } },
  "genesisTemplate": "template.block",
  "orgs": { "<source MSP ID>": { "signer": { "mode": "local", "cert": "…", "key": "…" }, "rootCa": "…", "tlsRootCa": "…",
                                 "anchorPeers": [{ "host": "peer0.org1.example.com", "port": 7051 }] } },
  "ordererOverrides": { "BatchTimeout": "500ms", "BatchSize": { "max_message_count": 500 } } }
```

A provider descriptor (`"profile": "provider"`) differs in three ways:

- It has `platform` (the platform's org and its admin key) instead of `ordererOrg` and `genesisTemplate`.
- The orderer and peer endpoints carry `clientCert`/`clientKey` for mutual TLS.
- The peer's `reader` is a source org, because the platform's org leaves the channel's application orgs at the first update.

`orderer.endpoints` lists every node of the ordering service. Reads move to the next node when one fails, and in timeout mode a failed send moves to another node, waits until nothing more can be cut, and resends only if nothing of the block was cut (`--failover-quiet` sets that wait). `plan` reports every node's height.

After `run`: `tip config` (provider), then `tip chaincode-check` and the lifecycle commands it prints (installing a package with the migration contract stays a manual step), then `tip import-private`, then `verify`. Member instructions for the ceremony: [`docs/signing-kit.md`](docs/signing-kit.md).

Before the tip phase:
- **Every peer must have committed every block.** Peers commit behind the orderer, a long way behind if they wait
  for private data no other peer will send: set `CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD=0s` on destination
  peers (see [prerequisites](../docs/rebroadcast.md#prerequisites)). `compare --via <peer>` exits 13 while a peer
  is behind, and `verify` and the `tip` commands refuse to read through it.
- **The redeployed chaincode must run on every peer** at the new sequence, with the migration contract in its package
  and its writer list naming the destination orgs. For chaincode as a service the sample chaincodes start a server
  when `CHAINCODE_SERVER_ADDRESS` is set.
- **Run `tip import-private` once per org that has private data:** each org writes the collections it is a member
  of, including its own implicit collection, through its own peer. Collections it cannot write are skipped with the
  member list, and a re-run writes only what is missing.
- On CouchDB peers, `verify` counts JSON values the state database re-serialised (keys sorted) as matches and
  reports how many; the history and the peer's commit hash are byte-exact.

For a ceremony, an org's `signer` is `{ "mode": "ceremony", "cert": "<the admin certificate it will sign with>" }`, with no key. That
member signs with `sign-config sign`. Bundle updates are submitted by the orderer `reader` identity, which must be a channel Writer.
