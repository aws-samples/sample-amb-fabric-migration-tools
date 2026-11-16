# Tuning Guide

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

The V8 heap ceiling, which has to be set before the process starts, plus the
timeouts, retries and batch sizes that govern a run once it is.

---

## Heap Size

`--max-old-space-size` is the only setting in this guide that cannot be changed
once the toolkit is running. It is a Node launch flag, so it goes in the
environment ahead of the command:

```sh
NODE_OPTIONS=--max-old-space-size=8192 amb-migrate extract \
  --manifest ./extraction-output/manifest.json \
  --tier 3 \
  ...
```

### The ceiling this host gives you

Node derives its default from physical memory, so it differs per host and is
worth reading rather than assuming:

```sh
node -e 'console.log((require("v8").getHeapStatistics().heap_size_limit / 1024 ** 2).toFixed(0), "MiB")'
```

*Measured: 4144 MiB on an 18 GiB machine (Node 22).* `--max-old-space-size=N`
puts the ceiling at N + 48 MiB — the 48 is the young generation, which the flag
does not cover. `extract` logs the ceiling it started with, so an
out-of-memory in a run's log can be read against the budget that run was given.

### How it relates to `--memory-limit`

`--memory-limit` is the state accumulator's budget for **all** channels together
— each channel extracted in parallel gets an equal share. When a channel's
accumulated state reaches its share, that channel spills to LevelDB on disk,
which is what holds a walk to a fixed footprint however tall the ledger is.

A heap ceiling below the budget disarms exactly that: the promotion threshold
becomes a line the process dies before reaching. So `extract` refuses a budget
its heap cannot hold, before it walks the first block:

```
--memory-limit 4096 lets the state accumulators reach 4096 MB, which needs an
8192 MiB V8 heap; this process has 4144 MiB. The LevelDB promotion that keeps a
walk inside that budget happens at 4096 MB, so the heap would run out before the
spill it exists to trigger. Either start the process with
NODE_OPTIONS=--max-old-space-size=8192, which no flag can change once it is
running, or lower --memory-limit to 2072 or below, or extract with
--state-backend leveldb.
```

**Size the ceiling at twice `--memory-limit`.** Measured on a test machine:
an accumulator filled to a 192 MiB estimate holds 178 MiB of live heap and peaks
at 191 MiB while it promotes to LevelDB, and the same fill dies at
`--max-old-space-size=192` but survives at 208. The accumulator alone therefore
needs ~1.1× its budget; the rest of the factor pays for the block being
reconstructed, the `--prefetch-buffer` blocks behind it, and the headroom V8
needs to collect garbage instead of thrashing against its ceiling.

The toolkit does not raise the ceiling for you, and raising it past what the
host can back is worse than leaving it alone: a clean V8 out-of-memory names the
accumulator and the limit, where swapping or the kernel's OOM killer ends the
run with no message at all, part-way through a walk that then starts over.

### Recommended starting points

| Host memory | `NODE_OPTIONS` | `--memory-limit` | `--state-backend` |
|---|---|---|---|
| 8 GiB | `--max-old-space-size=4096` | 2048 | `auto` |
| 16 GiB | `--max-old-space-size=8192` | 4096 | `auto` |
| 32 GiB or more | `--max-old-space-size=16384` | 8192 | `auto` |
| Any, state larger than memory | default | 512 | `leveldb` |

`discover`'s capacity advisory recommends `--state-backend leveldb` when a
channel's estimated state is large; take that over this table, which sizes the
process rather than the ledger.

`extract` logs the same estimate for the run it is about to make — the tier, the
concurrency and the private-data plan are all known by then, which the advisory's
hypothetical run has to guess at. Nothing is refused on the estimate: it is
arithmetic over ledger height, not a measurement. What it does say is which
channels are expected to outgrow their share of `--memory-limit` and spill to
LevelDB, while a larger instance or a different backend is still a choice.

`--state-backend leveldb` never accumulates in memory — ~4 MB per channel — so
the ceiling stops mattering for state and the volume under `--state-data-dir`
has to hold the whole reconstructed state instead. `--state-backend memory`
never promotes, so the ceiling is the only bound on reconstructed state and
reaching it ends the run; the extraction log warns about that at startup.

### What else lives in the heap

- **`verify`** prints each result as it is produced and keeps only the counts, so
  its heap does not grow with the size of the extraction. What it does hold is one
  channel at a time: the public keys of the channel being swept for keys the
  extraction does not account for, and the versions of the single history key
  being compared. A channel with far more public keys than the rest is what sizes
  the run.
