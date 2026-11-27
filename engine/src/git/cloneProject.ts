import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseRemoteURL } from "../pr/create.js";
import { remoteURLs, PROJECT_MATCH_MAX_PATHS } from "./newProject.js";

/**
 * docs/PROTOCOL.md §74 (clone from git): what the user pasted read as a repository to clone — an https / ssh URL, the scp
 * form `git@host:owner/repo.git`, GitHub's `owner/repo` shorthand, a local path — the recent projects that already have it
 * as a remote, and the clone itself: plain `git clone --progress` in a child process with the user's own credentials
 * (their credential helper, their SSH agent), its progress read from git's stderr, a cancel that kills it and removes the
 * folder it was cloning into. Nothing here ever puts a credential into a URL, a log line or a reply.
 */

/** A repository to clone, as `parseCloneSource` reads it. */
export type CloneSource = {
  /** What `git clone` gets: the URL as pasted (credential-free), a shorthand expanded, a browser link cut to the repository. */
  url: string;
  /** `owner/repo` when the URL names one, else the repository's folder name. */
  repo: string;
  /** The host (null: a local path). */
  host: string | null;
  /** The branch a browser link (`…/tree/<branch>`) or a pasted `git clone -b <branch>` names; null: the default branch. */
  branch: string | null;
  /** The folder name the clone gets by default (the repository's name). */
  name: string;
};

export type CloneSourceRefusal = { code: "bad_url" | "url_has_credentials"; detail: string };

const SCHEMES = new Set(["https", "http", "ssh", "git", "file", "git+ssh", "ssh+git"]);
const SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/;
const SCP = /^(?:([^@/\s:]+)@)?([A-Za-z0-9][A-Za-z0-9._-]*):(?!\/\/)(.+)$/;
/** A user part that is a token, not a name: GitHub / GitLab token prefixes, or a long opaque string. */
const TOKEN_USER = /^(gh[pousr]_|github_pat_|glpat-|x-access-token$|oauth2$)|^[A-Za-z0-9_\-]{30,}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** `https://user:secret@host/…` → `https://***@host/…`: for any text that may hold a URL (git's messages). */
export function redactCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/\s]+@/g, "$1***@");
}

/**
 * A folder name for the clone from the repository's name or the one the user typed: case kept (unlike §69's rule), every
 * character a folder name cannot hold (`/ \ : * ? " < > |`, control characters, spaces) a `-`, no leading dot or dash, at
 * most 100 characters; a Windows device name gets `-repo`; nothing left → `repo`.
 */
export function cloneFolderName(raw: string): string {
  let name = raw
    .normalize("NFC")
    .trim()
    .replace(/[\\/:*?"<>|\s\p{Cc}]+/gu, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.\s]+$/, "");
  name = [...name].slice(0, 100).join("").replace(/[.-]+$/, "");
  if (!name) return "repo";
  return WINDOWS_RESERVED.test(name) ? `${name}-repo` : name;
}

/** `git clone [-b <branch>] [--] <url> [<dir>]` pasted whole: the URL and the branch, the rest dropped. */
function fromCloneCommand(text: string): { url: string; branch: string | null } | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words[0] !== "git" || words[1] !== "clone") return null;
  let branch: string | null = null;
  let url: string | null = null;
  for (let i = 2; i < words.length; i += 1) {
    const w = words[i]!;
    if (w === "-b" || w === "--branch") branch = words[++i] ?? null;
    else if (w.startsWith("--branch=")) branch = w.slice("--branch=".length) || null;
    else if (w === "--") continue;
    else if (w.startsWith("-")) continue;
    else if (url === null) url = w;
  }
  return url === null ? null : { url, branch };
}

/**
 * Reads what the user pasted as a repository (docs/PROTOCOL.md §74.1). Refused `url_has_credentials` when it carries a
 * password or a token (git keeps the URL in `.git/config`; the user's credential helper or SSH key signs in instead), and
 * `bad_url` for anything else that is not a repository: text with spaces, an option (`-…`), a transport helper (`ext::`).
 */
