# Fabric Version Support

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Two versions decide what a migration can do, and they are independent:

- The **source** network's AMB `FrameworkVersion` — the peer binary version — decides
  what can be extracted. It is fixed at network creation and cannot be raised.
- The **destination**'s Fabric version decides whether a Fabric destination can be
  replayed into at all. PostgreSQL and DynamoDB destinations have no Fabric version.

Conflating the two is how this file was previously wrong. Read the section for the side
you are asking about.

## Source: what each AMB framework version yields

| AMB `FrameworkVersion` | Public state, block metadata, public history | Private-data hashes | Private-data values |
|---|---|---|---|
| **2.2** | works | tier 3 only | works |
| **1.4** | works | tier 3 only | **impossible** |
| **1.2** | works | tier 3 only | **impossible** |

### Private-data values need Fabric 2.0, not 1.4.1

Private-data *values* are read through the `DeliverWithPrivateData` gRPC endpoint, which
is a **Fabric 2.0+** RPC. Verified from the protobuf definitions rather than the release
notes: `protos/peer/events.proto` on `hyperledger/fabric` `release-1.4` defines only
`Deliver` and `DeliverFiltered`, and `DeliverWithPrivateData` first appears in
`hyperledger/fabric-protos` `release-2.2`. (The protos moved repositories in 2.x, which
is why the 1.4 path has to be checked in the main `fabric` repo.)

So **private-data values cannot be obtained from an AMB 1.2 or 1.4 network through
`DeliverWithPrivateData`** — not by this tool and not by any other client using that RPC.
There is no flag, no fallback and no configuration that changes this. If the migration's
scope includes private-data values and the source network is 1.2 or 1.4, that scope is not
achievable by extraction; confirm the loss in writing with the data owner before extraction
begins.

One route outside this tool exists, with limits. On a 1.x network a member can read its own
private values through ordinary `GetPrivateData` chaincode queries. That route (a) needs the
key names, which blocks do not contain — only key hashes — and (b) on CouchDB peers returns
JSON with its keys sorted, so the value no longer hashes to the on-chain hash. Plain string
values are byte-exact, and a LevelDB peer returns JSON in its original bytes, so the hash
matches, including values written before the peer joined. This toolkit's extractor does not
use that route; its behaviour on 1.x is unchanged by it.

### Private-data hashes come from the block walk, at tier 3 only

Hashes are embedded in each endorser transaction's read-write set, so they come out of
blocks the tool already has and need no RPC. That makes them available on every version —
but they are written only at **tier 3** (`--tier 3`,
[full history](migration-overview.md)): `BlockWalker` emits private-hash records inside
its `tier >= FullHistory` branch. A tier 1 or tier 2 extraction of a 1.2 or 1.4 network
therefore carries **no private-data artifacts at all**, values or hashes.

