import SwiftUI
import ReviewGateCore

// MARK: wave7 w7-state — §45.2: the review diff's list. Exactly one List row per plan item (`DiffDisplayItem`): a line row
// stacks its line, its notes, its AI pre-review findings and the open note composer, so the List knows its row count from
// the items alone and evaluates only the rows on screen. The list and each row compare their inputs (`Equatable`), so a
// state change that leaves the diff alone re-runs neither; the notes and findings come keyed by line, looked up per row.

/// What the rows do (closures, never compared). They act on the pane's state and the store, and captured the file and the
/// diff they were drawn with: the rows compare those instead (`DiffPlanRow.file`, `generation`).
struct DiffRowActions {
    var openComposer: (DiffLine) -> Void
    /// A click on a line (`true`: with ⇧, extending the pick).
    var clickLine: (DiffLine, Bool) -> Void
    /// A drag over the rows reached the List row at this index (`diffLinePicking`).
    var dragTo: (Int) -> Void
    /// The picked lines' code (`DiffLineSelection.copyText`); nil when nothing is picked.
    var copySelection: () -> String?
    /// The note being written on this line, put aside with its file (the composer opens with it; "" for none), and every
    /// change of the composer's text.
    var draftText: (DiffLine) -> String
    var draftChanged: (DiffLine, String) -> Void
    var submitNote: (DiffLine, String) -> Void
    var cancelNote: () -> Void
    var setHunk: (Int, Bool) -> Void
    var revertHunk: (Int) -> Void
    var reveal: (Int, ContextDirection) -> Void
    /// "Collapse N lines" on a gap; "Collapse All Shown Lines".
    var collapse: (Int) -> Void
    var collapseAll: () -> Void
    var toggleFoldedHunk: (Int) -> Void
    var toggleFile: () -> Void
    var toggleLarge: () -> Void
}

/// The diff pane's list: the plan's items, one row each.
struct DiffPlanList: View, Equatable {
    let file: ChangedFile
    let diff: FileDiff
    /// `DiffPlanCache.generation(of: diff)`: another diff draws every row again (their actions captured this one).
    let generation: Int
    let items: [DiffDisplayItem]
    let wrap: Bool
    let maxColumns: Int
    /// Per-line syntax colours by `DiffLine.id`, and those of the lines revealed from the full file by new line number.
    let highlighted: [AttributedString]?
    let contextHighlighted: [Int: AttributedString]
    let notes: [NotePlacement.LineKey: [ReviewNote]]
    let findings: [Int: [PreReviewItem]]
    let composerLineId: Int?
    /// Hunk header line id → its `DiffHunk.id` (`reject_hunks`' id).
    let hunkByHeader: [Int: Int]
    let selectedHunks: Set<Int>
    let showsHunkControls: Bool
    let canRejectHunks: Bool
    /// The diff on screen is the whole review (§34.1): old-side lines take notes and side questions.
    let wholeReview: Bool
    let contextLoading: Bool
    let contextBlocked: String?
    /// Some gap shows lines from the full file (`DiffFoldState.hasRevealed`): the expanders' menu collapses them all.
    let anyRevealed: Bool
    /// Find in diff: the marked query, the row it scrolls to (and its tick / column), the current match while the bar is open.
    let findQuery: String
    let scrollTarget: String?
    let scrollTick: Int
    let scrollColumn: Int?
    let currentMatch: String?
    /// The lines picked for copying.
    let selection: DiffLineSelection
    let actions: DiffRowActions

    /// Every input but `actions` (Sendable values only: SwiftUI may compare off the body's isolation).
    nonisolated static func == (a: DiffPlanList, b: DiffPlanList) -> Bool {
        a.file == b.file && a.generation == b.generation && a.diff == b.diff && a.items == b.items && a.wrap == b.wrap
            && a.maxColumns == b.maxColumns
            && a.highlighted == b.highlighted && a.contextHighlighted == b.contextHighlighted && a.notes == b.notes
            && a.findings == b.findings && a.composerLineId == b.composerLineId && a.hunkByHeader == b.hunkByHeader
            && a.selectedHunks == b.selectedHunks && a.showsHunkControls == b.showsHunkControls && a.canRejectHunks == b.canRejectHunks
            && a.wholeReview == b.wholeReview && a.contextLoading == b.contextLoading && a.contextBlocked == b.contextBlocked
            && a.anyRevealed == b.anyRevealed
            && a.findQuery == b.findQuery && a.scrollTarget == b.scrollTarget && a.scrollTick == b.scrollTick
            && a.scrollColumn == b.scrollColumn && a.currentMatch == b.currentMatch && a.selection == b.selection
    }

