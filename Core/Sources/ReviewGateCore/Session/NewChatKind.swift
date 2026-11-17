import Foundation

// MARK: terminal-default — docs/PROTOCOL.md §57.7
// A new chat the user asks for (⌘T, [+], 새 채팅, a project's first chat) is a terminal chat — the real Claude Code TUI —
// unless Settings › "새 채팅 종류" says Chat. Both kinds stay one menu item away (⌃⌘T, ⌃⌥⌘T). Existing chats keep their
// kind. Flows that send text for the user cannot target a terminal chat (nothing types into its TUI): they make a chat,
// or — on an explicit click — paste into the terminal without Enter.

extension AppSettings.Key {
    /// §57.7: `SessionKind.rawValue` of a new chat; unset → `terminal`.
    public static let newChatKind = "newChatKind"
}

extension AppSettings {
    /// The kind ⌘T / [+] / 새 채팅 and a project's first chat open as (unset or unknown → terminal).
    public static func newChatKind(defaults: UserDefaults = .standard) -> SessionKind {
        defaults.string(forKey: Key.newChatKind).flatMap(SessionKind.init(rawValue:)) ?? .terminal
    }

    public static func setNewChatKind(_ kind: SessionKind, defaults: UserDefaults = .standard) {
        defaults.set(kind.rawValue, forKey: Key.newChatKind)
    }
}

extension AppState {
    /// What ⌘T / [+] / 새 채팅 opens (Settings › "새 채팅 종류").
    public var defaultChatKind: SessionKind { AppSettings.newChatKind(defaults: settingsDefaults) }

    /// `set_settings {newChatKind}` after Settings changed it: the engine makes a project's first chat of that kind (live).
    public func pushNewChatKind() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.newChatKind = defaultChatKind
        fire(.setSettings(settings))
    }

    /// "Paste into the terminal": `text` goes into the live terminal chat's prompt (bracketed paste, never Enter) and the
    /// terminal takes the keyboard — the user reads it and sends it. Returns why it could not (nil: pasted).
    @discardableResult
    public func pasteIntoTerminal(_ text: String) -> String? {
        guard isTerminalChat, viewingChat == nil else { return NewChatKindText.notTerminal }
        guard let paste = onTerminalPaste else { return NewChatKindText.terminalNotRunning }
        return paste(text)
    }
}

/// §57.7: the bytes a paste into a TUI writes — `ESC [200~ text ESC [201~`, only when the program turned bracketed paste on
/// (Claude Code does), so a newline in the text never acts as Enter. nil when it did not: nothing is written.
public enum TerminalPaste {
    public static let start: [UInt8] = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]
    public static let end: [UInt8] = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]

    public static func bytes(_ text: String, bracketed: Bool) -> [UInt8]? {
        guard bracketed else { return nil }
        // A paste-end marker inside the text would end the paste early and let the rest act as typed keys; the
        // terminal's own line ending is CR, never LF alone (a lone CR stays inside the brackets: not Enter).
        let clean = text.replacingOccurrences(of: "\u{1b}[201~", with: "")
            .replacingOccurrences(of: "\r\n", with: "\r")
            .replacingOccurrences(of: "\n", with: "\r")
        guard !clean.isEmpty else { return nil }
        return start + Array(clean.utf8) + end
    }
}

/// §57.7 in the user's words.
public enum NewChatKindText {
    public static var notTerminal: String {
        String(localized: "The chat on screen is not a live terminal chat", bundle: .module)
    }
    public static var terminalNotRunning: String {
        String(localized: "Claude Code is not running in this terminal — restart it first", bundle: .module)
    }
    public static var terminalNotReady: String {
        String(localized: "Claude Code is not ready for a paste yet — try again once its prompt shows", bundle: .module)
    }
    /// The toast after a paste.
    public static var pasted: String {
        String(localized: "Pasted into the terminal — press Return there to send it", bundle: .module)
    }
}
