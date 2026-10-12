/**
 * The message queue above the composer (src/renderer/sendQueue.ts): one chip per queued message — click to edit,
 * ‹ › to reorder, × to remove — plus the queue's state (sending next / waiting for the gate / paused with the reason
 * and Resume). Messages go out one at a time with the same gate as a plain Send.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { cannotSendReason, useStore } from "../../store";
import { waitingOf } from "../../agentDetails"; // MARK: wave3 desktop-agents
import { isEnter } from "../../ime";

export function QueueBar() {
  const queue = useStore((s) => s.queue);
  const canSend = useStore((s) => s.state.gate.canSend);
  const reason = useStore((s) => cannotSendReason(s.state));
  const edit = useStore((s) => s.editQueuedMessage);
  const remove = useStore((s) => s.removeQueuedMessage);
  const move = useStore((s) => s.moveQueuedMessage);
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
  if (queue.items.length === 0) return null;

  const status = queue.paused
    ? t("Paused: {0}", queue.paused)
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
        <span className="queue-title">{t("Queue ({0})", queue.items.length)}</span>
        <span className="queue-status truncate" title={status} data-testid="Queue status">{status}</span>
        {queue.paused && (
          <button type="button" className="small" onClick={resume} data-testid="Resume queue">{t("Resume")}</button>
        )}
        <button type="button" className="plain tiny" onClick={clear} title={t("Remove every queued message")} data-testid="Clear queue">{t("Clear")}</button>
      </div>
      <div className="queue-chips">
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
