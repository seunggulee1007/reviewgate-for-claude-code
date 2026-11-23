/**
 * §57.5 / §57.17 (plan §4.2): what the strip over a terminal chat's terminal says, when it offers "Review now", and the
 * overlay over the terminal once Claude Code exited — pure, the Mac's `TerminalStatusStrip` / `TerminalEndedOverlay`
 * (App/UI/Chat/TerminalChatView.swift) with its exact English strings.
 */
import type { TerminalSessionState } from "@reviewgate/engine";
import { t } from "./i18n";

export type StripTone = "accent" | "muted" | "orange";

export type StripStatus = {
  kind: "disconnected" | "waiting" | "working" | "reviewed" | "trust";
  /** The strip's line. */
  text: string;
  /** The same in fewer words when the strip is narrow (beside the review panel); null: none shorter. */
  short: string | null;
  tone: StripTone;
  /** The tooltip. */
  help: string;
};

export type StripInput = {
  /** The engine that reviews this terminal was reset while the PTY ran: its hooks are refused until a restart. */
  disconnected: boolean;
  /** `state.session.terminal` of the live terminal chat. */
  info: TerminalSessionState | null | undefined;
  /** A turn runs (`gate.phase === "running"`). */
  working: boolean;
};

export function stripStatus(i: StripInput): StripStatus {
  if (i.disconnected) {
    return {
      kind: "disconnected",
      text: t("ReviewGate restarted — this terminal is no longer reviewed. Restart it"),
      short: null,
      tone: "orange",
      help: t("The engine that reviews this terminal restarted, so Claude Code's prompts and edits are refused until you restart the terminal (the conversation is resumed)"),
    };
  }
  const waiting = i.info?.waiting ?? null;
  if (waiting) {
    return {
      kind: "waiting",
      text: waiting.kind === "permission" ? t("Claude Code waits for your permission in the terminal") : t("Claude Code asked you a question in the terminal"),
      short: null,
      tone: "orange",
      help: waiting.message,
    };
  }
  if (i.working) {
    return {
      kind: "working",
      text: t("Claude is working — the review opens when it stops"),
      short: null,
      tone: "muted",
      help: t("ReviewGate takes a snapshot when you send a prompt and shows the turn's changes once Claude stops"),
    };
  }
  if (i.info?.hooksSeen === true) {
    return {
      kind: "reviewed",
      text: t("Reviewed by ReviewGate — changes show on the left"),
      short: t("Reviewed by ReviewGate"),
      tone: "muted",
      help: t("Claude Code reports each prompt and edit to ReviewGate; accept or reject the changes as in a chat"),
    };
  }
  // §57.7: before the first hook — Claude Code's trust question defaults to "No, exit", and a folder it does not trust
  // cannot be reviewed, so the strip says what to pick before the user presses Enter.
  return {
    kind: "trust",
    text: t("If Claude Code asks whether to trust this folder, choose Yes"),
    short: t("Trust this folder? Choose Yes"),
    tone: "accent",
    help: t(
      'ReviewGate has heard nothing from Claude Code yet — it starts reviewing with your first prompt. The first time Claude Code runs in a folder it asks whether to trust it, and "No, exit" is selected: choose "Yes, I trust this folder" — on No, Claude Code exits and nothing can be reviewed.',
    ),
  };
}

/**
 * §57.5: "Reviewed by ReviewGate — changes show on the left" says where the review is only in the first
 * `REVIEWED_HINT_CHATS` terminal chats that reach it (per user) or until the user closes it; then the strip keeps its icon,
 * the words in its tooltip. `countedHere`: this chat is one of them (it keeps the words while on screen).
 */
export const REVIEWED_HINT_CHATS = 3;
export const REVIEWED_HINT_COUNT_KEY = "rg.terminalReviewedHintCount";
export const REVIEWED_HINT_DISMISSED_KEY = "rg.terminalReviewedHintDismissed";

export function showsReviewedHint(count: number, dismissed: boolean, countedHere: boolean): boolean {
  return !dismissed && (countedHere || count < REVIEWED_HINT_CHATS);
}

/** The hint shows in a chat that has not counted yet: it counts now. */
export function countsReviewedHint(count: number, dismissed: boolean, countedHere: boolean): boolean {
  return !countedHere && showsReviewedHint(count, dismissed, false);
}

type HintStorage = Pick<Storage, "getItem" | "setItem">;

function hintStorage(): HintStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The persisted count and dismissal (blocked storage: as if never shown). */
export function readReviewedHint(storage: HintStorage | null = hintStorage()): { count: number; dismissed: boolean } {
  try {
    const count = Number.parseInt(storage?.getItem(REVIEWED_HINT_COUNT_KEY) ?? "0", 10);
    return { count: Number.isFinite(count) && count > 0 ? count : 0, dismissed: storage?.getItem(REVIEWED_HINT_DISMISSED_KEY) === "1" };
  } catch {
    return { count: 0, dismissed: false };
  }
}

export function writeReviewedHint(v: { count?: number; dismissed?: boolean }, storage: HintStorage | null = hintStorage()): void {
  try {
    if (v.count !== undefined) storage?.setItem(REVIEWED_HINT_COUNT_KEY, String(v.count));
    if (v.dismissed !== undefined) storage?.setItem(REVIEWED_HINT_DISMISSED_KEY, v.dismissed ? "1" : "0");
  } catch {
    // blocked storage: the hint shows again next time
  }
}

