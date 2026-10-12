import { devNull } from "node:os";
import { exec, type ExecResult } from "../util/exec.js";

export type GitOptions = {
  /** Extra variables merged over the process env (e.g. `GIT_INDEX_FILE`). */
  env?: Record<string, string | undefined>;
  stdin?: Buffer;
  /** When true a non-zero exit resolves instead of throwing `GitCommandError`. */
  allowFailure?: boolean;
  timeoutMs?: number;
  /**
   * Run the repository's hooks (`pre-commit`, `commit-msg`, `pre-push`, …). Only the explicit,
   * user-initiated commit / push set this; see `runGit`.
   */
  userHooks?: boolean;
};

export type GitResult = ExecResult & { readonly text: string };

export class NotARepositoryError extends Error {
  constructor(public readonly directory: string) {
    super("Not a git repository");
    this.name = "NotARepositoryError";
  }
}

export class GitCommandError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly stderr: string,
    public readonly status: number | null,
  ) {
    const detail = stderr.trim();
    super(detail ? `${cmd} failed (exit ${status}): ${detail}` : `${cmd} failed (exit ${status})`);
    this.name = "GitCommandError";
  }
}

/** Absolute path of the `git` executable used by `runGit`; set once from the toolchain. */
let gitPath = "git";
export function setGitPath(path: string): void {
  gitPath = path;
}
export function getGitPath(): string {
  return gitPath;
}

let isWindows = process.platform === "win32";
/** Test seam / Electron: decide whether `core.longpaths=true` is injected. */
export function setGitIsWindows(value: boolean): void {
  isWindows = value;
}

/**
 * `git -C root -c core.quotepath=off -c core.fsmonitor= [-c core.hooksPath=<null device>] [...] args`
 * with `LC_ALL=C`, stdout as a Buffer. `root` is expected in git's forward-slash form (as printed by
 * `rev-parse --show-toplevel`).
 *
 * Repository config is not trusted to run programs on the app's behalf: an fsmonitor command or a
 * hook planted in `.git/` (by a tool, a script or a cloned repo) would otherwise run on every snapshot
 * the app takes. So fsmonitor is off for every call (an empty value is "off" for both the boolean form
 * of git ≥ 2.36 and the hook-path form before it), and hooks are off (`core.hooksPath` points at the
 * null device, which can never contain a hook) for every internal call — snapshots, plumbing, revert,
 * worktree management. Only the explicit commit / push the user asked for (`userHooks: true`) keeps
 * the repository's hooks, exactly as their own `git commit` / `git push` would run them; edit tools
 * can never write inside `.git/` (hooks.ts `isGitInternalPath`), so those hooks are the user's.
 */
export async function runGit(root: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const prefix = ["-C", root, "-c", "core.quotepath=off", "-c", "core.fsmonitor="];
  if (!opts.userHooks) prefix.push("-c", `core.hooksPath=${devNull}`);
  if (isWindows) prefix.push("-c", "core.longpaths=true");
  const out = await exec(gitPath, [...prefix, ...args], {
    cwd: root,
    env: { LC_ALL: "C", ...opts.env },
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
  });
  if (out.status !== 0 && !opts.allowFailure) {
    throw new GitCommandError("git " + args.join(" "), out.stderr, out.status);
  }
  return Object.assign(out, { text: out.stdout.toString("utf8") });
}

/** Splits `-z` output into UTF-8 fields, dropping the empty field after the trailing NUL. */
export function nulSplit(data: Buffer): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      fields.push(data.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  fields.push(data.subarray(start).toString("utf8"));
  if (fields[fields.length - 1] === "") fields.pop();
  return fields;
}
