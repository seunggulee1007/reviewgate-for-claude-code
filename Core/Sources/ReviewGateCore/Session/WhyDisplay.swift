import Foundation

// wave2 mac-diff — "why" on screen (docs/PROTOCOL.md §34.8–34.9; audit comp-01, agents-03, comp-05, comp-09). The engine's
// `FileWhy` says where a reason comes from; the diff header and the turn summary card show that source instead of
// presenting every sentence as the reason: the turn-end report first, the call's own message next, an earlier sentence
// dimmed as "앞선 설명", and "원인 기록 없음" rather than a made-up one. A subagent's own reason comes before the main
// agent's delegation sentence, and a sentence several files share is shown once.

/// One file's reason as the UI draws it.
public struct WhyLine: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        /// The turn-end report names the file ("Claude 보고").
        case reported
        /// The text right before the call (its own API message), or an unknown source shown plainly.
        case direct
        /// The same agent's earlier text ("앞선 설명: …", dimmed).
        case earlier
        /// Nothing explains it ("원인 기록 없음"); not named `none` so `line?.source == .none` can never mean nil.
        case noRecord
    }

    /// nil for `.noRecord`.
    public var text: String?
    public var source: Source
    /// `.earlier`: the agent's tool calls between the text and the change.
    public var age: Int?
    /// The text is a subagent's: its type (or "Subagent").
    public var agent: String?
    /// The change ran inside a subagent: the main agent's sentence before the Agent call ("위임 이유: …").
    public var delegation: String?
    /// The call the reason belongs to (§21 "Why?" anchors, reveal in the chat).
    public var toolUseId: String?

    public init(text: String?, source: Source, age: Int? = nil, agent: String? = nil, delegation: String? = nil, toolUseId: String? = nil) {
        self.text = text
        self.source = source
        self.age = age
        self.agent = agent
        self.delegation = delegation
        self.toolUseId = toolUseId
    }

    /// `text` on one line (whitespace collapsed), at most `limit` characters.
    public func oneLine(limit: Int = 140) -> String? { TurnSummary.oneLine(text, limit: limit) }
}

public enum WhyDisplay {
    /// The engine's `FileWhy` (§34.8) as a line; nil without one.
    public static func line(_ why: FileWhy?) -> WhyLine? {
        guard let why else { return nil }
        let text = why.text.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let source: WhyLine.Source
        switch why.source {
        case _ where text == nil: source = .noRecord
        case .reported: source = .reported
        case .earlier: source = .earlier
        case .noRecord: source = .noRecord
        case .sameMessage, .other: source = .direct
        }
        let agent = why.agent.map { $0.subagentType.flatMap { $0.isEmpty ? nil : $0 } ?? WhyText.subagent }
        let delegation = why.delegation.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        return WhyLine(text: source == .noRecord ? nil : text, source: source, age: source == .earlier ? why.age : nil,
                       agent: agent, delegation: delegation, toolUseId: why.toolUseId)
    }

