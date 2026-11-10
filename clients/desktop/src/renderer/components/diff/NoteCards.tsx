/**
 * wave2 desktop-flow — review notes after `request_changes` (docs/PROTOCOL.md §34.4): a sent note stays in the review as
 * "요청함: … — 반영 확인" until the user checks it off (`remove_note`), a note whose line no longer exists reads "위치 사라짐",
 * and the notes the shown diff has no line for (gone, file notes, lines outside this range) sit above the diff instead of
 * disappearing. A note not sent yet looks as before (`Bubble`, delete).
 */
import type { ReviewNote } from "@reviewgate/engine";
import { t } from "../../i18n";
import { isTurnActive, noteLineLabel } from "../../reviewRound";
import { refusalText, useStore } from "../../store";
import { Bubble } from "./Bubble";
import "../reviewRound.css";

/** `remove_note` waits while a change request runs or is collected (its collection settles the notes). */
function useRemoveBlocked(): string | null {
  return useStore((s) => (s.state.gate.isRequestingChanges && isTurnActive(s.state.gate) ? refusalText("session_running") : null));
}

export function ReviewNoteBubble({ note, onRemove }: { note: ReviewNote; onRemove: () => void }) {
  const blocked = useRemoveBlocked();
  const line = noteLineLabel(note);
  const gone = note.anchor === "gone";
  if (!note.sent) {
    const meta = [line, gone ? t("Line no longer exists") : null].filter((x): x is string => x !== null).join(" · ");
    return <Bubble kind="note" body={note.body} meta={meta || undefined} onDelete={onRemove} />;
  }
  return (
    <div className="note-bubble note sent" data-testid="Sent note">
      <div className="body col" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6 }}>
          {line && <span className="caption muted num">{line}</span>}
          {gone && <span className="pill gray" title={t("A later change rewrote or removed the line this note was on")} data-testid="Note line gone">{t("Line no longer exists")}</span>}
          <span className="spacer" />
          <button
            type="button"
            className="small"
            disabled={blocked !== null}
            onClick={onRemove}
            title={blocked ?? t("Claude did what this note asked — remove it")}
            data-testid="Mark as addressed"
          >
            ✓ {t("Mark as addressed")}
          </button>
        </div>
        <div className="bubble-text">
          <span className="sent-label">{t("Requested: {0}", note.body)}</span>
        </div>
        {/* wave3 check-clients: the line it was written on, so what took its place can be found (as the Mac's card). */}
        {gone && note.excerpt.trim() !== "" && (
          <div className="caption muted mono truncate" title={note.excerpt} data-testid="Note gone excerpt">{note.excerpt}</div>
        )}
      </div>
    </div>
  );
}

/** The file's notes that have no line in the shown diff (see `placeNotes`). */
export function OutsideNotes({ notes, onRemove }: { notes: ReviewNote[]; onRemove: (id: string) => void }) {
  if (notes.length === 0) return null;
  return (
    <div className="outside-notes" data-testid="Outside notes">
      {notes.map((n) => (
        <ReviewNoteBubble key={n.id} note={n} onRemove={() => onRemove(n.id)} />
      ))}
    </div>
  );
}
