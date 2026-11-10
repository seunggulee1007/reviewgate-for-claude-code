/**
 * The one place error / refusal codes become words (docs/PROTOCOL.md §19.6). Clients localize on `code` and fall
 * back to the engine's `message` / `error` text for a code they do not know. English strings are the i18n keys
 * (ko.extra.json / ko.json hold the Korean).
 */
import { currentLanguage, t } from "./i18n";
import { gateText, requestChangesUnavailableText } from "./gateText"; // MARK: wave4d w4d-windows
import { cliChangeText } from "./sessionTools"; // MARK: wave3 desktop-session
import { longWorkErrorText } from "./longWork"; // MARK: wave4 w4-longwork
import { chatMoveNoticeText } from "./chatMove"; // MARK: wave4b w4b-follow
import { autoModeErrorText, autoModeRefusalText } from "./autoMode"; // MARK: wave4b w4b-auto
import { scopeRowText } from "./scopeNotices"; // MARK: r1-scope
import { gitNoticeText } from "./gitNotices"; // MARK: r1-git
import { reviewFlowNoticeText } from "./rejectSchedule"; // MARK: r2-review-flow (M32)

/** `error` event codes (§19.6 "Claude CLI / API failures" + "Other engine error codes"). */
export const ERROR_EVENT_CODES = [
  "auth_required",
  "usage_limit",
  "rate_limited",
  "api_error",
  "api_retrying",
  "cli_start_slow",
  "session_crashed",
  "cli_not_found",
  "cli_not_executable",
  "session_start_failed",
  "send_failed",
  "plan_followup_failed",
  "extensions_init_timeout",
  "unprompted_blocked",
  "project_open_failed",
  "git_init_failed",
  "collect_failed",
  "refresh_failed",
  "revert_failed",
  "branch_failed",
  "workbench_failed",
  "commit_failed",
  "command_failed",
  "side_failed",
  "mcp_auth_required",
  "mcp_failed",
  // MARK: wave1 desktop-session — §29 / §30 / §32 / §33.4
  "session_id_in_use",
  "resume_not_found",
  "resume_failed",
  "peer_release_failed",
  "lfs_missing",
  "worktree_blocked",
  "worktree_outside_review",
  // MARK: wave3 desktop-session — §36.8 the notice of a CLI that changed since the last session
  "cli_version_changed",
  // MARK: wave4 w4-longwork — §38.2 the tool-call limit and hooks (`cli_warning` / `cli_notice` show the CLI's own words, unlocalized)
  "max_turns",
  "hook_failed",
  "hook_blocked",
  // MARK: wave4b w4b-follow — §39.4 a chat that moved in (info), a followed move that did not happen (warning)
  "chat_moved_in",
  "chat_moved_in_disk",
  "chat_move_failed",
  // MARK: wave4b w4b-auto — §39.5 what auto mode blocked, an auto mode the CLI cannot run
  "auto_mode_denied",
  "auto_mode_unavailable",
  // MARK: r1-git — §46 / §31.3 what Claude's git commands did
  "git_stashed",
  "claude_committed",
  "claude_moved_head",
  "reject_committed",
  // MARK: r2-review-flow — M32 (§34.2) a reject while Claude works
  "reject_scheduled",
  "reject_applied",
  "reject_changed_again",
] as const;

