import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { NestedChange, NestedKind } from "../protocol.js";
import { runGit } from "../git/exec.js";
import { listWorktrees } from "../git/worktrees.js";
import { isInsidePath, realpathLenient, relativeInside, samePath } from "../platform/paths.js";

/**
 * Nested repositories (docs/PROTOCOL.md §32): a linked worktree under the project (`.claude/worktrees/*` — EnterWorktree,
 * the Workflow tool, `isolation: "worktree"` subagents), a submodule, or a clone inside it. The snapshot records them as
 * one gitlink line at most, so a change inside never reaches the review. What the session itself did inside one —
 * an edit tool's file, a Bash / MCP call whose cwd is in it, a command naming it — is reported instead. Cheap on a
 * repository with many worktrees: one `git worktree list` per turn, `stat`s up the touched paths, and `git status`
 * only in the nested repositories the turn touched (≤ `STATUS_TIMEOUT_MS` each).
 */
export const STATUS_TIMEOUT_MS = 3000;
export const MAX_TOUCHED_LISTED = 20;

export type NestedRepo = { abs: string; rel: string; kind: NestedKind };

/**
 * The innermost nested repository holding `abs` (a file, or a directory such as a cwd) strictly below `root`: the
 * nearest directory with a `.git` entry. A `.git` directory is a clone (`repo`); a `.git` file points into the main
 * repository's `worktrees/` (`worktree`) or `modules/` (`submodule`), anything else is a `repo`. null when none.
 */
export async function nestedRepoOf(abs: string, root: string, commonDir: string, cache = new Map<string, NestedRepo | null>()): Promise<NestedRepo | null> {
  const realRoot = realpathLenient(root);
  let dir = realpathLenient(abs);
  if (!isInsidePath(dir, realRoot) || samePath(dir, realRoot)) return null;
  if (!(await lstat(dir).then((s) => s.isDirectory(), () => false))) dir = dirname(dir);
  const seen: string[] = [];
  let found: NestedRepo | null = null;
  for (; isInsidePath(dir, realRoot) && !samePath(dir, realRoot); dir = dirname(dir)) {
    if (cache.has(dir)) {
      found = cache.get(dir)!;
      break;
    }
    seen.push(dir);
    const kind = await gitEntryKind(join(dir, ".git"), commonDir);
    if (kind) {
      found = { abs: dir, rel: relativeInside(dir, realRoot)!, kind };
      break;
    }
  }
  for (const d of seen) cache.set(d, found);
  return found;
}

async function gitEntryKind(dotGit: string, commonDir: string): Promise<NestedKind | null> {
  const st = await lstat(dotGit).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) return "repo";
  const text = await readFile(dotGit, "utf8").catch(() => "");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return "repo";
  const target = realpathLenient(isAbsolute(m[1]!) ? m[1]! : resolve(dirname(dotGit), m[1]!));
  const common = realpathLenient(commonDir);
  if (isInsidePath(target, join(common, "worktrees"))) return "worktree";
  if (isInsidePath(target, join(common, "modules"))) return "submodule";
  return "repo";
}

/** HEAD of every linked worktree of the repository that lies inside `root` (one `git worktree list`). */
export async function worktreeHeads(root: string): Promise<Map<string, { head: string | null; branch: string | null }>> {
  const out = new Map<string, { head: string | null; branch: string | null }>();
  const realRoot = realpathLenient(root);
  for (const w of await listWorktrees(root).catch(() => [])) {
    const p = realpathLenient(w.path);
    if (w.bare || samePath(p, realRoot) || !isInsidePath(p, realRoot)) continue;
    out.set(p, { head: w.head || null, branch: w.branch });
  }
  return out;
}

/** Registered submodule paths (`.gitmodules`), repo-relative. */
export async function submodulePaths(root: string): Promise<string[]> {
  const out = await runGit(root, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { allowFailure: true }).catch(() => null);
  if (!out || out.status !== 0) return [];
  return out.text.split("\n").map((l) => l.trim().split(/\s+/).slice(1).join(" ")).filter(Boolean);
}

