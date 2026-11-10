import type { ChangedFile } from "./checkpoint.js";
import { runGit } from "./exec.js";
import { chunkPaths, pathspecArgs } from "./pathspecs.js"; // MARK: wave4 w4-install

/** `user.name` / `user.email` as git resolves them for `root` (null when unset). */
export type GitIdentity = { name: string | null; email: string | null };

export async function gitIdentity(root: string): Promise<GitIdentity> {
  const read = async (key: string): Promise<string | null> => {
    const out = await runGit(root, ["config", "--get", key], { allowFailure: true }).catch(() => null);
    const value = out && out.status === 0 ? out.text.trim() : "";
    return value || null;
  };
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return { name, email };
}

/**
 * `git add -A -- <paths>`: stages additions, modifications and deletions of `paths`; for a rename
 * (from `changedFiles`) the old path is staged too so the deletion side lands in the same commit.
 * Returns the pathspecs that were staged.
 */
export async function stagePaths(root: string, paths: string[], changedFiles: readonly Pick<ChangedFile, "path" | "oldPath">[]): Promise<string[]> {
  const specs: string[] = [];
  for (const path of paths) {
    if (!specs.includes(path)) specs.push(path);
    const old = changedFiles.find((f) => f.path === path)?.oldPath ?? null;
    if (old !== null && old !== path && !specs.includes(old)) specs.push(old);
  }
  // MARK: wave4 w4-install: in chunks — hundreds of paths overflow a Windows command line.
  for (const chunk of chunkPaths(specs)) await runGit(root, ["add", "-A", "--", ...chunk]);
  return specs;
}

/**
 * `git commit -F -` with `message` on stdin (multi-line safe; the repository's hooks run); resolves with the new HEAD sha.
 * With `only` (the pathspecs `stagePaths` returned) it is `git commit --only -- <only>`: the commit holds just those paths'
 * worktree state on top of HEAD, and whatever else the user had staged stays staged (and out of the commit).
 */
export async function commit(root: string, message: string, only: string[] | null = null): Promise<string> {
  // MARK: wave4 w4-install: a long `only` list goes through a pathspec file (stdin carries the message).
  const spec = only && only.length > 0 ? await pathspecArgs(only) : null;
  const args = spec ? ["commit", "-q", "--only", "-F", "-", ...spec.args] : ["commit", "-q", "-F", "-"];
  try {
    await runGit(root, args, { stdin: Buffer.from(message, "utf8"), userHooks: true });
  } finally {
    await spec?.cleanup();
  }
  return (await runGit(root, ["rev-parse", "HEAD"])).text.trim();
}

/**
 * `git push` (or `git push -u origin <branch>` when the branch has no upstream). Throws an Error
 * whose message is the refusal code: `no_remote`, `detached_head`, `push_failed:<first stderr line>`.
 */
export async function push(root: string, branch: string | null): Promise<void> {
  const remote = await runGit(root, ["remote", "get-url", "origin"], { allowFailure: true });
  if (remote.status !== 0 || !remote.text.trim()) throw new Error("no_remote");
  const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFailure: true });
  let args: string[];
  if (upstream.status === 0) args = ["push"];
  else if (branch) args = ["push", "-u", "origin", branch];
  else throw new Error("detached_head");
  const out = await runGit(root, args, { allowFailure: true, userHooks: true });
  if (out.status !== 0) throw new Error(`push_failed:${firstLine(out.stderr)}`);
}

function firstLine(stderr: string): string {
  return stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "unknown error";
}
