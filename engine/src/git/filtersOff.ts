import { nulSplit, runGit } from "./exec.js";

/**
 * docs/PROTOCOL.md §33.4 / §46: a `git status` the engine runs in a folder whose repository is not this window's — a
 * nested clone or submodule, a folder outside the project, another worktree — before the user approved anything must run
 * nothing that repository's configuration names. `runGit` already turns fsmonitor and hooks off for every call; a filter
 * driver is the rest: `git status` hands a file whose stat data changed to its clean filter (`filter.<driver>.clean`, or
 * the long-running `process`) to compare it with the index.
 *
 * The `-c` options that turn off every filter driver the folder's configuration defines (system, global, the repository's
 * own, includes): `clean=` / `smudge=` / `process=` (git runs no command for an empty one) and `required=false` (a required
 * driver with no command would fail the status). An attribute naming a driver that has no configuration runs nothing
 * anyway. Null when a driver's name cannot be written as a `-c` key (it holds `=`): the caller does not run git there.
 * Without filters a file a filter would have cleaned (Git LFS) may read as changed: a status only ever errs on the side
 * of "changed" this way.
 */
export async function filtersOffArgs(dir: string, timeoutMs?: number): Promise<string[] | null> {
  const out = await runGit(dir, ["config", "-z", "--get-regexp", "^filter\\."], { allowFailure: true, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  // 1: no such key — no driver at all; anything else (no folder, a broken config) leaves git unable to tell.
  if (out.status === 1 && out.stdout.length === 0) return [];
  if (out.status !== 0) return null;
  const names = new Set<string>();
  for (const entry of nulSplit(out.stdout)) {
    const key = entry.split("\n", 1)[0]!;
    const last = key.lastIndexOf(".");
    if (!key.startsWith("filter.") || last <= "filter".length) continue;
    names.add(key.slice("filter.".length, last));
  }
  const args: string[] = [];
  for (const name of names) {
    if (name.includes("=") || /[\r\n]/.test(name)) return null;
    for (const v of ["clean=", "smudge=", "process=", "required=false"]) args.push("-c", `filter.${name}.${v}`);
  }
  return args;
}
