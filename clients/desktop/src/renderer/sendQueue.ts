/**
 * Client-side message queue (pure, unit-tested). Messages typed while Claude works wait as chips above the
 * composer and go out one at a time, in order, once a plain Send would be allowed (`gate.canSend` — the same
 * gate as a manual send, never `acceptPending`). The queue pauses itself on an error, on a turn the user stopped
 * and when the chat changes; the user resumes it. "Stop & send" puts the message first and interrupts the turn.
 */
import type { SendAttachment } from "@reviewgate/engine";

/** `mentions` / `attachments` (§23 / §24) go out with the text exactly as they were when it was queued. */
export type QueuedExtras = { mentions?: string[]; attachments?: SendAttachment[]; /** MARK: wave5 w5-model — §43.4: this message's own model. */ model?: string };
export type QueuedMessage = { id: number; text: string } & QueuedExtras;

export type QueueState = {
  items: QueuedMessage[];
  /** Why the queue stopped sending (shown on the queue bar); null = active. */
  paused: string | null;
  /** A queued `send` is waiting for its reply. */
  inflight: boolean;
  /** The last queued message was accepted; wait for its turn to start / end before the next one. */
  awaitingTurn: boolean;
  /** The next interrupted turn was "Stop & send" — it must not pause the queue. */
  skipInterruptPause: boolean;
};

export const EMPTY_QUEUE: QueueState = { items: [], paused: null, inflight: false, awaitingTurn: false, skipInterruptPause: false };

/** The message to send now, or null. */
export function nextToSend(q: QueueState, gate: { canSend: boolean }): QueuedMessage | null {
  if (q.items.length === 0 || q.paused !== null || q.inflight || q.awaitingTurn || !gate.canSend) return null;
  return q.items[0]!;
}

let seq = 1;
export function enqueue(items: QueuedMessage[], text: string, front = false, extras: QueuedExtras = {}): QueuedMessage[] {
  const t = text.trim();
  if (t.length === 0) return items;
  const m: QueuedMessage = { id: seq++, text: t, ...sendExtras(extras) };
  return front ? [m, ...items] : [...items, m];
}

export function removeQueued(items: QueuedMessage[], id: number): QueuedMessage[] {
  return items.filter((m) => m.id !== id);
}

/** Empty text removes the message. */
export function editQueued(items: QueuedMessage[], id: number, text: string): QueuedMessage[] {
  const t = text.trim();
  return t.length === 0 ? removeQueued(items, id) : items.map((m) => (m.id === id ? { ...m, text: t } : m));
}

/** Moves one message earlier (-1) or later (1); out-of-range moves are no-ops. */
export function moveQueued(items: QueuedMessage[], id: number, dir: -1 | 1): QueuedMessage[] {
  const i = items.findIndex((m) => m.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * A turn that ended this way pauses the queue (null = keep going). `interrupted` is skipped once after "Stop & send". §38.2:
 * the tool-call limit (`error_max_turns`) does not stop it — the limit counts per message, and the row offers [이어서 계속].
 */
export function pauseReasonForTurnEnd(stopReason: string, skipInterruptPause: boolean): "interrupted" | "error" | null {
  if (stopReason === "interrupted") return skipInterruptPause ? null : "interrupted";
  if (stopReason === "error_max_turns") return null;
  if (stopReason.startsWith("error") || stopReason === "session closed") return "error";
  return null;
}

/** Only the non-empty extras, ready to spread into a `send` command. */
export function sendExtras(e: QueuedExtras): QueuedExtras {
  return {
    ...(e.mentions && e.mentions.length > 0 ? { mentions: e.mentions } : {}),
    ...(e.attachments && e.attachments.length > 0 ? { attachments: e.attachments } : {}),
    ...(typeof e.model === "string" && e.model.length > 0 ? { model: e.model } : {}), // MARK: wave5 w5-model (§43.4)
  };
}
