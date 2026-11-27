/**
 * docs/PROTOCOL.md §71.2: Claude's to-do checklist over the message box, live (`state.session.todos`). Ctrl+Shift+L in
 * the box and `/todos` show or hide it, as Ctrl+T in Claude Code (Ctrl+T stays New Chat here); the choice is kept with
 * the app (localStorage). components/chat/TodoChecklist.tsx draws it. As the Mac's Core TodoChecklist.swift.
 */
import { create } from "zustand";
import type { SessionState, TodoItem } from "@reviewgate/engine";
import { t } from "./i18n";

/** Claude's checklist in the current chat; null from an engine without §71.2. */
export const todosOf = (session: Pick<SessionState, "todos">): TodoItem[] | null => (Array.isArray(session.todos) ? session.todos : null);

/** What a row says: the running words while it runs, else its text. */
export const shownText = (item: TodoItem): string => (item.status === "in_progress" && item.activeForm ? item.activeForm : item.text);

export const TODO_LIMIT = 5;

/** At most five at a time, as the terminal: from one item before the first one not done; the counts left out around them. */
export function todoWindow(all: readonly TodoItem[], limit = TODO_LIMIT): { items: TodoItem[]; before: number; after: number } {
  if (all.length <= limit) return { items: [...all], before: 0, after: 0 };
  const open = all.findIndex((i) => i.status !== "completed");
  const firstOpen = open < 0 ? all.length : open;
  const start = Math.max(0, Math.min(firstOpen - 1, all.length - limit));
  return { items: all.slice(start, start + limit), before: start, after: all.length - start - limit };
}

export const todoProgress = (all: readonly TodoItem[]): string => t("{0} of {1} done", all.filter((i) => i.status === "completed").length, all.length);

/** Why the key and `/todos` show nothing now; null: they can. */
export function todoBlocker(p: { todos: TodoItem[] | null; terminalChat: boolean; viewing: boolean }): string | null {
  if (p.todos === null) return t("This engine has no to-do checklist — update ReviewGate");
  if (p.terminalChat) return t("A terminal chat has its own Ctrl+T");
  if (p.viewing) return t("Go back to the running chat to see Claude's checklist");
  return null;
}

/** Ctrl+Shift+L (the physical L; never mid-composition). */
export const isTodosKey = (e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }): boolean =>
  !e.isComposing && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyL" || e.key.toLowerCase() === "l");

export const TODOS_KEY_LABEL = "Ctrl+Shift+L";

const STORE_KEY = "reviewgate.todoListShown";

function readShown(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(STORE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The panel is shown (on until the user hides it, as the terminal restores the view it was left in). */
export const useTodoPanel = create<{ shown: boolean; setShown(on: boolean): void }>((set) => ({
  shown: readShown(),
  setShown: (on) => {
    try {
      localStorage.setItem(STORE_KEY, on ? "1" : "0");
    } catch {
      /* the choice holds for this window only */
    }
    set({ shown: on });
  },
}));

/** The key: shown ↔ hidden — the line under the box says which, or why nothing shows. */
export function toggleTodos(todos: TodoItem[] | null, blocker: string | null): { notice: string; warning: boolean } {
  if (blocker !== null) return { notice: blocker, warning: true };
  const show = !useTodoPanel.getState().shown;
  useTodoPanel.getState().setShown(show);
  if (show && (todos ?? []).length === 0) return { notice: noTodosText(), warning: false };
  return { notice: show ? t("To-do checklist shown — {0} hides it", TODOS_KEY_LABEL) : t("To-do checklist hidden — {0} shows it", TODOS_KEY_LABEL), warning: false };
}

/** `/todos`: shown (it says so when Claude has none yet); null when there is nothing to say. */
export function showTodos(todos: TodoItem[] | null, blocker: string | null): { notice: string; warning: boolean } | null {
  if (blocker !== null) return { notice: blocker, warning: true };
  useTodoPanel.getState().setShown(true);
  return (todos ?? []).length === 0 ? { notice: noTodosText(), warning: false } : null;
}

export const noTodosText = (): string =>
  t("Claude has no to-do list in this chat yet — it makes one for work in several steps (on models with the to-do tools)");

/** The palette's line for `/todos`. */
export const todosDescription = (): string => t("Show Claude's to-do checklist for this chat ({0})", TODOS_KEY_LABEL);

export const statusLabel = (s: TodoItem["status"]): string => (s === "completed" ? t("Done") : s === "in_progress" ? t("In progress") : t("Pending"));
