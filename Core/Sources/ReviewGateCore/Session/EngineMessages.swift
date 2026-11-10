import Foundation

/// What a banner offers for an engine error (docs/PROTOCOL.md §19.6).
public enum EngineMessageAction: String, Sendable, Equatable, CaseIterable {
    /// `auth_required`: opens Terminal with `claude /login`.
    case login
    /// `session_crashed` / `cli_not_found`: `restart_session`.
    case restartSession
    /// `cli_not_found`: Settings › General (the claude path override).
    case openSettings
    /// §22 `mcp_auth_required`: `mcp_auth {server}` (a terminal with `claude /mcp`).
    case mcpLogin
    // MARK: wave1 mac-session (§30 / §33.4)
    /// `session_new`: a fresh chat (a start that fails the same way again, a chat that cannot be continued).
    case newChat
    /// §30 `resume_not_found` / `resume_failed`: the chat list, with the chat that could not be continued marked.
    case showPreviousChat
    /// The log folder (`~/Library/Logs/ReviewGate`).
    case openLogs
    /// §33.4: the new-workbench sheet (branch prefilled) or the workbench the work happened in.
    case openWorkbench
    /// §33.4: the folder the work happened in, in a window of its own.
    case openFolder
    // MARK: wave4 w4-longwork (§38.2)
    /// `max_turns`: "계속해" to the same chat, by the queue rules.
    case continueWork
    /// `usage_limit`: turn "풀리면 이어서 하기" on / off.
    case resumeAfterLimit
    // MARK: wave4b w4b-follow (§39.4)
    /// `worktree_outside_review` in a worktree of this repository: `chat_move` there (asks first while Claude works).
    case moveChat
}

/// How an `error` event is shown: a banner (with the transcript row) or a transient status chip that goes away by itself.
public enum EngineMessagePresentation: Sendable, Equatable {
    case banner
    /// `api_retrying`: "재시도 중 (2/10)…" in the HUD until the turn makes progress or ends.
    case retrying
    /// `cli_start_slow`: a hint in the HUD until the session has started.
    case slowStart
}

/// The one place that turns the engine's error and refusal codes (§19.6) into the user's words. Every code is matched
/// on its stable id (`result.code` / `error.code`, else the leading word of the English `error` text); an unknown or
/// absent code falls back to the engine's own text.
public enum EngineMessages {
    // MARK: Codes

    /// The leading code word of a refusal text: `gate_closed:running` → `gate_closed`, `empty message` → `empty_message`.
    public static func codeWord(_ raw: String) -> String {
        let head = raw.split(separator: ":", maxSplits: 1).first.map(String.init) ?? raw
        switch head {
        case "empty message": return "empty_message"
        case "empty note": return "empty_note"
        case "empty base": return "empty_base"
        case "engine disposed": return "engine_disposed"
        default:
            if head.hasPrefix("unknown command") { return "unknown_command" }
            if head.hasPrefix("Unknown PR file") { return "unknown_pr_file" }
            return head
        }
    }

    /// The part of a refusal text after `code:` (`gate_closed:running` → `running`); "" when there is none.
    public static func detail(of raw: String, code: String) -> String {
        guard raw.hasPrefix(code + ":") else { return "" }
        return String(raw.dropFirst(code.count + 1)).trimmingCharacters(in: .whitespaces)
    }

    /// Codes of the banner's extra actions.
    public static func actions(for code: String?) -> [EngineMessageAction] {
        switch code {
        case "auth_required": [.login]
        case "session_crashed": [.restartSession]
        case "cli_not_found": [.openSettings, .restartSession]
        case "cli_not_executable": [.openSettings]
        case "mcp_auth_required": [.mcpLogin]
        default: []
        }
    }

    public static func presentation(for detail: EngineErrorDetail, fatal: Bool) -> EngineMessagePresentation {
        guard !fatal else { return .banner }
        switch detail.code {
        case "api_retrying": return .retrying
        case "cli_start_slow": return .slowStart
        default: return .banner
        }
    }

    // MARK: Refusals (`result{ok:false}`)

