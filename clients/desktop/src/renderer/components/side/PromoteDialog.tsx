/**
 * "메인 대화로 보내기" / "리뷰 노트로 추가" (docs/PROTOCOL.md §21 promote): the engine drafts an instruction from the
 * thread (`side_promote_draft`), the user edits it here and sees where it goes, then `side_promote {as, text}`.
 * A closed gate (`gate_closed:running`) offers the composer queue instead; other refusals are shown in words.
 */
import { useEffect, useRef } from "react";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { promoteTarget } from "../../sideThreads";
import { Modal } from "../Menu";
import { isEnter } from "../../ime";

export function PromoteDialog() {
  const d = useStore((s) => s.promoteDraft);
  const th = useStore((s) => (s.promoteDraft ? s.side.threads[s.promoteDraft.threadId] : undefined));
  const edit = useStore((s) => s.editPromote);
  const submit = useStore((s) => s.submitPromote);
  const queue = useStore((s) => s.queuePromote);
  const cancel = useStore((s) => s.cancelPromote);
  const noteable = useStore((s) => {
    const a = th?.anchor;
    return !!a?.path && !a.entryId && s.state.changedFiles.some((f) => f.path === a.path);
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const loading = d?.loading === true;

  useEffect(() => {
    if (!loading) ref.current?.focus();
  }, [loading]);

  if (!d) return null;
  const anchor = th?.anchor ?? null;
  const busy = d.sending;
  return (
    <Modal title={d.as === "note" ? t("Add as a review note") : t("Send to the main conversation")} onClose={busy ? undefined : cancel} wide testId="Promote dialog">
      <div className="segmented promote-as" role="radiogroup" aria-label={t("Where it goes")}>
        <button type="button" className={d.as === "message" ? "active" : ""} disabled={busy} onClick={() => edit({ as: "message" })} data-testid="Promote as message">
          ↗ {t("Message")}
        </button>
        <button
          type="button"
          className={d.as === "note" ? "active" : ""}
          disabled={busy || !noteable}
          onClick={() => edit({ as: "note" })}
          title={noteable ? undefined : t("Only for a thread about a file of the current review")}
          data-testid="Promote as note"
        >
          ✎ {t("Review note")}
        </button>
      </div>
      <div className="promote-target" data-testid="Promote target">
        <span className="arrow" aria-hidden="true">→</span>
        <span>{promoteTarget(d.as, anchor)}</span>
      </div>
      <div className="promote-edit">
        {loading && (
          <div className="promote-loading" data-testid="Promote loading">
            <span className="spinner" aria-hidden="true" /> {t("Summarizing the thread into an instruction…")}
          </div>
        )}
        <textarea
          ref={ref}
          className="body"
          value={d.text}
          disabled={busy}
          placeholder={loading ? "" : t("What should Claude do? Reference files and lines.")}
          onChange={(e) => edit({ text: e.target.value })}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={9}
          data-testid="Promote text"
        />
        <div className="tiny faint">{d.as === "message" ? t("“(곁질문에서 정리됨)” is added at the end so Claude knows where it came from.") : t("The note is kept with the review and goes to Claude with Request changes.")}</div>
      </div>
      {d.error && (
        <div className={`banner ${d.recovery ? "orange" : "red"} promote-error`} data-testid="Promote error">
          <span className="grow">{d.error}</span>
          {d.recovery === "queue" && (
            <button type="button" className="small primary" onClick={queue} disabled={!d.text.trim()} data-testid="Promote queue">
              {t("Add to the queue")}
            </button>
          )}
        </div>
      )}
      <div className="actions">
        {busy && <span className="spinner" />}
        <span className="tiny faint grow">{t("⌘↩ to {0}", d.as === "note" ? t("Add note") : t("Send"))}</span>
        <button type="button" onClick={cancel} disabled={busy}>{t("Cancel")}</button>
        <button type="button" className="primary" disabled={busy || loading || !d.text.trim()} onClick={() => void submit()} data-testid="Promote submit">
          {d.as === "note" ? t("Add note") : t("Send")}
        </button>
      </div>
    </Modal>
  );
}
