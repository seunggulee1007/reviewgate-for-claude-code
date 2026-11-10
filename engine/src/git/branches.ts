import type { GitCheckpoint } from "./checkpoint.js";

/** One local branch as listed by `git for-each-ref refs/heads` (docs/M8-API.md). */
export type BranchInfo = {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Unix seconds of the tip commit; null when unparsable. */
  lastCommitDate: number | null;
};

/** Why the branch switcher is disabled right now; null means switching is allowed. */
export type BranchSwitchBlocker =
  | { kind: "pendingReview"; count: number }
  | { kind: "dirtyWorktree" }
  | { kind: "running" };

/** `[ahead 1, behind 2]`, `[ahead 1]`, `[behind 2]`, `[gone]` or empty → { ahead, behind }. */
export function parseTrack(track: string): { ahead: number; behind: number } {
  let ahead = 0;
  let behind = 0;
  const body = track.replace(/^[[\] ]+|[[\] ]+$/g, "");
  for (const part of body.split(",")) {
    const words = part.split(" ").filter((w) => w.length > 0);
    if (words.length !== 2) continue;
    const n = parseInt(words[1]!, 10);
    if (Number.isNaN(n)) continue;
    if (words[0] === "ahead") ahead = n;
    else if (words[0] === "behind") behind = n;
  }
  return { ahead, behind };
}

/** Local branches: the current one first, then by last commit date descending, then by name. */
export async function branches(cp: GitCheckpoint): Promise<BranchInfo[]> {
  const format = "%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)";
  const out = await cp.git(["for-each-ref", `--format=${format}`, "refs/heads"]);
  const result: BranchInfo[] = [];
  for (const line of out.text.split("\n")) {
    if (!line) continue;
    const f = line.split("\0");
    if (f.length < 5 || !f[0]) continue;
    const { ahead, behind } = parseTrack(f[3]!);
    const secs = parseInt(f[4]!.trim(), 10);
    result.push({
      name: f[0],
      isCurrent: f[1] === "*",
      upstream: f[2] ? f[2] : null,
      ahead,
      behind,
      lastCommitDate: Number.isNaN(secs) ? null : secs,
    });
  }
  return result.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const da = a.lastCommitDate ?? Number.NEGATIVE_INFINITY;
    const db = b.lastCommitDate ?? Number.NEGATIVE_INFINITY;
    if (da !== db) return db - da;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// MARK: wave3 engine-flow — §36.12

/** `state.branches.remotes` holds at most this many remote-tracking branches. */
export const MAX_REMOTE_BRANCHES = 300;

/** A remote-tracking branch as a `workbench_create` base (`RemoteBranchInfo`: `name` = `origin/develop`). */
export type RemoteBranch = BranchInfo & { remote: true };

/** `refs/remotes/*` without `<remote>/HEAD`, newest first, at most `MAX_REMOTE_BRANCHES`. */
export async function remoteBranches(cp: Pick<GitCheckpoint, "git">): Promise<RemoteBranch[]> {
  const format = "%(refname)%00%(refname:short)%00%(committerdate:unix)";
  // Room for the `<remote>/HEAD` entries the loop drops (one per remote).
  const out = await cp.git(["for-each-ref", "--sort=-committerdate", `--count=${MAX_REMOTE_BRANCHES * 2}`, `--format=${format}`, "refs/remotes"]);
  const result: RemoteBranch[] = [];
  for (const line of out.text.split("\n")) {
    if (result.length >= MAX_REMOTE_BRANCHES) break;
    const f = line.split("\0");
    if (f.length < 3 || !f[0] || !f[1] || f[0].endsWith("/HEAD")) continue;
    const secs = parseInt(f[2]!.trim(), 10);
    result.push({ name: f[1], isCurrent: false, upstream: null, ahead: 0, behind: 0, lastCommitDate: Number.isNaN(secs) ? null : secs, remote: true });
  }
  return result;
}

/** `git status --porcelain` is non-empty (untracked files count; ignore patterns are not applied). */
export async function isWorktreeDirty(cp: GitCheckpoint): Promise<boolean> {
  const out = await cp.git(["--no-optional-locks", "status", "--porcelain"]);
  return out.text.trim().length > 0;
}

/** `git switch <name>`. */
export async function switchBranch(cp: GitCheckpoint, name: string): Promise<void> {
  await cp.git(["switch", "--", name], { timeoutMs: 0 }); // wave4 w4-safety: never killed half-way (it moves the real index / HEAD)
}

/**
 * Validates `name` with `git check-ref-format --branch`, then `git switch -c <name> [from]`
 * (or `git branch <name> [from]` when `checkout` is false).
 */
export async function createBranch(
  cp: GitCheckpoint,
  name: string,
  from: string | null = null,
  checkout = true,
): Promise<void> {
  await cp.git(["check-ref-format", "--branch", name]);
  const args = checkout ? ["switch", "-c", name] : ["branch", "--", name];
  if (from) args.push(from);
  await cp.git(args);
}
