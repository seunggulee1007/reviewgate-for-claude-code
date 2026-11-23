import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState, SessionMeta } from "@reviewgate/engine";
import { initI18n } from "./i18n";

// MARK: task-start — docs/PROTOCOL.md §63.4 / §63.3 on Windows: the start screen's three choices, its recent chats and its
// checkbox, and the task dialog's fields — rendered to static HTML with the stores' initial state as the scene.

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined, activeElement: null };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  const { useStore } = await import("./store");
  const { useStartScreen } = await import("./startScreen");
  const { StartScreen } = await import("./components/start/StartScreen");
  const { TaskStartDialog } = await import("./components/start/TaskStartDialog");
  return { useStore, useStartScreen, StartScreen, TaskStartDialog };
}

const meta = (id: string, title: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, title, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", turns: 2, costUSD: 0, lastUserText: "Fix the cart", ...over }) as SessionMeta;

describe("the start screen and the task dialog (§63)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  afterAll(() => initI18n("en", "darwin"));

  const scene = (list: SessionMeta[], over: Partial<ReviewState> = {}) => {
    const init = m.useStore.getInitialState();
    Object.assign(init, {
      settings: { skipStartScreen: false },
      state: {
        ...init.state,
        project: { path: "C:\\work\\acme", root: "C:\\work\\acme", name: "acme", branch: "main", remoteURL: null },
        sessions: { list, currentId: list[0]?.id ?? null, openTabIds: [] },
        ...over,
      },
    });
    Object.assign(m.useStartScreen.getInitialState(), { shown: true, mark: { choice: 1 } });
  };

  it("three choices, the recent chats (kind, title, the open one) and the checkbox", () => {
    scene([meta("s1", "Cart total"), meta("s2", "Login", { kind: "terminal", updatedAt: "2026-01-01T00:00:00Z" })]);
    const out = renderToStaticMarkup(createElement(m.StartScreen));
    for (const n of [1, 2, 3]) expect(out).toContain(`data-testid="Start choice ${n}"`);
    expect(out).toContain("How do you want to start?");
    expect(out).toContain("Start now");
    expect(out).toContain("A task&#x27;s branch and first prompt");
    expect(out.match(/data-testid="Start recent chat"/g)).toHaveLength(2);
    expect(out).toContain("Terminal chat");
    expect(out).toContain("Open now");
    expect(out).toContain('data-testid="Skip the start screen"');
    expect(out).toContain("Start straight away next time");
    expect(out).toContain("1 · 2 · 3, ↑ ↓ Enter — Esc starts now"); // Windows keys
    expect(out).toMatch(/class="start-card marked"[^>]*data-testid="Start choice 1"/);
  });

  it("without earlier chats 대화로 열기 is off, with its reason; a folder without git starts here", () => {
    scene([meta("s1", "New chat", { turns: 0, lastUserText: null })], { project: { path: "C:\\work\\notes", root: "C:\\work\\notes", name: "notes", branch: null, remoteURL: null, vcs: "shadow" } as ReviewState["project"] });
    const out = renderToStaticMarkup(createElement(m.StartScreen));
    expect(out).toMatch(/disabled=""[^>]*title="This project has no earlier chats"/);
    expect(out).not.toContain("Recent chats");
    expect(out).toContain("From a task, in this folder");
    const dialog = renderToStaticMarkup(createElement(m.TaskStartDialog, { onClose: () => undefined }));
    expect(dialog).toContain("Start in This Folder");
    expect(dialog).not.toContain('data-testid="Task branch"');
  });

  it("the task dialog: the field, the branch, where it starts, the first prompt and Start off with its reason", () => {
    scene([meta("s1", "Cart total")]);
    const out = renderToStaticMarkup(createElement(m.TaskStartDialog, { onClose: () => undefined }));
    expect(out).toContain('data-testid="Task reference"');
    expect(out).toContain("ACME-123 · #42 · https://tracker.example.com/task/123");
    expect(out).toContain("A task id or link — set the platform in Settings › Tasks");
    expect(out).toContain('data-testid="Task branch"');
    expect(out).toContain("A new branch in this window");
    expect(out).toContain("A new workbench");
    expect(out).toContain("Goes into the message box — you send it");
    expect(out).toMatch(/disabled=""[^>]*title="Enter a task id or link"[^>]*data-testid="Task start"/);
    expect(out).toContain("Create Branch and Start");
    expect(out).toContain('data-testid="Task settings"');
  });
});
