import Foundation

// MARK: §70.1 — docs/PROTOCOL.md §70.1: ⌃R in the message box searches this project's prompt history, as Ctrl+R does in
// Claude Code: type to filter, ⌃R again (or ↑) for the next older match, ↓ back to a newer one, ↩ or ⇥ puts the match into
// the box (never sends), esc (or ⌫ in an empty search) gives the draft back. The composer shows the search over the box.

/// One ⌃R search over the prompt history (pure: the composer holds it while the search is open).
public struct PromptHistorySearch: Sendable, Equatable {
    /// The project's prompts, oldest first (`AppState.promptHistory`).
    public let entries: [String]
    /// What the box held before ⌃R — what esc gives back.
    public let original: String
    /// What is typed into the search.
    public private(set) var query = ""
    /// How many newer matches were stepped over (0: the newest match).
    public private(set) var skip = 0

    public init(entries: [String], original: String) {
        self.entries = entries
        self.original = original
    }

    /// The entries containing `query` (case-insensitive), newest first; none while nothing is typed.
    public var matches: [Int] {
        let q = query
        guard !q.isEmpty else { return [] }
        return entries.indices.reversed().filter { entries[$0].range(of: q, options: [.caseInsensitive]) != nil }
    }

    /// The match on show; nil while nothing is typed or nothing matches.
    public var match: String? {
        let list = matches
        guard !list.isEmpty else { return nil }
        return entries[list[min(skip, list.count - 1)]]
    }

    /// Something is typed and no prompt has it (the terminal's "failing" search).
    public var failing: Bool { !query.isEmpty && matches.isEmpty }

    /// "2 of 5": the match's place among the matches (1 = the newest); nil without one.
    public var position: (index: Int, count: Int)? {
        let count = matches.count
        return count == 0 ? nil : (min(skip, count - 1) + 1, count)
    }

    /// The search text changed: back to its newest match.
    public mutating func setQuery(_ text: String) {
        guard text != query else { return }
        query = text
        skip = 0
    }

    /// ⌃R again / ↑: the next older match; false at the oldest.
    @discardableResult
    public mutating func older() -> Bool {
        guard skip + 1 < matches.count else { return false }
        skip += 1
        return true
    }

    /// ↓: the next newer match; false at the newest.
    @discardableResult
    public mutating func newer() -> Bool {
        guard skip > 0 else { return false }
        skip -= 1
        return true
    }

    /// ↩ / ⇥: what the box gets — the match, or the draft as it was when nothing matched.
    public var accepted: String { match ?? original }

    /// Where `query` is in `text` (the first place, case-insensitive) — the part the search bar highlights.
    public static func highlight(in text: String, query: String) -> Range<String.Index>? {
        guard !query.isEmpty else { return nil }
        return text.range(of: query, options: [.caseInsensitive])
    }
}

/// §70.1: the search bar's words.
public enum PromptHistorySearchText {
    /// The search field's placeholder.
    public static var placeholder: String { String(localized: "Search your prompts", bundle: .module) }
    /// Its accessibility label and the bar's tooltip.
    public static var label: String { String(localized: "Prompt history search", bundle: .module) }
    public static var noMatch: String { String(localized: "No prompt matches", bundle: .module) }
    public static var empty: String { String(localized: "No prompts in this project yet", bundle: .module) }
    public static var typeToSearch: String { String(localized: "Type to search the prompts sent in this project", bundle: .module) }
    /// "2 / 5".
    public static func position(_ index: Int, of count: Int) -> String { "\(index) / \(count)" }
    /// The key hint at the bar's end (Mac keys).
    public static var hint: String { String(localized: "⌃R older · ↩ or ⇥ use · esc cancel", bundle: .module) }
    /// The bar's tooltip.
    public static var help: String {
        String(localized: "Searches the prompts sent in this project, newest first: ⌃R or ↑ for an older match, ↓ for a newer one, ↩ or ⇥ puts it into the message box, esc gives your draft back", bundle: .module)
    }
}
