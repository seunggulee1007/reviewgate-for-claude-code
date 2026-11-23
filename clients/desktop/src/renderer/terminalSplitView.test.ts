/**
 * §57.5 / plan §4.3: the terminal-first window — the review panel's collapse rule for a terminal chat, its edge tab's
 * words, and the reopen on each review.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

// The review panes themselves (Monaco) are not what this file tests.
vi.mock("./components/diff/DiffPane", () => ({ default: () => null }));
vi.mock("./components/diff/LiveDiffPane", () => ({ LiveDiffPane: () => null }));
vi.mock("./components/history/HistoryDiffPane", () => ({ HistoryDiffPane: () => null }));
vi.mock("./nav/ProjectFilePane", () => ({ ProjectFilePane: () => null })); // §62 (Monaco)
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState } from "@reviewgate/engine";
import { initI18n } from "./i18n";
import { reviewPanelCollapsed } from "./friction";

async function load() {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { dataset: {} },
    hasFocus: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ className: "", isConnected: false, remove: () => undefined, contains: () => false, getContext: () => null }),
    querySelector: () => null,
  };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  const { TerminalSplit, reopensReviewPanel } = await import("./components/terminal/TerminalSplit");
  return { useStore, TerminalSplit, reopensReviewPanel };
}

function put<T extends object>(store: { getInitialState(): T; setState(p: Partial<T>): void }, patch: Partial<T>): void {
  Object.assign(store.getInitialState(), patch);
  store.setState(patch);
}

const gate = (pendingCount: number, phase = "idle") => ({ pendingCount, phase }) as unknown as ReviewState["gate"];

describe("the review panel's collapse rule", () => {
  const s = (pending: number, changed = 0) => ({ gate: gate(pending), changedFiles: Array.from({ length: changed }, () => ({})) }) as unknown as ReviewState;
  it("a terminal chat: collapsed while nothing is pending, whatever is selected", () => {
    expect(reviewPanelCollapsed(s(0, 3), {}, "a.ts", true)).toBe(true);
    expect(reviewPanelCollapsed(s(2, 3), {}, null, true)).toBe(false);
  });
  it("the user's ⌘⇧D choice wins", () => {
    expect(reviewPanelCollapsed(s(2), { diffCollapsed: true }, null, true)).toBe(true);
    expect(reviewPanelCollapsed(s(0), { diffCollapsed: false }, null, true)).toBe(false);
  });
  it("a chat keeps the diff pane's rule (changed files or a selection)", () => {
    expect(reviewPanelCollapsed(s(0, 3), {}, null, false)).toBe(false);
    expect(reviewPanelCollapsed(s(0, 0), {}, null, false)).toBe(true);
  });
});

describe("the terminal split", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
    const init = m.useStore.getInitialState();
    put(m.useStore, {
      state: {
        ...init.state,
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
        sessions: { list: [{ id: "t1", title: "Terminal", kind: "terminal" }], currentId: "t1", openTabIds: ["t1"] },
        gate: { ...init.state.gate, pendingCount: 0 },
      } as unknown as ReviewState,
    });
  });

  it("nothing pending: the terminal takes the width; the edge tab says where the panel would open", () => {
    const out = renderToStaticMarkup(createElement(m.TerminalSplit));
    expect(out).toContain('data-testid="Terminal split"');
    expect(out).toContain('aria-expanded="false"');
    // Before the first measure the area is 0 px: too narrow to sit side by side.
    expect(out).toContain("Show the review panel over the terminal, next to the file list — the window is too narrow for both side by side (Ctrl+Shift+D)");
    expect(out).not.toContain('data-testid="Review drawer"');
    expect(out).not.toContain('data-testid="Review panel"');
    expect(out).toContain('data-testid="Terminal chat starting"');
  });

  it("a ⌘⇧D collapse lasts until the live terminal chat's next review", () => {
    const base = m.useStore.getState().state;
    const at = (phase: string, pendingCount: number, currentId = "t1") =>
      ({ ...base, gate: { ...base.gate, phase, pendingCount }, sessions: { ...base.sessions!, currentId } }) as ReviewState;
    const collapsed = { diffCollapsed: true };
    expect(m.reopensReviewPanel(at("collecting", 0), at("reviewing", 2), collapsed)).toBe(true);
    // Not without files, not twice in the same review, not when the user left it open, not for a chat.
    expect(m.reopensReviewPanel(at("collecting", 0), at("reviewing", 0), collapsed)).toBe(false);
    expect(m.reopensReviewPanel(at("reviewing", 2), at("reviewing", 1), collapsed)).toBe(false);
    expect(m.reopensReviewPanel(at("collecting", 0), at("reviewing", 2), {})).toBe(false);
    expect(m.reopensReviewPanel(at("collecting", 0, "c9"), at("reviewing", 2, "c9"), collapsed)).toBe(false);
  });
});
