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
export type PrimarySend = "send" | "steer" | "queue" | "answer";

/** The primary button (Mac: "답하기" while Claude's question is open, "바로 보내기" while the turn can take the message, else "대기열에 추가", else Send). */
export function primarySend(o: { canSend: boolean; queueMode: boolean; canSteer: boolean; question?: boolean }): PrimarySend {
  if (o.question) return "answer";
  if (o.canSend || !o.queueMode) return "send";
  return o.canSteer ? "steer" : "queue";
}

export type ComposerEnter = "acceptAndSend" | "send" | "stopAndSend" | "steer" | "queue" | "answer";

/**
 * ⌘↩ (Ctrl+Enter) with a draft (Mac `handleCardShortcut` / `sendWhileWorking`): ⌘⇧↩ accepts and sends; a plain send when
 * the gate is open; ⌥⌘↩ stops the turn and sends; ⌘↩ while Claude works goes into the turn when it can take it, else the
 * queue. From another chat shown read-only only a plain ⌘↩ does anything (it sends there). r1-composer M08: while Claude's
 * question is open ⌘↩ answers it (an empty box: sends its card as it is).
 */
export function composerEnter(
  e: { shiftKey: boolean; altKey: boolean },
  o: { viewing: boolean; canSend: boolean; canSteer: boolean; question?: boolean },
): ComposerEnter | null {
  if (o.viewing) return e.shiftKey || e.altKey ? null : "send";
  if (e.shiftKey) return "acceptAndSend";
  if (o.question) return e.altKey ? "stopAndSend" : "answer";
  if (o.canSend) return "send";
  if (e.altKey) return "stopAndSend";
  return o.canSteer ? "steer" : "queue";
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
 * r1-composer M08: while Claude's question is open, how the box answers it.
 */
export function workingHint(reason: string | null, canSteer: boolean, cardKeys = false, question = false): string | null {
  if (question) return t("Claude asked a question — ⌘↩ to answer · ⌥↩ to send separately");
  return reason !== null && canSteer && !cardKeys ? t("{0} — ⌘↩ sends it to Claude now", reason) : reason;
}
