/**
 * MARK: wave3 desktop-flow
 * docs/PROTOCOL.md §36.14 — PRs and Claude, kept free of React so they are tested (the Mac's `PRClaude`): review comments
 * grouped in threads and which are still unresolved, the composer draft "Send to Claude" puts in (the repository's PR command
 * first, the comments quoted — a PR's text is the reviewers', never the user's instruction), the branch a PR workbench is
 * created on, whether a PR is of the open project's repository, and the side-question anchor of a PR diff line (its hunk).
 */
import type { DiffLine, FileDiff, PRComment, SidePrAnchor } from "@reviewgate/engine";
import { t } from "./i18n";

/** `SidePrAnchor.hunk`: the engine cuts longer hunks; the client never sends more. */
export const MAX_PR_HUNK_CHARS = 4000;

/** A review comment and its replies (GitHub replies always name the thread's first comment). */
export type PRCommentThread = { root: PRComment; replies: PRComment[] };

export const threadComments = (th: PRCommentThread): PRComment[] => [th.root, ...th.replies];
export const lastComment = (th: PRCommentThread): PRComment => th.replies[th.replies.length - 1] ?? th.root;

const byTime = (a: PRComment, b: PRComment) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id;

/** The comments grouped in threads (oldest first; replies in order; a reply whose first comment is gone is a thread of its own). */
export function prThreads(comments: readonly PRComment[]): PRCommentThread[] {
  const roots = comments.filter((c) => c.inReplyTo === null || c.inReplyTo === undefined).sort(byTime);
  const rootIds = new Set(roots.map((c) => c.id));
  const replies = new Map<number, PRComment[]>();
  const orphans: PRComment[] = [];
  for (const c of comments) {
    if (c.inReplyTo === null || c.inReplyTo === undefined) continue;
    if (rootIds.has(c.inReplyTo)) replies.set(c.inReplyTo, [...(replies.get(c.inReplyTo) ?? []), c]);
    else orphans.push(c);
  }
  return [
    ...roots.map((root) => ({ root, replies: (replies.get(root.id) ?? []).sort(byTime) })),
    ...orphans.sort(byTime).map((root) => ({ root, replies: [] })),
  ];
}

/** The thread a comment belongs to. */
export function threadOf(comment: PRComment, comments: readonly PRComment[]): PRCommentThread | null {
  const rootId = comment.inReplyTo ?? comment.id;
  return prThreads(comments).find((th) => th.root.id === rootId || threadComments(th).some((c) => c.id === comment.id)) ?? null;
}

/**
 * Threads still waiting for the PR author's answer: the last word is someone else's. GitHub's REST comments carry no
 * "resolved" flag, so a thread the user already answered (a review-reply skill answers each) counts as handled.
 * Without the user's login every thread counts.
 */
export function unresolvedThreads(threads: readonly PRCommentThread[], me: string | null | undefined): PRCommentThread[] {
  const login = (me ?? "").trim().toLowerCase();
  if (!login) return [...threads];
  return threads.filter((th) => lastComment(th).author.toLowerCase() !== login);
}

/** The repository's PR command with `{pr}` = the PR number; null when none is set. */
export function respondCommand(template: string | null | undefined, number: number): string | null {
  const trimmed = (template ?? "").trim();
  return trimmed ? trimmed.replaceAll("{pr}", String(number)) : null;
}

/** The composer draft: the PR command first (when set), then file, line, author and the quoted body of every comment. */
export function prCommentsDraft(prNumber: number, prTitle: string, threads: readonly PRCommentThread[], command: string | null): string {
  const lines: string[] = [];
  if (command) lines.push(command, "");
  lines.push(threads.length === 1 ? t("Handle this review comment on PR #{0} ({1}):", prNumber, prTitle) : t("Handle these {0} review comments on PR #{1} ({2}):", threads.length, prNumber, prTitle));
  for (const th of threads) {
    lines.push("");
    const location = typeof th.root.line === "number" ? `${th.root.path}:${th.root.line}` : th.root.path;
    threadComments(th).forEach((c, i) => {
      lines.push(i === 0 ? `- ${location} — @${c.author}:` : `  ↳ @${c.author}:`);
      for (const bodyLine of c.body.trim().split("\n")) lines.push(`  > ${bodyLine}`);
    });
  }
  return lines.join("\n");
}

