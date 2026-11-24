/**
 * MARK: a-gitflow — docs/PROTOCOL.md §61: the end of a day (accept → new branch → commit → PR) as the Mac's Core
 * (`AppState.prCreateBlocker`, `CreatePRSheet.baseBlocker`): a new branch takes uncommitted work along, Create PR waits for
 * a branch other than the default one — not for a clean tree — and a switch the working tree blocks offers Commit….
 */
import type { PRDraftEvent, ReviewState } from "@reviewgate/engine";
import { commitListed } from "./acceptCommit";
import { otherChangesTotal } from "./commitOthers"; // MARK: git-sync (§68.5)
import { commitLockReason } from "./commitLock";
import { refusalCodeText } from "./errorCodes";
import { t } from "./i18n";
import { isShadowProject, notGitRepoReason } from "./noGit";

type Branchy = Pick<ReviewState, "project" | "gate" | "branches">;

/** Why "Create PR from this branch…" cannot run now (null: it can) — a folder without git, a detached HEAD, Claude working, the default branch. */
export function prCreateBlocker(st: Branchy): string | null {
  if (!st.project) return null;
  if (isShadowProject(st)) return notGitRepoReason();
  const branch = st.project.branch ?? null;
  if (branch === null) return refusalCodeText("detached_head", "");
  if (st.gate.phase === "running") return t("Claude is working");
  if (branch === (st.branches.defaultBranch ?? null)) return refusalCodeText("pr_same_branch", branch);
  return null;
}

/** The PR sheet's Create: the base is this branch (main → main), or nothing is on the branch since the base (the engine refuses both). */
export function prBaseBlocker(base: string, head: string, draft: Pick<PRDraftEvent, "baseRef" | "commits"> | null): string | null {
  if (base !== "" && base === head) return refusalCodeText("pr_same_branch", head);
  if (draft && draft.baseRef !== null && draft.commits.length === 0) return refusalCodeText("pr_no_commits", draft.baseRef);
  return null;
}

/** Where the branch menu says the working tree blocks a switch: why Commit… cannot open (null: it can). */
export function commitBeforeSwitchBlocker(st: Pick<ReviewState, "project" | "gate" | "changedFiles" | "commit">): string | null {
  const lock = commitLockReason(st);
  if (lock !== null) return lock;
  const committable = st.commit?.acceptedPaths ?? [];
  if (st.commit?.canCommit || commitListed(committable, st.changedFiles).length > 0 || otherChangesTotal(st) > 0) return null;
  return refusalCodeText("nothing_to_commit", "");
}