/** `result{ok:false}` refusal codes (§19.6 "Refusal codes"). */
export const REFUSAL_CODES = [
  "auto_mode_unavailable", // MARK: wave4b w4b-auto (§39.5)
  "binary_file",
  "branch_in_use",
  "cannot_remove_current",
  "cannot_remove_main",
  "collect_failed",
  "commit_failed",
  "detached_head",
  "diff_mismatch",
  "empty_base",
  "empty_message",
  "empty_note",
  "empty_title",
  "engine_disposed",
  "file_changed_since_review",
  "gate_closed",
  "git_identity_missing",
  "git_init_not_needed",
  "history_trees_gone",
  "invalid_branch_name",
  "invalid_mode",
  "locked_by_other_session",
  "no_hunks",
  "no_plan",
  "no_project",
  "no_remote",
  "no_review",
  "no_session",
  "not_a_changed_file",
  // §32 (wave1 desktop-review): a reverted batch held a file whose content was never captured
  "not_captured",
  "not_in_history_entry",
  "not_pending",
  "notes_pending",
  "nothing_to_commit",
  "nothing_to_push",
  "nothing_to_retry",
  "partial_reject_unsupported",
  "path_exists",
  "plan_followup_failed",
  "push_failed",
  "request_changes_unavailable",
  "refresh_failed",
  "revert_failed",
  "branch_failed",
  "workbench_failed",
  "reverting",
  "review_pending",
  "session_busy",
  "session_current",
  "session_running",
  "stale_diff",
  "starting",
  "switch_blocked",
  "unknown_command",
  "unknown_history_entry",
  "unknown_hunk",
  "unknown_pr_file",
  // MARK: wave1 desktop-perms — §33.1: the card's request is no longer open (a toast; the card turns "handled")
  "unknown_permission_request",
  "unknown_worktree",
  "unsupported_remote",
  "worktree_dirty",
  "worktree_locked",
  "command_failed",
  // §21 side questions
  "empty_question",
  "question_too_long",
  "unknown_side_thread",
  "side_busy",
  "side_limit",
  "side_no_answer",
  "side_no_anchor",
  "side_draft_failed",
  "invalid_promote",
  "invalid_plan_file", // MARK: wave5 w5-fixes — §43.5: the basis menu's plan_follow
  "send_failed",
  // §35.1: a send / peer_accept whose snapshot A failed for want of git-lfs is refused with it (the banner's words)
  "lfs_missing",
  "cli_not_found",
  "cli_not_executable",
  // MARK: wave2 desktop-flow — §34.10
  "range_unavailable",
  "invalid_since",
  "no_live_turn",
  "not_a_live_file",
  // §22 MCP servers
  "invalid_mcp_name",
  "invalid_mcp_scope",
  "invalid_mcp_config",
  "unknown_mcp_server",
  "mcp_unsupported",
  "mcp_failed",
  "mcp_cli_failed",
  "terminal_failed",
  // §23–27 composer
  "invalid_mention",
  "too_many_mentions",
  "list_files_failed",
  "too_many_attachments",
  "attachment_type",
  "attachment_too_large",
  "attachment_invalid",
  "unknown_attachment",
  "invalid_model",
  "invalid_effort",
  "set_model_failed",
  "invalid_rewind_mode",
  "unknown_turn",
  "rewind_unavailable",
  "focus_too_long",
  // MARK: wave1 desktop-session — §29 peer messages
  "peer_none",
  "peer_inbox_changed",
  "peer_unsupported",
  "peer_release_failed",
  "peer_dismiss_failed",
  "invalid_peer_mode",
  // MARK: wave3 desktop-session — §36.7–36.9
  "extensions_on",
  "cli_session_running",
  // MARK: §49 Run as Task — `workbench_create {task}`
  "invalid_task",
  "task_handoff_failed",
] as const;

/** The detail fields an `error` event may carry (engine `ErrorDetails`). */
export type ErrorInfo = {
  code?: string;
  /** §22: the MCP server of `mcp_auth_required` / `mcp_failed`. */
  server?: string;
  message: string;
  resetAt?: string;
  attempt?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  status?: number | null;
  // MARK: wave1 desktop-session — §30 / §33.4 detail fields
  /** §30: the CLI's own first stderr line (fatal session errors, resume notices). */
  detail?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** §30: the chat a resume notice is about. */
  sessionId?: string;
  /** §33.4: the tool, folder and branch of a worktree notice. */
  toolName?: string;
  path?: string;
  branch?: string;
  /** MARK: r1-scope — §33.4 `worktree_outside_review` of a command: what it changed in `path` (relative to it). */
  files?: string[];
  // MARK: wave3 desktop-session
  /** §36.8: the `cli_version_changed` notice's versions. */
  cli?: { from: string | null; to: string; verified: boolean };
  // MARK: wave4 w4-longwork
  /** §38.2 `max_turns`: the limit the turn hit; `hook_failed`: the hook's name. */
  maxTurns?: number;
  hookName?: string;
};

