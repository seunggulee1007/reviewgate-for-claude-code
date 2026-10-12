import Foundation
import Testing
@testable import ReviewGateCore

// MARK: wave4 w4-safety

/// Safety while Claude works: the close / quit confirmation (daily-12), the reject shortcut's line (daily-11), the stop
/// reason of a turn's notification (daily-14), "Force restart" after a stop that did not stop (robustness-07) and the
/// draft kept per chat (polish-12).
@Suite @MainActor struct WorkSafetyTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "WorkSafetyTests.\(UUID().uuidString)")! }

    private func makeState(_ d: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults())
    }

    private func snapshot(seq: Int, phase: GatePhase, pending: Int = 0, plan: PendingPlan? = nil,
                          permission: PermissionRequest? = nil, chat: String? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: permission, canRestart: true)
        s.session.pendingPlan = plan
        if let chat { s.sessions = SessionsInfo(list: [], currentId: chat, openTabIds: [chat]) }
        let canSend = (phase == .reviewing || phase == .idle) && permission == nil
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: pending, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: pending > 0 ? "B\(seq)" : nil, lastReviewSummary: nil)
        s.changedFiles = (0..<pending).map {
            ChangedFile(path: "f\($0).txt", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: ["Edit"], state: .pending)
        }
        return s
    }

    // MARK: - Close / quit (daily-12)

    @Test func closeGuardAsksOnlyWhileClaudeWorksOrWaits() {
        #expect(CloseGuardReason.of(isRunning: false, waitsForUser: false) == nil)
        #expect(CloseGuardReason.of(isRunning: true, waitsForUser: false) == .working)
        #expect(CloseGuardReason.of(isRunning: true, waitsForUser: true) == .waiting)
        #expect(CloseGuardReason.of(isRunning: false, waitsForUser: true) == .waiting)

        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        #expect(app.closeGuardReason == nil)
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        #expect(app.closeGuardReason == .working)
        let question = PermissionRequest(requestId: "q1", toolName: "AskUserQuestion", input: .object([:]))
        app.handle(.state(snapshot(seq: 3, phase: .running, permission: question)))
        #expect(app.closeGuardReason == .waiting)
        // A plan proposed at the end of the turn still waits for the user.
        app.handle(.state(snapshot(seq: 4, phase: .reviewing, plan: PendingPlan(path: nil, plan: "# Plan"))))
        #expect(app.closeGuardReason == .waiting)
        app.handle(.state(snapshot(seq: 5, phase: .reviewing, pending: 2)))
        #expect(app.closeGuardReason == nil)   // a review waiting is not Claude working
    }

    @Test func dontAskAgainTurnsTheConfirmationOff() {
        let d = defaults()
        let app = makeState(d)
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(AppSettings.confirmCloseWhileWorking(defaults: d))
        #expect(app.closeConfirmationReason(defaults: d) == .working)
        AppSettings.setConfirmCloseWhileWorking(false, defaults: d)
        #expect(app.closeConfirmationReason(defaults: d) == nil)
        AppSettings.setConfirmCloseWhileWorking(true, defaults: d)
        #expect(app.closeConfirmationReason(defaults: d) == .working)
    }

    @Test func quitMessageCountsTheWindows() {
        #expect(CloseGuardText.quitMessage([.working]) == CloseGuardText.message(.working))
        #expect(CloseGuardText.quitMessage([.waiting]) == CloseGuardText.message(.waiting))
        #expect(CloseGuardText.quitMessage([.working, .waiting, .working]).contains("3"))
        #expect(CloseGuardText.message(.working) != CloseGuardText.message(.waiting))
    }

    // MARK: - Reject shortcut (daily-11)

    @Test func rejectConfirmationSaysWhatHappensToTheFile() {
        func file(_ status: ChangeStatus, _ path: String, old: String? = nil) -> ChangedFile {
            ChangedFile(path: path, oldPath: old, status: status, added: 1, deleted: 1, isBinary: false, tools: ["Edit"], state: .pending)
        }
        let added = RejectConfirm.message(for: file(.added, "src/New.java"))
        let modified = RejectConfirm.message(for: file(.modified, "src/Old.java"))
        let deleted = RejectConfirm.message(for: file(.deleted, "src/Gone.java"))
        let renamed = RejectConfirm.message(for: file(.renamed, "src/B.java", old: "src/A.java"))
        #expect(added.contains("New.java"))
        #expect(modified.contains("Old.java"))
        #expect(deleted.contains("Gone.java"))
        #expect(renamed.contains("B.java") && renamed.contains("A.java"))
        #expect(Set([added, modified, deleted]).count == 3)
        #expect(!added.contains("src/"))   // one short line: the file name, not the path
    }

    // MARK: - Stop reason (daily-14)

    @Test func stopReasonComesFromTheErrorCodes() {
        let utc = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_700_000_000)   // 2023-11-14 22:13 UTC
        let limit = TurnStopReason.from(code: "usage_limit", message: "Your Claude usage limit is reached.",
                                        detail: EngineErrorDetail(code: "usage_limit", resetAt: "2023-11-14T23:00:00Z"),
                                        fatal: false, timeZone: utc, locale: Locale(identifier: "en_US"), now: now)
        #expect(limit?.kind == .usageLimit)
        #expect(limit?.text.contains("11:00") == true)
        #expect(TurnStopReason.from(code: "usage_limit", message: "", detail: EngineErrorDetail(code: "usage_limit"), fatal: false)?.kind == .usageLimit)
        #expect(TurnStopReason.from(code: "auth_required", message: "", detail: EngineErrorDetail(code: "auth_required"), fatal: false)?.kind == .loginRequired)
        #expect(TurnStopReason.from(code: "rate_limited", message: "", detail: EngineErrorDetail(code: "rate_limited"), fatal: false)?.kind == .rateLimited)
        let api = TurnStopReason.from(code: "api_error", message: "boom", detail: EngineErrorDetail(code: "api_error", status: 529), fatal: false)
        #expect(api?.kind == .apiError)
        #expect(api?.text.contains("529") == true)
        #expect(TurnStopReason.from(code: "session_crashed", message: "", detail: EngineErrorDetail(code: "session_crashed"), fatal: true)?.alreadyNotified == true)
        for other in ["collect_failed", "side_failed", "resume_failed", "api_retrying", nil] as [String?] {
            #expect(TurnStopReason.from(code: other, message: "x", detail: EngineErrorDetail(code: other), fatal: false) == nil)
        }
        // The stronger reason wins, whatever the order.
        let login = TurnStopReason(kind: .loginRequired, text: "login")
        let error = TurnStopReason(kind: .apiError, text: "error")
        #expect(TurnStopReason.merge(error, login) == login)
        #expect(TurnStopReason.merge(login, error) == login)
        #expect(TurnStopReason.merge(nil, error) == error)
        #expect(TurnStopReason.defersNotification(code: "usage_limit", fatal: false))
        // §38.2's tool-call limit is one of the reasons (one list): below a crash, above the API's own limits.
        let maxTurns = TurnStopReason.from(code: "max_turns", message: "", detail: EngineErrorDetail(code: "max_turns"), fatal: false)
        #expect(maxTurns?.kind == .maxTurns)
        #expect(TurnStopReason.defersNotification(code: "max_turns", fatal: false))
        #expect(TurnStopReason.merge(maxTurns, TurnStopReason(kind: .apiError, text: "error"))?.kind == .maxTurns)
        #expect(TurnStopReason.merge(maxTurns, login)?.kind == .loginRequired)
        #expect(!TurnStopReason.defersNotification(code: "session_crashed", fatal: true))
        #expect(!TurnStopReason.defersNotification(code: "collect_failed", fatal: false))
    }

    @Test func aTurnStoppedByTheLimitSaysSoInItsNotification() {
        let app = makeState()
        var events: [AttentionEvent] = []
        app.onAttention = { events.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.handle(.error(message: "Your Claude usage limit is reached.", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "usage_limit")))
        app.handle(.error(message: "Claude Code is not logged in", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "auth_required")))
        #expect(events.isEmpty)   // no separate "needs your action": the turn's end says it
        app.handle(.state(snapshot(seq: 2, phase: .reviewing, pending: 1)))
        #expect(events.count == 1)
        #expect(events.first?.kind == .turnFinished)
        let login = TurnStopReason.from(code: "auth_required", message: "", detail: EngineErrorDetail(code: "auth_required"), fatal: false)
        #expect(events.first?.title == login?.text)
        #expect(events.first?.body == AttentionEvent.turnFinished(pending: 1, key: "k").body)
        // The next turn finishes plainly.
        app.handle(.state(snapshot(seq: 3, phase: .running)))
        app.handle(.state(snapshot(seq: 4, phase: .idle)))
        #expect(events.count == 2)
        #expect(events.last?.title == AttentionEvent.turnFinished(pending: 0, key: "k").title)
    }

    @Test func aCrashIsPostedOnceNotTwice() {
        let app = makeState()
        var events: [AttentionEvent] = []
        app.onAttention = { events.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.handle(.error(message: "The Claude session ended", fatal: true, scope: .session, detail: EngineErrorDetail(code: "session_crashed")))
        #expect(events.map(\.kind) == [.actionNeeded])
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        #expect(events.map(\.kind) == [.actionNeeded])
    }

    @Test func anErrorOutsideATurnIsNotAStopReason() {
        let app = makeState()
        var events: [AttentionEvent] = []
        app.onAttention = { events.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .idle)))
        app.handle(.error(message: "not logged in", fatal: false, scope: .session, detail: EngineErrorDetail(code: "auth_required")))
        #expect(events.map(\.kind) == [.actionNeeded])   // as before: the login banner's action, notified at once
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        app.handle(.state(snapshot(seq: 3, phase: .idle)))
        #expect(events.last?.title == AttentionEvent.turnFinished(pending: 0, key: "k").title)
    }

    // MARK: - Force restart (robustness-07)

    @Test func forceRestartIsOfferedWhenTheStopDoesNotStop() async throws {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.interrupt()
        app.armInterruptWatch(delay: .milliseconds(30))   // the test's short delay instead of 10 s
        #expect(!app.showsForceRestart)
        try await waitUntil { app.showsForceRestart }
        app.forceRestartStuckTurn()
        #expect(sent.contains(.interrupt))
        #expect(sent.contains(.restartSession))
        #expect(!app.showsForceRestart)
    }

    @Test func forceRestartGoesAwayWhenTheTurnEnds() async throws {
        let app = makeState()
        app.commandSink = { _ in }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        app.interrupt()
        app.armInterruptWatch(delay: .milliseconds(30))
        try await waitUntil { app.interruptStuck }
        app.handle(.state(snapshot(seq: 2, phase: .idle)))
        #expect(!app.showsForceRestart)
        try await waitUntil { !app.interruptStuck }
        // A stop that works never offers it.
        app.handle(.state(snapshot(seq: 3, phase: .running)))
        app.interrupt()
        app.armInterruptWatch(delay: .milliseconds(30))
        app.handle(.state(snapshot(seq: 4, phase: .idle)))
        try await Task.sleep(for: .milliseconds(120))
        #expect(!app.interruptStuck)
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("condition not met in time")
    }

    // MARK: - Draft per chat (polish-12)

    @Test func draftsAreKeptPerChat() {
        let app = makeState()
        app.handle(.state(snapshot(seq: 1, phase: .idle, chat: "c1")))
        #expect(app.draftChatId == "c1")
        app.stashDraft(ChatDraft(text: "for chat one", mentions: ["a.txt"]), for: "c1")
        #expect(app.takeDraft(for: "c2") == ChatDraft())
        #expect(app.takeDraft(for: "c1") == ChatDraft(text: "for chat one", mentions: ["a.txt"]))
        #expect(app.takeDraft(for: "c1") == ChatDraft())   // taken: the composer owns it again
        app.stashDraft(ChatDraft(), for: "c1")
        #expect(app.takeDraft(for: "c1").isEmpty)
        app.stashDraft(ChatDraft(text: "x"), for: nil)   // engines without chats keep the one window draft
        #expect(app.takeDraft(for: nil).isEmpty)
        let old = makeState()
        old.handle(.state(snapshot(seq: 1, phase: .idle)))
        #expect(old.draftChatId == nil)
    }
}
