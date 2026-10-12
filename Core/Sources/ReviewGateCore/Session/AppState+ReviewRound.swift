import Foundation

// wave2 mac-flow — docs/PROTOCOL.md §34 ("리뷰 2차", 틈틈이 리뷰) on the window's store: the diff being read survives a send
// and pending files open while Claude works (§34.2, read-only), each file's range (§34.1), accept during a turn while
// reject waits, "봤음" keyed on content (§34.5), ⌘] / ⌘[ and the move after a verdict in the list's order (comp-10), sent
// notes (§34.4), the round in progress, the running turn's live changes (§34.6) and the ignore patterns pushed once edited.

extension AppState {
    // MARK: Trees and locks (§34.2)

    /// The B the review list and its diffs refer to (`gate.reviewEndTree`, an older engine's `turnEndTree`).
    public var reviewTree: String? { gate.reviewTree }

    /// Accept waits for the collection and a revert. While a turn runs it applies at once on a standing review (the engine
    /// records the file's patch against the B the turn started from, §34.2); an engine before §34 refuses it then.
    public var isAcceptLocked: Bool { acceptLockReason != nil }

    public var acceptLockReason: String? {
        if isReverting { return Self.sessionRefusalText("reverting") }
        if isSnapshotting { return Self.sessionRefusalText("session_running") }
        if isRunning, gate.reviewEndTree == nil { return Self.sessionRefusalText("session_running") }
        return nil
    }

    /// Reject and reject all wait while a turn runs: a revert mid-turn would be swallowed by the turn's own collection (§3).
    /// §37.1: they also wait while a collection failed — the engine refuses them `collect_failed` until Retry succeeded.
    public var isRejectLocked: Bool { rejectLockReason != nil }

    public var rejectLockReason: String? {
        if isReverting { return Self.sessionRefusalText("reverting") }
        if isRunning { return String(localized: "Reject is available when this turn ends", bundle: .module) }
        if isSnapshotting { return Self.sessionRefusalText("session_running") }
        if let reason = collectFailedLockReason { return reason }
        return nil
    }

    /// §37.1: why reject / reject_all / reject_hunks / commit wait — a failed collection (Retry first); nil otherwise.
    public var collectFailedLockReason: String? {
        gatePhase == .collectFailed || gate.collectError != nil ? Self.sessionRefusalText("collect_failed") : nil
    }

    /// Why "Commit accepted" waits — the engine's `canCommit` is false while a collection failed, a revert, a turn or its
    /// collection runs; nil otherwise (with no accepted file the button's count says so).
    public var commitLockReason: String? {
        if let reason = collectFailedLockReason { return reason }
        if isReverting { return Self.sessionRefusalText("reverting") }
        if isRunning || isSnapshotting { return Self.sessionRefusalText("session_running") }
        return nil
    }

    /// True — with an error row saying why — when accept must wait.
    func acceptLockedNotice() -> Bool {
        guard let reason = acceptLockReason else { return false }
        fail(reason, fatal: false)
        return true
    }

    /// True — with an error row saying why — when reject must wait.
    func rejectLockedNotice() -> Bool {
        guard let reason = rejectLockReason else { return false }
        fail(reason, fatal: false)
        return true
    }

    /// §34.2: a turn runs (or is collected) while the diff pane shows the review as it was before it — read-only.
    public var isShowingStaleDiff: Bool {
        (isRunning || isSnapshotting) && selectedPath != nil && selectedDiff != nil && liveSelection == nil
    }

    /// The selected file has no diff while this turn runs: there is no B to ask for (a turn on a fresh review, an engine
    /// before §34) and it was not on screen before the turn.
    public var isDiffUnavailable: Bool {
        (isRunning || isSnapshotting) && selectedPath != nil && selectedDiff == nil && reviewTree == nil
    }