/** How the window presents an `error` event (ErrorBanner / HUD / plan card). */
export type ErrorPresentation =
  /** `api_retrying`: a transient HUD chip, no banner, no transcript row. */
  | "retrying"
  /** `cli_start_slow`: a non-sticky hint banner. */
  | "startSlow"
  /** `plan_followup_failed`: the plan card comes back with the reason. */
  | "planFailed"
  /** `auth_required`: banner with the `claude /login` instructions. */
  | "auth"
  /** `side_failed` (§21): shown in its side thread, not as a window banner. */
  | "side"
  /** `mcp_auth_required` (§22): banner with a sign-in action for `server`. */
  | "mcpAuth"
  /** `session_crashed` / `cli_not_found` / `cli_not_executable` / `session_start_failed` / `session_id_in_use`: a fatal banner with the way back. */
  | "fatalSession"
  // MARK: wave1 desktop-session — notices (M4): never a red failure, never a paused queue or a "needs you" notification
  /** `resume_not_found` / `resume_failed` (§30): something already handled — an information banner. */
  | "info"
  /** `worktree_blocked` / `worktree_outside_review` (§33.4), `peer_release_failed` (§29), `unprompted_blocked` (§18): a warning. */
  | "warning"
  // MARK: wave3 desktop-session
  /** `cli_version_changed` (§36.8): a transcript row only — the banner comes from `session.cli`, never a second one. */
  | "row"
  | "banner";

export function presentationOf(code: string | undefined): ErrorPresentation {
  switch (code) {
    case "api_retrying":
      return "retrying";
    case "cli_start_slow":
      return "startSlow";
    case "plan_followup_failed":
      return "planFailed";
    case "auth_required":
      return "auth";
    case "side_failed":
      return "side";
    case "mcp_auth_required":
      return "mcpAuth";
    case "session_crashed":
    case "cli_not_found":
    case "cli_not_executable":
    case "session_start_failed":
    case "session_id_in_use":
      return "fatalSession";
    case "resume_not_found":
    case "resume_failed":
    case "chat_moved_in": // MARK: wave4b w4b-follow (§39.4)
    case "chat_moved_in_disk":
      return "info";
    case "worktree_blocked":
    case "peer_release_failed":
    case "unprompted_blocked":
    case "chat_move_failed": // MARK: wave4b w4b-follow (§39.4)
      return "warning";
    // MARK: r1-scope — §33.4: what already ran outside the review is a chat row (with its folder's actions), never a banner
    case "worktree_outside_review":
      return "row";
    // MARK: wave3 desktop-session — §36.8
    case "cli_version_changed":
      return "row";
    // MARK: wave4 w4-longwork — §38.2: the tool-call limit is a warning banner ([이어서 계속]); hooks / the CLI are rows only
    case "max_turns":
      return "warning";
    case "hook_failed":
    case "hook_blocked":
    case "cli_warning":
    case "cli_notice":
      return "row";
    // MARK: wave4b w4b-auto — §39.5: gray rows only
    case "auto_mode_denied":
    case "auto_mode_unavailable":
      return "row";
    // MARK: r1-git — §46: gray rows only
    case "git_stashed":
    case "claude_committed":
    case "claude_moved_head":
    case "reject_committed":
      return "row";
    // MARK: r2-review-flow — M32: gray rows only
    case "reject_scheduled":
    case "reject_applied":
    case "reject_changed_again":
      return "row";
    default:
      return "banner";
  }
}

/** §32 `lfs_missing`: the command that installs git-lfs on this platform (copied from the banner). */
export function lfsInstallCommand(platform: string = defaultPlatform()): string {
  return platform === "darwin" ? "brew install git-lfs && git lfs install" : "git lfs install";
}

function defaultPlatform(): string {
  const g = globalThis as { window?: { rg?: { platform?: string } } };
  return g.window?.rg?.platform ?? "darwin";
}

/**
 * M05b (§39.4): Claude moved its own folder (EnterWorktree / ExitWorktree) and the chat did not follow — the row says where
 * it went and offers the move (the Mac's words, SessionNotices). Null for any other tool.
 */
