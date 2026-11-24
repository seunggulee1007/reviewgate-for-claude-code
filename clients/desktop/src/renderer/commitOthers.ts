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
