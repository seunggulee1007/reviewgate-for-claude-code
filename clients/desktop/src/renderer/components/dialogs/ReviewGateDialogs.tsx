/**
 * wave1 desktop-review — the review-provenance dialogs (docs/PROTOCOL.md §31): the stale-review sheet ("오래된 리뷰입니다" →
 * 정리 = `finish_review` / 이어서 리뷰 = `keep_review`), the "리뷰 끝내기" confirm, and the second confirm before files
 * changed outside the app are reverted (answered through the store's `answerRejectExternal`).
 */
import { useState } from "react";
import { t } from "../../i18n";
import { staleLines } from "../../reviewGate";
import { refusalText, useStore } from "../../store";
import { Modal } from "../Menu";
import { ConfirmDialog } from "./ConfirmDialog";
import "./dialogs.css";

/** What `finish_review` does, said before it is sent (the sheet and the toolbar confirm). */
function FinishExplanation({ notes }: { notes: number }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div>{t("Clean up only empties the review list: the files stay on disk as they are and become the baseline from the next message.")}</div>
      {notes > 0 && <div className="orange" data-testid="Finish notes warning">{t("{0} note(s) are cleared too", notes)}</div>}
    </div>
  );
}

/** §31.5: shown once when `open_project` restored a stale review (HEAD moved / 12 h old); closing it decides nothing. */
export function StaleReviewDialog({ onClose }: { onClose: () => void }) {
  const stale = useStore((s) => s.state.gate.stale ?? null);
  const notes = useStore((s) => s.state.reviewNotes.filter((n) => !n.sent).length); // wave2 desktop-flow — §34.4: unsent notes
  const finishReview = useStore((s) => s.finishReview);
  const keepReview = useStore((s) => s.keepReview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!stale) return null;

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const refusal = await action();
    setBusy(false);
    if (refusal === null) onClose();
    else setError(refusalText(refusal));
  };

  return (
    <Modal title={t("This review is old")} onClose={busy ? undefined : onClose} testId="Stale review dialog">
      <div className="message col" style={{ gap: 4 }} data-testid="Stale review reasons">
        {staleLines(stale).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <div className="hint">
        <FinishExplanation notes={notes} />
      </div>
      {error && <div className="hint error" data-testid="Stale review error">{error}</div>}
      <div className="actions">
        {busy && <span className="spinner" />}
        <span className="spacer" />
        <button type="button" disabled={busy} onClick={() => void run(keepReview)} title={t("Keep the review as it is and continue")} data-testid="Keep reviewing">
          {t("Keep reviewing")}
        </button>
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void run(finishReview)} data-testid="Clean up review">
          {t("Clean up")}
        </button>
      </div>
    </Modal>
  );
}

/** "리뷰 끝내기" (toolbar / restored banner): confirm, then `finish_review`. */
export function FinishReviewDialog({ onClose }: { onClose: () => void }) {
  const notes = useStore((s) => s.state.reviewNotes.filter((n) => !n.sent).length); // wave2 desktop-flow — §34.4: unsent notes
  const finishReview = useStore((s) => s.finishReview);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      title={t("Finish this review?")}
      message={<FinishExplanation notes={notes} />}
      confirmLabel={t("Finish review")}
      busy={busy}
      onConfirm={() => {
        setBusy(true);
        void finishReview().then(() => {
          setBusy(false);
          onClose();
        });
      }}
      onCancel={onClose}
      testId="Finish review dialog"
    />
  );
}

/** §31.2: these files may be the user's or another session's work — revert them only on an explicit yes. */
export function RejectExternalDialog({ paths, all }: { paths: string[]; all: boolean }) {
  const answer = useStore((s) => s.answerRejectExternal);
  return (
    <ConfirmDialog
      title={all ? t("Revert the outside changes too?") : t("Revert a change made outside the app?")}
      message={
        <div className="col" style={{ gap: 8, alignItems: "stretch" }}>
          <div>{t("These files may not have been changed by Claude. Reverting them discards those edits:")}</div>
          <ul className="list accept-all-list" data-testid="Reject external files">
            {paths.map((p) => (
              <li key={p} className="mono" data-testid={`Reject external row ${p}`}>{p}</li>
            ))}
          </ul>
        </div>
      }
      confirmLabel={t("Revert them")}
      cancelLabel={t("Keep them")}
      danger
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
      testId="Reject external dialog"
    />
  );
}
