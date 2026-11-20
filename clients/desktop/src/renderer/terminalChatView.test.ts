/**
 * §57.5 / §57.10 (plan §4.2): a terminal chat's column rendered to static HTML (as the card tests do) — the strip, its
 * buttons' names and tooltips, the start problem, the read-only placeholder, the tab's glyph — and the pure rules of
 * terminalChat.ts (which chat is a terminal chat, the attention a wait raises).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewState, TerminalSessionState } from "@reviewgate/engine";
import { initI18n } from "./i18n";

async function load() {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { dataset: {} },
    hasFocus: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ className: "", isConnected: false, remove: () => undefined, contains: () => false }),
    querySelector: () => null,
  };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  const ChatPane = (await import("./components/chat/ChatPane")).default;
  const chat = await import("./terminal/terminalChat");
  const host = await import("./terminal/termHost");
  const viewed = await import("./viewedChat");
  const tab = await import("./tabAttention");
  return { useStore, ChatPane, chat, host, viewed, tab };
}

/** Server rendering reads a store's initial state (zustand's getServerSnapshot): set both. */
function put<T extends object>(store: { getInitialState(): T; setState(p: Partial<T>): void }, patch: Partial<T>): void {
  Object.assign(store.getInitialState(), patch);
  store.setState(patch);
}

const term = (over: Partial<TerminalSessionState> = {}): TerminalSessionState => ({ running: true, hooksSeen: false, promptId: null, waiting: null, interruptSuspected: false, ...over });

describe("terminal chat column (§57.5)", () => {
  let m: Awaited<ReturnType<typeof load>>;
  const setState = (session: Partial<ReviewState["session"]>, currentId = "t1") => {
    const init = m.useStore.getInitialState();
    put(m.useStore, {
      state: {
        ...init.state,
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
        sessions: {
          list: [
            { id: "t1", title: "Terminal one", kind: "terminal" },
            { id: "c1", title: "Classic one" },
          ],
          currentId,
          openTabIds: ["t1", "c1"],
        },
        session: { ...init.state.session, ...session },
      } as unknown as ReviewState,
    });
  };
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
    m.host.setTerminalLoader(() => new Promise(() => undefined)); // never loads: the markup only
  });

  it("shows the strip over the terminal: the trust hint first, Find and Restart named", () => {
    setState({ terminal: term() });
    m.host.adoptTerminal("p1", "chat", { sessionId: "t1" });
    put(m.chat.useTerminalChats, { bySession: { t1: { ptyId: "p1", opening: false, failed: null, startedAt: Date.now() } } });
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).toContain('data-testid="Terminal chat"');
    expect(out).toContain("If Claude Code asks whether to trust this folder, choose Yes");
    expect(out).toContain("Trust this folder? Choose Yes");
    expect(out).toContain("Ctrl+L redraws it");
    expect(out).toContain('aria-label="Restart Claude Code"');
    expect(out).toContain('title="Restart Claude Code in this terminal — the conversation is resumed; text typed and not sent is lost"');
    expect(out).toContain('aria-label="Find in terminal"');
    expect(out).toContain('aria-label="Terminal chat — Claude Code itself runs in this chat"');
    // No composer, no transcript in a terminal chat.
    expect(out).not.toContain('data-testid="Composer"');
    expect(out).not.toContain("Review now");
    expect(out).not.toContain('data-testid="Terminal chat overlay"');
  });

  it("Review now after Esc; the waits in words", () => {
    setState({ terminal: term({ hooksSeen: true, interruptSuspected: true }) });
    const s0 = m.useStore.getInitialState();
    put(m.useStore, { state: { ...s0.state, gate: { ...s0.state.gate, phase: "running" } } });
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).toContain("Review now");
    expect(out).toContain("End this turn and review its changes now");
    setState({ terminal: term({ hooksSeen: true, waiting: { kind: "question", message: "Which file?", since: "2026-11-20T01:00:00Z" } }) });
    expect(renderToStaticMarkup(createElement(m.ChatPane))).toContain("Claude Code asked you a question in the terminal");
  });

  it("the tab carries the terminal glyph", () => {
    setState({ terminal: term() });
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).toContain('data-testid="Chat tab terminal"');
    expect(out).toContain('title="Terminal chat — Claude Code itself runs in this chat"');
    expect((out.match(/data-testid="Chat tab terminal"/g) ?? []).length).toBe(1);
  });

  it("an engine refusal: why, and Try Again with its tooltip", () => {
    setState({ terminal: null });
    put(m.chat.useTerminalChats, { bySession: { t1: { ptyId: null, opening: false, failed: "Terminal chats need Claude Code 2.1.295 or later — update it with `claude update`", startedAt: 0 } } });
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).toContain("Claude Code could not start here");
    expect(out).toContain("2.1.295");
    expect(out).toContain("Try Again");
    expect(out).toContain("Ask ReviewGate&#x27;s engine again how to start Claude Code for this chat");
    expect(out).toContain('data-testid="Chat tab terminal stopped"');
  });

  it("starting: a spinner and words", () => {
    setState({ terminal: null });
    put(m.chat.useTerminalChats, { bySession: { t1: { ptyId: null, opening: true, failed: null, startedAt: 0 } } });
    expect(renderToStaticMarkup(createElement(m.ChatPane))).toContain("Starting Claude Code…");
  });

  it("a terminal chat shown read-only: no terminal, continue in it", () => {
    setState({}, "c1");
    put(m.viewed.useViewedChat, { chat: { id: "t1", liveId: "c1", items: [], start: null, oldestAt: null, loading: false, error: null } });
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).toContain('data-testid="Viewed terminal chat"');
    expect(out).toContain("This chat runs Claude Code in a terminal");
    expect(out).toContain("Continue in this chat");
    expect(out).not.toContain('data-testid="Terminal chat terminal"');
    put(m.viewed.useViewedChat, { chat: null });
  });

  it("a classic chat keeps its transcript and composer", () => {
    setState({}, "c1");
    const out = renderToStaticMarkup(createElement(m.ChatPane));
    expect(out).not.toContain('data-testid="Terminal chat"');
  });
});

