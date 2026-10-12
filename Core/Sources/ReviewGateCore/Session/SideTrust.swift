import Foundation

// MARK: wave4b w4b-side — docs/PROTOCOL.md §40.3 side questions you can trust (audit SME-06/07/08/12/13)
//
// The pure part of the Mac client, unit-tested in Core/Tests (SideTrustTests): the web setting, a thread's fork point and
// [최신 대화로 다시 묻기], a passage of Claude's answer as an anchor, the warning before a chat switch cuts running answers,
// the side model choices. Same rules and keys as Electron (clients/desktop/src/renderer/sideTrust.ts).

/// §40.3 `settings.sideWeb`: no web (the default), only the sites the user's Claude Code rules allow, or any site.
public enum SideWebMode: String, CaseIterable, Sendable, Equatable, Identifiable {
    case off, rules, on
    public var id: String { rawValue }

    /// Absent / unknown → off (an old `sideAllowWeb` true was only the default; it no longer turns the web on).
    public init(stored: String?) { self = stored.flatMap(SideWebMode.init(rawValue:)) ?? .off }

    public var label: String {
        switch self {
        case .off: String(localized: "Off", bundle: .module)
        case .rules: String(localized: "Only sites my Claude Code rules allow", bundle: .module)
        case .on: String(localized: "Any site", bundle: .module)
        }
    }

    /// The line under the picker: what the choice lets a side question do.
    public var help: String {
        switch self {
        case .off: String(localized: "Side questions answer from the code and the conversation only.", bundle: .module)
        case .rules: String(localized: "Only the WebFetch(domain:…) / WebSearch rules you allowed in Claude Code. Code you read can still leave in a request to those sites.", bundle: .module)
        case .on: String(localized: "Code a side question read can leave your computer: a page it opens may carry it in the address.", bundle: .module)
        }
    }
}

extension AppSettings.Key {
    /// §40.3: `SideWebMode` raw value (unset → off).
    public static let sideWeb = "sideWeb"
}

extension AppSettings {
    public static func sideWeb(defaults: UserDefaults = .standard) -> SideWebMode {
        SideWebMode(stored: defaults.string(forKey: Key.sideWeb))
    }
}

/// §40.3 `SideAnchor.quote`: a passage of Claude's answer and the main turn it is from.
public struct SideQuoteAnchor: Codable, Sendable, Hashable {
    public var text: String
    public var turn: Int?

    public init(text: String, turn: Int? = nil) {
        self.text = text
        self.turn = turn
    }

    private enum CodingKeys: String, CodingKey { case text, turn }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        turn = (try? c.decodeIfPresent(Int.self, forKey: .turn)).flatMap { $0 > 0 ? $0 : nil }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        if let turn { try c.encode(turn, forKey: .turn) } else { try c.encodeNil(forKey: .turn) }
    }
}

extension SideAnchor {
    private enum QuoteKeys: String, CodingKey { case quote }

    /// A side question about a passage of Claude's answer (the other fields stay empty: the engine ignores them then).
    public init(quote: SideQuoteAnchor) {
        self.init()
        self.quote = quote
    }

    /// Called at the end of `init(from:)`.
    mutating func decodeQuoteField(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: QuoteKeys.self) else { return }
        quote = (try? c.decodeIfPresent(SideQuoteAnchor.self, forKey: .quote)).flatMap { $0.text.isEmpty ? nil : $0 }
    }

    /// Called at the end of `encode(to:)`.
    func encodeQuoteField(to encoder: Encoder) throws {
        guard let quote else { return }
        var c = encoder.container(keyedBy: QuoteKeys.self)
        try c.encode(quote, forKey: .quote)
    }
}

public enum SideTrust {
    /// §40.3: a quoted passage is cut here (the engine cuts at the same length).
    public static let quoteMax = 2000

    /// "턴 N 시점": the last main turn the thread's side session knows; nil when it started without one.
    public static func forkPointLabel(_ thread: SideThread?) -> String? {
        guard let n = thread?.fork?.atTurn, n > 0 else { return nil }
        return String(localized: "As of turn \(n)", bundle: .module)
    }

    /// The main conversation went on since the fork (`turnCount`: `hud.turnCount`).
    public static func forkIsBehind(_ thread: SideThread?, turnCount: Int?) -> Bool {
        guard let n = thread?.fork?.atTurn, let turnCount else { return false }
        return turnCount > n
    }

    /// What [최신 대화로 다시 묻기] asks: the text being typed, else the thread's last question; nil when there is none.
    public static func reforkQuestion(_ thread: SideThread?, typed: String) -> String? {
        let q = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { return q }
        return thread?.messages.last(where: { $0.role == .user && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
            .text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "곁질문으로 묻기" on Claude's answer: `SideAnchor(quote:)`, trimmed and cut; nil for blank text.
    public static func quoteAnchor(_ text: String, turn: Int?) -> SideAnchor? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let cut = trimmed.count > quoteMax ? String(trimmed.prefix(quoteMax - 1)) + "…" : trimmed
        return SideAnchor(quote: SideQuoteAnchor(text: cut, turn: turn.flatMap { $0 > 0 ? $0 : nil }))
    }

    /// The turn of the row at `position`: the nearest user message at or before it that knows its turn (nil: none).
    public static func turnBefore(_ items: [ChatItem], position: Int?) -> Int? {
        guard let position, position >= 0, position < items.count else { return nil }
        for i in stride(from: position, through: 0, by: -1) {
            if case let .user(_, _, meta) = items[i], meta.turn > 0 { return meta.turn }
        }
        return nil
    }

    /// The anchor chip of a quote: `인용 · 턴 4`.
    public static func quoteLabel(_ quote: SideQuoteAnchor) -> String {
        if let turn = quote.turn { return String(localized: "Quote · turn \(turn)", bundle: .module) }
        return String(localized: "Quote", bundle: .module)
    }

    /// The thread head line of a quote: `“first words…” · 턴 4`.
    public static func quoteTitle(_ quote: SideQuoteAnchor) -> String {
        let one = quote.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let head = one.count > 80 ? String(one.prefix(79)) + "…" : one
        if let turn = quote.turn { return "“\(head)” · " + String(localized: "turn \(turn)", bundle: .module) }
        return "“\(head)”"
    }

    /// The draft sheet's line when the summary failed: the user writes the conclusion (`reason`: the refusal in words).
    public static func draftFailedText(_ reason: String) -> String {
        String(localized: "The summary failed — write the conclusion yourself. (\(reason))", bundle: .module)
    }

    /// Before a chat switch: running side answers would be cut — the confirm text, or nil when none runs.
    public static func switchWarning(runningCount: Int) -> String? {
        guard runningCount > 0 else { return nil }
        return String(localized: "A side question is still answering (\(runningCount)). Switching chats stops it — switch anyway?", bundle: .module)
    }

    public struct ModelChoice: Sendable, Equatable, Identifiable {
        public var value: String
        public var label: String
        public var id: String { value }
    }

    /// The side model picker: "same as main" first, the session's models, and a stored value the list does not have.
    public static func modelChoices(_ models: [ModelOption], current: String?) -> [ModelChoice] {
        var out = [ModelChoice(value: "", label: String(localized: "Same as the main conversation", bundle: .module))]
        for m in models where !m.value.isEmpty && !out.contains(where: { $0.value == m.value }) {
            out.append(ModelChoice(value: m.value, label: m.displayName.isEmpty ? m.value : m.displayName))
        }
        let cur = (current ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !cur.isEmpty, !out.contains(where: { $0.value == cur }) { out.append(ModelChoice(value: cur, label: cur)) }
        return out
    }
}
