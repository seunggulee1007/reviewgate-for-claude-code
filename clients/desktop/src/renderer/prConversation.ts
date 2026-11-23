/**
 * The PR's Conversation (docs/PROTOCOL.md §60): the description, the general comments (`state.pr.conversation`) and the
 * reviews (`state.pr.reviews`) as one time-ordered thread.
 */
import type { PRDetail, PRIssueComment, PRReview } from "@reviewgate/engine";
import { t } from "./i18n";

export type TimelineItem =
  | { kind: "description"; key: string; author: string; body: string; url: string }
  | { kind: "comment"; key: string; author: string; body: string; at: string; edited: boolean; url: string }
  | { kind: "review"; key: string; author: string; body: string; at: string; state: string; url: string | null };

function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The description first, then the comments and the submitted reviews merged by time (oldest first; equal times keep
 * comments before reviews). A `PENDING` review (no `submittedAt`) stays out; a review with an empty body still shows
 * its state.
 */
export function prTimeline(pr: Pick<PRDetail, "author" | "body" | "url">, conversation: readonly PRIssueComment[], reviews: readonly PRReview[]): TimelineItem[] {
  const rest: (TimelineItem & { at: string })[] = [
    ...conversation.map((c) => ({
      kind: "comment" as const,
      key: `c${c.id}`,
      author: c.author,
      body: c.body,
      at: c.createdAt,
      edited: c.updatedAt !== null && time(c.updatedAt) > time(c.createdAt),
      url: c.url,
    })),
    ...reviews
      .filter((r): r is PRReview & { submittedAt: string } => r.state !== "PENDING" && r.submittedAt !== null)
      .map((r) => ({ kind: "review" as const, key: `r${r.id}`, author: r.author, body: r.body, at: r.submittedAt, state: r.state, url: r.url })),
  ];
  rest.sort((a, b) => time(a.at) - time(b.at));
  return [{ kind: "description", key: "description", author: pr.author, body: pr.body, url: pr.url }, ...rest];
}

/** A review's state badge in the thread. */
export function reviewStateBadge(state: string): { label: string; color: string } {
  switch (state) {
    case "APPROVED":
      return { label: t("Approved"), color: "green" };
    case "CHANGES_REQUESTED":
      return { label: t("Changes requested"), color: "red" };
    case "COMMENTED":
      return { label: t("Commented"), color: "gray" };
    case "DISMISSED":
      return { label: t("Dismissed"), color: "gray" };
    default:
      return { label: state, color: "gray" };
  }
}

