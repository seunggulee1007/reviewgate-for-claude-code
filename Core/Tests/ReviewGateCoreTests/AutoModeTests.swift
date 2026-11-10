import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-auto: auto mode on the Mac (docs/PROTOCOL.md §39.5) — what the classifier blocked is a gray row, an auto mode
/// the CLI cannot run says why, a mode picked while Claude works applies from its next step (plan mode: at the turn's end).
@Suite @MainActor struct AutoModeTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "AutoModeTests.\(UUID().uuidString)")! }
    private func makeStore(_ d: UserDefaults? = nil) -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults()) }

    private func snapshot(seq: Int, phase: GatePhase = .idle, mode: PermissionMode = .default, path: String = "/repo", open: Bool = true) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: path, root: path, name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: open, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.permissionMode = mode
        s.gate = GateInfo(phase: phase, canSend: phase == .idle, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    private func rows(_ store: AppState) -> [(String, ErrorRowInfo)] {
        store.transcript.compactMap { if case let .error(_, message, _, info) = $0 { return (message, info) } else { return nil } }
    }

    // MARK: - Words

    @Test func wordsAndClassification() {
        var d = EngineErrorDetail(code: "auto_mode_denied")
        d.detail = "mvn -v — [Security Weaken]"
        d.toolName = "Bash"
        #expect(EngineMessages.error(message: "Auto mode blocked: mvn -v — [Security Weaken]", detail: d) == "Auto mode blocked: mvn -v — [Security Weaken]")
        #expect(SessionNotices.secondaryLine(message: "x", detail: d) == nil)
        #expect(EngineMessages.error(message: "x", detail: EngineErrorDetail(code: "auto_mode_denied")) == "Auto mode blocked a call")
        let u = EngineErrorDetail(code: "auto_mode_unavailable")
        #expect(EngineMessages.error(message: "x", detail: u) == "Auto mode is not available for this model (or is turned off), so Claude Code asks before commands")
        for code in ["auto_mode_denied", "auto_mode_unavailable"] {
            #expect(SessionNotices.isNotice(code: code, fatal: false))
            #expect(SessionNotices.style(code: code, fatal: false) == .info)
        }
        #expect(EngineMessages.refusal(code: "auto_mode_unavailable", error: "auto_mode_unavailable: Cannot set permission mode to auto")
                == "Auto mode is not available for this model. Pick another model or mode.")
        #expect(PermissionMode.auto.helpText == "Commands run on Claude Code's own judgment. File changes are still reviewed.")
    }

    @Test func deniedCallsAreGrayRowsOnly() {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, phase: .running, mode: .auto)))
        var d = EngineErrorDetail(code: "auto_mode_denied")
        d.detail = "mvn -v — [Security Weaken]"
        d.toolName = "Bash"
        store.handle(.error(message: "Auto mode blocked: mvn -v — [Security Weaken]", fatal: false, scope: .session, detail: d))
        store.handle(.error(message: "Auto mode blocked: mvn -v — [Security Weaken]", fatal: false, scope: .session, detail: d))
        let r = rows(store)
        #expect(r.map(\.0) == ["Auto mode blocked: mvn -v — [Security Weaken]"])
        #expect(r.first?.1.count == 2)   // repeats merge (×2)
        #expect(store.errorBanner == nil)
        #expect(store.lastError == nil)
        #expect(store.queuePausedReason == nil)
    }

    // MARK: - Picking a mode

    @Test func pickWhileIdleSwitchesNow() {
        let d = defaults()
        let store = makeStore(d)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1)))
        store.pickPermissionMode(.auto)
        #expect(sent == [.setPermissionMode(mode: .auto)])
        #expect(store.permissionMode == .auto)
        #expect(store.scheduledPermissionMode == nil)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .auto)
    }

    /// §39.5: auto picked while Claude works goes out at once — the CLI applies it from its next tool call, as Shift+Tab in
    /// the terminal; plan mode (into or out of it) waits for the turn's end, and so does anything while it is collected.
    @Test func pickWhileRunningSwitchesNowButPlanWaits() {
        let d = defaults()
        let store = makeStore(d)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, phase: .running)))
        #expect(store.canPickPermissionMode && !store.canSetPermissionMode)
        #expect(store.canSetPermissionMode(to: .auto) && !store.canSetPermissionMode(to: .plan))
        store.pickPermissionMode(.auto)
        #expect(sent == [.setPermissionMode(mode: .auto)])
        #expect(store.scheduledPermissionMode == nil)
        #expect(store.permissionMode == .auto)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .auto)
        #expect(AutoModeText.busyHelp(switchesNow: store.canSetPermissionMode(to: .auto))
                == "Claude is working — a new mode applies from its next step (plan mode: when this turn ends)")
        store.pickPermissionMode(.plan)
        #expect(sent == [.setPermissionMode(mode: .auto)])
        #expect(store.scheduledPermissionMode == .plan)
        store.handle(.state(snapshot(seq: 2, phase: .collecting, mode: .auto)))
        #expect(!store.canSetPermissionMode(to: .default))   // a collection takes no switch
        #expect(sent == [.setPermissionMode(mode: .auto)])   // still busy
        store.handle(.state(snapshot(seq: 3, mode: .auto)))
        #expect(sent == [.setPermissionMode(mode: .auto), .setPermissionMode(mode: .plan)])
        #expect(store.scheduledPermissionMode == nil)
        #expect(store.permissionMode == .plan)
        // A turn in plan mode: leaving it waits for the turn's end too.
        store.handle(.state(snapshot(seq: 4, phase: .running, mode: .plan)))
        #expect(!store.canSetPermissionMode(to: .auto))
        #expect(AutoModeText.busyHelp(switchesNow: store.canSetPermissionMode(to: .auto)) == AutoModeText.scheduledHelp)
        store.pickPermissionMode(.auto)
        #expect(store.scheduledPermissionMode == .auto)
        #expect(sent.count == 2)
    }

    /// An engine that cannot take the switch after all (`session_busy`: the turn's changes began to be collected) — the
    /// mode it runs shows again and the pick waits for the turn's end.
    @Test func aBusyRefusalSchedulesThePick() async {
        let d = defaults()
        let store = makeStore(d)
        var asked: [EngineCommand] = []
        store.requestSink = { command in
            asked.append(command)
            throw EngineClientError.refused("session_busy", code: "session_busy")
        }
        store.handle(.state(snapshot(seq: 1, phase: .running)))
        store.pickPermissionMode(.auto)
        #expect(store.permissionMode == .auto)   // shown at once
        for _ in 0..<50 where store.scheduledPermissionMode == nil { await Task.yield() }
        #expect(asked == [.setPermissionMode(mode: .auto)])
        #expect(store.scheduledPermissionMode == .auto)
        #expect(store.permissionMode == .default)
        #expect(store.permissionModeRefusal == nil)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .default)
        #expect(store.errorBanner == nil)
    }

    @Test func pickingTheCurrentModeOrLeavingTheProjectDropsTheWait() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, phase: .running)))
        store.pickPermissionMode(.plan)
        #expect(store.scheduledPermissionMode == .plan)
        store.pickPermissionMode(.default)   // the current mode: nothing waits any more
        #expect(store.scheduledPermissionMode == nil)
        store.pickPermissionMode(.plan)
        store.handle(.state(snapshot(seq: 2, path: "/other")))
        #expect(store.scheduledPermissionMode == nil)
        #expect(sent.isEmpty)
    }

    @Test func aRefusedSwitchGoesBackAndSaysWhy() async {
        let d = defaults()
        let store = makeStore(d)
        store.requestSink = { _ in
            throw EngineClientError.refused("auto_mode_unavailable: Cannot set permission mode to auto: auto mode unavailable for this model", code: "auto_mode_unavailable")
        }
        store.handle(.state(snapshot(seq: 1)))
        store.pickPermissionMode(.auto)
        #expect(store.permissionMode == .auto)   // shown at once
        for _ in 0..<50 where store.permissionModeRefusal == nil { await Task.yield() }
        #expect(store.permissionMode == .default)
        #expect(store.permissionModeRefusal == "Auto mode is not available for this model. Pick another model or mode.")
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .default)
        #expect(rows(store).map(\.0) == ["Auto mode is not available for this model. Pick another model or mode."])   // a gray row
        #expect(store.errorBanner == nil && store.lastError == nil)
        store.pickPermissionMode(.plan)   // the next pick clears the reason
        #expect(store.permissionModeRefusal == nil)
    }

    /// Settings › "시작 모드": the mode a project opened for the first time starts in stays what Settings says — a pick in a
    /// project is that project's (as in Electron's `settings.permissionMode`); unset, the last mode used anywhere (as before).
    @Test func theStartingModeIsNotMovedByAPickInAProject() {
        let d = defaults()
        AppSettings.setPermissionMode(.plan, root: "/a", defaults: d)
        #expect(AppSettings.startPermissionMode(defaults: d) == nil)
        #expect(AppSettings.permissionMode(root: "/new", defaults: d) == .plan)   // unset: the last mode used anywhere
        AppSettings.setStartPermissionMode(.auto, defaults: d)
        AppSettings.setPermissionMode(.default, root: "/b", defaults: d)
        #expect(AppSettings.startPermissionMode(defaults: d) == .auto)
        #expect(AppSettings.permissionMode(root: "/new", defaults: d) == .auto)
        #expect(AppSettings.permissionMode(defaults: d) == .auto)   // what `hello` carries
        #expect(AppSettings.permissionMode(root: "/a", defaults: d) == .plan)
        #expect(AppSettings.permissionMode(root: "/b", defaults: d) == .default)
    }

    /// §40.1 (reversed): 자동, the last mode used anywhere, seeds a project opened for the first time like every other mode —
    /// a new worktree of a repository worked in auto mode no longer starts in 기본 and asks for every command. Settings ›
    /// 시작 모드 still comes first; the engine puts the repository's own other worktrees before both (§11).
    @Test func autoUsedLastSeedsANewProjectLikeAnyOtherMode() {
        let d = defaults()
        AppSettings.setPermissionMode(.auto, root: "/work/acme-1100-2", defaults: d)
        #expect(AppSettings.permissionMode(root: "/work/acme-1100-2", defaults: d) == .auto)   // that project keeps it
        #expect(AppSettings.permissionMode(root: "/work/acme-1100-18", defaults: d) == .auto)   // a new worktree starts in it
        #expect(AppSettings.permissionMode(defaults: d) == .auto)   // what `hello` carries
        AppSettings.setPermissionMode(.acceptEdits, root: "/work/a", defaults: d)
        #expect(AppSettings.permissionMode(root: "/work/new", defaults: d) == .acceptEdits)   // other modes follow as before
        AppSettings.setStartPermissionMode(.default, defaults: d)   // chosen in Settings: it wins over the last mode
        #expect(AppSettings.permissionMode(root: "/work/other", defaults: d) == .default)
        #expect(AppSettings.permissionMode(root: "/work/acme-1100-2", defaults: d) == .auto)   // a project's own pick still wins
    }
}
