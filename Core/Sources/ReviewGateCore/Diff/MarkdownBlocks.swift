import Foundation

/// A pure, dependency-free block parser for the GitHub-flavored Markdown subset assistant replies use
/// (M17). The App renders the returned blocks; keeping the parsing here makes it unit-testable.
///
/// Supported blocks: ATX headings, fenced code (``` and ~~~), tables with per-column alignment,
/// thematic breaks, blockquotes (nested), lists (nested / ordered / task items, with 4-space indented
/// code inside an item), and paragraphs. Everything else stays a paragraph line and is handled by the
/// renderer's inline markdown pass.
public enum MarkdownBlocks {

    /// Column alignment taken from the table's `|---|:---:|---:|` separator row.
    public enum Alignment: String, Sendable, Equatable {
        case none, left, center, right
    }

    /// One list item. `indent` is the nesting *level* (0 = outermost), not a column count.
    public struct ListItem: Sendable, Equatable {
        public enum Marker: Sendable, Equatable {
            case bullet
            case ordered(String)        // the rendered number incl. its delimiter, e.g. "2."
            case task(done: Bool)
        }

        public let indent: Int
        public let marker: Marker
        public let text: String
        /// 4-space indented continuation lines under the item, kept verbatim (rendered monospaced).
        public let code: [String]

        public init(indent: Int, marker: Marker, text: String, code: [String] = []) {
            self.indent = indent
            self.marker = marker
            self.text = text
            self.code = code
        }
    }

    public indirect enum Block: Sendable, Equatable {
        case paragraph(lines: [String])
        case heading(level: Int, text: String)
        case code(language: String, text: String)
        case list(items: [ListItem])
        case quote(blocks: [Block])
        case table(header: [String], alignments: [Alignment], rows: [[String]])
        case rule
    }

    // MARK: - Entry point

    public static func parse(_ text: String) -> [Block] {
        parse(lines: text.components(separatedBy: "\n"))
    }

    // MARK: - Block scanner

