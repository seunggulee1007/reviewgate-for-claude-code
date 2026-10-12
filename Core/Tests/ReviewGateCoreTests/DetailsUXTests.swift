import Foundation
import Testing
@testable import ReviewGateCore

/// Small review gaps of daily use: Review › Undo Accept after ⌘⇧A has moved on, Undo Reject from the menu, why
/// "Commit accepted" waits, and the commit message (typed, or drafted by Claude) outliving its sheet.
@Suite @MainActor struct DetailsUXTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "DetailsUXTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
    }

    private func snapshot(seq: Int, files: [ChangedFile], phase: GatePhase = .reviewing, start: String = "A1",
                          _ change: (inout ReviewState) -> Void = { _ in }) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: true, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0,
                          isRequestingChanges: false, turnStartTree: start, turnEndTree: phase == .reviewing ? "B1" : nil,
                          lastReviewSummary: nil)
        s.gate.reviewEndTree = "B1"
        s.changedFiles = files
        change(&s)
        return s
    }

    // MARK: Undo Accept

    @Test func undoAcceptFindsTheFileTheSelectionMovedOnFrom() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts"), file("b.ts")])))
        #expect(app.selectedPath == "a.ts")
        #expect(app.undoAcceptTarget == nil && !MenuState(app).canUndoAccept)

        // ⌘⇧A: accepted, and the selection is on b.ts already.
        app.accept(file("a.ts"))
        #expect(app.selectedPath == "b.ts" && app.lastAcceptedPath == "a.ts")
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts", .accepted), file("b.ts")])))
        #expect(app.undoAcceptTarget?.path == "a.ts")
        #expect(MenuState(app).canUndoAccept)

        // ⌘⇧U: a.ts is pending again and selected — its diff is back.
        app.undoAccept()
        #expect(sent == [.accept(paths: ["a.ts"]), .unaccept(paths: ["a.ts"])])
        #expect(app.selectedPath == "a.ts" && app.lastAcceptedPath == nil)
        app.handle(.state(snapshot(seq: 3, files: [file("a.ts"), file("b.ts")])))
        #expect(app.undoAcceptTarget == nil && !MenuState(app).canUndoAccept)
    }

    @Test func theSelectedAcceptedFileComesFirstAndALockOrANewReviewTurnsItOff() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", .accepted), file("b.ts"), file("c.ts")])))
        app.selectedPath = "b.ts"
        app.accept(file("b.ts"))
        app.handle(.state(snapshot(seq: 2, files: [file("a.ts", .accepted), file("b.ts", .accepted), file("c.ts")])))
        // An accepted file picked in the list is what Undo Accept means.
        app.selectedPath = "a.ts"
        #expect(app.undoAcceptTarget?.path == "a.ts")
        app.selectedPath = "c.ts"
        #expect(app.undoAcceptTarget?.path == "b.ts")

        // While a turn runs the engine refuses unaccept: the item waits.
        app.handle(.state(snapshot(seq: 3, files: [file("a.ts", .accepted), file("b.ts", .accepted), file("c.ts")], phase: .running)))
        #expect(!MenuState(app).canUndoAccept)
        app.undoAccept()
        #expect(sent == [.accept(paths: ["b.ts"])])

        // A new review (another A) forgets it.
        app.handle(.state(snapshot(seq: 4, files: [file("b.ts", .accepted), file("d.ts")], start: "A2")))
        #expect(app.lastAcceptedPath == nil)
        app.selectedPath = "d.ts"
        #expect(app.undoAcceptTarget == nil)
    }

    // MARK: Undo Reject

    @Test func undoRejectIsOnTheMenuWhileTheBannerCanPutTheFileBack() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, files: [file("b.ts")])))
        #expect(!MenuState(app).canUndoReject)
        app.handle(.state(snapshot(seq: 2, files: [file("b.ts")]) {
            $0.gate.rejectUndo = RejectUndoInfo(path: "a.ts", available: true, reason: nil)
        }))
        #expect(MenuState(app).canUndoReject)
        app.undoLastReject()
        #expect(sent == [.rejectUndo(path: "a.ts")])
        // The file changed on disk since: the banner says why, the menu item is off.
        app.handle(.state(snapshot(seq: 3, files: [file("b.ts")]) {
            $0.gate.rejectUndo = RejectUndoInfo(path: "a.ts", available: false, reason: "changed_on_disk")
        }))
        #expect(!MenuState(app).canUndoReject)
    }

    // MARK: Commit accepted

    @Test func commitSaysWhyItWaits() {
        let app = makeState()
        let accepted = [file("a.ts", .accepted)]
        app.handle(.state(snapshot(seq: 1, files: accepted)))
        #expect(app.commitLockReason == nil)
        app.handle(.state(snapshot(seq: 2, files: accepted, phase: .running)))
        #expect(app.commitLockReason == AppState.sessionRefusalText("session_running"))
        app.handle(.state(snapshot(seq: 3, files: accepted, phase: .collecting)))
        #expect(app.commitLockReason == AppState.sessionRefusalText("session_running"))
        app.handle(.state(snapshot(seq: 4, files: accepted, phase: .reverting)))
        #expect(app.commitLockReason == AppState.sessionRefusalText("reverting"))
        app.handle(.state(snapshot(seq: 5, files: accepted, phase: .collectFailed) { $0.gate.collectError = "fatal: index.lock" }))
        #expect(app.commitLockReason == AppState.sessionRefusalText("collect_failed"))
    }

    @Test func aCommitDraftOutlivesTheSheetUntilOneTakesItAndAnotherProjectForgetsBoth() async {
        let app = makeState()
        app.commandSink = { _ in }
        app.replySink = { command in
            switch command {
            case .sideList: return .sideThreads(id: nil, mainSessionId: "s", threads: [])
            case .commitDraft: return .commitDraft(CommitDraftReply(id: "c1", message: " fix: a\n"))
            default: throw EngineClientError.refused("unknown command \(command.type)")
            }
        }
        app.handle(.state(snapshot(seq: 1, files: [file("a.ts", .accepted)])))
        // The draft finished (its sheet may be closed by now): the next sheet takes it, once.
        _ = await app.flow.draftCommitMessage(paths: ["a.ts"])
        #expect(app.flow.finishedCommitDraft == "fix: a")
        #expect(app.flow.takeFinishedCommitDraft() == "fix: a")
        #expect(app.flow.finishedCommitDraft == nil && app.flow.takeFinishedCommitDraft() == nil)

        // What was typed stays the window's until a commit; another project forgets it and an untaken draft.
        app.flow.commitMessageDraft = "wip: typed"
        _ = await app.flow.draftCommitMessage(paths: nil)
        #expect(app.flow.commitMessageDraft == "wip: typed" && app.flow.finishedCommitDraft == "fix: a")
        app.handle(.state(snapshot(seq: 2, files: []) {
            $0.project = ProjectInfo(path: "/other", root: "/other", name: "other", branch: "main", remoteURL: nil)
        }))
        #expect(app.flow.commitMessageDraft == nil && app.flow.finishedCommitDraft == nil)
    }
}
