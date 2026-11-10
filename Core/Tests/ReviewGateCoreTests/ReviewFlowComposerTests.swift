import Foundation
import Testing
@testable import ReviewGateCore

/// r2-review-flow M30 (§3): a message queues for any closed gate of an open project, and ↩ with text always does something.
@Suite @MainActor struct ReviewFlowComposerTests {
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

    // MARK: M30

    @Test func aMessageQueuesForAnyClosedGateOfAnOpenProjectNeverFromAnotherChat() {
        #expect(ComposerSendRules.canQueue(projectOpen: true, canSend: false, viewing: false))
        #expect(!ComposerSendRules.canQueue(projectOpen: true, canSend: true, viewing: false))
        #expect(!ComposerSendRules.canQueue(projectOpen: false, canSend: false, viewing: false))
        #expect(!ComposerSendRules.canQueue(projectOpen: true, canSend: false, viewing: true))
    }

    @Test func returnWithTextAlwaysDoesSomethingOrSaysWhyNot() {
        func action(canSend: Bool = false, canQueue: Bool = false, canSteer: Bool = false, ended: Bool = false, canRestart: Bool = false, text: Bool = true) -> ComposerSendAction {
            ComposerSendRules.returnAction(hasText: text, canSend: canSend, canQueue: canQueue, canSteer: canSteer, sessionEnded: ended, canRestart: canRestart)
        }
        #expect(action(canSend: true) == .send)
        #expect(action(canQueue: true, canSteer: true) == .steer)
        #expect(action(canQueue: true) == .queue)
        // The session ended: the message waits in the queue and the session restarts.
        #expect(action(canQueue: true, ended: true, canRestart: true) == .restartAndSend)
        #expect(action(canQueue: true, ended: true, canRestart: false) == .queue)
        #expect(action() == .nothing)
        #expect(action(canSend: true, text: false) == .nothing)
        #expect(ComposerSendRules.collectFailedNotice("git: index.lock exists\nmore")
                == "Could not collect the last turn's changes (git: index.lock exists) — your next message collects them with its own")
    }
}
