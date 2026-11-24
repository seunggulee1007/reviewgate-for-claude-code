/**
 * Renderer → engine command validation (docs/AUDIT-2026-09-14.md §2.1): only commands a client may
 * issue pass through `rg:cmd` / `rg:request`. `hello` is sent by main itself and `set_settings` is
 * derived from `rg:setSettings` — a renderer forging either (e.g. `claudePath`) is refused.
 */
import type { EngineCommand, EngineCommandType, EngineEvent } from "@reviewgate/engine";

const CLIENT_COMMANDS: ReadonlySet<EngineCommandType> = new Set<EngineCommandType>([
  "open_project",
  "switch_project",
  "close_project",
  "init_repo",
  // §59: review a folder that is no repository through a hidden one outside it
  "track_without_git",
  "cancel_git_init",
  "restart_session",
  "send",
  // §50: a message into the running turn (↩ while Claude works); §50.3: taking it back before Claude reads it
  "steer",
  "steer_take_back",
  // §56.1: /btw — a side question answered apart (own lane)
  "btw_ask",
  "request_changes",
  "interrupt",
  "permission_response",
  "forget_allows",
  // MARK: wave1 desktop-perms — §33.8: the user's Claude Code allow rules (query lane, read-only)
  "permission_rules",
  "set_permission_mode",
  "plan_response",
  // MARK: wave4d w4d-plan — §42.1: the plan file this chat's "plan vs actual" follows
  "plan_follow",
  "accept",
  "accept_all",
  "unaccept", // the Undo of "Accept all"'s toast
  "review_first_allow_turn", // §64 [이번 턴만 허용]
  // §34.6 the running turn's changes so far (reads: the "진행 중 변경" section and its read-only diff)
  "live_changes",
  "live_diff",
  "reject",
  "reject_all",
  // §31.5 (wave1 desktop-review): empty the review list without touching files / dismiss the stale flag
  "finish_review",
  "keep_review",
  "retry_collect",
  "add_note",
  "remove_note",
  "reject_hunks",
  "review_history",
  "history_diff",
  "select_file",
  "full_file",
  "tool_output",
  "branches",
  "switch_branch",
  "create_branch",
  "pr_list",
  "pr_open",
  "pr_close",
  "pr_select_file",
  "pr_add_draft",
  "pr_remove_draft",
  "pr_submit",
  "pr_reply",
  "pr_reload_comments",
  "pr_comment", // §60: a general comment on the PR's conversation
  "task_fetch", // MARK: task-start — §63.1: one GitHub issue for "Start from a task" (gh, the PR lane)
  "accounts",
  "login_in_terminal",
  "workbench_list",
  "workbench_create",
  "workbench_remove",
  "workbench_prune",
  "pr_create",
  "commit",
  "push",
  // MARK: wave3 desktop-flow — §36.11 commit draft, §36.12 workbench preview, §36.13 AI pre-review (read-only forks / reads)
  "commit_draft",
  // §53 commits in meaningful units: the accepted hunks (a read), Claude's proposed split (read-only fork), the commits in order
  "commit_hunks",
  "commit_split_draft",
  "commit_series",
  // MARK: git-sync — §68 fetch (its own lane) and a safe pull of the current branch
  "git_fetch",
  "git_pull",
  "workbench_preview",
  "prereview_start",
  "prereview_cancel",
  "prereview_dismiss",
  "shutdown",
  "refresh",
  "session_list",
  "session_new",
  "session_open",
  "session_rename",
  "session_archive",
  "session_delete",
  "tabs_set",
  // §21 side questions
  "side_ask",
  "side_list",
  "side_cancel",
  "side_close",
  "side_promote_draft",
  "side_promote",
  // §22 MCP servers
  "mcp_status",
  "mcp_reconnect",
  "mcp_toggle",
  "mcp_add",
  "mcp_remove",
  "mcp_auth",
  // §23–28 composer: @-mentions, image attachments, model / effort, rewind, compact
  "list_files",
  "attachment_get",
  "set_model",
  "rewind",
  "compact",
  // MARK: wave1 desktop-session — §29 messages from the user's other Claude sessions
  "peer_accept",
  "peer_dismiss",
  "peer_set",
  // MARK: wave3 desktop-agents — §36.1 a subagent's whole report (a read), §36.2 stop one subagent
  "agent_report",
  "stop_agent",
  // MARK: wave3 desktop-session — §36.7 extensions start, §36.8 CLI versions, §36.9 other Claude sessions
  "retry_extensions",
  "cli_versions",
  "cli_sessions",
  "cli_session_import",
  // MARK: wave4 w4-history — §38.3 older rows of a chat, search over every chat's messages (reads)
  "transcript_page",
  "transcript_search",
  // MARK: wave4b w4b-bigturn — §39.1 save again after a failure, old review history (counts first; removes with apply)
  "retry_save",
  "history_cleanup",
  // MARK: wave4b w4b-follow — §39.4 hand this chat to another worktree of the repository / take the chat handed here
  "chat_move",
  "chat_receive",
  // MARK: wave4c w4c-trust — §41.2 the repository's auto-accept rules, back to pending, undo the last reject
  "set_auto_accept",
  "auto_accept_undo",
  "reject_undo",
  // MARK: wave4c w4c-commit — §41.1 the team's commit format (a read), the PR sheet's draft
  "commit_format",
  "pr_draft",
  // §51 the PR sheet's "Fill with Claude": a read-only fork writes the title / description (nothing is pushed or created)
  "pr_ai_draft",
  // MARK: wave4c w4c-review — §41.3 reads: a past / PR diff's new side ("20줄 더 보기"), an image's two sides
  "history_file_lines",
  "pr_file_lines",
  "file_image",
  // MARK: wave4d w4d-config — §42.3 the project's CLAUDE.md: read, and saved over what was read (the user's own edit)
  "claude_md_read",
  "claude_md_write",
  // MARK: wave5 w5-brain — §43.2 the sub-brain (auto memory): read and watched while the board shows it, one memory's text (reads)
  "brain",
  "brain_read",
  // MARK: wave5 w5-graph — §43.3 the board's code graph (a read) and `graphify update .` (the user's click; one at a time)
  "code_graph",
  "code_graph_build",
  // MARK: wave6 w6-statusline — §44.2 the user's status line: the chat's width and whether it is on screen (a read; the
  // engine runs the user's own statusLine command, the one the terminal runs)
  "status_line",
  // §52 background work: stop a task, Ctrl+B / [백그라운드로], a task's last 64 KB of output
  "task_stop",
  "task_background",
  "task_output",
  // MARK: terminal-win — §57.17: Review now, Continue as Terminal Chat. terminal_spec / terminal_started / terminal_exited
  // stay out: main asks for the spec and reports the PTY itself (the hook token never reaches the renderer).
  "terminal_end_turn",
  "session_continue_terminal",
  // §62 go to definition / find references (read-only searches, own lane); a definition outside the review opens through
  // §47's project_file (a read of one worktree file)
  "find_definition",
  "find_references",
  "project_file",
  // §62: "Find in Project" from the "no definition found" notice (§47's search: read-only, lane "search")
  "project_search",
  // MARK: ide-nav — §65 the symbol index (read-only, lane "nav"): ⌘⇧O / ⌘T, the peek / hover preview, a rebuild
  "document_symbols",
  "workspace_symbols",
  "definition_preview",
  "nav_index_build",
]);

