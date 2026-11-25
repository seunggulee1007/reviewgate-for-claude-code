import Foundation

// MARK: §67 — docs/PROTOCOL.md §67.3: `/add-dir` and `!` in a classic chat, as in Claude Code's terminal. `/add-dir <path>`
// (or the folder picker) adds a directory Claude may work in from the next message on — its edits always ask, since the
// review cannot show them; a draft starting with `!` runs as a shell command in the project folder between turns, and its
// output goes to Claude with the next message. Terminal chats keep their TUI's own.

/// §67.2: the running `!` command's output so far.
public struct ShellLiveOutput: Sendable, Equatable {
    public var id: String
    public var output: String

    public init(id: String, output: String) {
        self.id = id
        self.output = output
    }
}

/// §67.2: how a `!` command ended.
public enum ShellEnd: Sendable, Equatable {
    case succeeded
    case failed(exitCode: Int)
    case cancelled
    case timedOut
    /// No exit code and neither stopped nor timed out: it could not start.
    case notStarted

    public init(_ result: ShellResult) {
        if result.cancelled { self = .cancelled }
        else if result.timedOut { self = .timedOut }
        else if let code = result.exitCode { self = code == 0 ? .succeeded : .failed(exitCode: code) }
        else { self = .notStarted }
    }

    /// "✓ 0" · "✗ 종료 코드 n" · "중지됨" · "시간 초과" · "시작하지 못했어요".
    public var text: String {
        switch self {
        case .succeeded: "✓ 0"
        case let .failed(code): "✗ " + String(localized: "Exit code \(code)", bundle: .module)
        case .cancelled: String(localized: "Stopped", bundle: .module)
        case .timedOut: String(localized: "Timed out", bundle: .module)
        case .notStarted: String(localized: "Could not start", bundle: .module)
        }
    }

    public var isSuccess: Bool { self == .succeeded }
}

/// §67.2: the message box's shell mode and the `!` rows, in the user's words.
public enum ShellMode {
    /// The rows show the last this many lines of a long output (전체 보기 shows the rest).
    public static let foldedLines = 12

    /// A draft whose first character is `!` (Claude Code's bash mode).
    public static func isShellDraft(_ draft: String) -> Bool { draft.hasPrefix("!") }

