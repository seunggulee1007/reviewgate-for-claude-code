// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the user's Claude Code status line on the wire.
import Foundation

/// The last run failed (`timeout` / `exit` / `spawn`); the lines stay the last good run's.
public struct StatusLineFailure: Sendable, Equatable, Decodable {
    public var code: String
    public var message: String
    public var at: String
    public var exitCode: Int?

    public init(code: String, message: String = "", at: String = "", exitCode: Int? = nil) {
        self.code = code
        self.message = message
        self.at = at
        self.exitCode = exitCode
    }

    private enum CodingKeys: String, CodingKey { case code, message, at, exitCode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(code: lenientValue(String.self, c, .code) ?? "", message: lenientValue(String.self, c, .message) ?? "",
                  at: lenientValue(String.self, c, .at) ?? "", exitCode: lenientValue(Int.self, c, .exitCode))
    }
}

/// A `statusLine` the project's own settings define: where, the command, its sha256 (what the user allows, per project:
/// `allowedProjectStatusLine`), and whether it runs.
public struct StatusLineProjectDefinition: Sendable, Equatable, Decodable {
    public var path: String
    public var command: String
    /// The command's sha256 (hex); "" from an engine before it was told.
    public var sha256: String
    public var allowed: Bool

    public init(path: String, command: String, sha256: String = "", allowed: Bool) {
        self.path = path
        self.command = command
        self.sha256 = sha256
        self.allowed = allowed
    }

    private enum CodingKeys: String, CodingKey { case path, command, sha256, allowed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: lenientValue(String.self, c, .path) ?? "", command: lenientValue(String.self, c, .command) ?? "",
                  sha256: lenientValue(String.self, c, .sha256) ?? "", allowed: lenientValue(Bool.self, c, .allowed) ?? false)
    }
}

/// Reply to `status_line`, and sent (no id) whenever what the status line shows changes.
public struct StatusLineReply: Sendable, Equatable, Decodable {
    public var id: String?
    /// The command's output lines as printed (ANSI escapes and OSC 8 links kept).
    public var lines: [String]
    /// ISO-8601 of the run that printed them; nil before the first.
    public var updatedAt: String?
    /// `settings.showStatusLine` is not false.
    public var enabled: Bool
    /// A command is configured and allowed.
    public var configured: Bool
    /// `user` / `project` / `local` / `managed`.
    public var source: String?
    /// The settings file it comes from.
    public var path: String?
    public var command: String?
    /// Blank columns on each side.
    public var padding: Int
    public var error: StatusLineFailure?
    public var project: StatusLineProjectDefinition?
    /// Why nothing runs: `disable_all_hooks` — a settings file (or "my hooks off") turns it off; `managed_policy` — the
    /// organization's managed settings cannot be read or allow only their own.
    public var disabled: String?

    public init(id: String? = nil, lines: [String] = [], updatedAt: String? = nil, enabled: Bool = true, configured: Bool = false,
                source: String? = nil, path: String? = nil, command: String? = nil, padding: Int = 0, error: StatusLineFailure? = nil,
                project: StatusLineProjectDefinition? = nil, disabled: String? = nil) {
        self.id = id
        self.lines = lines
        self.updatedAt = updatedAt
        self.enabled = enabled
        self.configured = configured
        self.source = source
        self.path = path
        self.command = command
        self.padding = padding
        self.error = error
        self.project = project
        self.disabled = disabled
    }

    private enum CodingKeys: String, CodingKey { case id, lines, updatedAt, enabled, configured, source, path, command, padding, error, project, disabled }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id), lines: lenientElements(String.self, c, .lines),
                  updatedAt: lenientValue(String.self, c, .updatedAt), enabled: lenientValue(Bool.self, c, .enabled) ?? true,
                  configured: lenientValue(Bool.self, c, .configured) ?? false, source: lenientValue(String.self, c, .source),
                  path: lenientValue(String.self, c, .path), command: lenientValue(String.self, c, .command),
                  padding: max(0, min(20, lenientValue(Int.self, c, .padding) ?? 0)), error: lenientValue(StatusLineFailure.self, c, .error),
                  project: lenientValue(StatusLineProjectDefinition.self, c, .project), disabled: lenientValue(String.self, c, .disabled))
    }
}
