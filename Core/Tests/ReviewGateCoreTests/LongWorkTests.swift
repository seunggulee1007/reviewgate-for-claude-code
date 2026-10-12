import Foundation
import Testing
@testable import ReviewGateCore

/// wave4 w4-longwork: long work on the Mac (docs/PROTOCOL.md §38.2) — the tool-call limit's row and [이어서 계속], hook /
/// CLI notices as chat rows, the usage windows and "풀리면 이어서 하기".
@Suite @MainActor struct LongWorkTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "LongWorkTests.\(UUID().uuidString)")! }
    private func makeStore(_ d: UserDefaults? = nil) -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults()) }

    private func snapshot(seq: Int, phase: GatePhase = .idle, canSend: Bool = true, rateLimits: [RateLimitWindow] = []) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        s.hud.rateLimits = rateLimits
        return s
    }

    private func sentTexts(_ sent: [EngineCommand]) -> [String] {
        sent.compactMap { if case let .send(text, _, _, _) = $0 { return text } else { return nil } }
    }

    private func rows(_ store: AppState) -> [(String, ErrorRowInfo)] {
        store.transcript.compactMap { if case let .error(_, message, _, info) = $0 { return (message, info) } else { return nil } }
    }

    // MARK: - Wire

    @Test func wireReadsRateLimitsAndNoticeFacts() throws {
        let hud = #"{"contextTokens":0,"sessionCostUSD":0,"turnCount":0,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0,"rateLimits":[{"kind":"five_hour","status":"allowed_warning","percent":82,"resetsAt":"2026-10-23T15:00:00.000Z","at":"x"},{"status":"rejected"},{"kind":"seven_day","status":"allowed","percent":41.4}]}"#
        let wire = try JSONDecoder().decode(HUDWire.self, from: Data(hud.utf8))
        #expect(wire.rateLimits == [RateLimitWindow(kind: "five_hour", status: "allowed_warning", percent: 82, resetsAt: "2026-10-23T15:00:00.000Z"),
                                    RateLimitWindow(kind: "seven_day", status: "allowed", percent: 41)])
        let old = #"{"contextTokens":0,"sessionCostUSD":0,"turnCount":0,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0}"#
        #expect(try JSONDecoder().decode(HUDWire.self, from: Data(old.utf8)).rateLimits.isEmpty)

        let event = #"{"type":"error","message":"m","fatal":false,"scope":"session","code":"max_turns","maxTurns":200}"#
        guard case let .error(_, _, _, detail) = try JSONDecoder().decode(EngineEvent.self, from: Data(event.utf8)) else {
            Issue.record("not an error event"); return
        }
        #expect(detail.maxTurns == 200)
        let hook = #"{"type":"error","message":"m","fatal":false,"scope":"session","code":"hook_failed","hookName":"PostToolUse:Bash","exitCode":2,"detail":"boom"}"#
        guard case let .error(_, _, _, hd) = try JSONDecoder().decode(EngineEvent.self, from: Data(hook.utf8)) else {
            Issue.record("not an error event"); return
        }
        #expect(hd.hookName == "PostToolUse:Bash")
        #expect(hd.exitCode == 2)
    }

    // MARK: - Words and classification

    // MARK: wave4b w4b-check4 — §40.1: a hook that blocked on purpose names itself and its reason in one row.
    @Test func hookBlockedNamesTheHookAndWhy() {
        var b = EngineErrorDetail(code: "hook_blocked")
        b.hookName = "PreToolUse:Bash"
        b.detail = "no rm -rf in this repo"
        b.exitCode = 2
        #expect(EngineMessages.error(message: "x", detail: b) == "Blocked by a hook: PreToolUse:Bash — no rm -rf in this repo")
        #expect(SessionNotices.secondaryLine(message: "x", detail: b) == nil)   // no second copy
        b.detail = nil
        #expect(EngineMessages.error(message: "x", detail: b) == "Blocked by a hook: PreToolUse:Bash")
        var old = EngineErrorDetail(code: "hook_blocked")   // an engine before §40.1 (a Stop hook's informational line)
        old.detail = "blocked: commit first"
        #expect(EngineMessages.error(message: "x", detail: old) == "A hook stopped this turn")
        #expect(SessionNotices.secondaryLine(message: "x", detail: old) == "blocked: commit first")
    }

    @Test func noticeWordsAndStyles() {
        var d = EngineErrorDetail(code: "max_turns")
        d.maxTurns = 200
        #expect(EngineMessages.error(message: "x", detail: d) == "Claude stopped at the tool-call limit (200 calls)")
        #expect(EngineMessages.error(message: "x", detail: EngineErrorDetail(code: "max_turns")) == "Claude stopped at the tool-call limit")
        var h = EngineErrorDetail(code: "hook_failed")
        h.hookName = "UserPromptSubmit"
        #expect(EngineMessages.error(message: "x", detail: h) == "A hook failed: UserPromptSubmit")
        #expect(EngineMessages.error(message: "x", detail: EngineErrorDetail(code: "hook_blocked")) == "A hook stopped this turn")
        var w = EngineErrorDetail(code: "cli_warning")
        w.detail = "Auto-compact is off"
        #expect(EngineMessages.error(message: "Auto-compact is off", detail: w) == "Auto-compact is off")
        #expect(SessionNotices.secondaryLine(message: "Auto-compact is off", detail: w) == nil)   // no second copy
        for code in ["max_turns", "hook_failed", "hook_blocked", "cli_warning", "cli_notice"] {
            #expect(SessionNotices.isNotice(code: code, fatal: false))
        }
        #expect(SessionNotices.style(code: "cli_notice", fatal: false) == .info)
        #expect(SessionNotices.style(code: "cli_warning", fatal: false) == .warning)
        #expect(SessionNotices.style(code: "max_turns", fatal: false) == .warning)
        #expect(SessionNotices.bannerActions(code: "max_turns", repeats: 1) == [.continueWork])
        #expect(SessionNotices.bannerActions(code: "usage_limit", repeats: 1) == [.resumeAfterLimit])
        #expect(EngineMessages.actions(for: "usage_limit").isEmpty)   // no new "needs you" notification
    }

    // MARK: - Tool-call limit

    @Test func maxTurnsRowBannerContinueAndNotification() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        var attention: [AttentionEvent] = []
        store.commandSink = { sent.append($0) }
        store.onAttention = { attention.append($0) }
        store.handle(.state(snapshot(seq: 1, phase: .running, canSend: false)))
        var d = EngineErrorDetail(code: "max_turns")
        d.maxTurns = 150
        store.handle(.error(message: "Claude stopped at the tool-call limit (150 calls) …", fatal: false, scope: .session, detail: d))
        #expect(rows(store).map(\.0) == ["Claude stopped at the tool-call limit (150 calls)"])
        #expect(store.errorBanner?.actions == [.continueWork])
        #expect(store.lastError == nil)
        #expect(store.queuePausedReason == nil)
        // One notification, the turn's "finished" one, says why it stopped (TurnStopReason, the one list of stop reasons).
        #expect(attention.isEmpty)
        store.handle(.state(snapshot(seq: 2)))
        #expect(attention.map(\.kind) == [.turnFinished])
        #expect(attention.map(\.title) == ["Stopped at the tool-call limit"])
        #expect(attention.first?.body == AttentionEvent.turnFinished(pending: 0, key: "k").body)
        store.continueWork()
        #expect(sentTexts(sent) == ["Please continue."])
    }

    @Test func continueQueuesWhileClaudeIsBusy() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, phase: .running, canSend: false)))
        store.continueWork()
        #expect(sentTexts(sent).isEmpty)
        #expect(store.queuedMessages.map(\.text) == ["Please continue."])
    }

    @Test func hookAndCliNoticesAreRowsOnly() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1)))
        var w = EngineErrorDetail(code: "cli_warning")
        w.detail = "Context is low"
        store.handle(.error(message: "Context is low", fatal: false, scope: .session, detail: w))
        store.handle(.error(message: "Context is low", fatal: false, scope: .session, detail: w))
        var h = EngineErrorDetail(code: "hook_blocked")
        h.detail = "UserPromptSubmit operation blocked by hook: commit first"
        store.handle(.error(message: "A hook stopped this turn: …", fatal: false, scope: .session, detail: h))
        let r = rows(store)
        #expect(r.map(\.0) == ["Context is low", "A hook stopped this turn"])
        #expect(r.first?.1.count == 2)   // the same warning twice: one row ×2
        #expect(r.last?.1.secondary == "UserPromptSubmit operation blocked by hook: commit first")
        #expect(store.errorBanner == nil)
        #expect(store.lastError == nil)
    }

    // MARK: - Usage limit

    @Test func limitResumeSteps() {
        let reset = Date(timeIntervalSince1970: 1_000_000)
        var s = LongWorkState()
        s.limitResetAt = reset
        #expect(LimitResume.step(s, running: false, idle: true, now: reset.addingTimeInterval(120)) == .wait)   // not armed
        s.resumeArmed = true
        #expect(LimitResume.step(s, running: false, idle: true, now: reset.addingTimeInterval(30)) == .wait)    // reset + 1 min
        #expect(LimitResume.step(s, running: false, idle: false, now: reset.addingTimeInterval(61)) == .wait)   // not idle
        #expect(LimitResume.step(s, running: false, idle: true, now: reset.addingTimeInterval(61)) == .fire)
        #expect(LimitResume.step(s, running: true, idle: false, now: reset) == .wait)     // the limit's own turn still ends
        s.idleSinceArmed = true
        #expect(LimitResume.step(s, running: true, idle: false, now: reset) == .cancel)   // another turn started
        s.limitResetAt = nil
        s.idleSinceArmed = false
        #expect(LimitResume.step(s, running: false, idle: true, now: reset) == .cancel)
        let now = Date(timeIntervalSince1970: 2_000_000)
        let windows = [RateLimitWindow(kind: "five_hour", status: "rejected", resetsAt: "1970-01-24T03:33:30Z"),
                       RateLimitWindow(kind: "seven_day", status: "allowed", percent: 41)]
        #expect(LimitResume.activeReset(rateLimits: windows, lastResetAt: nil, now: now) == Date(timeIntervalSince1970: 2_000_010))
        #expect(LimitResume.activeReset(rateLimits: windows, lastResetAt: nil, now: Date(timeIntervalSince1970: 2_000_011)) == nil)
        #expect(UsageMeter.fiveHour(windows) == nil)
        #expect(UsageMeter.weekly(windows) == 41)
        #expect(UsageMeter.isHigh(80) && !UsageMeter.isHigh(79) && !UsageMeter.isHigh(nil))
        #expect(LongWorkText.limitChip(resetTime: "15:00", armed: false) == "Usage limit — resets at 15:00")
    }

    @Test func armedResumeSendsContinueOnceAfterTheReset() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1)))
        let reset = Date().addingTimeInterval(3600)
        var d = EngineErrorDetail(code: "usage_limit")
        d.resetAt = reset.ISO8601Format()
        store.handle(.error(message: "Your Claude usage limit is reached.", fatal: false, scope: .session, detail: d))
        #expect(store.errorBanner?.actions == [.resumeAfterLimit])
        #expect(store.isUsageLimited)
        store.toggleLimitResume()
        #expect(store.longWork.resumeArmed)
        store.stepLimitResume(now: reset.addingTimeInterval(30))
        #expect(sentTexts(sent).isEmpty)
        store.stepLimitResume(now: reset.addingTimeInterval(61))
        #expect(sentTexts(sent) == ["Please continue."])
        #expect(!store.longWork.resumeArmed)
        store.stepLimitResume(now: reset.addingTimeInterval(120))
        #expect(sentTexts(sent).count == 1)   // once
    }

    /// MARK: wave4b w4b-check4 — §40.1: "풀리면 이어서 하기" belongs to the chat it was turned on in: another chat (a switch, a
    /// chat moved to another worktree, another project in the window) disarms it — "계속해" never goes to a chat that did not stop.
    @Test func armedResumeNeverGoesToAnotherChat() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        var first = snapshot(seq: 1)
        first.sessions = SessionsInfo(list: [], currentId: "c1", openTabIds: ["c1", "c2"])
        store.handle(.state(first))
        let reset = Date().addingTimeInterval(3600)
        var d = EngineErrorDetail(code: "usage_limit")
        d.resetAt = reset.ISO8601Format()
        store.handle(.error(message: "limit", fatal: false, scope: .session, detail: d))
        store.armLimitResume()
        #expect(store.longWork.resumeArmed)
        var same = snapshot(seq: 2)
        same.sessions = SessionsInfo(list: [], currentId: "c1", openTabIds: ["c1", "c2"])
        store.handle(.state(same))
        #expect(store.longWork.resumeArmed)   // the same chat: still armed
        var other = snapshot(seq: 3)
        other.sessions = SessionsInfo(list: [], currentId: "c2", openTabIds: ["c1", "c2"])
        store.handle(.state(other))
        #expect(!store.longWork.resumeArmed)
        store.stepLimitResume(now: reset.addingTimeInterval(120))
        #expect(sentTexts(sent).isEmpty)
        #expect(LimitResume.leftChat(armed: nil, current: "c2") == false)   // armed without a chat id (an older engine): as before
        #expect(LimitResume.leftChat(armed: "c1", current: nil))
    }

    @Test func anotherTurnOrALimitWithoutResetDisarms() {
        let store = makeStore()
        store.commandSink = { _ in }
        store.handle(.state(snapshot(seq: 1)))
        var d = EngineErrorDetail(code: "usage_limit")
        d.resetAt = Date().addingTimeInterval(3600).ISO8601Format()
        store.handle(.error(message: "limit", fatal: false, scope: .session, detail: d))
        store.armLimitResume()
        #expect(store.longWork.resumeArmed)
        store.handle(.state(snapshot(seq: 2, phase: .running, canSend: false)))   // the user sent something
        #expect(!store.longWork.resumeArmed)
        store.handle(.state(snapshot(seq: 3)))
        store.armLimitResume()
        #expect(store.longWork.resumeArmed)
        store.handle(.error(message: "limit", fatal: false, scope: .session, detail: EngineErrorDetail(code: "usage_limit")))
        #expect(!store.longWork.resumeArmed)
    }

    // MARK: - Settings

    @Test func maxTurnsSetting() {
        let d = defaults()
        #expect(AppSettings.maxTurns(defaults: d) == 200)
        #expect(AppSettings.engineSettings(defaults: d).maxTurns == 200)
        AppSettings.setMaxTurns(5000, defaults: d)
        #expect(AppSettings.maxTurns(defaults: d) == 1000)
        AppSettings.setMaxTurns(300, defaults: d)
        let store = makeStore(d)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.pushMaxTurns()
        guard case let .setSettings(s)? = sent.last else { Issue.record("no set_settings"); return }
        #expect(s.maxTurns == 300)
        #expect(s.budget == nil)
    }
}
