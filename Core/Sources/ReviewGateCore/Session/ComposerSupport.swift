import Foundation

/// A message the user queued while Claude was busy; sent in order once the session can take it (`AppState`).
public struct QueuedMessage: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var text: String
    /// §23 / §24: what goes out with the text.
    public var mentions: [String]
    public var images: [ComposerImage]
    // MARK: wave5 w5-model
    /// §43.4: this message only goes out on this model (the composer's "이번엔 opus"); nil = auto / the chip's model.
    public var model: String?

    public init(id: UUID = UUID(), text: String, mentions: [String] = [], images: [ComposerImage] = []) {
        self.id = id
        self.text = text
        self.mentions = mentions
        self.images = images
    }
}

/// ↑ / ↓ through the project's previous prompts from the composer's first / last line, like the terminal (wave6 w6-terminal,
/// §44.1: also with text typed — it comes back past the newest prompt); Esc goes back to what was typed before.
public struct PromptHistoryNavigator: Sendable, Equatable {
    /// Oldest first.
    public private(set) var entries: [String]
    /// Index into `entries` while browsing.
    public private(set) var index: Int?
    /// The draft typed before ↑: kept until it comes back (↓ past the newest prompt, Esc) or a prompt is sent.
    private var savedDraft = ""
    /// wave6 w6-terminal (§44.1): what was typed into recalled prompts, by index — kept while walking (as a shell keeps an
    /// edited history line), dropped by Esc and by a sent prompt.
    private var edits: [Int: String] = [:]

    public init(entries: [String]) {
        self.entries = entries
    }

    public var isBrowsing: Bool { index != nil }

    /// While browsing, the draft typed before ↑ (what a chat switch keeps, what an inserted text joins); nil otherwise.
    public var parkedDraft: String? { index == nil ? nil : savedDraft }

    private func shown(_ i: Int) -> String { edits[i] ?? entries[i] }

    /// The box no longer shows what this navigator put there: an edit of that recalled prompt, kept for the walk.
    private mutating func keepEdit(_ draft: String) {
        guard let index, draft != shown(index) else { return }
        edits[index] = draft
    }

    /// ↑ with the caret on the first line (an empty draft always is): the newest prompt — what was typed is kept for ↓ / Esc —
    /// or, while browsing, the one before (an edit of the shown one is kept). Elsewhere nil: the caret moves. Returns the new draft.
    public mutating func up(draft: String, caretOnFirstLine: Bool) -> String? {
        guard caretOnFirstLine || draft.isEmpty else { return nil }
        if let index {
            keepEdit(draft)
            guard index > 0 else { return nil }
            self.index = index - 1
            return shown(index - 1)
        }
        guard !entries.isEmpty else { return nil }
        savedDraft = draft
        index = entries.count - 1
        return shown(entries.count - 1)
    }

    /// ↓ with the caret on the last line, towards the newest; past it, back to the draft typed before browsing.
    public mutating func down(draft: String, caretOnLastLine: Bool) -> String? {
        guard let index, caretOnLastLine else { return nil }
        keepEdit(draft)
        if index + 1 < entries.count {
            self.index = index + 1
            return shown(index + 1)
        }
        self.index = nil
        return savedDraft
    }

    /// Esc while browsing: the draft before ↑ (edits of recalled prompts are dropped); nil when not browsing.
    public mutating func cancel() -> String? {
        guard index != nil else { return nil }
        index = nil
        edits = [:]
        return savedDraft
    }

    /// A prompt went out (or another history): everything starts over.
    public mutating func reset(entries: [String]) {
        self.entries = entries
        index = nil
        savedDraft = ""
        edits = [:]
    }

    /// Before ↑ from outside browsing: the latest prompts; the edits stay while the list is the same.
    public mutating func refresh(entries: [String]) {
        guard index == nil, entries != self.entries else { return }
        self.entries = entries
        edits = [:]
    }
}

public extension AppSettings {
    static let maxPromptHistory = 100

    /// Previous prompts of `root` (a `projectKey`), oldest first.
    static func promptHistory(root: String, defaults: UserDefaults = .standard) -> [String] {
        promptHistories(defaults: defaults)[root] ?? []
    }

