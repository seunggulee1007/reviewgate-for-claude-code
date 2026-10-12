import Foundation
import SwiftUI

// wave2 mac-diff — one diff line on screen (docs/PROTOCOL.md §34.7; audit comp-07, market-06, comp-19): the changed parts
// of a paired line marked inside it (`DiffLine.segments`, UTF-16 offsets), the render cap and its tooltip, display
// columns for the rows' shared horizontal scroll, find-in-diff matches and the copy texts. Shared by the review diff,
// the full file, PR and history diffs and the chat's mini diffs, so every one of them draws a line the same way.

public enum DiffLineText {
    /// UTF-16 units of a line that are drawn; the rest is cut ("…" and a tooltip). The engine's segment limit (§34.7:
    /// none on lines over 2 000 units), so every segment of a drawn line is drawn.
    public static let renderLimit = 2_000
    /// Characters a tooltip shows.
    public static let tooltipLimit = 4_000
    /// A tab's width in columns.
    public static let tabColumns = 4

    /// The drawn part of a line.
    public struct Shown: Equatable, Sendable {
        public var text: String
        /// Longer than `renderLimit`: `text` is its start.
        public var cut: Bool
    }

    /// At most `renderLimit` UTF-16 units of `text`, cut on a character boundary.
    public static func shown(_ text: String) -> Shown {
        guard text.utf8.count > renderLimit, text.utf16.count > renderLimit else { return Shown(text: text, cut: false) }
        var units = 0
        var end = text.startIndex
        for ch in text {
            let n = ch.utf16.count
            if units + n > renderLimit { break }
            units += n
            end = text.index(after: end)
        }
        return Shown(text: String(text[..<end]), cut: true)
    }

    /// The tooltip of a line too long to see whole (cut, or wider than the pane with wrapping off).
    public static func tooltip(_ text: String) -> String {
        text.count > tooltipLimit ? String(text.prefix(tooltipLimit)) + "…" : text
    }

    /// The line's segments as ranges of `shown` (its drawn text): ranges past the end, not on a code point boundary or of
    /// another text are dropped.
    public static func segmentRanges(_ line: DiffLine, in shown: String) -> [Range<String.Index>] {
        guard !line.segments.isEmpty else { return [] }
        let scalars = shown.unicodeScalars
        return line.segments.compactMap { segment in
            guard segment.end > segment.start, let range = segment.range(in: shown),
                  range.lowerBound.samePosition(in: scalars) != nil, range.upperBound.samePosition(in: scalars) != nil else { return nil }
            return range
        }
    }

    /// The text a row draws: `base` (the highlighter's colours, when it is for this very text) else plain, with the changed
    /// parts on `emphasis` and the find matches on `findColor` (black text, like the chat's find).
    public static func styled(_ line: DiffLine, base: AttributedString?, emphasis: Color?, find: [Range<String.Index>],
                              findColor: Color?) -> AttributedString {
        let shown = shown(line.text)
        var out = AttributedString(shown.text)
        if let base, String(base.characters) == line.text {
            if !shown.cut {
                out = base
            } else if let r = Range<AttributedString.Index>(line.text.startIndex..<line.text.index(line.text.startIndex, offsetBy: shown.text.count), in: base) {
                out = AttributedString(base[r])
            }
        }
        if let emphasis {
            for range in segmentRanges(line, in: shown.text) {
                if let r = Range<AttributedString.Index>(range, in: out) { out[r].swiftUI.backgroundColor = emphasis }
            }
        }
        if let findColor {
            for range in find where range.upperBound <= shown.text.endIndex {
                if let r = Range<AttributedString.Index>(range, in: out) {
                    out[r].swiftUI.backgroundColor = findColor
                    out[r].swiftUI.foregroundColor = .black
                }
            }
        }
        return out
    }

    // MARK: Columns

    /// Display columns of `text` for the horizontal scroll extent: a tab counts `tabColumns`, a character of three or
    /// four UTF-8 bytes (Hangul, CJK, emoji — the wide ones) two, anything else one. Never under the drawn width of a
    /// monospaced line, at the price of counting a few narrow symbols as wide.
    public static func columns(_ text: String) -> Int {
        var text = text
        return text.withUTF8 { bytes in
            var n = 0
            for b in bytes {
                switch b {
                case 0x09: n += tabColumns
                case 0x00..<0x80: n += 1
                case 0xC0..<0xE0: n += 1
                case 0xE0...: n += 2
                default: break   // a continuation byte
                }
            }
            return n
        }
    }

