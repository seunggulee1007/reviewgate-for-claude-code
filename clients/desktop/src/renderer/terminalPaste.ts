/**
 * §57.7 / §57.10 (plan §4.6): "Paste into the terminal" — the Mac's rule (Core NewChatKind.swift `pasteIntoTerminal`).
 * Flows that send text for the user (PR comments' "Send to Claude", an agent's "Send to main chat", a side question, the
 * promote sheet) cannot type into a terminal chat's TUI: on an explicit click their text goes into Claude Code's prompt as
 * ONE bracketed paste and the terminal takes the keyboard — never an Enter; the user reads it and sends it. Only into the
 * live terminal chat, only while its Claude Code runs and has bracketed paste on.
 */
import { t, usesMacKeys } from "./i18n";

/**
 * The text a paste may carry: no paste-end marker (it would end the paste early and let the rest act as typed keys), no
 * other ESC (no escape sequence of ours in the prompt), and the terminal's own line ending — CR, never LF (inside the
 * brackets a CR is a newline in the prompt, not Enter).
 */
export function sanitizePaste(text: string): string {
  return text
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\x1b/g, "")
    .replace(/\r\n/g, "\r")
    .replace(/\n/g, "\r");
}

/** What the paste needs of the window and its terminal. */
export type PasteTarget = {
  /** The live chat is a terminal chat and it is the one on screen (not another chat shown read-only). */
  liveTerminalChat: boolean;
  /** Its PTY runs (and the engine that reviews it was not reset). */
  running: boolean;
  /** Claude Code turned bracketed paste on (its prompt shows). */
  bracketed: boolean;
};

/** Why the text cannot go into the terminal now (null: it can). */
export function pasteRefusal(target: PasteTarget, text: string): string | null {
  if (!target.liveTerminalChat) return t("The chat on screen is not a live terminal chat");
  if (!target.running) return t("Claude Code is not running in this terminal — restart it first");
  if (!target.bracketed || sanitizePaste(text).length === 0) return t("Claude Code is not ready for a paste yet — try again once its prompt shows");
  return null;
}

/** The toast after a paste — Return on a Mac, Enter elsewhere. */
export function pastedText(): string {
  return usesMacKeys() ? t("Pasted into the terminal — press Return there to send it") : t("Pasted into the terminal — press Enter there to send it");
}
