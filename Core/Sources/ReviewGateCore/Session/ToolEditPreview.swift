import Foundation

/// wave2 mac-diff — the folded mini diff under a chat Edit / MultiEdit / Write row (docs/PROTOCOL.md §34.6; audit comp-03,
/// market-13). Built on the client from `tool_use.input` (`old_string` → `new_string`, MultiEdit's `edits`, the first
/// lines of a Write), so what Claude changed reads in the chat while the turn still runs — before the review exists.
public struct ToolEditPreview: Equatable, Sendable {
    public struct Line: Equatable, Sendable, Identifiable {
        public var id: Int
        /// `.add` / `.del` / `.context`; `.hunkHeader` separates the edits of a MultiEdit.
        public var kind: DiffLineKind
        public var text: String
        /// The changed part of a paired line (UTF-16, as `DiffLine.segments`).
        public var segments: [DiffSegment]
    }

    /// At most `maxLines` (a Write: `writeLines`).
    public var lines: [Line]
    /// Over the whole input, shown or not.
    public var added: Int
    public var removed: Int
    /// Lines not in `lines`.
    public var hiddenLines: Int
    /// The edits it shows (1 for Edit / Write).
    public var edits: Int

    /// Lines of a Write shown.
    public static let writeLines = 20
    /// Lines of an Edit / MultiEdit shown.
    public static let maxLines = 40
    /// Above this many old × new lines the line match is skipped (removed lines, then added ones).
    static let matchLimit = 40_000

    /// nil for another tool, malformed input or a change with nothing to show.
    public static func make(name: String, input: JSONValue) -> ToolEditPreview? {
        switch name {
        case "Edit":
            guard let old = input["old_string"]?.stringValue, let new = input["new_string"]?.stringValue, old != new else { return nil }
            return build([(old, new)], cap: maxLines)
        case "MultiEdit":
            guard case let .array(raw)? = input["edits"] else { return nil }
            let pairs: [(String, String)] = raw.compactMap { edit in
                guard let old = edit["old_string"]?.stringValue, let new = edit["new_string"]?.stringValue, old != new else { return nil }
                return (old, new)
            }
            guard !pairs.isEmpty else { return nil }
            return build(pairs, cap: maxLines)
        case "Write":
            guard let content = input["content"]?.stringValue else { return nil }
            let count = lineCount(content)
            guard count > 0 else { return nil }
            let shown = prefixLines(content, writeLines).enumerated().map { Line(id: $0.offset, kind: .add, text: $0.element, segments: []) }
            let total = max(count, shown.count)   // a lone "\r" splits lines too
            return ToolEditPreview(lines: shown, added: total, removed: 0, hiddenLines: total - shown.count, edits: 1)
        default:
            return nil
        }
    }

    /// The lines as `DiffLine`s (ids = positions, no numbers) for the shared row drawing.
    public var diffLines: [DiffLine] {
        lines.map { DiffLine(id: $0.id, kind: $0.kind, oldNo: nil, newNo: nil, text: $0.text, segments: $0.segments) }
    }

    /// The row's body is evaluated on every hover: past the line-match limit only the lines that can be shown are split.
    private static func build(_ pairs: [(String, String)], cap: Int) -> ToolEditPreview {
        var shown: [Line] = []
        var total = 0, added = 0, removed = 0
        func push(_ kind: DiffLineKind, _ text: String, _ segments: [DiffSegment]) {
            if shown.count < cap { shown.append(Line(id: shown.count, kind: kind, text: text, segments: segments)) }
            total += 1
        }
        for (i, (old, new)) in pairs.enumerated() {
            if i > 0 { push(.hunkHeader, "", []) }
            let oldCount = lineCount(old), newCount = lineCount(new)
            if oldCount * newCount <= matchLimit {
                for (kind, text, segments) in lineDiff(splitLines(old), splitLines(new)) {
                    if kind == .add { added += 1 } else if kind == .del { removed += 1 }
                    push(kind, text, segments)
                }
            } else {
                // Thousands of lines: removed then added, unpaired; only what can still be shown is split.
                removed += oldCount
                added += newCount
                let dels = prefixLines(old, cap - shown.count)
                for text in dels { push(.del, text, []) }
                total += oldCount - dels.count
                let adds = prefixLines(new, cap - shown.count)
                for text in adds { push(.add, text, []) }
                total += newCount - adds.count
            }
        }
        return ToolEditPreview(lines: shown, added: added, removed: removed, hiddenLines: total - shown.count, edits: pairs.count)
    }

