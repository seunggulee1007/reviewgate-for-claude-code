/**
 * §57.7 / plan §4.6: the flows that send for the user, into a live terminal chat — one bracketed paste (never an Enter)
 * only into the live, running terminal chat with bracketed paste on, a toast either way; Stop writes Esc to its PTY.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { ReviewState } from "@reviewgate/engine";
import type { PtyBridge, PtyExit } from "../shared/ipc";
import { initI18n } from "./i18n";

const input: [string, string][] = [];
let exitCb: (e: PtyExit) => void = () => undefined;
const term = { modes: { bracketedPasteMode: false }, pasted: [] as string[] };

async function load() {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { dataset: {} },
    hasFocus: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ className: "", isConnected: false, remove: () => undefined, contains: () => false }),
    activeElement: null,
  };
  (globalThis as unknown as { window: unknown }).window = {
    matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }),
    rg: { send: () => undefined, request: async () => ({}), requestDetailed: async () => ({ ok: true, reply: {} }), notify: async () => true, onEvent: () => () => undefined, platform: "win32" },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const { useStore } = await import("./store");
  const host = await import("./terminal/termHost");
  const chat = await import("./terminal/terminalChat");
  const { useViewedChat } = await import("./viewedChat");
  const { useToast } = await import("./toast");
  const fake = {
    ...term,
    options: {},
    cols: 80,
    rows: 24,
    textarea: { addEventListener: () => undefined },
    write: (_d: string, cb?: () => void) => cb?.(),
    paste: (text: string) => void term.pasted.push(text),
    onData: () => ({ dispose: () => undefined }),
    onBinary: () => ({ dispose: () => undefined }),
    attachCustomKeyEventHandler: () => undefined,
    open: () => undefined,
    loadAddon: () => undefined,
    hasSelection: () => false,
    focus: () => undefined,
    dispose: () => undefined,
  };
  Object.defineProperty(fake, "modes", { get: () => term.modes });
  host.setTerminalLoader(async () => ({
    createTerminal: () => fake as unknown as Terminal,
    fit: () => ({ activate: () => undefined, dispose: () => undefined, fit: () => undefined, proposeDimensions: () => undefined }),
    addons: () => undefined,
    webgl: () => null,
    search: () => ({ activate: () => undefined, dispose: () => undefined, findNext: () => true, findPrevious: () => true, clearDecorations: () => undefined }),
  }));
  host.initTermHost({
    input: (id: string, d: string) => void input.push([id, d]),
    ack: () => undefined,
    focus: () => undefined,
    resize: () => undefined,
    onData: () => () => undefined,
    onExit: (cb: (e: PtyExit) => void) => ((exitCb = cb), () => undefined),
  } as unknown as PtyBridge);
  return { useStore, host, chat, useViewedChat, useToast };
}

describe("paste into the live terminal chat", () => {
  let m: Awaited<ReturnType<typeof load>>;
  beforeAll(async () => {
    initI18n("en", "win32");
    m = await load();
    const init = m.useStore.getInitialState().state;
    m.useStore.setState({
      state: {
        ...init,
        project: { path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: null },
        sessions: { list: [{ id: "t1", title: "T", kind: "terminal" }, { id: "c1", title: "C" }], currentId: "t1", openTabIds: ["t1", "c1"] },
        gate: { ...init.gate, phase: "running" },
      } as unknown as ReviewState,
    });
    m.host.adoptTerminal("p1", "chat", { sessionId: "t1" });
    m.chat.useTerminalChats.setState({ bySession: { t1: { ptyId: "p1", opening: false, failed: null, startedAt: 1 } } });
    await new Promise((r) => setTimeout(r, 0));
  });
  beforeEach(() => {
    term.pasted.length = 0;
    input.length = 0;
    term.modes.bracketedPasteMode = false;
  });

  it("waits for Claude Code's prompt (bracketed paste on)", () => {
    expect(m.chat.pasteIntoLiveTerminal("fix it")).toBe("Claude Code is not ready for a paste yet — try again once its prompt shows");
    expect(term.pasted).toEqual([]);
  });

  it("pastes once — line breaks as CR, never an Enter of its own — and says so", () => {
    term.modes.bracketedPasteMode = true;
    expect(m.chat.pasteWithToast("PR #12 review:\nanswer each comment")).toBe(true);
    expect(term.pasted).toEqual(["PR #12 review:\ranswer each comment"]);
    expect(input).toEqual([]);
    expect(m.useToast.getState().text).toBe("Pasted into the terminal — press Enter there to send it");
  });

  it("a flow's draft goes into the terminal instead of a composer", () => {
    term.modes.bracketedPasteMode = true;
    m.chat.draftToLiveChat("Send to Claude draft");
    expect(term.pasted).toEqual(["Send to Claude draft"]);
  });

  it("not while another chat is shown read-only", () => {
    term.modes.bracketedPasteMode = true;
    m.useViewedChat.setState({ chat: { id: "c1", liveId: "t1", items: [], start: null, oldestAt: null, loading: false, error: null } });
    expect(m.chat.pasteIntoLiveTerminal("x")).toBe("The chat on screen is not a live terminal chat");
    m.useViewedChat.setState({ chat: null });
  });

  it("Stop writes Esc to the PTY; once Claude Code exited there is nothing to stop, nor to paste into", () => {
    expect(m.chat.stopLiveTerminal()).toBe(true);
    expect(input).toEqual([["p1", "\x1b"]]);
    exitCb({ ptyId: "p1", exitCode: 0, quickNoHooks: false, reason: "exited" });
    expect(m.chat.stopLiveTerminal()).toBe(false);
    term.modes.bracketedPasteMode = true;
    expect(m.chat.pasteIntoLiveTerminal("x")).toBe("Claude Code is not running in this terminal — restart it first");
  });
});