export function parseCloneSource(input: string): CloneSource | CloneSourceRefusal {
  let text = input.trim().replace(/^<(.*)>$/, "$1").replace(/^["'](.*)["']$/, "$1").trim();
  let branch: string | null = null;
  const command = fromCloneCommand(text);
  if (command) ({ url: text, branch } = command);
  if (!text) return { code: "bad_url", detail: "empty" };
  if (/\s/.test(text)) return { code: "bad_url", detail: "spaces" };
  if (text.startsWith("-")) return { code: "bad_url", detail: "option" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(text)) return { code: "bad_url", detail: "transport" };

  // A local path: an absolute one (a drive letter, a UNC share), as `git clone` takes it.
  if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) {
    const name = text.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    return { url: text, repo: stripGit(name) || "repo", host: null, branch, name: cloneFolderName(stripGit(name)) };
  }

  // A browser link or a URL without its scheme (`github.com/acme/widgets`).
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) && !SCP.test(text) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\/[^/]+\/[^/]+/.test(text)) text = `https://${text}`;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!SCHEMES.has(scheme)) return { code: "bad_url", detail: `scheme ${scheme}` };
    if (scheme === "file") {
      const path = text.slice("file://".length).replace(/\/+$/, "");
      const name = stripGit(path.split("/").pop() ?? "");
      return { url: text, repo: name || "repo", host: null, branch, name: cloneFolderName(name) };
    }
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return { code: "bad_url", detail: "unreadable" };
    }
    if (!u.hostname) return { code: "bad_url", detail: "no host" };
    if (u.password || (u.username && (scheme === "https" || scheme === "http") && TOKEN_USER.test(decodeURIComponent(u.username)))) {
      return { code: "url_has_credentials", detail: "" };
    }
    let segs = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (segs.length === 0) return { code: "bad_url", detail: "no repository" };
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    // GitHub's own links (a file, a branch, an issue): the repository is the first two parts; `tree/<branch>` names a branch.
    if (host === "github.com" && segs.length >= 2) {
      if (segs[2] === "tree" && segs.length > 3 && branch === null) branch = segs.slice(3).join("/");
      segs = segs.slice(0, 2);
      text = `https://github.com/${segs[0]}/${stripGit(segs[1]!)}.git`;
    } else {
      u.hash = "";
      u.search = "";
      text = u.toString().replace(/\/+$/, "");
    }
    const name = stripGit(segs[segs.length - 1]!);
    const remote = parseRemoteURL(text);
    return { url: text, repo: remote ? `${remote.owner}/${remote.repo}` : name, host, branch, name: cloneFolderName(name) };
  }

  // The scp form `[user@]host:path` (`git@github.com:acme/widgets.git`).
  const scp = SCP.exec(text);
  if (scp) {
    const path = scp[3]!.replace(/\/+$/, "");
    const name = stripGit(path.split("/").pop() ?? "");
    if (!name) return { code: "bad_url", detail: "no repository" };
    const remote = parseRemoteURL(text);
    return { url: text, repo: remote ? `${remote.owner}/${remote.repo}` : name, host: scp[2]!.toLowerCase(), branch, name: cloneFolderName(name) };
  }

  // GitHub's shorthand.
  if (SHORTHAND.test(text)) {
    const [owner, repo] = text.split("/") as [string, string];
    const bare = stripGit(repo);
    if (!bare || owner === "." || owner === "..") return { code: "bad_url", detail: "no repository" };
    return { url: `https://github.com/${owner}/${bare}.git`, repo: `${owner}/${bare}`, host: "github.com", branch, name: cloneFolderName(bare) };
  }
  return { code: "bad_url", detail: "not a repository" };
}

function stripGit(name: string): string {
  return name.replace(/\.git$/i, "");
}

/**
 * The recent projects (in the client's order, at most 30, relative paths skipped) with a remote that is `source`'s
 * repository: the same `owner/repo` (any case) on the same host — the folder the user already has. A local source matches
 * a remote that is the same path. Read-only: `git remote -v` (§69.3's read).
 */
