/**
 * One-line pending-review banner above the composer. It never implies that sending accepts: a message
 * sent while files await review is a question, and the list survives it (docs/PROTOCOL.md §10).
 * wave2 desktop-flow (§34.3, comp-04): the second line says what a send does to the review — Claude's new changes join
 * it on the same starting point; accept or reject first to review them on their own.
 */
import { t } from "../../i18n";
import { useStore } from "../../store";
import { removeQueued } from "../../sendQueue";
import { acceptAndSendHelp, acceptAndSendTitle, holdHelp, holdTitle, reviewFirstAcceptBlocker, reviewFirstHolds } from "../../reviewFirst"; // §64
import { showToast } from "../../toast";
import "../reviewRound.css";

export function PendingBanner() {
  const state = useStore((s) => s.state);
  const waiting = state.gate.pendingCount + state.gate.changesRequestedCount;
  if (waiting === 0) return null;
  if (state.gate.reviewFirst?.mode === "prompts") return <ReviewFirstBanner waiting={state.gate.reviewFirst.waiting} />; // §64
  const text = t("{0} files pending review — you can ask questions without accepting", waiting);
  // §64 (`reviewFirst: edits`, the default): the answer may not change files until the user decided.
  const merge = state.gate.reviewFirst?.mode === "edits"
    ? t("Until you accept or reject these files, Claude answers and reads but does not change files (Settings › Review).")
    : t("Sending now adds Claude's new changes to this review (same starting point). To review them separately, accept or reject first.");
  return (
    <div className="pending-banner" title={t("Next pending file ⌘] · previous ⌘[ · Accept ⌘⇧A · Reject ⌘⇧R · Request changes ⌘⇧C")} data-testid="Pending review banner">
      <div className="truncate">☑ {text}</div>
      <div className="caption pending-merge" data-testid="Pending merge note">{merge}</div>
    </div>
  );
}

/**
 * §64 `prompts`: a new message waits until the review is done — "리뷰를 먼저 끝내세요 — 대기 N개", and while one waits
 * [N개 수락 후 보내기] (every pending file accepted, then that message; off with the reason while it cannot go).
 */
function ReviewFirstBanner({ waiting }: { waiting: number }) {
  const state = useStore((s) => s.state);
  const held = useStore((s) => (s.queue.items[0] && reviewFirstHolds(s.state.gate, s.queue.items[0].text) ? s.queue.items[0] : null));
  const blocker = reviewFirstAcceptBlocker(state);
  const pending = state.gate.pendingCount;
  const acceptAndSend = () => {
    const st = useStore.getState();
    const first = st.queue.items[0];
    if (!first || reviewFirstAcceptBlocker(st.state) !== null) return;
    useStore.setState((x) => ({ queue: { ...x.queue, items: removeQueued(x.queue.items, first.id) } }));
    const { id: _id, text, ...extras } = first;
    st.send(text, { acceptPending: true, ...extras });
    showToast(t("Accepted {0} files and sent your message", pending));
  };
  return (
    <div className="pending-banner row" style={{ gap: 6 }} title={holdHelp()} data-testid="Review first banner">
      <div className="truncate grow">✋ {holdTitle(waiting)}</div>
      {held && (
        <button type="button" className="small" disabled={blocker !== null} onClick={acceptAndSend} title={blocker ?? acceptAndSendHelp()} data-testid="Review first accept and send">
          {acceptAndSendTitle(pending)}
        </button>
      )}
    </div>
  );
}
