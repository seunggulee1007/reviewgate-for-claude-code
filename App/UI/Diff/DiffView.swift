import SwiftUI
import AppKit
import ReviewGateCore

/// Native unified diff viewer for the selected changed file, with Accept / Reject for that file.
/// Header extras: note count, "Full file" toggle (whole worktree file), "Open in Editor".
/// Rows get a hover "+" gutter that opens a `CommentComposer` for a review note; notes render as
/// orange bubbles under their line and feed `AppState.requestChanges`.
struct DiffView: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    let file: ChangedFile?
    let diff: FileDiff?
    /// The engine cut `diff` at its line cap (audit 1.10): a banner offers the editor instead.
    var truncated: Bool = false
    /// A turn, its collection or a revert is in flight: reverting parts waits (`AppState.isReviewLocked`). Accept / reject
    /// follow the store's own locks — accept also works during a turn (wave2 mac-flow, §34.2).
    let isReviewLocked: Bool
    // MARK: wave7 w7-state — §45.2: accept / reject go to the store itself (no closures from the window, so an unchanged
    // file and diff skip this view when the window re-renders).

    /// The engine's diff line cap (`file_diff.truncated` beyond it). wave2 mac-diff: hunks fold above
    /// `DiffDisplay.foldLineThreshold` (3 000) — a diff the engine has already cut at 20 000 never reached this one.
    static let collapseThreshold = 20_000

    @State private var showFullFile = false
    @State private var composerLine: DiffLine?
    /// The note being written, per file: kept when its composer closes for another file, the -w view or the full file, and
    /// opened again on its line when that diff is back. By anchor — another diff of the file numbers its line objects anew.
    @State private var noteDrafts = NoteDrafts()
    /// The row last clicked; the header's "Add note" opens the composer here (else on the first changed line).
    @State private var clickedLine: DiffLine?
    /// Per-line syntax highlight indexed by `DiffLine.id`; nil until the highlighter returns.
    @State private var highlighted: [AttributedString]?
    /// §17: hunks ticked for "Revert selected" (`DiffHunk.id`).
    @State private var selectedHunks: Set<Int> = []
    @State private var confirmRevertSelected = false
    // MARK: wave2 mac-diff
    @Environment(WindowModel.self) private var model
    @AppStorage(DiffCodeMetrics.wrapLinesKey) private var wrapLines = true
    /// What is unfolded (large diff hunks, a generated file) and the lines revealed around the hunks (`DiffDisplayPlan`).
    @State private var fold = DiffFoldState()
    /// The full file's lines for "Show 20 more lines", once loaded and matching the diff.
    @State private var contextLines: [String]?
    @State private var contextLoading = false
    /// Why "Show 20 more lines" cannot work for this file (shown on the expanders).
    @State private var contextBlocked: String?
    /// Changes with every reset, so a full-file load that finishes for an older file / diff is dropped.
    @State private var contextToken = UUID()
    /// The widest line in columns (the sideways scroll's extent), measured off the main thread with wrapping off.
    @State private var maxColumns = 0
    @State private var find = DiffFindModel()
    @State private var planCache = DiffPlanCache()
    /// Syntax colours of the lines revealed from the full file, by new line number.
    @State private var contextHighlighted: [Int: AttributedString] = [:]
    // MARK: wave4c w4c-review
    /// §41.3 "공백 무시": the range diffed with `-w`, read-only (no part revert, note or line side question there).
    @State private var ignoreWhitespace = false
    /// The lines picked for ⌘C / "Copy selected lines" (a click, ⇧-click, a drag over the rows).
    @State private var lineSelection = DiffLineSelection()
    /// What the list scrolls to on `scrollTick`: find's current match, or the line of a chat link (`WindowModel.diffJump`).
    @State private var scrollKey: String?
    @State private var scrollColumn: Int?
    @State private var scrollTick = 0

    /// Changing any of these restarts (and cancels the previous) highlight task.
    private struct HighlightKey: Equatable {
        let path: String?
        let lineCount: Int
        let dark: Bool
        /// wave2 mac-flow: another range or B of the same length is another text (the rows take the highlight by index).
        let range: DiffSince
        let tree: String?
        /// wave2 mac-diff: neither large nor folded (`DiffDisplayPlan.highlights`).
        var highlights = true
    }

    private var highlightKey: HighlightKey {
        // wave4d w4d-speed (polish-09): the count from the per-diff index, not a 20 000-line `allLines` per body evaluation.
        var key = HighlightKey(path: file?.path, lineCount: diff.map { planCache.index(for: $0).lineCount } ?? -1, dark: colorScheme == .dark,
                               range: store.selectedDiffSince, tree: store.selectedDiffEndTree)
        if let file, let diff { key.highlights = displayPlan(diff, file: file).highlights }
        return key
    }

    var body: some View {
        VStack(spacing: 0) {
            if let file {
                // MARK: wave7 w7-state — §45.2: the header and the banners read the locks themselves. This body still runs
                // when a turn starts or ends (`isReviewLocked`, `isDiffUnavailable`); of the list's rows only the hunk
                // headers draw again then (their revert controls lock), the others compare equal.
                DiffViewHeader(file: file, diff: diff, showsHunkControls: showsHunkControls(file), canRejectHunks: canRejectHunks(file),
                               selectedHunks: selectedHunks.count, editorLine: { firstChangedLine }, showFullFile: $showFullFile,
                               ignoreWhitespace: $ignoreWhitespace, confirmRevertSelected: $confirmRevertSelected,
                               onAddNote: { openComposer() })
                Divider()
                // wave2 mac-flow (§34.2): read while Claude works — the review as it was before this turn.
                StaleDiffBannerSlot()
                HunkRefusalBannerSlot(file: file, isReviewLocked: isReviewLocked)
                // §31: shown even without a recorded cause — it says so (and offers a side question) instead of hiding.
                WhyChangedSection(file: file)
                Divider()
                if truncated, !showFullFile {
                    truncatedBanner(file)
                    Divider()
                }
                // MARK: wave4b w4b-files — §40.2: what a diff with lines cannot show (a rename's similarity, a mode change).
                if !showFullFile, let diff, !diff.isBinary, !diff.hunks.isEmpty, !FileMetaText.lines(diff).isEmpty {
                    FileMetaBanner(lines: FileMetaText.lines(diff))
                    Divider()
                }
                if !showFullFile { DisplacedNotesSection(file: file) }   // wave2 mac-flow (§34.4): notes with no line here
                if !showFullFile { PreReviewUnplacedSection(file: file, diff: diff) }   // wave3 mac-flow (§36.13): findings with no line here
                // MARK: wave4c w4c-review — §41.3: a changed image before / after
                if !showFullFile, !store.isDiffUnavailable, let diff, diff.isBinary, ReviewLeftovers.isPreviewImage(file.path) {
                    ImagePreviewSection(file: file)
                    Divider()
                }
                if showFullFile {
                    FullFilePane(file: file, tree: store.reviewTree, find: find)
                        .id(store.diffSince(for: file))   // wave2 mac-flow: the range's changed lines
                } else if store.isDiffUnavailable {
                    DiffUnavailableDuringTurn()   // wave2 mac-flow: no B during this turn — not an endless spinner
                } else if ignoreWhitespace, !file.isBinary, diff?.isBinary != true {
                    WhitespaceDiffBody(file: file, isOn: $ignoreWhitespace, find: find)   // wave4c w4c-review (§41.3)
                } else {
                    content(file)
                }
            } else {
                ContentUnavailableView("Select a file", systemImage: "doc.text.magnifyingglass",
                                       description: Text("Diffs appear here once a turn has changed files."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: file?.path) { _, path in
            if let jump = model.diffJump, jump.path != path { model.diffJump = nil }   // a link whose file never showed is dropped
            store.side.selectionAnchor = path.map { SideAnchor(path: $0) }
            composerLine = nil
            clickedLine = nil
            selectedHunks = []
            if file?.status == .deleted { showFullFile = false }   // it has none, and its toggle is off: never stuck in it
            resetLineState()   // wave2 mac-diff
            reopenNoteDraft()
        }
        .onChange(of: diff) { _, _ in
            selectedHunks = []   // a re-snapshot renumbers the hunks
            resetLineState()   // wave2 mac-diff
            reopenNoteDraft()   // the file's diff arrived (after a switch, the draft's line is in it now)
        }
        .onChange(of: ignoreWhitespace) { _, on in   // wave4c w4c-review: the -w view takes no parts and no notes
            selectedHunks = []
            composerLine = nil
            lineSelection.clear()
            if !on { reopenNoteDraft() }
        }
        .onChange(of: find.scrollTick) { _, _ in
            scrollKey = find.state.currentKey
            scrollColumn = find.currentColumn
            scrollTick += 1
        }
        // A chat link's file and line (`WindowModel.diffJump`), once this file's diff is on screen.
        .onChange(of: readyJumpTick, initial: true) { _, tick in
            guard tick != nil, let jump = model.diffJump else { return }
            model.diffJump = nil   // taken once: a diff drawn again later does not scroll again
            showJump(jump)
        }
        .confirmationDialog(revertSelectedTitle, isPresented: $confirmRevertSelected, titleVisibility: .visible) {
            Button("Revert \(selectedHunks.count) parts", role: .destructive) {
                if let file { revert(file, hunks: Array(selectedHunks)) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Those parts of \(file?.path ?? "") go back to how they were at the start of the turn, on disk. The rest of the file stays under review.")
        }
        .task(id: highlightKey) {
            highlighted = nil
            guard let file, let diff, !diff.isBinary else { return }
            let lines = diff.allLines
            guard !lines.isEmpty, highlightKey.highlights else { return }   // wave2 mac-diff: not a large / folded diff
            let result = await DiffRow.highlight(lines, path: file.path, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            highlighted = result
        }
        // MARK: wave2 mac-diff (another file / diff resets the line state above, before a draft opens again)
        .onChange(of: find.state.currentKey) { _, key in
            // The -w view's "L…" keys are another diff's lines (the full file's are "F…"): only the review diff unfolds.
            if !showFullFile, !ignoreWhitespace { unfold(for: key) }
        }
        .task(id: ColumnsKey(path: file?.path, lines: diff.map { planCache.index(for: $0).lineCount } ?? -1, context: contextLines?.count ?? 0, wrap: wrapLines)) {
            guard !wrapLines, let diff else { return }
            let texts = diff.hunks.flatMap { $0.lines.map(\.text) } + (contextLines ?? [])
            let widest = await Task.detached(priority: .utility) { DiffLineText.maxColumns(texts) }.value
            guard !Task.isCancelled else { return }
            maxColumns = widest
        }
        .task(id: ContextHighlightKey(path: file?.path, numbers: revealedLines.map(\.number), dark: colorScheme == .dark)) {
            let revealed = revealedLines
            guard let file, !revealed.isEmpty else {
                contextHighlighted = [:]
                return
            }
            let language = await SyntaxHighlighter.shared.language(forPath: file.path)
            let colored = await SyntaxHighlighter.shared.highlightLines(revealed.map(\.text), language: language, dark: colorScheme == .dark)
            guard !Task.isCancelled else { return }
            contextHighlighted = Dictionary(zip(revealed.map(\.number), colored), uniquingKeysWith: { a, _ in a })
        }
    }

    /// Audit 1.10: the engine returned only the first lines of a huge diff; the editor shows the whole file.
    private func truncatedBanner(_ file: ChangedFile) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text("Diff truncated at \(Self.collapseThreshold.formatted()) lines — open in editor to see the whole change")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            DiffEditorButton(file: file, line: { firstChangedLine })
                .controlSize(.small)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Diff truncated banner")
    }

    /// Header "Add note" (audit 4.3): the clicked row, else the first +/− line.
    private func openComposer() {
        guard let diff, !diff.isBinary else { return }
        if composerLine != nil { return }
        let lines = diff.allLines
        // wave2 mac-flow (§34.1): a note's old side is A's — outside the whole review only new-side lines take one.
        let annotatable = lines.filter { lineAnchor($0) != nil }
        let clicked = clickedLine.flatMap { lineAnchor($0) != nil ? $0 : nil }
        let target = clicked ?? annotatable.first { $0.kind == .add || $0.kind == .del } ?? annotatable.first
        guard let target else { return }
        unfold(lineId: target.id)   // wave2 mac-diff: the composer's line must be on screen
        composerLine = target
    }

    /// The row the editor should jump to: the note composer's line if open, else the first +/− line.
    private var firstChangedLine: Int {
        if let composerLine, let no = composerLine.newNo ?? composerLine.oldNo { return no }
        if let clickedLine, let no = clickedLine.newNo ?? clickedLine.oldNo { return no }
        let lines = diff?.allLines ?? []
        let first = lines.first { $0.kind == .add || $0.kind == .del } ?? lines.first { $0.kind != .hunkHeader }
        return first.flatMap { $0.newNo ?? $0.oldNo } ?? 1
    }

    // MARK: Body

    @ViewBuilder
    private func content(_ file: ChangedFile) -> some View {
        if let diff {
            // MARK: wave4b w4b-files — §40.2: a move, a mode change or a binary's sizes say what changed.
            let meta = diff.isBinary || diff.hunks.isEmpty ? FileMetaText.lines(diff) : []
            if !meta.isEmpty {
                FileMetaEmptyView(diff: diff, lines: meta)
            } else if diff.isBinary {
                ContentUnavailableView("Binary file", systemImage: "doc.zipper",
                                       description: Text("No textual diff is available for this file."))
            } else if diff.hunks.isEmpty {
                ContentUnavailableView("No changes", systemImage: "doc.text",
                                       description: Text("The patch for this file is empty."))
            } else {
                // wave2 mac-diff: the rows of `DiffDisplayPlan` — folded hunks / generated files, "Show 20 more lines".
                // MARK: wave7 w7-state — §45.2: one row per item, notes / findings keyed by line once, skipped while equal.
                let plan = displayPlan(diff, file: file)
                DiffPlanList(file: file, diff: diff, generation: planCache.generation(of: diff), items: plan.items, wrap: wrapLines,
                             maxColumns: maxColumns, highlighted: highlighted,
                             contextHighlighted: contextHighlighted, notes: store.inlineNotesByLine(path: file.path),
                             findings: store.preReviewFindingsByLine(path: file.path),
                             composerLineId: composerLine?.id, hunkByHeader: hunkIdByHeaderLine, selectedHunks: selectedHunks,
                             showsHunkControls: showsHunkControls(file), canRejectHunks: canRejectHunks(file), wholeReview: store.showsWholeReview,
                             contextLoading: contextLoading, contextBlocked: contextBlocked, anyRevealed: fold.hasRevealed,
                             findQuery: find.activeQuery,
                             scrollTarget: scrollKey, scrollTick: scrollTick, scrollColumn: scrollColumn,
                             currentMatch: find.visible ? find.state.currentKey : nil, selection: lineSelection,
                             actions: rowActions(file: file, diff: diff))
                    .equatable()
                    .diffFind(find, rows: { findRows(diff, plan: plan) },
                              rowsKey: FindRowsKey(path: file.path, diff: diff, items: plan.items.count), tick: model.diffFindTick)
            }
        } else {
            VStack(spacing: 8) {
                ProgressView()
                Text("Loading diff…").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Hunk-level reject (docs/PROTOCOL.md §17)

    /// The hunk header line id → its `DiffHunk.id` (the id `reject_hunks` takes) — built once per diff (wave4d w4d-speed,
    /// polish-09: it was rebuilt for every hunk header row of every body evaluation).
    private var hunkIdByHeaderLine: [Int: Int] {
        diff.map { planCache.index(for: $0).hunkByHeader } ?? [:]
    }

    /// Per-hunk controls exist for pending modified text files; added / deleted / renamed / binary ones only have
    /// the whole-file reject.
    private func showsHunkControls(_ file: ChangedFile) -> Bool {
        // wave2 mac-flow (§34.1): a range's hunk ids are not reject_hunks ids — parts are reverted from the whole review.
        file.supportsHunkReject && !showFullFile && diff?.isBinary == false && (diff?.hunks.count ?? 0) > 0 && store.showsWholeReview
            && !ignoreWhitespace   // wave4c w4c-review — §41.3: a -w diff's hunks are not the review's
    }

    private func canRejectHunks(_ file: ChangedFile) -> Bool {
        showsHunkControls(file) && !isReviewLocked && !store.isRejectingHunks && store.collectFailedLockReason == nil
    }

    private var revertSelectedTitle: String {
        String(localized: "Revert \(selectedHunks.count) selected parts?")
    }

    private func revert(_ file: ChangedFile, hunks: [Int]) {
        Task {
            if await store.rejectHunks(file, hunks: hunks) { selectedHunks = [] }
        }
    }

    // MARK: Rows + notes

    /// The anchor of one diff line (its number on the side it lives on); none for an old-side line outside the whole
    /// review — its numbers are not A's there (wave2 mac-flow, §34.1).
    private func lineAnchor(_ line: DiffLine) -> SideAnchor? {
        guard let path = file?.path, line.kind != .hunkHeader, line.kind != .del || store.showsWholeReview else { return nil }
        return SideAnchor(path: path, line: Self.noteLine(line), side: Self.noteSide(line))
    }

    static func noteSide(_ line: DiffLine) -> DiffSide { line.kind == .del ? .old : .new }

    static func noteLine(_ line: DiffLine) -> Int? { line.kind == .del ? line.oldNo : line.newNo }

    /// MARK: wave7 w7-state — §45.2: what the list's rows do (on this pane's state and the store). They capture `file` and
    /// `diff` (and `self.diff` in `reveal`): the rows compare the file and the diff's generation, so another one redraws them.
    private func rowActions(file: ChangedFile, diff: FileDiff) -> DiffRowActions {
        DiffRowActions(
            // A change request's follow-up runs: the engine refuses add_note (the "+" and the menu item say why).
            openComposer: { line in if !store.isNoteLocked { composerLine = line } },
            clickLine: { line, extend in
                clickedLine = line
                store.side.selectionAnchor = lineAnchor(line)
                lineSelection.select(DiffDisplayItem.key(line), extend: extend)
            },
            dragTo: { index in
                let items = displayPlan(diff, file: file).items
                guard items.indices.contains(index) else { return }
                lineSelection.select(DiffPlanList.rowKey(items[index]), extend: true)
            },
            copySelection: { selectedLinesText(diff, file: file) },
            draftText: { line in noteDrafts.text(path: file.path, side: Self.noteSide(line), line: Self.noteLine(line)) },
            draftChanged: { line, text in noteDrafts.set(text, path: file.path, side: Self.noteSide(line), line: Self.noteLine(line)) },
            submitNote: { line, body in
                // Refused while a change request's follow-up runs: the composer stays open with its text until it ends.
                guard !store.isNoteLocked else { return }
                store.addNote(path: file.path, line: Self.noteLine(line), side: Self.noteSide(line), excerpt: line.text, body: body)
                noteDrafts.remove(path: file.path)
                composerLine = nil
            },
            cancelNote: {
                noteDrafts.remove(path: file.path)
                composerLine = nil
            },
            setHunk: { id, on in if on { selectedHunks.insert(id) } else { selectedHunks.remove(id) } },
            revertHunk: { id in revert(file, hunks: [id]) },
            reveal: { gap, direction in reveal(gap: gap, direction: direction, file: file) },
            collapse: { gap in fold.collapse(gap: gap) },
            collapseAll: { fold.collapseAllRevealed() },
            toggleFoldedHunk: { id in toggleHunk(id, in: diff) },
            toggleFile: { fold.fileOpen.toggle() },
            toggleLarge: {
                fold.allOpen.toggle()
                fold.openHunks = []
            })
    }
}

// MARK: - wave2 mac-diff — the body's plan: folds (comp-18), "Show 20 more lines" (comp-19), find in diff

extension DiffView {
    private struct ColumnsKey: Equatable {
        let path: String?
        let lines: Int
        let context: Int
        let wrap: Bool
    }

    private struct ContextHighlightKey: Equatable {
        let path: String?
        let numbers: [Int]
        let dark: Bool
    }

    /// Find in diff searches again when the rows change: another diff (a new B, another range) or folds / reveals.
    private struct FindRowsKey: Equatable {
        let path: String
        let diff: FileDiff
        let items: Int
    }

    /// The lines on screen that came from the full file ("Show 20 more lines"), in order.
    private var revealedLines: [(number: Int, text: String)] {
        guard let file, let diff, contextLines != nil else { return [] }
        return displayPlan(diff, file: file).items.compactMap { item in
            guard case let .context(line) = item.kind, let n = line.newNo else { return nil }
            return (n, line.text)
        }
    }

    /// The rows of `diff` for what is unfolded now (cached: a hover re-evaluates the body). Unchanged lines around the
    /// hunks exist only for a modified or renamed text file (an added one is all diff, a deleted one has no new side).
    private func displayPlan(_ diff: FileDiff, file: ChangedFile) -> DiffDisplayPlan {
        planCache.plan(diff: diff, generated: file.generated, fold: fold, fullFile: contextLines, truncated: truncated,
                       contextEnabled: (file.status == .modified || file.status == .renamed) && !file.isBinary)
    }

    /// One folded hunk of a large diff opens or closes; with every hunk open, closing one keeps the others open.
    private func toggleHunk(_ id: Int, in diff: FileDiff) {
        if fold.allOpen {
            fold.allOpen = false
            fold.openHunks = Set(diff.hunks.map(\.id)).subtracting([id])
        } else {
            fold.toggleHunk(id)
        }
    }

    /// A new file / diff (another range, a new B): nothing unfolded, revealed or picked, the width measured again.
    private func resetLineState() {
        lineSelection.clear()
        fold = DiffFoldState()
        contextLines = nil
        contextBlocked = nil
        contextLoading = false
        contextToken = UUID()
        maxColumns = 0
    }

    /// The note being written on this file opens again on its line (back on the file, its diff arrived, out of the -w view).
    private func reopenNoteDraft() {
        guard composerLine == nil, !ignoreWhitespace, let file, let diff, !diff.isBinary,
              let draft = noteDrafts.draft(path: file.path) else { return }
        guard let line = diff.allLines.first(where: {
            lineAnchor($0) != nil && Self.noteSide($0) == draft.side && Self.noteLine($0) == draft.line
        }) else { return }   // the line is gone from this diff: the draft waits (another range may have it)
        unfold(lineId: line.id)
        composerLine = line
    }

    /// The tick of the chat link waiting for this file's diff (`WindowModel.diffJump`); nil when there is none, it names
    /// another file, or the diff has not arrived.
    private var readyJumpTick: Int? {
        guard let jump = model.diffJump, jump.path == file?.path, diff != nil else { return nil }
        return jump.tick
    }

    /// A chat link's `path:line`: the plain diff (not the full file or the -w view), the line's row opened, picked (the "Add
    /// note" target too) and scrolled to. A diff that has just arrived resets the line state, so this waits for it; a line
    /// outside the diff's hunks leaves the diff as it is.
    private func showJump(_ jump: DiffJump) {
        guard let line = jump.line else { return }
        showFullFile = false
        ignoreWhitespace = false
        Task {
            try? await Task.sleep(for: .milliseconds(150))   // the pane may just have opened (0.15 s) with its list
            guard let diff, store.selectedPath == jump.path, let target = diff.allLines.first(where: { $0.newNo == line }) else { return }
            if unfold(lineId: target.id) { try? await Task.sleep(for: .milliseconds(60)) }
            let key = DiffDisplayItem.key(target)
            clickedLine = target
            store.side.selectionAnchor = lineAnchor(target)
            lineSelection.select(key, extend: false)
            scrollKey = key
            scrollColumn = nil
            scrollTick += 1
        }
    }

    /// Find in diff landed on a row inside a fold: open it, then scroll to it once it exists.
    private func unfold(for key: String?) {
        guard let key, key.hasPrefix("L"), let id = Int(key.dropFirst()) else { return }
        if unfold(lineId: id) {
            Task {
                try? await Task.sleep(for: .milliseconds(60))
                find.rescroll()
            }
        }
    }

    /// Opens what hides the diff line `lineId` (the generated file's fold, its hunk of a large diff); true if anything opened.
    @discardableResult
    private func unfold(lineId: Int) -> Bool {
        guard let file, let diff, lineId >= 0 else { return false }
        var opened = false
        if file.generated != nil, !fold.fileOpen {
            fold.fileOpen = true
            opened = true
        }
        if DiffDisplay.isLarge(diff), !fold.allOpen, let hunk = DiffDisplay.hunkId(containingLine: lineId, in: diff),
           !fold.openHunks.contains(hunk) {
            fold.openHunks.insert(hunk)
            opened = true
        }
        return opened
    }

    /// "Show 20 more lines": the full file is loaded once (`full_file`, the content the diff's new side belongs to) and used
    /// only while it matches the diff; otherwise the expanders stay, disabled, with the reason.
    private func reveal(gap: Int, direction: ContextDirection, file: ChangedFile) {
        if contextLines != nil {
            fold.reveal(gap: gap, direction: direction)
            return
        }
        guard !contextLoading, contextBlocked == nil, let diff else { return }
        contextLoading = true
        let token = contextToken
        Task {
            let result: Result<FullFileView, any Error>
            do { result = .success(try await store.fullFile(for: file)) } catch { result = .failure(error) }
            guard contextToken == token else { return }   // another file / diff since: its own state was reset
            contextLoading = false
            switch result {
            case let .success(view):
                if view.isBinary || view.isTooLarge {
                    contextBlocked = String(localized: "More lines are not available: the file is too large or binary")
                } else if !DiffDisplay.fullFileMatches(diff, lines: view.lines) {
                    contextBlocked = String(localized: "The file on disk no longer matches this diff — refresh to see more lines")
                } else {
                    contextLines = view.lines
                    fold.reveal(gap: gap, direction: direction)
                }
            case let .failure(error):
                contextBlocked = error.localizedDescription
            }
        }
    }

    /// The picked lines' code, in display order (the lines of a closed fold between the ends are not on screen: left out).
    private func selectedLinesText(_ diff: FileDiff, file: ChangedFile) -> String? {
        let items = displayPlan(diff, file: file).items
        guard let range = lineSelection.range(in: items.map(DiffPlanList.rowKey)) else { return nil }
        let lines = items[range].compactMap { item -> DiffLine? in
            switch item.kind {
            case let .line(line), let .context(line): line
            default: nil
            }
        }
        return DiffLineSelection.copyText(lines)
    }

    /// The rows find in diff searches, in display order — the ones inside a fold included (they open when found).
    private func findRows(_ diff: FileDiff, plan: DiffDisplayPlan) -> [DiffFind.Row] {
        func row(_ line: DiffLine) -> DiffFind.Row { DiffFind.Row(key: DiffDisplayItem.key(line), text: line.text) }
        var rows: [DiffFind.Row] = []
        for item in plan.items {
            switch item.kind {
            case let .line(line), let .context(line):
                rows.append(row(line))
            case let .foldedHunk(hunkId, _, open) where !open:
                if let hunk = diff.hunks.first(where: { $0.id == hunkId }) {
                    rows.append(contentsOf: hunk.lines.filter { $0.kind != .hunkHeader }.map(row))
                }
            case let .foldedFile(_, open) where !open:
                rows.append(contentsOf: diff.allLines.map(row))
            default:
                break
            }
        }
        return rows
    }
}

/// The notes being written in the review diff, one per file, by the line they are on. A plain reference: typing into the
/// composer must not run the diff pane's body again.
@MainActor
final class NoteDrafts {
    struct Draft {
        let side: DiffSide
        let line: Int?
        let text: String
    }

    private var byPath: [String: Draft] = [:]

    func draft(path: String) -> Draft? { byPath[path] }

    /// The text written on this line of `path` ("" when its draft is on another line, or there is none).
    func text(path: String, side: DiffSide, line: Int?) -> String {
        guard let draft = byPath[path], draft.side == side, draft.line == line else { return "" }
        return draft.text
    }

    /// Typed: the file's draft is on this line now (blank text: none).
    func set(_ text: String, path: String, side: DiffSide, line: Int?) {
        byPath[path] = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : Draft(side: side, line: line, text: text)
    }

    func remove(path: String) { byPath[path] = nil }
}

/// One review note under its diff line: orange, with edit, "send only this note" and delete buttons.
struct NoteBubble: View {
    @Environment(\.colorScheme) private var colorScheme
    let note: ReviewNote
    /// "Send only this note" is offered (Request changes could run now).
    let canSend: Bool
    /// Why edit / delete wait (a change request's follow-up runs — the engine refuses both then); nil when they can be used.
    var lockReason: String? = nil
    let onEdit: (String) -> Void
    let onSendOnly: () -> Void
    let onDelete: () -> Void
    @State private var editing = false

    var body: some View {
        if editing {
            CommentComposer(submitTitle: String(localized: "Save"), submitID: "Save note", initialText: note.body,
                            onSubmit: { text in
                                if !text.isEmpty, text != note.body { onEdit(text) }
                                editing = false
                            },
                            onCancel: { editing = false })
        } else {
            bubble
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("Note")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.orange.wash(colorScheme, light: 0.20, dark: 0.28), in: Capsule())
                    .foregroundStyle(.orange)
                if let line = note.line {
                    Text(verbatim: "\(note.side == .old ? "−" : "+")\(line)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if note.anchor == .gone { LineGoneChip() }   // wave2 mac-flow (§34.4)
                Spacer(minLength: 0)
                // A 20 pt target each (`.borderless` made only the glyph one); the font keeps the small glyph.
                Button("Edit note", systemImage: "pencil") { editing = true }
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .font(.subheadline)
                    .disabled(lockReason != nil)
                    .help(lockReason.map { Text(verbatim: $0) } ?? Text("Edit note"))
                    .accessibilityIdentifier("Edit note")
                Button("Send only this note", systemImage: "paperplane", action: onSendOnly)
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .font(.subheadline)
                    .disabled(!canSend)
                    .help("Send only this note to Claude (Request changes with just this one)")
                    .accessibilityIdentifier("Send only this note")
                Button("Delete note", systemImage: "trash", action: onDelete)
                    .labelStyle(.iconOnly)
                    .buttonStyle(IconButtonStyle(padding: 2))
                    .font(.subheadline)
                    .disabled(lockReason != nil)
                    .help(lockReason.map { Text(verbatim: $0) } ?? Text("Delete note"))
                    .accessibilityLabel("Delete note")
                    .accessibilityIdentifier("Delete note")
            }
            Text(verbatim: note.body)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .background(Color.orange.wash(colorScheme, light: 0.10, dark: 0.18), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.orange.wash(colorScheme, light: 0.50, dark: 0.60)))
        .accessibilityIdentifier("Review note")
    }
}

// MARK: - wave7 w7-state — §45.2: the parts of the diff pane that read the turn's state, each a view of its own

/// The diff's header: the file, its counts and badges, the range picker and the controls. It reads the locks itself, so
/// a turn starting or ending re-renders it, not the diff below.
struct DiffViewHeader: View {
    @Environment(AppState.self) private var store
    @Environment(WindowModel.self) private var model
    let file: ChangedFile
    let diff: FileDiff?
    let showsHunkControls: Bool
    let canRejectHunks: Bool
    /// The parts ticked for "Revert selected".
    let selectedHunks: Int
    /// The line "Open in Editor" jumps to (asked when it is used: finding it walks the diff's lines).
    let editorLine: () -> Int
    @Binding var showFullFile: Bool
    @Binding var ignoreWhitespace: Bool
    @Binding var confirmRevertSelected: Bool
    let onAddNote: () -> Void

    var body: some View {
        // The file's unsent notes — what Request changes sends (wave2 mac-flow, §34.4: sent ones are "요청함" cards).
        let noteCount = store.unsentNotes.filter { $0.path == file.path }.count
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(file.status.rawValue)
                    .font(.caption.weight(.bold).monospaced())
                    .foregroundStyle(statusColor(file.status))
                    .frame(width: 14)
                    .accessibilityLabel(ReviewSpeech.status(file.status))   // MARK: wave4d w4d-speed — polish-10
                VStack(alignment: .leading, spacing: 1) {
                    Text(file.path).font(.callout.weight(.medium)).lineLimit(1).truncationMode(.middle)
                    if let old = file.oldPath, old != file.path {
                        Text("from \(old)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text("+\(file.added)").font(.caption.monospacedDigit()).foregroundStyle(.green)
                    .accessibilityLabel(ReviewSpeech.counts(added: file.added, deleted: file.deleted))   // MARK: wave4d w4d-speed
                Text("−\(file.deleted)").font(.caption.monospacedDigit()).foregroundStyle(.red)
                    .accessibilityHidden(true)
                if noteCount > 0 {
                    Label("\(noteCount) notes", systemImage: "text.bubble")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize()
                        .accessibilityIdentifier("Note count")
                }
                if file.partial {
                    TagChip(Text("Partial revert \(file.rejectedHunks)"), systemImage: "scissors", tint: .purple)
                        .help("Some parts were reverted on disk; the rest is still under review")
                        .accessibilityIdentifier("Partial revert badge")
                }
                if file.changedSinceAccepted, file.state == .pending { ChangedAfterAcceptChip() }   // wave2 mac-flow
                if file.whitespaceOnly {   // wave4c w4c-review — §34.7 / §41.3, as Electron's badge
                    TagChip(Text("Only whitespace changed"), systemImage: "space", tint: .secondary)
                        .help("Every change of this file is whitespace — “Ignore whitespace” shows nothing is left")
                        .accessibilityIdentifier("Whitespace only badge")
                }
            }
            DiffProvenanceHeader(file: file)   // wave1 mac-review — §31–32
            DiffRangePicker(file: file)   // wave2 mac-flow (§34.1): 전체 / 이번 턴 / 요청 이후 / 수락 이후
            // Narrow diff panes (agent panel open, small window) fall back to icon-only controls instead of overflowing.
            // FullOrCompact, not ViewThatFits: the buttons, toggles and editor menu are AppKit views it rebuilt every pass.
            FullOrCompact { measuring in
                controls(measuring: measuring)
            } compact: {
                controls(measuring: false).labelStyle(.iconOnly)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    /// `measuring`: the hidden copy FullOrCompact sizes — it registers no shortcut (the one on screen is the only ⌥⌘N).
    private func controls(measuring: Bool) -> some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            if showsHunkControls, selectedHunks > 0 {
                Button("Revert selected (\(selectedHunks))", systemImage: "scissors") { confirmRevertSelected = true }
                    .fixedSize()
                    .disabled(!canRejectHunks)
                    .help("Revert the ticked parts to the start of the turn; the rest stays under review")
                    .accessibilityLabel("Revert selected")
                    .accessibilityIdentifier("Revert selected hunks")
            }
            Button("Add note", systemImage: "text.bubble") { onAddNote() }
                .fixedSize()
                .disabled(diff == nil || diff?.isBinary == true || (diff?.hunks.isEmpty ?? true) || showFullFile || store.isNoteLocked
                          || (ignoreWhitespace && !showFullFile))   // wave4c w4c-review
                .keyboardShortcut(measuring ? nil : KeyboardShortcut("n", modifiers: [.command, .option]))   // wave4 w4-input (polish-06), Electron's Ctrl+Alt+N
                .help(store.isNoteLocked ? AppState.sessionRefusalText("session_running")
                      : ignoreWhitespace && !showFullFile ? ReviewLeftovers.whitespaceViewNote   // wave4c w4c-review
                      : String(localized: "Add a review note on the selected line (or the first changed line); send them with Request changes (⌘⇧C)") + " (⌥⌘N)")
                .accessibilityLabel("Add note")
                .accessibilityIdentifier("Add note")
            if !showFullFile { WhitespaceToggle(isOn: $ignoreWhitespace, file: file) }   // wave4c w4c-review — §41.3 공백 무시
            DiffLineOptions { model.diffFindTick += 1 }   // wave2 mac-diff: 줄바꿈, diff에서 찾기 (the diff or its full file)
            Toggle("Full file", systemImage: "doc.text", isOn: $showFullFile)
                .toggleStyle(.button)
                .labelStyle(.iconOnly)
                .fixedSize()
                .disabled(file.status == .deleted)
                .help(file.status == .deleted ? Text("A deleted file has no full file to show") : Text("Full file"))
                .accessibilityLabel("Full file")
                .accessibilityIdentifier("Full file")
            DiffEditorButton(file: file, line: editorLine)
            switch file.state {
            case .pending:
                // wave2 mac-flow (§34.2): while a turn runs accept still applies; reject waits and says why.
                Button("Reject", systemImage: "arrow.uturn.backward") { store.reject(file) }
                    .controlSize(.regular)
                    .fixedSize()
                    .disabled(store.isRejectLocked || file.uncaptured)
                    .help(store.rejectLockReason ?? rejectHelp)
                    .accessibilityLabel("Reject")
                    .accessibilityIdentifier("Reject")
                Button("Accept", systemImage: "checkmark") { store.accept(file) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .fixedSize()
                    .disabled(store.isAcceptLocked)
                    .help(store.acceptLockReason ?? String(localized: "Accept and move to the next pending file (⌘⇧A) · next/previous pending: ⌘] / ⌘["))
                    .accessibilityLabel("Accept")
                    .accessibilityIdentifier("Accept")
            case .accepted:
                Label("Accepted", systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green)
                Button("Undo Accept", systemImage: "arrow.uturn.left") { store.unaccept(file) }
                    .controlSize(.regular)
                    .fixedSize()
                    .disabled(store.isReviewLocked)
                    .help(Text("Make this file pending again (the file on disk is not changed)") + Text(verbatim: " (⌘⇧U)"))
                    .accessibilityIdentifier("Undo Accept")
            case .rejected:
                Label("Rejected", systemImage: "arrow.uturn.backward.circle.fill").font(.callout).foregroundStyle(.orange)
            case .changesRequested:
                Label("Changes requested", systemImage: "exclamationmark.bubble.fill").font(.callout).foregroundStyle(.orange)
            }
        }
    }

    /// §31–32: an uncaptured file cannot be reverted; an external one is confirmed before it is.
    private var rejectHelp: String {
        if file.uncaptured { return ReviewProvenanceText.uncaptured }
        if file.isExternal { return String(localized: "Changed outside the app — you confirm before it is reverted (⌘⇧R)") }
        return String(localized: "Reject and move to the next pending file (⌘⇧R)")
    }

    private func statusColor(_ status: ChangeStatus) -> Color {
        switch status {
        case .added: .green
        case .modified: .orange
        case .deleted: .red
        case .renamed: .blue
        case .other: .secondary
        }
    }
}

/// "Open in Editor": the remembered editor as the primary action, every installed editor in the menu; it opens `line()`.
struct DiffEditorButton: View {
    @Environment(AppState.self) private var store
    let file: ChangedFile
    let line: () -> Int

    var body: some View {
        let editors = ExternalEditor.installed
        let preferred = ExternalEditor.preferred ?? editors.first ?? .finder
        Menu {
            ForEach(editors) { editor in
                Button(editor.title, systemImage: editor.systemImage) { open(in: editor) }
                    .accessibilityIdentifier("Open in \(editor.rawValue)")
            }
        } label: {
            Label(preferred == .finder ? String(localized: "Open in Editor") : preferred.title,
                  systemImage: "arrow.up.forward.app")
        } primaryAction: {
            open(in: preferred)
        }
        .menuStyle(.button)
        .fixedSize()
        // A deleted path would open as a new empty file (VS Code: saving it brings the file back empty) or select nothing.
        .disabled(file.status == .deleted)
        .help(file.status == .deleted ? Text("A deleted file is no longer on disk") : Text("Open in Editor"))
        .accessibilityLabel("Open in Editor")
        .accessibilityIdentifier("Open in Editor")
    }

    private func open(in editor: ExternalEditor) {
        guard let root = store.projectInfo?.root ?? store.projectURL?.path else { return }
        let absolute = (root as NSString).appendingPathComponent(file.path)
        editor.open(absolute, line: line())
    }
}

/// wave2 mac-flow (§34.2): "the review as it was before this turn" while Claude works, with its divider.
struct StaleDiffBannerSlot: View {
    @Environment(AppState.self) private var store

    var body: some View {
        if store.isShowingStaleDiff {
            StaleDiffBanner()
            Divider()
        }
    }
}

/// A refused `reject_hunks` of `file`, in plain words, with the fix it calls for (refresh / reject the whole file).
struct HunkRefusalBannerSlot: View {
    @Environment(AppState.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let file: ChangedFile
    let isReviewLocked: Bool

    var body: some View {
        if let refusal = store.hunkRefusal, refusal.path == file.path {
            banner(refusal.refusal)
            Divider()
        }
    }

    private func banner(_ refusal: HunkRefusal) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(verbatim: refusal.message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("Hunk refusal text")
            Spacer(minLength: 4)
            switch refusal.remedy {
            case .refresh:
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refreshReviewAfterRefusal() } }
                    .controlSize(.small)
                    .fixedSize()
                    .accessibilityIdentifier("Hunk refusal refresh")
            case .rejectWholeFile:
                Button("Reject whole file", systemImage: "arrow.uturn.backward") { store.dismissHunkRefusal(); store.reject(file) }
                    .controlSize(.small)
                    .fixedSize()
                    .disabled(file.state != .pending || isReviewLocked)
                    .accessibilityIdentifier("Hunk refusal reject file")
            case .none:
                EmptyView()
            }
            Button { store.dismissHunkRefusal() } label: { Image(systemName: "xmark") }
                .buttonStyle(IconButtonStyle(padding: 2))
                .controlSize(.small)
                .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.orange.wash(colorScheme, light: 0.12, dark: 0.20))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("Hunk refusal banner")
    }
}