    /// A turn runs on a fresh review: the list still shows the previous round's decided files (dimmed, §34.2).
    public var isReviewListStale: Bool { (isRunning || isSnapshotting) && reviewTree == nil && !changedFiles.isEmpty }

    /// Notes wait while a change request's follow-up runs (the engine refuses them then; a question turn takes them).
    public var isNoteLocked: Bool { (isRunning || isSnapshotting) && gate.isRequestingChanges }

    // MARK: Ranges (§34.1)

    /// The ranges the diff header offers for `file` (one = no picker).
    public func availableRanges(for file: ChangedFile) -> [DiffSince] { ReviewRange.available(for: file, gate: gate) }

    /// The range `file`'s diff is shown in: the one picked (or opened) on its current content, else its default.
    public func diffSince(for file: ChangedFile) -> DiffSince {
        let available = availableRanges(for: file)
        if let choice = rangeChoices[file.path], choice.content == ViewedKey.content(file), available.contains(choice.since) {
            return choice.since
        }
        let fallback = ReviewRange.defaultRange(for: file, gate: gate)
        return available.contains(fallback) ? fallback : .review
    }

    /// The diff header's range picker.
    public func setDiffRange(_ since: DiffSince, for file: ChangedFile) {
        let current = changedFiles.first { $0.path == file.path } ?? file
        rangeChoices[current.path] = ReviewRangeChoice(since: since, content: ViewedKey.content(current))
        if selectedPath == current.path { selectFile(current) }
    }

    /// The diff on screen is the whole review (A → B): only then are its hunk ids `reject_hunks` / side-question ids and
    /// its old-side numbers A's (§34.1) — parts are reverted, and old lines noted, from it.
    public var showsWholeReview: Bool { selectedDiffSince == .review }

    /// Shows `file`'s diff in its range: from the cache of (path, range, B), else `select_file{path, since}` — answered
    /// from the held B while a turn runs. Without a B the diff of that range shown before stays (read-only).
    func loadSelectedDiff(_ file: ChangedFile) {
        let since = diffSince(for: file)
        rangeChoices[file.path] = ReviewRangeChoice(since: since, content: ViewedKey.content(file))
        selectedDiffSince = since
        guard let tree = reviewTree else {
            if let kept = reviewDiffs.first(where: { $0.key.path == file.path && $0.key.since == since })?.value { present(kept, since: since) }
            return
        }
        // wave3 check-clients: "봤음" once the diff is on screen (as Electron) — a load that failed showed nothing.
        if file.isBinary {
            present(ReviewDiffEntry(diff: FileDiff(oldPath: file.oldPath ?? file.path, newPath: file.path, isBinary: true, hunks: []),
                                    truncated: false, endTree: tree, info: FileDiffInfo()), since: since)
            markShown(file.path)
            return
        }
        if let cached = reviewDiffs[ReviewDiffKey(path: file.path, since: since, tree: tree)] {
            present(cached, since: since)
            markShown(file.path)
            return
        }
        let path = file.path
        diffLoadTask = Task {
            do {
                let event = try await typedReply(.selectFile(path: path, since: since.wire))
                guard case let .fileDiff(_, _, _, diff, truncated, endTree, info) = event else {
                    throw EngineClientError.unexpectedReply(String(describing: event))
                }
                guard !Task.isCancelled, selectedPath == path, selectedDiffSince == since else { return }
                // The tree the diff describes (older engines: the B it was requested under).
                showDiff(diff, truncated: truncated, endTree: endTree ?? tree, for: path, info: info, since: since, tree: tree)
                markShown(path)
            } catch let error as EngineClientError where error.refusalCode == "range_unavailable" {
                // The range's tree is gone (a review restored without it): the whole review instead.
                guard !Task.isCancelled, selectedPath == path, since != .review else { return }
                appendLog("[warn] select_file \(path) since \(since.rawValue): \(error.localizedDescription)")
                setDiffRange(.review, for: file)
            } catch {
                if !Task.isCancelled {
                    fail(String(localized: "Failed to load diff for \(path): \(error.localizedDescription)", bundle: .module), fatal: false)
                }
            }
        }
    }

