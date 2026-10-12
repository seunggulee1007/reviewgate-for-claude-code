import SwiftUI
import AppKit
import ReviewGateCore

/// Lightweight Markdown for assistant replies (M16 / M17). `MarkdownBlocks.parse` (in Core, unit-tested)
/// splits the reply into blocks; this file renders them: fenced code as a monospaced box with a language
/// label and Copy, GFM tables as a real grid with per-column alignment, `---` as a divider, grouped
/// blockquotes, and each run of paragraphs, headings and (nested / ordered / task) lists as one selectable
/// AppKit text (`ProseTextView`) with bold / italic / inline code / links. No raw HTML.
///
/// Links open on the first click (`ChatLinkOpener`): web links in the browser, and the bare URLs and the file
/// references that exist under the project (`Foo.java:42`, `ChatLinks`) are links too.
///
/// Streaming messages stay plain text (see `ChatView`), so a half-arrived table never renders as a grid.
struct MarkdownText: View {
    @Environment(AppState.self) private var store: AppState?
    @Environment(WindowModel.self) private var model: WindowModel?
    @Environment(\.font) private var font
    let text: String
    /// Drawn secondary (an answer Claude Code ran on its own): the AppKit prose does not take the foreground style around it.
    var secondary = false

    var body: some View {
        // MARK: wave7 w7-chat — §45.1: parsed once per text (a row drawn again, after a scroll, gets the blocks from here)
        MarkdownBlocksView(blocks: TranscriptRowCache.markdownBlocks(text), context: context)
            .textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in   // a table cell's links (SwiftUI `Text`)
                ChatLinkOpener.open(url, store: store, model: model) ? .handled : .discarded
            })
            .accessibilityElement(children: .contain)   // a container, so the code blocks keep their own identifiers
            .accessibilityIdentifier("Markdown")
    }

    private var context: MarkdownContext {
        let root = store?.projectInfo?.root ?? store?.projectURL?.path
        // A bare `Foo.java` is looked up among the review's files and the files the chat's calls touched (only when the
        // text is built — a cached text reads neither).
        let links = ProseLinks(root: root) { [weak store] in
            guard let store else { return [] }
            return store.changedFiles.map(\.path)
                + store.transcriptIndex.calls.values.compactMap { $0.file.map { RepoPath.relative($0, root: root) } }
        }
        return MarkdownContext(style: ProseStyle(size: ProseStyle.size(for: font), secondary: secondary), links: links) { [store, model] url in
            ChatLinkOpener.open(url, store: store, model: model)
        }
    }
}

/// What the blocks of one markdown text share: how its prose is set, what its file references resolve against, and what a
/// click on a link does.
private struct MarkdownContext {
    var style: ProseStyle
    let links: ProseLinks
    let open: (URL) -> Void
}

/// A markdown text's blocks in order: each run of prose blocks (paragraphs, headings, lists) as one selectable text, the
/// others as their own views.
private struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlocks.Block]
    let context: MarkdownContext

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.segments(blocks).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case let .prose(run):
                    ProseTextView(text: ProseBuilder.text(run, style: context.style, links: context.links), onLink: context.open)
                case let .block(block):
                    BlockView(block: block, context: context)
                }
            }
        }
    }

    enum Segment {
        case prose([MarkdownBlocks.Block])
        case block(MarkdownBlocks.Block)
    }

    /// Consecutive paragraphs, headings and lists together; a code block, table, quote or rule between them ends a run.
    static func segments(_ blocks: [MarkdownBlocks.Block]) -> [Segment] {
        var out: [Segment] = []
        var run: [MarkdownBlocks.Block] = []
        for block in blocks {
            switch block {
            case .paragraph, .heading, .list:
                run.append(block)
            case .code, .table, .quote, .rule:
                if !run.isEmpty { out.append(.prose(run)) }
                run = []
                out.append(.block(block))
            }
        }
        if !run.isEmpty { out.append(.prose(run)) }
        return out
    }
}

/// One block that is not prose. `AnyView` breaks the type recursion that blockquotes (blocks inside blocks) create.
private struct BlockView: View {
    let block: MarkdownBlocks.Block
    let context: MarkdownContext

    var body: some View {
        switch block {
        case let .code(language, text):
            CodeBlock(language: language, code: text)
        case let .quote(blocks):
            QuoteBlock(blocks: blocks, context: context)
        case let .table(header, alignments, rows):
            TableBlock(header: header, alignments: alignments, rows: rows, links: context.links)
        case .rule:
            Divider().padding(.vertical, 2).accessibilityIdentifier("Markdown rule")
        case .paragraph, .heading, .list:
            EmptyView()   // drawn in a prose run (`MarkdownBlocksView.segments`)
        }
    }
}

/// MARK: wave7 w7-chat — §45.1: a line's inline markdown is parsed once (NSCache: dropped under memory pressure).
private final class InlineMarkdown {
    let value: AttributedString?
    init(_ value: AttributedString?) { self.value = value }
}

@MainActor private let inlineMarkdownCache: NSCache<NSString, InlineMarkdown> = {
    let cache = NSCache<NSString, InlineMarkdown>()
    cache.countLimit = 2_000
    return cache
}()

/// Inline markdown (bold / italic / code / links) for a single line of text, parsed once.
@MainActor
private func parsedInline(_ s: String) -> AttributedString? {
    let key = s as NSString
    if let cached = inlineMarkdownCache.object(forKey: key) { return cached.value }
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    let parsed = try? AttributedString(markdown: s, options: options)
    inlineMarkdownCache.setObject(InlineMarkdown(parsed), forKey: key)
    return parsed
}

