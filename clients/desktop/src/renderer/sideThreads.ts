/**
 * Side questions ("곁질문", docs/PROTOCOL.md §21) — the pure part of the client state, unit-tested: the current
 * chat's threads keyed by id, the answer that is still streaming (`side_text_delta` / `side_tool_use` /
 * `side_tool_result` until the thread's next `side_thread` snapshot), anchors in words, badge counts per file /
 * hunk, the matching tool row of a permission card, promote refusals and the background notification.
 */
import type { SideAnchor, SideThread, SideToolCall } from "@reviewgate/engine";
import type { NotifyRequest } from "../shared/ipc";
import { t } from "./i18n";
import { prAnchorLocation } from "./prClaude"; // MARK: wave3 desktop-flow
import { quoteLabel, quoteTitle } from "./sideTrust"; // MARK: wave4b w4b-side

/** The answer being streamed; dropped when the thread's next snapshot is no longer `running`. */
export type SideLive = { text: string; toolCalls: SideToolCall[] };

export type SideState = {
  /** `side_threads.mainSessionId` — the chat these threads belong to. */
  mainSessionId: string | null;
  threads: Record<string, SideThread>;
  live: Record<string, SideLive>;
};

export const EMPTY_SIDE: SideState = { mainSessionId: null, threads: {}, live: {} };

