import SwiftUI
import ReviewGateCore

/// §14: one file of a past review round (`history_diff`), read-only in the diff pane — under a "Viewing history"
/// banner with the way back to the current review. The notes sent back in that round sit under their lines.
struct HistoryDiffView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppState.self) private var store
    /// Leaves the history (closes the selection and returns to the Changes tab).
    let onBack: () -> Void
    @State private var highlighted: [AttributedString]?
    // MARK: wave2 mac-diff
    @Environment(WindowModel.self) private var model
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    @State private var find = DiffFindModel()
    @State private var maxColumns = 0
    // MARK: wave4c w4c-review — §41.3 "Show 20 more lines" from the round's own tree
    @State private var more = DiffMoreLines()
    /// The lines picked for ⌘C / "Copy selected lines" (a click, ⇧-click, a drag over the rows).
    @State private var lineSelection = DiffLineSelection()

    private struct HighlightKey: Equatable {
        let selection: HistorySelection?
        let lineCount: Int
        let dark: Bool
    }

    /// wave2 mac-diff: the widest line is measured again for another diff, or when wrapping is turned off.
    private struct ColumnsKey: Equatable {
        let selection: HistorySelection?
        let lineCount: Int
        let wrap: Bool
    }

    var body: some View {
        VStack(spacing: 0) {
            banner
            Divider()
            if let selection = store.historySelection {
                if let entry = store.historyEntry, let file = store.historyFile {
                    header(entry: entry, file: file)
                    Divider()
                }
                content(selection)
            } else {
                ContentUnavailableView("Pick a past review", systemImage: "clock.arrow.circlepath",
                                       description: Text("Select a file under a review in the history list to see what that round proposed."))
                    .frame(maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: HighlightKey(selection: store.historySelection, lineCount: store.historyDiff?.allLines.count ?? -1, dark: colorScheme == .dark)) {
            highlighted = nil
            guard let path = store.historySelection?.path, let diff = store.historyDiff, !diff.isBinary else { return }
            let lines = diff.allLines
            guard !lines.isEmpty, lines.count <= DiffDisplay.foldLineThreshold else { return }   // wave2 mac-diff: as the review diff
            let result = await DiffRow.highlight(lines, path: path, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        // MARK: wave2 mac-diff
        .task(id: ColumnsKey(selection: store.historySelection, lineCount: store.historyDiff?.allLines.count ?? -1, wrap: wrapLines)) {
            maxColumns = 0
            guard !wrapLines, let diff = store.historyDiff else { return }
            let texts = diff.allLines.map(\.text)
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
        // MARK: wave4c w4c-review: another file / diff starts with nothing revealed (or picked)
        .onChange(of: store.historySelection) { _, _ in
            more = DiffMoreLines()
            lineSelection.clear()
        }
        .onChange(of: store.historyDiff) { _, _ in
            more = DiffMoreLines()
            lineSelection.clear()
        }
    }

    private var banner: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(.purple)
            Text("Viewing history — read only").font(.callout.weight(.semibold)).fixedSize()
            // Narrow panes drop the explanation instead of wrapping the title.
            ViewThatFits(in: .horizontal) {
                Text("Nothing here changes the current review.").font(.caption).foregroundStyle(.secondary).fixedSize()
                Color.clear.frame(width: 0, height: 0)
            }
            Spacer(minLength: 4)
            Button("Back to current review", systemImage: "arrow.uturn.left") {
                store.closeHistoryDiff()
                onBack()
            }
            .controlSize(.small)
            .fixedSize()
            .accessibilityIdentifier("Back to current review")
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.purple.wash(colorScheme, light: 0.10, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("History banner")
    }

    private func header(entry: ReviewHistoryEntry, file: ReviewHistoryFile) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(file.status.rawValue)
                    .font(.caption.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(file.status))
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: file.path).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    if let old = file.oldPath, old != file.path {
                        Text("from \(old)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(verbatim: "+\(file.adds)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                Text(verbatim: "−\(file.dels)").font(.caption.monospacedDigit()).foregroundStyle(.red)
                VerdictChip(verdict: file.verdict)
                DiffLineOptions { model.diffFindTick += 1 }   // wave2 mac-diff: 줄바꿈, diff에서 찾기
                // §21: a side question about what this round proposed.
                AskWhyButton(anchor: SideAnchor(path: file.path, entryId: entry.id))
            }
            HStack(spacing: 6) {
                Image(systemName: "text.quote").font(.caption).foregroundStyle(.secondary)
                Text(verbatim: entry.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                if let date = entry.endedDate {
                    Text(verbatim: date.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if file.verdict == .rejected {
                Label("Rejected in that round: this is what Claude proposed, not what is on disk.", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            // MARK: wave4 w4-history — §38.3: why that round changed the file (its chat's reason), like the live diff's.
            if let why = store.historyWhy, let line = WhyDisplay.line(why) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Why it changed").font(.caption.weight(.semibold))
                    WhyLineView(line: line)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("History why")
            }
            let fileNotes = entry.notes(for: file.path).filter { $0.line == nil }
            ForEach(Array(fileNotes.enumerated()), id: \.offset) { _, note in
                HistoryNoteBubble(note: note)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder
    private func content(_ selection: HistorySelection) -> some View {
        if let error = store.historyDiffError {
            ContentUnavailableView("Diff unavailable", systemImage: "exclamationmark.triangle", description: Text(verbatim: error))
                .frame(maxHeight: .infinity)
        } else if let diff = store.historyDiff {
            if diff.isBinary {
                ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                       description: Text("No textual diff is available for this file."))
            } else if diff.hunks.isEmpty {
                ContentUnavailableView("No changes", systemImage: "doc.text",
                                       description: Text("The patch for this file is empty."))
            } else {
                let notes = store.historyEntry?.notes(for: selection.path).filter { $0.line != nil } ?? []
                // MARK: wave4c w4c-review — the rows with "Show 20 more lines" between the hunks (a modified / renamed file)
                let offers = store.historyFile.map { ReviewLeftovers.historyOffersContext(status: $0.status, isBinary: diff.isBinary) } ?? false
                let items = more.items(diff, truncated: store.historyDiffTruncated, offersContext: offers)
                let picked = lineSelection.isEmpty ? [] : lineSelection.keys(in: items.map(DiffPlanList.rowKey))
                VStack(spacing: 0) {
                    if store.historyDiffTruncated {
                        Label("Diff truncated at \(DiffView.collapseThreshold.formatted()) lines", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                            .padding(6)
                    }
                    // wave2 mac-diff: wrapped or scrolled sideways together (DiffLinesList), find in diff, copy.
                    DiffLinesList(wrap: wrapLines, maxColumns: maxColumns, gutter: DiffCodeMetrics.diffGutter, resetKey: AnyHashable(selection),
                                  scrollTarget: find.state.currentKey, scrollTick: find.scrollTick, scrollColumn: find.currentColumn) {
                        ForEach(items) { item in
                          // MARK: wave7 w7-state — §45.2: one List row per item (the line and its notes stacked), so the List
                          // knows its rows from the items alone. The item's id is the row's key (what find in diff scrolls to):
                          // no `.id()` on the row, which would make the List build every row on each pick.
                          VStack(alignment: .leading, spacing: 0) {
                            switch item.kind {
                            case .line(let line), .context(let line):
                              let key = DiffDisplayItem.key(line)
                              let isPicked = line.kind != .hunkHeader && picked.contains(key)
                              DiffRow(line: line, highlighted: highlighted.flatMap { line.id >= 0 && $0.indices.contains(line.id) ? $0[line.id] : nil },
                                      findQuery: find.activeQuery, isCurrentMatch: find.isCurrent(key), selected: isPicked)
                                  // A click picks the line, ⇧-click / a drag the lines up to it, for ⌘C and "Copy selected lines".
                                  .diffLinePicking(select: { extend in
                                      if line.kind != .hunkHeader { lineSelection.select(key, extend: extend) }
                                  }, dragTo: { index in
                                      guard items.indices.contains(index) else { return }
                                      lineSelection.select(DiffPlanList.rowKey(items[index]), extend: true)
                                  })
                                  .contextMenu {
                                      if line.kind != .hunkHeader {
                                          SideQuestionMenuItems(anchor: SideAnchor(path: selection.path, line: line.kind == .del ? line.oldNo : line.newNo,
                                                                                   side: line.kind == .del ? .old : .new, entryId: selection.entryId),
                                                                whyTitle: "Ask Why This Line Changed", composeTitle: "Ask About This Line…")
                                          Divider()
                                          DiffLineCopyMenuItems(line: line, path: selection.path,
                                                                copySelected: isPicked && picked.count > 1 ? { copySelectedLines(items) } : nil)
                                      }
                                  }
                              if line.kind != .hunkHeader {
                                  ForEach(Array(notesOn(line, notes).enumerated()), id: \.offset) { _, note in
                                      HistoryNoteBubble(note: note)
                                          .padding(EdgeInsets(top: 2, leading: DiffRow.gutterWidth * 2 + 20, bottom: 2, trailing: 12))
                                  }
                              }
                            default:
                              // MARK: wave4c w4c-review — §41.3
                              MoreLinesExpanderRow(item: item, more: $more) { gap, direction in
                                  revealMoreLines($more, gap: gap, direction: direction, diff: diff) {
                                      try await store.historyFileLines(entryId: selection.entryId, path: selection.path)
                                  }
                              }
                            }
                          }
                          .listRowInsets(EdgeInsets())
                          .listRowSeparator(.hidden)
                        }
                    }
                    .diffLineCopying(revision: lineSelection.revision) { selectedLinesText(items) }
                    .diffFind(find, rows: { DiffMoreLines.findRows(items) },
                              rowsKey: AnyHashable([AnyHashable(selection), AnyHashable(diff.hunks.count), AnyHashable(diff.hunks.last?.lines.last?.id), AnyHashable(items.count)]),
                              tick: model.diffFindTick)
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

    /// The picked lines' code, in display order (`DiffLineSelection`).
    private func selectedLinesText(_ items: [DiffDisplayItem]) -> String? {
        guard let range = lineSelection.range(in: items.map(DiffPlanList.rowKey)) else { return nil }
        let lines = items[range].compactMap { item -> DiffLine? in
            switch item.kind {
            case let .line(line), let .context(line): line
            default: nil
            }
        }
        return DiffLineSelection.copyText(lines)
    }

    private func copySelectedLines(_ items: [DiffDisplayItem]) {
        if let text = selectedLinesText(items) { DiffLineCopyMenuItems.copy(text) }
    }

    private func notesOn(_ line: DiffLine, _ notes: [ReviewHistoryNote]) -> [ReviewHistoryNote] {
        let side: DiffSide = line.kind == .del ? .old : .new
        let number = line.kind == .del ? line.oldNo : line.newNo
        return notes.filter { $0.side == side && $0.line == number }
    }
}

/// A note sent back in a past round (read-only).
private struct HistoryNoteBubble: View {
    @Environment(\.colorScheme) private var colorScheme
    let note: ReviewHistoryNote

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text("Note")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.orange.wash(colorScheme, light: 0.20, dark: 0.28), in: Capsule())
                .foregroundStyle(.orange)
            if let line = note.line {
                Text(verbatim: "\(note.side == .old ? "−" : "+")\(line)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(verbatim: note.body)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(Color.orange.wash(colorScheme, light: 0.08, dark: 0.14), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityIdentifier("History note")
    }
}