/// A table cell's text with its links: a markdown link keeps a web destination or becomes the in-app link of a project
/// file (else it is dropped), and bare URLs and existing file references are linked (`ProseLinks`; the parser's own
/// bare-URL links are dropped first, they run on into Korean text).
@MainActor
private func linked(_ text: AttributedString, links: ProseLinks) -> AttributedString {
    var out = text
    for (range, url) in text.runs.compactMap({ run in run.link.map { (run.range, $0) } }) {
        out[range].link = ChatLinks.isAutolink(text: String(text[range].characters), url: url) ? nil : links.target(ofMarkdownLink: url)
    }
    let plain = String(out.characters)
    for match in ChatLinks.scan(plain) {
        guard let range = Range(match.range, in: plain), let target = links.target(of: match) else { continue }
        let lower = out.characters.index(out.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: range.lowerBound))
        let upper = out.characters.index(lower, offsetBy: plain.distance(from: range.lowerBound, to: range.upperBound))
        guard !out[lower..<upper].runs.contains(where: { $0.link != nil }) else { continue }
        out[lower..<upper].link = target.url
    }
    return out
}

/// A cell that is *entirely* one inline-code span renders monospaced; otherwise it is inline markdown. Either way its
/// links are live (`linked`); `hasLink` says whether there is one.
@MainActor
private func cellText(_ s: String, links: ProseLinks) -> (text: Text, hasLink: Bool) {
    let body = s.trimmingCharacters(in: .whitespaces)
    if body.count >= 2, body.hasPrefix("`"), body.hasSuffix("`") {
        let inner = String(body.dropFirst().dropLast())
        if !inner.contains("`") {
            let attributed = linked(AttributedString(inner), links: links)
            return (Text(attributed).font(.system(.callout, design: .monospaced)), attributed.runs.contains { $0.link != nil })
        }
    }
    guard let parsed = parsedInline(s) else { return (Text(verbatim: s), false) }
    let attributed = linked(parsed, links: links)
    return (Text(attributed), attributed.runs.contains { $0.link != nil })
}

/// Consecutive `>` lines as one quoted block: a left bar and secondary text. Nested `>` quotes recurse.
private struct QuoteBlock: View {
    let blocks: [MarkdownBlocks.Block]
    let context: MarkdownContext

    var body: some View {
        var quoted = context
        quoted.style.secondary = true
        return HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3)
            AnyView(MarkdownBlocksView(blocks: blocks, context: quoted))
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Quote block")
    }
}

/// A GFM table as a real grid: bold header, alternating row backgrounds, per-column alignment from the
/// separator row, thin dividers, and horizontal scrolling when it is wider than the chat pane.
private struct TableBlock: View {
    @Environment(\.colorScheme) private var colorScheme
    let header: [String]
    let alignments: [MarkdownBlocks.Alignment]
    let rows: [[String]]
    let links: ProseLinks

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                        cellView(cell, column: column, header: true, striped: false)
                    }
                }
                Divider().gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Divider().gridCellUnsizedAxes(.horizontal).opacity(0.5)
                    }
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            cellView(cell, column: column, header: false, striped: index % 2 == 1)
                        }
                    }
                }
            }
            // The frame hugs the grid, so a narrow table does not draw a full-width empty box.
            .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Markdown table")
        .accessibilityLabel(Text("Table"))
    }

    private func cellView(_ cell: String, column: Int, header isHeader: Bool, striped: Bool) -> some View {
        let (text, hasLink) = cellText(cell, links: links)
        return Group {
            // A selectable `Text` takes a click on its link as the start of a selection: a cell with a link opens it instead.
            if hasLink { text.textSelection(.disabled) } else { text }
        }
        .fontWeight(isHeader ? .semibold : .regular)
        .multilineTextAlignment(textAlignment(column))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: frameAlignment(column))
        // A tint rather than a system background colour, so the header and the stripes stay visible
        // in both light and dark appearance.
        .background(isHeader ? Color.secondary.wash(colorScheme, light: 0.14, dark: 0.20)
                    : striped ? Color.secondary.wash(colorScheme, light: 0.06, dark: 0.10) : Color.clear)
        .overlay(alignment: .trailing) {
            if column < alignments.count - 1 {
                Rectangle().fill(.quaternary).frame(width: 1).opacity(0.6)
            }
        }
    }

    private func alignment(_ column: Int) -> MarkdownBlocks.Alignment {
        column < alignments.count ? alignments[column] : .none
    }

    private func frameAlignment(_ column: Int) -> Alignment {
        switch alignment(column) {
        case .center: .center
        case .right: .trailing
        case .left, .none: .leading
        }
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        switch alignment(column) {
        case .center: .center
        case .right: .trailing
        case .left, .none: .leading
        }
    }
}

/// A fenced block: language label + Copy in a small header, monospaced code below (horizontal scroll).
private struct CodeBlock: View {
    @Environment(\.colorScheme) private var colorScheme
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(verbatim: language.isEmpty ? "code" : language)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("Code language")
                Spacer(minLength: 4)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Copy the code block")
                .accessibilityLabel("Copy code")
                .accessibilityIdentifier("Copy code")
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Color.panelHeaderFill(colorScheme))
            Divider()
            ScrollView(.horizontal) {
                Text(verbatim: code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
            }
        }
        .background(Color.panelFill(colorScheme), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Code block")
    }
}
