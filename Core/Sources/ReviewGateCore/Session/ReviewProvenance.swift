import Foundation

// Testable view logic for review provenance (docs/PROTOCOL.md §31–§32): the review list split by who changed a file,
// the mods group and its risk badges, the reject-all wording, the stale-review sheet, the "finish review" rules and
// the banners for HEAD moves, other Claude sessions, settings.local.json, nested repositories and skipped files.

// MARK: - Files

public extension ChangedFile {
    /// Nothing of Claude's explains the change (an IDE save, another session, `git pull`, work while the app was closed).
    var isExternal: Bool { origin == .external }
    /// A Bash call changed it (§31: by its execution window — not merely "no edit tool touched it"); wave2 mac-diff
    /// (comp-05): and Bash is its only cause (`FileRisk.isViaBash`).
    var isViaBash: Bool { FileRisk.isViaBash(self) }
    /// `.claude/**`, `.mcp.json`, `CLAUDE*.md`: the change alters how Claude Code itself behaves.
    var isMods: Bool { group == .mods }
}

public extension TurnSummary {
    /// §31: the files of the turn nothing of Claude's explains — the card's "앱 밖 변경 M개 포함".
    var externalCount: Int { files.filter { $0.origin == .external }.count }
}

public extension ModsRisk {
    /// The red badge of a mods file.
    var label: String {
        switch self {
        case .hook: String(localized: "Hook — runs automatically from the next prompt", bundle: .module)
        case .script: String(localized: "Executable script", bundle: .module)
        case .mcp: String(localized: "MCP server", bundle: .module)
        case .permissions: String(localized: "Permission rules", bundle: .module)
        case .env: String(localized: "Environment variables", bundle: .module)
        case let .other(raw): raw
        }
    }
}

/// One group of the review list: the mods files first, then Claude's changes, then the changes from outside the app.
public struct ChangedFileSection: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable, Equatable, CaseIterable {
        /// `group == .mods` (any origin): "설정·훅 (Claude 동작 변경)".
        case mods
        /// Changed by an edit tool, an MCP call or Bash (or an older engine that sends no origin).
        case claude
        /// Origin `external`.
        case external
    }

    public var kind: Kind
    public var files: [ChangedFile]
    // MARK: wave4b w4b-bigturn
    /// §39.1: a bulk list's folder (`FolderFold`, "" = the root) — nil for the ordinary sections.
    public var folder: String?
    // MARK: wave4b w4b-files
    /// §40.2: a "묶기" section inside the group (`FileGroups`): its key and header ("서비스", "…/orders/billing") — nil otherwise.
    public var subgroup: String?
    public var subgroupTitle: String?

    public var id: String { (folder.map { "\(kind.rawValue)|\($0)" } ?? kind.rawValue) + (subgroup.map { "#\($0)" } ?? "") }

    public init(kind: Kind, files: [ChangedFile]) {
        self.kind = kind
        self.files = files
    }

    /// The section header, with the number of files in it.
    public var title: String {
        if let folder { return "\(folder.isEmpty ? "/" : folder + "/") \(files.count)" }   // wave4b w4b-bigturn
        if let subgroupTitle { return "\(subgroupTitle) \(files.count)" }   // wave4b w4b-files
        return switch kind {
        case .mods: String(localized: "Settings & hooks (changes how Claude works) \(files.count)", bundle: .module)
        case .claude: String(localized: "Claude changes \(files.count)", bundle: .module)
        case .external: String(localized: "Outside the app \(files.count)", bundle: .module)
        }
    }

    /// What the header's tooltip explains.
    public var help: String {
        switch kind {
        case .mods: String(localized: "Claude Code's own configuration (.claude, .mcp.json, CLAUDE.md) — hooks and settings take effect from the next prompt, in every session", bundle: .module)
        case .claude: String(localized: "Changes Claude's edit tools, MCP tools or Bash commands made", bundle: .module)
        case .external: ReviewProvenanceText.externalHelp
        }
    }

    /// Mods first, then Claude's changes, then the external ones; empty groups are left out. `riskOrder` sorts each
    /// group riskiest first (`FileRisk.ordered`), else the files keep git's order.
    public static func build(_ files: [ChangedFile], riskOrder: Bool) -> [ChangedFileSection] {
        let ordered = riskOrder ? FileRisk.ordered(files) : files
        let groups: [(Kind, [ChangedFile])] = [
            (.mods, ordered.filter(\.isMods)),
            (.claude, ordered.filter { !$0.isMods && !$0.isExternal }),
            (.external, ordered.filter { !$0.isMods && $0.isExternal }),
        ]
        return groups.compactMap { kind, files in files.isEmpty ? nil : ChangedFileSection(kind: kind, files: files) }
    }
}

