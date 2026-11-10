/**
 * One-line pending-review banner above the composer. It never implies that sending accepts: a message
 * sent while files await review is a question, and the list survives it (docs/PROTOCOL.md §10).
 * wave2 desktop-flow (§34.3, comp-04): the second line says what a send does to the review — Claude's new changes join
 * it on the same starting point; accept or reject first to review them on their own.
 */
import { t } from "../../i18n";
import { useStore } from "../../store";
import "../reviewRound.css";

export function PendingBanner() {
  const state = useStore((s) => s.state);
  const waiting = state.gate.pendingCount + state.gate.changesRequestedCount;
  if (waiting === 0) return null;
  const text = t("{0} files pending review — you can ask questions without accepting", waiting);
  const merge = t("Sending now adds Claude's new changes to this review (same starting point). To review them separately, accept or reject first.");
  return (
    <div className="pending-banner" title={t("Next pending file ⌘] · previous ⌘[ · Accept ⌘⇧A · Reject ⌘⇧R · Request changes ⌘⇧C")} data-testid="Pending review banner">
      <div className="truncate">☑ {text}</div>
      <div className="caption pending-merge" data-testid="Pending merge note">{merge}</div>
    </div>
  );
}
