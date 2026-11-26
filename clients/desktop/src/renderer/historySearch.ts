/**
 * docs/PROTOCOL.md §70.1 on Windows (pure, unit-tested): Ctrl+R in the message box searches this project's prompt history
 * (src/renderer/promptHistory.ts), as Ctrl+R does in Claude Code — type to filter, Ctrl+R again (or ↑) for the next older
 * match, ↓ back to a newer one, Enter or Tab puts the match into the box (never sends), Esc (or Backspace in an empty
 * search) gives the draft back. As on the Mac (Core PromptHistorySearch.swift).
 */
import { t } from "./i18n";

/** One open search: the prompts (oldest first), the draft before Ctrl+R, what is typed, and how many newer matches were stepped over. */
export type HistorySearch = { entries: readonly string[]; original: string; query: string; skip: number };

export const startHistorySearch = (entries: readonly string[], original: string): HistorySearch => ({ entries, original, query: "", skip: 0 });

/** The entries containing the query (case-insensitive), newest first, as indexes; none while nothing is typed. */
export function searchMatches(s: HistorySearch): number[] {
  const q = s.query.toLowerCase();
  if (q === "") return [];
  const out: number[] = [];
  for (let i = s.entries.length - 1; i >= 0; i--) if (s.entries[i]!.toLowerCase().includes(q)) out.push(i);
  return out;
}

/** The match on show; null while nothing is typed or nothing matches. */
export function searchMatch(s: HistorySearch): string | null {
  const list = searchMatches(s);
  return list.length === 0 ? null : s.entries[list[Math.min(s.skip, list.length - 1)]!]!;
}

/** Something is typed and no prompt has it. */
export const searchFailing = (s: HistorySearch): boolean => s.query !== "" && searchMatches(s).length === 0;

/** The match's place among the matches (1 = the newest); null without one. */
export function searchPosition(s: HistorySearch): { index: number; count: number } | null {
  const count = searchMatches(s).length;
  return count === 0 ? null : { index: Math.min(s.skip, count - 1) + 1, count };
}

/** The text changed: back to its newest match (the same text keeps the place). */
export const withQuery = (s: HistorySearch, query: string): HistorySearch => (query === s.query ? s : { ...s, query, skip: 0 });

/** Ctrl+R again / ↑: the next older match (stays at the oldest). */
export const searchOlder = (s: HistorySearch): HistorySearch => (s.skip + 1 < searchMatches(s).length ? { ...s, skip: s.skip + 1 } : s);

/** ↓: the next newer match (stays at the newest). */
export const searchNewer = (s: HistorySearch): HistorySearch => (s.skip > 0 ? { ...s, skip: s.skip - 1 } : s);

/** Enter / Tab: what the box gets — the match, or the draft as it was when nothing matched. */
export const searchAccepted = (s: HistorySearch): string => searchMatch(s) ?? s.original;

/** Where the query is in `text` (the first place, case-insensitive): [start, end), or null. */
export function searchHighlight(text: string, query: string): [number, number] | null {
  if (query === "") return null;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  return at < 0 ? null : [at, at + query.length];
}

/** What a key does in the search field (null: the field takes it — typing, the caret). */
export type SearchKeyAction = "older" | "newer" | "accept" | "cancel" | null;

export type SearchKeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean };

/** The R key on any layout (a Korean layout reads ㄱ). */
const isR = (e: SearchKeyLike): boolean => e.key.toLowerCase() === "r" || e.code === "KeyR";

/** The search field's keys; an input method's composition (Korean) keeps every key. `empty`: nothing typed in the field. */
export function searchKeyAction(e: SearchKeyLike, empty: boolean): SearchKeyAction {
  if (e.isComposing) return null;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && isR(e)) return "older";
  if (plain && !e.shiftKey && e.key === "ArrowUp") return "older";
  if (plain && !e.shiftKey && e.key === "ArrowDown") return "newer";
  if (plain && !e.shiftKey && (e.key === "Enter" || e.key === "Tab")) return "accept";
  if (e.key === "Escape") return "cancel";
  if (plain && e.key === "Backspace" && empty) return "cancel";
  return null;
}

/** Ctrl+R in the message box (not mid-composition): the search opens. */
export const isHistorySearchKey = (e: SearchKeyLike): boolean =>
  !e.isComposing && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && isR(e);

/**
 * Ctrl+R is also the View menu's "Refresh" accelerator. The message box handles it first (preventDefault); should the menu
 * still fire for the same press, its refresh is dropped (`historySearchKeyJustHandled`) — as Ctrl+B is (src/renderer/background.ts).
 */
let searchKeyAt = -Infinity;
export function noteHistorySearchKey(now = Date.now()): void {
  searchKeyAt = now;
}
export function historySearchKeyJustHandled(now = Date.now()): boolean {
  return now - searchKeyAt < 500;
}

// The bar's words.
export const searchPlaceholder = (): string => t("Search your prompts");
export const searchLabel = (): string => t("Prompt history search");
export function searchStatus(s: HistorySearch): string {
  if (s.entries.length === 0) return t("No prompts in this project yet");
  if (searchFailing(s)) return t("No prompt matches");
  return t("Type to search the prompts sent in this project");
}
export const searchHint = (): string => t("Ctrl+R older · Enter or Tab use · Esc cancel");
export const searchHelp = (): string =>
  t("Searches the prompts sent in this project, newest first: Ctrl+R or ↑ for an older match, ↓ for a newer one, Enter or Tab puts it into the message box, Esc gives your draft back");
