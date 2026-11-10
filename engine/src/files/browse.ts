// MARK: code-browser — docs/PROTOCOL.md §47: reading and searching any file of the open project, read-only (the user's
// "코드 탐색"). Quick Open reuses `list_files` (§23); these two read what it lists.
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { CommandRefused } from "../errors.js";
import { getGitPath } from "../git/exec.js";
import { repoRelativeInside } from "../platform/paths.js";
import type { ProjectSearchMatch } from "../protocol.js";

/** `project_file` sends at most this many lines (the rest: `truncated`). */
export const PROJECT_FILE_MAX_LINES = 20_000;
/** …and reads at most this many bytes of the file. */
export const PROJECT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** `project_search` default and cap of `limit`. */
export const PROJECT_SEARCH_DEFAULT_LIMIT = 500;
export const PROJECT_SEARCH_MAX_LIMIT = 2_000;
/** A search that has not finished by then is stopped; what it found so far is the answer (`timedOut`). */
export const PROJECT_SEARCH_TIMEOUT_MS = 20_000;
/** Characters of a matching line a result carries (a window around the first match on a longer one). */
export const PROJECT_SEARCH_LINE_MAX = 400;

export type ProjectFile = { path: string; lines: string[]; isBinary: boolean; truncated: boolean; size: number };

/**
 * `project_file`: the worktree file at repo-relative `rel`, split into lines (`\r?\n`, the last empty one dropped). Only a
 * regular file inside the repository is read (no `..`, no symlink out of it, nothing under `.git`, no FIFO or device — the
 * descriptor is checked, as `safeReadText` does), at most `PROJECT_FILE_MAX_BYTES` of it and `PROJECT_FILE_MAX_LINES` lines.
 */
export function readProjectFile(root: string, rel: unknown): ProjectFile {
  const path = typeof rel === "string" ? repoRelativeInside(root, rel) : null;
  if (path === null) throw new CommandRefused(`invalid_path:${String(rel).slice(0, 200)}`, { code: "invalid_path" });
  let fd: number;
  try {
    fd = openSync(`${root}/${path}`, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new CommandRefused(`file_not_found:${path}`, { code: "file_not_found" });
    throw new CommandRefused(`file_unreadable:${code ?? String(e)}`, { code: "file_unreadable" });
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CommandRefused(`not_a_file:${path}`, { code: "not_a_file" });
    const want = Math.min(st.size, PROJECT_FILE_MAX_BYTES);
    const buf = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
    const bytes = buf.subarray(0, read);
    if (bytes.subarray(0, 8192).includes(0)) return { path, lines: [], isBinary: true, truncated: false, size: st.size };
    let cut = st.size > read;
    // A cut in the middle of a line (or a UTF-8 sequence) drops that partial line — unless it is the only one (a minified
    // bundle): then what was read shows, not an empty file.
    const lastNewline = bytes.lastIndexOf(0x0a);
    const text = bytes.toString("utf8", 0, cut && lastNewline >= 0 ? lastNewline + 1 : read);
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length > PROJECT_FILE_MAX_LINES) {
      lines.length = PROJECT_FILE_MAX_LINES;
      cut = true;
    }
    return { path, lines, isBinary: false, truncated: cut, size: st.size };
  } catch (e) {
    if (e instanceof CommandRefused) throw e;
    throw new CommandRefused(`file_unreadable:${(e as NodeJS.ErrnoException).code ?? String(e)}`, { code: "file_unreadable" });
  } finally {
    closeSync(fd);
  }
}

export type ProjectSearchOptions = { query: unknown; caseSensitive?: unknown; wholeWord?: unknown; limit?: unknown; timeoutMs?: number };
export type ProjectSearchResult = { query: string; matches: ProjectSearchMatch[]; truncated: boolean; timedOut: boolean };