// MARK: - Reject all

/// What "Reject all" reverts and what it leaves (§31 / §32), for the confirmation dialog.
public struct RejectAllPlan: Equatable, Sendable {
    /// Pending files Claude changed that will be reverted.
    public var claude: [String]
    /// Pending external files left alone (`gate.externalPendingCount` of them); "앱 밖 변경도 되돌리기" adds them.
    public var external: [String]
    /// Pending Claude files whose content was not captured — they cannot be reverted and are left alone.
    public var uncaptured: [String]

    public init(claude: [String], external: [String], uncaptured: [String]) {
        self.claude = claude
        self.external = external
        self.uncaptured = uncaptured
    }

    /// `externalCount`: the engine's `gate.externalPendingCount` (wins over the list's count when it is larger — the
    /// list may lag a snapshot behind).
    public init(pending: [ChangedFile], externalCount: Int? = nil) {
        let pending = pending.filter { $0.state == .pending }
        claude = pending.filter { !$0.isExternal && !$0.uncaptured }.map(\.path)
        external = pending.filter(\.isExternal).map(\.path)
        uncaptured = pending.filter { !$0.isExternal && $0.uncaptured }.map(\.path)
        externalCountOverride = externalCount
    }

    private var externalCountOverride: Int?

    /// M in "앱 밖 변경 M개는 그대로 둡니다".
    public var externalCount: Int { max(external.count, externalCountOverride ?? 0) }

    /// The dialog's body.
    public var message: String {
        var parts: [String] = []
        if claude.isEmpty {
            parts.append(String(localized: "There are no pending changes by Claude to revert.", bundle: .module))
        } else {
            parts.append(String(localized: "Reverts \(claude.count) change(s) by Claude.", bundle: .module))
        }
        if externalCount > 0 {
            parts.append(String(localized: "The \(externalCount) change(s) from outside the app stay as they are.", bundle: .module))
        }
        if !uncaptured.isEmpty {
            parts.append(String(localized: "\(uncaptured.count) file(s) whose content was not captured cannot be reverted and stay as they are.", bundle: .module))
        }
        return parts.joined(separator: " ")
    }
}

/// A reject the user still has to confirm because it reverts files Claude may not have changed (origin `external`).
public struct ExternalRejectRequest: Sendable, Equatable {
    /// `reject {paths}` of one external file, or `reject_all {includeExternal: true}`.
    public var command: EngineCommand
    /// The external files it would revert (shown in the alert).
    public var paths: [String]

    public init(command: EngineCommand, paths: [String]) {
        self.command = command
        self.paths = paths
    }

    /// The alert's body: the warning plus the files (at most 8 listed).
    public var message: String {
        let shown = paths.prefix(8).joined(separator: "\n")
        let more = paths.count > 8 ? "\n" + String(localized: "…and \(paths.count - 8) more", bundle: .module) : ""
        return ReviewProvenanceText.externalRejectWarning + "\n\n" + shown + more
    }
}

// MARK: - Stale review (§31.5)

