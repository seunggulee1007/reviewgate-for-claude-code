/**
 * One bubble under a diff line: a review note (orange, the Mac app's `NoteBubble`), a PR comment
 * (gray) or a PR draft (accent). Shared by the review DiffPane and the PR browser.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n";

export type BubbleKind = "note" | "comment" | "draft";

export type BubbleProps = {
  kind: BubbleKind;
  author?: string;
  /** Already formatted (`relativeTime` / `formatDate`). */
  time?: string;
  body: ReactNode;
  /** Extra caption after the kind pill, e.g. "+12" for the line the note was left on. */
  meta?: string;
  onDelete?: () => void;
  onReply?: () => void;
  testId?: string;
  /** MARK: wave3 desktop-flow — §36.14: more buttons before Reply (a PR comment's "Send to Claude"). */
  actions?: ReactNode;
};

const LABELS: Record<BubbleKind, () => string> = {
  note: () => t("Note"),
  comment: () => t("Comment"),
  draft: () => t("Draft"),
};

const PILL: Record<BubbleKind, string> = { note: "orange", comment: "gray", draft: "" };

export function Bubble(props: BubbleProps) {
  const testId = props.testId ?? (props.kind === "note" ? "Review note" : props.kind === "draft" ? "Draft comment" : "Comment");
  return (
    <div className={`note-bubble ${props.kind}`} data-testid={testId}>
      <div className="body col" style={{ gap: 4 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className={`pill ${PILL[props.kind]}`}>{LABELS[props.kind]()}</span>
          {props.author && <span className="caption bold truncate">{props.author}</span>}
          {props.meta && <span className="caption muted num">{props.meta}</span>}
          {props.time && <span className="caption faint">{props.time}</span>}
          <span className="spacer" />
          {props.actions}
          {props.onReply && (
            <button type="button" className="plain small" onClick={props.onReply} title={t("Reply")} data-testid="Reply">
              {t("Reply")}
            </button>
          )}
          {props.onDelete && (
            <button type="button" className="plain small" onClick={props.onDelete} title={t("Delete note")} aria-label={t("Delete note")} data-testid="Delete note">
              🗑
            </button>
          )}
        </div>
        <div className="bubble-text">{props.body}</div>
      </div>
    </div>
  );
}
