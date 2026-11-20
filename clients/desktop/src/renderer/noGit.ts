/**
 * docs/PROTOCOL.md §59 — a folder that is no git repository, reviewed through a hidden repository ReviewGate keeps outside
 * it (`track_without_git`, `project.vcs = "shadow"`): the words of the git-init dialog's new choice and of its refusals, and
 * the one test the rest of the UI asks before showing what needs a real repository (branches, workbenches, commit, PRs).
 *
 *   if (isShadowProject(state)) return;          // never send a command the engine refuses `not_a_git_repo`
 *   <button disabled title={notGitRepoReason()}>  // a single button stays, disabled with the reason
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** The project is tracked without git (§59): branches, workbenches, commit, push and PRs are off. */
export const isShadowProject = (s: Pick<ReviewState, "project">): boolean => s.project?.vcs === "shadow";

/** The tooltip of a control that needs a real repository. */
export const notGitRepoReason = (): string => t("This folder is not a git repository");

/** The project header's line in place of the branch. */
export const shadowProjectLine = (): string => t("Not a git repository — changes tracked by ReviewGate");

/** What the dialog's "Track without git" explains (and the indicator's tooltip). */
export const trackWithoutGitHelp = (): string =>
  t("ReviewGate keeps a hidden copy outside this folder to show what Claude changed. The folder itself is not touched; commit, branches, workbenches and PRs are off.");

/** `folder_too_large:<limit>` (§59 size guard): which limit, and the two ways out. */
export function folderTooLargeText(limit: string): string {
  switch (limit.trim()) {
    case "files":
      return t("This folder has more than 20,000 files — too many to track without git. Initialize git here, or open a smaller folder.");
    case "bytes":
      return t("This folder holds more than 1 GB — too much to track without git. Initialize git here, or open a smaller folder.");
    default:
      return t("Listing this folder took too long to track it without git. Initialize git here, or open a smaller folder.");
  }
}

/** `track_failed: <git's message>`. */
export const trackFailedText = (detail: string): string =>
  detail.trim() ? t("This folder could not be tracked without git: {0}", detail.trim()) : t("This folder could not be tracked without git.");

/** What `track_without_git` came to: done, the user must confirm first (`folder_unsafe`), or the refusal's words. */
export type TrackOutcome = { kind: "ok" } | { kind: "confirm" } | { kind: "failed"; text: string };
