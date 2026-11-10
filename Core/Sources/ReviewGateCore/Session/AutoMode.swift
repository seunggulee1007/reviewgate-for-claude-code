import Foundation

// MARK: wave4b w4b-auto
// docs/PROTOCOL.md §39.5 on the Mac: auto mode leaves commands to Claude Code's own judgment (its classifier); file changes
// are still reviewed. What the classifier blocked is a gray chat row, an auto mode the CLI cannot run is said once, a mode
// picked while Claude works applies when the turn ends.

/// The words of §39.5 (English keys, Korean in the catalog; Electron uses the same keys).
public enum AutoModeText {
    /// The notices that stay chat rows only (gray, no banner, no paused queue).
    public static let rowOnlyCodes: Set<String> = ["auto_mode_denied", "auto_mode_unavailable"]

    public static func isRowOnly(_ code: String?) -> Bool { code.map(rowOnlyCodes.contains) ?? false }

    /// The row says everything: no gray second line (the call and the reason are in the row's own text).
    public static func hidesSecondary(_ code: String?) -> Bool { isRowOnly(code) }

    /// The one-line description of auto mode: the composer picker, the HUD chip, Settings.
    public static var helpText: String {
        String(localized: "Commands run on Claude Code's own judgment. File changes are still reviewed.", bundle: .module)
    }

    /// The row text of a §39.5 code; nil for any other code.
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        switch detail.code {
        case "auto_mode_denied":
            let what = detail.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return what.isEmpty ? String(localized: "Auto mode blocked a call", bundle: .module)
                : String(localized: "Auto mode blocked: \(what)", bundle: .module)
        case "auto_mode_unavailable":
            return String(localized: "Auto mode is not available for this model (or is turned off), so Claude Code asks before commands", bundle: .module)
        default:
            return nil
        }
    }

    /// The refusal of `set_permission_mode auto` when the CLI cannot run it for the model; nil for any other code.
    public static func refusal(code: String) -> String? {
        code == "auto_mode_unavailable"
            ? String(localized: "Auto mode is not available for this model. Pick another model or mode.", bundle: .module) : nil
    }

    /// The picker / HUD line while a mode waits for the turn to end.
    public static func scheduledText(_ mode: PermissionMode) -> String {
        String(localized: "From the next turn: \(mode.displayName)", bundle: .module)
    }

    /// Why picking a mode now only schedules it.
    public static var scheduledHelp: String {
        String(localized: "Claude is working — the mode changes when this turn ends", bundle: .module)
    }

    /// The mode menu's last line while Claude works (§39.5): a pick applies from Claude's next step, unless plan mode is
    /// involved (`switchesNow` false: the turn is in plan mode, or the engine takes no switch now) — that one waits.
    public static func busyHelp(switchesNow: Bool) -> String {
        switchesNow ? String(localized: "Claude is working — a new mode applies from its next step (plan mode: when this turn ends)", bundle: .module)
            : scheduledHelp
    }
}
