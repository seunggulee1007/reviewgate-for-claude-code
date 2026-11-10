/**
 * PR wire models (port of Core `PR/PRModels.swift`, `PR/GHAuth.swift` `GHAccount`, `PR/PRStore.swift` `SubmitResult`).
 * Dates are ISO-8601 strings exactly as GitHub emitted them (`YYYY-MM-DDTHH:MM:SSZ`), so the Swift
 * client's `.iso8601` decoder (no fractional seconds) accepts them unchanged.
 */

/** One row of the PR list (from `search/issues`). */
export type PRSummary = {
  number: number;
  title: string;
  /** `owner/name` */
  repo: string;
  host: string;
  author: string;
  updatedAt: string;
  url: string;
  isDraft: boolean;
};

/** `host/owner/repo#N` — the id the app uses to address a summary. */
export function summaryId(s: Pick<PRSummary, "host" | "repo" | "number">): string {
  return `${s.host}/${s.repo}#${s.number}`;
}

/** `gh pr view --json …` */
export type PRDetail = {
  number: number;
  title: string;
  body: string;
  author: string;
  /** OPEN / CLOSED / MERGED */
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / "" (none) */
  reviewDecision: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

/** One entry of `repos/O/R/pulls/N/files`. */
export type PRFile = {
  filename: string;
  previousFilename: string | null;
  /** added / removed / modified / renamed / copied / changed / unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Headerless unified patch; null for binary or very large files. */
  patch: string | null;
};

/** `PRFile` without its patch — what goes on the wire in `state.pr.files`. */
export type PRFileMeta = Omit<PRFile, "patch">;

/** A review (inline) comment from `repos/O/R/pulls/N/comments`. */
export type PRComment = {
  id: number;
  path: string;
  /** null when the comment is outdated (its line no longer exists in the current diff). */
  line: number | null;
  /** LEFT / RIGHT */
  side: string | null;
  startLine: number | null;
  body: string;
  author: string;
  createdAt: string;
  inReplyTo: number | null;
  diffHunk: string;
};

/** One entry of `repos/O/R/pulls/N/reviews`. */
export type PRReview = {
  id: number;
  author: string;
  /** APPROVED / CHANGES_REQUESTED / COMMENTED / PENDING / DISMISSED */
  state: string;
  body: string;
  /** null for PENDING reviews. */
  submittedAt: string | null;
  /** `html_url` of the review (null when the API omitted it). */
  url: string | null;
};

/** A not-yet-submitted inline comment, collected by the client and sent with `submitReview`. */
export type DraftComment = {
  id: string;
  path: string;
  line: number;
  /** LEFT / RIGHT */
  side: string;
  startLine: number | null;
  body: string;
};

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** One `gh` host as reported by `gh auth status`. */
export type GHAccount = {
  host: string;
  login: string | null;
  ok: boolean;
  /** Human-readable status for that host (login/scopes on success, the error otherwise). */
  detail: string;
};

/** Outcome of a successful `PRStore.submit()`; the UI shows it as a banner. */
export type SubmitResult = {
  reviewURL: string;
  inlineCount: number;
  event: ReviewEvent;
  /** ISO-8601 */
  submittedAt: string;
};
