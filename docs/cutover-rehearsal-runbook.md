# Runbook: cutover rehearsal with a short freeze window

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

How to move a Fabric network's data with the source stopped only for the last few blocks. The long work runs while the
source is still taking writes:
- the full extraction;
- validation;
- the first replay into staging.

The freeze window holds only the extension to the final height, its validation, the replay of what the extension
added, and the checks that let the owners sign off.

Rehearse the whole sequence at least once on representative data, against the destination configuration intended for
production, and time every step. The window the data owners approve is the one the rehearsal measured, not an estimate.
Measured rates to plan the rehearsal with are in [Tuning: extraction sizing](tuning.md#extraction-sizing).

This runbook is the replay path. For re-broadcast, steps 8 and 9 become the archive top-up, a second `run` and the tip
phase; see [Re-broadcast: end to end](rebroadcast.md#end-to-end) and, for what each path needs from extraction, the
[decision guide](decision-guide.md#fabric-destinations-replay-or-re-broadcast).

## Roles

| Role | Does |
|---|---|
| Migration lead | Runs the steps below, keeps the timing sheet, calls go/no-go at each gate |
| Each extracting member | Extracts and extends from its own peer with its own MSP, ships its directory (or a private-data kit) to the lead |
| Data owners | Record which collections lost private values to `blockToLive` and accept the loss in writing before the first pass, approve the window, sign off the result |
| Application owners | Stop writes at the freeze, run the business checks, switch endpoints |

## Before the window (days to hours ahead)

1. **Discover and extract in full, while the source runs.** Each member, against its own peer:

   ```bash
   export NODE_OPTIONS=--max-old-space-size=8192
   amb-migrate discover --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION \
     --msp-path $MSP_PATH --output-dir ./ext
   amb-migrate extract --manifest ./ext/manifest.json --tier 3 \
     --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --msp-path $MSP_PATH \
     --output-dir ./ext --memory-limit 4096 --prefetch-buffer 32 --processes 4
   amb-migrate validate --input-dir ./ext
   ```

   `--processes` puts each channel in its own process; it pays off when there are several large channels. Each channel
   reads the source peer over two streams, its public walk and its private data, so `--processes 4` is up to eight.
   The source peer is still serving production traffic during this pass: if it is small or busy, extract fewer
   channels at once (drop `--processes`, or use `--concurrency 1`) and watch its height against the orderer. Record the
   wall time and each channel's height. This pass may take hours; it costs no downtime.

2. **Record and accept purge loss.** From this pass's coverage report, record which collections have lost private
   values to `blockToLive` purging and have the data owner accept the loss in writing. A
   collection with a finite `blockToLive` keeps losing values on the peer while the source runs. The extension keeps every value
   the first pass captured, so extracting early reduces the loss rather than adding to it.

3. **Merge** (multi-member networks with private data no single member can read) and validate the merged directory:

   ```bash
   amb-migrate merge --input-dirs ./ext-A ./ext-B ./ext-C --output-dir ./merged
   amb-migrate validate --input-dir ./merged
   ```

   Every member's directory must be at the same height per channel; `merge` refuses otherwise. A member that
   contributes only private data can send a kit (`member-kit.sh`, see the multi-member runbook) instead of a full
   directory.

4. **Replay the first pass into staging and verify it.** This is where destination limits, large values and
   application assumptions show up. It is also where the replay time is measured, and that time decides how the
   window's delta is replayed (step 9).

5. **Extend once or twice more while the source still runs.** Each `--extend` reads only the blocks added since the
   previous pass, so the final one is small:

   ```bash
   cp -a ./ext ./ext-before-extend-1      # or a volume snapshot: --extend works in place
   amb-migrate discover ... --output-dir ./ext     # new heights into the same directory
   amb-migrate extract --extend --manifest ./ext/manifest.json --tier 3 \
     --network-id $NETWORK_ID --member-id $MEMBER_ID --node-id $NODE_ID --region $REGION --msp-path $MSP_PATH \
     --output-dir ./ext --memory-limit 4096 --prefetch-buffer 32
   ```

   Time it: the final extension in the window costs the same fixed part (reading the extracted state back in) plus
   the per-block part for however many blocks the source writes between this pass and the freeze.

## The window

Write the start time of every step on the timing sheet.

6. **Freeze.** The application owners stop:
   - every submit, scheduled job and integration;
   - channel configuration and chaincode lifecycle changes.

   Let in-flight transactions commit, then run `discover` twice, a minute apart. Every in-scope channel must show the same height both
   times. Record per channel the height and the time.

7. **Extend to the final height.** Each member runs the `--extend` above against its own peer, into its directory.
   Keep a copy first if the pre-freeze pass must stay as it was. If the run is interrupted, re-run the same command:
   the journal (`extend-journal.json`) rolls back or finishes the interrupted extension, and any other run refuses the
   directory until then. Record from each member's `channel-*/metadata.json`:
   - `ledgerHeight`;
   - `walkTip` (the last block's number and header hash).

   Every member must report the same values per channel.

8. **Merge again and validate.** Same commands as step 3, into a new directory. The merge needs a full pass over every
   member's files, so its time is part of the window.

9. **Replay what the final extension added.**

   ```bash
   amb-migrate replay --input-dir ./merged --adapter <adapter> --config replay-config.json --since extension
   ```

   `--since extension` reads each channel's most recent extension from `metadata.json` (`merge` keeps it when every
   member extended from the same height; otherwise give `--since <channel>=<block>,...`). It replays history, block
   metadata and private hashes at or above that height, the state of every key written there, and deletes at the
   destination the keys deleted there.

   | Destination | Notes |
   |---|---|
   | PostgreSQL, DynamoDB | Re-running the whole directory instead is not equivalent: keys deleted since the earlier height stay in the state table (`verify` reports them as `[EXTRA]`) |
   | Fabric, state only (`replayHistory: false`) | Changed keys are written, deleted keys are deleted through `deleteMapping` / `DeletePrivateData` |
   | Fabric with history (`replayHistory: true`) | Needs `historyImport` with a **new scope** for this replay: the scope's plan binds the heights replayed, so the staged replay's scope is refused. Without `historyImport` the replay is refused |

   It keeps a checkpoint of its own, so it resumes after an interruption and never mixes with the staged replay's.
   Rehearse it: the measured time is in step 4's log and the timing sheet.

10. **Verify, then sign off.** Run `verify` with the replay config, plus the business checks. The data owners,
    members and application owners sign off against the agreed acceptance criteria.

11. **Close the migration path.** This is a gate: no application traffic reaches the destination until it is done.
    - Upgrade every destination chaincode to the package without the migration contract (the application's own code,
      with the import and registration removed), through the usual lifecycle approvals with a new sequence number.
      Keep every collection's `blockToLive` as committed: Fabric refuses a definition that changes it
      ([Destination blockToLive during migration](replay-config-reference.md#destination-blocktolive-during-migration)).
      The contract's write functions accept any identity of a listed MSP, and its read functions, including
      `ReadPrivateData`, are not gated at all; it must not outlive the migration.
    - Confirm it is gone: on each destination channel and chaincode, an evaluate of `MigrationContract:ListKeys`
      (or the name set in `migrationContract`) must fail with the contract not found. A `replay` against the
      destination must now stop at its pre-flight.
    - Revoke the identities replay and verify used (`chaincode.certPath`, `orgIdentities`, `collectionIdentities`):
      revoke them at their CA, and add the CA's updated CRL to the org's MSP definition in each channel's config, so
      peers and orderers refuse them. The CRL must carry the Authority Key Identifier extension: Fabric refuses a CRL
      without one (`could not obtain Authority Key Identifier for crl`). `fabric-ca-client revoke --gencrl` (Fabric CA
      1.5) writes it; a CRL made with `openssl ca` needs `authorityKeyIdentifier = keyid:always` in its CRL extensions.
      Delete the migration host's copies of their keys. The CRL update needs an org admin's signature, so do not revoke
      an org's only admin: give replay and verify dedicated identities, enrolled for the migration, and revoke those.

12. **Switch** application endpoints, credentials and integrations to the destination. Keep the source read-only for the agreed
    retention period.

## Abort

Until step 12 the source is still authoritative and has only been paused. To abort, lift the freeze. Keep the
extraction directories (they are the starting point for the next attempt, extended again), and reset the staging
destination if step 9 had started writing to it.

## Timing sheet

| Step | Started | Ended | Notes |
|---|---|---|---|
| 1 Full extraction (per member) | | | heights, blocks, transactions |
| 3 Merge + validate | | | |
| 4 Staged replay + verify | | | records, failures |
| 5 Pre-freeze extensions | | | gap in blocks, time |
| 6 Freeze confirmed | | | heights |
| 7 Final extension (per member) | | | gap in blocks, time |
| 8 Merge + validate | | | |
| 9 Delta replay | | | |
| 10 Verify + sign-off | | | |
| 11 Migration path closed | | | contract removed, identities revoked |
| 12 Switch | | | |

The window is the span from step 6 to the end of step 10. To estimate it before the rehearsal, use the extension and merge figures in
[Tuning: extraction sizing](tuning.md#extraction-sizing). The replay figures come from step 4.
