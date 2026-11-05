import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Settings } from "../protocol.js";
import { compareKey, realpathLenient, samePath, toNativeAbs } from "../platform/paths.js";
import { runGit } from "./exec.js";

/** One row of `git worktree list --porcelain` (docs/M10-WORKBENCHES.md). */
export type GitWorktree = {
  /** Absolute, native form (`toNativeAbs` of what git prints: `C:\\x` on Windows, not `C:/x`). */
  path: string;
  /** Commit SHA; empty for a bare entry. */
  head: string;
  /** `refs/heads/x` → `x`; null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  /** git's own `worktree lock` (not the ReviewGate session lock). */
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
};

export type AddWorktreeOptions = {
  path: string;
  branch: string;
  /** Start point for a new branch (default HEAD); ignored when `existingBranch`. */
  from?: string | null;
  /** `git worktree add <path> <branch>` instead of `-b <branch>`. */
  existingBranch: boolean;
  /**
   * MARK: wave3 engine-flow — §36.12: `--no-track` (a new branch from a remote base such as `origin/develop` gets no
   * upstream: the first push / `pr_create` publishes it under its own name instead of tracking the base).
   */
  noTrack?: boolean;
};

export const DIRTY_TIMEOUT_MS = 2000;

/** Parses the `--porcelain` listing; the first entry is always the main worktree. */
export function parseWorktreeList(text: string): GitWorktree[] {
  const result: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  const flush = () => {
    if (cur) result.push(cur);
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = { path: toNativeAbs(value), head: "", branch: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "HEAD":
        cur.head = value;
        break;
      case "branch":
        cur.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        break;
      case "bare":
        cur.bare = true;
        break;
      case "detached":
        cur.detached = true;
        break;
      case "locked":
        cur.locked = true;
        cur.lockReason = value || null;
        break;
      case "prunable":
        cur.prunable = true;
        cur.prunableReason = value || null;
        break;
    }
  }
  flush();
  return result;
}

/** `git worktree list --porcelain` of the repository containing `root`. */
export async function listWorktrees(root: string): Promise<GitWorktree[]> {
  const out = await runGit(root, ["worktree", "list", "--porcelain"]);
  return parseWorktreeList(out.text);
}

/** `git worktree add [-b branch] <path> [<from> | <branch>]`; the parent directory is created. */
export async function addWorktree(root: string, opts: AddWorktreeOptions): Promise<void> {
  await mkdir(dirname(opts.path), { recursive: true });
  const args = ["worktree", "add"];
  if (opts.existingBranch) {
    args.push("--", opts.path, opts.branch);
  } else {
    if (opts.noTrack) args.push("--no-track");
    args.push("-b", opts.branch, "--", opts.path);
    if (opts.from) args.push(opts.from);
  }
  await runGit(root, args);
}

/** `git worktree remove [--force] <path>`. */
export async function removeWorktree(root: string, path: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", path);
  await runGit(root, args);
}

/** `git worktree prune`. */
export async function pruneWorktrees(root: string): Promise<void> {
  await runGit(root, ["worktree", "prune"]);
}

/** Absolute `git rev-parse --git-common-dir` (the main repository's `.git`, shared by every worktree). */
export async function commonDir(root: string): Promise<string> {
  const out = await runGit(root, ["rev-parse", "--git-common-dir"]);
  return absoluteGitPath(root, out.text.trim());
}

/** Absolute `git rev-parse --git-dir`; for a linked worktree this is `<common>/worktrees/<name>`. */
/** §39.4: the repository's common git directory (shared by all its worktrees), real path; null outside a repository. */
export async function gitCommonDir(dir: string): Promise<string | null> {
  try {
    const out = await runGit(dir, ["rev-parse", "--git-common-dir"], { allowFailure: true });
    if (out.status !== 0 || !out.text.trim()) return null;
    return realpathLenient(absoluteGitPath(dir, out.text.trim()));
  } catch {
    return null;
  }
}

