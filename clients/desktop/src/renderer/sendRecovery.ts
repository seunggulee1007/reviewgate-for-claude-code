/**
 * wave2 check-clients — a message the engine accepted but could not hand to Claude is not lost (handoff M7 / §2.9, the
 * Mac's `recentSend` in AppState+Session.swift). When snapshot A fails, the engine's `send` resolves `ok` after an
 * `error{send_failed | lfs_missing}`: without this the queued message was dropped on its `ok` and a typed one was gone
 * with the cleared composer. The last send is remembered until it was answered and its turn is over (a "Stop & send" runs
 * only after the interrupted turn ended); such a failure puts it back at the front
 * of the (stopped) queue, where Resume sends it again. Pure, unit-tested through the store (sendRecoveryStore.test.ts).
 */
import type { QueuedMessage } from "./sendQueue";

export type SendAttempt = {
  message: Omit<QueuedMessage, "id">;
  /** The queued message (its id) when the queue sent it; null for a message sent from the composer. */
  queuedId: number | null;
  at: number;
  /** The `send` replied `ok`. */
  replied: boolean;
  /** A `send_failed` / `lfs_missing` said it never reached Claude; `failure` is that error in words. */
  failed: boolean;
  failure: string | null;
};

/** The `error` codes that mean the message that just went out did not reach Claude (§2.9: they stop the queue). */
export const SEND_FAILURE_CODES: ReadonlySet<string> = new Set(["send_failed", "lfs_missing"]);

/** The error event and the send's reply may arrive in either order: the send is remembered this long at most. */
export const SEND_ATTEMPT_MS = 60_000;

export function beginSendAttempt(message: Omit<QueuedMessage, "id">, queuedId: number | null, now: number): SendAttempt {
  return { message, queuedId, at: now, replied: false, failed: false, failure: null };
}

/** `error{code}` is the failure of `attempt` — the message that went out last, not yet over. */
export function failsSend(code: string | undefined, attempt: SendAttempt | null, now: number): attempt is SendAttempt {
  return attempt !== null && !attempt.failed && code !== undefined && SEND_FAILURE_CODES.has(code) && now - attempt.at < SEND_ATTEMPT_MS;
}

type TurnGate = { gate: { phase: string }; hud: { turnCount: number } };
const busy = (phase: string) => phase === "running" || phase === "collecting";

/** The turn the send started is over (running / collecting → anything else, or a new turn count): later failures are about something else. */
export function sendTurnOver(prev: TurnGate, next: TurnGate): boolean {
  return (busy(prev.gate.phase) && !busy(next.gate.phase)) || prev.hud.turnCount !== next.hud.turnCount;
}
