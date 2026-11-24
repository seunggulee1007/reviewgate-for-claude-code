import Foundation

// MARK: §67 — docs/PROTOCOL.md §67.1 `/add-dir` (directories beyond the project a chat may work in) and §67.2 `!` (the
// user's shell command between turns, as context for Claude's next message). The wire types; Session/AddDirShell.swift has
// the words and the app's actions.

/// §67.2 `state.session.shell`: a `!` command while it runs.
public struct ShellRunInfo: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var command: String
    /// Where it runs (the project folder).
    public var cwd: String
    /// ISO-8601.
    public var startedAt: String

    public init(id: String, command: String, cwd: String = "", startedAt: String = "") {
        self.id = id
        self.command = command
        self.cwd = cwd
        self.startedAt = startedAt
    }

    private enum CodingKeys: String, CodingKey { case id, command, cwd, startedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        command = lenientValue(String.self, c, .command) ?? ""
        cwd = lenientValue(String.self, c, .cwd) ?? ""
        startedAt = lenientValue(String.self, c, .startedAt) ?? ""
    }
}

/// §67.2: a finished `!` command — its transcript row (`kind: "shell"`) and the `shell_result` event.
public struct ShellResult: Sendable, Equatable, Hashable {
    public var id: String
    public var command: String
    /// Where it ran (the project folder).
    public var cwd: String
    /// stdout and stderr together, as a terminal shows them (escapes removed); its last part when `truncated`.
    public var output: String
    /// The output was longer: its start was cut.
    public var truncated: Bool
    /// nil: stopped (cancelled, timed out) or it could not start.
    public var exitCode: Int?
    public var timedOut: Bool
    public var cancelled: Bool
    public var durationMs: Int
    /// Project files it changed (repo-relative) — they reach the next review as `external` (§31.1).
    public var files: [String]
    /// More files changed than `files` lists.
    public var filesTruncated: Bool

    public init(id: String, command: String, cwd: String = "", output: String = "", truncated: Bool = false, exitCode: Int?,
                timedOut: Bool = false, cancelled: Bool = false, durationMs: Int = 0, files: [String] = [], filesTruncated: Bool = false) {
        self.id = id
        self.command = command
        self.cwd = cwd
        self.output = output
        self.truncated = truncated
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.cancelled = cancelled
        self.durationMs = durationMs
        self.files = files
        self.filesTruncated = filesTruncated
    }
}

extension ShellResult: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, command, cwd, output, truncated, exitCode, timedOut, cancelled, durationMs, files, filesTruncated
    }

    /// Lenient past `command`: a field a newer engine shapes differently reads as absent.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id) ?? "",
                  command: try c.decode(String.self, forKey: .command),
                  cwd: lenientValue(String.self, c, .cwd) ?? "",
                  output: lenientValue(String.self, c, .output) ?? "",
                  truncated: lenientValue(Bool.self, c, .truncated) ?? false,
                  exitCode: lenientValue(Int.self, c, .exitCode),
                  timedOut: lenientValue(Bool.self, c, .timedOut) ?? false,
                  cancelled: lenientValue(Bool.self, c, .cancelled) ?? false,
                  durationMs: lenientValue(Int.self, c, .durationMs) ?? 0,
                  files: lenientValue([String].self, c, .files) ?? [],
                  filesTruncated: lenientValue(Bool.self, c, .filesTruncated) ?? false)
    }
}

/// `state.session.addedDirs` / `shell` / `shellPending` (lenient: missing or malformed → none).
enum AddDirShellWire {
    private enum SessionKeys: String, CodingKey { case addedDirs, shell, shellPending }

    static func session(from decoder: Decoder) -> (addedDirs: [String], shell: ShellRunInfo?, shellPending: Int) {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self) else { return ([], nil, 0) }
        let dirs = (lenientValue([String].self, c, .addedDirs) ?? []).filter { !$0.isEmpty }
        let shell = lenientValue(ShellRunInfo.self, c, .shell).flatMap { $0.id.isEmpty ? nil : $0 }
        return (dirs, shell, max(0, lenientValue(Int.self, c, .shellPending) ?? 0))
    }
}

extension EngineCommand {
    private enum AddDirShellKeys: String, CodingKey { case path, command }

    /// `add_dir {path}`, `remove_dir {path}`, `shell_run {command}`, `shell_cancel {}` (`type` is written by the caller).
    func encodeAddDirShellFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AddDirShellKeys.self)
        switch self {
        case let .addDir(path), let .removeDir(path): try c.encode(path, forKey: .path)
        case let .shellRun(command): try c.encode(command, forKey: .command)
        default: break
        }
    }
}
