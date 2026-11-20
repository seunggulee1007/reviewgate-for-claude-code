/**
 * §57.10 (plan §4.1): the options every xterm.js terminal of this window starts with, and the renderer choice — pure, so
 * the platform / setting rules are unit-tested without a DOM.
 */
import type { ITerminalOptions, ITheme } from "@xterm/xterm";

/** Windows' console font first, then the Korean fonts Windows ships (a Hangul cell must never fall back to a proportional font). */
export const TERMINAL_FONT_FAMILY = "'Cascadia Mono', Consolas, 'D2Coding', 'Malgun Gothic', monospace";
export const TERMINAL_FONT_MIN = 9;
export const TERMINAL_FONT_MAX = 28;
export const TERMINAL_FONT_DEFAULT = 13;
export const TERMINAL_SCROLLBACK = 5000;

/** `terminalFontSize` within 9…28 (anything else: 13). */
export function clampFontSize(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return TERMINAL_FONT_DEFAULT;
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(n)));
}

/** Ctrl+= / Ctrl+- / Ctrl+0 (plan §5.1): the next font size. */
export function steppedFontSize(current: number, step: 1 | -1 | 0): number {
  return step === 0 ? TERMINAL_FONT_DEFAULT : clampFontSize(clampFontSize(current) + step);
}

/** The app's two palettes (the window's `data-theme`): xterm paints its own canvas, so it gets the colours here. */
export function terminalTheme(theme: "light" | "dark"): ITheme {
  return theme === "dark"
    ? {
        background: "#1a1a1c",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        cursorAccent: "#1a1a1c",
        selectionBackground: "#264f78",
        scrollbarSliderBackground: "rgba(121, 121, 121, 0.4)",
        scrollbarSliderHoverBackground: "rgba(100, 100, 100, 0.7)",
        scrollbarSliderActiveBackground: "rgba(191, 191, 191, 0.4)",
      }
    : {
        background: "#ffffff",
        foreground: "#1f1f1f",
        cursor: "#1f1f1f",
        cursorAccent: "#ffffff",
        selectionBackground: "#add6ff",
        black: "#000000",
        brightBlack: "#666666",
        white: "#a5a5a5",
        brightWhite: "#3b3b3b",
        yellow: "#949800",
        brightYellow: "#b5ba00",
        scrollbarSliderBackground: "rgba(100, 100, 100, 0.4)",
        scrollbarSliderHoverBackground: "rgba(100, 100, 100, 0.7)",
        scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.6)",
      };
}

export type TermOptionsInput = {
  /** `process.platform` of the client. */
  platform: string;
  /** Windows' build number (`PtyInfo.osBuild`) — xterm adapts its reflow and wrap rules to ConPTY's. */
  osBuild: number | null;
  fontSize: unknown;
  theme: "light" | "dark";
  screenReader?: boolean;
};

export function terminalOptions(i: TermOptionsInput): ITerminalOptions {
  return {
    allowProposedApi: true, // unicode11's `term.unicode`
    ...(i.platform === "win32" ? { windowsPty: { backend: "conpty" as const, ...(i.osBuild ? { buildNumber: i.osBuild } : {}) } } : {}),
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: clampFontSize(i.fontSize),
    scrollback: TERMINAL_SCROLLBACK,
    cursorBlink: true,
    rightClickSelectsWord: false,
    altClickMovesCursor: false,
    // Alt is Meta for the program (Alt+V, Alt+B …) on every platform: what Claude Code reads as its Meta keys.
    macOptionIsMeta: true,
    screenReaderMode: i.screenReader === true,
    theme: terminalTheme(i.theme),
  };
}

/** WebGL when the setting allows it and it has not failed in this window (it then stays on the DOM renderer, logged once). */
export function usesWebgl(gpu: unknown, failedBefore: boolean): boolean {
  return gpu !== "off" && !failedBefore;
}

/** Only http(s) links open (in the browser, through main) — never file:, javascript: or a custom scheme a program printed. */
export function isOpenableLink(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Acks after every 5,000 chars written (main pauses the PTY above 100,000 unacked, resumes below 5,000). */
export const ACK_CHARS = 5000;

/** The ack bookkeeping: chars written since the last ack → [chars to ack now (0: none), chars still unacked]. */
export function ackStep(unacked: number, written: number): [number, number] {
  const total = unacked + written;
  return total >= ACK_CHARS ? [total, 0] : [0, total];
}
