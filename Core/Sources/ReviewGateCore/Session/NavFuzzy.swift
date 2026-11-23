import Foundation

// MARK: ide-nav — docs/PROTOCOL.md §65.3 / §65.8 on the Mac: the palettes' client-side matching. Go to File marks the
// letters the query matched (the engine ranks, the client marks); Symbols in File filters the outline as the user types
// with the engine's order of kinds of match. UTF-16 offsets throughout, as the wire's `matches`.

public enum NavFuzzy {
    /// A match of `query` in a name: its score (higher is better, §65.3's scale) and the UTF-16 offsets matched.
    public struct Match: Sendable, Equatable {
        public var score: Int
        public var offsets: [Int]

        public init(score: Int, offsets: [Int]) {
            self.score = score
            self.offsets = offsets
        }
    }

    /// `query` against `name` as §65.3 ranks it: exact (1000) > prefix (800) > exact ignoring case (780) > prefix ignoring
    /// case (760) > camel humps (600) > substring (450 at a word start, else 400) > subsequence (200; not for one
    /// character); from prefixes down, minus the characters the name has beyond the query (at most 80). Nil: no match.
    public static func match(_ query: String, in name: String) -> Match? {
        let q = Array(query.utf16), n = Array(name.utf16)
        guard !q.isEmpty, !n.isEmpty else { return nil }
        let extra = min(80, max(0, n.count - q.count))
        if q == n { return Match(score: 1000, offsets: Array(0..<n.count)) }
        if n.starts(with: q) { return Match(score: 800 - extra, offsets: Array(0..<q.count)) }
        let lq = q.map(lower), ln = n.map(lower)
        if lq == ln { return Match(score: 780, offsets: Array(0..<n.count)) }
        if ln.starts(with: lq) { return Match(score: 760 - extra, offsets: Array(0..<q.count)) }
        if let humps = humps(q, n) { return Match(score: 600 - extra, offsets: humps) }
        let starts = wordStarts(n)
        var best: Int?
        if lq.count <= ln.count {
            for i in 0...(ln.count - lq.count) where Array(ln[i..<(i + lq.count)]) == lq {
                if starts.contains(i) { best = i; break }
                if best == nil { best = i }
            }
        }
        if let i = best { return Match(score: (starts.contains(i) ? 450 : 400) - extra, offsets: Array(i..<(i + q.count))) }
        guard q.count > 1, let sub = subsequence(lq, ln) else { return nil }
        return Match(score: 200 - extra, offsets: sub)
    }

    /// The offsets to mark in `text` for `query`: one contiguous run if it occurs, else its camel humps, else the letters
    /// in order; [] when they are not all there.
    public static func marks(_ query: String, in text: String) -> [Int] {
        let q = Array(query.utf16), n = Array(text.utf16)
        guard !q.isEmpty, !n.isEmpty else { return [] }
        let lq = q.map(lower), ln = n.map(lower)
        if lq.count <= ln.count {
            let starts = wordStarts(n)
            var first: Int?
            for i in 0...(ln.count - lq.count) where Array(ln[i..<(i + lq.count)]) == lq {
                if starts.contains(i) { return Array(i..<(i + q.count)) }
                if first == nil { first = i }
            }
            if let first { return Array(first..<(first + q.count)) }
        }
        return humps(q, n) ?? subsequence(lq, ln) ?? []
    }

    /// Go to File's marks for a `path` (repo-relative): in its file name when the query (without `/`) fits there, else in
    /// the whole path — split into the name's offsets and the folder's.
    public static func fileMarks(_ query: String, path: String) -> (name: [Int], folder: [Int]) {
        let q = query.trimmingCharacters(in: .whitespaces)
        let name = (path as NSString).lastPathComponent
        let folder = (path as NSString).deletingLastPathComponent
        guard !q.isEmpty else { return ([], []) }
        if !q.contains("/") {
            let inName = marks(q, in: name)
            if !inName.isEmpty { return (inName, []) }
            // The query's own extension is no part of the name's humps (`UsrSvc.java`).
            let stem = (q as NSString).deletingPathExtension
            if stem != q, !stem.isEmpty {
                let inStem = marks(stem, in: (name as NSString).deletingPathExtension)
                if !inStem.isEmpty { return (inStem, []) }
            }
        }
        let all = marks(q, in: path)
        guard !all.isEmpty else { return ([], []) }
        let cut = folder.isEmpty ? 0 : folder.utf16.count + 1
        return (all.filter { $0 >= cut }.map { $0 - cut }, all.filter { $0 < folder.utf16.count })
    }

