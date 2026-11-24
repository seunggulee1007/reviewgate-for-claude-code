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
import { reviewFirstHolds } from "./reviewFirst";
import { CONTINUE_MESSAGE, runTerminalAcceptContinue, terminalAcceptContinueBlocker, terminalContinueBlocker, type ContinueTarget } from "./terminalAcceptContinue";
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

// MARK: continue-states — §58.1: the primary follows the review (the Mac's ContinueStates.swift). "Accept All & Continue"
// while nothing is decided, "Accept N More & Continue" once some files are, "Continue" when nothing is pending and Claude has
// not been told the decisions, the change request while notes wait; none when there is nothing to tell. The pending
// banner and Ctrl+Shift+Enter in an empty message box run the same one.

export type ContinuePrimary =
  | { kind: "acceptAll"; pending: number }
  | { kind: "acceptRest"; pending: number }
  | { kind: "continue" }
  | { kind: "requestChanges"; notes: number };

/** §58.1: what "Continue" tells Claude — "Tells Claude: 1 accepted · 2 rejected" (null: nothing to say). */
export function continueCaption(gate: Pick<ReviewState["gate"], "untoldDecisions">): string | null {
  const u = gate.untoldDecisions;
  if (!u || u.accepted + u.rejected <= 0) return null;
  return t("Tells Claude: {0} accepted · {1} rejected", u.accepted, u.rejected);
}

/** The decision table: `decided` — a file of this review was accepted or rejected; `untold` — the next message tells Claude. */
export function continuePrimaryOf(o: { pending: number; unsentNotes: number; decided: boolean; untold: boolean }): ContinuePrimary | null {
  if (o.unsentNotes > 0) return { kind: "requestChanges", notes: o.unsentNotes };
  if (o.pending > 0) return o.decided || o.untold ? { kind: "acceptRest", pending: o.pending } : { kind: "acceptAll", pending: o.pending };
  return o.untold ? { kind: "continue" } : null;
}

/** Decisions the next message tells Claude: the engine's count, or (an older engine) its summary text. */
export function hasUntoldDecisions(gate: Pick<ReviewState["gate"], "lastReviewSummary" | "untoldDecisions">): boolean {
  if (gate.untoldDecisions) return gate.untoldDecisions.accepted + gate.untoldDecisions.rejected > 0;
  return gate.lastReviewSummary != null;
}

export function continuePrimary(s: ReviewState): ContinuePrimary | null {
  return continuePrimaryOf({
    pending: s.gate.pendingCount,
    unsentNotes: (s.reviewNotes ?? []).filter((n) => !n.sent).length,
    decided: (s.changedFiles ?? []).some((f) => f.state === "accepted"),
    untold: hasUntoldDecisions(s.gate),
  });
}

export function continuePrimaryTitle(p: ContinuePrimary): string {
  switch (p.kind) {
    case "acceptAll":
      return t("Accept All & Continue");
    case "acceptRest":
      return t("Accept {0} More & Continue", p.pending);
    case "continue":
      return t("Continue");
    case "requestChanges":
      return t("Request changes ({0})", p.notes);
  }
}

/** "Continue" with nothing pending: a chat's send rule, a terminal chat's idle-at-its-prompt rule. */
function continueOnlyBlocker(s: ReviewState, chat: ContinueChat): string | null {
  if (chat.viewing) return t("This review belongs to the running chat — show it to continue Claude there");
  if (chat.terminal) return terminalContinueBlocker(s, chat.terminal);
  if (!s.gate.canSend) return cannotSendReason(s) ?? t("Claude can't take a message right now");
  return null;
}

