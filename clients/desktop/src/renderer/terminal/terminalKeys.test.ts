/** §57.10 / plan §5.1: the keys a focused terminal keeps for Claude Code and the ones the app takes. */
import { describe, expect, it } from "vitest";
import { isTerminalPanelKey, isTerminalTarget, terminalKeyAction, xtermHandles, type TerminalKeyEvent } from "./terminalKeys";

const ev = (key: string, over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  type: "keydown",
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});
const win = { mac: false, hasSelection: false };
const kind = (e: TerminalKeyEvent, ctx = win) => terminalKeyAction(e, ctx).kind;

describe("Windows: keys that stay Claude Code's", () => {
  it("Esc, Tab, arrows, Enter and plain typing go to the PTY", () => {
    for (const k of ["Escape", "Tab", "ArrowUp", "ArrowLeft", "Enter", "Backspace", "a", "한"]) expect(kind(ev(k))).toBe("pty");
  });

  it("Ctrl+<letter> goes to the PTY — T B R O P N F G L D are Claude Code's own keys", () => {
    for (const k of ["t", "b", "r", "o", "p", "n", "f", "g", "l", "d", "y", "z", "a", "w"]) expect(kind(ev(k, { ctrlKey: true }))).toBe("pty");
  });

  it("Ctrl+C without a selection is ^C for the program; with one it copies", () => {
    expect(kind(ev("c", { ctrlKey: true }))).toBe("pty");
    expect(kind(ev("c", { ctrlKey: true }), { ...win, hasSelection: true })).toBe("copy");
    expect(kind(ev("C", { ctrlKey: true, shiftKey: true }))).toBe("copy");
  });

  it("Alt+V reaches the PTY (Claude Code's image paste on Windows)", () => {
    expect(kind(ev("v", { altKey: true }))).toBe("pty");
  });

  it("AltGr characters (Ctrl+Alt on Windows) type unless the letter is one of the app's", () => {
    expect(kind(ev("q", { ctrlKey: true, altKey: true }))).toBe("pty");
    expect(kind(ev("e", { ctrlKey: true, altKey: true }))).toBe("pty");
    expect(kind(ev("7", { code: "Digit7", ctrlKey: true, altKey: true }))).toBe("pty");
  });
});

