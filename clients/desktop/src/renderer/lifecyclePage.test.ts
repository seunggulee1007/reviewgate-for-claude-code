// MARK: polish p-lifecycle — P1-chrome-09: the menu bar's Review and Chat items follow the window (what the page tells main),
// and a click on an item whose key the page handles presses that key.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReviewState } from "@reviewgate/engine";
import { NOTHING_ENABLED } from "../shared/menuState";

type Page = typeof import("./lifecyclePage");
let page: Page;

beforeAll(async () => {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, dispatchEvent: () => true };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
  };
  page = await import("./lifecyclePage");
});
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
});

const file = (path: string, state: "pending" | "accepted") => ({ path, state, status: "M", added: 1, deleted: 0, tools: [] });
function facts(o: { phase?: string; files?: ReturnType<typeof file>[]; selected?: string | null; tab?: string; project?: boolean } = {}) {
  const state = {
    project: o.project === false ? null : { path: "/work/acme-api", root: "/work/acme-api", name: "acme-api", branch: "main" },
    gate: { phase: o.phase ?? "reviewing", canSend: true, pendingCount: 0 },
    changedFiles: o.files ?? [],
    reviewNotes: [],
    branches: { isWorktreeDirty: false },
    session: { open: true },
    sessions: { list: [], currentId: "c1", openTabIds: ["c1"] },
  } as unknown as ReviewState;
  return { state, selectedPath: o.selected ?? null, tab: o.tab ?? "changes", ui: {}, historyView: null } as unknown as Parameters<Page["menuEnabledOf"]>[0];
}

describe("what the menu items can do (P1-chrome-09)", () => {
  it("nothing without a project", () => {
    expect(page.menuEnabledOf(facts({ project: false }))).toEqual(NOTHING_ENABLED);
  });

  it("accept / reject need the selected file pending; the bulk items any pending file; Stop a running turn", () => {
    const idle = page.menuEnabledOf(facts({ files: [file("a.ts", "pending"), file("b.ts", "accepted")], selected: "a.ts" }));
    expect(idle).toMatchObject({ accept: true, pending: true, acceptAll: true, rejectAll: true, finishReview: true, stop: false });
    const onAccepted = page.menuEnabledOf(facts({ files: [file("a.ts", "pending"), file("b.ts", "accepted")], selected: "b.ts" }));
    expect(onAccepted).toMatchObject({ accept: false, reject: false, pending: true });
    const running = page.menuEnabledOf(facts({ phase: "running", files: [file("a.ts", "pending")], selected: "a.ts" }));
    expect(running).toMatchObject({ stop: true, finishReview: false, createPR: false });
  });

  it("is sent when it changes, at most every delay", () => {
    vi.useFakeTimers();
    let current = facts();
    const listeners: ((s: typeof current, p: typeof current) => void)[] = [];
    const sent: unknown[] = [];
    const off = page.reportMenuState({ getState: () => current, subscribe: (l) => (listeners.push(l), () => undefined) }, (m) => sent.push(m), 100);
    expect(sent).toHaveLength(1);
    const prev = current;
    current = facts({ phase: "running" });
    listeners.forEach((l) => l(current, prev));
    listeners.forEach((l) => l(current, prev));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ stop: true });
    // The same again: nothing sent.
    listeners.forEach((l) => l(facts({ phase: "running" }), current));
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    off();
    vi.useRealTimers();
  });
});

describe("a click presses the page's own key", () => {
  it("dispatches the key on the document — Ctrl on Windows, ⌘ on a Mac", async () => {
    class FakeKey {
      constructor(
        public type: string,
        init: Record<string, unknown>,
      ) {
        Object.assign(this, init);
      }
    }
    vi.stubGlobal("KeyboardEvent", FakeKey);
    const seen: Record<string, unknown>[] = [];
    vi.stubGlobal("document", { dispatchEvent: (e: Record<string, unknown>) => (seen.push(e), true) });
    const { pressKey, lifecycleMenuActions } = await import("./menuActions.lifecycle");
    pressKey({ key: "R", code: "KeyR", shift: true }, false);
    pressKey({ key: "/", code: "Slash", alt: true }, true);
    lifecycleMenuActions.chat_tab?.({ type: "chat_tab", index: 2 });
    expect(seen.map((e) => [e["type"], e["code"], e["ctrlKey"], e["metaKey"], e["shiftKey"], e["altKey"]])).toEqual([
      ["keydown", "KeyR", true, false, true, false],
      ["keydown", "Slash", false, true, false, true],
      ["keydown", "Digit3", true, false, false, false],
    ]);
    vi.unstubAllGlobals();
  });
});
