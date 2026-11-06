import { lstatSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../git/exec.js";

/**
 * docs/PROTOCOL.md §33.4: what a command changed in a folder this window's review does not see (another worktree of the
 * repository, a nested repository) — that folder's `git status` before and after the call, each entry with its file's
 * size and times, compared. Read with the engine's own git (no fsmonitor, no hooks) and `--no-optional-locks` (it never
 * writes that worktree's index).
 */

/** Repo-relative path (POSIX, as git prints it) → its status and file signature. */
export type DirState = Map<string, string>;

/** At most this many files a notice lists (sorted); the rest are left out. */
export const MAX_LISTED_FILES = 100;
/** Entries whose files are looked at (size and times); past it a status change alone counts. */
const MAX_STATTED = 2000;
const STATUS_TIMEOUT_MS = 15_000;

/** `git status` of `dir` with each entry's file signature; null when git did not answer (not a repository, a timeout). */
export async function dirState(dir: string): Promise<DirState | null> {
  let out: Buffer;
  try {
    const r = await runGit(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFailure: true, timeoutMs: STATUS_TIMEOUT_MS });
    if (r.status !== 0 || r.timedOut) return null;
    out = r.stdout;
  } catch {
    return null;
  }
  const state: DirState = new Map();
  const entries = out.toString("utf8").split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    // A rename / copy is followed by its source path.
    if (xy[0] === "R" || xy[0] === "C") i++;
    state.set(path, state.size < MAX_STATTED ? `${xy}|${signature(join(dir, path))}` : xy);
  }
  return state;
}

function signature(file: string): string {
  try {
    const st = lstatSync(file);
    return `${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  } catch {
    return "-";
  }
}

/** The paths whose status or file changed between two states (appeared, left, or another status / content), sorted, capped. */
export function changedPaths(before: DirState, after: DirState): string[] {
  const out: string[] = [];
  for (const [path, sig] of after) if (before.get(path) !== sig) out.push(path);
  for (const path of before.keys()) if (!after.has(path)) out.push(path);
  return out.sort().slice(0, MAX_LISTED_FILES);
}
