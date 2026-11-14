# Testing and reviewing the toolkit

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Four levels, each adding infrastructure. Levels 0 and 1 need no AWS account. Levels 2 and 3 need an Amazon Managed
Blockchain (AMB) Hyperledger Fabric network, because extraction reads from AMB peers through the AMB API.

| Level | Needs | Covers | Time |
|---|---|---|---|
| 0 | Node 22 (Go, Docker, `configtxlator`, gitleaks optional) | Build, lint, unit tests and coverage gates, dependency audit, migration contract stubs, secret scan | 10 min |
| 1 | A Linux host with Docker | Block-level re-broadcast end to end, from a local Fabric source | 1 h |
| 2 | An AMB Fabric 2.2 network you can write to, one host in its VPC | Extraction, validate, replay to PostgreSQL and Fabric, verify, extend, delta replay | half a day |
| 3 | As level 2, three to five members | Multi-member merge, private data across members, re-broadcast of a real AMB channel | 1-2 days |

## Level 0: no network

```bash
scripts/review-check.sh
```

It runs, and reports each as `ok`, `FAILED` (with its log) or `skipped` (a tool that is not installed):
- `npm ci`, `npm run build`, `npm run lint`, `npm run test:coverage` (fails if a directory's coverage falls under its
  threshold in `jest.config.js`);
- `npm audit --omit=dev --audit-level=high` for both packages. Three low findings remain by design: see
  [Dependency notes](#dependency-notes);
- `rebroadcast/`: install, build, tests. With `configtxlator` (Fabric 2.5) on `PATH`, all 79 tests run; without it, 15
  skip;
- the Go and Java migration contract stubs (`scripts/compile-migration-stubs.sh`; Java runs in a Maven + JDK 21 image);
- `gitleaks` over the git history.

CI (`.github/workflows/ci.yml`) runs the same checks except the secret scan.

### What to read for a security review

Start with the [threat model](threat-model.md). Then the code:

| Area | Where | What to check |
|---|---|---|
| Credentials | `src/connection/wallet-manager.ts`, `src/connection/legacy-fabric-gateway.ts`, `src/connection/node-signer.ts` | The admin key is read from an MSP directory or obtained by CA enrollment; enrolled keys are written mode 0600; signing goes through Node's crypto, not `elliptic` |
| History-import key | `src/replay/history-import/config.ts` | The HMAC key is read from a file, never from the config or the command line, and only a commitment to it reaches the destination |
| Network | `src/connection/` | Client connections only, TLS verified against the AMB TLS chain or the destination's CA; `--allow-insecure` is the only plaintext path |
| Values in output | `src/verification/`, `verify --redact-values` | Mismatch reports can quote ledger values unless redacted |
| Files written | `src/output/`, `src/extraction/extension.ts`, checkpoints | Output stays under the given directories; channel names are sanitised before they become paths |
| Destination writes | `src/replay/`, `sample/chaincode/migration_contract/` | The migration contract refuses writers not on its list (empty by default); replay refuses a destination whose genesis block differs from `destinationFingerprint`, and a non-empty destination for a plain history replay |

## Level 1: re-broadcast without AMB

Build and test the block-level re-broadcast tool with its fake orderer (unit and integration tests; the integration
tests need `configtxlator` from Fabric 2.5 on `PATH`):

```bash
cd rebroadcast && npm ci && npm run build && npm test
```

For a live destination, re-broadcast a channel into a local Docker Fabric 2.5 network, or follow the
[EKS runbook](eks-fabric-runbook.md). See the [re-broadcast README](../rebroadcast/README.md) for the command surface.

## Level 2: one AMB network

Build a source network of your own with [Build a test source network](test-source-network.md): a multi-member AMB
Fabric 2.2 network, its endpoint and a host, then your own chaincode and synthetic data. Testing against a ledger you
designed is the point. Then:

| Step | Command | Pass |
|---|---|---|
| Extract | `amb-migrate discover …` then `amb-migrate extract --tier 3 …` | exit 0 |
| Validate | `amb-migrate validate --input-dir out` | exit 0 |
| Replay to PostgreSQL | a local `postgres:16` bound to 127.0.0.1, then `amb-migrate replay --adapter postgresql` and `verify` | 0 failed; verify exit 0, no mismatch, missing or extra |
| Replay to Fabric | the bundled sample chaincodes: `sample/scripts/destination/setup-test-network.sh`; your own chaincode: `destination.sh` with `MM_CC_ROOT` ([Build a test source network](test-source-network.md#8-extract-merge-and-replay)); then `replay --adapter chaincode` and `verify` | as above |
| Interrupt and resume | `kill -9` an `extract`, re-run it; `kill -9` a replay with `historyImport`, re-run it | same output as an uninterrupted run; verify clean |
| Extend and delta | write more transactions, `discover`, `extract --extend`, `replay --since extension`, `verify` | verify clean; the delta replay sends only the new records |
| Guards | a replay with a wrong `destinationFingerprint`; a plain history replay into a non-empty destination; a plain history replay re-run after `kill -9` | each refused before writing |

## Level 3: several members

The [multi-member live-test runbook](multi-member-live-test-runbook.md) extracts every member of a network like the one
[Build a test source network](test-source-network.md) creates (three members; a Standard network takes up to five), with
shared and pairwise private collections, per-member extraction, `merge`, and a Fabric 2.5 destination with one org per member.
Re-broadcast of a real AMB channel into Kubernetes is in the [EKS runbook](eks-fabric-runbook.md). Measured results to
compare against are in [Tuning](tuning.md).

## Dependency notes

`npm audit --omit=dev` reports three low findings, all one advisory: `elliptic` (CVE-2025-14505, no patched
version), reported against `elliptic` and the two packages that require it, `fabric-common` and `fabric-ca-client`.
They are the only Node client for AMB's Fabric 2.2 peers, which have no Gateway service. The advisory concerns ECDSA
signing; the toolkit signs with Node's own crypto instead (`src/connection/node-signer.ts`). `jsrsasign` and the gRPC
library nested under `fabric-protos` are raised to patched versions with `overrides` in `package.json`.