    /// `text` with the UTF-16 `offsets` strongly emphasized (SwiftUI's `Text` draws them bold).
    public static func emphasized(_ text: String, offsets: [Int]) -> AttributedString {
        var out = AttributedString(text)
        guard !offsets.isEmpty else { return out }
        let units = text.utf16
        for offset in Set(offsets) where offset >= 0 && offset < units.count {
            let lo = units.index(units.startIndex, offsetBy: offset)
            guard let start = lo.samePosition(in: text) else { continue }
            let end = text.index(after: start)
            if let range = Range<AttributedString.Index>(start..<end, in: out) {
                out[range].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return out
    }

    // MARK: Parts

    private static func lower(_ u: UInt16) -> UInt16 { (u >= 0x41 && u <= 0x5A) ? u + 0x20 : u }
    private static func isUpper(_ u: UInt16) -> Bool { u >= 0x41 && u <= 0x5A }
    private static func isLower(_ u: UInt16) -> Bool { u >= 0x61 && u <= 0x7A }
    private static func isDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }
    private static func isSeparator(_ u: UInt16) -> Bool { [0x5F, 0x2D, 0x2E, 0x24, 0x2F, 0x20].contains(u) }   // _ - . $ / space

    /// Where the words of a name start: the first letter, a capital after a lower-case letter or digit, the last capital of
    /// a run before a lower-case letter (`HTTPServer` → HTTP, Server), anything after `_ - . $ /`.
    static func wordStarts(_ n: [UInt16]) -> Set<Int> {
        var out = Set<Int>()
        for i in n.indices where !isSeparator(n[i]) {
            if i == 0 || isSeparator(n[i - 1]) { out.insert(i); continue }
            let prev = n[i - 1]
            if isUpper(n[i]), isLower(prev) || isDigit(prev) { out.insert(i) }
            else if isUpper(n[i]), isUpper(prev), i + 1 < n.count, isLower(n[i + 1]) { out.insert(i) }
            else if isDigit(n[i]), !isDigit(prev) { out.insert(i) }
        }
        return out
    }

    /// Camel humps (§65.3): the query split before each capital and at `_`; each part starts a word of the name, in order
    /// (words may be skipped), its other letters in order within that word. Needs two parts or an all-capitals query.
    static func humps(_ q: [UInt16], _ n: [UInt16]) -> [Int]? {
        var parts: [[UInt16]] = []
        for u in q {
            if u == 0x5F { if !(parts.last?.isEmpty ?? true) { parts.append([]) }; continue }
            if isUpper(u) || parts.isEmpty { parts.append([u]) } else { parts[parts.count - 1].append(u) }
        }
        parts.removeAll { $0.isEmpty }
        guard parts.count >= 2 else { return nil }
        let starts = wordStarts(n).sorted()
        var out: [Int] = []
        var w = 0
        for part in parts {
            var placed = false
            while w < starts.count {
                let start = starts[w]
                w += 1
                guard lower(n[start]) == lower(part[0]) else { continue }
                let end = w < starts.count ? starts[w] : n.count
                var offsets = [start]
                var i = start + 1
                for u in part.dropFirst() {
                    while i < end, lower(n[i]) != lower(u) { i += 1 }
                    guard i < end else { break }
                    offsets.append(i)
                    i += 1
                }
                if offsets.count == part.count {
                    out += offsets
                    placed = true
                    break
                }
            }
            if !placed { return nil }
        }
        return out
    }

    /// The query's letters in order anywhere (lower-cased both).
    static func subsequence(_ lq: [UInt16], _ ln: [UInt16]) -> [Int]? {
        var out: [Int] = []
        var i = 0
        for u in lq {
            while i < ln.count, ln[i] != u { i += 1 }
            guard i < ln.count else { return nil }
            out.append(i)
            i += 1
        }
        return out
    }
}

// MARK: - The palettes

/// §65.8: the symbol palette a window shows — this file's (its repo-relative path) or the project's.
public enum NavPalette: Sendable, Equatable, Identifiable {
    case file(String)
    case project

