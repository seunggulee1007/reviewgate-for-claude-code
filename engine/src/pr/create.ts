import { exec } from "../util/exec.js";
import { GH_TIMEOUT_MS, GHError } from "./gh.js";
import type { ResolvedGH } from "./store.js";

export type RemoteRepo = { host: string; owner: string; repo: string };

export type CreatePROptions = {
  branch: string;
  base: string;
  title?: string;
  body?: string;
  draft?: boolean;
  // MARK: wave4c w4c-commit — §41.1
  assignees?: readonly string[];
  labels?: readonly string[];
  reviewers?: readonly string[];
  projects?: readonly string[];
};

/** §41.1: a `pr_create` metadata value is kept when it is a non-blank string of at most this many chars (at most 20 per flag). */
const PR_META_MAX = 200;

/** §41.1: the kept values of one metadata list (trimmed, blank / over-long / non-string dropped, ≤ 20). */
export function prMetaValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.length <= PR_META_MAX && !/[\r\n]/.test(v))
    .slice(0, 20);
}

/**
 * `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git`, `https://host/owner/repo[.git]`
 * → `{host, owner, repo}`; null for anything else.
 */
export function parseRemoteURL(url: string): RemoteRepo | null {
  const s = url.trim();
  if (!s) return null;
  let m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+):([^/:]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (m && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) return { host: m[1]!, owner: m[2]!, repo: m[3]! };
  m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([A-Za-z0-9._-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (m) return { host: m[1]!, owner: m[2]!, repo: m[3]! };
  return null;
}

/** Argv of `gh pr create` for `opts` (no shell; user text stays in argv values, never in flags). */
export function prCreateArgs(remote: RemoteRepo, opts: CreatePROptions): string[] {
  const args = ["pr", "create", "--repo", `${remote.host}/${remote.owner}/${remote.repo}`, "--head", opts.branch, "--base", opts.base];
  const title = opts.title?.trim() ?? "";
  if (title) {
    args.push("--title", title, "--body", opts.body ?? "");
  } else {
    args.push("--fill");
  }
  if (opts.draft) args.push("--draft");
  // MARK: wave4c w4c-commit — §41.1: `--flag=value`, so a value that starts with "-" is never read as a flag.
  for (const [flag, values] of [["assignee", opts.assignees], ["label", opts.labels], ["reviewer", opts.reviewers], ["project", opts.projects]] as const) {
    for (const v of prMetaValues(values)) args.push(`--${flag}=${v}`);
  }
  return args;
}

/** Runs `gh pr create …` and returns the PR URL printed on stdout. */
export async function createPR(gh: ResolvedGH, remote: RemoteRepo, opts: CreatePROptions): Promise<string> {
  const args = prCreateArgs(remote, opts);
  const out = await exec(gh.path, args, { env: gh.env, timeoutMs: GH_TIMEOUT_MS });
  if (out.status !== 0) throw new GHError(out.status ?? -1, out.stderr, args, out.timedOut);
  const lines = out.stdout.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const url = [...lines].reverse().find((l) => /^https?:\/\//.test(l));
  if (!url) throw new GHError(0, `gh pr create printed no URL: ${lines.join(" ")}`, args);
  return url;
}