public extension StaleReview {
    /// The sheet's lines under the title: when it was saved, then one line per reason.
    func lines(now: Date = Date(), locale: Locale = .current) -> [String] {
        var out: [String] = []
        if let saved = savedDate {
            let formatter = RelativeDateTimeFormatter()
            formatter.locale = locale
            formatter.unitsStyle = .full
            formatter.dateTimeStyle = .named
            out.append(String(localized: "Saved \(formatter.localizedString(for: saved, relativeTo: now))", bundle: .module))
        }
        for reason in reasons {
            switch reason {
            case .headMoved:
                let from = savedHead.map(ReviewProvenanceText.headLabel) ?? "?"
                let to = head.map(ReviewProvenanceText.headLabel) ?? "?"
                out.append(String(localized: "HEAD has changed since then: \(from) → \(to)", bundle: .module))
            case .old:
                out.append(String(localized: "More than 12 hours have passed", bundle: .module))
            case .other:
                continue
            }
        }
        if externalFiles > 0 {
            out.append(String(localized: "\(externalFiles) change(s) from outside the app are mixed in", bundle: .module))
        }
        return out
    }
}

// MARK: - Finish review (§31.5)

public enum FinishReviewRules {
    /// Why "리뷰 끝내기" is unavailable; nil when it can be sent. Mirrors the engine's refusals (a turn running or
    /// being collected, a revert, a failed collection) plus "nothing to finish" — unless a stale flag is there to clear.
    public static func blocker(phase: GatePhase, collectError: String?, files: Int, notes: Int, stale: Bool = false) -> String? {
        switch phase {
        case .running, .collecting: return EngineMessages.refusal(error: "session_running")
        case .reverting: return EngineMessages.refusal(error: "reverting")
        case .collectFailed: return EngineMessages.refusal(error: "collect_failed")
        case .idle, .starting, .reviewing: break
        }
        if collectError != nil { return EngineMessages.refusal(error: "collect_failed") }
        if files == 0 && notes == 0 && !stale { return String(localized: "There is no review to finish", bundle: .module) }
        return nil
    }

    /// The confirmation's body: only the list is emptied (+ the notes that go with it).
    public static func confirmation(notes: Int) -> String {
        var text = String(localized: "Only the review list is cleared. The files stay on disk as they are and become the baseline from the next message.", bundle: .module)
        if notes > 0 { text += "\n" + String(localized: "\(notes) note(s) will be deleted too.", bundle: .module) }
        return text
    }
}

// MARK: - Restored review banner

/// The "review restored" banner (`gate.restored`): it hides itself after a few seconds — except when the review is
/// stale or changes from outside the app slipped in, which the user should not miss.
public struct RestoredReviewBanner: Equatable, Sendable {
    public var id: String
    /// `gate.externalPendingCount`.
    public var externalCount: Int
    public var stale: Bool

    public init(id: String, externalCount: Int, stale: Bool) {
        self.id = id
        self.externalCount = externalCount
        self.stale = stale
    }

    public var autoHides: Bool { !stale && externalCount == 0 }

    public var message: String {
        let base = String(localized: "Review restored from a previous session", bundle: .module)
        guard externalCount > 0 else { return base }
        return base + " · " + String(localized: "\(externalCount) change(s) slipped in since", bundle: .module)
    }
}

// MARK: - Banners (§31–32)

/// One banner of the review notices bar, built from `state.gate`.
public struct ReviewNotice: Identifiable, Equatable, Sendable {
    public enum Severity: Sendable, Equatable {
        /// Red: changes the review cannot see or revert (nested repositories, settings.local.json).
        case critical
        /// Orange: HEAD moved, files left out of the snapshot.
        case warning
        /// Yellow: another Claude session in this worktree.
        case caution
    }

    public enum Kind: Sendable, Equatable {
        case nested(NestedChange)
        case localSettings(LocalSettingsChange)
        case headMoved(HeadMove)
        /// The sessions not dismissed yet.
        case concurrent([ConcurrentClaude])
        case skipped([SkippedPath])
    }

    public var id: String
    public var kind: Kind
    public var severity: Severity
    /// What happened, in one line.
    public var message: String
    /// Secondary facts (one gray line each).
    public var details: [String]
    /// Recorded in `AppState.dismissedReviewNotices` when the user closes it (one per session for `.concurrent`, so a
    /// later send with the same sessions does not bring it back but a new session does).
    public var dismissKeys: [String]