export type Validated = { ok: true; cmd: EngineCommand } | { ok: false; error: string };

/** A plain object whose `type` is in the client allowlist; anything else is refused with a reason. */
export function validateCommand(raw: unknown): Validated {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return { ok: false, error: "rejected command: not a plain object" };
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return { ok: false, error: "rejected command: missing type" };
  if (!CLIENT_COMMANDS.has(type as EngineCommandType)) return { ok: false, error: `rejected command: ${type}` };
  return { ok: true, cmd: raw as EngineCommand };
}

/**
 * §57.17: whether an engine event may go to the renderer (`rg:evt`). Never a `terminal_spec`: its env carries the hook
 * token and its argv the hook URL — main asks for it and spawns the PTY itself.
 */
export function forwardsToRenderer(ev: EngineEvent): boolean {
  return ev.type !== "terminal_spec";
}

/** `^https?://` only — `file:`, `smb:`, custom URL handlers etc. never reach the shell (§2.2). */
export function isSafeExternalURL(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// MARK: polish p-foundation — P4-composer-40
/** The most a copied image may be (its data URL's length): the attachments' 5 MiB limit, base64-encoded, with room. */
export const MAX_IMAGE_DATA_URL = 8_000_000;

/** An image the renderer shows (`data:image/png|jpeg|gif|webp;base64,…`, at most `MAX_IMAGE_DATA_URL` long) — what `rg:copyImage` takes. */
export function isImageDataURL(url: unknown): url is string {
  return typeof url === "string" && url.length <= MAX_IMAGE_DATA_URL && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url);
}

export type AppOrigin = { fileURL: string; devURL?: string };

/** True when `url` is the app's own page: the renderer html file (any hash / query) or the dev server's origin. */
export function isAppURL(url: string, origin: AppOrigin): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (origin.devURL) {
    try {
      if (u.origin === new URL(origin.devURL).origin && (u.protocol === "http:" || u.protocol === "https:")) return true;
    } catch {
      /* malformed dev URL: only the file is allowed */
    }
  }
  if (u.protocol !== "file:") return false;
  const file = new URL(origin.fileURL);
  return u.host === file.host && decodeURIComponent(u.pathname) === decodeURIComponent(file.pathname);
}
