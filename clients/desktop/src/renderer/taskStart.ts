/**
 * MARK: task-start — docs/PROTOCOL.md §63 on Windows, the same rules as Core `Session/TaskStart.swift` on the Mac: the task
 * the user names (an id or a link), the branch it gets, its first prompt, when the start screen of a project window shows,
 * what it lists and its keys. GitHub issues are read by the engine (`task_fetch`, `gh`); any other tracker is read by Claude
 * through the MCP server of Settings › Tasks — the app never calls a tracker and keeps no token. Pure (taskStart.test.ts).
 */
import type { GatePhase, SessionMeta } from "@reviewgate/engine";
import { t } from "./i18n";
import { cleanTaskPrefix } from "./runAsTask";
import { readsThroughMcp, type TaskPlatform, type TaskStartSettings } from "../shared/taskStartSettings";

// ---------------------------------------------------------------- the task the user names

/** A task id or link as typed or pasted: `ACME-123`, `#42`, `42`, `owner/repo#42`, a tracker link, a GitHub issue link. */
export type TaskReference = {
  /** What the user gave (trimmed). */
  raw: string;
  /** The id the branch and the prompt use (`ACME-123`, `42`). */
  id: string;
  /** The link, when one was given. */
  url: string | null;
  /** What `task_fetch` takes when this is a GitHub issue (a number, `owner/repo#n`, an `/issues/<n>` link); null otherwise. */
  issueRef: string | null;
  /** An `/issues/<n>` link on a GitHub host (`github.com`, GitHub Enterprise: a host with `github` in it). */
  isGitHubLink: boolean;
};

const isLink = (token: string) => token.startsWith("http://") || token.startsWith("https://");

/** A tracker key (`ACME-123`) in `text`. */
export function taskKeyIn(text: string): string | null {
  return /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(text)?.[1] ?? null;
}

/** The ASCII-safe part of a token (`[A-Za-z0-9._-]`, ≤ 40, no leading / trailing `.` or `-`), null when none is left. */
export function cleanTaskId(raw: string): string | null {
  const kept = raw
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 40)
    .replace(/^[.-]+|[.-]+$/g, "");
  return kept.length > 0 ? kept : null;
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** Null for nothing usable (empty, or no ASCII id in it — a Korean word names no branch). */
export function parseTaskReference(text: string): TaskReference | null {
  const raw = text.trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/);
  const token = tokens.find(isLink) ?? tokens[0]!;
  if (isLink(token)) {
    let url: URL | null = null;
    try {
      url = new URL(token);
    } catch {
      url = null;
    }
    if (url && url.hostname) {
      const host = url.hostname.toLowerCase();
      const parts = url.pathname.split("/").filter((p) => p.length > 0).map(decode);
      const last = parts[parts.length - 1] ?? "";
      if (parts.length >= 4 && parts[parts.length - 2] === "issues" && /^\d+$/.test(last) && Number(last) > 0) {
        const github = host.includes("github");
        return { raw, id: String(Number(last)), url: token, issueRef: github ? token : null, isGitHubLink: github };
      }
      const numeric = [...parts].reverse().find((p) => /^[0-9]+$/.test(p));
      const id = taskKeyIn(token) ?? numeric ?? (last ? cleanTaskId(last) : null) ?? "";
      if (!id) return null;
      return { raw, id, url: token, issueRef: null, isGitHubLink: false };
    }
  }
  const number = /^#?(\d{1,9})$/.exec(token);
  if (number && Number(number[1]) > 0) return { raw, id: String(Number(number[1])), url: null, issueRef: String(Number(number[1])), isGitHubLink: false };
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#(\d{1,9})$/.exec(token);
  if (repo && Number(repo[1]) > 0) return { raw, id: String(Number(repo[1])), url: null, issueRef: token, isGitHubLink: false };
  const id = taskKeyIn(token) ?? cleanTaskId(token);
  return id ? { raw, id, url: null, issueRef: null, isGitHubLink: false } : null;
}

