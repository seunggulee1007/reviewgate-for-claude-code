/**
 * §57.7 / §57.9 / §57.10 (plan §4.4 / §4.5): the ways into a terminal chat on Windows — the default kind behind
 * "Terminal chat (preview)", New Terminal Chat / New Chat (Classic) held while Claude works, Continue as Terminal Chat
 * with its blockers and refusals, the + button's words and menu, the record's bar, and Settings › Terminal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineCommand, ReviewState, SessionMeta } from "@reviewgate/engine";
import type { AppSettings, PtyInfo } from "../shared/ipc";
import { initI18n } from "./i18n";
import { continueAsTerminalBlocker, defaultChatKind, terminalChatsOffered } from "./continueTerminal";
import { terminalChatKey } from "./keymap";

const sent: EngineCommand[] = [];
let refuse: { code: string; error: string } | null = null;

let initialState: ReviewState | null = null;

async function load() {
  (globalThis as unknown as { document: unknown }).document = { documentElement: { dataset: {} }, hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: {
      send: (c: EngineCommand) => void sent.push(c),
      request: async () => ({}),
      requestDetailed: async (c: EngineCommand) => {
        sent.push(c);
        return refuse ? { ok: false, error: `${refuse.code}:${refuse.error}`, code: refuse.code } : { ok: true, reply: { type: "result", ok: true } };
      },
      notify: async () => true,
      onEvent: () => () => undefined,
      platform: "win32",
    },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  initialState ??= { ...useStore.getInitialState().state };
  const { usePtyInfo } = await import("./terminal/ptyInfo");
  const { usePendingSwitch } = await import("./pendingSwitch");
  const { ChatTabs } = await import("./components/chat/ChatTabs");
  const { MovedChatBar } = await import("./components/chat/ChatMoveViews");
  const { TerminalSettingsSection } = await import("./components/settings/TerminalSettings");
  return { useStore, usePtyInfo, usePendingSwitch, ChatTabs, MovedChatBar, TerminalSettingsSection };
}

const INFO: PtyInfo = { available: true, reason: null, osBuild: 22631, shells: ["powershell", "cmd"] };
const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({ id: "c1", title: "Pricing rules", turns: 3, cliKnown: true, ...over }) as SessionMeta;
const baseState = (over: Partial<ReviewState> = {}, phase = "idle"): ReviewState =>
  ({
    ...(initialState ?? {}),
    project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
    changedFiles: [],
    gate: { phase, collectError: null, pendingCount: 0 },
    session: { starting: false },
    sessions: { list: [meta(), meta({ id: "t1", title: "Terminal one", kind: "terminal" })], currentId: "c1", openTabIds: ["c1", "t1"] },
    ...over,
  }) as unknown as ReviewState;

describe("the default kind (§57.7 behind the preview)", () => {
  it("a terminal chat only while the preview is on, a PTY can run and New chats open as says Terminal", () => {
    expect(defaultChatKind({ terminalChatPreview: true, newChatKind: "terminal" }, true)).toBe("terminal");
    expect(defaultChatKind({ terminalChatPreview: true, newChatKind: "chat" }, true)).toBe("chat");
    expect(defaultChatKind({ terminalChatPreview: false, newChatKind: "terminal" }, true)).toBe("chat");
    expect(defaultChatKind({ terminalChatPreview: true, newChatKind: "terminal" }, false)).toBe("chat");
    expect(defaultChatKind(null, true)).toBe("chat");
    expect(terminalChatsOffered({}, true)).toBe(false);
  });

  it("Ctrl+Alt+T and Ctrl+Alt+Shift+T, by the physical key", () => {
    const k = (over: object) => ({ key: "t", code: "KeyT", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, ...over });
    expect(terminalChatKey(k({}))).toBe("terminal");
    expect(terminalChatKey(k({ shiftKey: true, key: "T" }))).toBe("classic");
    expect(terminalChatKey(k({ key: "ㅅ" }))).toBe("terminal");
    expect(terminalChatKey(k({ altKey: false }))).toBeNull();
    expect(terminalChatKey(k({ ctrlKey: false }))).toBeNull();
  });
});

describe("Continue as Terminal Chat: why not", () => {
  beforeAll(() => initI18n("en", "win32"));
  it("a terminal chat, a record, no conversation yet, a pending review, Claude working", () => {
    const s = baseState();
    expect(continueAsTerminalBlocker(s, meta(), false)).toBeNull();
    expect(continueAsTerminalBlocker(s, meta({ kind: "terminal" }), false)).toBe("This chat already runs Claude Code in a terminal");
    expect(continueAsTerminalBlocker(s, meta({ continuedIn: "t1" }), false)).toContain("This chat is a record");
    expect(continueAsTerminalBlocker(s, meta({ resumeFailed: true }), false)).toContain("This chat is a record");
    expect(continueAsTerminalBlocker(s, meta({ cliKnown: false, turns: 0 }), false)).toContain("no Claude conversation yet");
    const pending = baseState({ changedFiles: [{ path: "a.ts", state: "pending" }] as unknown as ReviewState["changedFiles"] });
    expect(continueAsTerminalBlocker(pending, meta(), false)).toContain("Accept or reject the files in the review first");
    expect(continueAsTerminalBlocker(s, meta(), true)).toBe("Claude is working — continue in a terminal chat once the turn is over");
    expect(continueAsTerminalBlocker(baseState({ project: null }), meta(), false)).toContain("Open a project first");
  });
  afterAll(() => initI18n("en", "darwin"));
});

describe("the store's entry points", () => {
  let m: Awaited<ReturnType<typeof load>>;
  const settings = (s: Partial<AppSettings>) => m.useStore.setState({ settings: { ...(m.useStore.getState().settings ?? ({} as AppSettings)), ...s } });
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });
  beforeEach(() => {
    sent.length = 0;
    refuse = null;
    m.usePtyInfo.setState({ info: INFO });
    m.usePendingSwitch.setState({ pending: null, inflight: false });
    m.useStore.setState({ state: baseState(), queue: { ...m.useStore.getState().queue, items: [], inflight: false } });
  });

  it("New chat follows the default kind; the preview off always opens a chat", async () => {
    settings({ terminalChatPreview: true, newChatKind: "terminal" });
    await m.useStore.getState().newChat();
    expect(sent.find((c) => c.type === "session_new")).toEqual({ type: "session_new", kind: "terminal" });
    sent.length = 0;
    settings({ terminalChatPreview: false });
    await m.useStore.getState().newChat();
    expect(sent.find((c) => c.type === "session_new")).toEqual({ type: "session_new" });
  });

  it("New Terminal Chat / New Chat (Classic) wait while Claude works, each held as its kind", async () => {
    m.useStore.setState({ state: baseState({}, "running") });
    await m.useStore.getState().newTerminalChat();
    expect(m.usePendingSwitch.getState().pending).toEqual({ kind: "newTerminal" });
    await m.useStore.getState().newClassicChat();
    expect(m.usePendingSwitch.getState().pending).toEqual({ kind: "new" });
    expect(sent.filter((c) => c.type === "session_new")).toEqual([]);
  });

  it("Continue as Terminal Chat sends session_continue_terminal; a refusal says why in words", async () => {
    await m.useStore.getState().continueAsTerminalChat("c1");
    expect(sent).toContainEqual({ type: "session_continue_terminal", sessionId: "c1" });
    refuse = { code: "review_pending", error: "files pending" };
    expect(await m.useStore.getState().continueAsTerminalChat("c1")).toBe(false);
    expect(m.useStore.getState().errorBanner?.message).toContain("Accept or reject the files in the review first");
    // Blocked before asking the engine: a terminal chat.
    sent.length = 0;
    expect(await m.useStore.getState().continueAsTerminalChat("t1")).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the views", () => {
  let m: Awaited<ReturnType<typeof load>>;
  const put = <T extends object>(store: { getInitialState(): T; setState(p: Partial<T>): void }, patch: Partial<T>) => {
    Object.assign(store.getInitialState(), patch);
    store.setState(patch);
  };
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
  });

  it("+ names the kind it opens and offers the other on a right-click; the preview off keeps it a chat", () => {
    put(m.usePtyInfo, { info: INFO });
    put(m.useStore, { state: baseState(), settings: { terminalChatPreview: true, newChatKind: "terminal" } as AppSettings });
    let out = renderToStaticMarkup(createElement(m.ChatTabs));
    expect(out).toContain('aria-label="New terminal chat"');
    expect(out).toContain("New terminal chat — Claude Code itself in this column (Ctrl+T)");
    expect(out).toContain("Right-click for the other kind; Settings › New chats open as changes the default");
    expect(out).toContain('aria-haspopup="menu"');
    put(m.useStore, { settings: { terminalChatPreview: false } as AppSettings });
    out = renderToStaticMarkup(createElement(m.ChatTabs));
    expect(out).toContain('aria-label="New chat"');
    expect(out).not.toContain("Right-click for the other kind");
  });

  it("a record names the terminal chat its conversation goes on in, with Open", () => {
    put(m.useStore, {
      state: baseState({
        sessions: { list: [meta({ continuedIn: "t1" }), meta({ id: "t1", title: "Terminal one", kind: "terminal" })], currentId: "c1", openTabIds: ["c1", "t1"] },
      } as Partial<ReviewState>),
    });
    const out = renderToStaticMarkup(createElement(m.MovedChatBar));
    expect(out).toContain("This conversation continues in the terminal chat &#x27;Terminal one&#x27; — this chat is kept as a record");
    expect(out).toContain('title="Open the terminal chat this conversation continues in"');
  });

  it("Settings › Terminal: the preview switch, its options while on, the default shell", () => {
    put(m.usePtyInfo, { info: INFO });
    const patch = () => undefined;
    let out = renderToStaticMarkup(createElement(m.TerminalSettingsSection, { settings: { terminalChatPreview: true } as AppSettings, patch }));
    for (const label of ["Terminal chat (preview)", "New chats open as", "Terminal GPU acceleration", "Repaint the whole screen each frame (recommended on Windows)", "Font size", "Default shell", "PowerShell", "Command Prompt"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("it has not been verified on a real Windows machine yet");
    out = renderToStaticMarkup(createElement(m.TerminalSettingsSection, { settings: {} as AppSettings, patch }));
    expect(out).not.toContain("New chats open as");
    expect(out).toContain("Default shell");
  });

  it("no PTY: the switch is off and says why; no shell row", () => {
    put(m.usePtyInfo, { info: { available: false, reason: "Terminal chat needs Windows 10 1903 or later", osBuild: 17763, shells: [] } });
    const out = renderToStaticMarkup(createElement(m.TerminalSettingsSection, { settings: { terminalChatPreview: true } as AppSettings, patch: () => undefined }));
    expect(out).toMatch(/data-testid="Terminal chat preview"[^>]*disabled=""|disabled=""[^>]*data-testid="Terminal chat preview"/);
    expect(out).toContain("Not available here: Terminal chat needs Windows 10 1903 or later");
    expect(out).not.toContain("Default shell");
    initI18n("ko", "win32");
    expect(renderToStaticMarkup(createElement(m.TerminalSettingsSection, { settings: {} as AppSettings, patch: () => undefined }))).toContain("Windows 10 1903 이상");
    initI18n("en", "win32");
  });
});

describe("a held new terminal chat (§9 × §57.5)", () => {
  it("says what waits and goes out as a terminal chat", async () => {
    initI18n("en", "win32");
    const { drainPendingSwitch, holdSwitch, pendingSwitchLabel, pendingSwitchText, usePendingSwitch } = await import("./pendingSwitch");
    usePendingSwitch.setState({ pending: null, inflight: false });
    let s = baseState({}, "running");
    holdSwitch({ kind: "newTerminal" });
    const pending = usePendingSwitch.getState().pending!;
    expect(pendingSwitchLabel(s, pending)).toBe("New terminal chat waits");
    expect(pendingSwitchText(s, pending)).toBe("A new terminal chat opens once Claude is done in 'Pricing rules'");
    const kinds: (string | undefined)[] = [];
    const deps = {
      state: () => s,
      queued: () => false,
      newChat: async (kind?: string) => (kinds.push(kind), true),
      openChat: async () => true,
      untilLive: async () => true,
      enqueue: () => undefined,
      fail: () => undefined,
    };
    await drainPendingSwitch(deps);
    expect(kinds).toEqual([]);
    s = baseState({}, "reviewing");
    await drainPendingSwitch(deps);
    expect(kinds).toEqual(["terminal"]);
    holdSwitch({ kind: "new" });
    await drainPendingSwitch(deps);
    expect(kinds).toEqual(["terminal", "chat"]);
  });
});
