import Foundation
import Testing
@testable import ReviewGateCore

/// polish P4-composer-07 (docs/PROTOCOL.md §55.7): the queue's text survives the window's close, a project switch and quit,
/// and comes back paused when the project opens again.
@Suite @MainActor struct QueueKeepTests {
    private func snapshot(seq: Int, root: String, phase: GatePhase = .running) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: root, root: root, name: URL(fileURLWithPath: root).lastPathComponent, branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let canSend = phase == .reviewing || phase == .idle
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    /// What the window does: `queueKeepChanged` whenever `queueKeep` changed.
    private func watch(_ app: AppState, _ change: () -> Void) {
        let old = app.queueKeep
        change()
        let new = app.queueKeep
        if new != old { app.queueKeepChanged(from: old, to: new) }
    }

    @Test func theQueueIsKeptAndComesBackPausedInTheNextWindow() {
        let defaults = UserDefaults(suiteName: "QueueKeepTests.\(UUID().uuidString)")!
        let first = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        first.commandSink = { _ in }
        watch(first) { first.handle(.state(snapshot(seq: 1, root: "/work/acme-api"))) }
        watch(first) { first.enqueue("run the tests", mentions: ["src/App.swift"]) }
        watch(first) { first.enqueue("then fix them", images: [ComposerImage(mediaType: .png, data: Data([1]), name: "shot.png")]) }
        #expect(AppSettings.keptQueue(root: "/work/acme-api", defaults: defaults).map(\.text) == ["run the tests", "then fix them"])

        // The window closed (or the app quit); the project opens again in another one.
        let next = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        next.commandSink = { _ in }
        watch(next) { next.handle(.state(snapshot(seq: 1, root: "/work/acme-api", phase: .idle))) }
        #expect(next.queuedMessages.map(\.text) == ["run the tests", "then fix them"])
        #expect(next.queuedMessages.first?.mentions == ["src/App.swift"])
        #expect(next.queuedMessages.allSatisfy { $0.images.isEmpty })   // images are not kept
        #expect(next.queuePausedReason == QuitText.keptQueuePaused)      // nothing goes out by itself

        // Cleared: forgotten.
        watch(next) { next.clearQueue() }
        #expect(AppSettings.keptQueue(root: "/work/acme-api", defaults: defaults).isEmpty)
    }

    @Test func switchingProjectsKeepsEachProjectsQueue() {
        let defaults = UserDefaults(suiteName: "QueueKeepTests.\(UUID().uuidString)")!
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        app.commandSink = { _ in }
        watch(app) { app.handle(.state(snapshot(seq: 1, root: "/work/acme-api"))) }
        watch(app) { app.enqueue("api work") }
        // Another project in this window: its queue starts empty; the first one's stays kept.
        watch(app) { app.handle(.state(snapshot(seq: 2, root: "/work/acme-web"))) }
        #expect(app.queuedMessages.isEmpty)
        #expect(AppSettings.keptQueue(root: "/work/acme-api", defaults: defaults).map(\.text) == ["api work"])
        // Back: it returns, paused.
        watch(app) { app.handle(.state(snapshot(seq: 3, root: "/work/acme-api"))) }
        #expect(app.queuedMessages.map(\.text) == ["api work"])
        #expect(app.queuePausedReason != nil)
    }
}