/** The engine reads this task with `gh` (`task_fetch`): a GitHub link always, a number or `owner/repo#n` when the project's tasks are GitHub issues. */
export function fetchesFromGitHub(ref: TaskReference, platform: TaskPlatform): boolean {
  return ref.issueRef !== null && (ref.isGitHubLink || platform === "github");
}

/** A task as the engine read it (`task_fetched`), or as far as the app knows it (an MCP task: only its id and link). */
export type FetchedTask = { id: string; number?: number; title: string; body: string; url: string; labels: string[] };

export const taskOf = (ref: TaskReference): FetchedTask => ({ id: ref.id, title: "", body: "", url: ref.url ?? "", labels: [] });

// ---------------------------------------------------------------- the branch

export const MAX_TASK_SLUG = 50;

/** `{type}`: `fix` for a bug, `docs`, `chore`, else `feature`. */
export function taskBranchType(labels: readonly string[]): string {
  const words = labels.map((l) => l.toLowerCase());
  if (words.some((w) => w.includes("bug") || w.includes("fix") || w.includes("defect"))) return "fix";
  if (words.some((w) => w.includes("doc"))) return "docs";
  if (words.some((w) => w.includes("chore") || w.includes("maintenance"))) return "chore";
  return "feature";
}

const asciiWords = (text: string) => text.split(/[^a-z0-9]+/).filter((w) => w.length > 0);

/** Lower-cased ASCII words of `title` joined by `-` (accents folded, the rest dropped), cut at a word to ≤ 50; a leading copy of the id left out. */
export function taskSlug(title: string, droppingId = ""): string {
  const folded = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = asciiWords(folded);
  const idWords = asciiWords(droppingId.toLowerCase());
  if (idWords.length > 0 && idWords.every((w, i) => words[i] === w)) words.splice(0, idWords.length);
  let out = "";
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > MAX_TASK_SLUG) {
      if (!out) out = word.slice(0, MAX_TASK_SLUG);
      break;
    }
    out = next;
  }
  return out;
}

/** `<prefix><id>-<slug>`; only `<prefix><id>` when the title has no ASCII word (a Korean title) or is not known (an MCP task). */
export function taskBranchName(prefix: string, id: string, title = "", labels: readonly string[] = []): string {
  const p = cleanTaskPrefix(prefix.split("{type}").join(taskBranchType(labels)));
  const clean = cleanTaskId(id) ?? "task";
  const slug = taskSlug(title, clean);
  return slug ? `${p}${clean}-${slug}` : p + clean;
}

// ---------------------------------------------------------------- the first prompt

/** The built-in template (Settings › Tasks › Reset), in the UI's language. */
export const defaultTaskTemplate = (): string => t("Work on task {id}: {title}\n{url}\n\n{mcp}\n\n{body}\n\nSummarize the task first and tell me your plan before you change code.");

/** Claude Code's tool-name part of a server: characters other than letters, digits, `_` and `-` become `_`. */
export const mcpToolPrefix = (server: string): string => server.replace(/[^A-Za-z0-9_-]/g, "_");

/** How Claude gets the task: through the MCP server (Jira / Linear / other), with `gh` (a GitHub issue the app could not read), or nothing. */
export function taskHint(platform: TaskPlatform, mcpServer: string, task: FetchedTask, github: boolean): string {
  const server = mcpServer.trim();
  if (github) return task.body === "" && task.title === "" ? t("Read the issue first (gh issue view {0}) and summarize it.", task.url || task.id) : "";
  if (!readsThroughMcp(platform)) return "";
  if (!server) return t("Read the task first (it is not in this message) and summarize it.");
  return t("Read this task with the {0} MCP server (its {1} tools) and summarize it before you start.", server, `mcp__${mcpToolPrefix(server)}__*`);
}

const PLACEHOLDERS = ["id", "title", "url", "body", "mcp"] as const;

