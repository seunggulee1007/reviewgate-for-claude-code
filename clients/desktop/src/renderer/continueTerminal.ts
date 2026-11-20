/**
 * §57.7 / §57.9 / §57.10 (plan §4.4): which kind a new chat is, and "Continue as Terminal Chat" — pure, the Mac's rules
 * (Core NewChatKind.swift, AppState+ContinueTerminal.swift) with their words. On Windows every entry point to a terminal
 * chat sits behind Settings › "Terminal chat (preview)" (off by default) and a PTY that can run.
 */
import type { ReviewState, SessionKind, SessionMeta } from "@reviewgate/engine";
import type { AppSettings } from "../shared/ipc";
import { t } from "./i18n";
import { newChatRefusal } from "./sessions";

/** The terminal-chat entry points show: the preview is on and this window can run a PTY. */
export function terminalChatsOffered(settings: Pick<AppSettings, "terminalChatPreview"> | null | undefined, ptyAvailable: boolean): boolean {
  return settings?.terminalChatPreview === true && ptyAvailable;
}

/** What [+] / Ctrl+T / a project's first chat open as: a terminal chat only while offered and "New chats open as" says Terminal. */
export function defaultChatKind(settings: Pick<AppSettings, "terminalChatPreview" | "newChatKind"> | null | undefined, ptyAvailable: boolean): SessionKind {
  return terminalChatsOffered(settings, ptyAvailable) && settings?.newChatKind === "terminal" ? "terminal" : "chat";
}

/** §57.9 refusal codes (`session_continue_terminal`) and the client's own reasons, in the user's words. */
export function continueRefusalText(code: string): string | null {
  switch (code) {
    case "not_a_chat":
      return t("This chat already runs Claude Code in a terminal");
    case "chat_is_record":
      return t("This chat is a record — its conversation went on elsewhere or could not be resumed");
    case "nothing_to_continue":
      return t("This chat has no Claude conversation yet — send a message first, or open a new terminal chat");
    case "review_pending":
      return t("Accept or reject the files in the review first — the terminal chat's review starts with its own first prompt");
    case "session_busy":
      return continueBusyText();
    default:
      return null;
  }
}

export function continueBusyText(): string {
  return t("Claude is working — continue in a terminal chat once the turn is over");
}

/**
 * Why chat `meta` cannot go on in a terminal chat now (null: it can). `waits`: a switch now would wait for the live chat
 * (a turn, its collection, the queue).
 */
export function continueAsTerminalBlocker(state: ReviewState, meta: SessionMeta, waits: boolean): string | null {
  if (!state.project) return t("Open a project first (⌘O)");
  if (meta.kind === "terminal") return continueRefusalText("not_a_chat");
  if (meta.resumeFailed || meta.movedTo || meta.continuedIn) return continueRefusalText("chat_is_record");
  if (!meta.cliKnown && meta.turns === 0) return continueRefusalText("nothing_to_continue");
  if (state.changedFiles.some((f) => f.state === "pending" || f.state === "changesRequested")) return continueRefusalText("review_pending");
  const refusal = newChatRefusal(state);
  if (refusal !== null) return refusal;
  if (waits) return continueBusyText();
  return null;
}

/** The item's line under its title (and its tooltip) while it can run. */
export function continueAsTerminalHelp(): string {
  return t("Claude Code resumes this conversation in a new terminal chat; this chat is kept as a record");
}

/** The bar over a record whose conversation goes on in a terminal chat. */
export function continuedBannerText(title: string): string {
  return t("This conversation continues in the terminal chat '{0}' — this chat is kept as a record", title);
}