    var body: some View {
        let picked = selection.isEmpty ? [] : selection.keys(in: items.map(Self.rowKey))
        DiffLinesList(wrap: wrap, maxColumns: maxColumns, gutter: DiffCodeMetrics.diffGutter, resetKey: AnyHashable(file.path),
                      scrollTarget: scrollTarget, scrollTick: scrollTick, scrollColumn: scrollColumn) {
            // The item's id is the row's key (what find in diff scrolls to): no `.id()` on the row, which would make the List
            // build every row on each pick (a click, each row a drag crosses).
            ForEach(items) { item in
                row(item, picked: picked)
                    .equatable()
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
        }
        .diffLineCopying(revision: selection.revision, copy: actions.copySelection)
    }

    /// A row's key: the item's id, which for a line is its `DiffDisplayItem.key` (what find in diff scrolls to).
    static func rowKey(_ item: DiffDisplayItem) -> String { item.id }

    private func row(_ item: DiffDisplayItem, picked: Set<String>) -> DiffPlanRow {
        var row = DiffPlanRow(item: item, file: file, generation: generation, wholeReview: wholeReview, actions: actions)
        switch item.kind {
        case let .line(line), let .context(line):
            row.highlight = highlight(for: line)
            row.findQuery = findQuery
            row.isCurrentMatch = currentMatch == DiffDisplayItem.key(line)
            if line.kind != .hunkHeader, picked.contains(DiffDisplayItem.key(line)) {
                row.selected = true
                row.inMultiSelection = picked.count > 1
            }
            if line.kind != .hunkHeader {
                if let number = DiffView.noteLine(line) {
                    row.notes = notes[NotePlacement.LineKey(side: DiffView.noteSide(line), line: number)] ?? []
                }
                row.composerOpen = composerLineId == line.id
            }
            if line.kind != .del, let number = line.newNo, let found = findings[number] {
                row.hasFindingMark = true
                if line.kind != .hunkHeader { row.findings = found }
            }
            if line.kind == .hunkHeader, let hunkId = hunkByHeader[line.id] {
                row.hunk = DiffPlanRow.HunkHeader(id: hunkId, hunk: diff.hunks.first { $0.id == hunkId }, selected: selectedHunks.contains(hunkId),
                                                  showsControls: showsHunkControls, canReject: canRejectHunks)
            }
        case .expander:
            row.contextLoading = contextLoading
            row.contextBlocked = contextBlocked
            row.canCollapseAll = anyRevealed
        case .foldedHunk, .foldedFile, .largeDiff:
            break
        }
        return row
    }

    private func highlight(for line: DiffLine) -> AttributedString? {
        if line.id < 0 { return contextHighlighted[-line.id] }   // wave2 mac-diff: a line revealed from the full file
        guard let highlighted, highlighted.indices.contains(line.id) else { return nil }
        return highlighted[line.id]
    }
}

/// One plan item's row; equal inputs skip its body.
struct DiffPlanRow: View, Equatable {
    /// A hunk header's part: its id, the hunk (side-question threads anchored in it) and its revert controls.
    struct HunkHeader: Equatable {
        let id: Int
        let hunk: DiffHunk?
        let selected: Bool
        let showsControls: Bool
        let canReject: Bool
    }

    let item: DiffDisplayItem
    /// The file and the diff's generation the actions captured: an expander or a fold equal in a new diff still draws again,
    /// so "Show 20 more lines" checks the new diff, not the one it was first drawn with.
    let file: ChangedFile
    let generation: Int
    let wholeReview: Bool
    var highlight: AttributedString?
    var findQuery = ""
    var isCurrentMatch = false
    var notes: [ReviewNote] = []
    var findings: [PreReviewItem] = []
    var hasFindingMark = false
    var composerOpen = false
    var hunk: HunkHeader?
    var contextLoading = false
    var contextBlocked: String?
    var canCollapseAll = false
    /// Picked for copying, and one of several picked rows (its menu offers "Copy selected lines").
    var selected = false
    var inMultiSelection = false
    let actions: DiffRowActions

    init(item: DiffDisplayItem, file: ChangedFile, generation: Int, wholeReview: Bool, actions: DiffRowActions) {
        self.item = item
        self.file = file
        self.generation = generation
        self.wholeReview = wholeReview
        self.actions = actions
    }

    var path: String { file.path }

    nonisolated static func == (a: DiffPlanRow, b: DiffPlanRow) -> Bool {
        a.item == b.item && a.generation == b.generation && a.file == b.file && a.wholeReview == b.wholeReview && a.highlight == b.highlight
            && a.findQuery == b.findQuery && a.isCurrentMatch == b.isCurrentMatch && a.notes == b.notes && a.findings == b.findings
            && a.hasFindingMark == b.hasFindingMark && a.composerOpen == b.composerOpen && a.hunk == b.hunk
            && a.contextLoading == b.contextLoading && a.contextBlocked == b.contextBlocked && a.canCollapseAll == b.canCollapseAll
            && a.selected == b.selected && a.inMultiSelection == b.inMultiSelection
    }

