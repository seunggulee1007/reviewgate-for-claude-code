// MARK: git-sync — §68: fetch and a safe pull of the current branch from its upstream.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { nulSplit, runGit, type GitResult } from "./exec.js";
import { FETCH_TIMEOUT_MS } from "./workbenchSetup.js";
import type { GitOperation } from "../protocol.js";

/** The git-dir files each unfinished operation leaves (`rebase-apply` is also `git am`'s: still a rebase to the user). */
const OPERATION_FILES: readonly [string, GitOperation][] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/** §68.2: the unfinished operation in `root` (one `rev-parse --git-path`), null when none. */
export async function gitOperation(root: string): Promise<GitOperation | null> {
  const out = await runGit(root, ["rev-parse", ...OPERATION_FILES.flatMap(([f]) => ["--git-path", f])], { allowFailure: true }).catch(() => null);
  if (!out || out.status !== 0) return null;
  const paths = out.text.split("\n").map((l) => l.trim());
  for (const [i, [, kind]] of OPERATION_FILES.entries()) {
    const p = paths[i];
    if (p && existsSync(isAbsolute(p) ? p : join(root, p))) return kind;
  }
  return null;
}

/** §68.1: the remotes of `root` (`git remote`), in git's order. */
export async function remoteList(root: string): Promise<string[]> {
  const out = await runGit(root, ["remote"], { allowFailure: true }).catch(() => null);
  return out && out.status === 0 ? out.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) : [];
}

/** §68.2: the current branch's upstream (`origin/main`) and its remote (`origin`; null for a local upstream `.`). */
export type Upstream = { ref: string; remote: string | null };

export async function upstreamOf(root: string, branch: string): Promise<Upstream | null> {
  const out = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true }).catch(() => null);
  const ref = out && out.status === 0 ? out.text.trim() : "";
  if (!ref) return null;
  const remote = await runGit(root, ["config", "--get", `branch.${branch}.remote`], { allowFailure: true }).catch(() => null);
  const name = remote && remote.status === 0 ? remote.text.trim() : "";
  return { ref, remote: name && name !== "." ? name : null };
}

/** `git rev-list --left-right --count HEAD...<ref>` → commits only HEAD has (ahead) / only `ref` has (behind). */
export async function aheadBehind(root: string, ref: string): Promise<{ ahead: number; behind: number } | null> {
  const out = await runGit(root, ["rev-list", "--left-right", "--count", `HEAD...${ref}`], { allowFailure: true }).catch(() => null);
  if (!out || out.status !== 0) return null;
  const [a, b] = out.text.trim().split(/\s+/).map((n) => parseInt(n, 10));
  return a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b) ? null : { ahead: a, behind: b };
}

export type FetchRun = { ok: boolean; exitCode: number | null; timedOut: boolean; line: string | null };

/**
 * §68.1 `git fetch --prune` of `remote` (or `--all`). Never asks on a terminal (`GIT_TERMINAL_PROMPT=0`); `quiet` (the
 * automatic fetch) also tells Git Credential Manager not to open a sign-in window. Hooks stay off (fetch runs none of the
 * user's). At most `FETCH_TIMEOUT_MS`.
 */
export async function fetchRemotes(root: string, opts: { remote: string | null; prune: boolean; quiet: boolean }): Promise<FetchRun> {
  const args = ["fetch", ...(opts.prune ? ["--prune"] : []), ...(opts.remote === null ? ["--all"] : ["--", opts.remote])];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", ...(opts.quiet ? { GCM_INTERACTIVE: "never" } : {}) };
  try {
    const out = await runGit(root, args, { allowFailure: true, timeoutMs: FETCH_TIMEOUT_MS, env });
    const exitCode = out.timedOut ? null : out.status;
    const line = exitCode === 0 ? null : out.timedOut ? "git fetch timed out" : gitErrorLine(out);
    return { ok: exitCode === 0, exitCode, timedOut: out.timedOut === true, line };
  } catch (e) {
    return { ok: false, exitCode: null, timedOut: false, line: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/** The most telling line of a failed git: its `fatal:` / `error:` line, else the first non-empty one (≤ 300 chars). */
export function gitErrorLine(out: Pick<GitResult, "stderr" | "text">): string {
  const lines = `${out.stderr}\n${out.text}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "git failed";
  return line.slice(0, 300);
}

/**
 * §68.2: the paths `HEAD..<ref>` changes (both sides of a rename: `--no-renames`), and of those the ones the working tree
 * holds changes to — a tracked file changed (staged or not) or an untracked file of that name. Git would refuse the
 * fast-forward for exactly these ("would be overwritten"); asking first gives the list before anything runs.
 */
export async function pullOverlap(root: string, ref: string): Promise<string[]> {
  const [incoming, status] = await Promise.all([
    runGit(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ref]),
    runGit(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
  ]);
  const touched = new Set(nulSplit(incoming.stdout));
  const dirty = nulSplit(status.stdout).filter((e) => e.length > 3).map((e) => e.slice(3));
  return [...new Set(dirty.filter((p) => touched.has(p)))].sort();
}

/** The tab-indented paths git lists under "…would be overwritten by merge:" (and the like). */
export function overwrittenPaths(stderr: string): string[] {
  return stderr.split(/\r?\n/).filter((l) => l.startsWith("\t")).map((l) => l.trim()).filter((l) => l.length > 0);
}

export type MoveRun = { ok: true } | { ok: false; line: string; overwritten: string[] };

/** §68.2 `git merge --ff-only <ref>` (the user's hooks run, as for their own pull; never killed half-way). */
export async function fastForward(root: string, ref: string): Promise<MoveRun> {
  const out = await runGit(root, ["merge", "--ff-only", "--no-stat", ref], { allowFailure: true, userHooks: true, timeoutMs: 0 });
  if (out.status === 0) return { ok: true };
  return { ok: false, line: gitErrorLine(out), overwritten: overwrittenPaths(out.stderr) };
}

/**
 * §68.3 `git rebase <ref>` of a clean working tree; a rebase that stops (a conflict, a hook) is aborted at once, so the
 * branch, the index and the files are back where they were. Never opens an editor.
 */
export async function rebaseOnto(root: string, ref: string): Promise<MoveRun> {
  const env = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };
  const out = await runGit(root, ["rebase", ref], { allowFailure: true, userHooks: true, timeoutMs: 0, env });
  if (out.status === 0) return { ok: true };
  const line = gitErrorLine(out);
  if ((await gitOperation(root)) === "rebase") await runGit(root, ["rebase", "--abort"], { allowFailure: true, timeoutMs: 0, env });
  return { ok: false, line, overwritten: overwrittenPaths(out.stderr) };
}