    /// A refusal in the user's words. `code` (the wire's `result.code`) wins over the leading word of `error`.
    public static func refusal(code explicit: String? = nil, error raw: String, paths: [String] = []) -> String {
        let code = explicit ?? codeWord(raw)
        let detail = detail(of: raw, code: code)
        if let text = PeerText.refusal(code: code, detail: detail) { return text }   // wave1 mac-session (§29)
        if let text = AutoModeText.refusal(code: code) { return text }   // wave4b w4b-auto (§39.5)
        // Failures whose `error` is the underlying (English) text rather than `code:<detail>`.
        let underlying = plainGitFailure(detail.isEmpty && raw != code && codeWord(raw) != code ? raw : detail)
        switch code {
        case "session_busy", "session_running": return String(localized: "Claude is working — wait for the turn to finish", bundle: .module)
        case "reverting": return String(localized: "Reverting…", bundle: .module)
        case "review_pending": return String(localized: "Review the pending files first", bundle: .module)
        case "notes_pending": return String(localized: "Send or delete your review notes first", bundle: .module)
        case "session_current": return String(localized: "The current chat cannot be deleted", bundle: .module)
        case "session_not_found": return String(localized: "This chat no longer exists", bundle: .module)
        case "starting": return String(localized: "Claude is still starting — wait a moment", bundle: .module)
        case "no_session": return String(localized: "No Claude session is open — restart the session", bundle: .module)
        case "no_project": return String(localized: "Open a project first (⌘O)", bundle: .module)
        case "no_review": return String(localized: "There is no review to revert from", bundle: .module)
        case "no_plan": return String(localized: "There is no plan waiting for an answer", bundle: .module)
        case "gate_closed": return gateText(detail)
        case "request_changes_unavailable":
            switch detail {
            case "no_notes": return String(localized: "Add a review note first", bundle: .module)
            case "no_review", "": return String(localized: "There is no review to request changes on", bundle: .module)
            default: return gateText(detail)
            }
        case "collect_failed":
            return underlying.isEmpty ? String(localized: "Retry collecting the changes first", bundle: .module)
                : String(localized: "Could not collect the changes: \(underlying)", bundle: .module)
        case "file_changed_since_review":
            let list = paths.isEmpty ? detail : paths.joined(separator: ", ")
            return String(localized: "You edited these files after the review, so nothing was reverted: \(list)", bundle: .module)
        // wave1 mac-review — §32: a stub / skipped file in the snapshot; the batch was refused, nothing was reverted.
        case "not_captured":
            let list = paths.isEmpty ? detail : paths.joined(separator: ", ")
            return String(localized: "These files' content was not captured, so they cannot be reverted: \(list)", bundle: .module)
        case "binary_file", "partial_reject_unsupported", "stale_diff", "no_hunks", "unknown_hunk", "diff_mismatch",
             "not_a_changed_file":
            return HunkRefusal.from(raw.hasPrefix(code) ? raw : code).message
        case "not_pending": return String(localized: "This file is no longer pending review", bundle: .module)
        case "unknown_history_entry": return String(localized: "This review is no longer in the history", bundle: .module)
        case "not_in_history_entry": return String(localized: "This file is not part of that review", bundle: .module)
        case "history_trees_gone": return String(localized: "The snapshots of this review were pruned; its diff cannot be shown", bundle: .module)
        case "empty_message": return String(localized: "Enter a message", bundle: .module)
        case "empty_note": return String(localized: "Write the note first", bundle: .module)
        case "note_not_editable": return String(localized: "This note was already sent or no longer exists, so it cannot be edited", bundle: .module)
        case "empty_title": return String(localized: "Enter a title", bundle: .module)
        case "empty_base": return String(localized: "Choose a base branch", bundle: .module)
        case "engine_disposed": return String(localized: "The engine is shutting down", bundle: .module)
        case "unknown_command": return String(localized: "The engine does not know this command — update ReviewGate", bundle: .module)
        case "unknown_pr_file": return String(localized: "This file is not part of the pull request", bundle: .module)
        case "invalid_mode": return String(localized: "Unknown permission mode", bundle: .module)
        case "unknown_permission_request": return PermissionNotice.alreadyHandled.text   // wave1 mac-perms (§33.1)
        case "invalid_branch_name": return String(localized: "Not a valid branch name: \(detail)", bundle: .module)
        case "branch_in_use": return String(localized: "That branch is already checked out in \(detail)", bundle: .module)
        case "path_exists": return String(localized: "The folder already exists: \(detail)", bundle: .module)
        case "switch_blocked": return String(localized: "Finish the review before switching branches", bundle: .module)
        case "detached_head": return String(localized: "Check out a branch first (HEAD is detached)", bundle: .module)
        case "no_remote": return String(localized: "The repository has no remote", bundle: .module)
        case "unsupported_remote": return String(localized: "The origin remote is not a GitHub URL: \(detail)", bundle: .module)
        case "git_identity_missing": return String(localized: "Set your Git name and email first (git config --global user.name / user.email)", bundle: .module)
        case "git_init_not_needed": return String(localized: "This folder is already a Git repository", bundle: .module)
        case "nothing_to_commit": return String(localized: "Nothing to commit — accept files first", bundle: .module)
        case "nothing_to_push": return String(localized: "Nothing to push", bundle: .module)
        case "nothing_to_retry": return String(localized: "Nothing to retry", bundle: .module)
        case "locked_by_other_session": return String(localized: "This workbench is open in another window or session", bundle: .module)
        case "unknown_worktree": return String(localized: "This workbench no longer exists", bundle: .module)
        case "worktree_dirty": return String(localized: "The workbench has uncommitted changes", bundle: .module)
        case "worktree_locked": return String(localized: "The workbench is open in another session", bundle: .module)
        case "cannot_remove_main": return String(localized: "The main worktree cannot be removed", bundle: .module)
        case "cannot_remove_current": return String(localized: "The workbench this window has open cannot be removed", bundle: .module)
        case "plan_followup_failed":
            return detail.isEmpty ? String(localized: "The plan answer could not be sent to Claude — the plan is still pending", bundle: .module)
                : String(localized: "The plan answer could not be sent to Claude — the plan is still pending (\(detail))", bundle: .module)
        case "commit_failed": return String(localized: "Could not commit: \(underlying)", bundle: .module)
        case "push_failed": return String(localized: "Could not push: \(underlying)", bundle: .module)
        case "refresh_failed": return String(localized: "Could not refresh: \(underlying)", bundle: .module)
        case "revert_failed": return String(localized: "Could not revert: \(underlying)", bundle: .module)
        case "branch_failed": return String(localized: "The branch operation failed: \(underlying)", bundle: .module)
        case "workbench_failed": return String(localized: "The workbench operation failed: \(underlying)", bundle: .module)
        case "command_failed": return String(localized: "The command failed: \(underlying)", bundle: .module)
        // §21 side questions
        case "empty_question": return String(localized: "Type a question first", bundle: .module)
        case "question_too_long": return String(localized: "The question is too long (at most 20,000 characters)", bundle: .module)
        case "unknown_side_thread": return String(localized: "This side question no longer exists", bundle: .module)
        case "side_busy": return String(localized: "This side question is still answering — wait or stop it first", bundle: .module)
        case "side_limit": return String(localized: "Three side questions are already answering — wait for one to finish", bundle: .module)
        case "side_no_answer": return String(localized: "There is no answer to send yet", bundle: .module)
        case "side_no_anchor": return String(localized: "This side question is not about a file, so it cannot become a review note", bundle: .module)
        case "side_draft_failed":
            return detail.isEmpty ? String(localized: "Could not write the summary — try again", bundle: .module)
                : String(localized: "Could not write the summary: \(detail)", bundle: .module)
        case "invalid_promote": return String(localized: "Choose where to send it: the main conversation or a review note", bundle: .module)
        case "send_failed":
            return underlying.isEmpty ? String(localized: "Could not send the message to Claude", bundle: .module)
                : String(localized: "Could not send the message to Claude: \(underlying)", bundle: .module)
        // §35.1: a send / peer_accept whose snapshot A failed for want of git-lfs is refused with it — the banner's words.
        case "lfs_missing": return SessionNotices.lfsMissingText
        case "cli_not_found": return String(localized: "Claude CLI not found — install Claude Code or set its path in Settings", bundle: .module)
        case "cli_not_executable": return String(localized: "The claude executable cannot be run — set claude in Settings › Toolchain paths", bundle: .module)
        // §22 MCP servers
        case "invalid_mcp_name": return String(localized: "Server names use letters, digits, “-”, “_” and “.” (at most 64, starting with a letter or digit)", bundle: .module)
        case "invalid_mcp_scope": return String(localized: "Choose where to add the server: this session, the project or your user settings", bundle: .module)
        case "invalid_mcp_config":
            return detail.isEmpty ? String(localized: "The server settings are not valid", bundle: .module)
                : String(localized: "The server settings are not valid: \(detail)", bundle: .module)
        case "unknown_mcp_server": return String(localized: "This MCP server is not known (any more)", bundle: .module)
        case "mcp_unsupported": return String(localized: "This Claude session cannot manage MCP servers — update Claude Code", bundle: .module)
        case "mcp_failed":
            return underlying.isEmpty ? String(localized: "The MCP server operation failed", bundle: .module)
                : String(localized: "The MCP server operation failed: \(underlying)", bundle: .module)
        case "mcp_cli_failed":
            return underlying.isEmpty ? String(localized: "claude mcp failed", bundle: .module)
                : String(localized: "claude mcp failed: \(underlying)", bundle: .module)
        case "terminal_failed":
            return underlying.isEmpty ? String(localized: "Could not open a terminal", bundle: .module)
                : String(localized: "Could not open a terminal: \(underlying)", bundle: .module)
        // §23–27
        case "invalid_mention":
            return detail.isEmpty ? String(localized: "A mentioned path is outside the repository", bundle: .module)
                : String(localized: "Only files inside the repository can be mentioned: \(detail)", bundle: .module)
        case "too_many_mentions": return String(localized: "At most 20 files can be mentioned in one message", bundle: .module)
        case "list_files_failed": return String(localized: "Could not list the repository's files", bundle: .module)
        case "invalid_query": return String(localized: "Search for one line of at most 500 characters", bundle: .module)
        case "search_failed":
            return underlying.isEmpty ? String(localized: "The search failed", bundle: .module)
                : String(localized: "The search failed: \(underlying)", bundle: .module)
        case "too_many_attachments": return AttachmentProblem.tooMany.message
        case "attachment_type": return AttachmentProblem.unsupportedType.message
        case "attachment_too_large": return AttachmentProblem.tooLarge.message
        case "attachment_invalid": return AttachmentProblem.invalid.message
        case "unknown_attachment": return String(localized: "This image is no longer stored", bundle: .module)
        case "invalid_model": return String(localized: "The Claude CLI does not know this model", bundle: .module)
        case "invalid_effort": return String(localized: "Unknown effort level", bundle: .module)
        case "set_model_failed":
            return detail.isEmpty ? String(localized: "Could not switch the model", bundle: .module)
                : String(localized: "Could not switch the model: \(detail)", bundle: .module)
        case "invalid_rewind_mode": return String(localized: "Choose what to rewind: the conversation, the files or both", bundle: .module)
        case "unknown_turn": return String(localized: "This message is no longer part of the chat", bundle: .module)
        case "rewind_unavailable":
            switch detail {
            case "files": return String(localized: "The file snapshots of this point are gone, so the files cannot be rewound", bundle: .module)
            case "conversation": return String(localized: "The conversation cannot be rewound to this point", bundle: .module)
            default: return String(localized: "This point cannot be rewound to", bundle: .module)
            }
        case "focus_too_long": return String(localized: "The compaction focus is too long (at most 2,000 characters)", bundle: .module)
        default: return raw
        }
    }