    public var id: String {
        switch self {
        case let .file(path): "file:" + path
        case .project: "project"
        }
    }
}

/// One row of Symbols in File: the symbol and the letters to mark.
public struct OutlineRow: Sendable, Equatable {
    public var symbol: DocumentSymbol
    public var offsets: [Int]

    public init(symbol: DocumentSymbol, offsets: [Int] = []) {
        self.symbol = symbol
        self.offsets = offsets
    }
}

extension NavFuzzy {
    /// Symbols in File as the user types: every symbol for an empty query, else those whose name matches — in file order
    /// (the outline stays an outline), `best` the best-scoring row to pick (the first on a tie).
    public static func filterOutline(_ symbols: [DocumentSymbol], query: String) -> (rows: [OutlineRow], best: Int?) {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return (symbols.map { OutlineRow(symbol: $0) }, symbols.isEmpty ? nil : 0) }
        var rows: [OutlineRow] = []
        var best: (index: Int, score: Int)?
        for s in symbols {
            guard let m = match(q, in: s.symbol.name) else { continue }
            if best == nil || m.score > best!.score { best = (rows.count, m.score) }
            rows.append(OutlineRow(symbol: s, offsets: m.offsets))
        }
        return (rows, best?.index)
    }

    /// Symbols in Project's footer lines: the index building, the list cut, the index cut.
    public static func projectNotes(_ reply: WorkspaceSymbolsReply?, index: NavIndexState?) -> [String] {
        var out: [String] = []
        let state = index ?? reply?.index
        if let state, state.status == .building {
            out.append(state.filesTotal.map { String(localized: "Indexing… \(state.files) / \($0) files", bundle: .module) }
                       ?? String(localized: "Indexing…", bundle: .module))
        }
        if let reply, reply.truncated { out.append(String(localized: "Showing the first \(reply.symbols.count)", bundle: .module)) }
        if state?.truncated == true || reply?.index.truncated == true {
            out.append(String(localized: "The project is larger than the index — some symbols are missing", bundle: .module))
        }
        return out
    }
}

extension AppState {
    /// ⌘F12: the symbols of `path` (§65.2), or why there are none in the user's words.
    public func documentSymbols(path: String) async -> (reply: DocumentSymbolsReply?, error: String?) {
        guard projectInfo != nil else { return (nil, CodeBrowserText.refusal(code: "no_project", fallback: "")) }
        do {
            guard case let .documentSymbols(r) = try await reply(.documentSymbols(path: path)) else { return (nil, nil) }
            return (r, nil)
        } catch {
            return (nil, CodeNavText.message(error))
        }
    }

    /// ⌘⇧P: the project's symbols matching `query` (§65.3, at most 100), or why there are none.
    public func workspaceSymbols(query: String) async -> (reply: WorkspaceSymbolsReply?, error: String?) {
        guard projectInfo != nil else { return (nil, CodeBrowserText.refusal(code: "no_project", fallback: "")) }
        do {
            guard case let .workspaceSymbols(r) = try await reply(.workspaceSymbols(query: query, limit: 100)) else { return (nil, nil) }
            return (r, nil)
        } catch {
            return (nil, CodeNavText.message(error))
        }
    }

    /// §65.1 `nav_index_build` — `full`: Navigate › Rebuild Symbol Index; else what changed (a failed index's Try Again).
    public func buildNavIndex(full: Bool) async {
        guard projectInfo != nil else { return }
        _ = try? await reply(.navIndexBuild(full: full))
    }
}
