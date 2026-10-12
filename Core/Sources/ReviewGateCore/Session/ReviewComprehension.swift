import Foundation

// Testable view logic for the turn summary card, review history, hunk-level reject and the applied-extensions view
// (docs/PROTOCOL.md §14–17).

// MARK: - Turn summary (§15)

public extension TurnSummary.File {
    /// The file as a `ChangedFile`, so the risk badges and ordering of the review list apply to it.
    var asChangedFile: ChangedFile {
        var file = ChangedFile(path: path, oldPath: nil, status: status, added: adds, deleted: dels, isBinary: false,
                               tools: tools, toolUseIds: toolUseIds, state: state)
        file.origin = origin   // wave1 mac-review: §31 — "Bash" / "outside the app" come from the origin
        file.engineRisks = engineRisks   // MARK: wave4b w4b-files — §40.2: the engine's badges, as in the list
        file.riskScore = riskScore
        return file
    }

    var risks: [FileRisk] { FileRisk.risks(for: asChangedFile) }

    /// `why` as one line for the row: the first non-empty line, whitespace collapsed, cut at `limit` characters.
    func whyLine(limit: Int = 140) -> String? {
        TurnSummary.oneLine(why, limit: limit)
    }
}

public extension TurnSummary {
    var totalAdds: Int { files.reduce(0) { $0 + $1.adds } }
    var totalDels: Int { files.reduce(0) { $0 + $1.dels } }
    /// Commands a test runner recognized as passing / failing.
    var testsPassed: Int { commands.filter { $0.testOutcome == .pass }.count }
    var testsFailed: Int { commands.filter { $0.testOutcome == .fail }.count }
    /// Non-test commands that ended in an error.
    var failedCommands: Int { commands.filter { $0.testOutcome == nil && $0.isError }.count }

