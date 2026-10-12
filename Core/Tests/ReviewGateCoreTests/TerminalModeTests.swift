import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave6 w6-terminal — docs/PROTOCOL.md §44.1 on the Mac: shift+tab cycles the permission mode like the terminal, the
/// mode line under the composer says which one runs (plan mode Claude entered by itself too), and approving a plan made in
/// an auto chat goes back to auto.
@Suite @MainActor struct TerminalModeTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "TerminalModeTests.\(UUID().uuidString)")! }
    private func makeStore(_ d: UserDefaults? = nil) -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? defaults()) }

    private func snapshot(seq: Int, phase: GatePhase = .idle, mode: PermissionMode = .default, prePlanMode: PermissionMode? = nil,
                          selectedModel: String? = nil, path: String = "/repo") -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: path, root: path, name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.session.permissionMode = mode
        s.session.prePlanMode = prePlanMode
        s.session.selectedModel = selectedModel
        s.gate = GateInfo(phase: phase, canSend: phase == .idle, canRequestChanges: false, blockedReason: nil, collectError: nil, pendingCount: 0,
                          changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    @Test func theCycleIsTheTerminals() {
        #expect(PermissionModeCycle.next(after: .default, autoAvailable: true) == .acceptEdits)
        #expect(PermissionModeCycle.next(after: .acceptEdits, autoAvailable: true) == .plan)
        #expect(PermissionModeCycle.next(after: .plan, autoAvailable: true) == .auto)
        #expect(PermissionModeCycle.next(after: .auto, autoAvailable: true) == .default)
        #expect(PermissionModeCycle.next(after: .plan, autoAvailable: false) == .default)
        #expect(PermissionModeCycle.next(after: .auto, autoAvailable: false) == .default)
    }

    @Test func shiftTabSwitchesNowOrWhenTheTurnEnds() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1)))
        for _ in 0..<4 { store.cyclePermissionMode() }
        #expect(sent == [.setPermissionMode(mode: .acceptEdits), .setPermissionMode(mode: .plan), .setPermissionMode(mode: .auto),
                         .setPermissionMode(mode: .default)])
        // While Claude works the pick waits for the turn's end, and the next ⇧⇥ goes on from it.
        sent = []
        store.handle(.state(snapshot(seq: 2, phase: .running)))
        store.cyclePermissionMode()
        store.cyclePermissionMode()
        #expect(sent.isEmpty)
        #expect(store.scheduledPermissionMode == .plan)
        #expect(store.composerModeLine.text == "Default mode · From the next turn: Plan (shift+tab to switch)")
    }

    @Test func autoIsSkippedWhereTheCLICannotRunIt() {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        store.handle(.state(snapshot(seq: 1, mode: .plan)))
        store.handle(.error(message: "Auto mode is not available here", fatal: false, scope: .session, detail: EngineErrorDetail(code: "auto_mode_unavailable")))
        #expect(store.autoModeUnavailable)
        store.cyclePermissionMode()
        #expect(sent == [.setPermissionMode(mode: .default)])
        // Another model may run it: auto is offered again.
        store.handle(.state(snapshot(seq: 2, selectedModel: "opus")))
        #expect(!store.autoModeUnavailable)
    }

    @Test func theModeLineSaysWhichModeRuns() {
        #expect(ComposerModeLine.make(mode: .auto, scheduled: nil, approvesIntoAuto: false) == ComposerModeLine(text: "⏵⏵ Auto mode (shift+tab to switch)", tone: .auto))
        #expect(ComposerModeLine.make(mode: .acceptEdits, scheduled: nil, approvesIntoAuto: false).text == "⏵⏵ Accept edits mode (shift+tab to switch)")
        #expect(ComposerModeLine.make(mode: .plan, scheduled: nil, approvesIntoAuto: false) == ComposerModeLine(text: "⏸ Plan mode (shift+tab to switch)", tone: .plan))
        #expect(ComposerModeLine.make(mode: .plan, scheduled: nil, approvesIntoAuto: true).text
                == "⏸ Plan mode — approving goes back to auto mode (shift+tab to switch)")
        #expect(ComposerModeLine.make(mode: .default, scheduled: nil, approvesIntoAuto: false) == ComposerModeLine(text: "Default mode (shift+tab to switch)", tone: .plain))
    }

    /// Plan mode Claude entered in an auto chat: the line and the plan card follow it at once, approving goes back to auto,
    /// and the project's stored mode (also the last mode used anywhere, which seeds new projects) never becomes plan.
    @Test func claudesOwnPlanModeInAnAutoChat() {
        let d = defaults()
        let store = makeStore(d)
        store.commandSink = { _ in }
        store.handle(.state(snapshot(seq: 1, mode: .auto)))
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .auto)
        #expect(store.planApproveMode == .default)
        store.handle(.state(snapshot(seq: 2, phase: .running, mode: .plan, prePlanMode: .auto)))
        #expect(store.composerModeLine.tone == .plan)
        #expect(store.composerModeLine.text.contains("approving goes back to auto mode"))
        #expect(store.planApproveMode == .auto)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .auto)
        #expect(AppSettings.permissionMode(root: "/another", defaults: d) != .plan)
        // An auto mode the engine said cannot run here: approving goes to default (the switch would be refused).
        store.handle(.error(message: "Auto mode is not available here", fatal: false, scope: .session, detail: EngineErrorDetail(code: "auto_mode_unavailable")))
        #expect(store.planApproveMode == .default)
        #expect(!store.composerModeLine.text.contains("approving goes back to auto mode"))
        store.handle(.state(snapshot(seq: 3, mode: .plan, prePlanMode: .default)))
        #expect(store.planApproveMode == .default)
    }

    /// Architect review: any refusal saying auto mode cannot run here — a plan answer too, not only a mode switch — is
    /// remembered (the plan is then approved into default), and the line says the default mode runs instead of "자동 모드".
    @Test func anyAutoModeRefusalIsRemembered() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, mode: .plan, prePlanMode: .auto)))
        #expect(store.planApproveMode == .auto)
        store.requestSink = { _ in throw EngineClientError.refused("auto_mode_unavailable: Cannot set permission mode to auto", code: "auto_mode_unavailable") }
        await #expect(throws: EngineClientError.self) { try await store.request(.planResponse(approve: true, mode: .auto, message: nil)) }
        #expect(store.autoModeUnavailable)
        #expect(store.planApproveMode == .default)
        store.handle(.state(snapshot(seq: 2, mode: .auto)))
        #expect(store.composerModeLine == ComposerModeLine(text: "Auto mode is not available here — running in default mode (shift+tab to switch)", tone: .plain))
        #expect(ComposerModeLine.make(mode: .auto, scheduled: nil, approvesIntoAuto: false, autoUnavailable: false).tone == .auto)
    }

    @Test func prePlanModeOnTheWire() throws {
        func decode(_ json: String) throws -> PermissionMode? {
            try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8)).prePlanMode
        }
        #expect(try decode(#"{"open":true,"starting":false,"permissionMode":"plan","prePlanMode":"auto"}"#) == .auto)
        #expect(try decode(#"{"open":true,"starting":false,"permissionMode":"plan","prePlanMode":null}"#) == nil)
        #expect(try decode(#"{"open":true,"starting":false,"permissionMode":"plan","prePlanMode":"bypassPermissions"}"#) == nil)
        #expect(try decode(#"{"open":true,"starting":false,"permissionMode":"auto"}"#) == nil)
    }
}