/** §39.4: whether `a` and `b` are in the same repository (any of its worktrees); null when either is in none. */
export async function sameRepository(a: string, b: string): Promise<boolean | null> {
  const [x, y] = await Promise.all([gitCommonDir(a), gitCommonDir(b)]);
  return x === null || y === null ? null : samePath(x, y);
}

export async function gitDir(root: string): Promise<string> {
  const out = await runGit(root, ["rev-parse", "--git-dir"]);
  return absoluteGitPath(root, out.text.trim());
}

/**
 * Gitdir of one listed worktree without spawning git: the main worktree's is the common dir, a
 * linked worktree's is the `gitdir: …` line of its `.git` file. Null when it cannot be read (pruned).
 */
export async function linkedGitDir(wt: GitWorktree, common: string, isMain: boolean): Promise<string | null> {
  if (isMain) return common;
  try {
    const text = await readFile(join(wt.path, ".git"), "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!m) return null;
    return absoluteGitPath(wt.path, m[1]!);
  } catch {
    return null;
  }
}

/** `git status --porcelain` non-empty; null when git did not answer within `timeoutMs` (default 2 s) or failed. */
export async function worktreeDirty(path: string, timeoutMs: number = DIRTY_TIMEOUT_MS): Promise<boolean | null> {
  try {
    const out = await runGit(path, ["--no-optional-locks", "status", "--porcelain"], { allowFailure: true, timeoutMs });
    if (out.timedOut || out.status !== 0) return null;
    return out.text.trim().length > 0;
  } catch {
    return null;
  }
}

/** Exit status of `git check-ref-format --branch <name>` is 0. */
export async function isValidBranchName(root: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  const out = await runGit(root, ["check-ref-format", "--branch", name], { allowFailure: true }).catch(() => null);
  return out !== null && out.status === 0;
}

/** True when `refs/heads/<name>` exists. */
export async function branchExists(root: string, name: string): Promise<boolean> {
  const out = await runGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFailure: true });
  return out.status === 0;
}

/**
 * `~/.reviewgate/worktrees/<repo-name>-<hash8>/` (or `settings.worktreeRoot` instead of the default
 * base). `repo-name` is the checkout's folder name (`.git` stripped for bare repositories); the hash is
 * the first 8 hex chars of sha256(commonDir) so two clones with the same name never collide. The base
 * is symlink-resolved (as far as it exists) so it matches the paths `git worktree list` prints.
 */
export function managedWorktreeRoot(settings: Pick<Settings, "worktreeRoot">, repoCommonDir: string): string {
  const base = canonicalPath(settings.worktreeRoot?.trim() ? resolve(settings.worktreeRoot.trim()) : join(homedir(), ".reviewgate", "worktrees"));
  const name = repoName(repoCommonDir);
  // compareKey: one hash per repository however the path is spelled (POSIX: the path itself).
  const hash = createHash("sha256").update(compareKey(repoCommonDir)).digest("hex").slice(0, 8);
  return join(base, `${name}-${hash}`);
}

/** `realpath` of the deepest existing ancestor + the rest (macOS `/var` → `/private/var`; Windows 8.3 names expanded). */
export function canonicalPath(p: string): string {
  return realpathLenient(p);
}

/** Folder name of the checkout that owns `commonDir` (`/x/repo/.git` → `repo`, `/x/repo.git` → `repo`). */
export function repoName(repoCommonDir: string): string {
  const trimmed = repoCommonDir.replace(/[\\/]+$/, "");
  const last = basename(trimmed);
  const name = last === ".git" ? basename(dirname(trimmed)) : last.replace(/\.git$/, "");
  return slugify(name || "repo");
}

/** Filesystem-safe folder name for a branch: `feature/x y` → `feature-x-y`. */
export function slugify(branch: string): string {
  const s = branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return s.length > 0 ? s : "branch";
}

/** Native absolute form of a path git printed (absolute `C:/x`, MSYS `/c/x`, or relative to `base`). */
function absoluteGitPath(base: string, p: string): string {
  if (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return toNativeAbs(p);
  return toNativeAbs(resolve(base, p));
}