/** How long a running turn may go without a change in the live terminal chat before "Review now" shows. */
export const REVIEW_NOW_IDLE_MS = 60_000;

/** §57.4: after an Esc the window saw, how long it waits for a hook before offering "Review now". */
export const ESCAPE_GRACE_MS = 2000;

/** §57.4: an Esc the user pressed in the live terminal chat while its turn ran, and the engine's `hookCount` then. */
export type EscapeMark = { atMs: number; hookCount: number };

/**
 * §57.4: `data` (what xterm sends to the PTY) is the Esc key alone — a lone ESC, or its kitty form (`CSI 27 u`). Alt+key
 * comes as one write (ESC and the key together), so a lone ESC is never a Meta prefix here.
 */
export function isEscapeKey(data: string): boolean {
  return data === "\x1b" || data === "\x1b[27u" || data === "\x1b[27;1u" || data === "\x1b[27;1:1u";
}

/** §57.4: an Esc counts only while a turn runs in a running terminal (between turns it closes a TUI menu: nothing). */
export function escapeMark(i: { working: boolean; info: TerminalSessionState | null | undefined; nowMs: number }): EscapeMark | null {
  if (!i.working || !i.info?.running) return null;
  return { atMs: i.nowMs, hookCount: i.info.hookCount ?? 0 };
}

/**
 * "Review now": a tool call ended by Esc (Claude Code sends no end of turn then), Esc pressed in the terminal 2 s ago with
 * no hook since (`hookCount` unchanged), or the turn has run 60 s with nothing changing in the live terminal chat
 * (`terminalActivityKey`). Only while a turn runs in a running terminal.
 */
export function showsReviewNow(i: {
  working: boolean;
  info: TerminalSessionState | null | undefined;
  lastActivityMs: number;
  nowMs: number;
  escape?: EscapeMark | null;
}): boolean {
  if (!i.working || !i.info?.running) return false;
  if (i.info.interruptSuspected || i.nowMs - i.lastActivityMs >= REVIEW_NOW_IDLE_MS) return true;
  const e = i.escape;
  return !!e && (i.info.hookCount ?? 0) === e.hookCount && i.nowMs - e.atMs >= ESCAPE_GRACE_MS;
}

/** What counts as activity of the live terminal chat (the Mac's rule — the app has no per-hook timestamp): the state's seq, its terminal state, the gate's phase. */
export function terminalActivityKey(s: { seq?: number; gate: { phase: string }; session: { terminal?: TerminalSessionState | null } }): string {
  return JSON.stringify([s.seq ?? 0, s.gate.phase, s.session.terminal ?? null]);
}

export type TerminalOverlay = { kind: "exited" | "stopped" | "failed" | "disconnected"; title: string; hint: string | null };

/** Over the terminal (its buffer stays readable underneath — Claude Code's own error, Git Bash missing …): why, and Restart. */
export function terminalOverlay(i: {
  exit: { exitCode: number | null; quickNoHooks: boolean; reason?: string } | null;
  failed: string | null;
  disconnected: boolean;
}): TerminalOverlay | null {
  if (i.failed) return { kind: "failed", title: i.failed, hint: null };
  if (i.exit) {
    const hint = i.exit.quickNoHooks
      ? t("If it asked whether to trust this folder, choose Yes after restarting — ReviewGate cannot review a folder Claude Code does not trust")
      : null;
    return i.exit.exitCode === null
      ? { kind: "stopped", title: t("Claude Code was stopped"), hint }
      : { kind: "exited", title: t("Claude Code exited ({0})", i.exit.exitCode), hint };
  }
  if (i.disconnected) {
    return {
      kind: "disconnected",
      title: t("ReviewGate restarted — this terminal is no longer reviewed. Restart it"),
      hint: t("The engine that reviews this terminal restarted, so Claude Code's prompts and edits are refused until you restart the terminal (the conversation is resumed)"),
    };
  }
  return null;
}

/**
 * §57.1 / §57.17: why a terminal chat's Claude Code could not start (the engine's `terminal_spec` refusals and main's
 * PTY codes), in the user's words; null for a code it does not know (the caller shows the raw error).
 */
export function terminalStartRefusal(code: string, error = ""): string | null {
  switch (code) {
    case "pty_unavailable":
      return error.trim() ? t("Terminals are not available here: {0}", error.trim()) : t("Terminals are not available here");
    case "terminal_needs_native_claude":
      return t("Terminal chat needs the native Claude Code (claude.exe) or Node on PATH");
    case "terminal_cmdline_too_long":
      return t("Claude Code's command line would be longer than Windows allows — turn off some MCP servers or plugins and try again");
    case "spawn_failed":
      return error.trim() ? t("Claude Code could not be started in the terminal: {0}", error.trim()) : t("Claude Code could not be started in the terminal");
    case "no_project":
      return t("Open a project first (⌘O)");
    case "not_current":
    case "terminal_not_current":
      return t("This terminal chat is not the live chat anymore — continue in it first");
    case "terminal_unsupported":
      return t("Terminal chats are not available in this window");
    case "terminal_cli_too_old":
      return t("Terminal chats need Claude Code 2.1.295 or later — update it with `claude update`");
    case "terminal_hooks_disabled":
      return t("Hooks are turned off in your Claude Code settings (disableAllHooks or allowManagedHooksOnly), so ReviewGate cannot review a terminal chat");
    case "terminal_chat":
      return t("This chat runs Claude Code in a terminal — do it there");
    case "no_turn":
      return t("No turn is open — there is nothing to review yet");
    default:
      return null;
  }
}