    private static func parse(lines: [String]) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            if !paragraph.isEmpty {
                out.append(.paragraph(lines: paragraph))
                paragraph = []
            }
        }

        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            if let fence = Fence(trimmed) {
                flushParagraph()
                var body: [String] = []
                i += 1
                while i < lines.count {
                    if fence.closes(lines[i].trimmingCharacters(in: .whitespaces)) { i += 1; break }
                    body.append(lines[i])
                    i += 1
                }
                out.append(.code(language: fence.info, text: body.joined(separator: "\n")))
                continue
            }

            if let h = heading(trimmed) {
                flushParagraph()
                out.append(.heading(level: h.level, text: h.text))
                i += 1
                continue
            }

            // Tables are checked before the thematic break so `| --- | --- |` stays a separator row,
            // and before the paragraph fallback so a table may follow a paragraph with no blank line.
            if let table = table(lines, at: i) {
                flushParagraph()
                out.append(table.block)
                i = table.next
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                out.append(.rule)
                i += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var inner: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    inner.append(stripQuoteMarker(lines[i]))
                    i += 1
                }
                out.append(.quote(blocks: parse(lines: inner)))
                continue
            }

            if listMarker(raw) != nil {
                flushParagraph()
                let list = list(lines, at: i)
                out.append(.list(items: list.items))
                i = list.next
                continue
            }

            paragraph.append(raw)
            i += 1
        }

        flushParagraph()
        return out
    }

    // MARK: - Fences

    private struct Fence {
        let char: Character
        let count: Int
        let info: String

        init?(_ trimmed: String) {
            guard let c = trimmed.first, c == "`" || c == "~" else { return nil }
            let n = trimmed.prefix(while: { $0 == c }).count
            guard n >= 3 else { return nil }
            let rest = String(trimmed.dropFirst(n)).trimmingCharacters(in: .whitespaces)
            if c == "`", rest.contains("`") { return nil }
            char = c
            count = n
            info = rest
        }

        func closes(_ trimmed: String) -> Bool {
            guard trimmed.first == char else { return false }
            let n = trimmed.prefix(while: { $0 == char }).count
            return n >= count && trimmed.dropFirst(n).allSatisfy { $0 == " " }
        }
    }

    // MARK: - Headings / rules / quotes

    private static func heading(_ s: String) -> (level: Int, text: String)? {
        let hashes = s.prefix(while: { $0 == "#" }).count
        guard hashes > 0, hashes <= 6 else { return nil }
        let rest = s.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return (hashes, String(rest).trimmingCharacters(in: .whitespaces))
    }

    /// `---`, `***`, `___` (3+ of one character, spaces allowed between) on a line of their own.
    static func isRule(_ trimmed: String) -> Bool {
        let stripped = trimmed.filter { !$0.isWhitespace }
        guard stripped.count >= 3, let c = stripped.first, c == "-" || c == "*" || c == "_" else { return false }
        return stripped.allSatisfy { $0 == c }
    }

    private static func stripQuoteMarker(_ raw: String) -> String {
        var s = Substring(raw).drop(while: { $0 == " " || $0 == "\t" })
        guard s.first == ">" else { return String(s) }
        s = s.dropFirst()
        if s.first == " " { s = s.dropFirst() }
        return String(s)
    }

    // MARK: - Tables

    /// Splits a table row on unescaped `|`, honouring `\|`, and drops the optional outer pipes.
    static func splitRow(_ line: String) -> [String] {
        var cells: [String] = []
        var cur = ""
        var escaped = false
        for ch in line {
            if escaped {
                if ch != "|" { cur.append("\\") }
                cur.append(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(cur)
                cur = ""
            } else {
                cur.append(ch)
            }
        }
        if escaped { cur.append("\\") }
        cells.append(cur)
        if cells.count > 1, cells[0].trimmingCharacters(in: .whitespaces).isEmpty { cells.removeFirst() }
        if cells.count > 1, cells[cells.count - 1].trimmingCharacters(in: .whitespaces).isEmpty { cells.removeLast() }
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func hasUnescapedPipe(_ line: String) -> Bool {
        var escaped = false
        for ch in line {
            if escaped { escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" { return true }
        }
        return false
    }

    /// `|---|:---:|---:|` → one alignment per column, or nil when the line is not a separator row.
    static func alignments(_ line: String) -> [Alignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.contains("-") else { return nil }
        guard trimmed.allSatisfy({ $0 == "-" || $0 == ":" || $0 == "|" || $0 == " " || $0 == "\t" }) else { return nil }
        let cells = splitRow(trimmed)
        guard !cells.isEmpty else { return nil }
        var out: [Alignment] = []
        for cell in cells {
            let body = cell.trimmingCharacters(in: .whitespaces)
            let left = body.hasPrefix(":")
            let right = body.hasSuffix(":") && body.count > 1
            let dashes = body.dropFirst(left ? 1 : 0).dropLast(right ? 1 : 0)
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
            switch (left, right) {
            case (true, true): out.append(.center)
            case (true, false): out.append(.left)
            case (false, true): out.append(.right)
            case (false, false): out.append(.none)
            }
        }
        return out
    }

    private static func table(_ lines: [String], at start: Int) -> (block: Block, next: Int)? {
        guard start + 1 < lines.count else { return nil }
        let headerLine = lines[start]
        guard hasUnescapedPipe(headerLine) else { return nil }
        guard let aligns = alignments(lines[start + 1]) else { return nil }
        let header = splitRow(headerLine.trimmingCharacters(in: .whitespaces))
        guard header.count == aligns.count, header.count >= 1 else { return nil }

        var rows: [[String]] = []
        var i = start + 2
        while i < lines.count {
            let raw = lines[i]
            if raw.trimmingCharacters(in: .whitespaces).isEmpty { break }
            guard hasUnescapedPipe(raw) else { break }
            var cells = splitRow(raw.trimmingCharacters(in: .whitespaces))
            // Ragged rows are tolerated: pad short rows, drop the overflow of long ones.
            if cells.count < header.count { cells += Array(repeating: "", count: header.count - cells.count) }
            if cells.count > header.count { cells = Array(cells.prefix(header.count)) }
            rows.append(cells)
            i += 1
        }
        return (.table(header: header, alignments: aligns, rows: rows), i)
    }

    // MARK: - Lists

    private struct Marker {
        let indent: Int          // leading columns before the marker
        let content: Int         // column where the item's text starts
        let kind: ListItem.Marker
        let text: String
    }

    private static func listMarker(_ raw: String) -> Marker? {
        var indent = 0
        var idx = raw.startIndex
        while idx < raw.endIndex, raw[idx] == " " || raw[idx] == "\t" {
            indent += raw[idx] == "\t" ? 4 : 1
            idx = raw.index(after: idx)
        }
        let rest = raw[idx...]
        guard let first = rest.first else { return nil }

        var markerWidth = 0
        var kind: ListItem.Marker
        if first == "-" || first == "*" || first == "+", rest.dropFirst().first == " " {
            markerWidth = 2
            kind = .bullet
        } else {
            let digits = rest.prefix(while: \.isNumber)
            let after = rest.dropFirst(digits.count)
            guard !digits.isEmpty, digits.count <= 9,
                  let delim = after.first, delim == "." || delim == ")",
                  after.dropFirst().first == " "
            else { return nil }
            markerWidth = digits.count + 2
            kind = .ordered(String(digits) + String(delim))
        }

        var text = String(rest.dropFirst(markerWidth)).trimmingCharacters(in: .whitespaces)
        if case .bullet = kind {
            let lower = text.lowercased()
            if lower == "[ ]" || lower.hasPrefix("[ ] ") {
                kind = .task(done: false)
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if lower == "[x]" || lower.hasPrefix("[x] ") {
                kind = .task(done: true)
                text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }
        }
        return Marker(indent: indent, content: indent + markerWidth, kind: kind, text: text)
    }

    private static func leadingColumns(_ raw: String) -> Int {
        var n = 0
        for ch in raw {
            if ch == " " { n += 1 } else if ch == "\t" { n += 4 } else { break }
        }
        return n
    }

    private static func list(_ lines: [String], at start: Int) -> (items: [ListItem], next: Int) {
        var items: [ListItem] = []
        var pending: [String] = []          // indented-code lines for the item being built
        var levels: [Int] = []              // marker columns, one per open nesting level
        var contentColumn = 0
        var i = start

        func flushCode() {
            guard !pending.isEmpty, let last = items.popLast() else { pending = []; return }
            items.append(ListItem(indent: last.indent, marker: last.marker, text: last.text, code: pending))
            pending = []
        }

        func appendText(_ extra: String) {
            guard let last = items.popLast() else { return }
            let joined = last.text.isEmpty ? extra : last.text + " " + extra
            items.append(ListItem(indent: last.indent, marker: last.marker, text: joined, code: last.code))
        }

        loop: while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                // A blank line only ends the list if what follows is neither an item nor a continuation.
                var j = i + 1
                while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).isEmpty { j += 1 }
                guard j < lines.count,
                      listMarker(lines[j]) != nil || leadingColumns(lines[j]) >= contentColumn + 4
                else { break loop }
                i = j
                continue
            }

            // Indented code inside the current item wins over every other interpretation, so a `- x`
            // line inside a code sample is not mis-read as a nested list item.
            if !items.isEmpty, leadingColumns(raw) >= contentColumn + 4 {
                pending.append(dedent(raw, by: contentColumn + 4))
                i += 1
                continue
            }

            if let marker = listMarker(raw), !isRule(trimmed) {
                flushCode()
                while let last = levels.last, marker.indent < last { levels.removeLast() }
                if levels.isEmpty || marker.indent > (levels.last ?? -1) { levels.append(marker.indent) }
                contentColumn = marker.content
                items.append(ListItem(indent: max(0, levels.count - 1), marker: marker.kind, text: marker.text))
                i += 1
                continue
            }

            // A lazy continuation line, unless it starts a different block.
            if items.isEmpty || isRule(trimmed) || heading(trimmed) != nil || Fence(trimmed) != nil
                || trimmed.hasPrefix(">") || table(lines, at: i) != nil {
                break loop
            }
            flushCode()
            appendText(trimmed)
            i += 1
        }

        flushCode()
        return (items, i)
    }

    private static func dedent(_ raw: String, by columns: Int) -> String {
        var n = columns
        var idx = raw.startIndex
        while n > 0, idx < raw.endIndex, raw[idx] == " " || raw[idx] == "\t" {
            n -= raw[idx] == "\t" ? 4 : 1
            idx = raw.index(after: idx)
        }
        return String(raw[idx...])
    }
}