    func present(_ entry: ReviewDiffEntry, since: DiffSince) {
        selectedDiff = entry.diff
        selectedDiffEndTree = entry.endTree
        selectedDiffTruncated = entry.truncated
        selectedDiffInfo = entry.info
        selectedDiffSince = since
    }

    /// The cached whole-review diff of `path` on the current B (what hunk ids and side-question anchors refer to).
    func wholeReviewDiff(path: String) -> ReviewDiffEntry? {
        reviewTree.flatMap { reviewDiffs[ReviewDiffKey(path: path, since: .review, tree: $0)] }
    }

    /// Typed replies (`file_diff`, `full_file_content`, `review_history`, …) through the test seam or the engine.
    func typedReply(_ command: EngineCommand) async throws -> EngineEvent {
        if let replySink { return try await replySink(command) }
        return try await requestReply(command)
    }

    // MARK: Viewed by content (§34.5)

    /// Changed files whose current content was shown.
    public var viewedPaths: Set<String> { Set(changedFiles.filter(isViewed).map(\.path)) }

    public func isViewed(_ file: ChangedFile) -> Bool { viewedContent[file.path] == ViewedKey.content(file) }

    /// wave3 check-clients: the review diff of `path` is on screen — remember the content it showed (the list's current entry).
    func markShown(_ path: String) {
        guard let file = changedFiles.first(where: { $0.path == path }) else { return }
        viewedContent[path] = ViewedKey.content(file)
    }

    /// "본 뒤 바뀜": shown before, changed since.
    public func changedSinceViewed(_ file: ChangedFile) -> Bool {
        viewedContent[file.path].map { $0 != ViewedKey.content(file) } ?? false
    }

    public var changedSinceViewedFiles: [ChangedFile] { changedFiles.filter(changedSinceViewed) }

    // MARK: The list's order (comp-10)

    /// The Changes list's order setting (`@AppStorage` of the same key in the list).
    var fileListRiskOrder: Bool { settingsDefaults.object(forKey: AppSettings.Key.changedFilesRiskOrder) as? Bool ?? true }

    /// The files in the order the Changes list shows them: its groups, risk first unless set to git order.
    public var displayOrderedFiles: [ChangedFile] { navigationSections(riskOrder: fileListRiskOrder).flatMap(\.files) }   // wave4b w4b-files: + "묶기"

    /// The pending file after `path` on screen, wrapping to the first one above it; nil when no other file is pending.
    func pendingAfter(_ path: String) -> ChangedFile? {
        let files = displayOrderedFiles
        guard let index = files.firstIndex(where: { $0.path == path }) else { return files.first { $0.state == .pending && $0.path != path } }
        return files[(index + 1)...].first { $0.state == .pending } ?? files[..<index].first { $0.state == .pending }
    }

    /// The file a fresh list opens on: the first pending one on screen, else the first.
    var firstFileOnScreen: ChangedFile? {
        let files = displayOrderedFiles
        return files.first { $0.state == .pending } ?? files.first
    }

    // MARK: Notes (§34.4)

    /// The notes request_changes would send ("notes pending" guards count only these).
    public var unsentNotes: [ReviewNote] { NotePlacement.unsent(reviewNotes) }

    /// The notes drawn under one line of the selected file's diff.
    public func inlineNotes(path: String, side: DiffSide, line: Int?) -> [ReviewNote] {
        NotePlacement.inline(reviewNotes, path: path, side: side, line: line, since: selectedPath == path ? selectedDiffSince : .review)
    }

    /// wave7 w7-state (§45.2): `inlineNotes` of every line of `path`, once per change (the diff's rows look theirs up).
    public func inlineNotesByLine(path: String) -> [NotePlacement.LineKey: [ReviewNote]] {
        NotePlacement.inlineByLine(reviewNotes, path: path, since: selectedPath == path ? selectedDiffSince : .review)
    }

