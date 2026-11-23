import Foundation

// MARK: c-panel (§57.18)
// docs/PROTOCOL.md §57.18: the bottom panel's 출력 tab — a read-only log of the window's own lines ("ReviewGate": the
// engine's `log` events and stderr, what the app logs) and of the Bash commands Claude ran in this window ("Claude 명령":
// each `tool_use` with the output its `tool_result` / `tool_output` carried). At most `limit` lines, oldest dropped.

/// Where an output line came from — the tab's source filter.
public enum OutputSource: String, Sendable, CaseIterable, Codable {
    case reviewGate
    case claude
}

public struct OutputLine: Sendable, Equatable, Identifiable {
    public let id: Int
    public let source: OutputSource
    public let text: String
}

public struct OutputLog: Sendable, Equatable {
    public static let defaultLimit = 5_000

    public private(set) var lines: [OutputLine] = []
    public let limit: Int
    private var nextId = 0

    public init(limit: Int = OutputLog.defaultLimit) {
        self.limit = max(1, limit)
    }

    /// Appends `text` line by line (`\n`, `\r\n`; a trailing newline adds no empty line); past `limit` the oldest go.
    public mutating func append(_ source: OutputSource, _ text: String) {
        var parts = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if parts.count > 1, parts.last == "" { parts.removeLast() }
        if parts.count > limit { parts = Array(parts.suffix(limit)) }
        for part in parts {
            lines.append(OutputLine(id: nextId, source: source, text: part))
            nextId += 1
        }
        if lines.count > limit { lines.removeFirst(lines.count - limit) }
    }

    /// One Bash call: `$ <command>`, its output, and a closing line when it failed or the output was cut.
    public mutating func appendBash(command: String, output: String, isError: Bool, truncated: Bool) {
        var block = "$ " + command.replacingOccurrences(of: "\n", with: "\n  ")
        let body = output.hasSuffix("\n") ? String(output.dropLast()) : output
        if !body.isEmpty { block += "\n" + body }
        if truncated { block += "\n" + String(localized: "… (the output was cut)", bundle: .module) }
        if isError { block += "\n" + String(localized: "✗ The command failed", bundle: .module) }
        append(.claude, block)
    }

    public mutating func clear() { lines = [] }

    /// The lines of `sources` holding `query` (case- and diacritic-insensitive; empty: every line).
    public func filtered(sources: Set<OutputSource>, query: String) -> [OutputLine] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return lines.filter { line in
            sources.contains(line.source) && (q.isEmpty || line.text.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil)
        }
    }

    /// What Copy puts on the clipboard: the shown lines, one per line.
    public static func text(_ lines: [OutputLine]) -> String { lines.map(\.text).joined(separator: "\n") }
}

public extension AppState {
    /// 출력 › 지우기: the window's output starts empty again (the daily log file keeps its lines).
    func clearOutput() { output.clear() }

    /// A Bash call's result: its command and output join 출력 — the kept full output (`tool_output`) when the preview was
    /// cut, else the preview. Results of calls whose `tool_use` this window did not see (restored rows) are not added.
    internal func outputBashResult(toolUseId: String, isError: Bool, preview: String, truncated: Bool) {
        guard let command = bashCommands.removeValue(forKey: toolUseId) else { return }
        guard truncated else {
            output.appendBash(command: command, output: preview, isError: isError, truncated: false)
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let (full, cut) = await self.fetchToolOutput(toolUseId: toolUseId)
            self.output.appendBash(command: command, output: full ?? preview, isError: isError, truncated: full == nil || cut)
        }
    }
}