- **One gRPC message.** The replay and verify clients accept messages up to
  100 MiB — the peer's own send default — so a large `GetKeyHistory` response is
  100 MiB of heap while it is decoded. Extraction reads blocks through
  fabric-common, which sets no receive limit at all.
- **The identity registry** of each channel being walked: one record per distinct
  signing identity, held until that walk ends.
- **Private current state.** No flag turns the delivery pass on or off: `extract`
  attempts it for every channel whenever the gateway exposes
  `DeliverWithPrivateData` and the manifest's `ambFrameworkVersion` is Fabric 2.0
  or later, and logs `Private-data delivery enabled` or
  `Skipping DeliverWithPrivateData` at startup to say which happened. When it runs,
  it re-walks the ledger, at the same time as the public walk, and holds a whole
  channel's private keys and values in a plain map until it writes them at the end.
  There is no spill to disk for it. Under `--state-backend auto` its size is charged
  to the channel's share of `--memory-limit`, so the walk's state accumulator moves
  to LevelDB instead of adding to it, but the map itself is bounded only by the
  ceiling and by how much private data the channels being walked together hold.
  `extract` warns when its estimate for that map exceeds `--memory-limit`; the
  answer is fewer channels at once, or a taller ceiling.

---

## gRPC Timeouts

Three timeout knobs control how long the toolkit waits for Fabric peer and
orderer responses. All values are in milliseconds.

| Parameter | Default | Controls |
|---|---|---|
| `requestMs` | 30 000 (30 s) | Evaluate, endorse, submit, and proposal calls |
| `commitMs` | 60 000 (60 s) | Commit-status checks (waits for ordering + consensus) |
| `connectMs` | 15 000 (15 s) | Initial gRPC channel ready-wait |

### CLI flags (extract command)

```sh
amb-migrate extract \
  --grpc-request-timeout 60000 \
  --grpc-commit-timeout 120000 \
  --grpc-connect-timeout 30000 \
  ...
```

### JSON config (replay command)

Add a `timeouts` object to the replay config JSON. Only the chaincode adapter
uses gRPC — timeouts are ignored for postgresql and dynamodb adapters.

```json
{
  "adapter": "chaincode",
  "timeouts": {
    "requestMs": 60000,
    "commitMs": 120000,
    "connectMs": 30000
  }
}
```

### When to increase timeouts

**Symptom: `DEADLINE_EXCEEDED` errors during extraction or replay.**

Root causes, in order of likelihood:

1. **AMB VPC endpoint latency.** Traffic between your EC2 instance and the AMB
   peer traverses a VPC endpoint, adding 50-200 ms per hop. For large blocks
   or slow peers, the default 30 s request timeout may not be enough.
   Recommended: `requestMs: 60000`.

2. **Large block payloads.** Blocks with many transactions or large private
   data collections take longer to serialize and deliver. If timeouts only
   occur on specific channels with high write density, increase `requestMs`
   rather than all three values.

3. **Orderer consensus delays.** The commit timeout covers the full
   ordering-and-commit cycle. On congested networks or Raft clusters with
   many members, consensus rounds take longer.
   Recommended: `commitMs: 120000`.

4. **Cold-start connection.** The first connection to a peer after a long idle
   period may take longer than 15 s if the peer is scaling up or the TLS
   handshake is slow. Increase `connectMs` only if you see
   `UNAVAILABLE: failed to connect` on the initial connection attempt.

**Do not increase timeouts to mask a failing peer.** If operations consistently
take longer than 60 s, the peer is likely overloaded or the network path has
issues. Investigate before raising timeouts further.

### Recommended starting points

| Scenario | requestMs | commitMs | connectMs |
|---|---|---|---|
| Same-region EC2 → AMB | 30 000 (default) | 60 000 (default) | 15 000 (default) |
| Cross-region or VPN | 60 000 | 120 000 | 30 000 |
| Large blocks (>1 MB avg) | 90 000 | 120 000 | 15 000 |
| Local / dev network | 10 000 | 30 000 | 5 000 |

---

## Retries

Peer, orderer and AMB control-plane reads are retried against a budget of
wall-clock time rather than a count of attempts.

| Parameter | Default | Controls |
|---|---|---|
| `budgetMs` | 180 000 (3 min) | Time one call may spend failing, delays included |
| `baseDelayMs` | 1 000 (1 s) | Delay before the second attempt; doubles per attempt |
| `maxDelayMs` | 30 000 (30 s) | Ceiling on a single delay |

