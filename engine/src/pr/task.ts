import { exec } from "../util/exec.js";
import { GH_TIMEOUT_MS } from "./gh.js";
import type { ResolvedGH } from "./store.js";

/**
 * docs/PROTOCOL.md §63 (task start): `task_fetch {ref}` reads one GitHub issue with `gh issue view` for the start screen's
 * "Start from a task". Other trackers are never called by the app — the first prompt asks Claude to read the task through
 * an MCP server — so this is GitHub only, and the app stores no token: `gh` holds the login.
 */

/** Which issue a `ref` names: `repo` (`owner/name`) and `host` null = the project's `origin`. */
export type TaskRef = { host: string | null; repo: string | null; number: number };

/** A task's body is cut to this many characters (an issue body is ≤ 65 536 on GitHub; the prompt keeps it whole below). */
export const TASK_BODY_MAX = 65_536;

/**
 * `123`, `#123`, `owner/repo#123`, `https://<host>/<owner>/<repo>/issues/<n>` (query, fragment and a trailing slash
 * allowed; `www.` dropped) → the issue; null for anything else (a PR link too: that is not a task).
 */
export function parseTaskRef(raw: string): TaskRef | null {
  const s = raw.trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  let m = /^#?(\d{1,9})$/.exec(s);
  if (m) return issue(null, null, m[1]!);
  m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})$/.exec(s);
  if (m) return issue(null, m[1]!, m[2]!);
  m = /^https?:\/\/(?:www\.)?([A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d{1,9})\/?(?:[?#].*)?$/i.exec(s);
  if (m) return issue(m[1]!.toLowerCase(), `${m[2]}/${m[3]}`, m[4]!);
  return null;
}

function issue(host: string | null, repo: string | null, n: string): TaskRef | null {
  const number = Number(n);
  return Number.isInteger(number) && number > 0 ? { host, repo, number } : null;
}

/** What `task_fetch` replies with (the `task` event's fields). */
export type FetchedTask = { id: string; number: number; title: string; body: string; url: string; labels: string[] };

/** `gh issue view`'s argv (no shell): `--repo HOST/OWNER/REPO`, so gh's default host never decides. */
export function taskFetchArgs(host: string, repo: string, number: number): string[] {
  return ["issue", "view", String(number), "--repo", `${host}/${repo}`, "--json", "number,title,body,labels,url"];
}

/** Why a fetch failed, as a refusal code: `not_found`, else `task_fetch_failed:<gh's first line>`. */
export function taskFetchRefusal(stderr: string): string {
  const first = (stderr.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300);
  if (/could not resolve to an issue|not found|http 404|no issue|is a pull request/i.test(stderr)) return "not_found";
  return `task_fetch_failed:${first || "gh failed"}`;
}

/** Decodes `gh issue view --json number,title,body,labels,url`; null when it is not that shape. */
export function decodeTask(stdout: string): FetchedTask | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.number !== "number" || typeof o.title !== "string") return null;
  const labels = Array.isArray(o.labels)
    ? o.labels.map((l) => (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name : null)).filter((l): l is string => l !== null)
    : [];
  const body = typeof o.body === "string" ? o.body.slice(0, TASK_BODY_MAX) : "";
  return { id: String(o.number), number: o.number, title: o.title, body, url: typeof o.url === "string" ? o.url : "", labels };
}

/** Runs `gh issue view` and returns the task; throws `Error(<refusal code>)` (`not_found`, `task_fetch_failed:…`). */
export async function fetchTask(gh: ResolvedGH, host: string, repo: string, number: number): Promise<FetchedTask> {
  const args = taskFetchArgs(host, repo, number);
  const out = await exec(gh.path, args, { env: gh.env, timeoutMs: GH_TIMEOUT_MS });
  if (out.timedOut) throw new Error(`task_fetch_failed:gh timed out after ${GH_TIMEOUT_MS / 1000}s`);
  if (out.status !== 0) throw new Error(taskFetchRefusal(out.stderr));
  const task = decodeTask(out.stdout.toString("utf8"));
  if (!task) throw new Error("task_fetch_failed:gh printed no issue");
  return task;
}
