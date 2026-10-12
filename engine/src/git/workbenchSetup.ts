import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { Platform } from "../platform/index.js";
import { isInside, realpathLenient } from "../platform/paths.js";
import type { WorkbenchCopyItem, WorkbenchSetup } from "../protocol.js";
import { nulSplit, runGit } from "./exec.js";
import { slugify } from "./worktrees.js";

/**
 * wave3 engine-flow — §36.12 (market-02): a new workbench builds and tests right away. The local-only files of this
 * worktree (untracked or ignored, matched by `settings.workbenchSetup.copy` or `.worktreeinclude`) are copied into it and
 * the user's own setup command runs there. `.worktreeinclude` only ever decides what is copied — the command comes from
 * the user's settings alone, never from a file in the repository Claude could change.
 */

/** `workbench_preview.copy` holds at most this many entries (`totalBytes` counts all). */
export const PREVIEW_MAX_ENTRIES = 500;
/** The setup command is killed after this long (`exitCode: null`). */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** A step's `logTail`. */
export const LOG_TAIL_CHARS = 4000;
/** `logTail` updates of a running setup go out at most this often. */
export const SETUP_PROGRESS_MS = 1000;
/** `git fetch` of a base / PR head gives up after this long. */
export const FETCH_TIMEOUT_MS = 120_000;
export const WORKTREE_INCLUDE = ".worktreeinclude";

const DRIVE_OR_UNC = /^(?:[A-Za-z]:|[\\/]{2})/;
const hasDotDot = (p: string): boolean => p.split(/[\\/]/).includes("..");

/**
 * `settings.workbenchSetup.copy` → gitignore patterns anchored at the repository root (`mvnw` = `<root>/mvnw` only, `**`
 * spans folders, a folder copies what is in it); `..`, absolute and empty globs are dropped, `./` and `\` normalized.
 */
export function copyPatterns(globs: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (typeof g !== "string") continue;
    let p = g.trim();
    const negate = p.startsWith("!");
    if (negate) p = p.slice(1);
    if (!p || p.startsWith("/") || p.startsWith("\\") || DRIVE_OR_UNC.test(p) || hasDotDot(p)) continue;
    p = p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    if (!p) continue;
    out.push(`${negate ? "!" : ""}/${p}`);
  }
  return out;
}

/** `.worktreeinclude` (gitignore syntax, as Claude Code reads it): its patterns minus comments, blank lines and any line naming `..`. */
export function worktreeIncludePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/(?<!\\)\s+$/, ""))
    .filter((l) => l.length > 0 && !l.startsWith("#") && !hasDotDot(l) && !DRIVE_OR_UNC.test(l));
}

/** The last segment of a branch name, folder-safe (`feature/acme/4790` → `4790`). */
export function branchTail(branch: string): string {
  const parts = branch.split("/").filter((s) => s.length > 0);
  return slugify(parts[parts.length - 1] ?? branch);
}

/** §36.12 `location: "sibling"`: `<parent of the main worktree>/<repo>-<branch tail>`. */
export function siblingPath(mainWorktree: string, branch: string): string {
  const main = mainWorktree.replace(/[\\/]+$/, "");
  return join(dirname(main), `${basename(main)}-${branchTail(branch)}`);
}

/** Whether `rel` (git's repo-relative path) stays a plain path inside the worktree. */
function safeRelative(rel: string): boolean {
  if (!rel || rel.endsWith("/") || isAbsolute(rel) || DRIVE_OR_UNC.test(rel) || hasDotDot(rel)) return false;
  return !rel.split("/").some((s) => s.toLowerCase() === ".git");
}

/**
 * The files `workbench_create` would copy out of `root`: untracked or ignored regular files matched by the `copy` globs
 * or (unless `useWorktreeInclude: false`) `<root>/.worktreeinclude`, as git's own matcher sees them (`ls-files --others
 * --ignored`: a tracked file never, nothing inside `.git` or a nested repository), symlinks and anything else that is not
 * a regular file skipped; sorted by path, with their sizes.
 */
