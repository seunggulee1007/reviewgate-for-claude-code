import Foundation

// MARK: r2-review-flow — polish P3-transcript-10: "텍스트로 복사" copies an answer as it reads, not as its markdown.

extension MarkdownBlocks {
    /// `text` (an answer's markdown) as the reader sees it, from the same blocks the transcript draws: headings, emphasis,
    /// inline code and links without their marks; list items with "•" / "2." / "☐" / "☑", indented two spaces a level; code
    /// blocks' text without their fences; a table's cells split by tabs; a rule left out. Blocks are an empty line apart.
    ///
    ///     MarkdownBlocks.plainText("## Fix\n- **one** in `a.swift`")   // "Fix\n\n• one in a.swift"
    public static func plainText(_ text: String) -> String {
        plain(parse(text)).joined(separator: "\n\n")
    }

    private static func plain(_ blocks: [Block]) -> [String] {
        blocks.compactMap { block -> String? in
            switch block {
            case let .paragraph(lines): return lines.map(inlineText).joined(separator: "\n")
            case let .heading(_, text): return inlineText(text)
            case let .code(_, text): return text
            case let .list(items): return items.map(itemText).joined(separator: "\n")
            case let .quote(blocks): return plain(blocks).joined(separator: "\n\n")
            case let .table(header, _, rows): return ([header] + rows).map { $0.map(inlineText).joined(separator: "\t") }.joined(separator: "\n")
            case .rule: return nil
            }
        }
    }

    private static func itemText(_ item: ListItem) -> String {
        let marker: String
        switch item.marker {
        case .bullet: marker = "•"
        case let .ordered(number): marker = number
        case let .task(done): marker = done ? "☑" : "☐"
        }
        let indent = String(repeating: "  ", count: item.indent)
        let line = indent + marker + " " + inlineText(item.text)
        return ([line] + item.code.map { indent + "  " + $0 }).joined(separator: "\n")
    }

    /// One line's inline markdown (**bold**, *emphasis*, `code`, [links](url)) as its text; the line as it is when it does not
    /// parse.
    static func inlineText(_ line: String) -> String {
        guard let styled = try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return line }
        return String(styled.characters)
    }
}
