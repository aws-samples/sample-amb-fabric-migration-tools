import { PurgeRisk } from './purge-assessor';

/**
 * Why a collection's coverage is not `values`.
 *
 * `coverage` alone records the outcome; this records the cause, which is what a
 * purge-loss sign-off has to name. Parallel to `validate`'s per-key
 * `MissingValueReason`, one level up: that classifies a single absent value,
 * this classifies the collection as a whole.
 *
 * unauthorized  — the extracting MSP is not named in the collection policy, so
 *                 its peer was never sent these values. Definitive.
 * purge-window  — the MSP is a member and hashes were captured, so the values
 *                 existed and the collection has a finite `blockToLive`. This
 *                 is the reason that constitutes accepted data loss.
 * never-written — neither values nor hashes were seen in the blocks walked.
 * unexplained   — a member, no purge window, yet no values arrived. Not an
 *                 accepted loss; something is wrong and it needs investigation.
 * indeterminate — the extracting MSP is unknown, so membership cannot be
 *                 evaluated and no cause may honestly be assigned.
 */
export type CoverageReason =
  | 'unauthorized'
  | 'purge-window'
  | 'never-written'
  | 'unexplained'
  | 'indeterminate';

/**
 * What the purge horizon has to explain for one collection.
 *
 * `blockToLive` and `ledgerHeight` bound the window; `newestHashBlock` is what
 * decides whether the window explains this collection's missing values.
 */
export interface PurgeHorizon {
  /** Collection's configured purge horizon; 0 means never. */
  blockToLive: number;
  /** The channel's ledger height at extraction. */
  ledgerHeight: number;
  /**
   * Highest block a hash was captured at for this collection.
   *
   * `undefined` when it could not be read, which leaves the purge window the
   * benefit of the doubt — see `purgeExplainsLoss`.
   */
  newestHashBlock?: number;
}

/**
 * Whether the purge horizon accounts for a collection's missing values.
 *
 * `blockToLive` bounds a *window*, and a collection having one is not evidence
 * that anything in it expired. Private data written in block `N` is purged once
 * the ledger passes `N + blockToLive`, so a hash captured at a block still
 * inside its own retention window proves the opposite: that write has not been
 * purged, and a peer that was sent it still holds the value. Missing values for
 * such a collection have some other cause — the extracting member had no anchor
 * peer while those blocks committed and gossip never delivered the data, the
 * peer joined after they committed, or membership came later.
 *
 * The arithmetic matches `estimatedPurgedBlocks` (`purge-assessor.ts`), where
 * block `N` is purged exactly when `N + blockToLive < ledgerHeight`. Both are
 * computed from heights rather than read back from a peer, and keeping them
 * identical means one unverified assumption rather than two that can disagree.
 *
 * An unknown `newestHashBlock` returns `true`, leaving the reason as it was
 * before this check existed: a check that cannot run must not invent a stop.
 */
function purgeExplainsLoss(horizon: PurgeHorizon): boolean {
  if (horizon.newestHashBlock === undefined) return true;
  return horizon.newestHashBlock + horizon.blockToLive < horizon.ledgerHeight;
}

/**
 * Name the cause behind a non-`values` outcome.
 *
 * Ordered by how much each conclusion can be trusted. Non-membership is
 * checked first because it is definitive and makes every later question moot:
 * a peer that was never sent the values cannot have purged them. `absent`
 * outranks the purge window in turn — with no hashes there is no evidence the
 * data ever existed, so calling it purged would invent a loss.
 *
 * `purge-window` is the last conclusion reached and the hardest to earn,
 * because it is the only one a data owner signs off as accepted loss. Having a
 * horizon is not enough: the horizon must actually explain the missing values.
 *
 * @param captured Outcome from `classifyCoverage`, never `values`.
 * @param authorized Membership of the collection policy, `undefined` if unknown.
 * @param horizon The collection's purge window and newest captured hash.
 */
export function classifyCoverageReason(
  captured: 'hashes-only' | 'absent',
  authorized: boolean | undefined,
  horizon: PurgeHorizon,
): CoverageReason {
  if (authorized === undefined) return 'indeterminate';
  if (!authorized) return 'unauthorized';
  if (captured === 'absent') return 'never-written';
  if (horizon.blockToLive === 0) return 'unexplained';
  return purgeExplainsLoss(horizon) ? 'purge-window' : 'unexplained';
}

/** What was actually captured for one private data collection. */
export interface PrivateCollectionCoverage {
  chaincode: string;
  collection: string;
  /**
   * values      — plaintext values were delivered for this collection.
   * hashes-only — only hashed rwsets were captured.
   * absent      — no values and no hashes were seen for this collection.
   *
   * The outcome only. Read `reason` for the cause: `hashes-only` on its own
   * cannot be acted on, because it is reached by unauthorized, purged and
   * never-written collections alike.
   */
  coverage: 'values' | 'hashes-only' | 'absent';
  /**
   * Whether the extracting MSP is named in this collection's policy.
   *
   * Absent when the extracting MSP is unknown, or when the policy could not be
   * read — in both cases membership is undetermined rather than false.
   */
  authorized?: boolean;
  /** Cause of a non-`values` outcome. Absent when `coverage` is `values`. */
  reason?: CoverageReason;
  blockToLive: number;
  purgeRisk: PurgeRisk['riskLevel'];
  /** Blocks whose private data has aged past blockToLive. */
  estimatedPurgedBlocks: number;
}

/**
 * How much a coverage reason blocks a go/no-go call, highest first.
 *
 * Used to collapse several members' reasons for one collection into the one a
 * coordinator has to act on. `unexplained` and `indeterminate` lead because
 * both mean the cause is unresolved: the first is a defect, the second is a
 * question nobody has answered. `purge-window` outranks `unauthorized` because
 * when one member was a collection member and lost data to the purge horizon,
 * the purge is the cause of the loss and another member's non-membership does
 * not change that. `never-written` is last: nothing was lost.
 */
const REASON_SEVERITY: Record<CoverageReason, number> = {
  unexplained: 5,
  indeterminate: 4,
  'purge-window': 3,
  unauthorized: 2,
  'never-written': 1,
};

/**
 * Pick the reason a coordinator has to act on from several members' reasons.
 *
 * @param reasons One reason per member that did not deliver values.
 * @returns The highest-severity reason, or `undefined` if none were given.
 */
export function mostSevereReason(
  reasons: CoverageReason[],
): CoverageReason | undefined {
  let worst: CoverageReason | undefined;
  for (const reason of reasons) {
    if (!worst || REASON_SEVERITY[reason] > REASON_SEVERITY[worst]) {
      worst = reason;
    }
  }
  return worst;
}

/**
 * Whether a merged coverage reason stops a sign-off.
 *
 * Both stops mean the same thing: nothing has been established. `unexplained`
 * is a member of the collection that received no values with no purge horizon
 * to blame, and `indeterminate` is a membership that could not be evaluated at
 * all. Neither is loss a data owner can accept, because neither says what was
 * lost.
 */
export function blocksSignOff(reason: CoverageReason | undefined): boolean {
  return reason === 'unexplained' || reason === 'indeterminate';
}
