/**
 * The message queue above the composer (src/renderer/sendQueue.ts): one chip per queued message — click to edit,
 * ‹ › to reorder, × to remove — plus the queue's state (sending next / waiting for the gate / paused with the reason
 * and Resume). Messages go out one at a time with the same gate as a plain Send. §50.1: a pause that ends by itself (the
 * API, the usage limit) says when, with [지금 보내기]; after the user's Stop the next message waits for [보내기].
 * §50.3: a message in Claude's turn can be taken back (×) or brought back into the composer to edit (✎) until Claude
 * reads it, as ↑ does in the terminal; every chip has the same tools in its context menu.
 */
import { useEffect, useRef, useState } from "react";
import { resetTimeText } from "../../errorCodes";
import { t } from "../../i18n";
import { cannotSendReason, useStore } from "../../store";
import { waitingOf } from "../../agentDetails"; // MARK: wave3 desktop-agents
import { isEnter } from "../../ime";
import { queuedSendNow } from "../../sendQueue";
import { steerPossible } from "../../sendNow";
import { useAgentContextMenu, type AgentMenuItem } from "../agents/AgentBits";

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
  const toComposer = useStore((s) => s.editQueuedInComposer); // §50.3
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
          <SteeringChip key={m.id} id={m.id} text={m.text} />
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
            <QueuedChip
              key={m.id}
              index={i}
              count={queue.items.length}
              text={m.text}
              sendNowTitle={sendNowHelp(queuedSendNow(m, { canSteer, running }))}
              onEdit={() => {
                setEditing(m.id);
                setText(m.text);
              }}
              onToComposer={() => toComposer(m.id)}
              onSendNow={() => sendNow(m.id)}
              onMove={(dir) => move(m.id, dir)}
              onRemove={() => remove(m.id)}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** §50.3: what a steering chip's tools say (and, while it is being taken back, why they wait). */
export function takeBackHelp(): { edit: string; remove: string; busy: string; chip: string } {
  return {
    edit: t("Edit — takes it back from Claude's turn into the message box (↑ in an empty box does too); ↩ sends it again"),
    remove: t("Take back — Claude never sees it"),
    busy: t("Taking it back from Claude's turn…"),
    chip: t("In Claude's turn — Claude reads it after the current step. Until then, click to edit it or × to take it back."),
  };
}

/**
 * composer §50.2: a message already in Claude's turn, waiting until Claude reads it. §50.3: until then ✎ (or a click)
 * brings it back into the composer and × takes it back (the CLI drops it); too late, a toast says so and its row stays.
 */
function SteeringChip({ id, text }: { id: string; text: string }) {
  const busy = useStore((s) => s.steerTakingBack.includes(id));
  const takeBack = useStore((s) => s.takeBackSteering);
  const help = takeBackHelp();
  const items: AgentMenuItem[] = [
    { label: t("Edit in Message Box"), onClick: () => void takeBack(id, true), disabled: busy ? help.busy : null, testId: "Queue steering menu edit" },
    { label: t("Take Back"), onClick: () => void takeBack(id, false), disabled: busy ? help.busy : null, danger: true, testId: "Queue steering menu take back" },
  ];
  const menu = useAgentContextMenu(items);
  return (
    <span className={`queue-chip steering${busy ? " busy" : ""}`} data-testid="Queue steering chip" onContextMenu={menu.onContextMenu}>
      <span className="queue-num" aria-hidden>↳</span>
      <button
        type="button"
        className="queue-text truncate"
        disabled={busy}
        title={`${text}\n\n${busy ? help.busy : help.chip}`}
        onClick={() => void takeBack(id, true)}
      >
        {text}
      </button>
      <span className="queue-tools">
        {busy ? (
          <span className="queue-busy" role="status" aria-label={help.busy} title={help.busy} data-testid="Queue steering busy">…</span>
        ) : (
          <>
            <button type="button" onClick={() => void takeBack(id, true)} aria-label={t("Edit the message in Claude's turn")} title={help.edit} data-testid="Queue steering edit">✎</button>
            <button type="button" onClick={() => void takeBack(id, false)} aria-label={t("Take back the message in Claude's turn")} title={help.remove} data-testid="Queue steering take back">×</button>
          </>
        )}
      </span>
      {menu.menu}
    </span>
  );
}

/** A queued message: click or ✎ to edit, ⏎ send now, ‹ › reorder, × remove — and the same in its context menu. */
function QueuedChip(p: {
  index: number;
  count: number;
  text: string;
  sendNowTitle: string;
  onEdit: () => void;
  onToComposer: () => void;
  onSendNow: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const first = p.index === 0;
  const last = p.index === p.count - 1;
  const items: AgentMenuItem[] = [
    { label: t("Edit…"), onClick: p.onEdit, testId: "Queue menu edit" },
    { label: t("Edit in Message Box"), onClick: p.onToComposer, testId: "Queue menu to composer" },
    { label: t("Send Now"), onClick: p.onSendNow, testId: "Queue menu send now" },
    { label: t("Move Earlier"), onClick: () => p.onMove(-1), disabled: first ? t("Already first in the queue") : null, testId: "Queue menu earlier" },
    { label: t("Move Later"), onClick: () => p.onMove(1), disabled: last ? t("Already last in the queue") : null, testId: "Queue menu later" },
    { label: t("Remove"), onClick: p.onRemove, danger: true, testId: "Queue menu remove" },
  ];
  const menu = useAgentContextMenu(items);
  return (
    <span className="queue-chip" data-testid="Queue chip" onContextMenu={menu.onContextMenu}>
      <span className="queue-num">{p.index + 1}</span>
      <button type="button" className="queue-text truncate" title={`${p.text}\n\n${t("Queued — click to edit; ↑ in an empty message box brings the last one back")}`} onClick={p.onEdit}>
        {p.text}
      </button>
      <span className="queue-tools">
        <button type="button" onClick={p.onEdit} aria-label={t("Edit queued message {0}", p.index + 1)} title={t("Edit this queued message")} data-testid="Queue edit button">✎</button>
        <button type="button" onClick={p.onSendNow} aria-label={t("Send now")} title={p.sendNowTitle} data-testid="Queue send now">
          ⏎
        </button>
        <button type="button" disabled={first} onClick={() => p.onMove(-1)} aria-label={t("Move earlier")} title={first ? t("Already first in the queue") : t("Move earlier")}>‹</button>
        <button type="button" disabled={last} onClick={() => p.onMove(1)} aria-label={t("Move later")} title={last ? t("Already last in the queue") : t("Move later")}>›</button>
        <button type="button" onClick={p.onRemove} aria-label={t("Remove from queue")} title={t("Remove from queue")} data-testid="Queue remove">×</button>
      </span>
      {menu.menu}
    </span>
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
