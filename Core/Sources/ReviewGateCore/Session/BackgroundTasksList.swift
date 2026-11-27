import Foundation

// MARK: §71.3 — docs/PROTOCOL.md §71.3: `/tasks` (the terminal's `/bashes` too) in a classic chat lists the background
// work of §52 — each shell, monitor and agent with the end of its output and [중지] — as the terminal's /tasks does.

public extension BackgroundText {
    /// The last `lines` non-empty lines of a task's output (ANSI colors and carriage-return redraws taken out).
    static func tail(_ text: String, lines: Int = 3) -> [String] {
        let plain = text.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
        // Lines by "\n" (NSString's, so "\r\n" splits too); a progress bar redraws its line with "\r": the last state is
        // what the terminal shows.
        let shown = plain.components(separatedBy: "\n").map { line in
            line.components(separatedBy: "\r").last { !$0.isEmpty } ?? ""
        }
        return Array(shown.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(lines)).map { String($0.prefix(240)) }
    }

    /// The palette's line for `/tasks`.
    static var tasksDescription: String {
        String(localized: "List the shells and agents running in the background — their output, and stop them", bundle: .module)
    }

    static var tasksTitle: String { String(localized: "Background tasks", bundle: .module) }

    static var stopHelp: String {
        String(localized: "Stop this task — Claude goes on without waiting for it", bundle: .module)
    }

    static var outputHelp: String { String(localized: "Show the end of its output (the last 64 KB)", bundle: .module) }

    static var stoppingHelp: String { String(localized: "Stopping…", bundle: .module) }

    static var noOutputYet: String { String(localized: "No output yet", bundle: .module) }

    /// The sheet's note on what Ctrl+B does (§52).
    static var moveHint: String {
        String(localized: "While Claude runs a command, ⌃B in the empty message box moves it here.", bundle: .module)
    }
}