    public init(id: String, kind: Kind, severity: Severity, message: String, details: [String] = [], dismissKeys: [String]) {
        self.id = id
        self.kind = kind
        self.severity = severity
        self.message = message
        self.details = details
        self.dismissKeys = dismissKeys
    }
}

public enum ReviewNotices {
    /// What the banners are scoped to: the project (every key starts with it) and the turn that produced the per-turn
    /// signals (`sessionId#hud.turnCount`), so a dismissed banner stays closed until the next turn reports it again.
    public struct Scope: Sendable, Equatable {
        public var project: String
        public var turn: String

        public init(project: String, turn: String) {
            self.project = project
            self.turn = turn
        }
    }

    /// Red first (nested repositories, settings.local.json), then HEAD moves, other Claude sessions, skipped files;
    /// the dismissed ones are left out.
    public static func build(gate: GateInfo, scope: Scope, dismissed: Set<String>) -> [ReviewNotice] {
        var out: [ReviewNotice] = []
        let turn = "\(scope.project)|\(scope.turn)"
        for repo in gate.nestedChanges {
            let key = "nested|\(turn)|\(repo.path)|\(repo.head?.to ?? "")"
            guard !dismissed.contains(key) else { continue }
            out.append(ReviewNotice(id: key, kind: .nested(repo), severity: .critical, message: ReviewProvenanceText.nested(repo),
                                    details: ReviewProvenanceText.nestedDetails(repo), dismissKeys: [key]))
        }
        if let change = gate.localSettingsChanged {
            let key = "local|\(turn)|\(change.path)|\(change.hooks)\(change.permissions)\(change.env)\(change.mcp)"
            if !dismissed.contains(key) {
                out.append(ReviewNotice(id: key, kind: .localSettings(change), severity: .critical, message: ReviewProvenanceText.localSettings(change),
                                        details: change.permissions ? [ReviewProvenanceText.localSettingsPermissionsNote] : [], dismissKeys: [key]))
            }
        }
        if let move = gate.headMoved, !move.isClaudesOwn {   // r1-git (§31.3): Claude's own move is a chat row, never this bar
            let key = "head|\(turn)|\(move.from.sha ?? "")|\(move.from.branch ?? "")|\(move.to.sha ?? "")|\(move.to.branch ?? "")"
            if !dismissed.contains(key) {
                out.append(ReviewNotice(id: key, kind: .headMoved(move), severity: .warning, message: ReviewProvenanceText.headMoved(move), dismissKeys: [key]))
            }
        }
        let sessions = gate.concurrentClaude.filter { !dismissed.contains(concurrentKey($0, project: scope.project)) }
        if !sessions.isEmpty {
            let keys = sessions.map { concurrentKey($0, project: scope.project) }
            out.append(ReviewNotice(id: "claude|" + keys.joined(separator: ","), kind: .concurrent(sessions), severity: .caution,
                                    message: ReviewProvenanceText.concurrent(sessions), dismissKeys: keys))
        }
        if !gate.snapshotSkipped.isEmpty {
            // Not per turn: the same unreadable files are skipped every turn until they are ignored — closed once is enough.
            let key = "skipped|\(scope.project)|" + gate.snapshotSkipped.map(\.path).sorted().joined(separator: ",")
            if !dismissed.contains(key) {
                out.append(ReviewNotice(id: key, kind: .skipped(gate.snapshotSkipped), severity: .warning,
                                        message: ReviewProvenanceText.skipped(gate.snapshotSkipped), dismissKeys: [key]))
            }
        }
        return out
    }

    /// One key per process (a reused pid has another start time); the project scopes it to the worktree.
    public static func concurrentKey(_ session: ConcurrentClaude, project: String) -> String {
        "claude|\(project)|\(session.pid)@\(session.startedAt ?? "")"
    }

