import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow M32 (docs/PROTOCOL.md §34.2): `rejectScheduled` on the wire, reject taken while Claude works on a standing
/// review, and the gray rows that say what became of it.
@Suite @MainActor struct ReviewFlowRejectTests {
    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ReviewFlowTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending, scheduled: Bool = false) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: state)
        f.rejectScheduled = scheduled
        return f
    }

    private func snapshot(seq: Int, phase: GatePhase, reviewEndTree: String?, files: [ChangedFile], canSend: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "a", turnEndTree: nil, lastReviewSummary: nil)
        s.gate.reviewEndTree = reviewEndTree
        s.changedFiles = files
        return s
    }

    private func detail(_ code: String, _ text: String) -> EngineErrorDetail {
        var d = EngineErrorDetail(code: code)
        d.detail = text
        return d
    }

    // MARK: M32

    @Test func rejectScheduledIsReadFromTheWireAndFalseWithoutIt() throws {
        let json = #"[{"path":"a.txt","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"state":"pending","rejectScheduled":true},{"path":"b.txt","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"state":"pending"},{"path":"c.txt","oldPath":null,"status":"M","added":1,"deleted":0,"isBinary":false,"state":"pending","rejectScheduled":"yes"}]"#
        let files = try JSONDecoder().decode([ChangedFile].self, from: Data(json.utf8))
        #expect(files.map(\.rejectScheduled) == [true, false, false])
    }

    @Test func rejectWhileClaudeWorksIsTakenOnAStandingReviewOnly() {
        let store = makeStore()
        // A question turn over a standing review (a held B): reject is not locked — the engine schedules it.
        store.handle(.state(snapshot(seq: 1, phase: .running, reviewEndTree: "b", files: [file("a.txt")])))
        #expect(store.rejectLockReason == nil)
        #expect(!store.isRejectLocked)
        // A fresh turn (no held B): still waits for the turn's end.
        store.handle(.state(snapshot(seq: 2, phase: .running, reviewEndTree: nil, files: [file("a.txt", .accepted)])))
        #expect(store.rejectLockReason == "Reject is available when this turn ends")
    }

    @Test func theRowsAreGrayRowsWithTheirWordsAndTheChangedAgainRowAsksWhileTheFileIsPending() {
        for code in ["reject_scheduled", "reject_applied", "reject_changed_again"] {
            #expect(SessionNotices.isNotice(code: code, fatal: false))
            #expect(SessionNotices.style(code: code, fatal: false) == .info)
            #expect(QueueStop.of(code: code, fatal: false) == .none)
        }
        let scheduled = detail("reject_scheduled", "src/Svc.java, new.txt")
        #expect(SessionNotices.errorText(message: "x", detail: scheduled)
                == "Rejected while Claude works: src/Svc.java, new.txt — reverted when the turn ends; Claude was told not to build on it")
        #expect(SessionNotices.secondaryLine(message: "x", detail: scheduled) == nil)
        #expect(SessionNotices.errorText(message: "x", detail: detail("reject_applied", "new.txt"))
                == "Reverted as you asked while Claude worked: new.txt")
        #expect(ReviewFlowText.askedPath(code: "reject_changed_again", detail: " src/Svc.java ") == "src/Svc.java")
        #expect(ReviewFlowText.askedPath(code: "reject_applied", detail: "src/Svc.java") == nil)
        #expect(ReviewFlowText.asksStill("a.txt", in: [file("a.txt")]))
        #expect(!ReviewFlowText.asksStill("a.txt", in: [file("a.txt", .accepted)]))
        #expect(!ReviewFlowText.asksStill("a.txt", in: [file("a.txt", scheduled: true)]))
        #expect(!ReviewFlowText.asksStill("a.txt", in: []))
    }

    @Test func aRejectRowNeverBecomesABannerOrStopsTheQueue() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, phase: .running, reviewEndTree: "b", files: [file("a.txt")])))
        store.handle(.error(message: "Rejected while Claude works: a.txt", fatal: false, scope: .session, detail: detail("reject_scheduled", "a.txt")))
        #expect(store.errorBanner == nil)
        #expect(store.queuePausedReason == nil)
    }
}