/** Why the primary is off (null: on). */
export function continuePrimaryBlocker(s: ReviewState, chat: ContinueChat): string | null {
  const p = continuePrimary(s);
  if (!p) return null;
  if (p.kind === "acceptAll" || p.kind === "acceptRest") return acceptAllContinueBlocker(s, chat);
  if (p.kind === "continue") return continueOnlyBlocker(s, chat);
  if (chat.viewing) return t("This review belongs to the running chat — show it to continue Claude there");
  return s.gate.canRequestChanges ? null : (cannotSendReason(s) ?? t("Claude can't take a message right now"));
}

/** The primary's tooltip while it is on. */
export function continuePrimaryHelp(s: ReviewState, chat: ContinueChat, dialog: boolean): string {
  const p = continuePrimary(s);
  if (p?.kind === "continue") {
    const told = s.gate.untoldDecisions ?? { accepted: 0, rejected: 0 };
    return chat.terminal
      ? t("Types “Continue.” into Claude Code with Enter — the files you accepted ({0}) and rejected ({1}) go with it", told.accepted, told.rejected)
      : t("Tells Claude to continue — the files you accepted ({0}) and rejected ({1}) go with it (⌘⇧↩)", told.accepted, told.rejected);
  }
  if (p?.kind === "requestChanges") return t("Send your notes to Claude as requested changes on this turn's diff (⌘⇧C)");
  return acceptAllContinueHelp(s, chat, dialog);
}

/** "⋯ › Continue, Leave the Rest Pending": files pending, Claude able to take a message, §64 `prompts` not holding it. */
export function continueLeavingRestBlocker(s: ReviewState, chat: ContinueChat): string | null {
  if (s.gate.pendingCount === 0) return t("No file waits for review");
  if (chat.viewing) return t("This review belongs to the running chat — show it to continue Claude there");
  if (reviewFirstHolds(s.gate, CONTINUE_MESSAGE)) return t("Settings › Review holds new messages until every file is accepted or rejected");
  if (chat.terminal) return terminalContinueBlocker(s, chat.terminal);
  if (!s.gate.canSend) return cannotSendReason(s) ?? t("Claude can't take a message right now");
  return null;
}

export function continueLeavingRestHelp(s: ReviewState, chat: ContinueChat): string {
  const n = s.gate.pendingCount;
  return chat.terminal
    ? t("Types “Continue.” into Claude Code with Enter without deciding the {0} pending file(s) — they stay in the review", n)
    : t("Tells Claude to continue without deciding the {0} pending file(s) — they stay in the review; what you decided goes with it", n);
}

/** The click (header, pending banner, Ctrl+Shift+Enter in an empty message box). */
export function runContinuePrimary(): void {
  const s = useStore.getState();
  const p = continuePrimary(s.state);
  if (!p || continuePrimaryBlocker(s.state, liveContinueChat()) !== null) return;
  if (p.kind === "acceptAll" || p.kind === "acceptRest") runAcceptAllContinue();
  else if (p.kind === "continue") void continueWithoutAccepting();
  else s.requestChanges(null);
}

/** "Continue" and "Continue, Leave the Rest Pending": `Continue.` with nothing accepted; the review summary goes with it. */
export async function continueWithoutAccepting(): Promise<void> {
  const s = useStore.getState();
  const chat = liveContinueChat();
  const pending = s.state.gate.pendingCount;
  const why = pending === 0 ? continuePrimaryBlocker(s.state, chat) : continueLeavingRestBlocker(s.state, chat);
  if (why !== null) {
    showToast(why);
    return;
  }
  const done = pending === 0 ? t("Told Claude to continue") : t("Told Claude to continue — {0} file(s) still wait for review", pending);
  if (chat.terminal) {
    const ptyId = chat.terminal.ptyId;
    const stopped = await runTerminalAcceptContinue({
      paste: (text) => pasteIntoTerminal(ptyId, text),
      enter: () => sendToTerminal(ptyId, "\r"),
      refusal: (e) => refusalOf(e).error,
    });
    focusTerminal(ptyId);
    showToast(stopped ?? done);
    return;
  }
  s.send(CONTINUE_MESSAGE);
  showToast(done);
}