function followRowText(toolName: string | undefined, path: string | undefined): string | null {
  if (toolName === "EnterWorktree") {
    return path
      ? t("Claude went into a worktree: {0}. Its work there is outside this window's review — move this chat there to review it there.", path)
      : t("Claude went into a worktree. Its work there is outside this window's review.");
  }
  if (toolName === "ExitWorktree" && path) {
    return t("Claude went back to the folder it came from: {0}. What it does next is outside this window's review — move this chat there to review it there.", path);
  }
  return null;
}

/** §33.4 `worktree_blocked` in words — the tool Claude reached for decides the sentence. */
function worktreeBlockedText(toolName: string | undefined, branch: string | undefined): string {
  if (toolName === "EnterWorktree") {
    return branch
      ? t("Claude tried to work in a separate worktree ('{0}'), so it was blocked — this window's review would not see that work.", branch)
      : t("Claude tried to work in a separate worktree, so it was blocked — this window's review would not see that work.");
  }
  if (toolName === "Workflow") return t("The Workflow tool runs its agents outside this window, so it was blocked.");
  if (toolName === "Agent" || toolName === "Task") return t("A subagent in isolation (worktree) mode was blocked.");
  return t("Claude tried to work outside this folder (another worktree), so it was blocked — this window's review would not see that work.");
}

