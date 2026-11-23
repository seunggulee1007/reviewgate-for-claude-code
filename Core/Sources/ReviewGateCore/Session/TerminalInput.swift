import Foundation

// MARK: terminal-friction — docs/PROTOCOL.md §57.4 / §57.5
// What the app reads from the keys a terminal chat's PTY is sent: Esc while a turn runs. Claude Code runs no Stop hook on
// a user interrupt, so the turn stays open; an Esc the app saw with no hook after it shows "Review now" at once instead of
// after 60 s.

/// One Esc key press in the bytes a terminal view sends to its PTY.
public enum TerminalEscapeKey {
    /// `bytes` are the Esc key alone: a lone ESC, or its kitty keyboard form (`CSI 27 u`, a press with no modifier).
    /// A paste (`ESC [200~ …`), an arrow, a terminal reply or a key with ⌥ as Meta are not.
    public static func isEscape<C: Collection>(_ bytes: C) -> Bool where C.Element == UInt8 {
        let b = Array(bytes)
        if b == [0x1b] { return true }
        guard b.count >= 4, b[0] == 0x1b, b[1] == 0x5b, b.last == 0x75 else { return false }
        // CSI 27 u, CSI 27;1 u, CSI 27;1:1 u (press) — never a release (:3) or a repeat (:2), never with modifiers.
        let params = String(decoding: b[2..<(b.count - 1)], as: UTF8.self)
        return ["27", "27;1", "27;1:1"].contains(params)
    }
}

/// SwiftTerm sends ⌥Return / ⌥Backspace / ⌥← (⌥ as Meta on the functional keys) as a lone ESC and then the key, two
/// writes. An ESC is the Esc key only when nothing follows it within `metaWindow`.
public struct EscapeKeyFilter: Sendable {
    public static let metaWindow: TimeInterval = 0.05

    private var pending: Date?

    public init() {}

    /// One write to the PTY at `at`. Returns the time of an Esc that is confirmed now (a later write came after the
    /// window); a write right after a pending ESC makes that ESC a Meta prefix (dropped).
    public mutating func input<C: Collection>(_ bytes: C, at: Date) -> Date? where C.Element == UInt8 {
        var confirmed: Date?
        if let p = pending {
            pending = nil
            if at.timeIntervalSince(p) >= Self.metaWindow { confirmed = p }
        }
        if TerminalEscapeKey.isEscape(bytes) {
            // The kitty form is never a Meta prefix: confirmed at once.
            if bytes.count > 1 { return at }
            pending = at
        }
        return confirmed
    }

    /// The pending ESC once `metaWindow` passed with nothing after it (nil: none, or not yet).
    public mutating func flush(now: Date) -> Date? {
        guard let p = pending, now.timeIntervalSince(p) >= Self.metaWindow else { return nil }
        pending = nil
        return p
    }
}

/// An Esc the user pressed while a turn of the live terminal chat ran: when, and how many hooks the engine had counted
/// then (`TerminalSessionInfo.hookCount`).
public struct TerminalEscapeMark: Equatable, Sendable {
    public let at: Date
    public let hookCount: Int
    public let chatId: String

    public init(at: Date, hookCount: Int, chatId: String) {
        self.at = at
        self.hookCount = hookCount
        self.chatId = chatId
    }
}

/// §57.4: when the strip offers "Review now" (`terminal_end_turn`).
public enum TerminalReviewNowRules {
    /// A turn with nothing from Claude Code for this long.
    public static let idleLimit: TimeInterval = 60
    /// After an Esc the app saw, how long it waits for a hook (Claude Code going on: the Esc closed a menu, or it was a
    /// tool call's interrupt, which `interruptSuspected` covers) before offering it.
    public static let escapeGrace: TimeInterval = 2

    /// An Esc is recorded only while a turn of that chat runs (an Esc that closes a TUI menu between turns is nothing).
    public static func recordsEscape(turnRunning: Bool, info: TerminalSessionInfo?) -> Bool {
        turnRunning && info?.running == true
    }

    /// "Review now" shows while a turn runs in a running terminal and: a tool call was interrupted (`interruptSuspected`),
    /// or the user pressed Esc in this chat's terminal `escapeGrace` ago and no hook came since, or nothing changed for
    /// `idleLimit`.
    public static func shows(turnRunning: Bool, info: TerminalSessionInfo?, chatId: String, escape: TerminalEscapeMark?,
                             lastActivity: Date, now: Date) -> Bool {
        guard turnRunning, let info, info.running else { return false }
        if info.interruptSuspected || now.timeIntervalSince(lastActivity) >= idleLimit { return true }
        guard let escape, escape.chatId == chatId, info.hookCount == escape.hookCount else { return false }
        return now.timeIntervalSince(escape.at) >= escapeGrace
    }
}