    /// The selected file's notes that have no line in the diff on screen (listed above it).
    public func displacedNotes(path: String) -> [ReviewNote] {
        guard selectedPath == path else { return [] }
        return NotePlacement.displaced(reviewNotes, path: path, since: selectedDiffSince, diff: selectedDiff)
    }

    /// "반영 확인": the sent note is done with.
    public func markAddressed(_ note: ReviewNote) {
        // wave3 check-clients: the engine refuses `remove_note` while the change request it answers runs — say so here.
        if let reason = noteLockReason {
            fail(reason, fatal: false)
            return
        }
        removeNote(id: note.id)
    }

    // MARK: Snapshots

    /// After each snapshot: a new review forgets its marks and picks; a new B reloads what is shown; no B (a turn on a
    /// fresh review, an older engine's turn) keeps it on screen, read-only; the live list follows the running turn.
    func reviewSnapshotApplied(previous: ReviewState) {
        let watchedLive = liveSelection
        let newReview = state.gate.turnStartTree != previous.gate.turnStartTree
        if newReview {
            viewedContent = [:]
            rangeChoices = [:]
            reviewDiffs = [:]
            lastAcceptedPath = nil   // Undo Accept is this review's
            Task { await SyntaxHighlighter.shared.clear() }   // wave7 w7-state (§45.2): the last round's coloured lines go
        }
        let tree = reviewTree
        if let tree, tree != previous.gate.reviewTree || newReview {
            reviewDiffs = reviewDiffs.filter { $0.key.tree == tree }
            selectFile(changedFiles.first { $0.path == selectedPath } ?? firstFileOnScreen)
        } else if tree == nil, previous.gate.reviewTree != nil {
            diffLoadTask?.cancel()
            diffLoadTask = nil
        } else if let selected = selectedPath, !changedFiles.contains(where: { $0.path == selected }) {
            selectFile(firstFileOnScreen)
        }
        liveSnapshotApplied(previous: previous, watched: watchedLive)
    }

    func resetReviewRound() {
        viewedContent = [:]
        rangeChoices = [:]
        reviewDiffs = [:]
        lastAcceptedPath = nil
        Task { await SyntaxHighlighter.shared.clear() }   // wave7 w7-state (§45.2): a project closed / switched, the engine gone
        selectedDiffSince = .review
        selectedDiffInfo = FileDiffInfo()
        currentReviewRound = nil
        clearLive()
        liveChangesUnsupported = false
    }

    // MARK: Live changes (§34.6)
    // The HUD's "진행 중: 파일 N개 · +A −D" is `liveChip` (AppState+ReviewRoundCheck.swift, wave3 check-clients).

    /// `live_changes` → `liveChanges` (read-only; nothing here can be accepted). An engine before §34 is not asked again.
    public func refreshLiveChanges() async {
        guard projectInfo != nil, !liveChangesUnsupported, isRunning || isSnapshotting, !isLoadingLiveChanges else { return }
        lastLiveRequestAt = Date()
        isLoadingLiveChanges = true
        defer { isLoadingLiveChanges = false }
        do {
            guard case let .liveChanges(live) = try await reply(.liveChanges) else { return }
            liveChanges = live.running && (isRunning || isSnapshotting) ? live : nil
        } catch let error as EngineClientError where error.refusalCode == "unknown_command" {
            liveChangesUnsupported = true
            liveChanges = nil
        } catch {
            appendLog("[warn] live_changes: \(error.localizedDescription)")
        }
    }