export async function filesToCopy(root: string, setup: WorkbenchSetup | undefined): Promise<WorkbenchCopyItem[]> {
  return matchingFiles(root, await copyPatternsFor(root, setup));
}

/** The patterns `filesToCopy` uses: `.worktreeinclude`'s (unless off) then the `copy` globs; empty = nothing to copy. */
export async function copyPatternsFor(root: string, setup: WorkbenchSetup | undefined): Promise<string[]> {
  const patterns: string[] = [];
  if (setup?.useWorktreeInclude !== false) {
    const text = await readFile(join(root, WORKTREE_INCLUDE), "utf8").catch(() => "");
    patterns.push(...worktreeIncludePatterns(text));
  }
  patterns.push(...copyPatterns(Array.isArray(setup?.copy) ? setup!.copy : []));
  return patterns;
}

/** The untracked or ignored regular files of `root` that `patterns` (gitignore syntax) match, sorted, with sizes. */
export async function matchingFiles(root: string, patterns: readonly string[]): Promise<WorkbenchCopyItem[]> {
  if (patterns.length === 0) return [];
  const out = await runGit(root, ["ls-files", "--others", "--ignored", "-z", ...patterns.map((p) => `--exclude=${p}`)], { timeoutMs: 60_000 });
  const items: WorkbenchCopyItem[] = [];
  for (const rel of nulSplit(out.stdout)) {
    if (!safeRelative(rel)) continue;
    const st = await lstat(join(root, rel)).catch(() => null);
    if (!st || !st.isFile()) continue;
    items.push({ path: rel, bytes: st.size });
  }
  return items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type CopyResult = { copied: number; bytes: number; skipped: string[]; failed: { path: string; error: string }[] };

/**
 * Copies `items` (repo-relative) from `src` to `dst`: parent folders created, the file mode kept, a destination that
 * already exists left alone (`skipped`), and nothing written outside `dst` (a folder of the new checkout that resolves
 * elsewhere — a symlink — is `skipped`).
 */
export async function copyFiles(src: string, dst: string, items: readonly WorkbenchCopyItem[]): Promise<CopyResult> {
  const root = realpathLenient(dst);
  const result: CopyResult = { copied: 0, bytes: 0, skipped: [], failed: [] };
  for (const item of items) {
    if (!safeRelative(item.path)) {
      result.skipped.push(item.path);
      continue;
    }
    const from = join(src, item.path);
    const to = join(dst, normalize(item.path));
    try {
      const st = await lstat(from);
      if (!st.isFile()) {
        result.skipped.push(item.path);
        continue;
      }
      // The parent as it resolves on disk must still be the new worktree or inside it (checked before and after mkdir).
      const inside = (p: string) => isInside(p, root);
      if (!inside(dirname(to))) {
        result.skipped.push(item.path);
        continue;
      }
      await mkdir(dirname(to), { recursive: true });
      if (!inside(dirname(to))) {
        result.skipped.push(item.path);
        continue;
      }
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          result.skipped.push(item.path);
          continue;
        }
        throw e;
      }
      await chmod(to, st.mode & 0o7777).catch(() => undefined);
      result.copied += 1;
      result.bytes += st.size;
    } catch (e) {
      result.failed.push({ path: item.path, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/** The copy step's log: what was copied, skipped or failed. */
export function copyLog(r: CopyResult, total: number): string {
  const lines = [`Copied ${r.copied} of ${total} file(s) (${r.bytes} bytes).`];
  if (r.skipped.length > 0) lines.push(`Skipped (already there, or outside the new worktree): ${r.skipped.join(", ")}`);
  for (const f of r.failed) lines.push(`Failed: ${f.path}: ${f.error}`);
  return tail(lines.join("\n") + "\n");
}

export function tail(text: string, max = LOG_TAIL_CHARS): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export type SetupRun = { exitCode: number | null; logTail: string };

/**
 * Runs the user's setup command in `cwd` through their login shell (`$SHELL -lc`, `/bin/sh` without one; Windows `cmd.exe
 * /d /s /c`) with stdout and stderr in one log. `onOutput` gets the log's tail as it grows (at most every `throttleMs`);
 * after `timeoutMs` the command and its children are killed (`exitCode: null`). Never throws.
 */
export function runSetupCommand(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  opts: { platform: Pick<Platform, "killTree" | "isWindows">; onOutput: (logTail: string) => void; timeoutMs?: number; throttleMs?: number; onStart?: (stop: () => void) => void },
): Promise<SetupRun> {
  const limit = opts.timeoutMs ?? SETUP_TIMEOUT_MS;
  const throttle = opts.throttleMs ?? SETUP_PROGRESS_MS;
  return new Promise<SetupRun>((resolve) => {
    let log = "";
    let lastSent = 0;
    let pending: NodeJS.Timeout | null = null;
    let timedOut = false;
    let settled = false;
    const append = (chunk: string) => {
      log = tail(log + chunk, LOG_TAIL_CHARS * 4);
      const now = Date.now();
      if (now - lastSent >= throttle) {
        lastSent = now;
        opts.onOutput(tail(log));
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          lastSent = Date.now();
          if (!settled) opts.onOutput(tail(log));
        }, throttle - (now - lastSent));
        pending.unref?.();
      }
    };
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
    const shell = opts.platform.isWindows ? null : env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : "/bin/sh";
    let child;
    try {
      child = opts.platform.isWindows
        ? spawn(env.ComSpec || env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { cwd, env: childEnv, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(shell!, ["-lc", command], { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exitCode: null, logTail: tail(`[ReviewGate] the setup command could not start: ${e instanceof Error ? e.message : String(e)}\n`) });
      return;
    }
    const stop = () => {
      if (child.pid !== undefined) void opts.platform.killTree(child.pid);
    };
    opts.onStart?.(stop);
    const timer = setTimeout(() => {
      timedOut = true;
      append(`\n[ReviewGate] setup timed out after ${Math.round(limit / 1000)} s — stopped.\n`);
      stop();
    }, limit);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending) clearTimeout(pending);
      resolve({ exitCode: timedOut ? null : code, logTail: tail(log) });
    };
    child.on("error", (e) => {
      append(`\n[ReviewGate] ${e.message}\n`);
      // The shell never started (no `close` follows for sure).
      if (child.pid === undefined) finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** `git remote` names of the repository. */
export async function remoteNames(root: string): Promise<string[]> {
  const out = await runGit(root, ["remote"], { allowFailure: true }).catch(() => null);
  return out && out.status === 0 ? out.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0) : [];
}

/** `origin/develop` → `{remote: "origin", branch: "develop"}` when `ref` starts with a remote's name (the longest wins); else null. */
export function splitRemoteRef(ref: string, remotes: readonly string[]): { remote: string; branch: string } | null {
  const hit = [...remotes].sort((a, b) => b.length - a.length).find((r) => ref.startsWith(`${r}/`) && ref.length > r.length + 1);
  return hit ? { remote: hit, branch: ref.slice(hit.length + 1) } : null;
}

export type FetchRun = { ok: boolean; exitCode: number | null; logTail: string };

/** `git fetch --no-tags <remote> <refspec>` without a credential prompt, bounded by `FETCH_TIMEOUT_MS`. Never throws. */
export async function fetchRef(root: string, remote: string, refspec: string): Promise<FetchRun> {
  try {
    const out = await runGit(root, ["fetch", "--no-tags", "--", remote, refspec], { allowFailure: true, timeoutMs: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" } });
    const text = `${out.text}${out.stderr}`.trim();
    const exitCode = out.timedOut ? null : out.status;
    return { ok: exitCode === 0, exitCode, logTail: tail(text ? text + "\n" : out.timedOut ? "git fetch timed out\n" : "") };
  } catch (e) {
    return { ok: false, exitCode: null, logTail: tail(`${e instanceof Error ? e.message : String(e)}\n`) };
  }
}

/** `git rev-parse --verify --quiet <ref>` succeeds. */
export async function refExists(root: string, ref: string): Promise<boolean> {
  const out = await runGit(root, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }).catch(() => null);
  return out !== null && out.status === 0;
}

/** The first non-empty line of a log (`fetch_failed:<git's first line>`). */
export function firstLogLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "git fetch failed";
  return line.slice(0, 300);
}
