import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 check-clients — review round 2 (docs/PROTOCOL.md §34) on the Mac where it differed from Electron or misled: the
/// "요청 후 바뀌지 않음" mark, the HUD's "진행 중" chip from `hud.turnFiles` on, "반영 확인" while a change request runs, and
/// Accept all counting a file viewed-then-changed once.
@Suite @MainActor struct ReviewRoundCheckTests {
    private func makeState() -> AppState {
        let defaults = UserDefaults(suiteName: "ReviewRoundCheckTests.\(UUID().uuidString)")!
        return AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending, blob: String? = nil,
                      _ change: (inout ChangedFile) -> Void = { _ in }) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
        f.blob = blob ?? "blob-\(path)"
        change(&f)
        return f
    }

    private func snapshot(seq: Int, files: [ChangedFile], phase: GatePhase = .reviewing, end: String? = "B1", review: String? = "B1",
                          notes: [ReviewNote] = [], _ change: (inout ReviewState) -> Void = { _ in }) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: phase == .reviewing, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0,
                          isRequestingChanges: false, turnStartTree: "A1", turnEndTree: end, lastReviewSummary: nil)
        s.gate.reviewEndTree = review
        s.changedFiles = files
        s.reviewNotes = notes
        change(&s)
        return s
    }

    private func diff(_ path: String) -> FileDiff {
        FileDiff(oldPath: path, newPath: path, isBinary: false, hunks: [
            DiffHunk(id: 0, header: "@@ -1 +1 @@", lines: [
                DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1 +1 @@"),
                DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 1, text: path),
            ]),
        ])
    }

    private func answerDiffs(_ app: AppState) {
        app.replySink = { [diff] command in
            switch command {
            case .sideList: return .sideThreads(id: nil, mainSessionId: "s", threads: [])
            case let .selectFile(path, _):
                return .fileDiff(id: nil, scope: .turn, path: path, diff: diff(path), truncated: false, endTree: "B1", info: FileDiffInfo(baseTree: "A1"))
            default: throw EngineClientError.refused("unknown command \(command.type)")
            }
        }
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }

    // MARK: "요청 후 바뀌지 않음" (Electron's `unchangedSinceRequest`)

    @Test func unchangedSinceRequestOnlyOnceTheFollowUpWasCollected() {
        var g = GateInfo(phase: .reviewing, canSend: true, canRequestChanges: true, blockedReason: nil, collectError: nil,
                         pendingCount: 1, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "A1",
                         turnEndTree: "B2", lastReviewSummary: nil)
        let sentAlone = file("a.ts") { $0.sentNoteCount = 1 }
        let sentChanged = file("b.ts") { $0.sentNoteCount = 1; $0.changedSinceRequest = true }
        let noNotes = file("c.ts")
        // No request in this review: nothing to say.
        #expect(!ReviewRange.unchangedSinceRequest(sentAlone, gate: g))
        // The request went out (follow-up turn 4) but turn 4 is not collected yet: the follow-up may still change it.
        g.lastRequest = ReviewRequestInfo(turn: 4, at: "t", notes: 1)
        g.lastTurnChanges = LastTurnChanges(turn: 3, files: 1)
        #expect(!ReviewRange.unchangedSinceRequest(sentAlone, gate: g))
        // Turn 4 collected: a file with sent notes it left alone says so; one it changed, or one without sent notes, does not.
        g.lastTurnChanges = LastTurnChanges(turn: 4, files: 1)
        #expect(ReviewRange.unchangedSinceRequest(sentAlone, gate: g))
        #expect(!ReviewRange.unchangedSinceRequest(sentChanged, gate: g))
        #expect(!ReviewRange.unchangedSinceRequest(noNotes, gate: g))
    }

    // MARK: the HUD's "진행 중" from hud.turnFiles (Electron's InProgressChip)

    @Test func theInProgressChipShowsFromTheTurnsFileCountBeforeTheListArrives() async {
        let app = makeState()
        app.liveRefreshDelay = .seconds(60)   // the list is not fetched by itself here
        app.handle(.state(snapshot(seq: 1, files: [], end: nil, review: nil)))
        #expect(app.liveChip == nil)
        // The turn touched two files: the chip says so at once, without +/− (no list yet).
        app.handle(.state(snapshot(seq: 2, files: [], phase: .running, end: nil, review: nil) { $0.hud.turnFiles = 2 }))
        #expect(app.liveChip == LiveChipSummary(files: 2, added: nil, deleted: nil))
        // The list arrives with both files: +/− from it.
        app.replySink = { command in
            if case .sideList = command { return .sideThreads(id: nil, mainSessionId: "s", threads: []) }
            return .liveChanges(LiveChanges(id: "l", running: true, turn: 5, baseTree: "T", liveTree: "L", at: "t", files: [
                LiveChangedFile(path: "a.ts", added: 12, deleted: 3), LiveChangedFile(path: "b.ts", added: 1, deleted: 0),
            ]))
        }
        await app.refreshLiveChanges()
        #expect(app.liveChip == LiveChipSummary(files: 2, added: 13, deleted: 3))
        // A third file since the list: the count follows the turn, the +/− wait for a list that has it.
        app.handle(.state(snapshot(seq: 3, files: [], phase: .running, end: nil, review: nil) { $0.hud.turnFiles = 3 }))
        #expect(app.liveChip == LiveChipSummary(files: 3, added: nil, deleted: nil))
        // An engine before §34 (no turnFiles, no list) and a turn that touched nothing: no chip.
        app.liveRefreshTask?.cancel()
        app.handle(.state(snapshot(seq: 4, files: [], end: "B2", review: "B2")))
        #expect(app.liveChip == nil)
        app.handle(.state(snapshot(seq: 5, files: [], phase: .running, end: nil, review: nil)))
        #expect(app.liveChip == nil)
    }

    // MARK: "반영 확인" while the change request it answers runs

    @Test func markAsAddressedWaitsWhileTheChangeRequestRuns() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let note = ReviewNote(id: "n1", path: "a.ts", line: 1, side: .new, excerpt: "x", body: "keep b", sent: NoteSent(at: "t", turn: 4))
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts") { $0.sentNoteCount = 1 }], phase: .running, end: nil, notes: [note]) {
            $0.gate.isRequestingChanges = true
        }))
        #expect(app.noteLockReason == AppState.sessionRefusalText("session_running"))
        app.markAddressed(note)
        #expect(sent.isEmpty)
        #expect(app.lastError == AppState.sessionRefusalText("session_running"))
        // The follow-up was collected: the note can be checked off.
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts") { $0.sentNoteCount = 1 }], end: "B2", review: "B2", notes: [note])))
        #expect(app.noteLockReason == nil)
        app.markAddressed(note)
        #expect(sent == [.removeNote(noteId: "n1")])
    }

    // MARK: the turn summary card — the whole review apart from this turn (§34.3, as Electron's summaryReviewTotals)

    @Test func theSummaryShowsTheReviewTotalsOnlyForAMergedTurn() {
        var summary = TurnSummary(turn: 4, files: [TurnSummary.File(path: "a.ts", adds: 2, dels: 1)], commands: [], plan: nil)
        #expect(summary.reviewTotalsShown == nil)                       // an engine before §34
        summary.review = ChangeTotals(files: 1, added: 2, deleted: 1)
        #expect(summary.reviewTotalsShown == nil)                       // a fresh turn: its review is this turn
        summary.merged = true
        summary.review = ChangeTotals(files: 5, added: 40, deleted: 7)
        #expect(summary.reviewTotalsShown == ChangeTotals(files: 5, added: 40, deleted: 7))
        summary.review = nil
        #expect(summary.reviewTotalsShown == nil)
    }

    // MARK: Accept all — a file viewed and then changed is counted once

    @Test func acceptAllCountsNeverViewedAndChangedSinceViewedApart() async {
        let app = makeState()
        answerDiffs(app)
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", blob: "a1"), file("b.ts", blob: "b1"), file("c.ts", blob: "c1")])))
        await app.diffLoadTask?.value
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        // A question turn changed a.ts after it was viewed; b.ts is on screen (seen again); c.ts was never opened.
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts", blob: "a2"), file("b.ts", blob: "b2"), file("c.ts", blob: "c1"),
                                                  file("d.ts", .accepted, blob: "d1")], end: "B2", review: "B2")))
        await app.diffLoadTask?.value
        #expect(app.neverViewedPendingFiles.map(\.path) == ["c.ts"])
        #expect(app.changedSinceViewedPendingFiles.map(\.path) == ["a.ts"])
        // Together they are the pending files whose current content was not shown (what "not viewed" always meant).
        #expect(Set(app.unviewedPendingFiles.map(\.path)) == ["a.ts", "c.ts"])
    }

    // MARK: the summary's test line reads the same on both clients (§34.9)

    @Test func theTestLineReadsTheSameOnBothClients() throws {
        // `lastTest: null` is a §34 engine saying no test ran this turn; an engine before §34 sends no key at all.
        let none = try NDJSON.decode(TurnSummary.self, from: #"{"type":"turn_summary","turn":3,"files":[],"commands":[],"plan":null,"lastTest":null}"#)
        #expect(none.lastTest == nil && none.lastTestReported)
        let legacy = try NDJSON.decode(TurnSummary.self, from: #"{"type":"turn_summary","turn":3,"files":[],"commands":[],"plan":null}"#)
        #expect(!legacy.lastTestReported)
        #expect(TestVerdictLine(nil, reported: true) == .noTestRun)
        #expect(TestVerdictLine(nil, reported: false) == nil)   // the old count-based chips then
        #expect(TestVerdictLine.noTestRun.text == TestVerdictLine.noTestAfterEdit.text)
        #expect(TestVerdictLine.noTestRun.help(nil) == String(localized: "No test command ran in this turn", bundle: .module))
        // a run an edit came after covers nothing, whatever it said — the tooltip keeps what it said and the command
        let failed = LastTest(verdict: .fail, command: "./mvn25.sh  -q -o test", afterLastEdit: false, runs: 2)
        #expect(TestVerdictLine(failed, reported: true) == .noTestAfterEdit)
        #expect(TestVerdictLine.noTestAfterEdit.help(failed)
                == String(localized: "The last test failed before a later edit", bundle: .module) + "\n$ ./mvn25.sh -q -o test · ×2")
        let passed = LastTest(verdict: .pass, command: "npm test", afterLastEdit: true)
        #expect(TestVerdictLine(passed, reported: true) == .passedAfterEdit)
        #expect(TestVerdictLine.passedAfterEdit.help(passed) == "$ npm test")
        // a verdict this client does not know says nothing, either way (Electron returns null too)
        #expect(TestVerdictLine(LastTest(verdict: nil, command: "npm test", afterLastEdit: false), reported: true) == nil)
    }

    // MARK: a range other than the whole review says where its line tools went (as Electron, not hidden)

    @Test func aRangeOtherThanTheWholeReviewSaysWhereItsLineToolsAre() async {
        let app = makeState()
        answerDiffs(app)
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts") { $0.changedThisTurn = true }, file("b.ts", .accepted) { $0.changedThisTurn = true }]) {
            $0.gate.reviewTurns = [3, 4]
            $0.gate.lastTurnChanges = LastTurnChanges(turn: 4, files: 2)
        }))
        await app.diffLoadTask?.value
        let side = String(localized: "Line side questions are in the “Whole review” view", bundle: .module)
        let parts = String(localized: "Parts can be reverted in the “Whole review” view", bundle: .module)
        #expect(app.rangeHints(for: app.changedFiles[0]).isEmpty)          // the whole review: everything is there
        app.setDiffRange(.turn, for: app.changedFiles[0])
        await app.diffLoadTask?.value
        #expect(app.rangeHints(for: app.changedFiles[0]) == [side, parts])  // pending, modified text: parts too
        app.setDiffRange(.turn, for: app.changedFiles[1])
        #expect(app.rangeHints(for: app.changedFiles[1]) == [side])         // decided: nothing to revert
    }

    // MARK: "봤음" only for a diff that was on screen (as Electron's markViewed)

    @Test func aDiffThatFailedToLoadIsNotViewed() async {
        let app = makeState()
        var failing = true
        app.replySink = { [diff] command in
            switch command {
            case .sideList: return .sideThreads(id: nil, mainSessionId: "s", threads: [])
            case let .selectFile(path, _):
                if failing { throw EngineClientError.refused("no_review") }
                return .fileDiff(id: nil, scope: .turn, path: path, diff: diff(path), truncated: false, endTree: "B1", info: FileDiffInfo(baseTree: "A1"))
            default: throw EngineClientError.refused("unknown command \(command.type)")
            }
        }
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", blob: "a1"), file("b.ts", blob: "b1")])))
        await app.diffLoadTask?.value
        #expect(app.selectedPath == "a.ts" && app.selectedDiff == nil)
        #expect(app.viewedPaths.isEmpty)               // the load failed: nothing of a.ts was shown
        #expect(app.neverViewedPendingFiles.count == 2)
        failing = false
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        #expect(app.viewedPaths == ["b.ts"])           // shown → viewed
    }

    @Test func aDecidedFileIsNeverCountedAsChangedSinceViewed() async {
        let app = makeState()
        answerDiffs(app)
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", blob: "a1"), file("b.ts", blob: "b1")])))
        await app.diffLoadTask?.value
        app.selectedPath = "b.ts"
        await app.diffLoadTask?.value
        // a.ts was viewed and accepted; its blob moved (a refresh took the user's later edit as the review).
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts", .accepted, blob: "a2"), file("b.ts", blob: "b1")], end: "B2", review: "B2")))
        await app.diffLoadTask?.value
        #expect(app.changedSinceViewed(app.changedFiles[0]))   // the fact stays …
        #expect(app.changedSinceViewedPendingFiles.isEmpty)    // … but nothing is left to look at
        #expect(!app.showsChangedSinceViewed(app.changedFiles[0]))
    }
}