/** The template with the task's values: a line whose placeholders are all empty is left out, one with some empty loses a trailing `:`/`—`/`-`. */
export function renderTaskPrompt(template: string, task: FetchedTask, hint: string): string {
  const values: Record<(typeof PLACEHOLDERS)[number], string> = { id: task.id, title: task.title, url: task.url, body: task.body.trim(), mcp: hint };
  const lines: string[] = [];
  for (const line of template.split("\n")) {
    const names = PLACEHOLDERS.filter((n) => line.includes(`{${n}}`));
    let out = line;
    for (const n of names) out = out.split(`{${n}}`).join(values[n]);
    if (names.length > 0) {
      if (names.every((n) => values[n] === "")) continue;
      if (names.some((n) => values[n] === "")) {
        out = out.trim();
        while (out.length > 0 && ":—–-·".includes(out[out.length - 1]!)) out = out.slice(0, -1).trim();
      }
    }
    lines.push(out);
  }
  let text = lines.join("\n");
  while (text.includes("\n\n\n")) text = text.split("\n\n\n").join("\n\n");
  text = text.trim();
  if (hint && !template.includes("{mcp}")) text = `${hint}\n\n${text}`;
  return text;
}

/** §63.1 refusals of `task_fetch` in the user's words (null: the shared refusal text says it). */
export function taskFetchRefusal(code: string, detail: string): string | null {
  switch (code) {
    case "bad_task_ref":
      return t("Not a GitHub issue — use a number, owner/repo#123 or an issue link");
    case "gh_missing":
      return t("GitHub CLI (gh) was not found — install it, or set its path in Settings › Advanced");
    case "not_found":
      return t("No such issue in this repository");
    case "task_fetch_failed":
      return detail ? t("Could not read the issue: {0}", detail) : t("Could not read the issue");
    default:
      return null;
  }
}

/** The task dialog's line under its title: the platform and how the task is read. */
export function taskPlatformLine(platform: TaskPlatform, mcpServer: string, title: string): string {
  switch (platform) {
    case "none":
      return t("A task id or link — set the platform in Settings › Tasks");
    case "github":
      return t("GitHub Issues — read with the GitHub CLI (gh)");
    default:
      return mcpServer.trim() ? t("{0} — Claude reads it with the {1} MCP server", t(title), mcpServer.trim()) : t("{0} — choose its MCP server in Settings › Tasks", t(title));
  }
}

// ---------------------------------------------------------------- the task dialog

/** What the dialog fills in for `ref` (the issue read, else its id and link): the branch and the first prompt — until the user edits them. */
export function taskDraft(settings: TaskStartSettings, ref: TaskReference, fetched: FetchedTask | null): { task: FetchedTask; branch: string; prompt: string } {
  const task = fetched ?? taskOf(ref);
  const hint = taskHint(settings.platform, settings.mcpServer, task, fetchesFromGitHub(ref, settings.platform));
  return {
    task,
    branch: taskBranchName(settings.branchPrefix, task.id, task.title, task.labels),
    prompt: renderTaskPrompt(settings.promptTemplate ?? defaultTaskTemplate(), task, hint),
  };
}

/** Why Start is off (null: it can start) — in the Mac's order. */
export function taskStartBlocker(o: { ref: TaskReference | null; fetching: boolean; prompt: string; branchHint: string | null; createBlocker: string | null }): string | null {
  if (!o.ref) return t("Enter a task id or link");
  if (o.fetching) return t("Reading the issue…");
  if (!o.prompt.trim()) return t("The first prompt is empty");
  return o.branchHint ?? o.createBlocker;
}

// ---------------------------------------------------------------- the start screen

export const RECENT_CHAT_LIMIT = 5;

/**
 * When a project opened in a window: not when the user turned it off, not for a window the app opened with work of its own
 * (a restored window, a workbench it just made), never while a turn runs, files wait for review or text waits for the
 * composer — the window then shows its chat as before.
 */
export function shouldShowStartScreen(o: { skip: boolean; suppressed: boolean; phase: GatePhase; reviewPending: boolean; composerTask: boolean }): boolean {
  return !o.skip && !o.suppressed && !o.reviewPending && !o.composerTask && o.phase === "idle";
}