    /// First non-empty line of `text`, internal whitespace collapsed, at most `limit` characters ("…" when cut).
    static func oneLine(_ text: String?, limit: Int = 140) -> String? {
        guard let text else { return nil }
        guard let line = text.split(whereSeparator: \.isNewline).lazy
            .map({ $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") })
            .first(where: { !$0.isEmpty }) else { return nil }
        guard line.count > limit else { return line }
        return String(line.prefix(max(1, limit - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }
}

public extension TurnSummary.Plan {
    /// Steps at least one changed file maps to.
    var matchedStepCount: Int { steps.filter { !$0.files.isEmpty }.count }
    func isUnplanned(_ path: String) -> Bool { unplannedFiles.contains(path) }
    /// The plan file's name for the card header (nil for an ExitPlanMode-only plan).
    var fileName: String? { path.map { ($0 as NSString).lastPathComponent } }
}

public extension TurnSummary.Command {
    /// The first line of the command, for a one-row display.
    var firstLine: String { command.split(whereSeparator: \.isNewline).first.map(String.init) ?? command }
}

// MARK: - Hunk-level reject (§17)

/// A `reject_hunks` refusal, localized, with what the UI should offer next.
public struct HunkRefusal: Sendable, Equatable {
    public enum Remedy: Sendable, Equatable {
        /// Re-diff the review (`refresh{scope:["review"]}`) and try again.
        case refresh
        /// Hunk reject cannot apply to this file: reject the whole file instead.
        case rejectWholeFile
        case none
    }

    public var code: String
    public var message: String
    public var remedy: Remedy

    public init(code: String, message: String, remedy: Remedy) {
        self.code = code
        self.message = message
        self.remedy = remedy
    }

    /// The engine's refusal codes (`code` or `code:<detail>`), localized; unknown codes pass through.
    public static func from(_ raw: String) -> HunkRefusal {
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        let code = parts.first ?? raw
        let detail = parts.count > 1 ? parts[1] : ""
        switch code {
        case "session_running", "session_busy":
            return HunkRefusal(code: code, message: String(localized: "Claude is working — wait for the turn to finish", bundle: .module), remedy: .none)
        case "reverting":
            return HunkRefusal(code: code, message: String(localized: "Another revert is in progress — try again in a moment", bundle: .module), remedy: .none)
        case "no_review":
            return HunkRefusal(code: code, message: String(localized: "There is no review to revert from", bundle: .module), remedy: .none)
        case "stale_diff":
            return HunkRefusal(code: code, message: String(localized: "The diff changed since you looked at it — refresh and pick the parts again", bundle: .module),
                               remedy: .refresh)
        case "file_changed_since_review":
            return HunkRefusal(code: code, message: String(localized: "The file was edited after the review started, so nothing was reverted (your edit is kept). Refresh to review the current content.", bundle: .module),
                               remedy: .refresh)
        case "binary_file":
            return HunkRefusal(code: code, message: String(localized: "Binary files cannot be reverted part by part — reject the whole file instead", bundle: .module),
                               remedy: .rejectWholeFile)
        case "partial_reject_unsupported":
            let message: String
            switch detail {
            case "A": message = String(localized: "An added file cannot be reverted part by part — reject the whole file instead", bundle: .module)
            case "D": message = String(localized: "A deleted file cannot be reverted part by part — reject the whole file instead", bundle: .module)
            case "symlink": message = String(localized: "A symbolic link cannot be reverted part by part — reject the whole file instead", bundle: .module)
            case "submodule": message = String(localized: "A submodule cannot be reverted part by part — reject the whole file instead", bundle: .module)
            case "mode": message = String(localized: "Only the file mode changed — reject the whole file to revert it", bundle: .module)
            // wave1 mac-review — §32: a stub in the snapshot; nothing of it can be put back, whole or in part.
            case "uncaptured": return HunkRefusal(code: code, message: ReviewProvenanceText.uncaptured, remedy: .none)
            default: message = String(localized: "A renamed or copied file cannot be reverted part by part — reject the whole file instead", bundle: .module)
            }
            return HunkRefusal(code: code, message: message, remedy: .rejectWholeFile)
        case "not_pending":
            return HunkRefusal(code: code, message: String(localized: "Only files still pending review can be reverted part by part", bundle: .module), remedy: .none)
        case "not_a_changed_file":
            return HunkRefusal(code: code, message: String(localized: "This file is no longer in the review", bundle: .module), remedy: .refresh)
        case "no_hunks":
            return HunkRefusal(code: code, message: String(localized: "Select at least one part to revert", bundle: .module), remedy: .none)
        case "unknown_hunk", "diff_mismatch":
            return HunkRefusal(code: code, message: String(localized: "The selected parts no longer match the file — refresh and try again", bundle: .module),
                               remedy: .refresh)
        default:
            return HunkRefusal(code: code, message: EngineMessages.refusal(error: raw), remedy: .none)
        }
    }
}

public extension ChangedFile {
    /// `reject_hunks` can apply: a pending, modified, text file (added / deleted / renamed / binary need the whole-file reject)
    /// whose content was captured (§32: an uncaptured file cannot be reverted at all).
    var supportsHunkReject: Bool { state == .pending && status == .modified && !isBinary && !uncaptured }
}

// MARK: - Review history (§14)

/// The history file whose diff the diff pane shows read-only.
public struct HistorySelection: Sendable, Hashable {
    public var entryId: String
    public var path: String

    public init(entryId: String, path: String) {
        self.entryId = entryId
        self.path = path
    }
}

public enum ReviewHistoryText {
    /// `history_diff` refusals, localized; unknown codes pass through.
    public static func refusal(_ raw: String) -> String {
        switch raw.split(separator: ":", maxSplits: 1).first.map(String.init) ?? raw {
        case "unknown_history_entry": String(localized: "This review is no longer in the history", bundle: .module)
        case "not_in_history_entry": String(localized: "This file is not part of that review", bundle: .module)
        case "history_trees_gone": String(localized: "The snapshots of this review were pruned; its diff cannot be shown", bundle: .module)
        case "no_project": String(localized: "Open a project first (⌘O)", bundle: .module)
        default: EngineMessages.refusal(error: raw)
        }
    }
}

// MARK: - Applied extensions (§16)

public enum ExtensionSettingsLogic {
    /// The plugin is turned off by `settings.disabledPlugins` (by id or by bare name).
    public static func isDisabled(_ plugin: ExtensionPlugin, in disabled: [String]) -> Bool {
        disabled.contains(plugin.key) || disabled.contains(plugin.name)
    }

    /// `disabled` with the plugin switched on (both its id and bare name removed) or off (its id appended).
    public static func setting(_ disabled: [String], plugin: ExtensionPlugin, enabled: Bool) -> [String] {
        var out = disabled.filter { $0 != plugin.key && $0 != plugin.name }
        if !enabled { out.append(plugin.key) }
        return out
    }

    /// What the settings would make the engine disable: entries with `@` as they are, bare names resolved through
    /// the plugins the session knows (else left bare — the engine reports those as unresolved).
    public static func resolved(_ disabled: [String], plugins: [ExtensionPlugin]) -> Set<String> {
        Set(disabled.map { entry in
            guard !entry.contains("@") else { return entry }
            return plugins.first { $0.name == entry }?.id ?? entry
        })
    }

    /// The settings differ from what the running session applied: they take effect after `restart_session`.
    public static func needsRestart(applied: SessionExtensions?, disabledPlugins: [String], disableUserHooks: Bool) -> Bool {
        guard let applied else { return false }
        if applied.userHooksDisabled != disableUserHooks { return true }
        let now = Set(applied.disabledPlugins).union(applied.unresolvedDisabledPlugins)
        return resolved(disabledPlugins, plugins: applied.plugins) != now
    }

    /// Hook sources grouped user → project → plugin, empty groups left out.
    public static func hookGroups(_ hooks: [ExtensionHook]) -> [(source: ExtensionHook.Source, hooks: [ExtensionHook])] {
        ExtensionHook.Source.allCases.compactMap { source in
            let group = hooks.filter { $0.source == source }
            return group.isEmpty ? nil : (source, group)
        }
    }

    /// MCP status → traffic light: connected, a problem, or still starting / unknown.
    public enum ServerHealth: Sendable, Equatable { case ok, problem, pending }

    public static func health(_ status: String) -> ServerHealth {
        switch status.lowercased() {
        case "connected": .ok
        case "failed", "needs-auth", "error", "disabled": .problem
        default: .pending
        }
    }
}
