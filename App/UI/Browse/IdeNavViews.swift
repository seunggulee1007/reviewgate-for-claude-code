import SwiftUI
import AppKit
import ReviewGateCore

// MARK: ide-nav — docs/PROTOCOL.md §65.8 on the Mac: the peek band — a definition shown inline under the clicked row of a
// diff or a project file, so the place being read never moves. ⌥F12 (and ⌘-click while Settings › Review › Diff says
// 미리 보기) opens it; several candidates are listed on its right (↑ / ↓ switch, ↩ / 열기 jumps, Esc / × closes). The
// rules are Core `CodeNavPeekStore` (tested in `IdeNavTests`).

/// Under a code row: the peek band when it hangs under this row (`row` without a column, `text` the drawn line).
struct CodeNavPeekSlot: View {
    @Environment(AppState.self) private var store: AppState?
    let row: CodeNavLocation
    let text: String

    var body: some View {
        if let store, store.codeNav.peek.shows(row: row, text: text), let band = store.codeNav.peek.band {
            CodeNavPeekBand(band: band)
                .environment(store)
                .padding(.vertical, 4)
                .padding(.trailing, 8)
        }
    }
}

/// Monospaced lines of a file with their numbers, syntax-highlighted as the diff, one line marked; at most `visible` lines
/// tall, scrolled so the marked one shows. Shared by the peek band, the hover card and the References tab's preview.
struct CodeNavPreviewLines: View {
    @Environment(\.colorScheme) private var colorScheme
    let preview: SymbolPreviewReply
    /// The 1-based line to mark (the definition, the reference); nil marks none.
    var marked: Int?
    /// How many lines tall (nil: as tall as the space it is given, the marked line centred — the References tab).
    var visible: Int? = 15
    @State private var highlighted: [AttributedString]?

    static let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    static let lineHeight: CGFloat = ceil(NSLayoutManager().defaultLineHeight(for: font))

    var body: some View {
        let lines = preview.lines
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        line(index, text: lines[index])
                            .id(index)
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(height: visible.map { CGFloat(max(1, min(lines.count, $0))) * Self.lineHeight + 8 })
            .onAppear { reveal(proxy) }
            .onChange(of: preview) { _, _ in reveal(proxy) }
        }
        .task(id: PreviewKey(preview: preview, dark: colorScheme == .dark)) {
            highlighted = nil
            let language = await SyntaxHighlighter.shared.language(forPath: preview.path)
            let out = await SyntaxHighlighter.shared.highlightLines(preview.lines, language: language, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = out
        }
    }

    private struct PreviewKey: Equatable {
        let preview: SymbolPreviewReply
        let dark: Bool
    }

    private func line(_ index: Int, text: String) -> some View {
        let number = preview.startLine + index
        let isMarked = number == marked
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(verbatim: String(number))
                .font(DiffRow.font)
                .foregroundStyle(isMarked ? Color.primary : Color.secondary)
                .frame(width: DiffRow.gutterWidth, alignment: .trailing)
                .padding(.trailing, 8)
            Group {
                if let highlighted, highlighted.indices.contains(index) {
                    Text(highlighted[index])
                } else {
                    Text(verbatim: text)
                }
            }
            .font(DiffRow.font)
            .lineLimit(1)
            .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .frame(height: Self.lineHeight)
        .background(isMarked ? Color.accentColor.wash(colorScheme, light: 0.16, dark: 0.26) : Color.clear)
        .help(text.count > 120 ? text : "")
    }

    /// The marked line in view: the lines above it (a doc comment) stay unless they would push it out.
    private func reveal(_ proxy: ScrollViewProxy) {
        guard let marked else { return }
        let index = marked - preview.startLine
        guard let visible else {
            DispatchQueue.main.async { proxy.scrollTo(index, anchor: .center) }
            return
        }
        guard index >= visible - 3 else { return }
        DispatchQueue.main.async { proxy.scrollTo(max(0, index - 3), anchor: .top) }
    }
}

