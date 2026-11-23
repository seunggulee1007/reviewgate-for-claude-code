/**
 * The PR's Conversation (docs/PROTOCOL.md §60): the description, the general comments and the reviews as one
 * time-ordered thread — each with its author, its time (relative; the absolute one in the tooltip), its Markdown body
 * and "Open on GitHub" — and under it the composer that posts `pr_comment`. Beside it, "Code comments (N)": every
 * inline comment by file and line, each row opening its line in the PR diff.
 */
import { Fragment, useMemo, useState } from "react";
import type { PRDetail } from "@reviewgate/engine";
import { formatDate, relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { codeCommentGroups, commentBlocker, excerpt, postComment, prTimeline, reviewStateBadge, type CodeCommentRow, type TimelineItem } from "../../prConversation";
import { isEnter } from "../../ime";
import { Markdown } from "../chat/Markdown";
import "../chat/chat.css";

export function PRConversation({ pr }: { pr: PRDetail }) {
  const conversation = useStore((s) => s.state.pr.conversation);
  const reviews = useStore((s) => s.state.pr.reviews);
  const items = useMemo(() => prTimeline(pr, conversation ?? [], reviews), [pr, conversation, reviews]);
  return (
    <div className="pr-conversation" data-testid="PR conversation">
      <ol className="pr-thread" aria-label={t("Conversation")}>
        {items.map((item) => (
          <li key={item.key}>
            <Entry item={item} />
          </li>
        ))}
      </ol>
      <CommentComposer />
    </div>
  );
}

/** "Code comments (N)" — the inline comments by file and line; a row shows its line in the Files view. Null without any. */
export function CodeComments({ onShow }: { onShow: () => void }) {
  const comments = useStore((s) => s.state.pr.comments);
  const files = useStore((s) => s.state.pr.files);
  const prShowComment = useStore((s) => s.prShowComment);
  const groups = useMemo(() => codeCommentGroups(comments, files), [comments, files]);
  if (comments.length === 0) return null;
  const show = (row: CodeCommentRow) => {
    prShowComment(row.path, row.side, row.line);
    onShow();
  };
  return (
    <div className="pr-side" data-testid="Code comments">
      <ul className="list" aria-label={t("Code comments ({0})", comments.length)}>
        <li className="section">{t("Code comments ({0})", comments.length)}</li>
        {groups.map((g) => (
          <Fragment key={g.path}>
            <li className="pr-cc-file" title={g.path}>
              <span className="truncate">{g.path}</span>
              <span className="num muted">{g.count}</span>
            </li>
            {g.rows.map((row) => {
              const first = row.comments[0]!;
              const where = row.line === null ? t("Outdated") : `${row.side === "LEFT" ? "−" : ""}${row.line}`;
              const title =
                row.line === null
                  ? t("Outdated — the line is no longer in the diff. Opens {0}.", g.path)
                  : t("Show {0}:{1} in the diff", g.path, row.line);
              return (
                <li key={row.key}>
                  <button type="button" className="pr-cc-row" onClick={() => show(row)} title={title} aria-label={`${title} — ${first.author}: ${excerpt(first.body)}`} data-testid={`Code comment ${row.key.replace("\u0000", " ")}`}>
                    <span className="pr-cc-line num muted">{where}</span>
                    <span className="truncate grow">
                      <span className="bold">{first.author}</span> {excerpt(first.body)}
                    </span>
                    {row.comments.length > 1 && <span className="num muted" title={t("{0} comment(s)", row.comments.length)}>💬 {row.comments.length}</span>}
                  </button>
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

/** "Leave a comment": Ctrl+Enter (⌘↩) or Comment sends; the text clears only once it was posted. */
function CommentComposer() {
  const isCommenting = useStore((s) => s.state.pr.isCommenting === true);
  const prComment = useStore((s) => s.prComment);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const blocker = commentBlocker(text, posting || isCommenting);
  const send = () => {
    if (blocker) return;
    setPosting(true);
    setRefusal(null);
    void postComment(text, prComment).then((next) => {
      setPosting(false);
      setText((now) => (next.refusal === null && now === text ? "" : now));
      setRefusal(next.refusal);
    });
  };
  return (
    <form
      className="pr-comment-composer"
      data-testid="PR comment composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        value={text}
        rows={4}
        placeholder={t("Leave a comment")}
        aria-label={t("Leave a comment")}
        aria-invalid={refusal !== null}
        aria-describedby={refusal !== null ? "pr-comment-refusal" : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isEnter(e) && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        data-testid="PR comment text"
      />
      <div className="row">
        {refusal !== null && (
          <span id="pr-comment-refusal" className="caption red pr-comment-refusal" role="alert" data-testid="PR comment refusal">
            {refusal}
          </span>
        )}
        <span className="spacer" />
        <span className="tiny faint">{t("⌘↩ to {0}", t("Comment"))}</span>
        <button type="submit" className="primary small" disabled={blocker !== null} title={blocker ?? undefined} data-testid="Post comment">
          {t("Comment")}
        </button>
      </div>
    </form>
  );
}

function Entry({ item }: { item: TimelineItem }) {
  const badge = item.kind === "review" ? reviewStateBadge(item.state) : null;
  const hasBody = item.body.trim() !== "";
  return (
    <article className={`pr-entry ${item.kind}${hasBody ? "" : " no-body"}`} data-testid={`PR entry ${item.key}`}>
      <header>
        <span className="bold truncate">{item.author}</span>
        {item.kind === "description" && <span className="pill gray">{t("Description")}</span>}
        {badge && <span className={`pill ${badge.color}`} data-testid="Review state">{badge.label}</span>}
        {item.kind !== "description" && (
          <time className="caption muted" dateTime={item.at} title={formatDate(item.at)}>
            {relativeTime(item.at)}
          </time>
        )}
        {item.kind === "comment" && item.edited && <span className="caption faint">{t("edited")}</span>}
        <span className="spacer" />
        {item.url && (
          <button type="button" className="plain small" onClick={() => void window.rg.openExternal(item.url!)} title={t("Open on GitHub")} data-testid="Open entry on GitHub">
            {t("Open on GitHub")}
          </button>
        )}
      </header>
      {hasBody ? <Markdown text={item.body} /> : item.kind === "description" ? <div className="pr-entry-empty caption muted">{t("No description provided.")}</div> : null}
    </article>
  );
}
