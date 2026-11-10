import { existsSync } from "node:fs";
import { join } from "node:path";
import { nulSplit, runGit } from "./exec.js";

/**
 * Release-2 review (docs/PROTOCOL.md §33.4, §32.2, §46): a `git status` the engine runs before a card counts a submodule by
 * its commit only (`--ignore-submodules=dirty`) — otherwise git would run a status inside it with that submodule's own
 * configuration. Where a submodule's own uncommitted changes matter, the engine looks into each one itself, as another
 * repository (its filter drivers off): these are the submodules to look into.
 */

/**
 * The checked-out submodules of `dir` under `pathspecs` (all when none): the gitlinks `git ls-files --stage` lists (mode
 * 160000; `ls-files` runs no filter) whose folder holds a `.git` — relative to `dir`, as git prints them. Null when git could
 * not tell.
 */
export async function checkedOutSubmodules(dir: string, pathspecs: readonly string[] = [], timeoutMs?: number): Promise<string[] | null> {
  const out = await runGit(dir, ["ls-files", "-z", "--stage", ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])], {
    allowFailure: true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }).catch(() => null);
  if (!out || out.status !== 0 || out.timedOut) return null;
  const subs: string[] = [];
  for (const entry of nulSplit(out.stdout)) {
    const m = /^160000 [0-9a-f]+ \d+\t(.+)$/s.exec(entry);
    if (m && existsSync(join(dir, m[1]!, ".git"))) subs.push(m[1]!);
  }
  return subs;
}
