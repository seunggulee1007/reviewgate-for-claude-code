import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow M28: "Accept all" without a sheet unless a file needs a look; the commit sheet accepts as it commits; push
/// after commit kept per project.
@Suite @MainActor struct ReviewFlowAcceptTests {
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

    // MARK: M28

    @Test func acceptAllAsksOnlyWhenAFileNeedsALook() {
        #expect(!AcceptAllRules.needsSheet(unviewed: 0, changedSinceViewed: 0, sensitive: 0))
        #expect(AcceptAllRules.needsSheet(unviewed: 1, changedSinceViewed: 0, sensitive: 0))
        #expect(AcceptAllRules.needsSheet(unviewed: 0, changedSinceViewed: 2, sensitive: 0))
        #expect(AcceptAllRules.needsSheet(unviewed: 0, changedSinceViewed: 0, sensitive: 1))
        #expect(AcceptAllRules.acceptedToast(3) == "Accepted 3 files")
    }

    @Test func theCommitSheetListsPendingFilesAfterTheAcceptedOnesAndAcceptsTheTickedOnes() {
        var ignored = file("ignored.json")
        ignored.ignored = true
        let files = [file("a.txt", .accepted), file("b.txt"), file("c.txt"), ignored, file("d.txt", .changesRequested)]
        #expect(CommitAcceptRules.listed(committable: ["a.txt"], files: files) == ["a.txt", "b.txt", "c.txt"])
        #expect(CommitAcceptRules.toAccept(ticked: ["a.txt", "c.txt", "ignored.json"], files: files) == ["c.txt"])
    }

    @Test func pushAfterCommitIsKeptPerProject() {
        let defaults = UserDefaults(suiteName: "ReviewFlowTests.push.\(UUID().uuidString)")!
        #expect(AppSettings.commitPush(root: "/work/acme", defaults: defaults) == AppSettings.commitPushByDefault(defaults: defaults))
        AppSettings.setCommitPush(true, root: "/work/acme", defaults: defaults)
        #expect(AppSettings.commitPush(root: "/work/acme", defaults: defaults))
        #expect(AppSettings.commitPush(root: "/work/other", defaults: defaults) == AppSettings.commitPushByDefault(defaults: defaults))
        AppSettings.setCommitPush(false, root: "/work/acme", defaults: defaults)
        #expect(!AppSettings.commitPush(root: "/work/acme", defaults: defaults))
    }
}
