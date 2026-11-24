/**
 * MARK: accept-continue-ui — §58.1: "Accept All & Continue", the Changes list's primary button (and the composer's pending
 * banner, and Ctrl+Shift+Enter in an empty message box): every pending file accepted, then Claude told to go on with nothing
 * typed — a chat through §58's one `send {text: "Continue.", acceptPending: true}`, a terminal chat through its own accept,
 * paste and Enter (only while Claude Code is idle at its prompt). The summary dialog first when a file still needs a look.
 * The Mac's AcceptAllContinue.swift.
 */
import type { ReviewState } from "@reviewgate/engine";
import { engineRequest, refusalOf } from "./engineRequest";
import { canAcceptAndSend } from "./friction";
import { t } from "./i18n";
import { needsAcceptAllDialog } from "./acceptAllAction";
import { sessionsOf } from "./sessions";
import { cannotSendReason, useStore } from "./store";
import { chatKindOf, chatPtyOf } from "./terminal/terminalChat";
import { acceptsPaste, focusTerminal, pasteIntoTerminal, sendToTerminal, terminalStatus } from "./terminal/termHost";
import { CONTINUE_MESSAGE, runTerminalAcceptContinue, terminalAcceptContinueBlocker, type ContinueTarget } from "./terminalAcceptContinue";
import { showToast } from "./toast";
import { useViewedChat, viewingOf } from "./viewedChat";

/** The chat the button continues: another chat shown read-only, or the live one — a terminal chat with its PTY. */
export type ContinueChat = { viewing: boolean; terminal: (ContinueTarget & { ptyId: string }) | null };

/**
 * Why the button is off (null: on): nothing pending, another chat shown read-only, a terminal chat's own rule (§58: Claude
 * Code idle at its prompt), else the message box's (a file sent back for changes, Claude working, a card waiting).
 */
export function acceptAllContinueBlocker(s: ReviewState, chat: ContinueChat): string | null {
  if (s.gate.pendingCount === 0) return t("No file waits for review");
  if (chat.viewing) return t("This review belongs to the running chat — show it to continue Claude there");
  if (chat.terminal) return terminalAcceptContinueBlocker(s, chat.terminal);
  if (s.gate.changesRequestedCount > 0) return t("Send your change request ({0} file(s)) to continue", s.gate.changesRequestedCount);
  if (!canAcceptAndSend(s)) return cannotSendReason(s) ?? t("Claude can't take a message right now");
  return null;
}

/** The tooltip while it is on: a terminal chat's words name the paste and Enter; the summary first when one is due. */
export function acceptAllContinueHelp(s: ReviewState, chat: ContinueChat, dialog: boolean): string {
  const n = s.gate.pendingCount;
  if (chat.terminal) return t("Accepts the {0} pending file(s), then types “Continue.” into Claude Code with Enter", n);
  return dialog
    ? t("Shows a summary of the {0} pending file(s) first, then accepts them and tells Claude to continue (⌘⇧↩)", n)
    : t("Accepts the {0} pending file(s), then tells Claude to continue (⌘⇧↩)", n);
}

/** The live chat as the button sees it now. */
export function liveContinueChat(): ContinueChat {
  const state = useStore.getState().state;
  const live = sessionsOf(state).currentId;
  const viewing = viewingOf(useViewedChat.getState().chat, state) !== null;
  if (viewing || chatKindOf(state, live) !== "terminal") return { viewing, terminal: null };
  const ptyId = chatPtyOf(live).ptyId ?? "";
  const running = terminalStatus(ptyId).running && state.session.terminal?.running === true;
  return { viewing, terminal: { ptyId, shown: true, running, bracketed: acceptsPaste(ptyId) } };
}

/** The click: the summary dialog first when a pending file still needs a look, else at once. */
export function runAcceptAllContinue(): void {
  const s = useStore.getState();
  const why = acceptAllContinueBlocker(s.state, liveContinueChat());
  if (why !== null) return;
  if (needsAcceptAllDialog()) s.openDialog({ kind: "acceptAll", continues: true });
  else void acceptAllContinueNow();
}

/** Accepts every pending file and lets Claude continue (the dialog's confirm too); a refusal by then is a toast. */
export async function acceptAllContinueNow(): Promise<void> {
  const s = useStore.getState();
  const chat = liveContinueChat();
  const why = acceptAllContinueBlocker(s.state, chat);
  if (why !== null) {
    showToast(why);
    return;
  }
  const count = s.state.gate.pendingCount;
  if (chat.terminal) {
    await continueInTerminal(chat.terminal.ptyId, count);
    return;
  }
  s.send(CONTINUE_MESSAGE, { acceptPending: true });
  showToast(t("Accepted {0} files — Claude continues", count));
}

/** §58 in a terminal chat: `accept_all` awaited, then `Continue.` pasted and Enter — the terminal keeps the keyboard. */
export async function continueInTerminal(ptyId: string, count: number): Promise<void> {
  const why = await runTerminalAcceptContinue({
    accept: async () => {
      await engineRequest({ type: "accept_all" });
    },
    paste: (text) => pasteIntoTerminal(ptyId, text),
    enter: () => sendToTerminal(ptyId, "\r"),
    refusal: (e) => refusalOf(e).error,
  });
  focusTerminal(ptyId);
  showToast(why ?? t("Accepted {0} files — Claude continues", count));
}
