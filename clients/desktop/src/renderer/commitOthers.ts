/**
 * MARK: git-sync — docs/PROTOCOL.md §68.5 on Windows (as the Mac's Core `CommitOthersRules`): the commit dialog's second
 * group — changed files outside the review (the user's own edits, files dirty before the turn), none ticked at first,
 * untracked ones listed only when asked for; committed along as they are (`commit.extraPaths`), never marked accepted.
 */
import type { OtherChange, ReviewState } from "@reviewgate/engine";

/** `state.commit.otherChanges` total (0 from an older engine). */
export function otherChangesTotal(st: Pick<ReviewState, "commit">): number {
  const o = (st.commit as { otherChanges?: { tracked: number; untracked: number } } | undefined)?.otherChanges;
  return o ? o.tracked + o.untracked : 0;
}

/** The rows shown: tracked changes always, untracked ones with `showUntracked`. */
export function visibleOthers(files: readonly OtherChange[], showUntracked: boolean): OtherChange[] {
  return showUntracked ? [...files] : files.filter((f) => !f.untracked);
}

/** The ticked paths still listed (an untracked one hidden again is not committed). */
export function extraPathsOf(ticked: ReadonlySet<string>, files: readonly OtherChange[], showUntracked: boolean): string[] {
  return visibleOthers(files, showUntracked).map((f) => f.path).filter((p) => ticked.has(p));
}

/** The status column: git's letter, "U" for an untracked file (as editors show it). */
export function otherStatusLetter(f: Pick<OtherChange, "status" | "untracked">): string {
  return f.untracked ? "U" : f.status;
}

/**
 * The dialog holds only changes outside the review (no review file to list): titled "Commit changes" — not "Commit
 * accepted (0)…" — with no empty review list above them (as the Mac's `CommitOthersRules.othersOnly`).
 */
export function othersOnly(reviewListed: number, others: number, truncated: boolean): boolean {
  return reviewListed === 0 && (others > 0 || truncated);
}

/**
 * The message once `commit_others` answered: with only other changes and the message still the review's suggestion
 * (Claude's last instruction, or "Apply accepted changes"), the reply's neutral one ("Update README.md"); null keeps the
 * message (a review file listed, something typed, an older engine) — as the Mac's `CommitOthersRules.message`.
 */
export function othersMessage(current: string, reviewSuggestion: string, othersSuggestion: string | undefined, onlyOthers: boolean): string | null {
  if (!onlyOthers || !othersSuggestion) return null;
  return current === reviewSuggestion || current === "" ? othersSuggestion : null;
}

/**
 * The ticked files changed: the message the reply names them with, while the message is still the one last suggested
 * (a draft typed over it stays); null keeps the message — as the Mac's `CommitOthersRules.followingTicks`.
 */
export function followingTicks(current: string, lastSuggestion: string | null, newSuggestion: string | undefined): string | null {
  return lastSuggestion !== null && newSuggestion !== undefined && current === lastSuggestion && newSuggestion !== current ? newSuggestion : null;
}
