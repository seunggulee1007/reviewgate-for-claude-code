/**
 * Review submission (the Mac app's `SubmitReviewSheet`): summary, event (COMMENT / APPROVE /
 * REQUEST_CHANGES) and the drafts posted as inline comments. Posts one review via `pr_submit`; the
 * dialog stays open showing `state.pr.errorText` (gh stderr verbatim) on failure.
 */
import { useState } from "react";
import type { ReviewEvent } from "@reviewgate/engine";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { Modal } from "../Menu";
import "./pr.css";
import { isEnter } from "../../ime";

const EVENTS: { value: ReviewEvent; label: () => string }[] = [
  { value: "COMMENT", label: () => t("Comment") },
  { value: "APPROVE", label: () => t("Approve") },
  { value: "REQUEST_CHANGES", label: () => t("Request changes") },
];

export function SubmitReviewDialog({ onClose }: { onClose: () => void }) {
  const pr = useStore((s) => s.state.pr);
  const prSubmit = useStore((s) => s.prSubmit);
  const [summary, setSummary] = useState("");
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [error, setError] = useState<string | null>(null);
  const drafts = pr.draftComments;
  // GitHub rejects COMMENT / REQUEST_CHANGES reviews with neither a body nor comments.
  const canSubmit = event === "APPROVE" || drafts.length > 0 || summary.trim().length > 0;

  const submit = async () => {
    if (!canSubmit || pr.isSubmitting) return;
    setError(null);
    const hadDrafts = drafts.length > 0;
    const ok = await prSubmit(event, summary);
    const after = useStore.getState().state.pr;
    // Drafts are cleared only when the POST succeeded (a failed comment reload afterwards keeps errorText set).
    const posted = ok || after.errorText === null || (hadDrafts && after.draftComments.length === 0);
    if (posted) onClose();
    else setError(after.errorText ?? t("Review was not submitted."));
  };

  return (
    <Modal title={pr.selected ? t("Review {0}#{1}", pr.selectedSummary?.repo ?? "", pr.selected.number) : t("Submit review")} onClose={pr.isSubmitting ? undefined : onClose} wide testId="Submit review dialog">
      {pr.selected && <div className="muted truncate" title={pr.selected.title}>{pr.selected.title}</div>}
      <label className="field">
        <span className="bold">{t("Summary")}</span>
        <textarea
          value={summary}
          rows={5}
          autoFocus
          data-testid="Review summary"
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
      </label>
      <div className="row" role="radiogroup" data-testid="Review event">
        {EVENTS.map((ev) => (
          <label key={ev.value} className="row" style={{ gap: 4 }}>
            <input type="radio" name="review-event" value={ev.value} checked={event === ev.value} onChange={() => setEvent(ev.value)} />
            {ev.label()}
          </label>
        ))}
      </div>
      <div className="bold">{t("Inline comments ({0})", drafts.length)}</div>
      {drafts.length === 0 ? (
        <div className="caption muted">{t("No drafts — only the summary will be posted.")}</div>
      ) : (
        <ul className="list card" style={{ maxHeight: 200, overflow: "auto", padding: 4 }} data-testid="Draft list">
          {drafts.map((d) => (
            <li key={d.id} className="col" style={{ gap: 1 }}>
              <span className="caption muted mono truncate" title={`${d.path}:${d.line}`}>{d.path}:{d.line}</span>
              <span className="truncate">{d.body.split(/\r?\n/)[0]}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="banner orange pr-error" style={{ borderRadius: 6, maxHeight: 120 }} data-testid="Submit error">{error}</div>}
      <div className="actions">
        {pr.isSubmitting && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={pr.isSubmitting} onClick={onClose}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={!canSubmit || pr.isSubmitting} onClick={() => void submit()} data-testid="Submit review">
          {drafts.length === 0 ? t("Submit summary only") : t("Submit review")}
        </button>
      </div>
    </Modal>
  );
}
