/**
 * r2-chats-cards — polish PX-19 / P4-composer-34 / P4-composer-08, as on the Mac (ChatCommands.swift `ClosedChatTabs`,
 * ChatTabs.swift): the chats whose tabs were closed in this window (Ctrl/⌘+Shift+T reopens the last one; for 3 s the strip
 * says "탭을 닫았어요 · 다시 열기"), the next / previous tab (Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / PgUp; ⌃⇥ on a Mac),
 * and which chats hold an unsent draft (their tab's ✎). Pure helpers plus one small store of its own (never store.ts).
 */
import { create } from "zustand";

export const CLOSED_TABS_LIMIT = 20;

export const useClosedTabs = create<{ ids: string[]; justClosed: string | null }>(() => ({ ids: [], justClosed: null }));

/** `id`'s tab was closed: remembered last (once), the oldest dropped past the limit. */
export function rememberClosedTab(id: string): void {
  useClosedTabs.setState((s) => ({ ids: [...s.ids.filter((x) => x !== id), id].slice(-CLOSED_TABS_LIMIT), justClosed: id }));
}

/** The last closed chat that still exists (it leaves the stack); null when none is left. */
export function takeClosedTab(exists: (id: string) => boolean): string | null {
  const ids = [...useClosedTabs.getState().ids];
  let found: string | null = null;
  while (ids.length > 0 && found === null) {
    const id = ids.pop()!;
    if (exists(id)) found = id;
  }
  useClosedTabs.setState({ ids, justClosed: null });
  return found;
}

/** The tab after / before `shown` in `ids`, around the ends; null with fewer than two tabs. */
export function stepTab(ids: string[], shown: string | null, by: number): string | null {
  if (ids.length < 2) return null;
  const at = shown ? Math.max(0, ids.indexOf(shown)) : 0;
  return ids[(at + by + ids.length) % ids.length] ?? null;
}

/** The key that steps through the tabs: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp (the Mac's ⌃⇥ is Ctrl+Tab too). */
export function tabStepKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): 1 | -1 | null {
  if (!e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Tab") return e.shiftKey ? -1 : 1;
  if (e.shiftKey) return null;
  if (e.key === "PageDown") return 1;
  if (e.key === "PageUp") return -1;
  return null;
}

/** Ctrl/⌘+Shift+T: reopen the last closed chat tab. */
export function isReopenTabKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "t";
}

/** ⌘Y / Ctrl+H: the chat history (the Mac's Chat › 채팅 기록…; a browser's history key on each platform). */
export function isHistoryKey(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (mac) return e.metaKey && !e.ctrlKey && (e.code === "KeyY" || e.key.toLowerCase() === "y");
  return e.ctrlKey && !e.metaKey && (e.code === "KeyH" || e.key.toLowerCase() === "h");
}