describe("terminalChat rules", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  const state = (currentId: string, terminal: TerminalSessionState | null = null) =>
    ({
      sessions: { list: [{ id: "t1", title: "T", kind: "terminal" }, { id: "c1", title: "C" }], currentId, openTabIds: [] },
      session: { terminal },
      gate: { phase: "idle", pendingCount: 0 },
    }) as unknown as ReviewState;

  it("which chat is a terminal chat", () => {
    expect(m.chat.chatKindOf(state("t1"), "t1")).toBe("terminal");
    expect(m.chat.chatKindOf(state("t1"), "c1")).toBe("chat");
    expect(m.chat.chatKindOf(state("t1"), "gone")).toBe("chat");
    expect(m.chat.liveTerminalChatId(state("t1"))).toBe("t1");
    expect(m.chat.liveTerminalChatId(state("c1"))).toBeNull();
  });

  it("a wait raises one attention per wait, in the Mac's words", () => {
    const waiting = { kind: "permission" as const, message: "Bash: npm run build", since: "2026-11-20T01:02:03Z" };
    const a = m.chat.terminalWaitingAttention(waiting, "t1");
    expect(a).toEqual({ kind: "permission", headline: "Permission needed in the terminal", body: "Permission needed in the terminal — Bash: npm run build", key: "term:t1:2026-11-20T01:02:03Z" });
    expect(m.chat.terminalWaitingAttention({ ...waiting, kind: "question", message: "x".repeat(300) }, "t1").body.length).toBeLessThan(220);
    expect(m.chat.terminalWaitingOf(state("t1", term({ waiting })))).toEqual(waiting);
    expect(m.chat.terminalWaitingOf(state("c1", term({ waiting })))).toBeNull();
  });

  it("the Changes tab's dot says Claude Code waits", () => {
    const s = state("t1", term({ waiting: { kind: "question", message: "?", since: "x" } }));
    expect(m.tab.changesStatus(s)).toEqual({ kind: "waiting", reason: "question" });
  });
});