/// The band: "File.kt:42 — Container.member", 열기 · 참조 · ×; the definition's lines (the definition line marked); the
/// candidates on the right when there are several.
struct CodeNavPeekBand: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let band: CodeNavPeekStore.Band
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
            ForEach(band.reply.map(CodeNavText.limits) ?? [], id: \.self) { line in
                Text(verbatim: line).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.vertical, 3)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.accentColor.opacity(0.55), lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { focused = true }   // a click in the band is the band's, never the row's (picking the line)
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onChange(of: band.tick) { _, _ in focused = true }
        .onKeyPress(.upArrow) { Task { await store.peekMove(-1) }; return .handled }
        .onKeyPress(.downArrow) { Task { await store.peekMove(1) }; return .handled }
        .onKeyPress(.return) { store.openPeekSelection(); return .handled }
        .onKeyPress(.escape) { store.codeNav.peek.close(); return .handled }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Peek of \(band.symbol)"))
        .accessibilityIdentifier("Peek band")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye").foregroundStyle(Color.accentColor).font(.caption)
            if let c = band.current {
                Text(verbatim: IdeNavText.title(c, symbol: previewSymbol, fallback: IdeNavText.bare(band.symbol)))
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(c.path)
                if !c.kind.rawValue.isEmpty { KindBadge(kind: c.kind) }
                Text(verbatim: (c.path as NSString).deletingLastPathComponent)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            } else {
                Text("Definition of \(band.symbol)").font(.callout.weight(.semibold)).lineLimit(1)
            }
            Spacer(minLength: 4)
            if band.status == .looking || band.preview == .loading { ProgressView().controlSize(.mini) }
            Button("Open") { store.openPeekSelection() }
                .disabled(band.current == nil)
                .help(band.current == nil ? Text("Nothing to open — no definition was found") : Text("Jump there — Back (⌃-) returns here (↩)"))
                .accessibilityIdentifier("Peek open")
            Button("Find References") {
                let symbol = band.symbol
                let from = band.from
                Task { await store.findReferences(symbol, from: from) }
            }
            .help("Every line that holds this name as a whole word (⇧F12)")
            .accessibilityIdentifier("Peek find references")
            Button { store.codeNav.peek.close() } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                .buttonStyle(.borderless)
                .help("Close the peek (Esc)")
                .accessibilityLabel(Text("Close the peek"))
                .accessibilityIdentifier("Peek close")
        }
        .controlSize(.small)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color.accentColor.wash(colorScheme, light: 0.07, dark: 0.12))
    }

    private var previewSymbol: NavSymbol? {
        if case let .loaded(p) = band.preview, p.path == band.current?.path, p.line == band.current?.line { return p.symbol }
        return nil
    }

    // MARK: Body

    @ViewBuilder
    private var content: some View {
        switch band.status {
        case .looking:
            Text("Looking for \(band.symbol)…").font(.callout).foregroundStyle(.secondary).padding(10)
        case .notFound:
            CodeNavPeekNote(symbol: band.symbol, from: band.from, message: String(localized: "No definition found for \(band.symbol)"))
        case let .failed(message):
            CodeNavPeekNote(symbol: band.symbol, from: band.from, message: message)
        case .found:
            HStack(alignment: .top, spacing: 0) {
                lines
                    .frame(maxWidth: .infinity, alignment: .leading)
                if band.candidates.count > 1 {
                    Divider()
                    CodeNavPeekCandidates(band: band)
                        .frame(width: 240)
                }
            }
        }
    }

    @ViewBuilder
    private var lines: some View {
        switch band.preview {
        case let .loaded(p):
            CodeNavPreviewLines(preview: p, marked: p.line)
        case let .failed(message):
            Label(message, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.secondary).padding(10)
        case .loading, nil:
            Color.clear.frame(height: CodeNavPreviewLines.lineHeight * 4)
        }
    }
}

/// The candidates of a peek, best first: "Name.kt:42", the container, the folder; a click shows it, a double-click opens.
private struct CodeNavPeekCandidates: View {
    @Environment(AppState.self) private var store
    let band: CodeNavPeekStore.Band

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(band.candidates.enumerated()), id: \.offset) { index, c in
                        row(c, selected: index == band.selected)
                            .id(index)
                            .contentShape(Rectangle())
                            .onTapGesture(count: 2) {
                                Task {
                                    await store.peekSelect(index)
                                    store.openPeekSelection()
                                }
                            }
                            .onTapGesture { Task { await store.peekSelect(index) } }
                    }
                }
            }
            .frame(maxHeight: CodeNavPreviewLines.lineHeight * 15 + 8)
            .onChange(of: band.selected) { _, index in proxy.scrollTo(index) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Peek candidates")
    }

    private func row(_ c: DefinitionCandidate, selected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: "\((c.path as NSString).lastPathComponent):\(c.line)").font(.caption.weight(.medium)).lineLimit(1)
            Text(verbatim: [c.container, (c.path as NSString).deletingLastPathComponent].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.2) : Color.clear)
        .help(Text("\(c.path):\(c.line) — double-click to open"))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("Peek candidate \(c.path):\(c.line)")
    }
}

/// Nothing found (or the lookup failed): the line and the next steps.
private struct CodeNavPeekNote: View {
    @Environment(AppState.self) private var store
    let symbol: String
    let from: CodeNavLocation
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Label(message, systemImage: "questionmark.circle").font(.callout)
            Spacer(minLength: 4)
            Button("Find in Project") {
                store.codeNav.peek.close()
                Task { await store.searchProject(word: IdeNavText.bare(symbol)) }
            }
            .help("Search the project for this word (⇧⌘F)")
            .accessibilityIdentifier("Peek find in project")
        }
        .controlSize(.small)
        .padding(10)
    }
}

/// A definition's kind as a small capsule ("method", "class").
struct KindBadge: View {
    let kind: DefinitionKind

    var body: some View {
        Text(verbatim: kind.rawValue)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }
}

// MARK: - The hover card

/// §65.8: ⌘ held over a name for a moment — its declaration in bold, where it is, and its first lines.
struct CodeNavHoverCard: View {
    let card: CodeNavHoverStore.Card

    var body: some View {
        let c = card.candidate
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: card.preview.symbol?.signature ?? c.preview)
                .font(.system(.body, design: .monospaced).weight(.bold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Text(verbatim: "\((c.path as NSString).lastPathComponent):\(c.line)").font(.caption.weight(.medium))
                if let container = card.preview.symbol?.container ?? c.container {
                    Text(verbatim: container).font(.caption).foregroundStyle(.secondary)
                }
                if !c.kind.rawValue.isEmpty { KindBadge(kind: c.kind) }
                Spacer(minLength: 0)
            }
            .help(c.path)
            Divider()
            CodeNavPreviewLines(preview: card.preview, marked: card.preview.line, visible: 12)
            if card.others > 0 {
                Text("\(card.others) more — ⌥F12 shows them all").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(width: 520, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Hover definition card")
    }
}