/** Newest first (`updatedAt`, then `createdAt`). */
export function sortedThreads(s: SideState): SideThread[] {
  return Object.values(s.threads).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

/** `side_thread`: the snapshot replaces the thread; the streamed partial answer ends with a non-running one. */
export function applyThread(s: SideState, thread: SideThread): SideState {
  const threads = { ...s.threads, [thread.id]: thread };
  if (thread.status === "running") {
    // Deltas may already have arrived for this question: keep them; else start an empty partial answer.
    return { ...s, threads, live: s.live[thread.id] ? s.live : { ...s.live, [thread.id]: { text: "", toolCalls: [] } } };
  }
  const { [thread.id]: _done, ...live } = s.live;
  return { ...s, threads, live };
}

/** `side_threads`: the whole list of the current chat (a chat switch replaces everything). */
export function applyThreads(s: SideState, mainSessionId: string | null, threads: SideThread[]): SideState {
  const map: Record<string, SideThread> = {};
  const live: Record<string, SideLive> = {};
  for (const th of threads) {
    map[th.id] = th;
    if (th.status === "running" && s.live[th.id] && s.mainSessionId === mainSessionId) live[th.id] = s.live[th.id]!;
  }
  return { mainSessionId, threads: map, live };
}

const liveOf = (s: SideState, id: string): SideLive => s.live[id] ?? { text: "", toolCalls: [] };

export function applyTextDelta(s: SideState, threadId: string, text: string): SideState {
  const cur = liveOf(s, threadId);
  return { ...s, live: { ...s.live, [threadId]: { ...cur, text: cur.text + text } } };
}

export function applyToolUse(s: SideState, threadId: string, call: { id: string; name: string; input: Record<string, unknown> }): SideState {
  const cur = liveOf(s, threadId);
  if (cur.toolCalls.some((c) => c.id === call.id)) return s;
  return { ...s, live: { ...s.live, [threadId]: { ...cur, toolCalls: [...cur.toolCalls, { id: call.id, name: call.name, input: call.input }] } } };
}

export function applyToolResult(s: SideState, threadId: string, r: { toolUseId: string; isError: boolean; preview: string; denied?: true }): SideState {
  const cur = s.live[threadId];
  if (!cur) return s;
  const toolCalls = cur.toolCalls.map((c) => (c.id === r.toolUseId ? { ...c, isError: r.isError, preview: r.preview, ...(r.denied ? { denied: true as const } : {}) } : c));
  return { ...s, live: { ...s.live, [threadId]: { ...cur, toolCalls } } };
}

/** `side_turn_end`: the question is over (the final snapshot follows; until then the thread reads idle). */
export function applyTurnEnd(s: SideState, threadId: string): SideState {
  const th = s.threads[threadId];
  if (!th || th.status !== "running") return s;
  return { ...s, threads: { ...s.threads, [threadId]: { ...th, status: "idle" } } };
}

export function applyClosed(s: SideState, threadId: string): SideState {
  if (!s.threads[threadId] && !s.live[threadId]) return s;
  const { [threadId]: _t, ...threads } = s.threads;
  const { [threadId]: _l, ...live } = s.live;
  return { ...s, threads, live };
}

/** `side_failed` (`error.threadId`): the thread shows the failure until its next snapshot. */
export function applyThreadError(s: SideState, threadId: string, message: string): SideState {
  const th = s.threads[threadId];
  if (!th) return s;
  return { ...s, threads: { ...s.threads, [threadId]: { ...th, status: "error", error: th.error ?? message } } };
}

export const runningCount = (s: SideState): number => Object.values(s.threads).filter((th) => th.status === "running").length;
/** Every side question of this chat costs this much (also `hud.sideCostUSD`, which an older engine lacks). */
export const totalCost = (s: SideState): number => Object.values(s.threads).reduce((n, th) => n + (th.costUSD || 0), 0);

// ---------------------------------------------------------------- anchors

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The short chip text of an anchor: `a.ts:42`, `a.ts · 부분 2`, `a.ts`, `도구 호출`, or null for none. */
export function anchorLabel(a: SideAnchor | null | undefined): string | null {
  if (!a) return null;
  if (a.pr) return prAnchorLocation(a.pr); // MARK: wave3 desktop-flow — §36.14 a PR line / hunk
  if (a.quote) return quoteLabel(a.quote); // MARK: wave4b w4b-side — §40.3 a passage of Claude's answer
  const file = a.path ? baseName(a.path) : null;
  let out: string | null = null;
  if (file && a.line !== undefined) out = `${file}:${a.side === "old" ? "−" : ""}${a.line}`;
  else if (file && a.hunkId !== undefined) out = t("{0} · part {1}", file, a.hunkId + 1);
  else if (file) out = file;
  else if (a.toolUseId) out = t("tool call");
  if (out && a.entryId) out = `${out} · ${t("history")}`;
  return out;
}

/** The full anchor in words for the thread header / tooltip. */
export function anchorTitle(a: SideAnchor | null | undefined): string {
  if (!a) return t("No anchor — about the whole conversation");
  // MARK: wave3 desktop-flow — §36.14: `PR #<number> <path>:<line> (<side>)`, as the side prompt names it
  if (a.pr) return `PR #${a.pr.number} ${a.pr.path}${typeof a.pr.line === "number" ? `:${a.pr.line}` : ""} (${a.pr.side})`;
  if (a.quote) return quoteTitle(a.quote); // MARK: wave4b w4b-side — §40.3
  const parts: string[] = [];
  if (a.path) parts.push(a.line !== undefined ? `${a.path}:${a.side === "old" ? "−" : "+"}${a.line}` : a.path);
  if (a.hunkId !== undefined) parts.push(t("part {0}", a.hunkId + 1));
  if (a.toolUseId) parts.push(t("tool call {0}", a.toolUseId.slice(-8)));
  if (a.entryId) parts.push(t("past review round"));
  return parts.join(" · ");
}

/** Same thing? (for re-opening an existing thread instead of starting a duplicate). */
export function sameAnchor(a: SideAnchor | null | undefined, b: SideAnchor | null | undefined): boolean {
  const n = (x: SideAnchor | null | undefined) =>
    JSON.stringify([x?.path ?? null, x?.hunkId ?? null, x?.line ?? null, x?.line !== undefined ? (x?.side ?? "new") : null, x?.toolUseId ?? null, x?.entryId ?? null, x?.pr ? [x.pr.number, x.pr.path, x.pr.line, x.pr.side] : null, x?.quote ? [x.quote.text, x.quote.turn ?? null] : null]); // MARK: wave3 desktop-flow — + §36.14 pr; wave4b w4b-side — + §40.3 quote
  return n(a) === n(b);
}

/** Threads anchored on `path` of the live review (history threads count on their own view). */
export function threadsOnFile(threads: SideThread[], path: string, entryId?: string): SideThread[] {
  return threads.filter((th) => th.anchor?.path === path && (th.anchor.entryId ?? undefined) === entryId);
}

/** Threads on one hunk: `hunkId`, or a line inside its new / old range. */
export function threadsOnHunk(threads: SideThread[], path: string, hunk: { id: number; lines: { oldNo: number | null; newNo: number | null }[] }, entryId?: string): SideThread[] {
  return threadsOnFile(threads, path, entryId).filter((th) => {
    const a = th.anchor!;
    if (a.hunkId !== undefined) return a.hunkId === hunk.id;
    if (a.line === undefined) return false;
    return hunk.lines.some((l) => (a.side === "old" ? l.oldNo === a.line : l.newNo === a.line));
  });
}

/** Threads about one tool call. */
export function threadsOnTool(threads: SideThread[], toolUseId: string): SideThread[] {
  return threads.filter((th) => th.anchor?.toolUseId === toolUseId);
}

/** The default question for an anchor (prefilled, selected — Enter asks it, typing replaces it). */
export function defaultQuestion(a: SideAnchor | null, kind?: "permission" | "tool" | "line" | "hunk" | "file"): string {
  if (kind === "permission") return t("Why is this needed?");
  if (kind === "tool") return t("Why did you do this?");
  if (!a) return "";
  return t("Why did you change it like this?");
}

/** One-click follow-ups offered under an answer. */
export function quickQuestions(): string[] {
  return [t("Why did you change it like this?"), t("What are the risks?"), t("Is there a simpler way?")];
}

/**
 * The transcript row of the call a permission card asks about (the engine's request has no tool-use id): the last
 * `toolUse` of that tool before the card whose command / file matches.
 */
export function toolUseIdForPermission(
  items: readonly { kind: string; toolUseId?: string; name?: string; input?: Record<string, unknown>; file?: string; request?: { requestId: string } }[],
  request: { requestId: string; toolName: string; input: Record<string, unknown>; file?: string },
): string | null {
  let end = items.findIndex((it) => it.kind === "permission" && it.request?.requestId === request.requestId);
  if (end < 0) end = items.length;
  const cmd = typeof request.input["command"] === "string" ? request.input["command"] : null;
  for (let i = end - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== "toolUse" || it.name !== request.toolName || !it.toolUseId) continue;
    if (cmd !== null) {
      if (it.input?.["command"] === cmd) return it.toolUseId;
      continue;
    }
    if (request.file && it.file && it.file !== request.file) continue;
    return it.toolUseId;
  }
  return null;
}