    /// The ignore-pattern text with `paths` appended (one per line), skipping the ones already listed; nil when nothing
    /// new would be added. `current` is the stored text (nil: never edited — the defaults).
    public static func ignorePatterns(adding paths: [String], to current: String?, defaults: [String]) -> String? {
        let text = current ?? defaults.joined(separator: "\n")
        let existing = Set(text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) })
        var seen = Set<String>()
        let added = paths.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !existing.contains($0) && seen.insert($0).inserted }
        guard !added.isEmpty else { return nil }
        let base = text.hasSuffix("\n") || text.isEmpty ? text : text + "\n"
        return base + added.joined(separator: "\n")
    }
}

// MARK: - Texts

/// The §31–32 wording in one place (Korean in the catalog).
public enum ReviewProvenanceText {
    /// The external badge.
    public static var externalBadge: String { String(localized: "Outside the app", bundle: .module) }

    /// The external badge's tooltip.
    public static var externalHelp: String {
        String(localized: "Not changed by a Claude tool — the IDE, another session or a git pull may have changed it", bundle: .module)
    }

    /// The diff header's cause line when no tool call explains the change.
    public static func noCause(external: Bool) -> String {
        external ? String(localized: "Outside the app — Claude may not have changed this", bundle: .module)
            : String(localized: "No recorded cause — ask in a side question", bundle: .module)
    }

    public static var uncaptured: String { String(localized: "Content not captured (large file / binary) — cannot be reverted", bundle: .module) }
    public static var ignored: String { String(localized: "Gitignored — not committable", bundle: .module) }

    /// The turn summary / turn-end line: "앱 밖 변경 M개 포함".
    public static func externalIncluded(_ count: Int) -> String {
        String(localized: "Includes \(count) change(s) from outside the app", bundle: .module)
    }

    /// The second confirmation before external files are reverted.
    public static var externalRejectWarning: String {
        String(localized: "Claude may not have changed these files. Reverting them discards those edits:", bundle: .module)
    }

    /// `branch@sha7`; a detached HEAD is its commit alone, an unborn one its branch.
    public static func headLabel(_ head: HeadInfo) -> String {
        switch (head.branch, head.shortSha) {
        case let (branch?, sha?): "\(branch)@\(sha)"
        case let (nil, sha?): sha
        case let (branch?, nil): String(localized: "\(branch) (no commits)", bundle: .module)
        case (nil, nil): "?"
        }
    }

    public static func headMoved(_ move: HeadMove) -> String {
        String(localized: "The branch / commit changed during this turn (\(headLabel(move.from)) → \(headLabel(move.to))). The difference is shown as changes from outside the app.", bundle: .module)
    }

    /// "acme-b4 (터미널)" / "pid 123 (앱/SDK)".
    public static func sessionLabel(_ session: ConcurrentClaude) -> String {
        let name = session.name.flatMap { $0.isEmpty ? nil : $0 } ?? "pid \(session.pid)"
        return session.isTerminal ? String(localized: "\(name) (terminal)", bundle: .module) : String(localized: "\(name) (app / SDK)", bundle: .module)
    }

    public static func concurrent(_ sessions: [ConcurrentClaude]) -> String {
        let shown = sessions.prefix(3).map(sessionLabel).joined(separator: ", ")
        let list = sessions.count > 3 ? shown + " " + String(localized: "and \(sessions.count - 3) more", bundle: .module) : shown
        return String(localized: "Another Claude session is running in this worktree: \(list) — its edits mix in as changes from outside the app. Move it to a workbench.", bundle: .module)
    }

    /// "훅·권한·환경변수·MCP": the parts of settings.local.json that changed.
    public static func localSettingsParts(_ change: LocalSettingsChange) -> String {
        var parts: [String] = []
        if change.hooks { parts.append(String(localized: "hooks", bundle: .module)) }
        if change.permissions { parts.append(String(localized: "permissions", bundle: .module)) }
        if change.env { parts.append(String(localized: "environment variables", bundle: .module)) }
        if change.mcp { parts.append("MCP") }
        return parts.joined(separator: "·")
    }

