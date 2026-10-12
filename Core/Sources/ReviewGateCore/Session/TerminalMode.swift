import Foundation

// MARK: wave6 w6-terminal
// docs/PROTOCOL.md §44.1 on the Mac: the bottom of the chat works like Claude Code in the terminal — shift+tab in the
// composer cycles the permission mode, a one-line mode indicator says which one runs (Claude's own plan mode too), and
// approving a plan made in an auto chat goes back to auto.

/// shift+tab's order, as in the terminal: default → acceptEdits → plan → auto → default.
public enum PermissionModeCycle {
    public static let order: [PermissionMode] = [.default, .acceptEdits, .plan, .auto]

    /// The mode after `mode`; auto is skipped while the CLI cannot run it for this chat (`AppState.autoModeUnavailable`).
    public static func next(after mode: PermissionMode, autoAvailable: Bool) -> PermissionMode {
        let modes = autoAvailable ? order : order.filter { $0 != .auto }
        guard let at = modes.firstIndex(of: mode) else { return modes[0] }
        return modes[(at + 1) % modes.count]
    }
}

/// The colour family of the mode line (the view picks the colours).
public enum ComposerModeTone: Sendable, Equatable {
    case plain, auto, acceptEdits, plan
}

/// The terminal-style line under the composer: "⏵⏵ 자동 모드 (shift+tab 전환)", "⏸ 계획 모드 — 승인하면 자동 모드로
/// 돌아가요 (shift+tab 전환)", "기본 모드 (shift+tab 전환)"; a mode picked while Claude works is added ("다음 턴부터: 계획").
public struct ComposerModeLine: Sendable, Equatable {
    public let text: String
    public let tone: ComposerModeTone

    /// `approvesIntoAuto`: plan mode whose "Approve & run" goes back to auto (`AppState.planApproveMode`). `autoUnavailable`:
    /// the engine said auto mode cannot run here — the CLI runs the default mode (and asks), and the line says so.
    public static func make(mode: PermissionMode, scheduled: PermissionMode?, approvesIntoAuto: Bool, autoUnavailable: Bool = false) -> ComposerModeLine {
        var text: String
        let tone: ComposerModeTone
        switch mode {
        case .auto where autoUnavailable:
            text = String(localized: "Auto mode is not available here — running in default mode", bundle: .module)
            tone = .plain
        case .auto:
            text = "⏵⏵ " + String(localized: "Auto mode", bundle: .module)
            tone = .auto
        case .acceptEdits:
            text = "⏵⏵ " + String(localized: "Accept edits mode", bundle: .module)
            tone = .acceptEdits
        case .plan:
            text = "⏸ " + String(localized: "Plan mode", bundle: .module)
            if approvesIntoAuto { text += " — " + String(localized: "approving goes back to auto mode", bundle: .module) }
            tone = .plan
        case .default:
            text = String(localized: "Default mode", bundle: .module)
            tone = .plain
        }
        if let scheduled, scheduled != mode { text += " · " + AutoModeText.scheduledText(scheduled) }
        text += " " + String(localized: "(shift+tab to switch)", bundle: .module)
        return ComposerModeLine(text: text, tone: tone)
    }
}

extension AppState {
    /// "Approve & run" (and the new chat / workbench answers): back to auto when the chat came from auto mode, else the
    /// default mode as before (`state.session.prePlanMode`; an older engine sends none). Not into an auto mode the engine
    /// said cannot run here — the switch would be refused and the plan would wait.
    public var planApproveMode: PermissionMode { sessionInfo.prePlanMode == .auto && !autoModeUnavailable ? .auto : .default }

    /// The composer's mode line for the live mode (and a pick waiting for the turn to end).
    public var composerModeLine: ComposerModeLine {
        ComposerModeLine.make(mode: permissionMode, scheduled: scheduledPermissionMode,
                              approvesIntoAuto: permissionMode == .plan && planApproveMode == .auto, autoUnavailable: autoModeUnavailable)
    }

    /// shift+tab in the composer: the next mode of the terminal's cycle — now, or when the turn ends while Claude works
    /// (`pickPermissionMode`). From a waiting pick it goes on from that one; auto is skipped where it cannot run.
    public func cyclePermissionMode() {
        guard canPickPermissionMode else { return }
        let from = scheduledPermissionMode ?? permissionMode
        pickPermissionMode(PermissionModeCycle.next(after: from, autoAvailable: !autoModeUnavailable))
    }

    /// The engine said auto mode cannot run here (the start notice or a refused switch, `auto_mode_unavailable`).
    func noteAutoModeUnavailable() {
        autoModeUnavailable = true
    }

    /// After every snapshot: another project or another model may run auto mode again.
    func refreshAutoModeAvailability(previous: ReviewState) {
        guard autoModeUnavailable else { return }
        if state.project?.path != previous.project?.path || state.session.selectedModel != previous.session.selectedModel {
            autoModeUnavailable = false
        }
    }
}