// ---------------------------------------------------------------- promote

export type PromoteAs = "message" | "note";

/** Where a promoted text goes, in words (the draft dialog's "→" line). */
export function promoteTarget(as: PromoteAs, anchor: SideAnchor | null): string {
  if (as === "message") return t("A message to the main conversation (Claude reads it as your next instruction)");
  if (!anchor?.path) return t("A review note — this thread has no file to put it on");
  const where = anchor.line !== undefined ? `${anchor.path}:${anchor.side === "old" ? "−" : "+"}${anchor.line}` : anchor.path;
  return t("A review note on {0} (sent with Request changes)", where);
}

/** What the dialog offers for a refused `side_promote` (null = just show the words). */
export type PromoteRecovery = "queue" | null;

/** `gate_closed:running` (or any closed gate) for a message → it can wait in the composer queue instead. */
export function promoteRecovery(as: PromoteAs, code: string): PromoteRecovery {
  return as === "message" && (code === "gate_closed" || code === "session_busy" || code === "starting") ? "queue" : null;
}

/** The suffix the engine appends; the queued fallback adds the same so the main agent sees where it came from. */
export const PROMOTE_SUFFIX = "\n\n(곁질문에서 정리됨)";

/**
 * MARK: r2-skills-side — P3-transcript-29: what closing the window (or quitting) loses while the promote dialog is up — its
 * drafted / edited text, once there is some (`useUnsavedWork("sidePromote", …)`); null otherwise. The side drafts themselves
 * are kept per chat (P3-transcript-28), so they list nothing.
 */
export function promoteUnsavedLine(d: { text: string; loading: boolean } | null): string | null {
  return d && !d.loading && d.text.trim() ? t("A side question's instruction or note is not sent yet. Closing discards it.") : null;
}

/** `thread.promotions` newest last → the chip under the thread ("메인으로 보냄 ✓"). */
export function lastPromotion(th: SideThread): { as: PromoteAs; at: string; queued?: true } | null {
  const p = th.promotions;
  return p && p.length > 0 ? p[p.length - 1]! : null;
}

// ---------------------------------------------------------------- notification

const firstLine = (s: string, max = 160): string => {
  const line = s.split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

/** `side_turn_end` while the window is in the background → "곁질문 답변 도착: <title>". */
export function sideNotification(th: SideThread | undefined, answer: string, stopReason: string, ctx: { project: string | null }): NotifyRequest | null {
  if (!th || stopReason === "interrupted") return null;
  const title = ctx.project ? `ReviewGate — ${ctx.project}` : "ReviewGate";
  const head = t("Side answer: {0}", th.title || t("(untitled)"));
  // The first sentence of the answer, not its markdown heading.
  const prose = answer.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  const line = firstLine(prose, 200) || firstLine(answer, 200);
  const body = line ? `${head} — ${line}` : head;
  return { kind: "side_answer", title, body, key: `side:${th.id}:${th.messages.length}` };
}

/** The last assistant text of a thread (or the live one). */
export function lastAnswer(th: SideThread | undefined, live?: SideLive): string {
  if (live?.text) return live.text;
  if (!th) return "";
  for (let i = th.messages.length - 1; i >= 0; i--) if (th.messages[i]!.role === "assistant") return th.messages[i]!.text;
  return "";
}