    /// `gate_closed:<blockedReason>` (and `request_changes_unavailable:<reason>`).
    static func gateText(_ reason: String) -> String {
        switch reason {
        case "running": String(localized: "Claude is working — wait for the turn to finish", bundle: .module)
        case "awaiting_permission": String(localized: "Answer the pending permission request first", bundle: .module)
        case "collecting": String(localized: "Collecting the changes — wait a moment", bundle: .module)
        case "reverting": String(localized: "Reverting…", bundle: .module)
        case "collect_failed": String(localized: "Retry collecting the changes first", bundle: .module)
        case "pending_review": String(localized: "Review the pending files first", bundle: .module)
        case "changes_requested": String(localized: "Send the requested changes first", bundle: .module)
        case "no_session": String(localized: "No Claude session is open — restart the session", bundle: .module)
        case "starting": String(localized: "Claude is still starting — wait a moment", bundle: .module)
        case "git_init_needed": String(localized: "Initialize the Git repository first", bundle: .module)
        default: String(localized: "This cannot be sent right now", bundle: .module)
        }
    }

    // MARK: Error events

    /// An `error` event in the user's words; no / an unknown `code` → `message` as the engine wrote it.
    public static func error(message: String, detail: EngineErrorDetail,
                             timeZone: TimeZone = .current, locale: Locale = .current, now: Date = Date()) -> String {
        if let text = SessionNotices.errorText(message: message, detail: detail) { return text }   // wave1 mac-session (§30 / §33.4)
        let underlying = plainGitFailure(underlyingText(message))
        switch detail.code {
        case "auth_required": return String(localized: "Claude login is required", bundle: .module)
        case "usage_limit":
            guard let time = resetTime(detail, timeZone: timeZone, locale: locale, now: now) else {
                return String(localized: "Usage limit reached", bundle: .module)
            }
            return String(localized: "Usage limit reached — resets at \(time)", bundle: .module)
        case "rate_limited":
            if let time = resetTime(detail, timeZone: timeZone, locale: locale, now: now) {
                return String(localized: "The Claude API rate limit was hit — try again after \(time)", bundle: .module)
            }
            return String(localized: "The Claude API rate limit was hit — wait a moment and try again", bundle: .module)
        case "api_error":
            if let status = detail.status {
                return String(localized: "Claude API error (HTTP \(String(status))) — try again in a moment", bundle: .module)
            }
            return String(localized: "Claude API error — try again in a moment", bundle: .module)
        case "api_retrying": return retryText(detail)
        case "cli_start_slow": return String(localized: "Claude is slow to start — check your VPN / plugin marketplace", bundle: .module)
        case "session_crashed": return String(localized: "The Claude session crashed — restart the session", bundle: .module)
        case "cli_not_found": return String(localized: "Claude CLI not found — install Claude Code or set its path in Settings", bundle: .module)
        case "cli_not_executable": return String(localized: "The claude executable cannot be run — set claude in Settings › Toolchain paths", bundle: .module)
        case "session_start_failed": return String(localized: "The Claude session could not start: \(underlying)", bundle: .module)
        case "send_failed": return String(localized: "Could not send the message to Claude: \(underlying)", bundle: .module)
        case "plan_followup_failed": return String(localized: "The plan answer could not be sent to Claude — the plan is still pending", bundle: .module)
        case "extensions_init_timeout": return String(localized: "Claude did not start in time — restarted without your plugins and hooks", bundle: .module)
        case "unprompted_blocked": return String(localized: "Claude tried to work without a request; it was blocked and nothing was modified.", bundle: .module)
        case "project_open_failed": return String(localized: "Could not open the project: \(underlying)", bundle: .module)
        case "git_init_failed": return String(localized: "Could not initialize the Git repository: \(underlying)", bundle: .module)
        case "collect_failed": return String(localized: "Could not collect the changes: \(underlying)", bundle: .module)
        case "refresh_failed", "revert_failed", "branch_failed", "workbench_failed", "commit_failed", "command_failed":
            return refusal(code: detail.code, error: underlying)
        case "side_failed": return String(localized: "The side question failed: \(sideFailureText(message))", bundle: .module)
        case "mcp_auth_required":
            return detail.server.map { String(localized: "The MCP server “\($0)” needs you to log in", bundle: .module) }
                ?? String(localized: "An MCP server needs you to log in", bundle: .module)
        case "mcp_failed":
            if let server = detail.server {
                return String(localized: "The MCP server “\(server)” failed: \(underlying)", bundle: .module)
            }
            return refusal(code: "mcp_failed", error: underlying)
        default: return message
        }
    }