/** A reset time in the user's local time: "오후 2:30" today, "10월 21일 오후 2:30" another day. */
export function resetTimeText(iso: string, opts: { now?: Date; timeZone?: string } = {}): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const locale = currentLanguage() === "ko" ? "ko" : "en";
  const tz = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { ...tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const sameDay = day(d) === day(opts.now ?? new Date());
  const fmt = new Intl.DateTimeFormat(locale, sameDay ? { ...tz, hour: "numeric", minute: "2-digit" } : { ...tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return fmt.format(d);
}

/** "재시도 중 (2/10)…" — the HUD chip of `api_retrying`. */
export function retryChipText(attempt: number | undefined, maxRetries: number | undefined): string {
  if (attempt !== undefined && maxRetries !== undefined) return t("Retrying ({0}/{1})…", attempt, maxRetries);
  if (attempt !== undefined) return t("Retrying ({0})…", attempt);
  return t("Retrying…");
}

const httpSuffix = (status: number | null | undefined) => (typeof status === "number" ? ` (HTTP ${status})` : "");

/** An `error` event in words: a known `code` localized, an unknown one (or none) → the engine's `message`. */
export function errorEventText(ev: ErrorInfo, opts: { now?: Date; timeZone?: string; platform?: string } = {}): string {
  const longWork = longWorkErrorText(ev); // MARK: wave4 w4-longwork (§38.2)
  if (longWork !== null) return longWork;
  const auto = autoModeErrorText(ev); // MARK: wave4b w4b-auto (§39.5)
  if (auto !== null) return auto;
  const git = gitNoticeText(ev); // MARK: r1-git (§46)
  if (git !== null) return git;
  const flow = reviewFlowNoticeText(ev); // MARK: r2-review-flow (M32)
  if (flow !== null) return flow;
  const withDetail = (summary: string) => (ev.message ? `${summary}: ${ev.message}` : summary);
  switch (ev.code) {
    case "auth_required":
      return t("Claude login required");
    case "usage_limit": {
      const at = ev.resetAt ? resetTimeText(ev.resetAt, opts) : null;
      return at ? t("Claude usage limit reached — it resets at {0}.", at) : t("Claude usage limit reached — try again once it resets.");
    }
    case "rate_limited": {
      const at = ev.resetAt ? resetTimeText(ev.resetAt, opts) : null;
      return at ? t("Claude API rate limit hit — try again after {0}.", at) : t("Claude API rate limit hit — wait a moment, then send again.");
    }
    case "api_error":
      return t("Claude API error{0} — try again in a moment. If it keeps happening, check status.anthropic.com.", httpSuffix(ev.status));
    case "api_retrying":
      return retryChipText(ev.attempt, ev.maxRetries);
    case "cli_start_slow":
      return t("Claude Code is slow to start. A VPN / proxy, the plugin marketplace or MCP servers may be holding it up — still waiting.");
    case "session_crashed":
      return t("The Claude session ended unexpectedly.");
    case "cli_not_found":
      return t("Claude Code (claude) was not found. Install it, or choose the program in Settings.");
    case "cli_not_executable":
      return t("The claude program could not be found — choose claude.exe in Settings.");
    case "session_start_failed":
      // §30: the CLI's own words go on the banner's second line (`detail`), not into the sentence.
      return t("Claude Code exited right after it started.");
    case "send_failed":
      return withDetail(t("The message could not be sent to Claude"));
    case "plan_followup_failed":
      return t("The plan answer could not be sent to Claude — the plan is still waiting. Answer it again to retry.");
    case "extensions_init_timeout":
      return t("Extensions took too long to load, so the session started without them.");
    case "unprompted_blocked":
      return withDetail(t("A turn Claude Code started on its own was blocked"));
    case "project_open_failed":
      return withDetail(t("The project could not be opened"));
    case "git_init_failed":
      return withDetail(t("The git repository could not be initialized"));
    case "collect_failed":
      return withDetail(t("The changes could not be collected"));
    case "refresh_failed":
      return withDetail(t("Refresh failed"));
    case "revert_failed":
      return withDetail(t("The files could not be reverted"));
    case "branch_failed":
      return withDetail(t("The branch operation failed"));
    case "workbench_failed":
      return withDetail(t("The workbench operation failed"));
    case "commit_failed":
      return withDetail(t("The commit failed"));
    case "command_failed":
      return withDetail(t("The command failed"));
    case "side_failed":
      return withDetail(t("The side question failed"));
    case "mcp_auth_required":
      return ev.server ? t("MCP server {0} needs you to sign in.", ev.server) : t("An MCP server needs you to sign in.");
    case "mcp_failed":
      return ev.server ? t("MCP server {0} failed: {1}", ev.server, ev.message) : withDetail(t("The MCP server failed"));
    // MARK: wave1 desktop-session — §29 / §30 / §32 / §33.4
    case "session_id_in_use":
      return t("This chat could not be continued. Start a new chat.");
    case "resume_not_found":
      return t("Claude Code has no record of this chat any more (cleaned up after 30 days, or deleted), so a new chat was started. The previous chat stays readable in the list.");
    case "resume_failed":
      return t("Claude Code could not load this chat's record, so a new chat was started. The previous chat stays readable in the list.");
    case "peer_release_failed":
      return t("The other session's message could not be handed to Claude. Try again, or decline it.");
    case "lfs_missing":
      return lfsMissingText(opts.platform ?? defaultPlatform());
    case "worktree_blocked":
      return worktreeBlockedText(ev.toolName, ev.branch);
    case "worktree_outside_review":
      return scopeRowText(ev) ?? followRowText(ev.toolName, ev.path) ?? (ev.path ? t("Claude worked where this window's review does not see it: {0}", ev.path) : t("Claude worked where this window's review does not see it."));
    // MARK: wave3 desktop-session — §36.8
    case "cli_version_changed":
      return cliChangeText(ev);
    // MARK: wave4b w4b-follow — §39.4
    case "chat_moved_in":
    case "chat_moved_in_disk":
    case "chat_move_failed":
      return chatMoveNoticeText(ev.code, ev.path, ev.detail) ?? ev.message;
    default:
      return ev.message;
  }
}

/** §32 `lfs_missing` (an error event, or §35.1 a refused send): what is missing and the command that installs it here. */
function lfsMissingText(platform: string): string {
  return platform === "darwin"
    ? t("This repository uses Git LFS, but git-lfs is missing. Run {0} in a terminal, then try again.", lfsInstallCommand("darwin"))
    : t("This repository uses Git LFS, but git-lfs is missing. Install it (git-lfs.com), run {0} in a terminal, then try again.", lfsInstallCommand("win32"));
}

/** A refusal (`result{ok:false}`) in words, or null for a code this client does not know. */
export function refusalCodeText(code: string, detail: string, paths?: string[]): string | null {
  const d = detail.trim();
  switch (code) {
    case "auto_mode_unavailable": // MARK: wave4b w4b-auto (§39.5)
      return autoModeRefusalText();
    case "binary_file":
      return t("This is a binary file.");
    case "branch_in_use":
      return t("That branch is already checked out in {0}", d);
    case "cannot_remove_current":
      return t("This window's own workbench cannot be removed from here.");
    case "cannot_remove_main":
      return t("The main workbench cannot be removed.");
    case "collect_failed":
      return t("Retry collecting the changes first");
    case "commit_failed":
      return d ? t("The commit failed: {0}", d) : t("The commit failed");
    case "detached_head":
      return t("Check out a branch first (HEAD is detached).");
    case "diff_mismatch":
    case "unknown_hunk":
      return t("The diff no longer matches the file. Refresh (⌘R) and try again.");
    case "empty_base":
      return t("Choose a base branch.");
    case "empty_message":
      return t("Enter a commit message.");
    case "empty_note":
      return t("Write the note first.");
    case "empty_title":
      return t("Enter a title.");
    case "engine_disposed":
      return t("The engine has shut down — reopen the project.");
    case "file_changed_since_review": {
      const list = paths && paths.length > 0 ? paths.join(", ") : d;
      return t("Edited by you after the review: {0}. Reverting would discard those edits.", list);
    }
    case "gate_closed":
      // §29: another session's turn is running — the message waits in the queue (composer hint, no banner).
      if (d === "external_turn") return t("It goes out once the other work is done.");
      return gateText(d); // MARK: wave4d w4d-windows (polish-07): the Mac's words, never the raw state
    case "git_identity_missing":
      return t("Git identity is not configured (user.name / user.email).{0}", d ? ` ${d}` : "");
    case "git_init_not_needed":
      return t("This folder is already a git repository.");
    case "history_trees_gone":
      return t("The snapshots of this round were cleaned up; its diff can no longer be shown.");
    case "invalid_branch_name":
      return t("Not a valid branch name: {0}", d);
    case "invalid_mode":
      return t("Not a permission mode: {0}", d);
    // MARK: §49 Run as Task — nothing is created for an empty / too long task; a failed handoff leaves the worktree
    case "invalid_task":
      return t("Describe the task first (at most 100,000 characters).");
    case "task_handoff_failed":
      return t("The workbench was created, but the task could not be handed to it: {0}", d);
    case "locked_by_other_session":
      return t("Another ReviewGate session (pid {0}) has this project open.", d);
    case "no_hunks":
      return t("Select at least one part to revert.");
    case "no_plan":
      return t("There is no plan waiting for an answer.");
    case "no_project":
      return t("Open a project first (⌘O)");
    case "no_remote":
      return t("The repository has no remote to push to.");
    case "no_review":
      return t("There is no review in progress.");
    case "no_session":
      return t("Session ended — Restart to continue");
    case "not_a_changed_file":
      return t("{0} is not part of the current review.", d);
    case "not_captured":
      return t("Content that was not captured cannot be reverted: {0} — fix it by hand or accept it", paths && paths.length > 0 ? paths.join(", ") : d);
    case "not_in_history_entry":
      return t("{0} is not part of this review round.", d);
    case "not_pending":
      return t("Only files still pending review can be changed.");
    case "notes_pending":
      return t("Send or delete your review notes first");
    case "nothing_to_commit":
      return t("No accepted files to commit.");
    case "nothing_to_push":
      return t("Nothing to push yet.");
    case "nothing_to_retry":
      return t("There is nothing to retry.");
    case "partial_reject_unsupported":
      if (d === "uncaptured") return t("This file's content was not captured, so no part of it can be reverted either");
      return t("This file cannot be reverted in parts — reject the whole file instead.");
    case "path_exists":
      return t("The folder already exists: {0}", d);
    case "plan_followup_failed":
      return d ? t("The plan answer could not be sent to Claude ({0}) — the plan is still waiting. Answer it again to retry.", d) : t("The plan answer could not be sent to Claude — the plan is still waiting. Answer it again to retry.");
    case "push_failed":
      return t("The commit was created but the push failed: {0}", d);
    case "request_changes_unavailable":
      return requestChangesUnavailableText(d); // MARK: wave4d w4d-windows (polish-07)
    case "refresh_failed":
      return d ? t("Refresh failed: {0}", d) : t("Refresh failed");
    case "revert_failed":
      return d ? t("The files could not be reverted: {0}", d) : t("The files could not be reverted");
    case "branch_failed":
      return d ? t("The branch operation failed: {0}", d) : t("The branch operation failed");
    case "workbench_failed":
      return d ? t("The workbench operation failed: {0}", d) : t("The workbench operation failed");
    case "reverting":
      return t("Reverting…");
    case "review_pending":
      return t("Review pending files first");
    case "session_busy":
    case "session_running":
      return t("Claude is working…");
    case "session_current":
      return t("The current chat cannot be deleted.");
    case "stale_diff":
      return t("The diff changed in the meantime. Refresh (⌘R) and try again.");
    case "starting":
      return t("The session is still starting…");
    case "switch_blocked":
      return d ? t("Switching is not possible right now: {0}", d) : t("Switching is not possible right now.");
    case "unknown_command":
      return t("This engine does not support the command — update ReviewGate.");
    case "unknown_history_entry":
      return t("This review round is no longer in the history.");
    case "unknown_pr_file":
      return t("That file is not part of the pull request.");
    case "unknown_permission_request":
      return t("This permission request was already handled");
    case "unknown_session":
      return t("No such chat: {0}", d);
    case "unknown_worktree":
      return t("No such workbench: {0}", d);
    case "unsupported_remote":
      return t("The origin remote is not a GitHub URL: {0}", d);
    case "worktree_dirty":
      return t("The workbench has uncommitted changes.");
    case "worktree_locked":
      return t("The workbench is in use by another session (pid {0}).", d);
    case "command_failed":
      return d ? t("The command failed: {0}", d) : t("The command failed");
    case "empty_question":
      return t("Type a question first.");
    case "question_too_long":
      return t("The question is too long (at most 20,000 characters).");
    case "unknown_side_thread":
      return t("This side thread no longer exists.");
    case "side_busy":
      return t("This side thread is still answering — wait for it or cancel it.");
    case "side_limit":
      return t("Three side questions are already running — wait for one to finish.");
    case "side_no_answer":
      return t("There is no answer to summarize yet.");
    case "side_no_anchor":
      return t("This thread is not about a file, so it cannot become a review note — send it as a message instead.");
    case "side_draft_failed":
      return d ? t("The summary could not be written: {0}", d) : t("The summary could not be written.");
    case "invalid_promote":
      return t("Choose message or review note.");
    case "invalid_plan_file": // MARK: wave5 w5-fixes — §43.5
      return t("That plan file cannot be read any more — choose another one");
    case "send_failed":
      return d ? t("The message could not be sent to Claude: {0}", d) : t("The message could not be sent to Claude");
    case "lfs_missing":
      return lfsMissingText(defaultPlatform());
    case "cli_not_found":
      return t("Claude Code (claude) was not found. Install it, or choose the program in Settings.");
    case "cli_not_executable":
      return t("The claude program could not be found — choose claude.exe in Settings.");
    case "invalid_mcp_name":
      return t("Not a valid server name: letters, digits, _ . - only (start with a letter or digit, at most 64).");
    case "invalid_mcp_scope":
      return t("Choose where to add the server: this session, project or user.");
    case "invalid_mcp_config":
      return d ? t("The server settings are not valid: {0}", d) : t("The server settings are not valid.");
    case "unknown_mcp_server":
      return t("No such MCP server: {0}", d);
    case "mcp_unsupported":
      return t("This session cannot manage MCP servers — update Claude Code.");
    case "mcp_failed":
      return d ? t("The MCP server operation failed: {0}", d) : t("The MCP server operation failed.");
    case "mcp_cli_failed":
      return d ? t("claude mcp failed: {0}", d) : t("claude mcp failed.");
    case "terminal_failed":
      return d ? t("No terminal could be opened: {0}", d) : t("No terminal could be opened.");
    case "invalid_mention":
      return d ? t("This file cannot be mentioned: {0}", d) : t("This file cannot be mentioned.");
    case "too_many_mentions":
      return t("Mention at most 20 files or folders.");
    case "list_files_failed":
      return d ? t("The project's files could not be listed: {0}", d) : t("The project's files could not be listed.");
    case "too_many_attachments":
      return t("Attach at most 5 images.");
    case "attachment_type":
      return d ? t("Only PNG, JPEG, GIF and WebP images can be attached ({0}).", d) : t("Only PNG, JPEG, GIF and WebP images can be attached.");
    case "attachment_too_large":
      return d ? t("Images must be 5 MB or smaller ({0}).", d) : t("Images must be 5 MB or smaller.");
    case "attachment_invalid":
      return d ? t("The image could not be read ({0}).", d) : t("The image could not be read.");
    case "unknown_attachment":
      return t("The image is no longer stored.");
    case "invalid_model":
      return d ? t("Not a model Claude Code knows: {0}", d) : t("Not a model Claude Code knows.");
    case "invalid_effort":
      return d ? t("Not an effort level: {0}", d) : t("Not an effort level.");
    case "set_model_failed":
      return d ? t("The model could not be changed: {0}", d) : t("The model could not be changed.");
    case "invalid_rewind_mode":
      return t("Choose what to rewind: the conversation, the files or both.");
    case "unknown_turn":
      return t("This message can no longer be rewound to.");
    case "rewind_unavailable":
      return d === "files"
        ? t("Claude's file changes from this point on can no longer be put back.")
        : d === "conversation"
          ? t("The conversation can no longer be rewound to this point.")
          : t("This point can no longer be rewound to.");
    case "focus_too_long":
      return t("The focus is too long (at most 2,000 characters).");
    // MARK: wave1 desktop-session — §29 peer messages
    case "peer_none":
      return t("No message from another session is waiting.");
    case "peer_inbox_changed":
      return t("New messages arrived and the list changed. Check it again.");
    case "peer_unsupported":
      return t("This Claude Code cannot hold messages from other sessions — update Claude Code.");
    case "peer_release_failed":
      return d ? t("The message could not be handed to Claude ({0}). It is still waiting — try again or decline it.", d) : t("The message could not be handed to Claude. It is still waiting — try again or decline it.");
    case "peer_dismiss_failed":
      return d ? t("The message could not be declined ({0}). Try again.", d) : t("The message could not be declined. Try again.");
    case "invalid_peer_mode":
      return t("Not a setting for messages from other sessions.");
    // MARK: wave3 desktop-session — §36.7–36.9
    case "extensions_on":
      return t("Extensions are already on — there is nothing to retry.");
    case "cli_session_running":
      return t("That conversation is still running in a terminal — end it there first (two processes on one conversation would corrupt it).");
    // MARK: wave2 desktop-flow — §34.10 diff ranges and live changes
    case "range_unavailable":
      return t("This range is not available for the file ({0}) — the whole review is shown", rangeWords(d));
    case "invalid_since":
      return t("Unknown diff range: {0}", d);
    case "no_live_turn":
      return t("No turn is running — its changes so far are in the review now");
    case "not_a_live_file":
      return t("{0} is not among this turn's changes so far", d);
    default:
      return null;
  }
}

/** wave2 desktop-flow — a §34.1 `since` in the selector's words (unknown values as sent). */
function rangeWords(since: string): string {
  switch (since) {
    case "review":
      return t("Whole review");
    case "turn":
      return t("This turn");
    case "request":
      return t("Since request");
    case "accepted":
      return t("Since accepted");
    default:
      return since;
  }
}

/** A refusal in words from its parts — unknown code → the engine's `error` text unchanged. */
export function refusalMessage(r: { code: string; error: string; detail: string; paths?: string[] }): string {
  // `command_failed`'s text is the underlying error itself (no `command_failed:` prefix).
  const detail = r.code === "command_failed" && !r.error.startsWith("command_failed") ? r.error : r.detail;
  return refusalCodeText(r.code, detail, r.paths) ?? r.error;
}
