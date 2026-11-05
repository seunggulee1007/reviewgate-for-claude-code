import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { copyIndex, type GitCheckpoint } from "./checkpoint.js";
import { nulSplit } from "./exec.js";
import { chunkPaths } from "./pathspecs.js";

/**
 * §53 `commit_series`: each commit is git's own `commit` on a temporary index that starts from HEAD — the worktree and the
 * user's index are never part of it — and afterwards the user's index entries of the committed paths follow HEAD.
 */

/** A file of a series commit given by content (a part of a file split by hunks). */
export type SeriesBlob = { path: string; mode: string; sha: string };

/** git's words when one commit of a series failed (a hook's refusal, an empty commit, …). */
export class SeriesCommitError extends Error {}

const LITERAL = { GIT_LITERAL_PATHSPECS: "1" };

/** The worktree file as `git add` stores it (clean filters / eol applied), written to the object database. */
export async function worktreeBlob(cp: GitCheckpoint, path: string): Promise<{ sha: string; content: Buffer }> {
  const sha = (await cp.git(["hash-object", "-w", `--path=${path}`, "--", cp.fsPath(path)])).text.trim();
  return { sha, content: (await cp.git(["cat-file", "blob", sha])).stdout };
}

/** `content` (already as the index stores it) as a blob in the object database. */
export async function writeBlob(cp: GitCheckpoint, content: Buffer): Promise<string> {
  return (await cp.git(["hash-object", "-w", "--stdin", "--no-filters"], { stdin: content })).text.trim();
}

/**
 * One commit: `git commit -q -F -` (the repository's hooks run, as for `commit`) with `GIT_INDEX_FILE` a temporary index in
 * the git directory — HEAD's tree (the real index's stat data reused), `whole` as the worktree holds them (added, updated or
 * removed), `blobs` as given. The temporary index is removed afterwards. Resolves with the new HEAD; a failed commit throws
 * `SeriesCommitError` with git's words.
 */
export async function commitOnHead(cp: GitCheckpoint, message: string, whole: readonly string[], blobs: readonly SeriesBlob[]): Promise<string> {
  const gitDir = (await cp.git(["rev-parse", "--absolute-git-dir"])).text.trim();
  const index = join(gitDir, `rg-series-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const real = (await cp.git(["rev-parse", "--git-path", "index"])).text.trim();
    await copyIndex(isAbsolute(real) ? real : join(cp.root, real), index);
    const head = (await cp.head()).sha;
    // `--reset`: HEAD's entries, the copy's stat data kept where they match (git does not rehash every file), no lock.
    await cp.git(head ? ["read-tree", "--reset", head] : ["read-tree", "--empty"], { env });
    if (whole.length > 0) await cp.git(["update-index", "--add", "--remove", "-z", "--stdin"], { env, stdin: Buffer.from(whole.join("\0") + "\0") });
    if (blobs.length > 0) {
      const info = blobs.map((b) => `${b.mode} ${b.sha}\t${b.path}`).join("\0") + "\0";
      await cp.git(["update-index", "-z", "--index-info"], { env, stdin: Buffer.from(info) });
    }
    const out = await cp.git(["commit", "-q", "-F", "-"], { env, stdin: Buffer.from(message, "utf8"), userHooks: true, allowFailure: true });
    if (out.status !== 0) throw new SeriesCommitError((out.stderr.trim() || out.text.trim() || `git commit exited with ${out.status}`).slice(0, 2000));
    return (await cp.git(["rev-parse", "HEAD"])).text.trim();
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
    await rm(index + ".lock", { force: true }).catch(() => undefined);
  }
}

/**
 * `--index-info` lines that set `paths` to their entries in `tree` (each path removed first, so one `tree` lacks is
 * removed). Only exact paths count: a directory of that name is not an entry.
 */
export async function entriesIn(cp: GitCheckpoint, tree: string, paths: readonly string[]): Promise<string[]> {
  const zero = "0".repeat((await cp.git(["rev-parse", tree])).text.trim().length);
  const want = new Set(paths);
  const lines = paths.map((p) => `0 ${zero}\t${p}`);
  for (const chunk of chunkPaths(paths)) {
    const out = await cp.git(["ls-tree", "-r", "-z", tree, "--", ...chunk], { env: LITERAL });
    for (const entry of nulSplit(out.stdout)) {
      const tab = entry.indexOf("\t");
      if (tab >= 0 && want.has(entry.slice(tab + 1))) lines.push(entry);
    }
  }
  return lines;
}

/** The user's index entries of `paths` set to HEAD's (as `commit --only` leaves them); every other entry stays as it is. */
export async function indexToHead(cp: GitCheckpoint, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const lines = await entriesIn(cp, "HEAD", paths);
  await cp.git(["update-index", "-z", "--index-info"], { stdin: Buffer.from(lines.join("\0") + "\0") });
}