    public static func localSettings(_ change: LocalSettingsChange) -> String {
        let parts = localSettingsParts(change)
        if parts.isEmpty {
            return String(localized: "\(change.path) changed — it may hold secrets, so its content is not kept and the change cannot be reverted.", bundle: .module)
        }
        return String(localized: "\(change.path) changed (\(parts)) — it may hold secrets, so its content is not kept and the change cannot be reverted.", bundle: .module)
    }

    /// Added when the permissions changed (§33.5: the user's allow rules apply to read-only tools).
    public static var localSettingsPermissionsNote: String {
        String(localized: "Changed allow rules may apply to look-up / read tools from the next session (check them in Settings › General › Permissions › Terminal (Claude Code) allow rules).", bundle: .module)
    }

    public static func nestedKind(_ kind: NestedKind) -> String {
        switch kind {
        case .worktree: String(localized: "worktree", bundle: .module)
        case .submodule: String(localized: "submodule", bundle: .module)
        case .repo, .other: String(localized: "nested repository", bundle: .module)
        }
    }

    /// The files the turn changed in it (its edits), else the repository's `git status` count; nil when unknown.
    public static func nestedFileCount(_ repo: NestedChange) -> Int? {
        if !repo.touchedFiles.isEmpty { return repo.touchedFiles.count }
        return repo.dirtyFiles
    }

    public static func nested(_ repo: NestedChange) -> String {
        var what = nestedKind(repo.kind)
        if let branch = repo.branch, !branch.isEmpty { what += " · \(branch)" }
        if let count = nestedFileCount(repo) {
            return String(localized: "Outside the review — \(repo.path) (\(what), \(count) file(s)): not reviewed in this window", bundle: .module)
        }
        return String(localized: "Outside the review — \(repo.path) (\(what)): not reviewed in this window", bundle: .module)
    }

    public static func nestedDetails(_ repo: NestedChange) -> [String] {
        var out: [String] = []
        if let head = repo.head { out.append("HEAD \(head.from.prefix(7)) → \(head.to.prefix(7))") }
        if repo.dirtyFiles == nil { out.append(String(localized: "Status check timed out", bundle: .module)) }
        return out
    }

    public static func skipped(_ files: [SkippedPath]) -> String {
        let shown = files.prefix(3).map(\.path).joined(separator: ", ")
        let list = files.count > 3 ? shown + " " + String(localized: "and \(files.count - 3) more", bundle: .module) : shown
        return String(localized: "Left \(files.count) unreadable file(s) out of this review: \(list)", bundle: .module)
    }

    /// The sidecar log line of a §31–32 event (English, like the rest of the log); nil for other events.
    public static func logLine(for event: EngineEvent) -> String? {
        switch event {
        case let .headMoved(e):
            let own = e.move.isClaudesOwn ? " (Claude's git\(e.move.commits.isEmpty ? "" : ": " + e.move.commits.joined(separator: ", ")))" : ""   // r1-git
            return "[info] head_moved turn \(e.turn): \(headLabel(e.move.from)) → \(headLabel(e.move.to))\(own)"
        case let .concurrentClaude(e):
            let list = e.sessions.map { session in
                "pid \(session.pid) \(session.name ?? "-") (\(session.entrypoint ?? "?"))"
            }.joined(separator: ", ")
            return "[info] concurrent_claude at \(e.at): \(list)"
        case let .localSettingsChanged(e):
            let c = e.change
            return "[warn] local_settings_changed turn \(e.turn): \(c.path) hooks=\(c.hooks) permissions=\(c.permissions) env=\(c.env) mcp=\(c.mcp)"
        case let .nestedChanges(e):
            let list = e.repos.map { repo in
                "\(repo.path) (\(repo.kind.rawValue), \(repo.touchedFiles.count) touched, dirty \(repo.dirtyFiles.map { String($0) } ?? "?"))"
            }
            return "[warn] nested_changes turn \(e.turn): " + list.joined(separator: "; ")
        default:
            return nil
        }
    }
}
