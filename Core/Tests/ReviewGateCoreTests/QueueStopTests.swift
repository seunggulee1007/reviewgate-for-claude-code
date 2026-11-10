import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §50.1 on the Mac: an error stops the composer's queue only when it is about the message's own send,
/// its session, a login or the API; the API and the usage limit stop it for a while and it goes on by itself.
@Suite @MainActor struct QueueStopTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "QueueStopTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, phase: GatePhase) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let canSend = phase == .reviewing || phase == .idle
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private func sends(_ commands: [EngineCommand]) -> [String] {
        commands.compactMap { if case let .send(text, _, _, _) = $0 { return text }; return nil }
    }

    /// A running turn with "next" queued behind it.
    private func queued() -> (AppState, () -> [String]) {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.enqueue("next")
        return (app, { self.sends(sent) })
    }

    @Test func whatStopsTheQueue() {
        for code in ["send_failed", "lfs_missing", "session_crashed", "session_start_failed", "session_id_in_use", "auth_required"] {
            #expect(QueueStop.of(code: code, fatal: false) == .pause, "\(code)")
        }
        #expect(QueueStop.of(code: nil, fatal: true) == .pause)
        #expect(QueueStop.of(code: "command_failed", fatal: true) == .pause)
        #expect(QueueStop.of(code: "api_error", fatal: false) == .retry)
        #expect(QueueStop.of(code: "rate_limited", fatal: false) == .retry)
        #expect(QueueStop.of(code: "usage_limit", fatal: false) == .untilLimitResets)
        for code in ["command_failed", "refresh_failed", "commit_failed", "mcp_failed", "branch_failed", "workbench_failed",
                     "revert_failed", "collect_failed", "plan_followup_failed", "max_turns", "auto_mode_denied"] {
            #expect(QueueStop.of(code: code, fatal: false) == QueueStop.none, "\(code)")
        }
        #expect(QueueStop.of(code: nil, fatal: false) == QueueStop.none)
        #expect(QueueStop.retryDelay(after: 1) == 30)
        #expect(QueueStop.retryDelay(after: 2) == 120)
        #expect(QueueStop.retryDelay(after: 5) == 120)
    }

    /// A failing PR list, a refresh, a commit: their banner says it — the queued message still goes out.
    @Test func anUnrelatedErrorLeavesTheQueueGoing() {
        let (app, sent) = queued()
        app.handle(.error(message: "gh pr list failed", fatal: false, scope: .pr, detail: EngineErrorDetail(code: "command_failed")))
        app.handle(.error(message: "git status failed", fatal: false, scope: .git, detail: EngineErrorDetail(code: "refresh_failed")))
        app.handle(.error(message: "commit failed", fatal: false, scope: .git, detail: EngineErrorDetail(code: "commit_failed")))
        #expect(app.queuePausedReason == nil)
        #expect(app.errorBanner != nil)   // still said
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sent() == ["next"])
    }

    @Test func theMessagesOwnFailureStillStopsIt() {
        let (app, sent) = queued()
        app.handle(.error(message: "snapshot failed", fatal: false, scope: .session, detail: EngineErrorDetail(code: "send_failed")))
        #expect(app.queuePausedReason != nil)
        #expect(app.queueResumesAt == nil)   // waits for Resume
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sent().isEmpty)
    }

    /// The API failed after the CLI's own retries: the queue stops, goes on by itself after 30 s, then 2 min while it
    /// keeps failing; a turn that went through starts over at 30 s.
    @Test func anAPIErrorResumesByItselfAfterABackoff() {
        let (app, sent) = queued()
        app.enqueue("after")
        let t0 = Date()
        app.stopQueue(.retry, reason: "The Claude API returned an error.", detail: EngineErrorDetail(code: "api_error"), now: t0)
        #expect(app.queuePausedReason != nil)
        #expect(app.queueResumesAt == t0.addingTimeInterval(30))
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sent().isEmpty)
        app.stepQueueResume(now: t0.addingTimeInterval(29))
        #expect(sent().isEmpty)
        app.stepQueueResume(now: t0.addingTimeInterval(30))
        #expect(app.queuePausedReason == nil && app.queueResumesAt == nil)
        #expect(sent() == ["next"])
        // Its turn fails the same way: the next wait is 2 minutes.
        app.handle(.state(snapshot(seq: 3, phase: .running)))
        let t1 = t0.addingTimeInterval(60)
        app.stopQueue(.retry, reason: "rate limited", detail: EngineErrorDetail(code: "rate_limited"), now: t1)
        #expect(app.queueResumesAt == t1.addingTimeInterval(120))
        app.handle(.state(snapshot(seq: 4, phase: .reviewing)))
        app.resumeQueue()   // "지금 보내기"
        #expect(app.queueResumesAt == nil)
        #expect(sent() == ["next", "after"])
        // That turn went through: the next API failure waits 30 s again.
        app.handle(.state(snapshot(seq: 5, phase: .running)))
        app.handle(.state(snapshot(seq: 6, phase: .reviewing)))
        app.handle(.state(snapshot(seq: 7, phase: .running)))
        app.enqueue("third")
        let t2 = t0.addingTimeInterval(600)
        app.stopQueue(.retry, reason: "api", detail: EngineErrorDetail(code: "api_error"), now: t2)
        #expect(app.queueResumesAt == t2.addingTimeInterval(30))
    }

    @Test func theErrorEventItselfStopsTheQueueForAWhile() {
        let (app, sent) = queued()
        // The event takes its own "now": the due time lies 30 s after a moment between these two, however long that took.
        let before = Date()
        app.handle(.error(message: "The Claude API returned an error.", fatal: false, scope: .session, detail: EngineErrorDetail(code: "api_error")))
        let after = Date()
        #expect(app.queuePausedReason != nil)
        let due = try? #require(app.queueResumesAt)
        #expect(due.map { $0 >= before.addingTimeInterval(30) && $0 <= after.addingTimeInterval(30) } == true)
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(sent().isEmpty)
        app.clearQueue()
        #expect(app.queueResumesAt == nil)
    }

    /// The usage limit: the queue goes on a minute after the reset; without a known reset it waits for the user.
    @Test func theUsageLimitResumesAfterItsReset() {
        let (app, sent) = queued()
        let reset = Date().addingTimeInterval(3600)
        var d = EngineErrorDetail(code: "usage_limit")
        d.resetAt = reset.ISO8601Format()
        app.handle(.error(message: "Your Claude usage limit is reached.", fatal: false, scope: .session, detail: d))
        #expect(app.queuePausedReason != nil)
        let due = try? #require(app.queueResumesAt)
        #expect(due.map { abs($0.timeIntervalSince(reset) - LimitResume.delay) < 1 } == true)
        app.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        app.stepQueueResume(now: reset)
        #expect(sent().isEmpty)
        app.stepQueueResume(now: reset.addingTimeInterval(LimitResume.delay + 1))
        #expect(sent() == ["next"])

        let (other, otherSent) = queued()
        other.handle(.error(message: "limit", fatal: false, scope: .session, detail: EngineErrorDetail(code: "usage_limit")))
        #expect(other.queuePausedReason != nil && other.queueResumesAt == nil)
        other.handle(.state(snapshot(seq: 2, phase: .reviewing)))
        #expect(otherSent().isEmpty)
    }

    @Test func theQueueBarSaysWhenItGoesOn() {
        #expect(QueueStop.sendNowTitle == "Send it now")
        let date = Date()
        #expect(QueueStop.resumesText(date) == "Sends again at \(LongWorkText.resetTime(date))")
    }
}