    /// Appends `text` to the project's history (an immediate repeat is not stored twice; capped).
    static func appendPromptHistory(_ text: String, root: String, defaults: UserDefaults = .standard) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var all = promptHistories(defaults: defaults)
        var list = all[root] ?? []
        list.removeAll { $0 == trimmed }
        list.append(trimmed)
        if list.count > maxPromptHistory { list.removeFirst(list.count - maxPromptHistory) }
        all[root] = list
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.promptHistory) }
    }

    private static func promptHistories(defaults: UserDefaults) -> [String: [String]] {
        guard let data = defaults.data(forKey: Key.promptHistory) else { return [:] }
        return (try? JSONDecoder().decode([String: [String]].self, from: data)) ?? [:]
    }

    // MARK: Per-project Bash allow patterns ("Always allow in this project")

    /// Patterns saved from the permission card for `root`, in insertion order.
    static func projectBashAllowPatterns(root: String, defaults: UserDefaults = .standard) -> [String] {
        projectPatternTable(defaults: defaults)[root] ?? []
    }

    static func setProjectBashAllowPatterns(_ patterns: [String], root: String, defaults: UserDefaults = .standard) {
        var table = projectPatternTable(defaults: defaults)
        var seen = Set<String>()
        let cleaned = patterns.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
        table[root] = cleaned.isEmpty ? nil : cleaned
        if let data = try? JSONEncoder().encode(table) { defaults.set(data, forKey: Key.projectBashAllowPatterns) }
    }

    /// What the engine of a window on `root` runs with: the global list, then the project's own.
    static func effectiveBashAllowPatterns(root: String?, defaults: UserDefaults = .standard) -> [String] {
        let global = bashAllowPatterns(defaults: defaults)
        guard let root else { return global }
        var seen = Set(global)
        return global + projectBashAllowPatterns(root: root, defaults: defaults).filter { seen.insert($0).inserted }
    }

    private static func projectPatternTable(defaults: UserDefaults) -> [String: [String]] {
        guard let data = defaults.data(forKey: Key.projectBashAllowPatterns) else { return [:] }
        return (try? JSONDecoder().decode([String: [String]].self, from: data)) ?? [:]
    }

    // MARK: Notifications

    /// Unset → true.
    static func notificationsEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.notificationsEnabled) == nil ? true : defaults.bool(forKey: Key.notificationsEnabled)
    }

    /// Unset → true.
    static func notificationSound(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.notificationSound) == nil ? true : defaults.bool(forKey: Key.notificationSound)
    }
}

// MARK: - Transcript search (⌘F)

public enum TranscriptSearch {
    /// Row ids whose text contains `query` (case- and diacritic-insensitive), in display order: an agent group's call,
    /// its children, then its result.
    public static func matches(_ query: String, in nodes: [TranscriptNode]) -> [UUID] {
        matches(query, in: nodes, text: searchableText)
    }

    /// MARK: wave7 w7-chat — §45.1: `text` gives a row's searchable text (the chat passes the row as it is now and keeps a
    /// tool call's JSON between keystrokes, `TranscriptLookups.searchText`).
    public static func matches(_ query: String, in nodes: [TranscriptNode], text: (ChatItem) -> String?) -> [UUID] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        var out: [UUID] = []
        func contains(_ item: ChatItem) -> Bool {
            text(item)?.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
        func visit(_ node: TranscriptNode) {
            switch node {
            case let .row(item):
                if contains(item) { out.append(item.id) }
            case let .agentGroup(call, _, children, result):
                if contains(call) { out.append(call.id) }
                children.forEach(visit)
                if let result, contains(result) { out.append(result.id) }
            }
        }
        nodes.forEach(visit)
        return out
    }

    /// The text a row shows (or previews): messages, tool name + target + input, tool output preview, errors, plans.
    public static func searchableText(_ item: ChatItem) -> String? {
        switch item {
        case let .user(_, text, _): return text
        case let .assistant(_, text, _, _): return text
        case let .toolUse(_, _, name, file, input, _):
            return [name, file ?? "", input["command"]?.stringValue ?? input.prettyPrinted].joined(separator: "\n")
        case let .toolResult(_, _, _, preview, _): return preview
        case let .permission(_, request, _): return request.toolName + "\n" + (request.input["command"]?.stringValue ?? request.input.prettyPrinted)
        case let .error(_, message, _, info): return [message, info.secondary ?? ""].joined(separator: "\n")
        case let .plan(_, _, plan, _): return plan
        case let .peerMessage(_, message): return [message.senderName, message.body ?? ""].joined(separator: "\n")
        case let .autoTurn(_, _, info): return [BackgroundText.autoTurnTitle(info), BackgroundText.autoTurnDetail(info) ?? ""].joined(separator: "\n")
        case .budgetEvent, .turnEnd, .turnSummary: return nil
        }
    }

    /// Agent groups (tool_use ids, outermost first) that contain the row `rowID`; nil when the row is not in `nodes`.
    public static func enclosingGroups(ofRow rowID: UUID, in nodes: [TranscriptNode]) -> [String]? {
        for node in nodes {
            switch node {
            case let .row(item):
                if item.id == rowID { return [] }
            case let .agentGroup(call, id, children, result):
                if call.id == rowID { return [] }
                if result?.id == rowID { return [id] }   // the result shows inside the expanded group
                if let inner = enclosingGroups(ofRow: rowID, in: children) { return [id] + inner }
            }
        }
        return nil
    }
}
