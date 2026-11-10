/**
 * Review / plan locks shared by the store and the components (kept free of the store so they are unit-testable).
 */
import type { PendingPlan, ReviewState } from "@reviewgate/engine";

/**
 * Accept / reject are unavailable while a turn runs, its changes are being collected or a revert is in
 * flight — the engine refuses them with `session_running` / `reverting` then (release review H3).
 */
export const isReviewLocked = (s: Pick<ReviewState, "gate">): boolean => ["running", "collecting", "reverting"].includes(s.gate.phase);

/**
 * The plan card's Approve / Keep planning are disabled while the review is locked (a turn, its collection or a
 * revert) and while a `plan_response` is still waiting for its `result` (no double answers).
 */
export const isPlanLocked = (s: Pick<ReviewState, "gate">, answering: boolean): boolean => answering || isReviewLocked(s);

/**
 * After `plan_followup_failed` (§19.5) the card comes back: the snapshot's `pendingPlan` when the engine already
 * restored it, else the plan that was being answered (until the restored snapshot arrives).
 */
export function planAfterFollowupFailure(pending: PendingPlan | null, answered: PendingPlan | null): PendingPlan | null {
  return pending ?? answered;
}
