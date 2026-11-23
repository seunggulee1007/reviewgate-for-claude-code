/**
 * The PR's Conversation (docs/PROTOCOL.md §60): the description, the general comments and the reviews as one
 * time-ordered thread — each with its author, its time (relative; the absolute one in the tooltip), its Markdown body
 * and "Open on GitHub".
 */
import { useMemo } from "react";
import type { PRDetail } from "@reviewgate/engine";
import { formatDate, relativeTime, t } from "../../i18n";
import { useStore } from "../../store";
import { prTimeline, reviewStateBadge, type TimelineItem } from "../../prConversation";
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
    </div>
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
