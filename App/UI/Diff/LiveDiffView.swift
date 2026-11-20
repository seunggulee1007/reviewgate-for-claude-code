import SwiftUI
import ReviewGateCore

/// wave2 mac-flow — §34.6: one file of the running turn's changes so far (`live_diff`), read-only in the diff pane under
/// an "진행 중 변경 (아직 수락 불가)" banner. Nothing here can be accepted: the file reaches the review when the turn is
/// collected, and the pane then turns into it by itself.
struct LiveDiffView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    @State private var highlighted: [AttributedString]?
    /// The lines picked for ⌘C / "Copy selected lines" (a click, ⇧-click, a drag over the rows).
    @State private var lineSelection = DiffLineSelection()
    // As the other diff panes (HistoryDiffView): wrap or scroll sideways together, find in diff (⌥⌘F).
    @Environment(WindowModel.self) private var model
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    @State private var find = DiffFindModel()
    @State private var maxColumns = 0

    private struct HighlightKey: Equatable {
        let path: String?
        let lineCount: Int
        let dark: Bool
    }

    /// The widest line is measured again for another diff, or when wrapping is turned off.
    private struct ColumnsKey: Equatable {
        let path: String?
        let lineCount: Int
        let wrap: Bool
    }

    /// Find in diff searches again when the rows change (another file, a refresh).
    private struct FindRowsKey: Equatable {
        let path: String
        let diff: FileDiff
    }

    /// The live diff's line count without building every line per body.
    private var lineCount: Int { store.liveDiff.map { $0.hunks.reduce(0) { $0 + $1.lines.count } } ?? -1 }

    var body: some View {
        VStack(spacing: 0) {
            banner
            Divider()
            if let path = store.liveSelection {
                header(path)
                Divider()
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .diffSplitWidth()   // §34.11
        // MARK: wave7 w7-state — §45.2: the count without building every line per body; at most 3 000 lines are coloured, as
        // in the review diff (a larger one shows plain).
        .task(id: HighlightKey(path: store.liveSelection, lineCount: lineCount, dark: colorScheme == .dark)) {
            highlighted = nil
            guard let path = store.liveSelection, let diff = store.liveDiff, !diff.isBinary else { return }
            let lines = diff.allLines
            guard !lines.isEmpty, lines.count <= DiffDisplay.foldLineThreshold else { return }
            let result = await DiffRow.highlight(lines, path: path, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        .task(id: ColumnsKey(path: store.liveSelection, lineCount: lineCount, wrap: wrapLines)) {
            maxColumns = 0
            guard !wrapLines, let diff = store.liveDiff else { return }
            let texts = diff.allLines.map(\.text)
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
        .onChange(of: store.liveSelection) { _, _ in lineSelection.clear() }
        .onChange(of: store.liveDiff) { _, _ in lineSelection.clear() }   // refreshed: the line ids are another diff's
    }

    private var banner: some View {
        HStack(spacing: 8) {
            Image(systemName: "hammer.fill").foregroundStyle(.orange)
            Text("In progress (can't accept yet)").font(.callout.weight(.semibold)).fixedSize()
            // A narrow pane keeps the way back as its icon (the title stays whole).
            FullOrCompact { _ in
                HStack { Spacer(minLength: 4); refreshButton; backButton }
            } compact: {
                HStack { Spacer(minLength: 4); refreshButton; backButton.labelStyle(.iconOnly) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Live diff banner")
    }

    private var refreshButton: some View {
        Button("Refresh", systemImage: "arrow.clockwise") {
            guard let path = store.liveSelection else { return }
            Task {
                await store.refreshLiveChanges()
                await store.openLiveDiff(path)
            }
        }
        .labelStyle(.iconOnly)
        .controlSize(.small)
        .fixedSize()
        .disabled(store.isLoadingLiveChanges || !(store.isRunning || store.isSnapshotting))
        .help("Refresh")
        .accessibilityIdentifier("Refresh live diff")
    }

    private var backButton: some View {
        Button("Back to current review", systemImage: "arrow.uturn.left") { store.closeLiveDiff() }
            .controlSize(.small)
            .fixedSize()
            .help("Back to current review")
            .accessibilityIdentifier("Back from live diff")
    }

    private func header(_ path: String) -> some View {
        let file = store.liveChanges?.files.first { $0.path == path }
        return HStack(spacing: 8) {
            if let file {
                Text(file.status.rawValue)
                    .font(.caption.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(file.status))
                    .frame(width: 14)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: path).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                if let old = file?.oldPath, old != path {
                    Text("from \(old)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let file {
                Text(verbatim: "+\(file.added)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                Text(verbatim: "−\(file.deleted)").font(.caption.monospacedDigit()).foregroundStyle(.red)
            }
            DiffLineOptions { model.diffFindTick += 1 }   // 줄바꿈, diff에서 찾기
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder
    private var content: some View {
        if let error = store.liveDiffError {
            ContentUnavailableView("Diff unavailable", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
                .frame(maxHeight: .infinity)
        } else if let diff = store.liveDiff {
            if diff.isBinary {
                ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                       description: Text("No textual diff is available for this file."))
            } else if diff.hunks.isEmpty {
                ContentUnavailableView("No changes", systemImage: "doc.text",
                                       description: Text("The patch for this file is empty."))
            } else {
                VStack(spacing: 0) {
                    if store.liveDiffTruncated {
                        Label("Diff truncated at \(DiffView.collapseThreshold.formatted()) lines", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .padding(6)
                    }
                    let lines = diff.allLines
                    let picked = lineSelection.isEmpty ? [] : lineSelection.keys(in: lines.map(\.rowKey))
                    DiffSplitReader { split in
                        // §34.11: split rows only while split is shown; a drag picks by the List's rows, the split ones then.
                        let layout = split ? DiffSplit.layout(lines: lines) : nil
                        let rows = layout?.rows
                        let rowKey: (Int) -> String? = { index in
                            if let rows { return rows.indices.contains(index) ? rows[index].id : nil }
                            return lines.indices.contains(index) ? lines[index].rowKey : nil
                        }
                        DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: split ? DiffCodeMetrics.splitGutter : DiffCodeMetrics.diffGutter,
                                      resetKey: AnyHashable(store.liveSelection),
                                      scrollTarget: layout?.rowId(forLineKey: find.state.currentKey) ?? find.state.currentKey,
                                      scrollTick: find.scrollTick, scrollColumn: find.currentColumn, split: split) {
                            if let layout {
                                ForEach(layout.rows) { row in
                                    Group {
                                        switch row.kind {
                                        case let .pair(left, right):
                                            DiffSplitPair(left: left, right: right) { line, side in
                                                lineRow(line, side: side, lines: lines, picked: picked, rowKey: rowKey)
                                            }
                                        case let .item(item):
                                            if case let .line(line) = item.kind {
                                                lineRow(line, side: nil, lines: lines, picked: picked, rowKey: rowKey)
                                            }
                                        }
                                    }
                                    .listRowInsets(EdgeInsets())
                                    .listRowSeparator(.hidden)
                                }
                            } else {
                                // The rows' ids are their keys (what find in diff scrolls to), the ForEach's own: a `.id()` on each
                                // row would make the List build every row to learn its id, on each pick (a click, each row a drag
                                // crosses).
                                ForEach(lines, id: \.rowKey) { line in
                                    lineRow(line, side: nil, lines: lines, picked: picked, rowKey: rowKey)
                                        .listRowInsets(EdgeInsets())
                                        .listRowSeparator(.hidden)
                                }
                            }
                        }
                    }
                    .diffLineCopying(revision: lineSelection.revision) { selectedLinesText(lines) }
                    .diffFind(find, rows: { lines.map { DiffFind.Row(key: DiffDisplayItem.key($0), text: $0.text) } },
                              rowsKey: FindRowsKey(path: store.liveSelection ?? "", diff: diff), tick: model.diffFindTick)
                }
            }
        } else {
            VStack(spacing: 8) {
                ProgressView()
                Text("Loading diff…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// A line row (`side`: one side of a split row, §34.11). `rowKey`: the line key of the List row at an index, for a drag.
    private func lineRow(_ line: DiffLine, side: DiffSide?, lines: [DiffLine], picked: Set<String>, rowKey: @escaping (Int) -> String?) -> some View {
        let key = line.rowKey
        let isPicked = line.kind != .hunkHeader && picked.contains(key)
        return DiffRow(line: line, highlighted: highlighted.flatMap { $0.indices.contains(line.id) ? $0[line.id] : nil },
                       findQuery: find.activeQuery, isCurrentMatch: find.isCurrent(key), selected: isPicked, splitSide: side)
            // A click picks the line, ⇧-click / a drag the lines up to it, for ⌘C and "Copy selected lines".
            .diffLinePicking(select: { extend in
                if line.kind != .hunkHeader { lineSelection.select(key, extend: extend) }
            }, dragTo: { index in
                guard let key = rowKey(index) else { return }
                lineSelection.select(key, extend: true)
            })
            .contextMenu {
                if line.kind != .hunkHeader {
                    DiffLineCopyMenuItems(line: line, path: store.liveSelection,
                                          copySelected: isPicked && picked.count > 1 ? { copySelectedLines(lines) } : nil)
                }
            }
    }

    /// The picked lines' code, in display order (`DiffLineSelection`).
    private func selectedLinesText(_ lines: [DiffLine]) -> String? {
        guard let range = lineSelection.range(in: lines.map(\.rowKey)) else { return nil }
        return DiffLineSelection.copyText(lines[range])
    }

    private func copySelectedLines(_ lines: [DiffLine]) {
        if let text = selectedLinesText(lines) { DiffLineCopyMenuItems.copy(text) }
    }
}

private extension DiffLine {
    /// The row's key (`DiffDisplayItem.key`): its id in the List, what find in diff scrolls to.
    var rowKey: String { DiffDisplayItem.key(self) }
}
