/**
 * The message queue above the composer (src/renderer/sendQueue.ts): one chip per queued message — click to edit,
 * ‹ › to reorder, × to remove — plus the queue's state (sending next / waiting for the gate / paused with the reason
 * and Resume). Messages go out one at a time with the same gate as a plain Send. §50.1: a pause that ends by itself (the
 * API, the usage limit) says when, with [지금 보내기]; after the user's Stop the next message waits for [보내기].
 */
import { useEffect, useRef, useState } from "react";
import { resetTimeText } from "../../errorCodes";
import { t } from "../../i18n";
import { cannotSendReason, useStore } from "../../store";
import { waitingOf } from "../../agentDetails"; // MARK: wave3 desktop-agents
import { isEnter } from "../../ime";
import { queuedSendNow } from "../../sendQueue";
import { steerPossible } from "../../sendNow";

const NO_STEERING: readonly { id: string; text: string }[] = [];

export function QueueBar() {
  const queue = useStore((s) => s.queue);
  // MARK: composer — §50.2: messages already put into Claude's turn wait here until Claude reads them (as in the terminal).
  const steering = useStore((s) => s.state.session.steering ?? NO_STEERING);
  const canSend = useStore((s) => s.state.gate.canSend);
  const reason = useStore((s) => cannotSendReason(s.state));
  const edit = useStore((s) => s.editQueuedMessage);
  const remove = useStore((s) => s.removeQueuedMessage);
  const move = useStore((s) => s.moveQueuedMessage);
  const sendNow = useStore((s) => s.sendQueuedNow); // MARK: composer
  // MARK: composer — what "Send now" on a chip does (sendQueue.ts `queuedSendNow`), said on its tooltip.
  const canSteer = useStore((s) => steerPossible(s.state, false));
  const running = useStore((s) => s.state.gate.phase === "running");
  const resume = useStore((s) => s.resumeQueue);
  const clear = useStore((s) => s.clearQueue);
  // MARK: wave3 desktop-agents — §36.4: the main turn waits on subagents → the queue goes out when they are done.
  const waitingOnAgents = useStore((s) => s.state.gate.blockedReason === "running" && waitingOf(s.state.hud) !== null);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing !== null) editRef.current?.focus();
  }, [editing]);
  if (queue.items.length === 0 && steering.length === 0) return null;

  const resumesAt = queue.resumeAt != null ? resetTimeText(new Date(queue.resumeAt).toISOString()) : null;
  const status = queue.items.length === 0
    ? t("In Claude's turn — Claude reads it after the current step")
    : queue.paused
    ? queue.afterStop === true
      ? queue.paused
      : resumesAt !== null
        ? `${t("Paused: {0}", queue.paused)} · ${t("Sends again at {0}", resumesAt)}`
        : t("Paused: {0}", queue.paused)
    : queue.inflight
      ? t("Sending…")
      : canSend && !queue.awaitingTurn
        ? t("Sending next…")
        : waitingOnAgents
          ? t("Sends when the agents finish")
          : t("Waiting — {0}", reason ?? t("Claude is working…"));

  const commit = () => {
    if (editing !== null) edit(editing, text);
    setEditing(null);
  };

  return (
    <div className={`queue-bar ${queue.paused ? "paused" : ""}`} data-testid="Queue">
      <div className="queue-head">
        <span className="queue-title">{t("Queue ({0})", queue.items.length + steering.length)}</span>
        <span className="queue-status truncate" title={status} data-testid="Queue status">{status}</span>
        {queue.paused && (
          <button type="button" className="small" onClick={resume} data-testid="Resume queue">
            {queue.afterStop === true ? t("Send") : queue.resumeAt != null ? t("Send it now") : t("Resume")}
          </button>
        )}
        {queue.items.length > 0 && (
          <button type="button" className="plain tiny" onClick={clear} title={t("Remove every queued message")} data-testid="Clear queue">{t("Clear")}</button>
        )}
      </div>
      <div className="queue-chips">
        {steering.map((m) => (
          <span
            key={m.id}
            className="queue-chip steering"
            title={`${m.text}\n\n${t("Already in Claude's turn — Claude reads it after the current step")}`}
            data-testid="Queue steering chip"
          >
            <span className="queue-num" aria-hidden>↳</span>
            <span className="queue-text truncate">{m.text}</span>
          </span>
        ))}
        {queue.items.map((m, i) =>
          editing === m.id ? (
            <span key={m.id} className="queue-chip editing">
              <span className="queue-num">{i + 1}</span>
              <input
                ref={editRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (isEnter(e)) {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(null);
                  }
                }}
                aria-label={t("Edit queued message")}
                data-testid="Queue edit"
              />
            </span>
          ) : (
            <span key={m.id} className="queue-chip" data-testid="Queue chip">
              <span className="queue-num">{i + 1}</span>
              <button
                type="button"
                className="queue-text truncate"
                title={`${m.text}\n\n${t("Click to edit")}`}
                onClick={() => {
                  setEditing(m.id);
                  setText(m.text);
                }}
              >
                {m.text}
              </button>
              <span className="queue-tools">
                <button
                  type="button"
                  onClick={() => sendNow(m.id)}
                  aria-label={t("Send now")}
                  title={sendNowHelp(queuedSendNow(m, { canSteer, running }))}
                  data-testid="Queue send now"
                >
                  ⏎
                </button>
                <button type="button" disabled={i === 0} onClick={() => move(m.id, -1)} aria-label={t("Move earlier")} title={t("Move earlier")}>‹</button>
                <button type="button" disabled={i === queue.items.length - 1} onClick={() => move(m.id, 1)} aria-label={t("Move later")} title={t("Move later")}>›</button>
                <button type="button" onClick={() => remove(m.id)} aria-label={t("Remove from queue")} title={t("Remove from queue")} data-testid="Queue remove">×</button>
              </span>
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** MARK: composer — the chip's "Send now" tooltip: what it does now. */
export function sendNowHelp(how: ReturnType<typeof queuedSendNow>): string {
  return how === "steer"
    ? t("Send now — into Claude's turn: Claude reads it after the current step")
    : how === "stopAndSend"
      ? t("Send now — stops Claude's turn and sends this message right after")
      : t("Send now — this message goes first");
}