/** The chats "대화로 열기" lists: newest first, at most five, ones with a turn — not archived, moved or carried on in a terminal chat. */
export function recentStartChats(list: readonly SessionMeta[], limit = RECENT_CHAT_LIMIT): SessionMeta[] {
  return list
    .filter((m) => !m.archived && !m.movedTo && !m.continuedIn && (m.turns > 0 || (m.lastUserText ?? "") !== ""))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit);
}

/** 바로 시작 (and a task started here) needs a fresh chat when the window's chat already holds a conversation. */
export function needsNewChat(current: SessionMeta | null | undefined): boolean {
  return !!current && (current.turns > 0 || (current.lastUserText ?? "") !== "");
}

/** 1 바로 시작 · 2 업무로 시작 · 3 대화로 열기. */
export type StartChoice = 1 | 2 | 3;
/** The marked row: a choice, or the n-th recent chat (0-based). */
export type StartMark = { choice: StartChoice } | { chat: number };
export type StartAction = { kind: "start" } | { kind: "task" } | { kind: "openChat"; id: string };

export const START_MARK: StartMark = { choice: 1 };

const sameMark = (a: StartMark, b: StartMark) => ("choice" in a && "choice" in b ? a.choice === b.choice : "chat" in a && "chat" in b && a.chat === b.chat);

/** The rows in order: the choices (대화로 열기 only with chats), then the chats. */
function rows(chats: readonly string[]): StartMark[] {
  const choices: StartMark[] = chats.length === 0 ? [{ choice: 1 }, { choice: 2 }] : [{ choice: 1 }, { choice: 2 }, { choice: 3 }];
  return [...choices, ...chats.map((_, chat) => ({ chat }))];
}

/** ↑ / ↓: the mark moves through the choices and then the chats, stopping at either end. */
export function moveStartMark(mark: StartMark, delta: number, chats: readonly string[]): StartMark {
  const all = rows(chats);
  const index = Math.max(0, all.findIndex((m) => sameMark(m, mark)));
  return all[Math.max(0, Math.min(all.length - 1, index + delta))]!;
}

/** 1 / 2 act at once; 3 marks the first recent chat (nothing without one). */
export function pressStartNumber(mark: StartMark, n: number, chats: readonly string[]): { mark: StartMark; action: StartAction | null } {
  if (n === 1) return { mark, action: { kind: "start" } };
  if (n === 2) return { mark, action: { kind: "task" } };
  if (n === 3 && chats.length > 0) return { mark: { chat: 0 }, action: null };
  return { mark, action: null };
}

/** ↩: the marked row (대화로 열기 marks its first chat instead). */
export function activateStartMark(mark: StartMark, chats: readonly string[]): { mark: StartMark; action: StartAction | null } {
  if ("chat" in mark) {
    const id = chats[mark.chat];
    return { mark, action: id ? { kind: "openChat", id } : null };
  }
  return pressStartNumber(mark, mark.choice, chats);
}

/**
 * A key on the start screen (`KeyboardEvent.key`): 1 / 2 / 3, ↑ / ↓, Enter, and Esc = 바로 시작 — the screen never blocks.
 * `handled` false: not the screen's key (it goes on as usual).
 */
export function startScreenKey(key: string, mark: StartMark, chats: readonly string[]): { handled: boolean; mark: StartMark; action: StartAction | null } {
  switch (key) {
    case "1":
    case "2":
    case "3":
      return { handled: true, ...pressStartNumber(mark, Number(key), chats) };
    case "ArrowUp":
      return { handled: true, mark: moveStartMark(mark, -1, chats), action: null };
    case "ArrowDown":
      return { handled: true, mark: moveStartMark(mark, 1, chats), action: null };
    case "Enter":
      return { handled: true, ...activateStartMark(mark, chats) };
    case "Escape":
      return { handled: true, mark, action: { kind: "start" } };
    default:
      return { handled: false, mark, action: null };
  }
}
