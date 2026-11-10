/**
 * MARK: wave4 w4-history — docs/PROTOCOL.md §38.3 "History that lasts" on Electron: [이전 대화 더 보기] pages the chat's
 * older rows in (`transcript_page`, the view keeps its place), a restored `turn_summary` row is the turn summary card
 * again, the chat history searches the messages themselves (`transcript_search`; opening a match scrolls to its row),
 * and the review history filters its rounds by path, request, note or commit. An engine before §38.3 sends no `start`:
 * no button, the search stays on titles.
 */
import { create } from "zustand";
import type { ReviewHistoryEntry, TranscriptItem, TranscriptRestoreEvent, TranscriptSearchMatch, TurnSummaryEvent } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { t } from "./i18n";
import { chatItemsOfRows, useStore, type ChatItem } from "./store";
import { SEARCH_PER_CHAT } from "./reviewLeftovers"; // MARK: wave4c w4c-review

export const PAGE_ROWS = 200;
/** A search match further up than this is loaded in one page at most (the engine's own cap is 2 000). */
const MAX_JUMP_ROWS = 2000;

export type TranscriptPaging = {
  /** The chat the shown rows are of (`transcript_restore.sessionId`); null: nothing to page (an older engine, an empty chat). */
  sessionId: string | null;
  /** Row index of the oldest shown row; > 0: older rows exist. */
  start: number | null;
  /** `at` of that row (`transcript_page.beforeAt`, re-finds it after a rotation). */
  oldestAt: string | null;
  loading: boolean;
  error: string | null;
  /** Row index → ChatItem id of the restored user messages and Claude answers (a search match scrolls to its row). */
  rowIds: Record<number, number>;
  /** A search match to show once its row is loaded; `nonce` repeats a jump to the same row; `at` (epoch ms) when asked. */
  target: { sessionId: string; row: number; nonce: number; at: number } | null;
};

const EMPTY: TranscriptPaging = { sessionId: null, start: null, oldestAt: null, loading: false, error: null, rowIds: {}, target: null };

export const useTranscriptPaging = create<TranscriptPaging>(() => ({ ...EMPTY }));

// ---------------------------------------------------------------- pure

/** Pairs the user / assistant rows of a window with the user / assistant items made from them (one item each, in order). */
export function rowIdsOf(items: readonly TranscriptItem[], start: number, chat: readonly ChatItem[]): Record<number, number> {
  const rows: number[] = [];
  items.forEach((r, i) => {
    if (r.kind === "user_message" || r.kind === "assistant_text") rows.push(start + i);
  });
  const ids = chat.filter((c) => c.kind === "user" || c.kind === "assistant").map((c) => c.id);
  const out: Record<number, number> = {};
  for (let i = 0; i < Math.min(rows.length, ids.length); i++) out[rows[i]!] = ids[i]!;
  return out;
}

/** Older rows go above the shown ones (under the "restored" divider when it leads). */
export function insertOlder(transcript: readonly ChatItem[], older: readonly ChatItem[]): ChatItem[] {
  if (older.length === 0) return [...transcript];
  const at = transcript[0]?.kind === "restoredDivider" ? 1 : 0;
  return [...transcript.slice(0, at), ...older, ...transcript.slice(at)];
}

/** A restored `turn_summary` row as the live event; null for a row without files (no card, as live). */
export function summaryOfRow(row: TranscriptItem): TurnSummaryEvent | null {
  if (row.kind !== "turn_summary" || !Array.isArray(row.files) || row.files.length === 0) return null;
  return {
    type: "turn_summary",
    turn: row.turn,
    files: row.files,
    commands: Array.isArray(row.commands) ? row.commands : [],
    plan: row.plan ?? null,
    ...(row.review ? { review: row.review } : {}),
    ...(row.merged ? { merged: true as const } : {}),
    ...(row.lastTest !== undefined ? { lastTest: row.lastTest } : {}),
  };
}

/** Review history search: a round whose request, file paths (old names too), notes or commit subjects contain `query`. */
export function filterHistoryEntries(entries: readonly ReviewHistoryEntry[], query: string): ReviewHistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  const has = (s: string | null | undefined) => typeof s === "string" && s.toLowerCase().includes(q);
  return entries.filter(
    (e) => has(e.prompt) || e.files.some((f) => has(f.path) || has(f.oldPath) || has(f.commit?.subject)) || e.notes.some((n) => has(n.body)),
  );
}

/** The rows of the chat history: title / last request matches plus the chats whose messages matched (their line). */
export function chatSearchRows<M extends { id: string; title: string; lastUserText?: string | null }>(
  list: readonly M[],
  query: string,
  matches: readonly TranscriptSearchMatch[] | null,
): { meta: M; match: TranscriptSearchMatch | null }[] {
  const q = query.trim().toLowerCase();
  const byId = new Map((matches ?? []).map((m) => [m.sessionId, m] as const));
  return list
    .map((meta) => ({ meta, match: q ? byId.get(meta.id) ?? null : null }))
    .filter(({ meta, match }) => q === "" || match !== null || meta.title.toLowerCase().includes(q) || (meta.lastUserText ?? "").toLowerCase().includes(q));
}

