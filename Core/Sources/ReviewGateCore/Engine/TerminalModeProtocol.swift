import Foundation

// MARK: wave6 w6-terminal
// docs/PROTOCOL.md §44.1 on the wire: `state.session.prePlanMode` — while the chat is in plan mode, the mode before it.

enum TerminalModeWire {
    private enum Keys: String, CodingKey { case prePlanMode }

    /// `prePlanMode` of a state's session (nil when absent, null or a mode this app does not know).
    static func prePlanMode(from decoder: Decoder) -> PermissionMode? {
        guard let c = try? decoder.container(keyedBy: Keys.self) else { return nil }
        return lenientValue(String.self, c, .prePlanMode).flatMap(PermissionMode.init(rawValue:))
    }
}
