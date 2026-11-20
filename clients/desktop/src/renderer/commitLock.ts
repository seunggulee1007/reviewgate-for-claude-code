/**
 * MARK: polish p-foundation — P5-sheets-12 / P2-review-26: why "Commit accepted" waits, in the Mac's order and words
 * (Core `AppState.commitLockReason`): a folder that is no git repository (§59) first, then a failed collection (Retry),
 * then a revert, then a turn or its collection running — the engine's `canCommit` is false through all of them. null: nothing holds it (with no accepted file the
 * button's count says so).
 *
 *   const why = commitLockReason(state);   // the commit button's title and the caption beside it
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";
import { collectFailedReason } from "./reviewRound";
import { isShadowProject, notGitRepoReason } from "./noGit";

export function commitLockReason(s: Pick<ReviewState, "gate"> & Partial<Pick<ReviewState, "project">>): string | null {
  // §59: a folder tracked without git never commits — before anything that would only make it wait.
  if (isShadowProject({ project: s.project ?? null })) return notGitRepoReason();
  const collect = collectFailedReason(s);
  if (collect !== null) return collect;
  if (s.gate.phase === "reverting") return t("Reverting…");
  if (s.gate.phase === "running" || s.gate.phase === "collecting") return t("Claude is working — wait for the turn to finish");
  return null;
}
