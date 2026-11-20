/**
 * §57.10 (Windows terminal chat, plan §5.1): which keys a focused terminal (xterm.js) keeps for the program in it and which
 * the app takes. Pure — `termHost` asks `terminalKeyAction` from `term.attachCustomKeyEventHandler` and acts on the answer:
 *
 * - `pty`: xterm handles the key (the default — Esc, Tab, arrows, Ctrl+letters such as T B R O P N F G L D go to Claude
 *   Code; main's `setIgnoreMenuShortcuts` keeps the menu accelerators out while a terminal has the keyboard).
 * - `app`: xterm leaves it alone and the window's own handlers (document listeners) run — chat tabs, the review keys,
 *   Settings, Stop (Ctrl+.), the terminal panel (Ctrl+`).
 * - `copy`: the selection goes to the clipboard (Ctrl+C with a selection, Ctrl+Shift+C).
 * - `paste`: the browser's paste event — xterm turns it into a bracketed paste (Ctrl+V, Ctrl+Shift+V, Shift+Insert).
 * - `send`: these bytes go to the PTY instead of what xterm would send (Shift+Enter → ESC CR, Claude Code's newline).
 * - `font`: the terminal's font size (Ctrl+= / Ctrl+- / Ctrl+0, as in Windows Terminal).
 *
 * A key that belongs to an IME composition always stays xterm's. On a Mac (development) ⌘ is the app's modifier and every
 * Ctrl key is the program's.
 */

export type TerminalKeyEvent = {
  type?: string;
  key: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type TerminalKeyAction =
  | { kind: "pty" }
  | { kind: "app" }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "send"; data: string }
  | { kind: "font"; step: 1 | -1 | 0 };

export type TerminalKeyContext = {
  /** The terminal has a selection (Ctrl+C copies it instead of sending ^C). */
  hasSelection: boolean;
  /** macOS (development): ⌘ is the app's modifier. */
  mac: boolean;
};

const PTY: TerminalKeyAction = { kind: "pty" };
const APP: TerminalKeyAction = { kind: "app" };

/** Ctrl+Alt+<letter> the app keeps (agent panel, side questions, the board, find in the diff, new terminal / classic chat). */
const APP_CTRL_ALT_LETTERS = new Set(["KeyA", "KeyS", "KeyB", "KeyF", "KeyN", "KeyT"]);

/** The letter's physical key (`KeyT`), from `code` or — without one — from `key`. */
function letterCode(e: TerminalKeyEvent): string | null {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code;
  return /^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : null;
}

/** The IME owns the key: never intercept it (xterm's composition path handles it). */
export function isImeKey(e: TerminalKeyEvent): boolean {
  return e.isComposing === true || e.keyCode === 229 || e.key === "Process";
}

/** Ctrl+` (the physical Backquote key, whatever the layout prints on it): the terminal panel. */
export function isTerminalPanelKey(e: TerminalKeyEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "Backquote";
}

export function terminalKeyAction(e: TerminalKeyEvent, ctx: TerminalKeyContext): TerminalKeyAction {
  if (isImeKey(e)) return PTY;
  if (isTerminalPanelKey(e)) return APP;
  return ctx.mac ? macAction(e, ctx) : windowsAction(e, ctx);
}

function windowsAction(e: TerminalKeyEvent, ctx: TerminalKeyContext): TerminalKeyAction {
  const { ctrlKey: ctrl, altKey: alt, shiftKey: shift } = e;
  const code = e.code ?? "";
  if (e.key === "F11") return APP;
  // Shift+Insert: paste, as in every Windows console.
  if (shift && !ctrl && !alt && e.key === "Insert") return { kind: "paste" };
  // Shift+Enter: Meta+Enter (ESC CR) — a newline in Claude Code's prompt, the sequence its /terminal-setup installs.
  if (shift && !ctrl && !alt && e.key === "Enter") return { kind: "send", data: "\x1b\r" };
  if (!ctrl || e.metaKey) return PTY;
  const letter = letterCode(e);
  if (alt) {
    // AltGr arrives as Ctrl+Alt on Windows: only the app's own letters, so AltGr characters still type.
    return letter && APP_CTRL_ALT_LETTERS.has(letter) ? APP : PTY;
  }
  if (shift) {
    if (letter === "KeyC") return { kind: "copy" };
    if (letter === "KeyV") return { kind: "paste" };
    if (letter) return APP; // Ctrl+Shift+<letter>: accept, reject, commit, close tab, reopen, the diff pane …
    if (e.key === "Tab") return APP;
    return PTY;
  }
  if (letter === "KeyC") return ctx.hasSelection ? { kind: "copy" } : PTY;
  if (letter === "KeyV") return { kind: "paste" };
  if (e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown") return APP;
  if (/^Digit[1-9]$/.test(code) || /^[1-9]$/.test(e.key)) return APP;
  if (code === "Comma" || e.key === ",") return APP;
  if (code === "Period" || e.key === ".") return APP;
  if (code === "Equal" || code === "NumpadAdd" || e.key === "=" || e.key === "+") return { kind: "font", step: 1 };
  if (code === "Minus" || code === "NumpadSubtract" || e.key === "-") return { kind: "font", step: -1 };
  if (code === "Digit0" || code === "Numpad0" || e.key === "0") return { kind: "font", step: 0 };
  return PTY;
}

function macAction(e: TerminalKeyEvent, ctx: TerminalKeyContext): TerminalKeyAction {
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === "Enter") return { kind: "send", data: "\x1b\r" };
  if (!e.metaKey) return PTY;
  const letter = letterCode(e);
  const code = e.code ?? "";
  if (!e.altKey && !e.ctrlKey) {
    if (letter === "KeyC") return e.shiftKey || ctx.hasSelection ? { kind: "copy" } : APP;
    if (letter === "KeyV") return { kind: "paste" };
    if (code === "Equal" || e.key === "=" || e.key === "+") return { kind: "font", step: 1 };
    if (code === "Minus" || e.key === "-") return { kind: "font", step: -1 };
    if (code === "Digit0" || e.key === "0") return { kind: "font", step: 0 };
  }
  return APP;
}

/** What `attachCustomKeyEventHandler` returns: true lets xterm handle the key. */
export function xtermHandles(action: TerminalKeyAction): boolean {
  return action.kind === "pty";
}

/** The element is (inside) a terminal — xterm's own helper textarea, its screen. Window key handlers leave such keys alone. */
export function isTerminalTarget(target: EventTarget | null | undefined): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null | undefined;
  return typeof el?.closest === "function" && el.closest(".xterm") != null;
}
