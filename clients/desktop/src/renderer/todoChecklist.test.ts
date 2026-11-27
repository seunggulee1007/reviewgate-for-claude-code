// docs/PROTOCOL.md §71.2: Ctrl+Shift+L / `/todos` — Claude's to-do checklist over the message box. As Core TodoChecklistTests.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TodoItem } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { parseSlashAppCommand, TERMINAL_ONLY } from "./slashAppCommands";
import { isTodosKey, shownText, showTodos, todoBlocker, todoProgress, todosOf, todoWindow, toggleTodos, useTodoPanel } from "./todoChecklist";

beforeAll(() => initI18n("en", "win32"));
beforeEach(() => useTodoPanel.setState({ shown: true }));

const item = (text: string, status: TodoItem["status"], activeForm?: string): TodoItem => ({ text, status, ...(activeForm ? { activeForm } : {}) });

describe("§71.2 the checklist", () => {
  it("reads the state; an older engine has none", () => {
    expect(todosOf({ todos: [item("a", "pending")] })).toEqual([item("a", "pending")]);
    expect(todosOf({ todos: [] })).toEqual([]);
    expect(todosOf({})).toBeNull();
    expect(shownText(item("Fix it", "in_progress", "Fixing it"))).toBe("Fixing it");
    expect(shownText(item("Fix it", "completed", "Fixing it"))).toBe("Fix it");
    expect(todoProgress([item("a", "completed"), item("b", "pending")])).toBe("1 of 2 done");
  });

  it("shows five at a time, from one before the first open item", () => {
    const all = Array.from({ length: 8 }, (_, i) => item(`step ${i + 1}`, i < 4 ? "completed" : i === 4 ? "in_progress" : "pending"));
    const w = todoWindow(all);
    expect(w.items.map((x) => x.text)).toEqual(["step 4", "step 5", "step 6", "step 7", "step 8"]);
    expect([w.before, w.after]).toEqual([3, 0]);
    expect(todoWindow(all.map((x) => ({ ...x, status: "pending" as const })))).toMatchObject({ before: 0, after: 3 });
    expect(todoWindow(all.slice(0, 3))).toMatchObject({ before: 0, after: 0 });
  });

  it("Ctrl+Shift+L — never Ctrl+T (New Chat), never mid-composition", () => {
    const k = { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    expect(isTodosKey(k)).toBe(true);
    expect(isTodosKey({ ...k, key: "ㅣ" })).toBe(true); // a Korean layout: the physical L
    expect(isTodosKey({ ...k, shiftKey: false })).toBe(false);
    expect(isTodosKey({ ...k, key: "t", code: "KeyT", shiftKey: false })).toBe(false);
    expect(isTodosKey({ ...k, isComposing: true })).toBe(false);
  });

  it("toggles and shows, and says why not", () => {
    const todos = [item("a", "pending")];
    expect(toggleTodos(todos, null)).toEqual({ notice: "To-do checklist hidden — Ctrl+Shift+L shows it", warning: false });
    expect(useTodoPanel.getState().shown).toBe(false);
    expect(toggleTodos([], null).notice).toContain("no to-do list");
    expect(useTodoPanel.getState().shown).toBe(true);
    useTodoPanel.setState({ shown: false });
    expect(showTodos(todos, null)).toBeNull();
    expect(useTodoPanel.getState().shown).toBe(true);
    expect(todoBlocker({ todos: null, terminalChat: false, viewing: false })).toContain("update ReviewGate");
    expect(todoBlocker({ todos, terminalChat: false, viewing: true })).toContain("running chat");
    expect(toggleTodos(todos, "why")).toEqual({ notice: "why", warning: true });
    expect(useTodoPanel.getState().shown).toBe(true); // a refusal changes nothing
  });

  it("/todos is the app's own command now", () => {
    expect(parseSlashAppCommand("/todos", [])).toEqual({ kind: "todos" });
    expect(TERMINAL_ONLY.has("todos")).toBe(false);
  });
});
