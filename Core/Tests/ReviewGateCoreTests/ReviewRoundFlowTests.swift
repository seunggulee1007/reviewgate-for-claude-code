import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 mac-flow — docs/PROTOCOL.md §34 on the Mac's store, driven with §34-shaped snapshots and replies: the diff being
/// read survives a send (comp-02), ranges and the one a file opens in, accept during a turn while reject waits, "봤음" by
/// content (comp-08), the list's order for ⌘] / ⌘[ and the move after a verdict (comp-10), sent notes (comp-06), the
/// round in progress, live changes (comp-03), the turn-end row (comp-04) and the ignore patterns pushed when edited.
@Suite @MainActor struct ReviewRoundFlowTests {
    private func makeState(riskOrder: Bool? = nil) -> AppState {
        let defaults = UserDefaults(suiteName: "ReviewRoundFlowTests.\(UUID().uuidString)")!
        if let riskOrder { defaults.set(riskOrder, forKey: AppSettings.Key.changedFilesRiskOrder) }
        return AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending, blob: String? = nil, noBlob: Bool = false,
                      added: Int = 1, deleted: Int = 0, status: ChangeStatus = .modified,
                      _ change: (inout ChangedFile) -> Void = { _ in }) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: status, added: added, deleted: deleted, isBinary: false,
                            tools: ["Edit"], state: state)
        f.blob = noBlob ? nil : (blob ?? "blob-\(path)")
        change(&f)
        return f
    }

    /// `end` is `turnEndTree` (nil while a turn runs), `review` the §34 `reviewEndTree` (nil = an engine before §34, or a
    /// turn on a fresh review).
    private func snapshot(seq: Int, files: [ChangedFile], phase: GatePhase = .reviewing, start: String? = "A1",
                          end: String? = "B1", review: String? = "B1", notes: [ReviewNote] = [],
                          _ change: (inout ReviewState) -> Void = { _ in }) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: true, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0,
                          isRequestingChanges: false, turnStartTree: start, turnEndTree: end, lastReviewSummary: nil)
        s.gate.reviewEndTree = review
        s.changedFiles = files
        s.reviewNotes = notes
        change(&s)
        return s
    }

    /// A one-hunk diff whose single added line says which range and tree it was computed for.
    private func diff(_ path: String, _ label: String) -> FileDiff {
        FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: [
            DiffHunk(id: 0, header: "@@ -1 +1 @@", lines: [
                DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1 +1 @@"),
                DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 1, text: label),
            ]),
        ])
    }

    private func shownLabel(_ app: AppState) -> String? { app.selectedDiff?.allLines.last?.text }

    /// An engine answering `select_file` / `full_file` with the tree it is told and recording what it was asked.
    @MainActor private final class FakeEngine {
        var tree = "B1"
        var stale = false
        var refuseSince: Set<DiffSince> = []
        var asked: [EngineCommand] = []

        func answer(_ command: EngineCommand, diff: (String, String) -> FileDiff) throws -> EngineEvent {
            // A project with a chat loads its side questions (§21): not what these tests look at.
            if case .sideList = command { return .sideThreads(id: nil, mainSessionId: "s", threads: []) }
            asked.append(command)
            switch command {
            case let .selectFile(path, since):
                if let since, refuseSince.contains(since) {
                    throw EngineClientError.refused("range_unavailable:\(since.rawValue)", code: "range_unavailable")
                }
                return .fileDiff(id: nil, scope: .turn, path: path, diff: diff(path, "\(since?.rawValue ?? "review")@\(tree)"),
                                 truncated: false, endTree: tree, info: FileDiffInfo(since: since, baseTree: "A1", stale: stale))
            case let .fullFile(path, since):
                var view = FullFileView(path: path, lines: ["x"], changedNewLines: [1], deletedAfterNewLine: [:], isBinary: false, isTooLarge: false)
                view.since = since
                view.stale = stale
                return .fullFileContent(id: nil, view: view)
            default:
                throw EngineClientError.refused("unknown command \(command.type)")
            }
        }
    }

    private func attach(_ engine: FakeEngine, to app: AppState) {
        app.replySink = { [diff] command in try engine.answer(command, diff: diff) }
    }

    // MARK: comp-02 — reviewing while Claude works

    @Test func aSendKeepsTheDiffBeingReadAndServesThePendingFilesReadOnly() async throws {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        var verdicts: [EngineCommand] = []
        app.commandSink = { verdicts.append($0) }
        let a = file("a.ts"), b = file("b.ts")
        app.handle(.state(snapshot(seq: 1, files: [a, b])))
        #expect(app.selectedPath == "a.ts")
        await app.diffLoadTask?.value
        #expect(shownLabel(app) == "review@B1")
        #expect(!app.isShowingStaleDiff)

        // A question goes out on the standing review: B is held, the diff on screen stays (no spinner, no reload).
        app.handle(.state(snapshot(seq: 2, files: [a, b], phase: .running, end: nil, review: "B1")))
        #expect(shownLabel(app) == "review@B1")
        #expect(engine.asked.count == 1)
        #expect(app.isShowingStaleDiff)
        #expect(!app.isDiffUnavailable)

        // Another pending file opens during the turn (read-only, from the held B).
        engine.stale = true
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        #expect(engine.asked.last == .selectFile(path: "b.ts", since: nil))
        #expect(shownLabel(app) == "review@B1" && app.selectedDiffInfo.stale)

        // Accept applies during the turn (§34.2) and moves on; r2-review-flow M32: so does reject — the engine reverts the
        // file right after the turn's collection.
        #expect(!app.isAcceptLocked && !app.isRejectLocked)
        #expect(app.rejectLockReason == nil)
        app.accept(b)
        #expect(verdicts == [.accept(paths: ["b.ts"])])
        #expect(app.selectedPath == "a.ts")
        app.reject(a)
        app.rejectAll()
        #expect(verdicts == [.accept(paths: ["b.ts"]), .reject(paths: ["a.ts"], force: false), .rejectAll(force: false, includeExternal: false)])
        #expect(app.lastError == nil)
        app.acceptAll()
        #expect(verdicts.last == .acceptAll)

        // While the turn's changes are collected nothing can be decided (a second at most).
        app.handle(.state(snapshot(seq: 3, files: [a, b], phase: .collecting, end: nil, review: "B1")))
        #expect(app.isAcceptLocked && app.isShowingStaleDiff && app.isRejectLocked)
        app.accept(a)
        #expect(verdicts.count == 4)
        #expect(app.lastError == AppState.sessionRefusalText("session_running"))

        // The collection replaces B: the selected file reloads under the new B.
        engine.tree = "B2"
        engine.stale = false
        app.handle(.state(snapshot(seq: 4, files: [file("a.ts", blob: "a2"), file("b.ts", .accepted)], end: "B2", review: "B2")))
        await app.diffLoadTask?.value
        #expect(shownLabel(app) == "review@B2")
        #expect(!app.isShowingStaleDiff && !app.isAcceptLocked && !app.isRejectLocked)
    }

    /// §37.1 (integration of wave3 check-engine): while a collection failed the engine refuses reject / reject_all /
    /// reject_hunks / commit (`collect_failed`) — the Mac offers them disabled with "Retry first"; accept stays.
    @Test func aFailedCollectionLocksRejectAndRevertingPartsButNotAccept() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let a = file("a.ts"), b = file("b.ts")
        app.handle(.state(snapshot(seq: 1, files: [a, b], phase: .collectFailed) { $0.gate.collectError = "fatal: index.lock" }))
        let reason = AppState.sessionRefusalText("collect_failed")
        #expect(app.isRejectLocked && app.rejectLockReason == reason && app.collectFailedLockReason == reason)
        #expect(!app.isAcceptLocked)
        app.reject(a)
        app.rejectAll()
        #expect(sent.isEmpty)
        #expect(app.lastError == reason)
        #expect(await app.rejectHunks(a, hunks: [0]) == false)
        #expect(app.hunkRefusal?.refusal.message == reason)
        app.accept(b)
        #expect(sent == [.accept(paths: ["b.ts"])])
        // Retry succeeded: the locks go.
        app.handle(.state(snapshot(seq: 2, files: [a, file("b.ts", .accepted)])))
        #expect(!app.isRejectLocked && app.collectFailedLockReason == nil)
    }

    @Test func anOlderEngineKeepsTheShownDiffButOffersNoAcceptDuringATurn() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        let a = file("a.ts", noBlob: true), b = file("b.ts", noBlob: true)
        app.handle(.state(snapshot(seq: 1, files: [a, b], review: nil)))
        await app.diffLoadTask?.value
        #expect(shownLabel(app) == "review@B1")

        app.handle(.state(snapshot(seq: 2, files: [a, b], phase: .running, end: nil, review: nil)))
        #expect(shownLabel(app) == "review@B1" && app.isShowingStaleDiff)
        #expect(app.isAcceptLocked && app.acceptLockReason == AppState.sessionRefusalText("session_running"))
        // Nothing to ask an engine that refuses diffs during a turn: the pane says so instead of spinning.
        app.selectedPath = "b.ts"
        #expect(engine.asked.count == 1)
        #expect(app.selectedDiff == nil && app.isDiffUnavailable)
        // The file read before the turn comes back as it was.
        app.selectedPath = "a.ts"
        #expect(shownLabel(app) == "review@B1" && !app.isDiffUnavailable)
    }

    @Test func aTurnOnAFreshReviewDimsThePreviousRoundsFiles() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", .accepted), file("b.ts", .rejected)])))
        #expect(!app.isReviewListStale)
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts", .accepted), file("b.ts", .rejected)], phase: .running,
                                   start: "A2", end: nil, review: nil)))
        #expect(app.isReviewListStale)
    }

    // MARK: §34.1 ranges

    @Test func rangesAreOfferedOnlyWhereTheyShowSomethingElse() {
        var gate = snapshot(seq: 1, files: []).gate
        let plain = file("a.ts")
        #expect(ReviewRange.available(for: plain, gate: gate) == [.review])
        #expect(ReviewRange.defaultRange(for: plain, gate: gate) == .review)

        // "이번 턴" needs a review of several turns and a file this turn touched.
        let touched = file("a.ts") { $0.changedThisTurn = true }
        gate.reviewTurns = [4]
        #expect(ReviewRange.available(for: touched, gate: gate) == [.review])
        gate.reviewTurns = [3, 4]
        gate.lastTurnChanges = LastTurnChanges(turn: 4, files: 1, added: 1, deleted: 0)
        #expect(ReviewRange.available(for: touched, gate: gate) == [.review, .turn])
        #expect(ReviewRange.defaultRange(for: touched, gate: gate) == .review)

        // Right after a change request's follow-up, "이번 턴" is the request's range: only "요청 이후" is offered.
        gate.lastRequest = ReviewRequestInfo(turn: 4, at: "t", notes: 1)
        let followedUp = file("a.ts") { $0.changedThisTurn = true; $0.changedSinceRequest = true; $0.sentNoteCount = 1 }
        #expect(ReviewRange.available(for: followedUp, gate: gate) == [.review, .request])
        #expect(ReviewRange.defaultRange(for: followedUp, gate: gate) == .request)
        // A question turn after it: both differ now.
        gate.reviewTurns = [3, 4, 5]
        gate.lastTurnChanges = LastTurnChanges(turn: 5, files: 1, added: 1, deleted: 0)
        #expect(ReviewRange.available(for: followedUp, gate: gate) == [.review, .turn, .request])
        // A file the follow-up changed that was never sent back opens whole (nothing it holds was looked at yet).
        let neverSentBack = file("b.ts") { $0.changedSinceRequest = true }
        #expect(ReviewRange.defaultRange(for: neverSentBack, gate: gate) == .review)

        // Accepted, then changed again: "수락 이후", also its default while pending.
        let reopened = file("c.ts") { $0.changedSinceAccepted = true; $0.changedSinceRequest = true; $0.sentNoteCount = 2 }
        #expect(ReviewRange.available(for: reopened, gate: gate) == [.review, .request, .accepted])
        #expect(ReviewRange.defaultRange(for: reopened, gate: gate) == .accepted)
        // Decided files open whole.
        let decided = file("c.ts", .accepted) { $0.changedSinceAccepted = true }
        #expect(ReviewRange.defaultRange(for: decided, gate: gate) == .review)
        #expect(DiffSince.review.wire == nil && DiffSince.accepted.wire == .accepted)
    }

    @Test func theDiffOpensInItsRangeAndCachesPerRange() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        let a = file("a.ts") { $0.changedSinceAccepted = true }
        app.handle(.state(snapshot(seq: 1, files: [a])))
        await app.diffLoadTask?.value
        #expect(engine.asked == [.selectFile(path: "a.ts", since: .accepted)])
        #expect(app.selectedDiffSince == .accepted && shownLabel(app) == "accepted@B1")
        #expect(app.availableRanges(for: a) == [.review, .accepted])
        // Hunk ids of a range are not reject_hunks ids (§34.1): parts are reverted from the whole review only.
        #expect(!app.showsWholeReview)

        app.setDiffRange(.review, for: a)
        await app.diffLoadTask?.value
        #expect(engine.asked.last == .selectFile(path: "a.ts", since: nil))
        #expect(app.selectedDiffSince == .review && shownLabel(app) == "review@B1" && app.showsWholeReview)
        app.setDiffRange(.accepted, for: a)
        await app.diffLoadTask?.value
        #expect(engine.asked.count == 2)   // from the cache
        #expect(shownLabel(app) == "accepted@B1")

        // full_file follows the range.
        _ = try? await app.fullFile(for: a)
        #expect(engine.asked.last == .fullFile(path: "a.ts", since: .accepted))

        // A range the engine cannot answer (its trees are gone after a restore): back to the whole review.
        engine.refuseSince = [.request]
        let b = file("b.ts") { $0.changedSinceRequest = true; $0.sentNoteCount = 1 }
        app.handle(.state(snapshot(seq: 2, files: [a, b]) { $0.gate.lastRequest = ReviewRequestInfo(turn: 2, at: "t", notes: 1) }))
        app.selectedPath = "b.ts"
        await eventually { app.selectedDiffSince == .review && shownLabel(app) == "review@B1" }
        #expect(engine.asked.suffix(2) == [.selectFile(path: "b.ts", since: .request), .selectFile(path: "b.ts", since: nil)])
        #expect(app.selectedDiffSince == .review && app.lastError == nil)
    }

    @Test func aPickedRangeStaysUntilTheFileChangesAgain() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        let note = ReviewNote(id: "n1", path: "a.ts", line: 1, side: .new, excerpt: "x", body: "keep", sent: NoteSent(at: "t", turn: 2))
        let a = file("a.ts") { $0.changedSinceAccepted = true }
        app.handle(.state(snapshot(seq: 1, files: [a], notes: [note])))
        await app.diffLoadTask?.value
        app.setDiffRange(.review, for: a)
        await app.diffLoadTask?.value
        // "반영 확인" removes the note: same content, the range picked stays.
        app.handle(.state(snapshot(seq: 2, files: [a], end: "B2", review: "B2")))
        await app.diffLoadTask?.value
        #expect(app.selectedDiffSince == .review)
        // The file changed again: its default range comes back.
        app.handle(.state(snapshot(seq: 3, files: [file("a.ts", blob: "a3") { $0.changedSinceAccepted = true }], end: "B3", review: "B3")))
        await app.diffLoadTask?.value
        #expect(app.selectedDiffSince == .accepted)
        // A new review forgets every pick.
        app.setDiffRange(.review, for: app.changedFiles[0])
        await app.diffLoadTask?.value
        app.handle(.state(snapshot(seq: 4, files: [file("a.ts", blob: "a3") { $0.changedSinceAccepted = true }], start: "A9", end: "B3", review: "B3")))
        #expect(app.diffSince(for: app.changedFiles[0]) == .accepted)
    }

    // MARK: comp-08 — viewed by content

    @Test func viewedIsKeptPerContentAndOnlyAChangedFileLosesIt() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        let a = file("a.ts"), b = file("b.ts"), c = file("c.ts")
        app.handle(.state(snapshot(seq: 1, files: [a, b, c])))
        await app.diffLoadTask?.value
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["a.ts", "b.ts"] && app.viewedChangedCount == 2)

        // Rejecting c re-snapshots B: a and b keep their mark (before §34 every mark went).
        app.handle(.state(snapshot(seq: 2, files: [a, b], end: "B2", review: "B2")))
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["a.ts", "b.ts"])
        #expect(app.changedSinceViewedFiles.isEmpty)

        // A question turn changed both: b is on screen (reloaded there, so seen again), a is "본 뒤 바뀜".
        app.handle(.state(snapshot(seq: 3, files: [file("a.ts", blob: "a2"), file("b.ts", blob: "b2")], end: "B3", review: "B3")))
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["b.ts"])
        #expect(app.changedSinceViewedFiles.map(\.path) == ["a.ts"])
        #expect(app.unviewedPendingFiles.map(\.path) == ["a.ts"])
        app.selectedPath = "a.ts"
        await app.diffLoadTask?.value
        #expect(app.changedSinceViewedFiles.isEmpty && app.unviewedPendingFiles.isEmpty)

        // A new review (A moved) starts with nothing viewed.
        app.handle(.state(snapshot(seq: 4, files: [file("d.ts")], start: "A2", end: "B4", review: "B4")))
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["d.ts"] && app.changedSinceViewedFiles.isEmpty)
    }

    @Test func viewedWithoutBlobsFallsBackToTheLineCounts() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        let a = file("a.ts", noBlob: true), b = file("b.ts", noBlob: true)
        app.handle(.state(snapshot(seq: 1, files: [a, b], review: nil)))
        await app.diffLoadTask?.value
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        app.selectedPath = "a.ts"
        await app.diffLoadTask?.value
        // b changed (its counts moved), a did not.
        app.handle(.state(snapshot(seq: 2, files: [a, file("b.ts", noBlob: true, added: 4)], end: "B2", review: nil)))
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["a.ts"])
        #expect(app.changedSinceViewedFiles.map(\.path) == ["b.ts"])
        #expect(ViewedKey.content(file("x", noBlob: true, status: .deleted)) == "deleted")
    }

    // MARK: comp-10 — the list's order

    @Test func nextPreviousAndTheMoveAfterAVerdictFollowTheListOrder() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        var verdicts: [EngineCommand] = []
        app.commandSink = { verdicts.append($0) }
        // Git order a, b, c, d; risk first: the workflow (sensitive), then the deleted file, then the rest in git order.
        let files = [file("a.ts"), file("b.ts", status: .deleted), file(".github/workflows/ci.yml"), file("d.ts")]
        app.handle(.state(snapshot(seq: 1, files: files)))
        #expect(app.displayOrderedFiles.map(\.path) == [".github/workflows/ci.yml", "b.ts", "a.ts", "d.ts"])
        #expect(app.selectedPath == ".github/workflows/ci.yml")   // the first file on screen
        app.selectNextPending()
        #expect(app.selectedPath == "b.ts")
        app.selectNextPending()
        #expect(app.selectedPath == "a.ts")
        app.selectPreviousPending()
        #expect(app.selectedPath == "b.ts")
        // Accepting moves to the file below it on screen, not to git's first pending file.
        app.accept(files[1])
        #expect(verdicts == [.accept(paths: ["b.ts"])] && app.selectedPath == "a.ts")
        // The last one on screen wraps to the first pending file above.
        app.selectedPath = "d.ts"
        app.accept(files[3])
        #expect(app.selectedPath == ".github/workflows/ci.yml")

        // Git order when the list is set to it.
        let plain = makeState(riskOrder: false)
        plain.handle(.state(snapshot(seq: 1, files: files)))
        #expect(plain.displayOrderedFiles.map(\.path) == ["a.ts", "b.ts", ".github/workflows/ci.yml", "d.ts"])
        #expect(plain.selectedPath == "a.ts")
        plain.selectNextPending()
        #expect(plain.selectedPath == "b.ts")
    }

    // MARK: comp-06 — sent notes

    @Test func sentNotesStayOnTheirLinesAndOnlyUnsentOnesHoldTheReview() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let requested = ReviewNote(id: "n1", path: "a.ts", line: 1, side: .new, excerpt: "x", body: "b는 2 그대로",
                                   sent: NoteSent(at: "t", turn: 2), anchor: .moved)
        let gone = ReviewNote(id: "n2", path: "a.ts", line: 9, side: .new, excerpt: "y", body: "이 줄은?",
                              sent: NoteSent(at: "t", turn: 2), anchor: .gone)
        let oldSide = ReviewNote(id: "n3", path: "a.ts", line: 1, side: .old, excerpt: "z", body: "삭제 확인")
        let offRange = ReviewNote(id: "n4", path: "a.ts", line: 30, side: .new, excerpt: "w", body: "범위 밖")
        let a = file("a.ts") { $0.sentNoteCount = 2; $0.changedSinceRequest = true }
        app.handle(.state(snapshot(seq: 1, files: [a], notes: [requested, gone, oldSide, offRange]) {
            $0.gate.lastRequest = ReviewRequestInfo(turn: 2, at: "t", notes: 2)
        }))
        await app.diffLoadTask?.value
        #expect(app.selectedDiffSince == .request)
        #expect(app.unsentNotes.map(\.id) == ["n3", "n4"])
        #expect(app.inlineNotes(path: "a.ts", side: .new, line: 1).map(\.id) == ["n1"])
        // In a range the old side is not A: old-side notes, gone lines and lines the range does not show go above it.
        #expect(app.inlineNotes(path: "a.ts", side: .old, line: 1).isEmpty)
        #expect(app.displacedNotes(path: "a.ts").map(\.id) == ["n2", "n3", "n4"])
        app.setDiffRange(.review, for: a)
        await app.diffLoadTask?.value
        // The whole review anchors the old side, but this diff has no line −1: still listed above it.
        #expect(app.displacedNotes(path: "a.ts").map(\.id) == ["n2", "n3", "n4"])
        #expect(app.inlineNotes(path: "a.ts", side: .new, line: 1).map(\.id) == ["n1"])

        // "반영 확인" removes the sent note.
        app.markAddressed(requested)
        #expect(sent.last == .removeNote(noteId: "n1"))

        // Sent notes alone never block switching chats or rewinding (the engine only counts unsent ones).
        app.handle(.state(snapshot(seq: 2, files: [a], notes: [requested, gone])))
        #expect(app.chatSwitchBlocker == nil)
        #expect(app.unsentNotes.isEmpty)
        app.handle(.state(snapshot(seq: 3, files: [a], notes: [requested, oldSide])))
        #expect(app.chatSwitchBlocker == nil)   // r2-chats-cards M31 (§9): unsent notes stay in the review, the switch goes
    }

    @Test func notePlacementIsPure() {
        let d = FileDiff(oldPath: "a", newPath: "a", isBinary: false, hunks: [DiffHunk(id: 0, header: "@@", lines: [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@"),
            DiffLine(id: 1, kind: .del, oldNo: 4, newNo: nil, text: "old"),
            DiffLine(id: 2, kind: .add, oldNo: nil, newNo: 4, text: "new"),
            DiffLine(id: 3, kind: .context, oldNo: 5, newNo: 5, text: "same"),
        ])])
        let notes = [
            ReviewNote(id: "old4", path: "a", line: 4, side: .old, excerpt: "old", body: "x"),
            ReviewNote(id: "new4", path: "a", line: 4, side: .new, excerpt: "new", body: "x"),
            ReviewNote(id: "ctx5", path: "a", line: 5, side: .new, excerpt: "same", body: "x"),
            ReviewNote(id: "file", path: "a", line: nil, side: .new, excerpt: "", body: "x"),
            ReviewNote(id: "other", path: "b", line: 4, side: .new, excerpt: "", body: "x"),
        ]
        #expect(NotePlacement.inline(notes, path: "a", side: .old, line: 4, since: .review).map(\.id) == ["old4"])
        #expect(NotePlacement.inline(notes, path: "a", side: .old, line: 4, since: .turn).isEmpty)
        #expect(NotePlacement.inline(notes, path: "a", side: .new, line: 4, since: .turn).map(\.id) == ["new4"])
        #expect(NotePlacement.displaced(notes, path: "a", since: .review, diff: d).map(\.id) == ["file"])
        #expect(NotePlacement.displaced(notes, path: "a", since: .turn, diff: d).map(\.id) == ["old4", "file"])
        #expect(NotePlacement.displaced(notes, path: "a", since: .review, diff: nil).isEmpty)
    }

    // MARK: §34.4 — the round in progress

    @Test func historyShowsTheRoundInProgress() async {
        let app = makeState()
        let round = ReviewHistoryEntry(id: "r9", sessionId: "s", turns: [3, 4], prompt: "Add cart check",
                                       files: [ReviewHistoryFile(path: "a.ts", verdict: .pending)], turnStartTree: "A1", turnEndTree: "B1")
        var current = round
        current.inProgress = true
        let past = ReviewHistoryEntry(id: "r1", prompt: "older")
        app.replySink = { command in
            if case .reviewHistory = command { return .reviewHistory(id: "h", sessionId: "s", entries: [past], current: current) }
            throw EngineClientError.refused("unknown command")
        }
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts")])))
        await app.loadReviewHistory()
        #expect(app.reviewHistory.map(\.id) == ["r1"])
        #expect(app.currentReviewRound?.id == "r9" && app.currentReviewRound?.inProgress == true)
        // Its files open like a past round's (history_diff with the current round's id).
        app.replySink = { command in
            if case let .historyDiff(entryId, path) = command {
                return .historyDiff(id: "d", entryId: entryId, path: path, diff: FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: []), truncated: false)
            }
            throw EngineClientError.refused("unknown command")
        }
        await app.openHistoryDiff(entryId: "r9", path: "a.ts")
        #expect(app.historyEntry?.id == "r9" && app.historyFile?.path == "a.ts" && app.historyDiff != nil)
    }

    // MARK: comp-04 — this turn

    @Test func theTurnEndRowCountsThisTurnAndTheReviewItMergedInto() {
        let app = makeState()
        let usage = Usage(inputTokens: 1, outputTokens: 2, costUsd: 0.5, durationMs: 1500)
        app.handle(.turnEnd(stopReason: "end_turn", usage: usage, files: 1, added: 2, deleted: 1, external: 0,
                            review: TurnEndReview(review: ChangeTotals(files: 5, added: 40, deleted: 7), merged: true)))
        app.handle(.turnEnd(stopReason: "end_turn", usage: usage, files: 2, added: 3, deleted: 0))
        let rows = app.transcript.compactMap { item -> String? in
            if case let .turnEnd(_, summary) = item { return summary }
            return nil
        }
        // wave4b w4b-check4 (§40.1): the stop reason in words ("end_turn" → "Finished").
        let merged = String(localized: "This turn changed \(1) file(s) (+\(2) −\(1)) · review \(5) file(s) (+\(40) −\(7)) · \("Finished")", bundle: .module)
        let fresh = String(localized: "Changed \(2) file(s) (+\(3) −\(0)) · \("Finished")", bundle: .module)
        #expect(rows == [merged + " · $0.5000 · 1.5s", fresh + " · $0.5000 · 1.5s"])
        // A restored row reads the same.
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 4, kind: .turnEnd(
            stopReason: "end_turn", usage: usage, files: 1, added: 2, deleted: 1, changedOutside: [],
            review: TurnEndReview(review: ChangeTotals(files: 5, added: 40, deleted: 7), merged: true)))]))
        guard case let .turnEnd(_, restored) = app.transcript[0] else { Issue.record("no restored turn end"); return }
        #expect(restored == merged + " · $0.5000 · 1.5s")
    }

    @Test func aTurnThatChangedNothingHasNoSummaryCard() {
        let app = makeState()
        app.handle(.turnSummary(TurnSummary(turn: 5)))
        #expect(app.transcript.isEmpty)
        app.handle(.turnSummary(TurnSummary(turn: 6, files: [TurnSummary.File(path: "a.ts")])))
        #expect(app.transcript.count == 1)
    }

    // MARK: comp-03 — live changes

    @Test func liveChangesWhileATurnRuns() async {
        let app = makeState()
        app.liveRefreshDelay = .zero
        var asked: [EngineCommand] = []
        let live = LiveChanges(id: "l", running: true, turn: 5, baseTree: "T5", liveTree: "L1", at: "t", files: [
            LiveChangedFile(path: "a.ts", added: 12, deleted: 3, inReview: true),
            LiveChangedFile(path: "package-lock.json", added: 300, deleted: 200, generated: .lockfile),
        ])
        app.replySink = { command in
            if case .sideList = command { return .sideThreads(id: nil, mainSessionId: "s", threads: []) }
            asked.append(command)
            switch command {
            case .liveChanges: return .liveChanges(live)
            case let .liveDiff(path):
                if path == "gone.ts" { throw EngineClientError.refused("not_a_live_file:gone.ts", code: "not_a_live_file") }
                return .fileDiff(id: nil, scope: .live, path: path, diff: diff(path, "live@L1"), truncated: false, endTree: "L1",
                                 info: FileDiffInfo(baseTree: "T5"))
            case let .selectFile(path, since):
                return .fileDiff(id: nil, scope: .turn, path: path, diff: diff(path, "\(since?.rawValue ?? "review")@B2"), truncated: false, endTree: "B2")
            default: throw EngineClientError.refused("unknown command")
            }
        }
        app.handle(.state(snapshot(seq: 1, files: [], start: "A1", end: nil, review: nil)))
        #expect(app.liveChip == nil)
        // The turn touches files: the list is fetched (debounced) and summed up for the HUD.
        app.handle(.state(snapshot(seq: 2, files: [], phase: .running, end: nil, review: nil) { $0.hud.turnFiles = 2 }))
        await app.liveRefreshTask?.value
        await eventually { app.liveChip?.added != nil }
        #expect(asked.first == .liveChanges)
        #expect(app.liveChip == LiveChipSummary(files: 2, added: 312, deleted: 203))

        // The same file edited again (hud.turnFiles stays 2): a writing call's end asks again; a read does not.
        app.liveMinGap = 0
        let before = asked.filter { $0 == .liveChanges }.count
        app.handle(.toolUse(id: "r1", name: "Read", input: .object([:]), file: "a.ts", info: ToolUseInfo()))
        app.handle(.toolResult(toolUseId: "r1", isError: false, preview: "", info: ToolResultInfo()))
        #expect(app.liveRefreshTask == nil)
        app.handle(.toolUse(id: "e2", name: "Edit", input: .object([:]), file: "a.ts", info: ToolUseInfo()))
        app.handle(.toolResult(toolUseId: "e2", isError: false, preview: "", info: ToolResultInfo()))
        await app.liveRefreshTask?.value
        await eventually { asked.filter { $0 == .liveChanges }.count > before }
        #expect(asked.filter { $0 == .liveChanges }.count == before + 1)

        // A live file's diff opens read-only.
        await app.openLiveDiff("a.ts")
        #expect(asked.last == .liveDiff(path: "a.ts"))
        #expect(app.liveSelection == "a.ts" && app.liveDiff?.allLines.last?.text == "live@L1")
        await app.openLiveDiff("gone.ts")
        #expect(app.liveDiff?.hunks.isEmpty == true && app.liveDiffError == nil)   // unchanged between the trees: "No changes"
        await app.openLiveDiff("a.ts")

        // The turn is collected: the live list goes, the pane shows the file in the review.
        app.handle(.state(snapshot(seq: 3, files: [file("a.ts")], end: "B2", review: "B2")))
        #expect(app.liveChanges == nil && app.liveChip == nil && app.liveSelection == nil)
        #expect(app.selectedPath == "a.ts")
        await app.diffLoadTask?.value
        #expect(shownLabel(app) == "review@B2")
    }

    @Test func anEngineWithoutLiveChangesIsNotAskedAgain() async {
        let app = makeState()
        var asked = 0
        app.replySink = { command in
            if case .sideList = command { return .sideThreads(id: nil, mainSessionId: "s", threads: []) }
            asked += 1
            throw EngineClientError.refused("unknown command: live_changes", code: "unknown_command")
        }
        app.handle(.state(snapshot(seq: 1, files: [], phase: .running, end: nil, review: nil)))
        await app.refreshLiveChanges()
        #expect(app.liveChangesUnsupported && app.liveChanges == nil && app.lastError == nil)
        await app.refreshLiveChanges()
        #expect(asked == 1)
    }

    // MARK: §17 with §34.1 — reject_hunks names the diff's old side

    @Test func rejectHunksEchoesTheBaseTreeOfTheShownDiff() async {
        let app = makeState()
        let engine = FakeEngine()
        attach(engine, to: app)
        var sent: [EngineCommand] = []
        app.requestSink = { sent.append($0) }
        let a = file("a.ts")
        app.handle(.state(snapshot(seq: 1, files: [a])))
        await app.diffLoadTask?.value
        #expect(await app.rejectHunks(a, hunks: [0]))
        #expect(sent == [.rejectHunks(path: "a.ts", hunks: [0], expectedEndTree: "B1", expectedBaseTree: "A1")])
    }

    // MARK: Settings — checkpoint ignore patterns

    @Test func ignorePatternsGoToTheEngineWhenEditingEndsAndOnlyWhenChanged() {
        let defaults = UserDefaults(suiteName: "ReviewRoundFlowTests.ignore.\(UUID().uuidString)")!
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        defaults.set(".omc/\n*.log", forKey: AppSettings.Key.checkpointIgnorePatterns)
        app.commitIgnorePatterns()
        #expect(sent == [.setSettings(EngineSettings(ignorePatterns: [".omc/", "*.log"]))])
        app.commitIgnorePatterns()   // nothing changed since
        #expect(sent.count == 1)
        defaults.set(".omc/", forKey: AppSettings.Key.checkpointIgnorePatterns)
        app.commitIgnorePatterns()
        #expect(sent.last == .setSettings(EngineSettings(ignorePatterns: [".omc/"])))
        // "무시 패턴에 추가" (§32) counts as what the engine has.
        app.addIgnorePatterns(["build/"])
        let afterAdd = sent.count
        app.commitIgnorePatterns()
        #expect(sent.count == afterAdd)
    }
}