    /// What `shell_run` runs for `draft`: the text after the `!`, trimmed; nil for a draft that is not in shell mode.
    public static func command(in draft: String) -> String? {
        guard isShellDraft(draft) else { return nil }
        return String(draft.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The badge at the box's start.
    public static var badge: String { String(localized: "Shell", bundle: .module) }

    /// The key hint under the box in shell mode, after the send key in use.
    public static func hint(key: String) -> String {
        String(localized: "\(key) runs the shell command · its output goes to Claude with your next message", bundle: .module)
    }

    /// The box's placeholder in shell mode (an empty `!`).
    public static var placeholder: String {
        String(localized: "A shell command to run in the project folder", bundle: .module)
    }

    /// `output` folded to its last `lines` lines: the text shown and how many lines were left out (0: all of it).
    public static func folded(_ output: String, lines: Int = foldedLines) -> (text: String, hidden: Int) {
        let trimmed = output.hasSuffix("\n") ? String(output.dropLast()) : output
        let all = trimmed.split(separator: "\n", omittingEmptySubsequences: false)
        guard all.count > lines, lines > 0 else { return (trimmed, 0) }
        return (all.suffix(lines).joined(separator: "\n"), all.count - lines)
    }

    /// "12줄 더 보기"-style button title: the whole output.
    public static func showAll(hidden: Int) -> String {
        String(localized: "Show all (\(hidden) more lines)", bundle: .module)
    }

    /// The note over an output whose start the engine cut.
    public static var truncatedNote: String {
        String(localized: "The start was cut", bundle: .module)
    }

    /// "파일 N개를 바꿨어요 — 다음 리뷰에 나와요".
    public static func filesLine(_ result: ShellResult) -> String? {
        guard !result.files.isEmpty else { return nil }
        let count = result.files.count
        return result.filesTruncated
            ? String(localized: "Changed more than \(count) files — they show in the next review", bundle: .module)
            : String(localized: "Changed \(count) file(s) — they show in the next review", bundle: .module)
    }

    /// The files line's tooltip: the names, one per line.
    public static func filesTooltip(_ result: ShellResult) -> String {
        result.files.joined(separator: "\n") + (result.filesTruncated ? "\n…" : "")
    }

    /// The row's line: how it ended and how long it took ("✓ 0 · 1.2초").
    public static func summary(_ result: ShellResult, language: String = ElapsedFormat.uiLanguage) -> String {
        ShellEnd(result).text + " · " + ElapsedFormat.text(seconds: Double(result.durationMs) / 1000, language: language)
    }

    /// The caption over the box while results wait for the next message (nil: none wait).
    public static func pendingCaption(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return String(localized: "\(count) shell result(s) go to Claude with your next message", bundle: .module)
    }

    /// Seconds since `startedAt` (ISO-8601); 0 when it does not read.
    public static func elapsed(since startedAt: String, now: Date = Date()) -> Double {
        guard let start = parseDate(startedAt) else { return 0 }
        return max(0, now.timeIntervalSince(start))
    }

    private static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// The live row's stop button and the composer's stop while a command runs.
    public static var stopHelp: String {
        String(localized: "Stop the shell command (esc)", bundle: .module)
    }
}

/// §67.1: the added-directories chip and the `/add-dir` notices.
public enum AddDirText {
    /// `/add-dir` ok.
    public static var added: String {
        String(localized: "Directory added — from your next message Claude works here too", bundle: .module)
    }

    /// The palette's line for /add-dir.
    public static var description: String {
        String(localized: "Let Claude work in a directory outside the project too", bundle: .module)
    }

    public static let argumentHint = "[path]"

    /// "디렉터리 N".
    public static func chip(_ count: Int) -> String { String(localized: "Directories \(count)", bundle: .module) }

    /// The chip's tooltip.
    public static var chipHelp: String {
        String(localized: "Directories this chat added with /add-dir — Claude may work there too, and every edit there asks first because the review does not show it", bundle: .module)
    }

    /// The folder picker's message.
    public static var pickerMessage: String {
        String(localized: "Choose a directory Claude may work in besides the project", bundle: .module)
    }
}

/// §67: the engine's refusals of `add_dir` / `remove_dir` / `shell_run` / `shell_cancel` in the user's words.
public enum AddDirShellText {
    public static func refusal(code: String, detail: String) -> String? {
        let path = detail.isEmpty ? nil : SessionNotices.abbreviatingHome(detail)
        switch code {
        case "dir_empty_path": return String(localized: "Type a directory path after /add-dir", bundle: .module)
        case "dir_path_too_long": return String(localized: "That path is too long", bundle: .module)
        case "dir_not_found":
            return path.map { String(localized: "There is no directory at \($0)", bundle: .module) }
                ?? String(localized: "That directory does not exist", bundle: .module)
        case "dir_not_directory":
            return path.map { String(localized: "\($0) is a file, not a directory", bundle: .module) }
                ?? String(localized: "That is a file, not a directory", bundle: .module)
        case "dir_is_project": return String(localized: "That is the project folder or inside it — Claude works there already", bundle: .module)
        case "dir_already_added":
            return path.map { String(localized: "Already added: \($0)", bundle: .module) }
                ?? String(localized: "That directory is already added", bundle: .module)
        case "dir_too_many": return String(localized: "A chat can add at most 20 directories — remove one first", bundle: .module)
        case "dir_busy": return String(localized: "Wait until Claude's work is done — the directories change only between turns", bundle: .module)
        case "dir_not_added": return String(localized: "That directory is not added to this chat", bundle: .module)
        case "empty_command": return String(localized: "Type a command after !", bundle: .module)
        case "command_too_long": return String(localized: "The command is too long (at most 10,000 characters)", bundle: .module)
        case "shell_busy": return String(localized: "A shell command is already running — wait or stop it (esc)", bundle: .module)
        case "turn_running": return String(localized: "Claude is working — run the shell command after the turn", bundle: .module)
        case "no_shell_running": return String(localized: "No shell command is running", bundle: .module)
        default: return nil
        }
    }
}

public extension AppState {
    /// §67.1: the current chat's added directories (real absolute paths, in the order added).
    var addedDirs: [String] { sessionInfo.addedDirs }
    /// §67.2: the `!` command running now.
    var shellRun: ShellRunInfo? { sessionInfo.shell }
    /// §67.2: `!` results that go to Claude with the next message.
    var shellPending: Int { sessionInfo.shellPending }

    /// §67.2: the running command's output so far ("" before its first `shell_output`).
    var shellRunOutput: String {
        guard let run = shellRun, let live = shellLive, live.id == run.id else { return "" }
        return live.output
    }

    /// §67.1: why the chip's × and "디렉터리 추가…" are off now (the engine would refuse `dir_busy`); nil: they work.
    var addedDirsBlocker: String? {
        guard projectInfo != nil else { return EngineMessages.refusal(error: "no_project") }
        if isStarting || isRunning || isSnapshotting || isReverting || isExternalTurn {
            return AddDirShellText.refusal(code: "dir_busy", detail: "")
        }
        return nil
    }

    /// §67.1 `add_dir {path}`: nil when added, else why not (the composer keeps the draft and says it).
    func addDir(_ path: String) async -> String? {
        await addDirCommand(.addDir(path: path))
    }

    /// §67.1 `remove_dir {path}`: nil when removed, else why not.
    func removeDir(_ path: String) async -> String? {
        await addDirCommand(.removeDir(path: path))
    }

    private func addDirCommand(_ command: EngineCommand) async -> String? {
        do {
            try await request(command)
            return nil
        } catch {
            appendLog("[warn] \(command.type): \(error.localizedDescription)")
            return (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    /// §67.2: `draft` (starting with `!`) runs as `shell_run` — never sent to Claude, never queued; it joins the prompt
    /// history. nil once it started, else why not.
    func runShell(_ draft: String) async -> String? {
        guard let command = ShellMode.command(in: draft) else { return nil }
        guard !command.isEmpty else { return AddDirShellText.refusal(code: "empty_command", detail: "") }
        recordPrompt(draft)
        do {
            try await request(.shellRun(command: command))
            return nil
        } catch {
            appendLog("[warn] shell_run: \(error.localizedDescription)")
            return (error as? EngineClientError)?.userMessage ?? error.localizedDescription
        }
    }

    /// §67.2: stops the running `!` command (the live row's 중지, Esc, the composer's stop).
    func cancelShell() {
        guard shellRun != nil else { return }
        fire(.shellCancel)
    }
}

extension AppState {
    func handleShellOutput(id: String, output: String) {
        guard !id.isEmpty else { return }
        shellLive = ShellLiveOutput(id: id, output: output)
    }

    /// The command's row joins the chat (once: a restored row of the same id is not added again).
    func handleShellResult(_ result: ShellResult, at: String) {
        if shellLive?.id == result.id { shellLive = nil }
        let known = !result.id.isEmpty && transcript.contains {
            if case let .shell(_, row) = $0 { return row.id == result.id }
            return false
        }
        guard !known else { return }
        transcript.append(.shell(id: at.isEmpty ? RowClock.newID() : RowClock.newID(at: at), result: result))
    }
}
