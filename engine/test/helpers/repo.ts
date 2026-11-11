import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/** Runs `git -C dir args` directly (the test oracle, independent of the engine's `runGit`). */
export function sh(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
}

export function write(dir: string, rel: string, content: string | Buffer): void {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function read(dir: string, rel: string): string | null {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

export function fileExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function makeTempDir(prefix = "rg-git"): string {
  const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  // Windows runners' %TEMP% is an 8.3 short path (C:\Users\RUNNER~1\…) while git and the engine report the long
  // one; expand it so paths compare equal. Elsewhere the path is kept as is (macOS tests rely on /var vs /private/var).
  return process.platform === "win32" ? realpathSync.native(dir) : dir;
}

/**
 * The absolute path `p` as a Bash command written on this host spells it. On Windows the Bash tool runs Git Bash, where an
 * unquoted backslash escapes the next character — `cd C:\Users\me\wt` goes to `C:Usersmewt`, and the engine reads it so
 * (docs/PROTOCOL.md §20) — so the folder is written as Git Bash's own `pwd` prints it: `/c/Users/me/wt`. Elsewhere `p`.
 */
export function bashPath(p: string): string {
  if (process.platform !== "win32") return p;
  const drive = /^([A-Za-z]):[\\/]*(.*)$/s.exec(p);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

/** Windows: a just-exited child (git, the fake CLI) can still hold a handle for a moment → EPERM / EBUSY; retry. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * `renameSync` of a folder a git process may still have open (Windows refuses it with EPERM / EBUSY / EACCES while the
 * engine's own git work after a command — snapshot pins, the persisted review — finishes): retried for up to 5 s; a leftover folder at `to` is removed first.
 */
export async function renameWhenFree(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY" && code !== "EEXIST")) throw e;
      // A folder cannot be renamed onto a non-empty one (ENOTEMPTY / EEXIST; EPERM on Windows): the engine's bookkeeping may
      // have made a fresh `.git` while the real one was hidden, so what is in the way is cleared and the rename retried.
      if (existsSync(to)) removeDir(to);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Mirrors `GitCheckpointTests.makeRepo`: README.md + other.txt + tomove.txt committed, untracked.txt uncommitted. */
export function makeRepo(): string {
  const dir = makeTempDir();
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "README.md", "line1\nline2\nline3\n");
  write(dir, "other.txt", "other\n");
  write(dir, "tomove.txt", "move me\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  write(dir, "untracked.txt", "original untracked\n");
  return dir;
}

/** Mirrors `GitBranchesTests.makeRepo`: `main` with a.txt committed. */
export function makeBranchRepo(prefix = "rg-branch"): string {
  const dir = makeTempDir(prefix);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "core.autocrlf", "false");
  write(dir, "a.txt", "a\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

export function indexFingerprint(dir: string): { mtimeMs: number; bytes: Buffer } {
  const p = join(dir, ".git", "index");
  return { mtimeMs: statSync(p).mtimeMs, bytes: readFileSync(p) };
}

export function mode(p: string): number {
  return statSync(p).mode & 0o777;
}
