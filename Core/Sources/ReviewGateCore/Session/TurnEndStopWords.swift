import Foundation

// MARK: wave4b w4b-check4
// docs/PROTOCOL.md §40.1: the turn-end line says why the turn ended in words — the stop reasons of §38.1's list — instead of
// the CLI's raw `stopReason` (`error_max_turns`, `success`, …). Electron: renderer/stopWords.ts (same keys).

public extension TurnEndText {
    /// `turn_end.stopReason` in words; an unknown value is shown as it came (a newer CLI / engine).
    static func stopWords(_ raw: String) -> String {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "success", "ended", "end_turn":
            return String(localized: "Finished", bundle: .module)
        case "interrupted":
            return String(localized: "Stopped by you", bundle: .module)
        case "error_max_turns":
            return String(localized: "Stopped at the tool-call limit", bundle: .module)
        case "error_max_budget_usd":
            return String(localized: "Stopped at the cost limit", bundle: .module)
        case "error", "error_during_execution", "error_max_structured_output_retries":
            return String(localized: "Stopped by an error", bundle: .module)
        case "session restarted":
            return String(localized: "Stopped — the session restarted", bundle: .module)
        case "session closed":
            return String(localized: "Stopped — the session closed", bundle: .module)
        case "chat moved":
            return String(localized: "Stopped — the chat moved to another worktree", bundle: .module)
        default:
            return raw
        }
    }
}