A hash proves a key existed in a collection, and `validate` cross-checks each chaincode's
delivered private values against its own hashes. It does not carry the value, the value
cannot be recovered from it, and `verify` does not compare it against the destination — see
[Phase 6: Verification](migration-guide.md#phase-6-verification).

### What has never been tested

**No real 1.2 or 1.4 block bytes have been run through this tool's decoder.** The block
decoder is exercised only against fixtures captured from a 2.x network, and
`capture-fixtures` defaults to a connection mode that cannot reach a 1.x peer, so no 1.x
fixtures exist. Public-state reconstruction on 1.2 and 1.4 is expected to work because the
system chaincodes it uses — `cscc.GetChannels`, `cscc.GetConfigBlock`, `qscc.GetChainInfo`,
`qscc.GetBlockByNumber`, `lscc.GetChaincodes` — all predate 1.2, but *expected* is the
strongest claim available. Validate on one representative channel before committing to a
window.

There is no other extraction difference between 1.2 and 1.4. Both take the 1.x path, both
are `lscc` for chaincode discovery, and neither can produce private-data values.

## What decides private-data support: `FrameworkVersion`, not channel capability

`assessPrivateDataSupport` (`src/utils/fabric-version.ts`) reads
`manifest.ambFrameworkVersion`, which `discover` and `migrate` record from AMB's
`FrameworkVersion`, and compares its major version against 2.

**Channel capability is not a proxy for the peer version, and using one is wrong in both
directions.** A 2.2 peer serves `DeliverWithPrivateData` on a channel still at `V1_2`
application capability, which is legal and common; a 1.4 peer refuses it on a channel at
`V1_4_2`. The RPC is implemented by the peer binary, not enabled by a channel capability,
so this file names no capability threshold — there is none to name.

**An unestablished version is refused, not guessed.** A manifest with no
`ambFrameworkVersion`, or one this tool cannot compare against 2.0, makes `extract` fail
with an `ExtractionError` telling you to re-run `discover`. Both fallbacks lose data in
opposite directions — assuming support attempts an RPC the peer does not serve, assuming
none abandons recoverable private data — so neither is taken.

## Chaincode discovery: `_lifecycle` first, `lscc` on rejection

`ChaincodeDiscoverer` does not branch on a detected version. It asks
`_lifecycle.QueryChaincodeDefinitions` and falls back to `lscc.GetChaincodes` when the peer
rejects it with `UNIMPLEMENTED`, "not found", or "could not find chaincode" — the answers a
peer without the 2.0 lifecycle gives. So a 1.2 or 1.4 network reaches `lscc` because its
peer says so, not because the tool decided in advance.

The fallback is deliberately narrow in one place that matters: a `DiscoveryError` raised
*inside* the `_lifecycle` path is re-thrown rather than re-asked of `lscc`, because a 2.x
peer's `lscc` answer does not apply to a 2.x lifecycle question. Likewise, exactly one
`lscc.GetCollectionsConfig` rejection — Fabric's own "collections config not defined for
chaincode" — means "this chaincode has no collections"; every other rejection is a
failure, because an ACL denial or a timeout reading as "no private data" is how private
data gets silently dropped.

## Implicit collections are 2.0+

`_implicit_org_<MSPID>` collections arrived with the 2.0 chaincode lifecycle. On a 2.2
network `discover` synthesizes one per application org per chaincode, taking the org MSP
IDs from that channel's own config block. A pre-2.0 network synthesizes nothing and the
peer is never asked.

Synthesized means "may exist", not "was written to" — a synthesized collection earns a row
in the coverage report only once it has captured something.

## Destination: a Fabric destination must be 2.4 or later

`replay` and `verify` connect to a Fabric destination through
`@hyperledger/fabric-gateway`, whose own README states it "requires Fabric v2.4 (or later)
with a Gateway enabled Peer". There is no legacy-SDK path in `src/replay/` or
`src/verification/`, so this is a hard requirement rather than a preference:

- **Fabric 2.4+ with the Gateway service enabled** — supported. The sample destination is
  Fabric 2.5.11 (`sample/scripts/destination/setup-test-network.sh`).
- **Fabric 2.0–2.3** — the peer has `_lifecycle` and can host the migration contract, but
  it has no Gateway service, so the client cannot connect. Not usable as a Fabric
  destination.
- **Fabric 1.x** — not usable, for the same reason and several others.
- **Another AMB network** — AMB's framework versions top out at 2.2, so an AMB network
  cannot be a Fabric destination for this tool. Extract from AMB, replay into
  self-managed Fabric 2.4+, PostgreSQL, or DynamoDB.

The destination also has to have each source chaincode committed under the identical name,
carrying the migration contract; `replay` pre-flights both and refuses before the first
write. See *Destination chaincode pre-flight* in
[Replay config reference](replay-config-reference.md).

## What version detection records, and what it does not decide

`discover` (and `migrate`) query `cscc.GetConfigBlock` on the first channel and parse the
Application, Channel and Orderer capability keys out of it. The result is written to
`manifest.json` as `fabricVersion` (`1.x` or `2.x`) and `fabricCapabilities`, and printed
in the discovery summary.

**These fields are descriptive.** Nothing downstream branches on them: private-data support
comes from `ambFrameworkVersion`, chaincode discovery comes from what the peer rejects, and
implicit-collection synthesis comes from `ambFrameworkVersion` too. They are recorded so an
operator can see what the channel admits, and `merge` carries them through so a merged
directory keeps them.

Version detection has one behavioural effect, and only on `discover`: when the SDK mode is
`gateway` or `auto` and the probe shows 1.x capabilities, the run reconnects with the legacy
SDK. That path is off by default — `discover --fabric-mode` defaults to `legacy`, and
`extract` and `migrate` expose no such flag and always use the legacy SDK, because AMB
serves no Gateway service on any framework version it offers. `capture-fixtures` is the one
command that defaults to `auto`.