export async function clonedAlready(source: CloneSource, paths: readonly string[]): Promise<string[]> {
  const candidates = [...new Set(paths.filter((p) => typeof p === "string" && isAbsolute(p)))].slice(0, PROJECT_MATCH_MAX_PATHS);
  const target = parseRemoteURL(source.url);
  const lc = (s: string) => s.toLowerCase();
  const norm = (u: string) => lc(stripGit(u.replace(/^file:\/\//, "").replace(/[\\/]+$/, "")));
  const hits = await Promise.all(candidates.map(async (path) => {
    const urls = await remoteURLs(path);
    return urls.some((u) => {
      if (!target) return norm(u) === norm(source.url);
      const r = parseRemoteURL(u);
      return r !== null && lc(r.owner) === lc(target.owner) && lc(r.repo) === lc(target.repo) && lc(r.host).replace(/^www\./, "") === lc(target.host).replace(/^www\./, "");
    });
  }));
  return candidates.filter((_, i) => hits[i]);
}

// ---------------------------------------------------------------- the clone

/** The steps git reports, in order. */
export type ClonePhase = "connecting" | "counting" | "compressing" | "receiving" | "resolving" | "checkout";

export type CloneProgress = {
  phase: ClonePhase;
  /** The whole clone, 0–100 (the steps weighted: receiving is most of it). */
  percent: number;
  /** The step's own percent (null: git gave none yet). */
  phasePercent: number | null;
  /** `1.20 MiB | 512.00 KiB/s` while receiving; null otherwise. */
  detail: string | null;
};

const PHASE_SPAN: Record<ClonePhase, [number, number]> = {
  connecting: [0, 0],
  counting: [0, 3],
  compressing: [3, 6],
  receiving: [6, 88],
  resolving: [88, 96],
  checkout: [96, 100],
};

/** One progress line of `git clone --progress` (`remote: ` stripped); null when it is no step. */
export function parseCloneProgressLine(line: string): CloneProgress | null {
  const s = line.replace(/^remote:\s*/, "").trim();
  const m = /^(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d{1,3})%(?:\s+\(\d+\/\d+\))?(?:,\s*(.*?))?(?:,\s*done\.?)?$/.exec(s);
  if (!m) {
    // "Enumerating objects: 12, done." has no percent: counting has begun.
    return /^(Enumerating|Counting) objects:/.test(s) ? { phase: "counting", percent: 0, phasePercent: null, detail: null } : null;
  }
  const phase: ClonePhase = m[1]!.startsWith("Compressing") ? "compressing"
    : m[1]!.startsWith("Receiving") ? "receiving"
    : m[1]!.startsWith("Resolving") ? "resolving"
    : m[1]!.startsWith("Updating") || m[1]!.startsWith("Checking") ? "checkout"
    : "counting";
  const phasePercent = Math.min(100, Number(m[2]));
  const [from, to] = PHASE_SPAN[phase];
  const detail = phase === "receiving" && m[3] && /\d/.test(m[3]) ? m[3].replace(/,\s*done\.?$/, "").trim() || null : null;
  return { phase, percent: Math.round(from + ((to - from) * phasePercent) / 100), phasePercent, detail };
}

/** The refusal codes of a clone (docs/PROTOCOL.md §74.3). */
export type CloneFailure = "clone_auth_failed" | "clone_not_found" | "clone_branch_not_found" | "clone_network" | "clone_folder_exists" | "clone_timeout" | "clone_cancelled" | "git_missing" | "clone_failed";

/** Which of §74.3's reasons git's stderr says (`LC_ALL=C`, so it is git's English). */
export function classifyCloneError(stderr: string): CloneFailure {
  const s = stderr;
  if (/Remote branch .* not found|couldn't find remote ref/i.test(s)) return "clone_branch_not_found";
  if (/already exists and is not an empty directory/i.test(s)) return "clone_folder_exists";
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Permission denied, please try again|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]\b|Host key verification failed|denied to |access denied|Too many authentication failures/i.test(s)) return "clone_auth_failed";
  if (/Repository not found|repository '[^']*' not found|does not appear to be a git repository|returned error: 404\b|project you were looking for could not be found|does not exist|Not Found/i.test(s)) return "clone_not_found";
  if (/Could not resolve host|Could not resolve hostname|nodename nor servname|Name or service not known|Temporary failure in name resolution|Failed to connect|Connection timed out|Operation timed out|Connection refused|Network is unreachable|No route to host|Connection reset|Connection closed|early EOF|unexpected disconnect|SSL|TLS|gnutls|schannel/i.test(s)) return "clone_network";
  return "clone_failed";
}

/** git's first line that says why (progress, "Cloning into …" and hints left out), credentials redacted, ≤ 300 chars. */
export function cloneErrorLine(stderr: string): string {
  const lines = stderr.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^Cloning into/.test(l) && !/^hint:/.test(l) && parseCloneProgressLine(l) === null && !/^remote:\s*$/.test(l));
  const why = lines.find((l) => /^(fatal|error|ERROR|remote: (ERROR|fatal))/i.test(l)) ?? lines[lines.length - 1] ?? "";
  return redactCredentials(why.replace(/^(fatal|error):\s*/i, "")).slice(0, 300);
}

export class CloneError extends Error {
  constructor(public readonly code: CloneFailure, detail: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CloneError";
  }
}

/** A clone with no output for this long is taken as stuck (a network that stopped answering); progress resets it. */
export const CLONE_IDLE_TIMEOUT_MS = 120_000;
/** At most one progress event per this many ms (a phase change always goes out). */
const PROGRESS_EVERY_MS = 150;

export type CloneRun = {
  /** Resolves when the clone is done; rejects with a `CloneError` (the folder removed). */
  done: Promise<void>;
  /** Kills git and removes the folder; `done` rejects `clone_cancelled`. */
  cancel(): void;
};

export type CloneOptions = {
  git: string;
  source: Pick<CloneSource, "url">;
  branch: string | null;
  /** An empty folder made for it (`createProjectFolder`): git clones into it; removed on any failure. */
  path: string;
  onProgress: (p: CloneProgress) => void;
  idleTimeoutMs?: number;
  /** Kills git and the helpers it started (`git-remote-https`, `ssh`): the platform's tree kill. */
  killTree?: (pid: number) => Promise<void>;
};

/**
 * `git clone --progress [--branch <b>] -- <url> <path>` with the user's own git: their credential helper and SSH agent sign
 * in; no prompt can wait for an answer (`GIT_TERMINAL_PROMPT=0`, stdin closed), so a missing sign-in fails at once as
 * `clone_auth_failed`. Progress is read from stderr (`\r`-separated). No output for `idleTimeoutMs` kills it as
 * `clone_timeout`. Any failure, and a cancel, removes `path`.
 */
export function startClone(opts: CloneOptions): CloneRun {
  const args = ["-c", "core.fsmonitor=", "clone", "--progress", ...(opts.branch ? ["--branch", opts.branch] : []), "--", opts.source.url, opts.path];
  let cancelled = false;
  let timedOut = false;
  let stderr = "";
  let idle: NodeJS.Timeout | undefined;
  let lastPhase: ClonePhase | null = null;
  let lastSent = 0;
  const child = spawn(opts.git, args, {
    env: { ...process.env, LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_PROGRESS_DELAY: "0" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const kill = () => {
    if (child.pid !== undefined && opts.killTree) void opts.killTree(child.pid).catch(() => undefined);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  };
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.idleTimeoutMs ?? CLONE_IDLE_TIMEOUT_MS);
  };
  armIdle();
  opts.onProgress({ phase: "connecting", percent: 0, phasePercent: null, detail: null });
  let partial = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    armIdle();
    if (stderr.length < 64 * 1024) stderr += chunk;
    const parts = (partial + chunk).split(/[\r\n]/);
    partial = parts.pop() ?? "";
    for (const line of parts) {
      const p = parseCloneProgressLine(line);
      if (!p) continue;
      const now = Date.now();
      if (p.phase === lastPhase && now - lastSent < PROGRESS_EVERY_MS && p.phasePercent !== 100) continue;
      lastPhase = p.phase;
      lastSent = now;
      opts.onProgress(p);
    }
  });
  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (e: CloneError) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      void removeClone(opts.path).finally(() => reject(e));
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      fail(e.code === "ENOENT" ? new CloneError("git_missing", "") : new CloneError("clone_failed", redactCredentials(e.message)));
    });
    const finish = (code: number | null) => {
      if (cancelled) return fail(new CloneError("clone_cancelled", ""));
      if (timedOut) return fail(new CloneError("clone_timeout", ""));
      if (code !== 0) return fail(new CloneError(classifyCloneError(stderr), cloneErrorLine(stderr)));
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      resolve();
    };
    // `close` waits for stderr's end, which a helper git started (`git-remote-https`, `ssh`) may hold a little longer than
    // git lives: a stop ends at git's exit, anything else at the end of its messages (or 3 s after the exit).
    child.on("exit", (code) => {
      if (cancelled || timedOut) finish(code);
      else setTimeout(() => finish(code), 3000).unref();
    });
    child.on("close", (code) => finish(code));
  });
  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      kill();
    },
  };
}

/** Removes the folder a failed or cancelled clone left (retried: on Windows a helper may hold a file a moment longer). */
async function removeClone(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
