import Foundation

// MARK: terminal-friction — docs/PROTOCOL.md §57.5
// Files dropped on a terminal (Finder, a screenshot) go in as their shell-escaped paths, and "Mention in Chat" pastes
// `@path` into a terminal chat — one bracketed paste each, never Enter (§57.7).

extension AppState {
    /// "Mention in Chat" for a terminal chat: `@path` for each (quoted when it holds a space) pasted into the TUI's prompt,
    /// no Enter. Returns why it could not (nil: pasted).
    @discardableResult
    public func mentionInTerminal(_ paths: [String]) -> String? {
        guard !paths.isEmpty else { return nil }
        return pasteIntoTerminal(TerminalPathText.mentions(paths))
    }
}

/// §57.5: what a drop or a mention puts into a terminal.
public enum TerminalPathText {
    /// The characters a shell reads specially; each gets a backslash, as Terminal.app and iTerm2 write a dropped path.
    static let special: Set<Character> = [" ", "\t", "!", "\"", "#", "$", "&", "'", "(", ")", "*", ",", ";", "<", "=", ">", "?",
                                          "[", "\\", "]", "^", "`", "{", "|", "}", "~"]

    /// `path` as one shell word: a backslash before each special character; a path with another control character (a
    /// newline) is single-quoted whole instead (a backslash before a newline would join the lines). Unicode stays as it is.
    public static func shellEscaped(_ path: String) -> String {
        if path.unicodeScalars.contains(where: { $0.value < 0x20 && $0 != "\t" || $0.value == 0x7f }) {
            return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }
        var out = ""
        for ch in path {
            if special.contains(ch) { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    /// Dropped files: their absolute paths, shell-escaped, separated by spaces and followed by one (Terminal.app's form;
    /// Claude Code takes an image path as an image).
    public static func dropText(_ paths: [String]) -> String {
        paths.isEmpty ? "" : paths.map(shellEscaped).joined(separator: " ") + " "
    }

    /// "Mention in Chat": `@relative/path` each — `@"…"` when it holds whitespace — joined by spaces and followed by one.
    public static func mentions(_ paths: [String]) -> String {
        let words = paths.map { path -> String in
            path.contains(where: \.isWhitespace) ? "@\"\(path.replacingOccurrences(of: "\"", with: "\\\""))\"" : "@" + path
        }
        return words.isEmpty ? "" : words.joined(separator: " ") + " "
    }
}