These are constants in `src/utils/retry.ts`. There is no flag: the default is
sized for the outage operators actually meet, and an outage longer than it is
better answered by resuming from the checkpoint than by holding a run open.

### Why time and not attempts

A restarting AMB peer — maintenance window, instance replacement, node version
upgrade — is unreachable for 30 to 120 seconds. A tier-3 walk of eight channels
runs for hours and will meet one, so the tolerance has to be a span of time long
enough to cover it. Three attempts a second apart cover three seconds.

Counting time rather than attempts also makes the tolerance independent of how
the failure arrives. A call that hangs until `requestMs` spends 30 s of the
budget by itself, so a stalled peer gets roughly five attempts and a peer
refusing connections outright gets about ten — both keep trying for three
minutes.

Half of each delay is randomised. With `--concurrency 8`, eight channel walkers
share one peer; identical backoff would bring all eight back at the same instant,
repeatedly, against a peer that has just come up. The other half stays fixed so
the attempts still back away from a struggling peer rather than clustering.

### What is not retried

Waiting cannot change these answers, so they fail immediately:

| Failure | What it means |
|---|---|
| `UNAUTHENTICATED`, `PERMISSION_DENIED` | The identity is not allowed on this channel — check the enrolled MSP and its channel membership |
| `INVALID_ARGUMENT`, `NOT_FOUND`, `… not found` | The channel, chaincode or AMB resource named does not exist |
| `UNIMPLEMENTED`, `does not support the Gateway` | The peer is Fabric 1.x; the toolkit falls back to the legacy SDK path itself |
| CA `Authorization failure` / `Authentication failure` | Wrong enrollment secret or expired credential |
| `AccessDeniedException`, `ValidationException`, `ExpiredTokenException`, `UnrecognizedClientException` | An IAM, argument or credential problem in the AWS control-plane call |

Everything else is retried, including errors the toolkit does not recognise. The
list above is deliberately a list of permanent failures rather than a list of
transient ones: an unrecognised peer message at hour 20 of a walk is worth
waiting three minutes on, and the cost of the inverse mistake — waiting out the
budget on something permanent — is bounded and logged.

AWS SDK calls carry the SDK's own retries underneath this budget, so a throttled
control-plane call is attempted more often than the log here shows.

### When the outage outlasts the budget