    /// A git failure in a folder that is no longer a repository — its `.git` moved, deleted, or swept from /tmp by macOS
    /// (git runs with `LC_ALL=C`) — in words; any other text as it is.
    static func plainGitFailure(_ text: String) -> String {
        guard text.contains("not a git repository") else { return text }
        return String(localized: "this folder is no longer a Git repository (its .git is gone) — was it moved or deleted? macOS deletes files in /tmp that were not opened for a few days", bundle: .module)
    }

    /// `api_retrying`: "Retrying (2/10)…".
    public static func retryText(_ detail: EngineErrorDetail) -> String {
        guard let attempt = detail.attempt else { return String(localized: "Retrying…", bundle: .module) }
        guard let max = detail.maxRetries else { return String(localized: "Retrying (\(String(attempt)))…", bundle: .module) }
        return String(localized: "Retrying (\(String(attempt))/\(String(max)))…", bundle: .module)
    }

    /// `resetAt` in local time — the time alone when it is today, else date and time.
    public static func resetTime(_ detail: EngineErrorDetail, timeZone: TimeZone = .current, locale: Locale = .current,
                                 now: Date = Date()) -> String? {
        guard let date = detail.resetDate else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let sameDay = calendar.isDate(date, inSameDayAs: now)
        var style = Date.FormatStyle(date: sameDay ? .omitted : .abbreviated, time: .shortened, locale: locale,
                                     calendar: calendar, timeZone: timeZone)
        style.timeZone = timeZone
        return date.formatted(style)
    }

    /// "Side question failed: x" → "x".
    static func sideFailureText(_ message: String) -> String {
        let lead = "Side question failed: "
        return message.hasPrefix(lead) ? String(message.dropFirst(lead.count)) : message
    }

    /// "Failed to collect changes: fatal: x" → "fatal: x" (the engine's English lead is replaced by ours).
    static func underlyingText(_ message: String) -> String {
        guard message.hasPrefix("Failed to "), let range = message.range(of: ": ") else { return message }
        return String(message[range.upperBound...])
    }
}