    /// A turn summary file: its `whyDetail` (§34); else the older `why` text as before; else — when nothing of Claude's
    /// touched it (no tools, comp-05) — "원인 기록 없음". An external file has its own badge and no line.
    public static func line(for file: TurnSummary.File) -> WhyLine? {
        if let detail = line(file.whyDetail) { return detail }
        if let why = file.why, !why.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return WhyLine(text: why, source: .direct, toolUseId: file.whyToolUseId)
        }
        if file.tools.isEmpty, file.toolUseIds.isEmpty, file.origin != .external { return WhyLine(text: nil, source: .noRecord) }
        return nil
    }

    /// A changed file of the review: the engine's `FileWhy` only (the diff header lists the touching calls itself).
    public static func line(for file: ChangedFile) -> WhyLine? { line(file.why) }

    /// The diff header gives the file's reason a line of its own above the calls unless a listed call already shows it
    /// as its own sentence: the turn-end report, an earlier turn's call, a delegation without text of the subagent's.
    public static func showsAbove(_ why: WhyLine, causes: [ChangeCause]) -> Bool {
        switch why.source {
        case .reported: return true
        case .noRecord: return why.delegation != nil
        case .direct, .earlier:
            guard let id = why.toolUseId else { return true }
            return !causes.contains { $0.toolUseId == id && $0.rationale != nil }
        }
    }

    /// A sentence two or more files of one card share (§34.8: "shown once at the card's top").
    public struct Shared: Equatable, Sendable, Identifiable {
        public var id: String { key }
        public var key: String
        /// The strongest source among the files that share it (reported > direct > earlier).
        public var line: WhyLine
        public var paths: [String]
    }

    /// The shared sentences of `files`, in the order they first appear; "no record" is never grouped.
    public static func shared(_ files: [TurnSummary.File]) -> [Shared] {
        var order: [String] = []
        var groups: [String: Shared] = [:]
        for file in files {
            guard var line = line(for: file), line.source != .noRecord, let text = line.text else { continue }
            let k = key(text)
            line.text = k   // the card shows the sentence once, whitespace collapsed
            if var group = groups[k] {
                group.paths.append(file.path)
                if rank(line.source) < rank(group.line.source) { group.line = line }
                groups[k] = group
            } else {
                order.append(k)
                groups[k] = Shared(key: k, line: line, paths: [file.path])
            }
        }
        return order.compactMap { groups[$0] }.filter { $0.paths.count >= 2 }
    }

    public static func isShared(_ path: String, in shared: [Shared]) -> Bool { shared.contains { $0.paths.contains(path) } }

    /// The text two lines are compared by: whitespace runs collapsed, trimmed.
    static func key(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static func rank(_ source: WhyLine.Source) -> Int {
        switch source {
        case .reported: 0
        case .direct: 1
        case .earlier: 2
        case .noRecord: 3
        }
    }
}

/// The wording of the "why" lines (the same English keys as the Electron client, Korean in the catalog).
public enum WhyText {
    /// An earlier sentence of the same agent, not the call's own.
    public static func earlier(_ text: String) -> String { String(localized: "Earlier note: \(text)", bundle: .module) }
    /// How far back that sentence was written.
    public static func callsEarlier(_ count: Int) -> String { String(localized: "\(count) calls earlier", bundle: .module) }
    /// The main agent's sentence before it delegated the change to a subagent.
    public static func delegated(_ text: String) -> String { String(localized: "Delegated: \(text)", bundle: .module) }
    public static var noRecord: String { String(localized: "No recorded reason", bundle: .module) }
    /// The turn-end report named the file.
    public static var reported: String { String(localized: "Reported by Claude", bundle: .module) }
    public static var subagent: String { String(localized: "Subagent", bundle: .module) }
}

/// The turn summary's test line (§34.9): the turn's last test run against its last edit.
public enum TestVerdictLine: Equatable, Sendable {
    /// "테스트 통과 · 마지막 편집 뒤 실행".
    case passedAfterEdit
    /// "테스트 실패" (the last run, after the last edit).
    case failed
    /// "편집 뒤 테스트 없음": files changed after the last run — whatever it said, the final code was not tested.
    case noTestAfterEdit
    // MARK: wave3 check-clients
    /// "편집 뒤 테스트 없음" in grey: no test command ran this turn (`lastTest: null`; `init(_:reported:)`), as in Electron.
    case noTestRun

    /// nil when no test ran (or an older engine sent no `lastTest`) or the verdict is unknown.
    public init?(_ lastTest: LastTest?) {
        guard let lastTest else { return nil }
        // wave3 check-clients: a verdict this client does not know says nothing, either way (Electron's testVerdict).
        guard lastTest.verdict != nil else { return nil }
        if !lastTest.afterLastEdit {
            self = .noTestAfterEdit
            return
        }
        switch lastTest.verdict {
        case .pass: self = .passedAfterEdit
        case .fail: self = .failed
        case nil: return nil
        }
    }

    public var text: String {
        switch self {
        case .passedAfterEdit: String(localized: "Tests passed · ran after the last edit", bundle: .module)
        case .failed: String(localized: "Tests failed", bundle: .module)
        case .noTestAfterEdit, .noTestRun: String(localized: "No tests after the last edit", bundle: .module)
        }
    }
}