/** HEAD, branch and the number of `git status` entries of a nested repository (`dirtyFiles` null when git did not answer in time). */
export async function nestedStatus(abs: string): Promise<{ head: string | null; branch: string | null; dirtyFiles: number | null }> {
  const [head, branch, status] = await Promise.all([
    runGit(abs, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }).catch(() => null),
    runGit(abs, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }).catch(() => null),
    runGit(abs, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true, timeoutMs: STATUS_TIMEOUT_MS }).catch(() => null),
  ]);
  const entries = status && status.status === 0 && !status.timedOut ? status.stdout.toString("utf8").split("\0").filter(Boolean) : null;
  // `-z` porcelain v1: a rename / copy entry is followed by its source path.
  let dirty: number | null = null;
  if (entries) {
    dirty = 0;
    for (let i = 0; i < entries.length; i++) {
      dirty += 1;
      if (/^[RC]/.test(entries[i]!)) i += 1;
    }
  }
  return {
    head: head && head.status === 0 ? head.text.trim() || null : null,
    branch: branch && branch.status === 0 ? branch.text.trim() || null : null,
    dirtyFiles: dirty,
  };
}

/** What the turn did, as the engine saw it. */
export type NestedTouches = {
  /** Absolute files the turn's edit tools changed (tool_use ids present). */
  editedFiles: string[];
  /** Bash / MCP calls: where they ran and (Bash) the command. */
  calls: { via: "bash" | "mcp"; cwds: string[]; command?: string }[];
};

/**
 * The nested repositories the turn touched, with what is known about them now: the files its edit tools changed
 * there, how many `git status` entries the repository has, and its HEAD when it moved since the turn started
 * (`headsBefore`: worktree HEADs then; a gitlink's commit in A otherwise). A repository the turn only named in a
 * command, or ran a call in, is reported when it is dirty or its HEAD moved.
 */
export async function nestedChanges(opts: {
  root: string;
  commonDir: string;
  touches: NestedTouches;
  headsBefore: Map<string, { head: string | null; branch: string | null }>;
  /** A gitlink's commit in snapshot A (submodules, clones git saw), by repo-relative path. */
  gitlinkBefore: (rel: string) => Promise<string | null>;
}): Promise<NestedChange[]> {
  const cache = new Map<string, NestedRepo | null>();
  const found = new Map<string, { repo: NestedRepo; files: Set<string>; via: Set<"edit" | "bash" | "mcp"> }>();
  const note = (repo: NestedRepo | null, via: "edit" | "bash" | "mcp", file?: string): void => {
    if (!repo) return;
    const entry = found.get(repo.abs) ?? { repo, files: new Set<string>(), via: new Set() };
    entry.via.add(via);
    if (file) {
      const rel = relativeInside(realpathLenient(file), realpathLenient(opts.root));
      if (rel) entry.files.add(rel);
    }
    found.set(repo.abs, entry);
  };
  for (const f of opts.touches.editedFiles) note(await nestedRepoOf(f, opts.root, opts.commonDir, cache), "edit", f);
  const known: NestedRepo[] = [];
  const realRoot = realpathLenient(opts.root);
  for (const p of (await worktreeHeads(opts.root)).keys()) known.push({ abs: p, rel: relativeInside(p, realRoot)!, kind: "worktree" });
  for (const rel of await submodulePaths(opts.root)) known.push({ abs: join(realRoot, rel), rel, kind: "submodule" });
  for (const call of opts.touches.calls) {
    for (const cwd of call.cwds) note(await nestedRepoOf(cwd, opts.root, opts.commonDir, cache), call.via);
    const command = call.command;
    if (!command) continue;
    for (const k of [...known, ...[...found.values()].map((e) => e.repo)]) {
      if (command.includes(k.rel) || command.includes(k.abs)) note(k, call.via);
    }
    // A path the command names (`sed -i … vendor/lib/x.txt`, `git -C libs/sub …`) inside a repository nobody listed.
    const base = call.cwds[0] ?? opts.root;
    for (const token of pathTokens(command)) note(await nestedRepoOf(resolve(base, token), opts.root, opts.commonDir, cache), call.via);
  }
  const out: NestedChange[] = [];
  for (const { repo, files, via } of found.values()) {
    const now = await nestedStatus(repo.abs);
    const before = opts.headsBefore.get(repo.abs)?.head ?? (await opts.gitlinkBefore(repo.rel));
    const head = before !== null && now.head !== null && before !== now.head ? { from: before, to: now.head } : null;
    if (files.size === 0 && head === null && !now.dirtyFiles) continue;
    out.push({
      path: repo.rel,
      kind: repo.kind,
      branch: now.branch,
      head,
      dirtyFiles: now.dirtyFiles,
      touchedFiles: [...files].sort().slice(0, MAX_TOUCHED_LISTED),
      via: [...via].sort(),
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Words of a shell command that look like paths (hold a `/`, not an option, not a URL); at most 50. */
export function pathTokens(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;&|<>()`'"]+/)) {
    const t = raw.replace(/^[^\w./~-]+|[,:]+$/g, "");
    if (!t.includes("/") || t.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("~")) continue;
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}
