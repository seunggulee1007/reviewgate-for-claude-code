/**
 * The PR's Conversation (docs/PROTOCOL.md §60): the description, the general comments (`state.pr.conversation`) and the
 * reviews (`state.pr.reviews`) as one time-ordered thread; the inline comments (`state.pr.comments`) by file and line.
 */
import type { PRComment, PRDetail, PRFileMeta, PRIssueComment, PRReview } from "@reviewgate/engine";
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
 * comments before reviews). A `PENDING` review (no `submittedAt`) stays out, and so does a COMMENTED review with no body —
 * GitHub makes one for every batch of inline comments (as the Mac app does); an APPROVED / CHANGES_REQUESTED review with an
 * empty body still shows its state.
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
      .filter((r): r is PRReview & { submittedAt: string } => r.state !== "PENDING" && r.submittedAt !== null && !(r.state === "COMMENTED" && r.body.trim() === ""))
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


/** Why the composer's send button is disabled (null: it is enabled). */
export function commentBlocker(text: string, posting: boolean): string | null {
  if (posting) return t("Posting the comment…");
  if (!text.trim()) return t("Write a comment first.");
  return null;
}

/**
 * Sends the composer's text: on `ok` the composer is empty again; a refusal keeps the text and says why under it.
 * `post` answers null on ok, else the refusal's words (the store's `prComment`).
 */
export async function postComment(text: string, post: (body: string) => Promise<string | null>): Promise<{ text: string; refusal: string | null }> {
  const refusal = await post(text);
  return refusal === null ? { text: "", refusal: null } : { text, refusal };
}

/** One line's inline comments (oldest first); `line` null: the file's outdated ones (their line left the diff). */
export type CodeCommentRow = { key: string; path: string; side: "LEFT" | "RIGHT"; line: number | null; comments: PRComment[] };
export type CodeCommentFile = { path: string; count: number; rows: CodeCommentRow[] };

/**
 * "Code comments (N)": every inline comment grouped by file (the PR's file order, then any other path by name) and,
 * in a file, by line (by number, the old side first on a tie; the outdated ones last).
 */
export function codeCommentGroups(comments: readonly PRComment[], files: readonly Pick<PRFileMeta, "filename">[]): CodeCommentFile[] {
  const byPath = new Map<string, Map<string, CodeCommentRow>>();
  for (const c of comments) {
    const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
    const key = c.line === null ? `${c.path}\u0000outdated` : `${c.path}\u0000${side}:${c.line}`;
    const rows = byPath.get(c.path) ?? new Map<string, CodeCommentRow>();
    byPath.set(c.path, rows);
    const row = rows.get(key) ?? { key, path: c.path, side: c.line === null ? "RIGHT" : side, line: c.line, comments: [] };
    rows.set(key, row);
    row.comments.push(c);
  }
  const order = new Map(files.map((f, i) => [f.filename, i]));
  const rank = (p: string) => order.get(p) ?? Number.MAX_SAFE_INTEGER;
  return [...byPath.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([path, rows]) => {
      const list = [...rows.values()].sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.side === b.side ? 0 : a.side === "LEFT" ? -1 : 1));
      for (const r of list) r.comments.sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id - b.id);
      return { path, count: list.reduce((n, r) => n + r.comments.length, 0), rows: list };
    });
}

/** The first line of a comment's text, for a one-line row. */
export function excerpt(body: string): string {
  return body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}
