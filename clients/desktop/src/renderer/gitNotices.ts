/**
 * MARK: r1-git
 * docs/PROTOCOL.md §46 / §31.3 in Electron (as on the Mac, GitNotices.swift) — pure, unit-tested: git runs as in the
 * terminal; what Claude's own git commands did is told after the fact. A file Claude committed keeps its place in the review
 * with a "커밋됨 <sha>" badge, a HEAD move Claude made is a gray chat row instead of the head-moved banner, a stash that took
 * files out of the working tree names them, and a red git card says why it allows one call at a time.
 */
import type { PermissionRequest } from "@reviewgate/engine";
import { t } from "./i18n";

/** The §46 notice codes: chat rows only (gray, no banner, never a stopped queue). */
export const GIT_ROW_CODES: ReadonlySet<string> = new Set(["git_stashed", "claude_committed", "claude_moved_head", "reject_committed"]);

export function isGitRow(code: string | undefined): boolean {
  return code !== undefined && GIT_ROW_CODES.has(code);
}

/** The row text of a §46 code (the same keys as the Mac's); null for any other code (errorCodes.ts falls back to its own). */
export function gitNoticeText(ev: { code?: string; detail?: string }): string | null {
  const what = (ev.detail ?? "").trim();
  switch (ev.code) {
    case "git_stashed":
      return t("Stashed and out of the review: {0} (git stash pop brings them back)", what);
    case "claude_committed":
      return t("Claude committed {0} — its files stay in the review", what);
    case "claude_moved_head":
      return t("Claude's git command moved HEAD ({0}) — the review shows only Claude's changes", what);
    case "reject_committed":
      return t("Reverted on disk — Claude's commit still holds the change: {0} (git reset --soft or git revert undoes it)", what);
    default:
      return null;
  }
}

/** The changed-file badge: "커밋됨 abc1234". */
export function committedBadge(sha: string): string {
  return t("Committed {0}", sha);
}

/** The badge's tooltip: the file stays in the review; a reject reverts the working tree, the commit stays. */
export function committedHelp(sha: string): string {
  return t("Claude committed this change in {0}; the file stays in the review. Rejecting it reverts the working tree — the commit stays (git reset --soft undoes it).", sha);
}

/**
 * Why a card with a reason allows one call at a time (the Allow once button's tooltip; the session allow and its shortcut do
 * nothing there): a destructive git command, or a call outside what the review sees. Null for a card that can be remembered.
 */
export function onceOnlyHelp(request: Pick<PermissionRequest, "toolName" | "reason">): string | null {
  if (!request.reason || request.toolName === "SendMessage") return null;
  return request.reason.code === "git_command"
    ? t("Allowed one call at a time — this git command can throw away work the review cannot bring back, so it is never remembered (⌘↩)")
    : t("Allowed one call at a time — this call works where the review cannot follow, so it is never remembered (⌘↩)");
}
