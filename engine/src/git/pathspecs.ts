// MARK: wave4 w4-install — a Windows command line stops at 32 767 characters (CreateProcess), so a commit or an overlay
// of hundreds of files must not put every path on it (3rd-round check-engine report). `git add` runs in chunks, `git
// commit --only` reads its pathspecs from a file, `update-index` reads paths from stdin.
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Paths per command line, well under the Windows limit (the rest of the git command line included). */
export const MAX_PATHSPEC_CHARS = 8000;

/** What `paths` add to a command line (each quoted, space-separated). */
export function pathsLength(paths: readonly string[]): number {
  return paths.reduce((n, p) => n + p.length + 3, 0);
}

/** `paths` in order, in chunks of at most `maxChars`; a single longer path is a chunk of its own. */
export function chunkPaths(paths: readonly string[], maxChars: number = MAX_PATHSPEC_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paths) {
    const len = p.length + 3;
    if (current.length > 0 && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * `-- <paths>` when they fit on a command line, else `--pathspec-from-file=<tmp> --pathspec-file-nul` (git ≥ 2.25) —
 * call `cleanup` when git is done.
 */
export async function pathspecArgs(paths: readonly string[]): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  if (pathsLength(paths) <= MAX_PATHSPEC_CHARS) return { args: ["--", ...paths], cleanup: async () => undefined };
  const file = join(tmpdir(), `rg-pathspec-${randomUUID()}`);
  await writeFile(file, paths.join("\0") + "\0");
  return { args: [`--pathspec-from-file=${file}`, "--pathspec-file-nul"], cleanup: () => rm(file, { force: true }).catch(() => undefined) };
}
