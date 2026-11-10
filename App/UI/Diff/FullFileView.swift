import SwiftUI
import ReviewGateCore

/// Read-only view of the whole worktree file (`AppState.fullFile(for:)`): every line with a gutter,
/// changed lines tinted green, deleted old lines shown inline in red after the line they followed,
/// syntax-highlighted as one document so multi-line tokens stay right. Scrolls to the first change.
/// wave2 mac-diff: lines wrap or scroll sideways together (`DiffLinesList`), find in diff (⌥⌘F) searches the file,
/// and a row's menu copies the line or `path:line`.
struct FullFilePane: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme

    let file: ChangedFile
    /// The review's B (`AppState.reviewTree`): a new one (the next turn, ⌘R) reads the file again.
    let tree: String?
    /// Find in diff: the diff pane's, so an open bar and its query stay when the view changes.
    let find: DiffFindModel

    @State private var content: FullFileView?
    @State private var loadError: String?
    @State private var highlighted: [AttributedString]?
    // MARK: wave2 mac-diff
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    @State private var maxColumns = 0
    // MARK: wave4c w4c-review — §41.3: the review diff's in-line changes on the full file's rows
    @State private var marks = FullFileEmphasis()
    /// wave7 w7-state (§45.2): the rows in display order, built once per loaded file.
    @State private var rowsCache = FullFileRowsCache()
    /// The lines picked for ⌘C / "Copy selected lines" (a click, ⇧-click, a drag over the rows).
    @State private var lineSelection = DiffLineSelection()

    private static let font = DiffRow.font

    var body: some View {
        Group {
            if let loadError {
                ContentUnavailableView("Could not load file", systemImage: "exclamationmark.triangle",
                                       description: Text(verbatim: loadError))
            } else if let content {
                if content.isBinary {
                    ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                           description: Text("No textual view is available for this file."))
                } else if content.isTooLarge {
                    ContentUnavailableView("File too large", systemImage: "doc.text.magnifyingglass",
                                           description: Text("Files over 20,000 lines or 2 MB are not shown in full; use the diff view."))
                } else {
                    lines(content)
                        .diffFind(find, rows: { Self.findRows(content) }, rowsKey: AnyHashable(content.lines.count), tick: model.diffFindTick)
                }
            } else {
                VStack(spacing: 8) {
                    ProgressView()
                    Text("Loading file…").font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("Full file view")
        .task(id: LoadKey(path: file.path, tree: tree)) {
            // No B while this turn runs (a fresh review): the file loaded for this path stays on screen, read-only.
            if tree == nil, content?.path == file.path { return }
            content = nil
            loadError = nil
            highlighted = nil
            lineSelection.clear()
            do {
                let loaded = try await store.fullFile(for: file)
                guard !Task.isCancelled else { return }
                content = loaded
            } catch {
                guard !Task.isCancelled else { return }
                loadError = error.localizedDescription
            }
        }
        .task(id: HighlightKey(path: file.path, lineCount: content?.lines.count ?? -1, dark: colorScheme == .dark)) {
            highlighted = nil
            guard let content, !content.isBinary, !content.isTooLarge, !content.lines.isEmpty else { return }
            let language = await SyntaxHighlighter.shared.language(forPath: file.path)
            let result = await SyntaxHighlighter.shared.highlightDocument(
                content.lines.joined(separator: "\n"), language: language, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        // MARK: wave4c w4c-review: the selected diff is this file's in the same range (the pane is rebuilt per range)
        .onChange(of: store.selectedDiff, initial: true) { _, diff in
            marks = store.selectedFile?.path == file.path ? diff.map { FullFileEmphasis(diff: $0) } ?? FullFileEmphasis() : FullFileEmphasis()
        }
        .task(id: ColumnsKey(path: file.path, lines: content?.lines.count ?? -1, wrap: wrapLines)) {
            guard !wrapLines, let content else { return }
            let texts = content.lines + content.deletedAfterNewLine.values.flatMap { $0 }
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
    }

    private struct LoadKey: Equatable {
        let path: String
        let tree: String?
    }

    private struct HighlightKey: Equatable {
        let path: String
        let lineCount: Int
        let dark: Bool
    }

    private struct ColumnsKey: Equatable {
        let path: String
        let lines: Int
        let wrap: Bool
    }

    private func lines(_ content: FullFileView) -> some View {
        let keys = rowsCache.keys(content)
        let picked = lineSelection.isEmpty ? [] : lineSelection.keys(in: keys)
        return ScrollViewReader { proxy in
            DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: DiffCodeMetrics.fileGutter, resetKey: AnyHashable(file.path),
                          scrollTarget: find.state.currentKey, scrollTick: find.scrollTick, scrollColumn: find.currentColumn) {
                // MARK: wave7 w7-state — §45.2: one List row per element — the file's lines and the deleted lines after each
                // (before line 1 too) in display order, each with its own key — so the List knows its rows without building them.
                // The ids are the ForEach's own (the keys find and the first-change scroll go to): a `.id()` on each row would
                // make the List build all of them to learn their ids, on every pick (a click, each row a drag crosses).
                ForEach(keys, id: \.self) { key in
                    let item = Self.row(key)
                    let copySelected: (() -> Void)? = picked.count > 1 && picked.contains(key) ? { copySelectedLines(content) } : nil
                    VStack(spacing: 0) {
                        switch item {
                        case let .line(number):
                            row(number: number, text: content.lines[number - 1], changed: content.changedNewLines.contains(number),
                                copySelected: copySelected)
                        case let .deleted(anchor, offset):
                            deletedRow(content.deletedAfterNewLine[anchor]?[offset] ?? "", anchor: anchor, offset: offset,
                                       copySelected: copySelected)
                        }
                    }
                    .background(picked.contains(key) ? DiffRow.selectionFill : Color.clear)
                    // A click picks the line, ⇧-click / a drag the lines up to it, for ⌘C and "Copy selected lines".
                    .diffLinePicking(select: { extend in lineSelection.select(key, extend: extend) }, dragTo: { index in
                        guard keys.indices.contains(index) else { return }
                        lineSelection.select(keys[index], extend: true)
                    })
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                }
            }
            .diffLineCopying(revision: lineSelection.revision) { selectedLinesText(content) }
            .onAppear { scrollToFirstChange(content, proxy: proxy) }
        }
    }

    /// The picked rows' code, in display order (`DiffLineSelection`).
    private func selectedLinesText(_ content: FullFileView) -> String? {
        let rows = rowsCache.rows(content)
        guard let range = lineSelection.range(in: rowsCache.keys(content)) else { return nil }
        return rows[range].map { item in
            switch item {
            case let .line(number): content.lines[number - 1]
            case let .deleted(anchor, offset): content.deletedAfterNewLine[anchor]?[offset] ?? ""
            }
        }.joined(separator: "\n")
    }

    private func copySelectedLines(_ content: FullFileView) {
        if let text = selectedLinesText(content) { DiffLineCopyMenuItems.copy(text) }
    }

    private func scrollToFirstChange(_ content: FullFileView, proxy: ScrollViewProxy) {
        let firstChanged = content.changedNewLines.min()
        let firstDeleted = content.deletedAfterNewLine.keys.min()
        guard let target = [firstChanged, firstDeleted].compactMap({ $0 }).min() else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            proxy.scrollTo(Self.lineKey(max(target, 1)), anchor: .center)
        }
    }

    private func row(number: Int, text: String, changed: Bool, copySelected: (() -> Void)?) -> some View {
        let key = Self.lineKey(number)
        let kind: DiffLineKind = changed ? .add : .context
        // wave4c w4c-review: an added line keeps the diff's changed parts (while its text is still the diff's).
        let line = (changed ? marks.added[number]?.line(id: number, kind: kind, newNo: number, text: text) : nil)
            ?? DiffLine(id: number, kind: kind, oldNo: nil, newNo: number, text: text)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            gutter(String(number))
            Text(changed ? "+" : " ")
                .font(Self.font)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            DiffCodeText(text: text, styled: styled(line, base: highlight(number - 1), key: key), faint: line.wsOnly)
                .font(Self.font)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(changed ? Color.green.wash(colorScheme, light: 0.15, dark: 0.14) : Color.clear)
        .contentShape(Rectangle())
        .contextMenu { DiffLineCopyMenuItems(line: line, path: file.path, copySelected: copySelected) }
    }

    /// One deleted old line, after new line `anchor` (0: before line 1).
    private func deletedRow(_ text: String, anchor: Int, offset: Int, copySelected: (() -> Void)?) -> some View {
        let key = Self.deletedKey(anchor, offset)
        let line = marks.deletedLine(anchor: anchor, offset: offset)?.line(id: -1, kind: .del, newNo: nil, text: text)   // wave4c w4c-review
            ?? DiffLine(id: -1, kind: .del, oldNo: nil, newNo: nil, text: text)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            gutter("")
            Text("−")
                .font(Self.font)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            DiffCodeText(text: text, styled: styled(line, base: Self.red(text), key: key), faint: line.wsOnly)
                .font(Self.font)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.wash(colorScheme, light: 0.15, dark: 0.14))
        .contentShape(Rectangle())
        .contextMenu { DiffLineCopyMenuItems(line: line, path: nil, copySelected: copySelected) }
    }

    /// A deleted line's text in red (the highlighter colours only the new content).
    private static func red(_ text: String) -> AttributedString {
        var s = AttributedString(text)
        s.swiftUI.foregroundColor = .red
        return s
    }

    private func highlight(_ index: Int) -> AttributedString? {
        guard let highlighted, highlighted.indices.contains(index) else { return nil }
        return highlighted[index]
    }

    /// The row's text with find-in-diff matches marked, and (wave4c w4c-review, §41.3) the review diff's changed parts of
    /// the line — the same marks as the diff's rows (`DiffRow`).
    private func styled(_ line: DiffLine, base: AttributedString?, key: String) -> AttributedString {
        let query = find.activeQuery
        let ranges = query.isEmpty ? [] : DiffFind.ranges(of: query, in: DiffLineText.shown(line.text).text)
        let emphasis: Color? = line.segments.isEmpty ? nil
            : line.kind == .del ? Color.red.wash(colorScheme, light: 0.30, dark: 0.36) : Color.green.wash(colorScheme, light: 0.32, dark: 0.36)
        return DiffLineText.styled(line, base: base, emphasis: emphasis, find: ranges,
                                   findColor: Color.yellow.opacity(find.isCurrent(key) ? 0.85 : 0.45))
    }

    private func gutter(_ label: String) -> some View {
        Text(verbatim: label)
            .font(Self.font)
            .foregroundStyle(.secondary)
            .frame(width: DiffRow.gutterWidth, alignment: .trailing)
            .padding(.trailing, 6)
    }

    // MARK: Find in diff

    static func lineKey(_ number: Int) -> String { "F\(number)" }
    static func deletedKey(_ anchor: Int, _ offset: Int) -> String { "D\(anchor)-\(offset)" }

    /// wave7 w7-state (§45.2): a row's key — what find in diff and the first-change scroll go to.
    static func key(_ row: FullFileRow) -> String {
        switch row {
        case let .line(number): lineKey(number)
        case let .deleted(anchor, offset): deletedKey(anchor, offset)
        }
    }

    /// The row a key names (`key(_:)` the other way round: the List's rows are the keys).
    static func row(_ key: String) -> FullFileRow {
        let numbers = key.dropFirst().split(separator: "-").compactMap { Int($0) }
        if key.hasPrefix("D"), numbers.count == 2 { return .deleted(anchor: numbers[0], offset: numbers[1]) }
        return .line(numbers.first ?? 1)
    }

    /// Every row in display order: the deleted lines before line 1, then each line followed by the ones deleted after it.
    static func findRows(_ content: FullFileView) -> [DiffFind.Row] {
        var rows: [DiffFind.Row] = []
        rows.reserveCapacity(content.lines.count)
        func deleted(_ anchor: Int) {
            for (offset, text) in (content.deletedAfterNewLine[anchor] ?? []).enumerated() {
                rows.append(DiffFind.Row(key: deletedKey(anchor, offset), text: text))
            }
        }
        deleted(0)
        for (index, text) in content.lines.enumerated() {
            rows.append(DiffFind.Row(key: lineKey(index + 1), text: text))
            deleted(index + 1)
        }
        return rows
    }
}

/// wave7 w7-state (§45.2): the loaded file's rows (`FullFileView.rows`) and their keys, built once per file instead of per
/// body — a pick re-evaluates the body for each click and each row a drag crosses.
@MainActor
final class FullFileRowsCache {
    private var cached: (content: FullFileView, rows: [FullFileRow], keys: [String])?

    func rows(_ content: FullFileView) -> [FullFileRow] { entry(content).rows }

    func keys(_ content: FullFileView) -> [String] { entry(content).keys }

    private func entry(_ content: FullFileView) -> (content: FullFileView, rows: [FullFileRow], keys: [String]) {
        if let cached, cached.content == content { return cached }
        let rows = content.rows
        let entry = (content: content, rows: rows, keys: rows.map(FullFilePane.key))
        cached = entry
        return entry
    }
}
