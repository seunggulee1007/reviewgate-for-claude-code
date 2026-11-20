/**
 * §57.10 / plan §4.1: the terminal registry with a fake xterm and a fake bridge — output held until a PTY is adopted,
 * flow-control acks, exits, the key routing (Shift+Enter, copy), bracketed paste, the WebGL fallback, font size.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { PtyBridge, PtyExit } from "../../shared/ipc";
import {
  adoptTerminal,
  configureTerminals,
  initTermHost,
  pasteIntoTerminal,
  setTerminalLoader,
  subscribeTerminals,
  terminalStatus,
  type XtermModules,
} from "./termHost";

type FakeTerm = {
  options: Record<string, unknown>;
  modes: { bracketedPasteMode: boolean };
  written: string[];
  pasted: string[];
  key: ((e: KeyboardEvent) => boolean) | null;
  selection: string;
};

function setup(opts: { webglThrows?: boolean } = {}) {
  (globalThis as unknown as { document: unknown }).document = {
    activeElement: null,
    createElement: () => ({ className: "", isConnected: false, remove: () => undefined, contains: () => false }),
  };
  const sent = { input: [] as [string, string][], acks: [] as [string, number][], focus: [] as boolean[] };
  let dataCb: (id: string, d: string) => void = () => undefined;
  let exitCb: (e: PtyExit) => void = () => undefined;
  const bridge = {
    input: (id: string, d: string) => sent.input.push([id, d]),
    ack: (id: string, n: number) => sent.acks.push([id, n]),
    focus: (f: boolean) => sent.focus.push(f),
    resize: () => undefined,
    onData: (cb: typeof dataCb) => ((dataCb = cb), () => undefined),
    onExit: (cb: typeof exitCb) => ((exitCb = cb), () => undefined),
  } as unknown as PtyBridge;
  const terms: FakeTerm[] = [];
  const logs: string[] = [];
  const copied: string[] = [];
  let fontAsked: number | null = null;
  const modules: XtermModules = {
    createTerminal: (options) => {
      const t: FakeTerm & Record<string, unknown> = {
        options: { ...options },
        modes: { bracketedPasteMode: false },
        written: [],
        pasted: [],
        key: null,
        selection: "",
        cols: 80,
        rows: 24,
        textarea: { addEventListener: () => undefined },
        write(data: string, cb?: () => void) {
          t.written.push(data);
          cb?.();
        },
        paste(text: string) {
          t.pasted.push(text);
        },
        onData: () => ({ dispose: () => undefined }),
        onBinary: () => ({ dispose: () => undefined }),
        attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
          t.key = fn;
        },
        open: () => undefined,
        loadAddon: () => {
          if (opts.webglThrows && terms.length > 0 && (t as { loadingWebgl?: boolean }).loadingWebgl) throw new Error("no gl");
        },
        hasSelection: () => t.selection.length > 0,
        getSelection: () => t.selection,
        clearSelection: () => (t.selection = ""),
        resize: () => undefined,
        focus: () => undefined,
        dispose: () => undefined,
      };
      terms.push(t);
      return t as unknown as Terminal;
    },
    fit: () => ({ activate: () => undefined, dispose: () => undefined, fit: () => undefined, proposeDimensions: () => ({ cols: 80, rows: 24 }) }),
    addons: () => undefined,
    webgl: () =>
      opts.webglThrows
        ? null
        : { activate: () => undefined, dispose: () => undefined, onContextLoss: () => ({ dispose: () => undefined }) },
    search: () => ({ activate: () => undefined, dispose: () => undefined, findNext: () => true, findPrevious: () => true, clearDecorations: () => undefined }),
  };
  setTerminalLoader(async () => modules);
  initTermHost(bridge, { log: (l) => logs.push(l), copy: (t) => copied.push(t), onFontSize: (n) => (fontAsked = n) });
  return {
    sent,
    terms,
    logs,
    copied,
    fontAsked: () => fontAsked,
    data: (id: string, d: string) => dataCb(id, d),
    exit: (e: PtyExit) => exitCb(e),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string, over: Partial<KeyboardEvent> = {}) => {
  const e = { type: "keydown", key: k, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, prevented: false, stopped: false, ...over };
  return Object.assign(e, { preventDefault: () => (e.prevented = true), stopPropagation: () => (e.stopped = true) }) as unknown as KeyboardEvent & { prevented: boolean; stopped: boolean };
};

describe("output and flow control", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    configureTerminals({ platform: "win32", gpu: "auto", fontSize: 13 });
  });

  it("bytes that arrive before the PTY is adopted are held, acked at once, and written once its terminal exists", async () => {
    h.data("p1", "hello ");
    expect(h.sent.acks).toEqual([["p1", 6]]);
    adoptTerminal("p1", "chat", { sessionId: "s1" });
    await settle();
    h.data("p1", "world");
    expect(h.terms[0]!.written).toEqual(["hello ", "world"]);
    // The held bytes are not acked a second time.
    expect(h.sent.acks).toEqual([["p1", 6]]);
  });

  it("acks every 5,000 chars written", async () => {
    adoptTerminal("p2", "shell");
    await settle();
    h.data("p2", "x".repeat(3000));
    expect(h.sent.acks).toEqual([]);
    h.data("p2", "x".repeat(3000));
    expect(h.sent.acks).toEqual([["p2", 6000]]);
  });

  it("a replay after a reload is written, never acked", async () => {
    adoptTerminal("p3", "chat", { sessionId: "s3", replay: "old screen", status: { running: true, exit: null } });
    await settle();
    expect(h.terms[0]!.written).toEqual(["old screen"]);
    expect(h.sent.acks).toEqual([]);
  });

  it("an exit ends the status and tells the views", async () => {
    let calls = 0;
    const off = subscribeTerminals(() => calls++);
    adoptTerminal("p4", "chat", { sessionId: "s4" });
    expect(terminalStatus("p4")).toEqual({ running: true, exit: null });
    const exit: PtyExit = { ptyId: "p4", exitCode: 1, quickNoHooks: true, reason: "exited" };
    h.exit(exit);
    expect(terminalStatus("p4")).toEqual({ running: false, exit });
    expect(calls).toBeGreaterThanOrEqual(2);
    off();
  });
});

describe("keys", () => {
  it("Shift+Enter writes ESC CR once (keydown only); a plain key stays xterm's", async () => {
    const h = setup();
    configureTerminals({ platform: "win32" });
    adoptTerminal("k1", "chat", { sessionId: "s" });
    await settle();
    const handler = h.terms[0]!.key!;
    const down = key("Enter", { shiftKey: true });
    expect(handler(down)).toBe(false);
    expect(down.prevented).toBe(true);
    expect(handler(key("Enter", { shiftKey: true, type: "keypress" }))).toBe(false);
    expect(h.sent.input).toEqual([["k1", "\x1b\r"]]);
    expect(handler(key("a"))).toBe(true);
    expect(handler(key("t", { ctrlKey: true, code: "KeyT" }))).toBe(true);
  });

  it("Ctrl+C copies a selection (through the injected copy, never the real clipboard) and clears it", async () => {
    const h = setup();
    configureTerminals({ platform: "win32" });
    adoptTerminal("k2", "chat", { sessionId: "s" });
    await settle();
    h.terms[0]!.selection = "some output";
    const e = key("c", { ctrlKey: true, code: "KeyC" });
    expect(h.terms[0]!.key!(e)).toBe(false);
    expect(h.copied).toEqual(["some output"]);
    expect(h.terms[0]!.selection).toBe("");
    expect(e.stopped).toBe(true);
    // Without a selection Ctrl+C is ^C for the program.
    expect(h.terms[0]!.key!(key("c", { ctrlKey: true, code: "KeyC" }))).toBe(true);
  });

  it("Ctrl+V leaves the browser's paste event alone; Ctrl+= asks for a bigger font", async () => {
    const h = setup();
    configureTerminals({ platform: "win32", fontSize: 13 });
    adoptTerminal("k3", "chat", { sessionId: "s" });
    await settle();
    const paste = key("v", { ctrlKey: true, code: "KeyV" });
    expect(h.terms[0]!.key!(paste)).toBe(false);
    expect(paste.prevented).toBe(false);
    expect(h.terms[0]!.key!(key("=", { ctrlKey: true, code: "Equal" }))).toBe(false);
    expect(h.fontAsked()).toBe(14);
  });
});

describe("paste into the terminal", () => {
  it("only with bracketed paste on; the text sanitized, never an Enter added", async () => {
    const h = setup();
    adoptTerminal("q1", "chat", { sessionId: "s" });
    await settle();
    expect(pasteIntoTerminal("q1", "fix it")).toBe(false);
    h.terms[0]!.modes.bracketedPasteMode = true;
    expect(pasteIntoTerminal("q1", "line one\nline two\x1b[201~")).toBe(true);
    expect(h.terms[0]!.pasted).toEqual(["line one\rline two"]);
    expect(pasteIntoTerminal("missing", "x")).toBe(false);
  });
});

describe("renderer and settings", () => {
  it("WebGL that cannot be created falls back to the DOM renderer, logged once", async () => {
    const h = setup({ webglThrows: true });
    configureTerminals({ gpu: "auto" });
    adoptTerminal("w1", "shell");
    adoptTerminal("w2", "shell");
    await settle();
    expect(h.terms).toHaveLength(2);
    expect(h.logs.filter((l) => l.includes("WebGL off"))).toHaveLength(1);
  });

  it("the font size and theme follow the settings", async () => {
    const h = setup();
    configureTerminals({ fontSize: 13, theme: "dark" });
    adoptTerminal("f1", "shell");
    await settle();
    configureTerminals({ fontSize: 16, theme: "light" });
    expect(h.terms[0]!.options["fontSize"]).toBe(16);
    expect((h.terms[0]!.options["theme"] as { background: string }).background).toBe("#ffffff");
  });
});