    static let bubbleInsets = EdgeInsets(top: 2, leading: DiffRow.gutterWidth * 2 + 20, bottom: 2, trailing: 12)

    var body: some View {
        // One view, whatever the item: the List counts its rows without building them.
        VStack(alignment: .leading, spacing: 0) {
            switch item.kind {
            case let .line(line), let .context(line):
                DiffLineStack(row: self, line: line)
            case let .expander(gap, _, up, down, revealed):
                DiffContextExpanderRow(gap: gap, up: up, down: down, revealed: revealed, loading: contextLoading, blocked: contextBlocked,
                                       canCollapseAll: canCollapseAll,
                                       onReveal: { direction in actions.reveal(gap, direction) },
                                       onCollapse: { actions.collapse(gap) },
                                       onCollapseAll: { actions.collapseAll() })
            case let .foldedHunk(hunkId, lines, open):
                DiffFoldRow(kind: .hunk(lines: lines), open: open) { actions.toggleFoldedHunk(hunkId) }
            case let .foldedFile(lines, open):
                DiffFoldRow(kind: .generated(lines: lines), open: open) { actions.toggleFile() }
            case let .largeDiff(lines, open):
                DiffFoldRow(kind: .large(lines: lines), open: open) { actions.toggleLarge() }
            }
        }
    }
}

/// A line menu's "Add Note…", off while a change request's follow-up runs. A view of its own: only it reads the lock, so a
/// turn starting or ending does not draw every row again.
private struct AddNoteMenuItem: View {
    @Environment(AppState.self) private var store
    let action: () -> Void

    var body: some View {
        Button("Add Note…", systemImage: "text.bubble", action: action)
            .disabled(store.isNoteLocked)
    }
}

/// A diff line with its hunk controls (a header), then its notes, findings and the open composer.
private struct DiffLineStack: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let row: DiffPlanRow
    let line: DiffLine

    var body: some View {
        if line.kind == .hunkHeader, let hunk = row.hunk {
            // The controls sit beside the header (which truncates), never on top of its text.
            HStack(spacing: 0) {
                lineRow
                HStack(spacing: 6) {
                    sideHunkControls(hunk)
                    if hunk.showsControls { hunkControls(hunk) }
                }
                .padding(.horizontal, 8)
                .frame(maxHeight: .infinity)
                .background(Color.blue.wash(colorScheme, light: 0.08, dark: 0.16))
            }
            .contextMenu { SideQuestionMenuItems(anchor: SideAnchor(path: row.path, hunkId: hunk.id), whyTitle: "Ask Why This Part Changed") }
        } else {
            lineRow
        }
        if line.kind != .hunkHeader {
            ForEach(row.notes) { note in
                ReviewNoteCard(note: note)   // wave2 mac-flow (§34.4): a sent note reads "요청함: …" with 반영 확인
                    .padding(DiffPlanRow.bubbleInsets)
            }
            // wave3 mac-flow (§36.13): the AI pre-review's findings on this (new-side) line.
            ForEach(row.findings) { item in
                PreReviewFindingCard(item: item, excerpt: line.text)
                    .padding(DiffPlanRow.bubbleInsets)
            }
            if row.composerOpen {
                CommentComposer(
                    submitTitle: String(localized: "Add note"),
                    submitID: "Submit note",
                    initialText: row.actions.draftText(line),
                    onTextChange: { row.actions.draftChanged(line, $0) },
                    onSubmit: { body in
                        guard !body.isEmpty else { return }
                        row.actions.submitNote(line, body)
                    },
                    onCancel: { row.actions.cancelNote() })
                    .padding(DiffPlanRow.bubbleInsets)
            }
        }
    }

    /// The anchor of the line (its number on the side it lives on); none for an old-side line outside the whole review —
    /// its numbers are not A's there (wave2 mac-flow, §34.1).
    private var anchor: SideAnchor? {
        guard line.kind != .hunkHeader, line.kind != .del || row.wholeReview else { return nil }
        return SideAnchor(path: row.path, line: DiffView.noteLine(line), side: DiffView.noteSide(line))
    }

