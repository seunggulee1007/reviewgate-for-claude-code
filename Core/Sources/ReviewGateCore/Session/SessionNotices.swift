import Foundation

// MARK: wave1 mac-session
// docs/PROTOCOL.md §30 (session start and recovery), §33.4 (worktree notices), §29 (peer refusals) and the queue rules of
// the client handoff §2.9 (M4): which `error` events are notices, how they read, what their banner offers and how the
// same error repeated becomes one row (×N).

/// How an error banner / row reads.
public enum NoticeStyle: String, Sendable, Equatable {
    /// Nothing failed; the user should know what happened (`resume_not_found`, `resume_failed`). Blue / gray, never red.
    case info
    /// Something was stopped or skipped, or a non-fatal failure. Orange.
    case warning
    /// A fatal failure. Red.
    case error
}

/// What an error row in the transcript carries besides its text: the event's code and the CLI's own words (the merge key
/// of §30), the gray second line, how often the same error came in a row and when it came last.
public struct ErrorRowInfo: Sendable, Equatable {
    public var code: String?
    /// §30 `detail` as the engine sent it (the merge key with `code`).
    public var detail: String?
    /// The gray second line: the CLI's words · exit code · signal (nil = none).
    public var secondary: String?
    public var scope: ErrorScope?
    /// The same error (code + detail, else the text) reported this many times in a row; ≥ 1.
    public var count: Int
    /// When it was reported last; nil = unknown.
    public var lastAt: Date?
    /// MARK: r1-scope — §33.4 `worktree_outside_review`: the folder the row's actions open or move this chat to.
    public var path: String?

    public init(code: String? = nil, detail: String? = nil, secondary: String? = nil, scope: ErrorScope? = nil, count: Int = 1,
                lastAt: Date? = nil, path: String? = nil) {
        self.code = code
        self.detail = detail
        self.secondary = secondary
        self.scope = scope
        self.count = count
        self.lastAt = lastAt
        self.path = path
    }
}

public enum SessionNotices {
    // MARK: Classification (M4, §2.9)

    /// `error` codes that are notices, not failures: they never stop the composer queue and never post an "action needed"
    /// notification (`unprompted_blocked` included — §29's peer fallback must not pause the queue either).
    public static let notices: Set<String> = [
        "resume_not_found", "resume_failed", "worktree_blocked", "worktree_outside_review", "peer_release_failed", "unprompted_blocked",
        "cli_version_changed",   // wave3 mac-session (§36.8): a chat row only — the banner comes from `session.cli`
        // MARK: wave4 w4-longwork (§38.2)
        "max_turns", "hook_failed", "hook_blocked", "cli_warning", "cli_notice",
        // MARK: wave4b w4b-follow (§39.4)
        "chat_moved_in", "chat_moved_in_disk", "chat_move_failed",
        // MARK: wave4b w4b-auto (§39.5)
        "auto_mode_denied", "auto_mode_unavailable",
        // MARK: r1-git (§46, §31.3)
        "git_stashed", "claude_committed", "claude_moved_head", "reject_committed",
    ]

    /// Codes whose banner means the Claude session died; `state.session.ready` turning true clears it (§30).
    public static let sessionDeaths: Set<String> = ["session_crashed", "session_start_failed", "session_id_in_use"]

    public static func isNotice(code: String?, fatal: Bool) -> Bool {
        guard !fatal, let code else { return false }
        return notices.contains(code)
    }

    public static func style(code: String?, fatal: Bool) -> NoticeStyle {
        if fatal { return .error }
        if let git = GitNoticeText.style(code) { return git }   // r1-git (§46): gray rows
        switch code {
        case "resume_not_found", "resume_failed": return .info
        case "cli_version_changed": return .info   // wave3 mac-session (§36.8)
        case "cli_notice": return .info   // wave4 w4-longwork (§38.2): the CLI's gray notice
        case "chat_moved_in", "chat_moved_in_disk": return .info   // wave4b w4b-follow (§39.4)
        case "auto_mode_denied", "auto_mode_unavailable": return .info   // wave4b w4b-auto (§39.5): gray rows
        case "worktree_outside_review": return .info   // r1-scope (§33.4): what already ran outside the review — a row, not a warning
        default: return .warning
        }
    }

    /// True for a banner the next successful start (`ready` false → true) makes obsolete.
    public static func isSessionDeath(code: String?, fatal: Bool, scope: ErrorScope) -> Bool {
        if let code, sessionDeaths.contains(code) { return true }
        return fatal && scope == .session && code == nil
    }

    // MARK: Banner actions (§2.6, §2.5)