/** The branch a PR workbench is created on: the head branch, or `pr-<number>` when it cannot be told apart from the base. */
export function prWorkbenchBranch(number: number, headRef: string, baseRef: string): string {
  const head = headRef.trim();
  return !head || head === baseRef ? `pr-${number}` : head;
}

/** `owner/name` of a GitHub-style remote (`git@host:o/r.git`, `https://host/o/r(.git)`, `ssh://git@host/o/r`), lowercased. */
export function repoSlug(remote: string | null | undefined): string | null {
  const r = (remote ?? "").trim();
  if (!r) return null;
  let path: string | null = null;
  const scp = /^[^/@\s]+@[^:/\s]+:(.+)$/.exec(r);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) path = scp[1]!;
  else {
    try {
      const u = new URL(r);
      if (u.host) path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!path) return null;
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : null;
}

/** The PR is of the open project's repository; false when either is unknown. */
export function isProjectRepo(prRepo: string | null | undefined, remote: string | null | undefined): boolean {
  const slug = repoSlug(remote);
  return !!prRepo && !!slug && prRepo.toLowerCase() === slug;
}

/** The hunk around `line` as unified text (`@@ … @@`, then ` ` / `+` / `-` lines), cut at `MAX_PR_HUNK_CHARS`. */
export function prHunkText(diff: FileDiff, line: DiffLine): string {
  const hunk = diff.hunks.find((h) => h.lines.some((l) => l.id === line.id));
  if (!hunk) return line.text;
  let out = "";
  for (const l of hunk.lines) {
    const prefix = l.kind === "hunkHeader" ? "" : l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    const text = l.kind === "hunkHeader" ? l.text || hunk.header : l.text;
    const row = `${prefix}${text}\n`;
    if (out.length + row.length > MAX_PR_HUNK_CHARS) break;
    out += row;
  }
  return out;
}

/** A side-question anchor on a PR diff line: its number on the side it lives on (`LEFT` for a deleted line). */
export function prLineAnchor(number: number, path: string, line: DiffLine, diff: FileDiff, commitId: string | null | undefined): SidePrAnchor | null {
  if (line.kind === "hunkHeader") return null;
  const side = line.kind === "del" ? "LEFT" : "RIGHT";
  const no = line.kind === "del" ? line.oldNo : line.newNo;
  return { number, path, line: no ?? null, side, hunk: prHunkText(diff, line), ...(commitId ? { commitId } : {}) };
}

/**
 * The side question's preview of a PR anchor: its hunk read back (numbered from the `@@` header) around the anchored line,
 * like a review anchor's; null when the hunk has no header (nothing to number from).
 */
export function prHunkPreview(pr: SidePrAnchor, around = 4): { lines: DiffLine[]; focus: number | null } | null {
  const rows = pr.hunk.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rows[0] ?? "");
  if (!head) return null;
  let oldNo = Number(head[1]);
  let newNo = Number(head[2]);
  const body: DiffLine[] = [];
  rows.slice(1).forEach((row, i) => {
    const sign = row[0];
    const text = row.slice(1);
    if (sign === "\\") return; // "\ No newline at end of file"
    if (sign === "+") body.push({ id: i + 1, kind: "add", oldNo: null, newNo: newNo++, text });
    else if (sign === "-") body.push({ id: i + 1, kind: "del", oldNo: oldNo++, newNo: null, text });
    else body.push({ id: i + 1, kind: "context", oldNo: oldNo++, newNo: newNo++, text: sign === " " ? text : row });
  });
  const at = typeof pr.line === "number" ? body.findIndex((l) => (pr.side === "LEFT" ? l.kind !== "add" && l.oldNo === pr.line : l.kind !== "del" && l.newNo === pr.line)) : -1;
  const from = Math.max(0, at - around);
  return { lines: at >= 0 ? body.slice(from, from + 2 * around + 1) : body.slice(0, 2 * around + 1), focus: at >= 0 ? body[at]!.id : null };
}

/** `PR #512 · api/Svc.java:42` (the side question's chip / header). */
export function prAnchorLocation(pr: SidePrAnchor): string {
  const place = typeof pr.line === "number" ? `${pr.path}:${pr.line}` : pr.path;
  return `PR #${pr.number} · ${place}`;
}
