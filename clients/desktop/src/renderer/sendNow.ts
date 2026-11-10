/**
 * §50 "Send now" (바로 보내기) — docs/PROTOCOL.md §50 in Electron, as on the Mac (ChatComposer.swift `canSteer` /
 * `sendWhileWorking`, AppState+Task.swift `canSteer`): while a turn of ours runs, a typed message goes into it (as typing
 * while Claude works does in the terminal) — Claude reads it once the current step is done and its changes join this
 * turn's review. A message with images waits in the queue (the CLI takes images only with a message of its own), and a
 * `steer` the engine refuses (the turn ended meanwhile, its review is being collected) is queued too (store `steer`).
 */
import type { ReviewState } from "@reviewgate/engine";
import { t } from "./i18n";

/** The session's half (Mac `AppState.canSteer`): a turn of ours runs — not another session's — in the chat shown. */
export function steerPossible(state: Pick<ReviewState, "gate" | "session">, viewing: boolean): boolean {
  return state.gate.phase === "running" && !state.session.externalTurn && !viewing;
}

/**
 * The composer's half (Mac `ChatComposer.canSteer`): the draft would be queued (`queueMode`: the gate is closed, a project
 * is open, no other chat shown), the turn can take it, and it has no images.
 */
export function canSteerDraft(state: Pick<ReviewState, "gate" | "session">, o: { queueMode: boolean; viewing: boolean; images: number }): boolean {
  return o.queueMode && o.images === 0 && steerPossible(state, o.viewing);
}

/**
 * What the composer's primary button does: a plain Send, else (Claude working) into the turn or the queue. r1-composer M08:
 * "answer" while Claude's question is open (`question`, src/renderer/openQuestion.ts) — the text answers it instead of
 * waiting behind it in the turn.
 */
export type PrimarySend = "send" | "steer" | "queue" | "answer" | "deny";

/** The primary button (Mac: "답하기" while Claude's question is open, "바로 보내기" while the turn can take the message, else "대기열에 추가", else Send). */
export function primarySend(o: { canSend: boolean; queueMode: boolean; canSteer: boolean; question?: boolean; card?: boolean }): PrimarySend {
  if (o.question) return "answer";
  // r2-chats-cards M24 (§33.10): a permission card waits and text is typed — the text answers the card.
  if (o.card) return "deny";
  if (o.canSend || !o.queueMode) return "send";
  return o.canSteer ? "steer" : "queue";
}

export type ComposerEnter = "acceptAndSend" | "send" | "stopAndSend" | "steer" | "queue" | "answer" | "deny";

/**
 * ⌘↩ (Ctrl+Enter) with a draft (Mac `handleCardShortcut` / `sendWhileWorking`): ⌘⇧↩ accepts and sends; a plain send when
 * the gate is open; ⌥⌘↩ stops the turn and sends; ⌘↩ while Claude works goes into the turn when it can take it, else the
 * queue. From another chat shown read-only only a plain ⌘↩ does anything (it sends there). r1-composer M08: while Claude's
 * question is open ⌘↩ answers it (an empty box: sends its card as it is).
 */
export function composerEnter(
  e: { shiftKey: boolean; altKey: boolean },
  o: { viewing: boolean; canSend: boolean; canSteer: boolean; question?: boolean; card?: boolean },
): ComposerEnter | null {
  if (o.viewing) return e.shiftKey || e.altKey ? null : "send";
  if (e.shiftKey) return "acceptAndSend";
  if (o.question) return e.altKey ? "stopAndSend" : "answer";
  // r2-chats-cards M24 (§33.10): with a permission card waiting, the text denies it as the instruction (⌥: stop and send).
  if (o.card) return e.altKey ? "stopAndSend" : "deny";
  if (o.canSend) return "send";
  if (e.altKey) return "stopAndSend";
  return o.canSteer ? "steer" : "queue";
}

/**
 * MARK: r2-review-flow — polish P4-composer-13: a plain Enter (no modifier) in the message box, as on the Mac. With "Return
 * sends the message" on (absent: on) it sends — "send" takes the ⌘↩ path (`composerEnter`) — and in an empty box (no text, no
 * open question) it is swallowed, so no stray blank line; Shift+Enter and Alt+Enter stay a new line (or ⌥↩'s own meaning), and
 * a palette open takes the key. Null: Enter is the textarea's (a new line), or a combination the caller reads itself.
 */
export function plainEnterAction(
  e: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean },
  o: { returnSends: boolean | undefined; paletteVisible: boolean; hasText: boolean; question: boolean },
): "send" | "swallow" | null {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return null;
  if (o.returnSends === false || o.paletteVisible) return null;
  return o.hasText || o.question ? "send" : "swallow";
}

/**
 * r1-composer M08: ⌥↩ (Alt+Enter) while Claude's question is open — the text goes to Claude apart from the question: into
 * the turn (read once the question is answered), else the queue. Null otherwise — ⌥↩ stays a new line.
 */
export function separateEnter(o: { question: boolean; hasText: boolean; queueMode: boolean; canSteer: boolean }): "steer" | "queue" | null {
  if (!o.question || !o.hasText || !o.queueMode) return null;
  return o.canSteer ? "steer" : "queue";
}

/**
 * The hint under the composer while Claude works (Mac: "… — ⌘↩로 바로 보내기" when the turn can take the message). Not while
 * ⌘↩ answers a permission card instead (`cardKeys`: one is open and the draft is empty) — the reason alone, as before.
 * r1-composer M08: while Claude's question is open, how the box answers it. polish P4-composer-13: with "Return sends the
 * message" on (`returnSends`) the key named is ↩ (Enter on Windows), as the Mac's hint says.
 */
export function workingHint(reason: string | null, canSteer: boolean, cardKeys = false, question = false, returnSends = false, cardWithText = false): string | null {
  if (question) {
    return returnSends
      ? t("Claude asked a question — ↩ to answer · ⌥↩ to send separately")
      : t("Claude asked a question — ⌘↩ to answer · ⌥↩ to send separately");
  }
  // r2-chats-cards M24 (§33.10): a card waits and text is typed.
  if (cardWithText) {
    return returnSends
      ? t("↩ denies the card with this instruction · ⌥⌘↩ stops and sends")
      : t("⌘↩ denies the card with this instruction · ⌥⌘↩ stops and sends");
  }
  if (reason === null || !canSteer || cardKeys) return reason;
  return returnSends ? t("{0} — ↩ sends it to Claude now", reason) : t("{0} — ⌘↩ sends it to Claude now", reason);
}