    /// `live_diff{path}`: the file's change in the running turn so far, read-only in the diff pane.
    public func openLiveDiff(_ path: String) async {
        closeHistoryDiff()
        liveSelection = path
        liveDiff = nil
        liveDiffTruncated = false
        liveDiffError = nil
        do {
            let event = try await reply(.liveDiff(path: path))
            guard liveSelection == path else { return }
            guard case let .fileDiff(_, _, _, diff, truncated, _, _) = event else { throw EngineClientError.unexpectedReply(String(describing: event)) }
            liveDiff = diff
            liveDiffTruncated = truncated
        } catch let error as EngineClientError {
            guard liveSelection == path else { return }
            switch error.refusalCode {
            case "no_live_turn": closeLiveDiff()   // the turn ended meanwhile: the review has it now
            case "not_a_live_file": liveDiff = FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: [])
            default: liveDiffError = error.userMessage
            }
        } catch {
            guard liveSelection == path else { return }
            liveDiffError = error.localizedDescription
        }
    }

    /// Back to the review in the diff pane.
    public func closeLiveDiff() {
        liveSelection = nil
        liveDiff = nil
        liveDiffTruncated = false
        liveDiffError = nil
    }

    /// The running turn changed the files the HUD counts: ask for the list once the edits settle. Once the turn is
    /// collected the list goes; a live diff on screen turns into that file of the review.
    func liveSnapshotApplied(previous: ReviewState, watched: String?) {
        guard isRunning || isSnapshotting else {
            if liveChanges != nil || liveSelection != nil || liveRefreshTask != nil { clearLive() }
            if let watched, watched != selectedPath, let file = changedFiles.first(where: { $0.path == watched }) { selectFile(file) }
            return
        }
        if isRunning, state.hud.turnFiles > 0, state.hud.turnFiles != previous.hud.turnFiles { scheduleLiveRefresh() }
    }

    /// Calls whose end can change the worktree: an edit tool, Bash, an MCP tool (§31's writers).
    static let liveWriterTools: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]

    /// A writing call of the running turn finished while its changes are on screen: the same file edited again keeps
    /// `hud.turnFiles` where it was, so the list (and the HUD's +/−) is asked again — at most every `liveMinGap` seconds.
    func liveCallFinished(toolUseId: String, isError: Bool) {
        guard isRunning, !isError, liveChanges != nil, !liveChangesUnsupported else { return }
        let name = transcript.reversed().lazy.compactMap { item -> String? in
            if case let .toolUse(_, id, name, _, _, _) = item, id == toolUseId { return name }
            return nil
        }.first
        guard let name, Self.liveWriterTools.contains(name) || name.hasPrefix("mcp__") else { return }
        let since = lastLiveRequestAt.map { Date().timeIntervalSince($0) } ?? .infinity
        scheduleLiveRefresh(after: since < liveMinGap ? .seconds(liveMinGap - since) : nil)
    }

    func scheduleLiveRefresh(after wait: Duration? = nil) {
        guard !liveChangesUnsupported, liveRefreshTask == nil, projectInfo != nil else { return }
        let delay = wait.map { max($0, liveRefreshDelay) } ?? liveRefreshDelay
        liveRefreshTask = Task { [weak self] in
            if delay > .zero { try? await Task.sleep(for: delay) }
            // A reply still on its way predates this change: ask again once it is in, not never.
            while self?.isLoadingLiveChanges == true, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(50)) }
            guard !Task.isCancelled, let self else { return }
            self.liveRefreshTask = nil
            await self.refreshLiveChanges()
        }
    }

    func clearLive() {
        liveRefreshTask?.cancel()
        liveRefreshTask = nil
        liveChanges = nil
        closeLiveDiff()
    }

    // MARK: Settings — checkpoint ignore patterns

    /// Settings' ignore patterns when editing ends (the box loses focus, Reset, the window closes): `set_settings` only
    /// when they differ from what this engine has — never a half-typed pattern ("*") in the middle of a turn's collection.
    public func commitIgnorePatterns() {
        guard AppSettings.ignorePatterns(defaults: settingsDefaults) != engineIgnorePatterns else { return }
        pushIgnorePatterns()
    }
}