The call fails with `Retry budget exhausted`, naming the call and the elapsed
time, and the run ends. Extraction resumes from its last checkpoint on re-run
(see [Checkpoint and resume](migration-guide.md#checkpoint-and-resume)), so the
cost is the blocks since the last checkpoint, not the walk.

Version detection is the one call with a shorter budget — 5 s. A peer that will
not report its capabilities leaves the toolkit assuming them and connecting
anyway, so three minutes of retries would delay a connection that is going to be
made regardless.

---

## Replay Batch Size

Controls how many NDJSON records accumulate in memory before being flushed to
the target adapter in a single batch.

| Parameter | Default | Range |
|---|---|---|
| `batchSize` | 500 | 50 – 5 000 |

### CLI flag (replay command)

```sh
amb-migrate replay \
  --batch-size 200 \
  ...
```

### JSON config

```json
{
  "adapter": "postgresql",
  "batchSize": 200
}
```

The CLI `--batch-size` flag overrides the JSON config value if both are set.

### When to change batch size

**Decrease** when:

- **Large average value sizes (>10 KB).** Each batch is held in memory and
  sent as a single transaction. 500 records at 50 KB each = 25 MB per batch.
  For PostgreSQL, this can exceed `work_mem` or cause transaction timeouts.
  Try `100`–`200`.

- **PostgreSQL `statement_timeout` or `idle_in_transaction_session_timeout`
  errors.** Smaller batches complete faster, staying within server limits.

- **DynamoDB `BatchWriteItem` throttling.** DynamoDB has a 25-item limit per
  batch write call; the adapter handles chunking internally, but very large
  batches amplify retry pressure on throttled tables. Try `100`.

**Increase** when:

- **Small, uniform records (<1 KB).** Larger batches reduce per-batch overhead
  (checkpoint writes, adapter flush calls). For small records, `1000`–`2000`
  improves throughput.

- **Target system can handle larger transactions.** If your PostgreSQL instance
  has generous `work_mem` and no tight statement timeouts, larger batches
  reduce round-trips.

**Do not exceed 5 000.** Beyond this, checkpoint granularity suffers — a crash
loses up to `batchSize` records of progress, requiring re-replay from the last
checkpoint.

### Decision matrix

| Avg record size | Target adapter | Recommended batch size |
|---|---|---|
| < 1 KB | PostgreSQL | 1 000 – 2 000 |
| 1 – 10 KB | PostgreSQL | 500 (default) |
| > 10 KB | PostgreSQL | 100 – 200 |
| < 1 KB | DynamoDB | 500 – 1 000 |
| 1 – 10 KB | DynamoDB | 200 – 500 |
| > 10 KB | DynamoDB | 50 – 100 |
| Any | Chaincode | 100 – 500 (bound by endorsement latency, and a ceiling on `writeBatchSize` — see below) |

## Write Batch Size (chaincode replay)

How many distinct public keys the chaincode adapter carries in one
`PutStateBatch` transaction. A separate knob from `batchSize`, because they bound
different things: `batchSize` is how many records are read and checkpointed at a
time, `writeBatchSize` is how many keys share a transaction inside that.

| Parameter | Default | Range |
|---|---|---|
| `chaincode.writeBatchSize` | 500 | 1 – unbounded (`batchSize` is the effective ceiling) |

```json
{
  "adapter": "chaincode",
  "batchSize": 500,
  "chaincode": { "writeBatchSize": 500, "concurrency": 4 }
}
```

This is the one knob that changes a Fabric replay's order of magnitude. A
transaction costs an endorsement round trip plus an ordering and commit wait
whatever it carries — tens to hundreds of milliseconds against a real network —
so at one write per transaction a few million history records is a run measured in
days. Batching pays that cost once per 500 keys instead of once per key.

### What bounds a batch below the number you set

- **`batchSize`.** A batch is assembled from the records currently in memory, so
  `writeBatchSize` above `batchSize` can never fill. Raise `batchSize` first.
- **Distinct keys.** A transaction's write set holds one value per key, so two
  versions of one key are always two transactions. A history replay of few keys
  and many versions per key is bounded by how many keys are in flight, not by this
  — 500 records of one key's history is 500 transactions whatever it is set to.
- **2 MiB of framed bytes.** Fabric's default `AbsoluteMaxBytes` is 10 MiB and an
  oversized transaction is rejected whole, so a round of large values is split
  into several transactions below the key ceiling. With 50 KB values a batch tops
  out around 40 keys; `writeBatchSize` is not what is limiting that run.
- **Mapped functions and private data.** A `keyMapping` or `deleteMapping` entry
  naming an application function opts that deployment out, and private writes are
  never batched. Those go one key per transaction.

### When to lower it

- **Blast radius.** A transaction the destination rejects lands none of what it
  carried, so one bad value fails every key in its batch — and with
  `replayHistory: true` that aborts the file and needs a destination reset. `1`
  restores per-key isolation at one round trip per write.
- **A peer or orderer under pressure.** A 2 MiB transaction is one 2 MiB block
  payload to validate, commit and index; a CouchDB destination indexing 500 keys
  in one commit is a longer commit than 10. Watch commit latency rather than
  guessing, and lower `concurrency` before this — it is fewer transactions in
  flight, not fewer keys per transaction.

### Memory

A round decodes one value per key in flight before it submits anything, so the
write path's high-water mark is roughly `batchSize × average value size`,
independent of `writeBatchSize`. This is what to lower for a heap problem on
replay — 500 records at 200 KB each is 100 MB of decoded values, and
[Heap Size](#heap-size) is what that has to fit inside.

`concurrency` multiplies throughput rather than competing with it: it is
transactions in flight, so the two together are up to
`concurrency × writeBatchSize` keys being written at once. Start by raising
`writeBatchSize`, which costs one round trip per batch, before `concurrency`,
which costs one connection's worth of outstanding endorsements per unit.

---

## Eight Channels at Once

Everything above is a per-run or per-channel lever. This section is what those
levers come to when a migration covers eight channels rather than one. It is
**arithmetic over the sections above, not a measurement** — nothing in this
toolkit has been run against eight channels — so read it as what to budget for
and which log lines to check the budget against.

### What adds, what divides, and what stays put

| Quantity | At eight channels | Follows from |
|---|---|---|
| `--memory-limit` | Unchanged as a total, and **divided**: each parallel walker accumulates against `⌊limit ÷ min(concurrency, channels)⌋`. Eight channels at `--concurrency 8` spill to LevelDB at an eighth of the state one channel would | [How it relates to `--memory-limit`](#how-it-relates-to---memory-limit) |
| V8 heap ceiling | Unchanged. The refusal checks the *flag*, not the share, because the shares add back up to the flag — so the ceiling a run needs is 2× `--memory-limit` at any concurrency | [Heap Size](#heap-size) |
| `--state-data-dir` | Eight subdirectories, live at once. Size the volume for the sum of all eight channels' reconstructed state, not for the largest one | `--state-data-dir` is per channel by construction |
| `--prefetch-buffer` | Per walker, so ×8 at `--concurrency 8`: the default 8 becomes 64 blocks decoded and in flight, plus the block each walker is reconstructing | [What else lives in the heap](#what-else-lives-in-the-heap) |
| Identity registry | One per walk, each held until its own walk ends | same |
| Private current state | One unbounded map per channel being delivered. Under `auto` it is charged to that channel's `--memory-limit` share, so it spills the walk's state to LevelDB rather than adding to it, but nothing bounds the map itself. This is the quantity that scales worst | same |
| Retry budget | Per call, not per run. Eight walkers meeting one peer outage each spend up to three minutes on it *concurrently* — the randomised half of each delay exists for exactly this case | [Retries](#retries) |
| Blocks read, bytes written | Sums. Each channel is two streams to the peer, its walk and its private pass, so eight walkers is up to sixteen fetch streams against one peer and eight output trees on one volume | [Public walk and private delivery at the same time](#public-walk-and-private-delivery-at-the-same-time) |
| Replay wall clock | ×8. `replay` walks channels one after another; `chaincode.concurrency` and `writeBatchSize` parallelise *inside* a channel and nothing parallelises across them | [Write Batch Size](#write-batch-size-chaincode-replay) |
| `verify` heap | Unchanged. It holds one channel at a time, so the largest channel sizes the run whether there is one or eight | [What else lives in the heap](#what-else-lives-in-the-heap) |

### What `--concurrency` costs at eight channels

Taking the 16 GiB row — `--max-old-space-size=8192`, `--memory-limit 4096`,
`--prefetch-buffer 8` — over eight channels:

| `--concurrency` | Accumulator share per channel | Blocks in flight | Private maps live at once | Wall clock |
|---|---|---|---|---|
| 1 | 4096 MB | 8 | 1 | 8 walks, one after another |
| 2 | 2048 MB | 16 | 2 | ~4 walks' worth |
| 4 | 1024 MB | 32 | 4 | ~2 walks' worth |
| 8 | 512 MB | 64 | 8 | ~1 walk's worth, if the peer keeps up |

The heap commitment is the same in every row, so the question `--concurrency`
actually asks is whether an eighth of the budget is still above the per-channel
state — below it, an in-memory walk becomes a LevelDB one, which is slower per
block but bounded, and needs the disk in the row above. The other cost is the
peer: each channel is two streams, its walk and its private pass, so eight channels
are sixteen streams and eight sets of retries against one node, where raising
concurrency past what it will serve buys retries rather than throughput.

`--concurrency 1` is the setting that gives the accumulator the whole budget and
keeps one private-state map live, at eight times the wall clock. It is also the
easiest to resume: extraction checkpoints per channel, so an interrupted run
re-walks unfinished channels only, whatever the concurrency
([5.5 Resuming an interrupted run](HOWTO.md#55-resuming-an-interrupted-run)).

### The log lines to check a budget against

`extract` reports each of these against the run it is about to make, before it
walks a block — which is where an eight-channel budget is cheapest to correct:

- `Dividing --memory-limit across channels extracted in parallel` — names
  `workers` and the resulting `perChannelMemoryLimitMb`. This is the divisor in
  the table above, confirmed rather than assumed.
- `Estimated state exceeds a channel's share of --memory-limit` — which channels
  are expected to promote to LevelDB mid-walk, and the spill to size
  `--state-data-dir` for.
- `Estimated private current state exceeds --memory-limit, which does not bound
  it` — the one quantity with no ceiling but the heap.
- The `--memory-limit … needs an N MiB V8 heap` refusal, which is a startup
  failure rather than a warning. It compares against the flag, so it fires or
  does not identically at every concurrency.

`replay` and `verify` have no equivalent: budget those from
[Write Batch Size](#write-batch-size-chaincode-replay) and the `verify` bullet in
[What else lives in the heap](#what-else-lives-in-the-heap), and split `verify`
across invocations with `--channels`
([6.5 Verifying more than one channel](HOWTO.md#65-verifying-more-than-one-channel)).

---

## Extraction sizing

Two measured sets. The first is a single deep channel on `bc.m5.large` peers (CouchDB) with the extracting host
(`c6i.4xlarge`, 16 vCPU) in the same VPC, Tier 3 unless stated, synthetic data. The second, further down, is an
earlier multi-channel set on smaller `bc.t3.medium` peers. Both are starting points, not guarantees: time a
rehearsal against your own peers.

### One deep channel, bc.m5.large peers, 16 vCPU host

The channel held 4,542 blocks and 242,441 transactions, about 4.29M public writes of 400-byte values over 1.76M
distinct keys, across two private-data collections (Measured). Every run used `--memory-limit 4096` with
`--max-old-space-size=8192` unless noted, and dropped the page cache first.

| Phase (full channel, Tier 3) | Measured | Rate (Derived) |
|---|---|---|
| Block walk | 4,542 blocks / 242,441 tx / 4.29M writes in 348 s | ~13 blocks/s, ~700 tx/s, ~12,300 writes/s |
| Private-data delivery | 422 s (quarter 104 s, half 216 s, full 422 s) | ~10.7 blocks/s, flat with height |
| State flush, in memory, no spill | 8 s | |
| Peak RSS | 1,795 MB against the 4,096 MB budget | |

The walk rate held across heights (quarter / half / full walked at 14.0 / 12.8 / 13.0 blocks/s, Derived), so
walk time is blocks ÷ ~13. Private-data delivery re-walks the ledger and ran at ~10.7 blocks/s whatever the
height; run on its own it was 54% of the wall clock, longer than the public walk (the passes now overlap; see
[below](#public-walk-and-private-delivery-at-the-same-time)). Its rate tracks private-data density rather
than block count, so a channel carrying little private data clears this pass far faster (the smaller-peer set
below saw about 350 blocks/s with sparse private data).

**Cores, 4 against 16.** Pinned to 4 cores the full walk took 327 s against 348 s on 16, with total CPU of 285 s
and 296 s respectively (Measured). One channel's walk averages well under a core, so cores past a handful sit
idle; they earn their keep only across channels walked in parallel (`--concurrency`, `--processes`).

**Prefetch, 8 against 32.** `--prefetch-buffer 32` did not beat the default 8 (walk 348 s against 319 s, inside
run-to-run variance) and nudged peak RSS up. At this peer's latency the walk is not prefetch-bound; leave it at
the default.

**Spilling to LevelDB (`--memory-limit 512`).** Forcing a spill cut peak RSS from 1,795 to 1,066 MB, down 41%,
and promoted state to LevelDB, for 30% more CPU (383 s against 296 s) and a state flush of 17 s against 8 s
(Measured). Wall clock did not suffer here (714 s against 780 s, inside variance) because the run is peer-bound
and the extra local work hid under I/O wait. On a CPU-bound run of many channels in parallel, expect the spill
to surface in wall clock.

**Tier 1 against Tier 3.** Tier 1 did not extract faster (wall 794 s against 780 s): both walk every block and
both run the private-data pass. The gap is output. Tier 1 wrote 1,390 MB, current state only (1.76M records);
Tier 3 wrote 6,190 MB, current state plus 4.29M history records and block metadata (Measured). Pick the tier by
what the replay needs, not for extraction speed.

Output grew sub-linearly with height: quarter / half / full Tier 3 were 2,046 / 3,840 / 6,190 MB, about
1.36 MB per block at full height (Measured). Current state saturated by half height (1.76M keys at both half and
full), so past that only history and metadata keep growing.

### `extract --extend`

`--extend` reads an earlier extraction's state back in, then walks only the new blocks. Measured from one base
extraction of 1,514 blocks, grown in three gaps:

| Gap | Seed (read base state back) | Walk + private | Wall |
|---|---|---|---|
| 100 blocks | 11.3 s | 15 s | 44 s |
| 1,000 blocks | 11.7 s | 202 s | 224 s |
| 1,928 blocks (to full height) | 13.3 s | 371 s | 394 s |

The seed cost is roughly fixed, about 11 to 13 s and growing slowly with the base state size; the rest scales
with the gap at about the full-walk per-block rate. A linear fit is wall ≈ 27 s fixed + 0.19 s per added block
(Derived), where the fixed term is the seed plus per-run finalisation. So `--extend` cost tracks the gap, not
ledger height: closing a 100-block gap is under a minute where re-extracting the whole channel is 13 minutes.

Grown through all three gaps to full height, `--extend` produced output identical to a fresh full extraction:
every NDJSON file matched, including blockToLive-purged private data, and `validate` of the fresh run passed 29
of 29 checks (Measured).

Starting model, one deep channel on these peers:

```
full extraction ≈ max(blocks / 13 per s,      # public walk, Tier 3
                      blocks / 11 per s)      # private-data delivery, running at the same time
--extend        ≈ 12 s to read the base state back + added blocks at the rates above
```

### Public walk and private delivery at the same time

The two passes are independent reads of the same ledger, so `extract` runs them together: each channel opens two
streams to the peer. Measured on the channel above, started together against one `bc.m5.large` peer:

| Pass | Alongside the other | Alone |
|---|---|---|
| Public walk | 354 s | 348 s |
| Private-data delivery | 353 s | 422 s |

Neither slowed the other, so the channel takes about as long as the longer pass. Measured with the passes running
together inside one `extract`: the channel took 356 s against 780 s one after the other, peak RSS 1,833 MB against
1,795 MB, and the output was identical to the sequential run's, file by file (all 7.28M records), with `validate`
passing 29 of 29. A peer with fewer cores or burst credits may not serve two streams at full rate;
it gets slower rather than wrong, since the walk checks every block. Lower `--concurrency` if the source peer is busy.

The passes then share memory. The private pass's map is charged to the channel's share of `--memory-limit`, so the walk's
state accumulator promotes to LevelDB once the two together reach it, and `--state-data-dir` can be needed where state
alone would have fitted. `extract` warns before the walk when the estimate predicts that. `--state-backend memory`
never promotes, so with it the passes run one after the other.

### Smaller peers, several channels (bc.t3.medium, 4 vCPU host)

Earlier figures on AMB Hyperledger Fabric 2.2 with `bc.t3.medium` peers (CouchDB), extracting host in the same
VPC, Tier 3, synthetic data, a few thousand blocks per channel.

| Phase | Measured | Rate |
|---|---|---|
| Block walk, one channel of three in parallel | 1,382 blocks, 13,201 transactions, 48,343 writes in 49 s | 268 transactions/s, 980 writes/s per channel |
| Block walk, one of two channels in parallel | 1,382 blocks in 34 s | 388 transactions/s per channel |
| Private-data delivery (`DeliverWithPrivateData`), sparse private data | 1,382 blocks in 4 s | about 350 blocks/s |
| Four channels (615-2,126 blocks), 16 vCPU host: `--concurrency 1` / `--concurrency 4` / `--processes 4` | 1.15M output records | 295 s / 210 s / 162 s wall |
| Merge, 3 members | 163 MB merged output | 26 s |

What bounds it:
- On a small host the walk is CPU-bound in the client (parsing, hash-chain checks, state reconstruction): one
  process uses one core for this, whatever `--concurrency` is, which the 4-against-16-core result above confirms.
  `--processes` gives each channel its own process.
- On larger peers with denser blocks the run waits on the peer: the 16 vCPU run above used 61 s of CPU in 295 s
  of wall clock, and the private-data pass took longer than the walk.
- The source peer must hold the whole ledger. A peer that falls behind the orderer (seen with burstable instance
  types under sustained write load) delays extraction until it catches up; check peer height against the orderer
  before a timed run.
- Output scales with value size and private-data volume, not write count alone: the 400-byte-value channel above
  wrote about 1.36 MB per block at Tier 3, where these smaller-value channels ran near 115 bytes per public
  write. Size `--state-data-dir` and output volume from a sample, not a constant.

## Replay sizing

Measured into a self-managed Fabric 2.5 destination (one orderer, one peer and CouchDB per member) sharing a 4 vCPU
host, `replayHistory: true`.

| Record kind | Rate |
|---|---|
| Public history, `writeBatchSize` 500, `concurrency` 16 | about 150 versions/s |
| Public history, window raised to a whole channel, `concurrency` 32 | about 290 versions/s per channel; 567/s across three channels in parallel |
| Private history (one transaction per record) | 29-54 records/s |
| Verify (state and full public history) | about 81 entries/s |

Two bounds apply, and both can be measured before a window is promised:
- **Depth:** a key's versions must commit in order, so replay takes at least the deepest key's version count ×
  the destination's commit latency (about `BatchTimeout` plus a round trip; 0.32 s per version measured at 200 ms
  `BatchTimeout` across AZs). `status` reports each file's deepest key.
- **Volume:** records ÷ the destination's sustained write throughput, measured on one representative channel.

On separate hardware with a 200 ms `BatchTimeout` the same data replayed 5.4 times faster than at 2 s on a shared host.

### Fabric destination

Source: AMB Hyperledger Fabric 2.2, five members, channels `channel-a` and `channel-b`, merged Tier 3 extraction.
Destination: Fabric 2.5 on one `c6i.4xlarge` (one orderer, one peer and CouchDB per org), `BatchTimeout` 200 ms.
Measured on a test network.

| Run | Records | Time | Result |
|---|---|---|---|
| History replay (`replayHistory: true`) | 457,705 | 1,801 s (254/s) | 0 failed; `verify` 6,999 match, 0 mismatch |
| History replay with `historyImport` (`idempotent-v1`), resumed after `kill -9` at 120 s | 397,705 in the resumed run | 3,947 s (about 100/s) | 0 failed; `verify` 6,999 match, 0 mismatch: no history duplicated |
| The same replay again over the finished destination, checkpoint deleted | 457,705, every one already applied | 1,824 s | 0 failed; `verify` unchanged: re-applied operations are no-ops |

`historyImport` costs about 2.5 times the plain history replay (each write also records a receipt), and buys a replay
that can be resumed after any interruption. `verify`'s skips here are the documented ones: composite keys (1,300) and
private history, which Fabric cannot read back (17 collections).

### DynamoDB destination

Source: one member's Tier 3 extraction from an AMB Hyperledger Fabric 2.2 network, four channels, 15,382,674 records
(13 GB). Destination: five on-demand DynamoDB tables that `replay` created, written from a `c6i.4xlarge` in the same
region. Default `batchSize`. Measured on a test network.

| Run | Time | Result |
|---|---|---|
| Replay | 2,754 s (about 5,600 records/s), one run | 0 failed. DynamoDB returned unprocessed items 35,810 times and answered 34 requests with `InternalServerError`; every one was retried and written. Peak memory 258 MB |
| `verify`, `concurrency` 16 | 2,433 s (about 1,460 entries/s) | 3,541,420 match, 0 mismatch, missing or extra. Peak memory 2.4 GB |

On one channel of the same extraction (158,980 records), a second replay over the finished tables converged, and a
replay resumed after `kill -9` from its checkpoint; `verify` matched every entry after both.

### Replaying only what an extension added (`replay --since`)

Channel `channel-b` (two members), extracted at height 1,700, extended to 1,934, merged. Each `--since extension` result
was checked against a fresh full replay into an empty destination.

| Destination | `--since` replay | Result |
|---|---|---|
| PostgreSQL | 82,254 records, 1,196 keys changed, 150 deleted, 5.9 s (full replay: 12.6 s) | `fabric_state`, `fabric_history`, `fabric_block_metadata`, `fabric_private_hashes` identical to the fresh replay (row count and digest); `verify` clean |
| Fabric, history with `historyImport` (new scope) | 48,405 records, 516 s (full replay of the extended directory: 104,450 records) | `verify` clean; the base replay's scope was refused |
| Fabric, state only | 1,196 records, 4.1 s | `verify` clean, the same as a fresh full state replay |

Re-running the whole directory over the PostgreSQL destination instead, the earlier procedure, left the 100 public
keys deleted since the earlier height in the state table (`verify`: 100 `[EXTRA]`).

## Re-broadcast

Block-level re-broadcast, measured on a test network. One channel (`channel-b`, 1,934 blocks, 20,731 valid
transactions, two orgs) into a self-managed Fabric 2.5 destination with CouchDB peers, `BatchTimeout` 500 ms, peers set
to `CORE_PEER_GOSSIP_PVTDATA_PULLRETRYTHRESHOLD=0s`:
- `run`: 1,933 blocks in 993 s, p50 510 ms per transaction block.
- `compare` via the orderer and via each peer: every block matches (data hash, transaction IDs, validation codes,
  commit hash). Peers were level with the orderer 15 s after `run` ended.
- Tip phase: chaincode redeployed at the next sequence with the migration contract; `tip import-private` as each org;
  `verify` via each org's peer: all 1,016 live keys, 260 deletes, 71,421 history versions and every private value or
  hash match.