    /// `text` split into lines, without the empty line after a final newline ("" has none). Any newline counts: "\r\n" is
    /// one Swift `Character`, so a CRLF file would otherwise read as a single line.
    static func splitLines(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    /// The first `n` lines of `text` (as `splitLines`), without splitting the rest.
    static func prefixLines(_ text: String, _ n: Int) -> [String] {
        guard n > 0, !text.isEmpty else { return [] }
        var parts = text.split(maxSplits: n, omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        if parts.count > n {
            parts.removeLast()   // the unsplit rest
        } else if parts.last == "" {
            parts.removeLast()   // after a final newline
        }
        return parts
    }

    /// Lines of `text` as `splitLines` counts them ("\n" / "\r\n" newlines), from its UTF-8 bytes.
    static func lineCount(_ text: String) -> Int {
        var text = text
        return text.withUTF8 { bytes in
            guard let last = bytes.last else { return 0 }
            var n = 0
            for b in bytes where b == 0x0A { n += 1 }
            return last == 0x0A ? n : n + 1
        }
    }

    /// A line-level diff (longest common subsequence): unchanged lines as context, each run of removed lines followed by
    /// the added ones, the i-th removed / added line of a run paired for the in-line marks.
    static func lineDiff(_ old: [String], _ new: [String]) -> [(DiffLineKind, String, [DiffSegment])] {
        guard old.count * new.count <= matchLimit else {
            return block(del: old[...], add: new[...])
        }
        let n = old.count, m = new.count
        // lcs[i][j]: the common subsequence length of old[i...] and new[j...].
        var lcs = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        if n > 0 && m > 0 {
            for i in stride(from: n - 1, through: 0, by: -1) {
                for j in stride(from: m - 1, through: 0, by: -1) {
                    lcs[i][j] = old[i] == new[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
                }
            }
        }
        var out: [(DiffLineKind, String, [DiffSegment])] = []
        var i = 0, j = 0
        var dels: [String] = [], adds: [String] = []
        func flush() {
            out.append(contentsOf: block(del: dels[...], add: adds[...]))
            dels = []
            adds = []
        }
        while i < n || j < m {
            if i < n, j < m, old[i] == new[j] {
                flush()
                out.append((.context, old[i], []))
                i += 1
                j += 1
            } else if j < m, i == n || lcs[i][j + 1] >= lcs[i + 1][j] {
                adds.append(new[j])
                j += 1
            } else {
                dels.append(old[i])
                i += 1
            }
        }
        flush()
        return out
    }

    /// Removed lines then added ones, the i-th of each paired for the in-line marks (§34.7's pairing).
    private static func block(del: ArraySlice<String>, add: ArraySlice<String>) -> [(DiffLineKind, String, [DiffSegment])] {
        var dels = del.map { (DiffLineKind.del, $0, [DiffSegment]()) }
        var adds = add.map { (DiffLineKind.add, $0, [DiffSegment]()) }
        for k in 0..<min(dels.count, adds.count) {
            let (a, b) = changedParts(dels[k].1, adds[k].1)
            dels[k].2 = a
            adds[k].2 = b
        }
        return dels + adds
    }

    /// The changed middle of two lines (common prefix and suffix cut off) as one segment on each side, in UTF-16 units;
    /// none when more than 60 % of the longer line changed (a rewrite reads as a whole-line change, as §34.7) or a side
    /// only gained / lost text in the middle (an empty range).
    static func changedParts(_ a: String, _ b: String) -> ([DiffSegment], [DiffSegment]) {
        let x = Array(a), y = Array(b)
        var prefix = 0
        while prefix < x.count, prefix < y.count, x[prefix] == y[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < x.count - prefix, suffix < y.count - prefix, x[x.count - 1 - suffix] == y[y.count - 1 - suffix] { suffix += 1 }
        func units(_ chars: ArraySlice<Character>) -> Int { chars.reduce(0) { $0 + $1.utf16.count } }
        let aStart = units(x[..<prefix]), aEnd = aStart + units(x[prefix..<(x.count - suffix)])
        let bStart = units(y[..<prefix]), bEnd = bStart + units(y[prefix..<(y.count - suffix)])
        let longer = max(a.utf16.count, b.utf16.count)
        guard longer > 0, Double(max(aEnd - aStart, bEnd - bStart)) <= 0.6 * Double(longer) else { return ([], []) }
        return (aEnd > aStart ? [DiffSegment(start: aStart, end: aEnd)] : [], bEnd > bStart ? [DiffSegment(start: bStart, end: bEnd)] : [])
    }
}