    /// The widest drawn line of `texts`.
    public static func maxColumns(_ texts: some Sequence<String>) -> Int {
        var best = 0
        for text in texts {
            let drawn = text.utf8.count > renderLimit ? shown(text).text : text
            // A line cannot need more columns than four per UTF-8 byte (tabs); skip the count when it cannot win.
            if drawn.utf8.count * tabColumns <= best { continue }
            best = max(best, columns(drawn))
        }
        return best
    }

    // MARK: Copy (comp-19)

    /// "Copy line": the line's text.
    public static func copyLine(_ line: DiffLine) -> String { line.text }

    /// "Copy path:line": `path:<number>` — the new number, or the old one for a deleted line; nil for a hunk header.
    public static func copyLocation(_ line: DiffLine, path: String) -> String? {
        guard line.kind != .hunkHeader, let n = line.kind == .del ? line.oldNo : (line.newNo ?? line.oldNo) else { return nil }
        return "\(path):\(n)"
    }
}

// MARK: - Find in diff

public enum DiffFind {
    /// A searchable row: its key (`DiffDisplayItem.key`, "F<n>" in the full file) and its text.
    public struct Row: Sendable, Equatable {
        public var key: String
        public var text: String

        public init(key: String, text: String) {
            self.key = key
            self.text = text
        }
    }

    /// The query as searched: trimmed; empty = no search.
    public static func normalized(_ query: String) -> String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Every occurrence of `query` in `text`, ignoring case (code is searched as written: no diacritic folding, so the
    /// rows found and the parts marked in them always agree).
    public static func ranges(of query: String, in text: String) -> [Range<String.Index>] {
        let q = normalized(query)
        guard !q.isEmpty else { return [] }
        var out: [Range<String.Index>] = []
        var start = text.startIndex
        while start < text.endIndex, let r = text.range(of: q, options: [.caseInsensitive], range: start..<text.endIndex) {
            out.append(r)
            start = r.upperBound > r.lowerBound ? r.upperBound : text.index(after: r.lowerBound)
        }
        return out
    }

    /// The keys of the rows that contain `query`, in order. An ASCII query (identifiers, almost always) is matched on the
    /// UTF-8 bytes — Foundation's search bridges every line to UTF-16 first, ~0.6 s for 20 000 long lines in a debug
    /// build (DiffPerformanceTests).
    public static func matches(query: String, in rows: [Row]) -> [String] {
        let q = normalized(query)
        guard !q.isEmpty else { return [] }
        if q.utf8.allSatisfy({ $0 < 0x80 }) {
            let needle = q.utf8.map(lowerASCII)
            return rows.compactMap { containsASCII($0.text, needle) ? $0.key : nil }
        }
        return rows.compactMap { $0.text.range(of: q, options: [.caseInsensitive]) != nil ? $0.key : nil }
    }

    /// The display column the first match of `query` starts at in `text` (`DiffLineText.columns` of what precedes it), so
    /// a list that does not wrap can scroll sideways to it; nil without a match.
    public static func column(of query: String, in text: String) -> Int? {
        guard let first = ranges(of: query, in: text).first else { return nil }
        return DiffLineText.columns(String(text[..<first.lowerBound]))
    }

    @inline(__always) static func lowerASCII(_ b: UInt8) -> UInt8 { b >= 0x41 && b <= 0x5A ? b | 0x20 : b }

    /// `text` contains the lowercased ASCII `needle`, ASCII letters compared without case.
    static func containsASCII(_ text: String, _ needle: [UInt8]) -> Bool {
        guard let first = needle.first else { return true }
        var text = text
        return text.withUTF8 { hay in
            let n = needle.count
            guard n <= hay.count else { return false }
            return needle.withUnsafeBufferPointer { pin in
                var i = 0
                let last = hay.count - n
                while i <= last {
                    if lowerASCII(hay[i]) == first {
                        var j = 1
                        while j < n, lowerASCII(hay[i + j]) == pin[j] { j += 1 }
                        if j == n { return true }
                    }
                    i += 1
                }
                return false
            }
        }
    }
}

/// The find bar's position among the matching rows ("3 / 17"), stepping with wrap-around.
public struct DiffFindState: Equatable, Sendable {
    public private(set) var matches: [String] = []
    public private(set) var current: Int?

    public init() {}

    public var total: Int { matches.count }
    public var currentKey: String? { current.map { matches[$0] } }

    /// New matches (the query or the rows changed): the current row stays current while it still matches.
    public mutating func update(matches new: [String]) {
        let keep = currentKey.flatMap { new.firstIndex(of: $0) }
        matches = new
        current = new.isEmpty ? nil : (keep ?? 0)
    }

    public mutating func next() {
        guard !matches.isEmpty else { return }
        current = ((current ?? -1) + 1) % matches.count
    }

    public mutating func previous() {
        guard !matches.isEmpty else { return }
        current = ((current ?? 0) - 1 + matches.count) % matches.count
    }
}