/**
 * `project_search`: `git grep` over the worktree's tracked and untracked-but-not-ignored text files (`--untracked -I`,
 * what `list_files` lists), the query as a fixed string (`-F`), ignoring case unless `caseSensitive`, whole words with
 * `wholeWord`. Read as it streams: the first `limit` matches, then git is stopped (`truncated`); after
 * `PROJECT_SEARCH_TIMEOUT_MS` likewise (`timedOut`).
 */
export function searchProject(root: string, opts: ProjectSearchOptions): Promise<ProjectSearchResult> {
  const query = typeof opts.query === "string" ? opts.query : "";
  if (!query.trim()) throw new CommandRefused("empty_query", { code: "empty_query" });
  // A newline would make git search for each line as a pattern of its own; a control character never matches code anyway.
  if (query.length > 500 || /[\0-\x08\x0a-\x1f]/.test(query)) throw new CommandRefused("invalid_query", { code: "invalid_query" });
  const caseSensitive = opts.caseSensitive === true;
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.min(PROJECT_SEARCH_MAX_LIMIT, Math.floor(opts.limit)) : PROJECT_SEARCH_DEFAULT_LIMIT;
  // The user's git config must not change the output or refuse the search: `submodule.recurse` makes `--untracked` fatal,
  // `grep.column` / `grep.fullName` / `grep.fallbackToNoIndex` change what a line holds.
  const args = ["-C", root, "-c", "core.quotepath=off", "-c", "submodule.recurse=false", "-c", "grep.column=false", "-c", "grep.fullName=false",
    "-c", "grep.fallbackToNoIndex=false", "grep", "-n", "-z", "-I", "--no-color", "--untracked", "-F"];
  if (!caseSensitive) args.push("-i");
  if (opts.wholeWord === true) args.push("-w");
  args.push("-e", query, "--");

  return new Promise<ProjectSearchResult>((resolve, reject) => {
    const matches: ProjectSearchMatch[] = [];
    let truncated = false;
    let timedOut = false;
    let stopped = false;
    let pending: Buffer = Buffer.alloc(0);
    let stderr = "";
    const child = spawn(getGitPath(), args, { cwd: root, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs ?? PROJECT_SEARCH_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      // `-n -z`: `<path>\0<line>\0<text>\n` per match (the path verbatim — it may hold a newline, the text cannot).
      let pos = 0;
      for (;;) {
        const pathEnd = pending.indexOf(0, pos);
        if (pathEnd < 0) break;
        const lineEnd = pending.indexOf(0, pathEnd + 1);
        if (lineEnd < 0) break;
        const textEnd = pending.indexOf(0x0a, lineEnd + 1);
        if (textEnd < 0) break;
        if (matches.length >= limit) {
          truncated = true;
          stop();
          break;
        }
        const text = pending.toString("utf8", lineEnd + 1, textEnd).replace(/\r$/, "");
        matches.push({
          path: pending.toString("utf8", pos, pathEnd),
          line: Number.parseInt(pending.toString("latin1", pathEnd + 1, lineEnd), 10) || 0,
          text: lineWindow(text, query, caseSensitive),
        });
        pos = textEnd + 1;
      }
      pending = pending.subarray(pos);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new CommandRefused(`search_failed:${e.message.slice(0, 200)}`, { code: "search_failed" }));
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      // 1: nothing matched; a status we caused by stopping it does not count.
      if (!stopped && status !== 0 && status !== 1) {
        const line = stderr.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? `exit ${status}`;
        reject(new CommandRefused(`search_failed:${line}`, { code: "search_failed" }));
        return;
      }
      resolve({ query, matches, truncated, timedOut });
    });
  });
}

/** `text` when short enough, else `PROJECT_SEARCH_LINE_MAX` characters around the first match, "…" where it was cut. */
export function lineWindow(text: string, query: string, caseSensitive: boolean): string {
  if (text.length <= PROJECT_SEARCH_LINE_MAX) return text;
  const at = caseSensitive ? text.indexOf(query) : text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Math.min(at - 80, text.length - PROJECT_SEARCH_LINE_MAX));
  const end = start + PROJECT_SEARCH_LINE_MAX;
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
