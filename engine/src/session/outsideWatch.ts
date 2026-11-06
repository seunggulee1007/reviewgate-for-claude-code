import { lstatSync } from "node:fs";
import { join } from "node:path";
import { nulSplit, runGit } from "../git/exec.js";

/**
 * docs/PROTOCOL.md §33.4: what a command changed in a folder this window's review does not see (another worktree of the
 * repository, a nested repository) — that folder's `git status` before and after the call, each entry with its file's
 * size and times, compared, and its HEAD: a commit made in the same call (`sed -i … && git commit -am x`) leaves the status
 * as clean as it was, so what the commits between the two HEADs changed counts too. Read with the engine's own git (no
 * fsmonitor, no hooks) and `--no-optional-locks` (it never writes that worktree's index).
 */

/** A folder's `git status` — repo-relative path (POSIX, as git prints it) → its status and file signature — and its HEAD. */
export type DirState = { files: Map<string, string>; head: string | null };

/** At most this many files a notice lists (sorted); the rest are left out. */
export const MAX_LISTED_FILES = 100;
/** Entries whose files are looked at (size and times); past it a status change alone counts. */
const MAX_STATTED = 2000;
const STATUS_TIMEOUT_MS = 15_000;

/** `git status` of `dir` with each entry's file signature, and HEAD; null when git did not answer (not a repository, a timeout). */
export async function dirState(dir: string): Promise<DirState | null> {
  let out: Buffer;
  let head: string | null = null;
  try {
    const [r, h] = await Promise.all([
      runGit(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true, timeoutMs: STATUS_TIMEOUT_MS }),
      runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true, timeoutMs: STATUS_TIMEOUT_MS }).catch(() => null),
    ]);
    if (r.status !== 0 || r.timedOut) return null;
    out = r.stdout;
    if (h && h.status === 0) head = h.text.trim() || null;
  } catch {
    return null;
  }
  const files: Map<string, string> = new Map();
  const entries = out.toString("utf8").split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    // A rename / copy is followed by its source path.
    if (xy[0] === "R" || xy[0] === "C") i++;
    files.set(path, files.size < MAX_STATTED ? `${xy}|${signature(join(dir, path))}` : xy);
  }
  return { files, head };
}

function signature(file: string): string {
  try {
    const st = lstatSync(file);
    return `${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * The paths of `dir` that changed between two states, sorted, capped: those whose status or file changed (appeared, left,
 * or another status / content) and, when HEAD moved (a commit, a checkout, a reset there), those the two commits differ in.
 */
export async function changedPaths(dir: string, before: DirState, after: DirState): Promise<string[]> {
  const out = new Set<string>();
  for (const [path, sig] of after.files) if (before.files.get(path) !== sig) out.add(path);
  for (const path of before.files.keys()) if (!after.files.has(path)) out.add(path);
  if (before.head && after.head && before.head !== after.head) {
    const r = await runGit(dir, ["diff", "--name-only", "--no-renames", "-z", before.head, after.head], { allowFailure: true, timeoutMs: STATUS_TIMEOUT_MS }).catch(() => null);
    if (r && r.status === 0 && !r.timedOut) for (const path of nulSplit(r.stdout)) out.add(path);
  }
  return [...out].sort().slice(0, MAX_LISTED_FILES);
}
