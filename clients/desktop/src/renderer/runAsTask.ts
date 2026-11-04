/**
 * docs/PROTOCOL.md §49 "Run as Task" (업무로 실행) on the desktop client, as on the Mac (Core `Session/AppState+Task.swift`,
 * App `UI/Chat/ChatComposer.swift`): a task starts in a workbench of its own (a new branch and folder, its own window and a
 * fresh chat), so the chat it was typed in never sees it. The New Workbench sheet sends `workbench_create {task}`; the new
 * window's engine sends the task as its first message (`task_started`). Pure (unit-tested in runAsTask.test.ts).
 */
import type { AppSettings } from "../shared/ipc";

/** The prefix "Run as Task" suggests until a task branch was created (then the one that branch used). */
export const DEFAULT_TASK_PREFIX = "task/";

/** Settings › General › Workbenches › "업무로 실행" (`runAsTaskEnabled`, absent = on). */
export const runAsTaskEnabled = (settings: Pick<AppSettings, "runAsTaskEnabled"> | null | undefined): boolean => settings?.runAsTaskEnabled !== false;

/** The prefix the next suggestion starts with (`taskBranchPrefix`, `task/` until a task branch was created). */
export const taskPrefixOf = (settings: Pick<AppSettings, "taskBranchPrefix"> | null | undefined): string =>
  typeof settings?.taskBranchPrefix === "string" ? settings.taskBranchPrefix : DEFAULT_TASK_PREFIX;

/** What "Run as Task" takes from the composer: the draft, then its @ mentions as `@path` (images stay in the composer). */
export function composerTaskText(draft: string, mentions: readonly string[]): string {
  const text = draft.trim();
  if (mentions.length === 0) return text;
  const tags = mentions.map((m) => `@${m}`).join(" ");
  return text.length === 0 ? tags : `${text}\n\n${tags}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * The branch "Run as Task" suggests for `text` (Mac `TaskBranchName.suggest`): `<prefix><id>` from a task link or key (the
 * last number of a URL's path, `#project/123` → `project-123`, `ABC-123`, `#123`), else up to five ASCII words of its first
 * line, else the date and time (`utc`: in UTC, else local time).
 */
export function suggestTaskBranch(text: string, prefix: string = DEFAULT_TASK_PREFIX, now: Date = new Date(), utc = false): string {
  const p = cleanTaskPrefix(prefix);
  const id = taskIdIn(text);
  if (id) return p + id;
  const words = firstLineWords(text);
  if (words.length > 0) return p + words.join("-");
  const [y, mo, d, h, mi] = utc
    ? [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()]
    : [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()];
  return `${p}${pad(y, 4)}${pad(mo)}${pad(d)}-${pad(h)}${pad(mi)}`;
}

/** The part of `branch` before its last `/` (with the slash), "" without one: what the next suggestion starts with. */
export function taskBranchPrefixOf(branch: string): string {
  const trimmed = branch.replace(/^[ \t]+|[ \t]+$/g, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? "" : cleanTaskPrefix(trimmed.slice(0, slash + 1));
}

/** A prefix that keeps the branch name valid: path parts of `[A-Za-z0-9._-]` ending in `/`, "" otherwise. */
export function cleanTaskPrefix(raw: string): string {
  const parts = raw
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+|\.+$/g, ""))
    .filter((part) => part.length > 0 && !part.endsWith(".lock"));
  return parts.length === 0 ? "" : `${parts.join("/")}/`;
}

/** The task's id in `text`: a URL's last numeric path part, `#project/123` → `project-123`, `ABC-123`, `#123` → `123`. */
export function taskIdIn(text: string): string | null {
  const url = firstUrl(text);
  if (url) {
    const numbers = url.pathname.split("/").filter((part) => /^[0-9]+$/.test(part));
    const last = numbers[numbers.length - 1];
    if (last) return last;
  }
  const project = /#([A-Za-z][A-Za-z0-9_-]*)\/(\d+)/.exec(text);
  if (project) return `${project[1]}-${project[2]}`;
  const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(text);
  if (key) return key[1]!;
  const hash = /(?:^|\s)#(\d+)\b/.exec(text);
  if (hash) return hash[1]!;
  return null;
}

/** The first http(s) link in `text` (trailing punctuation is not part of it), or null. */
function firstUrl(text: string): URL | null {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch {
      // not a URL after all: the next one
    }
  }
  return null;
}

/** Lower-cased ASCII words of the first non-empty line (URLs skipped), at most five and 40 characters. */
export function firstLineWords(text: string): string[] {
  const line = text.split(/\r\n|[\n\r\u2028\u2029\u0085\v\f]/).find((l) => l.trim().length > 0) ?? "";
  const words: string[] = [];
  let length = 0;
  for (const token of line.split(/\s+/)) {
    if (token.length === 0 || token.includes("://")) continue;
    const word = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (word.length === 0) continue;
    if (words.length === 5 || length + word.length > 40) break;
    words.push(word);
    length += word.length + 1;
  }
  return words;
}