    /// The banner's actions, most useful first. A start failure offers a new chat first; a crash reconnects first unless the
    /// same failure keeps coming back (`repeats ≥ 2`). §33.4 notices open the work as a workbench (or the folder).
    public static func bannerActions(code: String?, repeats: Int, path: String? = nil, pathIsWorkbench: Bool = false) -> [EngineMessageAction] {
        switch code {
        case "session_start_failed": return [.newChat, .restartSession, .openLogs]
        case "session_crashed": return repeats >= 2 ? [.newChat, .restartSession] : [.restartSession, .newChat]
        case "session_id_in_use": return [.newChat]
        case "max_turns": return [.continueWork]   // wave4 w4-longwork (§38.2)
        case "usage_limit": return [.resumeAfterLimit]   // wave4 w4-longwork (§38.2): the banner only (no "needs you" notification change)
        case "resume_not_found", "resume_failed": return [.showPreviousChat]
        case "worktree_blocked": return [.openWorkbench]
        case "worktree_outside_review":
            guard let path, !path.isEmpty else { return [] }
            // wave4b w4b-follow (§39.4): a worktree of this repository — the chat can follow; the workbench stays.
            return pathIsWorkbench ? [.moveChat, .openWorkbench] : [.openFolder]
        default: return EngineMessages.actions(for: code)
        }
    }

    // MARK: Words

    /// The engine's English text for a start that died before initialize (§30) — not worth a second line.
    static let genericStartFailure = "Claude Code exited while starting."

