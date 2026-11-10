import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow M29 (§31.5): the stale review is one banner line.
@Suite @MainActor struct ReviewFlowStaleTests {
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

    // MARK: M29

    @Test func theStaleBannerSaysWhyInOneLine() {
        let stale = StaleReview(reasons: [.old], savedAt: "2026-11-01T09:00:00.000Z", savedHead: nil, head: nil, externalFiles: 0)
        let text = StaleReviewBannerText.message(stale)
        #expect(text.hasPrefix("This review is stale — Saved "))
        #expect(text.hasSuffix(" · More than 12 hours have passed"))
    }
}