// ---------------------------------------------------------------- store glue

/** `transcript_restore` was applied (store.ts): where its rows start and which items they became. */
export function pagingOnRestore(ev: TranscriptRestoreEvent, chat: readonly ChatItem[]): void {
  const target = useTranscriptPaging.getState().target;
  if (typeof ev.start !== "number" || typeof ev.sessionId !== "string" || ev.items.length === 0) {
    useTranscriptPaging.setState({ ...EMPTY, target });
    return;
  }
  useTranscriptPaging.setState({
    sessionId: ev.sessionId,
    start: ev.start,
    oldestAt: ev.items[0]!.at,
    loading: false,
    error: null,
    rowIds: rowIdsOf(ev.items, ev.start, chat),
    target,
  });
}

/** [이전 대화 더 보기]: the `limit` rows before the oldest shown one, put above it. */
export async function loadOlderRows(limit = PAGE_ROWS, request: typeof engineRequest = engineRequest): Promise<boolean> {
  const p = useTranscriptPaging.getState();
  if (p.loading || p.sessionId === null || p.start === null || p.start <= 0) return false;
  const sessionId = p.sessionId;
  useTranscriptPaging.setState({ loading: true, error: null });
  try {
    const reply = await request({ type: "transcript_page", sessionId, before: p.start, ...(p.oldestAt ? { beforeAt: p.oldestAt } : {}), limit });
    // Another chat (or project) came meanwhile: its rows are not these.
    if (useTranscriptPaging.getState().sessionId !== sessionId || reply.sessionId !== sessionId) {
      useTranscriptPaging.setState({ loading: false });
      return false;
    }
    const older = chatItemsOfRows(reply.items, useStore.getState().state.budget);
    useStore.setState((s) => ({ transcript: insertOlder(s.transcript, older) }));
    useTranscriptPaging.setState((s) => ({
      start: reply.start,
      oldestAt: reply.items[0]?.at ?? s.oldestAt,
      loading: false,
      rowIds: { ...rowIdsOf(reply.items, reply.start, older), ...s.rowIds },
    }));
    return true;
  } catch (e) {
    const r = refusalOf(e);
    useTranscriptPaging.setState({ loading: false, error: r.code === "unknown_command" ? t("This engine cannot load earlier messages") : t("Could not load earlier messages") });
    return false;
  }
}

/** A search match to scroll to once its chat's rows are shown (loads the rows above when it is further up). */
export function jumpToRow(sessionId: string, row: number, now = Date.now()): void {
  useTranscriptPaging.setState((s) => ({ target: { sessionId, row, nonce: (s.target?.nonce ?? 0) + 1, at: now } }));
}

/** How long a jump waits for its chat's rows (a chat that never says where they start — an older engine — leaves none). */
export const JUMP_WAIT_MS = 15_000;

/** The jump waited too long for its chat. */
export function jumpExpired(p: TranscriptPaging, now = Date.now()): boolean {
  return p.target !== null && now - p.target.at > JUMP_WAIT_MS;
}

/** The item a pending jump lands on; `load`: how many rows above have to come first (0: none / out of reach). */
export function jumpState(p: TranscriptPaging): { itemId: number | null; load: number } {
  const target = p.target;
  if (!target || target.sessionId !== p.sessionId || p.start === null) return { itemId: null, load: 0 };
  const id = p.rowIds[target.row];
  if (id !== undefined) return { itemId: id, load: 0 };
  if (target.row < p.start) return { itemId: null, load: Math.min(MAX_JUMP_ROWS, Math.max(PAGE_ROWS, p.start - target.row + 1)) };
  return { itemId: null, load: 0 };
}

/** The ordinal of item `id` among the transcript's user / assistant items (their rows' DOM order). */
export function messageOrdinal(transcript: readonly ChatItem[], id: number): number {
  let n = 0;
  for (const c of transcript) {
    if (c.kind !== "user" && c.kind !== "assistant") continue;
    if (c.id === id) return n;
    n++;
  }
  return -1;
}

export function clearJump(): void {
  useTranscriptPaging.setState({ target: null });
}

/** `transcript_search` → its matches; null when the engine cannot search messages (before §38.3) or refused. */
export async function searchMessages(query: string, request: typeof engineRequest = engineRequest): Promise<TranscriptSearchMatch[] | null> {
  try {
    return (await request({ type: "transcript_search", query, perChat: SEARCH_PER_CHAT })).matches; // MARK: wave4c w4c-review — §41.3
  } catch {
    return null;
  }
}