describe("Windows: keys the app takes", () => {
  it("Ctrl+V, Ctrl+Shift+V and Shift+Insert paste (the browser's paste event — xterm brackets it)", () => {
    expect(kind(ev("v", { ctrlKey: true }))).toBe("paste");
    expect(kind(ev("V", { ctrlKey: true, shiftKey: true }))).toBe("paste");
    expect(kind(ev("Insert", { shiftKey: true }))).toBe("paste");
  });

  it("Shift+Enter writes ESC CR (Meta+Enter: a newline in Claude Code)", () => {
    expect(terminalKeyAction(ev("Enter", { shiftKey: true }), win)).toEqual({ kind: "send", data: "\x1b\r" });
  });

  it("Ctrl+Shift+<letter> other than C / V, Ctrl+Tab, Ctrl+PgUp/PgDn, Ctrl+1…9, Ctrl+, , Ctrl+. and F11", () => {
    for (const k of ["D", "A", "R", "K", "W", "T", "F"]) expect(kind(ev(k, { ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(kind(ev("Tab", { ctrlKey: true }))).toBe("app");
    expect(kind(ev("Tab", { ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(kind(ev("PageUp", { ctrlKey: true }))).toBe("app");
    expect(kind(ev("PageDown", { ctrlKey: true }))).toBe("app");
    for (let d = 1; d <= 9; d++) expect(kind(ev(String(d), { code: `Digit${d}`, ctrlKey: true }))).toBe("app");
    expect(kind(ev(",", { code: "Comma", ctrlKey: true }))).toBe("app");
    expect(kind(ev(".", { code: "Period", ctrlKey: true }))).toBe("app");
    expect(kind(ev("F11"))).toBe("app");
  });

  it("Ctrl+Alt+A S B F N T (and Shift+T) are the app's", () => {
    for (const k of ["a", "s", "b", "f", "n", "t"]) expect(kind(ev(k, { ctrlKey: true, altKey: true }))).toBe("app");
    expect(kind(ev("T", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("app");
  });

  it("the physical key decides — a Korean layout reads Ctrl+Shift+D as ㅇ", () => {
    expect(kind(ev("ㅇ", { code: "KeyD", ctrlKey: true, shiftKey: true }))).toBe("app");
    expect(kind(ev("ㅅ", { code: "KeyT", ctrlKey: true, altKey: true }))).toBe("app");
  });

  it("Ctrl+= / Ctrl+- / Ctrl+0 size the terminal font", () => {
    expect(terminalKeyAction(ev("=", { code: "Equal", ctrlKey: true }), win)).toEqual({ kind: "font", step: 1 });
    expect(terminalKeyAction(ev("-", { code: "Minus", ctrlKey: true }), win)).toEqual({ kind: "font", step: -1 });
    expect(terminalKeyAction(ev("0", { code: "Digit0", ctrlKey: true }), win)).toEqual({ kind: "font", step: 0 });
  });

  it("Ctrl+` (the physical Backquote, whatever the layout prints) is the terminal panel", () => {
    expect(kind(ev("`", { code: "Backquote", ctrlKey: true }))).toBe("app");
    expect(kind(ev("ö", { code: "Backquote", ctrlKey: true }))).toBe("app");
    expect(isTerminalPanelKey(ev("`", { code: "Backquote", ctrlKey: true }))).toBe(true);
    expect(isTerminalPanelKey(ev("`", { code: "Backquote" }))).toBe(false);
    expect(isTerminalPanelKey(ev("`", { code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("IME composition", () => {
  it("never intercepts a composing key — not even Enter, Ctrl+C or Ctrl+`", () => {
    expect(kind(ev("Enter", { isComposing: true }))).toBe("pty");
    expect(kind(ev("Enter", { keyCode: 229, shiftKey: true }))).toBe("pty");
    expect(kind(ev("c", { ctrlKey: true, isComposing: true }), { ...win, hasSelection: true })).toBe("pty");
    expect(kind(ev("`", { code: "Backquote", ctrlKey: true, keyCode: 229 }))).toBe("pty");
    expect(kind(ev("Process"))).toBe("pty");
  });
});

describe("macOS (development): ⌘ is the app's, Ctrl the program's", () => {
  const mac = { mac: true, hasSelection: false };
  it("Ctrl+letters go to the PTY, ⌘ keys to the app", () => {
    expect(kind(ev("c", { ctrlKey: true }), mac)).toBe("pty");
    expect(kind(ev("t", { metaKey: true }), mac)).toBe("app");
    expect(kind(ev("d", { metaKey: true, shiftKey: true }), mac)).toBe("app");
  });
  it("⌘C copies a selection, ⌘V pastes, ⌘= sizes the font", () => {
    expect(kind(ev("c", { metaKey: true }), { mac: true, hasSelection: true })).toBe("copy");
    expect(kind(ev("v", { metaKey: true }), mac)).toBe("paste");
    expect(kind(ev("=", { code: "Equal", metaKey: true }), mac)).toBe("font");
  });
  it("⌃` toggles the panel and ⇧↩ writes ESC CR there too", () => {
    expect(kind(ev("`", { code: "Backquote", ctrlKey: true }), mac)).toBe("app");
    expect(kind(ev("Enter", { shiftKey: true }), mac)).toBe("send");
  });
});

describe("xterm's handler result and the target guard", () => {
  it("only `pty` lets xterm handle the key", () => {
    expect(xtermHandles({ kind: "pty" })).toBe(true);
    for (const a of [{ kind: "app" }, { kind: "copy" }, { kind: "paste" }, { kind: "send", data: "x" }, { kind: "font", step: 1 }] as const) {
      expect(xtermHandles(a)).toBe(false);
    }
  });
  it("a target inside `.xterm` is a terminal's", () => {
    expect(isTerminalTarget({ closest: (s: string) => (s === ".xterm" ? {} : null) } as unknown as EventTarget)).toBe(true);
    expect(isTerminalTarget({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(isTerminalTarget(null)).toBe(false);
    expect(isTerminalTarget({} as EventTarget)).toBe(false);
  });
});
