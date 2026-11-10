/**
 * MARK: r2-review-flow — M32 (docs/PROTOCOL.md §34.2): a reject while Claude works waits for the turn's end (`rejectScheduled`) and says so in
 * gray rows; a file the turn changed again is asked about in its row (the Mac's Core ReviewFlow+Reject.swift).
 */
import type { ChangedFileState } from "@reviewgate/engine";
import { t } from "./i18n";

// ---------------------------------------------------------------- M32 rows and the scheduled state

/** The rows about a reject during a turn: gray chat rows only (no banner, the queue goes on). */
export const REVIEW_FLOW_ROW_CODES: ReadonlySet<string> = new Set(["reject_scheduled", "reject_applied", "reject_changed_again"]);

export function isReviewFlowRow(code: string | undefined): boolean {
  return code !== undefined && REVIEW_FLOW_ROW_CODES.has(code);
}

/** The row text of an M32 code (the same keys as the Mac's); null for any other code. */
export function reviewFlowNoticeText(ev: { code?: string; detail?: string }): string | null {
  const what = (ev.detail ?? "").trim();
  switch (ev.code) {
    case "reject_scheduled":
      return t("Rejected while Claude works: {0} — reverted when the turn ends; Claude was told not to build on it", what);
    case "reject_applied":
      return t("Reverted as you asked while Claude worked: {0}", what);
    case "reject_changed_again":
      return t("Claude changed this again after you rejected it, so it was not reverted: {0}", what);
    default:
      return null;
  }
}

/** The file a `reject_changed_again` row asks about (its `detail`); null for any other row. */
export function rejectAskedPath(code: string | undefined, detail: string | undefined): string | null {
  const path = (detail ?? "").trim();
  return code === "reject_changed_again" && path.length > 0 ? path : null;
}

/** The row's [되돌리기] while that file is still pending (another turn or a decision may have settled it). */
export function asksStill(path: string, files: readonly Pick<ChangedFileState, "path" | "state" | "rejectScheduled">[]): boolean {
  return files.some((f) => f.path === path && f.state === "pending" && f.rejectScheduled !== true);
}

export const scheduledBadge = (): string => t("Reject scheduled");
export const scheduledHelp = (): string => t("Reverted when Claude's turn ends — Claude was told not to build on it. Accept the file to keep it.");