    /// The user's words for the §30 / §33.4 / §29 codes; nil = not one of them (the caller falls back to `EngineMessages`).
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        if let text = LongWorkText.errorText(message: message, detail: detail) { return text }   // wave4 w4-longwork (§38.2)
        if let text = ChatMoveText.noticeText(code: detail.code, path: detail.path, message: message, detail: detail.detail) { return text }   // wave4b w4b-follow
        if let text = AutoModeText.errorText(message: message, detail: detail) { return text }   // wave4b w4b-auto (§39.5)
        if let text = ScopeText.errorText(message: message, detail: detail) { return text }   // r1-scope (§33.4)
        if let text = GitNoticeText.errorText(message: message, detail: detail) { return text }   // r1-git (§46)
        switch detail.code {
        case "session_start_failed": return String(localized: "Claude Code quit right after it started.", bundle: .module)
        case "session_crashed": return String(localized: "The Claude session ended unexpectedly.", bundle: .module)
        case "resume_not_found":
            return String(localized: "Claude Code has no record of this chat any more, so a new chat was started (cleaned up after 30 days, or deleted). The previous chat stays readable in the list.", bundle: .module)
        case "resume_failed":
            return String(localized: "Claude Code could not load this chat's record, so a new chat was started. The previous chat stays readable in the list.", bundle: .module)
        case "session_id_in_use": return String(localized: "This chat could not be continued. Start a new chat.", bundle: .module)
        case "peer_release_failed": return peerReleaseFailedText
        case "lfs_missing": return lfsMissingText
        case "cli_version_changed": return CliVersionText.notice(detail.cli, message: message)   // wave3 mac-session (§36.8)
        case "worktree_blocked":
            switch detail.toolName {
            case "EnterWorktree":
                if let branch = detail.branch, !branch.isEmpty {
                    return String(localized: "Claude tried to work in a separate worktree ('\(branch)'), so it was stopped: this window's review would not see that work.", bundle: .module)
                }
                return String(localized: "Claude tried to work in a separate worktree, so it was stopped: this window's review would not see that work.", bundle: .module)
            case "Workflow":
                return String(localized: "The workflow tool runs agents outside this window, so it was stopped.", bundle: .module)
            case "Agent", "Task":
                return String(localized: "A subagent in isolated (worktree) mode was stopped.", bundle: .module)
            default:
                return String(localized: "Claude tried to work outside this window's folder, so it was stopped: this window's review would not see that work.", bundle: .module)
            }
        case "worktree_outside_review":
            if let path = detail.path, !path.isEmpty {
                let shown = abbreviatingHome(path)
                return String(localized: "Claude worked where this window's review does not see it: \(shown)", bundle: .module)
            }
            return String(localized: "Claude worked where this window's review does not see it.", bundle: .module)
        default: return nil
        }
    }

    public static var peerReleaseFailedText: String {
        String(localized: "The other session's message could not be handed to Claude. Try again or decline it.", bundle: .module)
    }

    public static var lfsMissingText: String {
        String(localized: "This repository uses Git LFS, but git-lfs is not installed. Run brew install git-lfs && git lfs install in Terminal, then try again.", bundle: .module)
    }

    /// The banner's / row's gray second line: the CLI's own words (§30 `detail`; for a start failure or crash without one,
    /// the engine's text when it says more than the generic sentence), then the exit code and the signal.
    public static func secondaryLine(message: String, detail: EngineErrorDetail) -> String? {
        if LongWorkText.hidesSecondary(detail.code) { return nil }   // wave4 w4-longwork (§38.2): the CLI's words are the row
        if AutoModeText.hidesSecondary(detail.code) { return nil }   // wave4b w4b-auto (§39.5): the row names the call and the reason
        if GitNoticeText.isRowOnly(detail.code) { return nil }   // r1-git (§46): the row names the files / commits
        if detail.code == "hook_blocked", !(detail.hookName ?? "").isEmpty { return nil }   // wave4b w4b-check4 (§40.1): the row names the hook and the reason
        var parts: [String] = []
        if let words = detail.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty {
            parts.append(words)
        } else if detail.code == "session_start_failed" || detail.code == "session_crashed" {
            let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, text != genericStartFailure { parts.append(text) }
        }
        if let exit = detail.exitCode { parts.append(String(localized: "Exit code \(String(exit))", bundle: .module)) }
        if let signal = detail.signal, !signal.isEmpty { parts.append(String(localized: "Signal \(signal)", bundle: .module)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "×3 · last 09:41" for a repeated error; nil for a single one.
    public static func repeatText(count: Int, lastAt: Date?, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard count > 1 else { return nil }
        guard let lastAt else { return "×\(count)" }
        var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone)
        style.timeZone = timeZone
        let time = lastAt.formatted(style)
        return String(localized: "×\(count) · last \(time)", bundle: .module)
    }

    /// `/Users/me/x` → `~/x`.
    public static func abbreviatingHome(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard !home.isEmpty, home != "/", path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }

    // MARK: Restored rows (§30 `kind: "error"`)

    /// A restored row keeps only `{message, fatal, scope, code, detail}`: the §33.4 tool / branch / path are read back from
    /// the engine's English text so the row reads like the live banner did.
    public static func restoredDetail(code: String?, detail: String?, message: String,
                                      facts: EngineErrorDetail = EngineErrorDetail()) -> EngineErrorDetail {
        // §35.3: the row keeps what the event carried; only a row written before that is read back from the words.
        var d = facts
        d.code = code
        d.detail = detail
        guard d.toolName == nil else { return d }
        switch code {
        case "worktree_blocked":
            // "Claude tried to work in a git worktree ("name"); …" / "Claude tried to work in <Tool> outside this folder; …"
            if message.hasPrefix("Claude tried to work in a git worktree") {
                d.toolName = "EnterWorktree"
                d.branch = between(message, "(\"", "\")")
            } else if let rest = message.components(separatedBy: "Claude tried to work in ").dropFirst().first,
                      let tool = rest.components(separatedBy: " outside this folder").first, !tool.isEmpty, !tool.contains(" ") {
                d.toolName = tool
            }
        case "worktree_outside_review":
            // "<Tool> worked outside this window's review (<path>): …"
            if let tool = message.components(separatedBy: " worked outside").first, !tool.contains(" ") { d.toolName = tool }
            d.path = between(message, "review (", "):")
        default: break
        }
        return d
    }

    private static func between(_ text: String, _ open: String, _ close: String) -> String? {
        guard let a = text.range(of: open), let b = text.range(of: close, range: a.upperBound..<text.endIndex) else { return nil }
        let inner = String(text[a.upperBound..<b.lowerBound])
        return inner.isEmpty ? nil : inner
    }

    // MARK: Merging repeats (§30: "clients merge repeats on code + detail")

    /// The identity two reports of the same error share: code + detail, else code + text, else the text.
    public static func mergeKey(message: String, code: String?, detail: String?) -> String {
        guard let code, !code.isEmpty else { return message }
        if let detail, !detail.isEmpty { return code + "\u{1F}" + detail }
        return code + "\u{1F}" + message
    }

    /// Appends an error row — or, when the last error row says the same thing and no new user turn started since (a user
    /// message or a delivered peer message), bumps its count (×N) and time instead. `mergeable` excludes rows (e.g. ones
    /// restored from a previous run). Returns the row's count after the call.
    @discardableResult
    public static func appendError(to rows: inout [ChatItem], id: UUID = UUID(), message: String, fatal: Bool, info: ErrorRowInfo,
                                   mergeable: (UUID) -> Bool = { _ in true }) -> Int {
        let key = mergeKey(message: message, code: info.code, detail: info.detail)
        for index in rows.indices.reversed() {
            switch rows[index] {
            case let .error(rowID, rowMessage, rowFatal, rowInfo):
                guard mergeKey(message: rowMessage, code: rowInfo.code, detail: rowInfo.detail) == key, mergeable(rowID) else { break }
                var merged = rowInfo
                merged.count += max(info.count, 1)
                merged.lastAt = info.lastAt ?? rowInfo.lastAt
                merged.secondary = info.secondary ?? rowInfo.secondary
                rows[index] = .error(id: rowID, message: message, fatal: rowFatal || fatal, info: merged)
                return merged.count
            case .user:
                return append(&rows, id: id, message: message, fatal: fatal, info: info)
            case let .peerMessage(_, peer) where peer.state == .delivered:
                return append(&rows, id: id, message: message, fatal: fatal, info: info)
            default:
                continue
            }
            // A different error (or one that may not be merged into) ends the search: only the last error row counts.
            return append(&rows, id: id, message: message, fatal: fatal, info: info)
        }
        return append(&rows, id: id, message: message, fatal: fatal, info: info)
    }

    private static func append(_ rows: inout [ChatItem], id: UUID, message: String, fatal: Bool, info: ErrorRowInfo) -> Int {
        var info = info
        info.count = max(info.count, 1)
        rows.append(.error(id: id, message: message, fatal: fatal, info: info))
        return info.count
    }
}