    /// The line with the hover-only gutter buttons — "+" (review note) and "?" (side question) — and a context menu.
    /// wave4d w4d-speed (polish-09): the hover is the row's own (`HoverRow`); VoiceOver gets the same two actions.
    private var lineRow: some View {
        HoverRow { hovered in
            DiffRow(line: line, highlighted: row.highlight, findQuery: row.findQuery, isCurrentMatch: row.isCurrentMatch,
                    selected: row.selected)
                .accessibilityActions {
                    if let anchor {
                        Button("Add note on this line") { row.actions.openComposer(line) }
                        if store.side.isSupported { Button("Ask about this line") { store.side.compose(anchor: anchor) } }
                    }
                }
                .overlay(alignment: .leading) {
                    if anchor != nil, hovered {   // wave2 mac-flow: no old-side note outside the whole review
                        HStack(spacing: 2) {
                            Button {
                                row.actions.openComposer(line)
                            } label: {
                                Image(systemName: "plus")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 16, height: 16)
                                    .background(Color.orange, in: RoundedRectangle(cornerRadius: 3))
                            }
                            .buttonStyle(.plain)
                            // A change request's follow-up runs: the engine refuses notes until it ends.
                            .disabled(store.isNoteLocked)
                            .help(store.noteLockReason.map { Text(verbatim: $0) } ?? Text("Add note on this line"))
                            .accessibilityLabel("Add note on line")
                            .accessibilityIdentifier("Add note on line")
                            if store.side.isSupported, let anchor {
                                Button {
                                    store.side.compose(anchor: anchor)
                                } label: {
                                    Image(systemName: "questionmark")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(.white)
                                        .frame(width: 16, height: 16)
                                        .background(Color.teal, in: RoundedRectangle(cornerRadius: 3))
                                }
                                .buttonStyle(.plain)
                                .help("Ask about this line in a side question")
                                .accessibilityLabel("Ask about this line")
                                .accessibilityIdentifier("Ask about line")
                            }
                        }
                        .padding(.leading, 2)
                    }
                }
                .overlay(alignment: .trailing) {
                    if row.hasFindingMark { PreReviewLineMarkIcon() }   // wave3 mac-flow (§36.13)
                }
                // A click picks the line (the "Add note" target too), ⇧-click / a drag the lines up to it, for ⌘C.
                .diffLinePicking(select: pick, dragTo: row.actions.dragTo)
                .contextMenu {
                    if let anchor {
                        AddNoteMenuItem { row.actions.openComposer(line) }
                        Divider()
                        SideQuestionMenuItems(anchor: anchor, whyTitle: "Ask Why This Line Changed", composeTitle: "Ask About This Line…")
                        Divider()
                    }
                    if line.kind != .hunkHeader {   // wave2 mac-diff (comp-19); also an old-side line outside the whole review
                        DiffLineCopyMenuItems(line: line, path: row.path, copySelected: copySelected)
                    }
                }
        }
    }

    /// A click on the row (`extend`: with ⇧); a hunk header picks nothing.
    private func pick(_ extend: Bool) {
        if line.kind != .hunkHeader { row.actions.clickLine(line, extend) }
    }

    /// "Copy selected lines" on a row of a several-line pick.
    private var copySelected: (() -> Void)? {
        guard row.inMultiSelection else { return nil }
        let actions = row.actions
        return { if let text = actions.copySelection() { DiffLineCopyMenuItems.copy(text) } }
    }

    /// §21 on a hunk header: the threads on this part and the one-click "Why?".
    @ViewBuilder
    private func sideHunkControls(_ header: DiffPlanRow.HunkHeader) -> some View {
        // wave2 mac-flow (§34.1): side-question hunk anchors name the whole review's hunks.
        if row.wholeReview {
            if let hunk = header.hunk {
                let threads = store.side.threads(onPath: row.path).filter { SideThreadStore.anchor($0.anchor, isIn: hunk) }
                SideBadge(threads: threads)
            }
            AskWhyButton(anchor: SideAnchor(path: row.path, hunkId: header.id), iconOnly: true)
        }
    }

    /// A hunk header's trailing controls: tick for "Revert selected", or revert just this part.
    private func hunkControls(_ header: DiffPlanRow.HunkHeader) -> some View {
        HStack(spacing: 6) {
            Toggle("Select", isOn: Binding(get: { header.selected }, set: { on in row.actions.setHunk(header.id, on) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
                .controlSize(.small)
                .disabled(!header.canReject)
                .help("Select this part for “Revert selected”")
                .accessibilityIdentifier("Select hunk \(header.id)")
            Button("Revert this part", systemImage: "arrow.uturn.backward") { row.actions.revertHunk(header.id) }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .disabled(!header.canReject)
                .help("Revert only this part to the start of the turn; the rest of the file stays under review")
                .accessibilityIdentifier("Revert hunk \(header.id)")
        }
        .font(.caption)
        .fixedSize()
    }
}
