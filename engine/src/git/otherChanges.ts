// MARK: git-sync — §68.5: changed files outside the review, for the commit sheet's second group.
import type { OtherChange } from "../protocol.js";
import type { ChangedFile } from "./checkpoint.js";
import { nulSplit, runGit } from "./exec.js";
import { matchesIgnore } from "./ignore.js";

/** `commit_others` lists at most this many files (`truncated` beyond). */
export const MAX_OTHER_CHANGES = 500;

/** Both `XY` letters of an unmerged entry (`git status`): a conflict is resolved first, never committed from the sheet. */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * §68.5: every change `git status --porcelain=v1 -z --untracked-files=all` lists whose path — or, for a rename, either
 * path — is not a review file (`review`, both names of a rename), unmerged entries left out, sorted by path. `hidden`: an
 * app ignore pattern matches it (still committable — it is the user's file — but never in a review).
 */
export async function otherChanges(root: string, review: readonly Pick<ChangedFile, "path" | "oldPath">[], ignore: readonly string[]): Promise<OtherChange[]> {
  const out = await runGit(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const inReview = new Set(review.flatMap((f) => (f.oldPath !== null && f.oldPath !== f.path ? [f.path, f.oldPath] : [f.path])));
  const tokens = nulSplit(out.stdout);
  const files: OtherChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const oldPath = xy[0] === "R" || xy[0] === "C" ? (tokens[++i] ?? null) : null;
    if (UNMERGED.has(xy) || xy === "!!") continue;
    if (inReview.has(path) || (oldPath !== null && inReview.has(oldPath))) continue;
    const untracked = xy === "??";
    const status = untracked ? "?" : statusLetter(xy);
    files.push({ path, oldPath: xy[0] === "R" ? oldPath : null, status, untracked, ...(matchesIgnore(path, [...ignore]) ? { hidden: true as const } : {}) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The index's letter when it has one, else the worktree's (`C`opied reads as `A`dded). */
function statusLetter(xy: string): OtherChange["status"] {
  const c = xy[0] !== " " ? xy[0]! : xy[1]!;
  if (c === "R") return "R";
  if (c === "D") return "D";
  if (c === "A" || c === "C") return "A";
  if (c === "T") return "T";
  return "M";
}

/** The pathspecs a commit of `files` stages: each path and the old name of a rename. */
export function otherSpecs(files: readonly OtherChange[]): string[] {
  return [...new Set(files.flatMap((f) => (f.oldPath !== null ? [f.path, f.oldPath] : [f.path])))];
}
