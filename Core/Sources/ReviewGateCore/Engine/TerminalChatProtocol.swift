import Foundation

// MARK: terminal-chat (§57)
// docs/PROTOCOL.md §57.1 on the wire: a chat whose column is the real Claude Code TUI in a terminal (`kind: "terminal"`).
// The engine gates its turns through hooks; the app only starts the PTY from `terminal_spec` and reports it.

/// What a chat runs — the app's chat UI (`chat`, the default) or the real `claude` TUI in a terminal (`terminal`).
public enum SessionKind: String, Codable, Sendable {
    case chat, terminal

    /// A missing or unknown kind (a newer engine) reads as `.chat`.
    public init(wire: String?) {
        self = wire.flatMap(SessionKind.init(rawValue:)) ?? .chat
    }
}

/// Reply to `terminal_spec`: how to start `claude` for the current terminal chat (`TerminalLaunch.claude` wraps it).
public struct TerminalSpec: Decodable, Sendable, Equatable {
    /// The correlation id of the reply.
    public var id: String?
    public let sessionId: String
    /// argv[0] = the claude executable. Never holds the hook token.
    public let argv: [String]
    /// Added to the PTY env; only keys starting `RG_` or `CLAUDE_CODE_` are used. Holds `RG_HOOK_TOKEN`.
    public let env: [String: String]
    public let cwd: String
    /// true: argv has `--resume=<id>`; false: `--session-id=<id>`.
    public let resume: Bool

    public init(id: String? = nil, sessionId: String, argv: [String], env: [String: String], cwd: String, resume: Bool) {
        self.id = id
        self.sessionId = sessionId
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.resume = resume
    }

    private enum CodingKeys: String, CodingKey { case id, sessionId, argv, env, cwd, resume }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        argv = try c.decode([String].self, forKey: .argv)
        env = (try? c.decodeIfPresent([String: String].self, forKey: .env)) ?? [:]
        cwd = try c.decode(String.self, forKey: .cwd)
        resume = (try? c.decodeIfPresent(Bool.self, forKey: .resume)) ?? false
    }
}

/// Claude Code waits for the user in the TUI (a permission prompt or a question).
public struct TerminalWaiting: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case permission, question }
    public let kind: Kind
    public let message: String
    /// ISO-8601 as written by the engine; part of the attention key.
    public let since: String

    public init(kind: Kind, message: String, since: String) {
        self.kind = kind
        self.message = message
        self.since = since
    }
}

/// `state.session.terminal`: the terminal chat's hook link (nil for a chat-kind session and on older engines).
public struct TerminalSessionInfo: Codable, Sendable, Equatable {
    /// `terminal_started` seen for the current spawn, no `terminal_exited` since.
    public let running: Bool
    /// A hook with the current spawn's token arrived.
    public let hooksSeen: Bool
    /// prompt_id of the open review turn (nil: none open, or a turn Claude started itself).
    public let promptId: String?
    /// Claude Code waits for the user in the TUI; cleared by the next hook.
    public let waiting: TerminalWaiting?
    /// A tool call ended by Esc and no Stop came: the turn stays open until the next prompt, idle, Review now or exit.
    public let interruptSuspected: Bool

    public init(running: Bool, hooksSeen: Bool, promptId: String? = nil, waiting: TerminalWaiting? = nil, interruptSuspected: Bool = false) {
        self.running = running
        self.hooksSeen = hooksSeen
        self.promptId = promptId
        self.waiting = waiting
        self.interruptSuspected = interruptSuspected
    }

    private enum CodingKeys: String, CodingKey { case running, hooksSeen, promptId, waiting, interruptSuspected }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        hooksSeen = (try? c.decodeIfPresent(Bool.self, forKey: .hooksSeen)) ?? false
        promptId = (try? c.decodeIfPresent(String.self, forKey: .promptId)) ?? nil
        waiting = (try? c.decodeIfPresent(TerminalWaiting.self, forKey: .waiting)) ?? nil
        interruptSuspected = (try? c.decodeIfPresent(Bool.self, forKey: .interruptSuspected)) ?? false
    }
}

enum TerminalChatWire {
    private enum MetaKeys: String, CodingKey { case kind, cliSessionId }
    private enum SessionKeys: String, CodingKey { case terminal }

    /// `kind` / `cliSessionId` of a `SessionMeta` (lenient: missing or unknown kind → `.chat`, an empty id → nil).
    static func meta(from decoder: Decoder) -> (kind: SessionKind, cliSessionId: String?) {
        guard let c = try? decoder.container(keyedBy: MetaKeys.self) else { return (.chat, nil) }
        let kind = SessionKind(wire: lenientValue(String.self, c, .kind))
        let cli = lenientValue(String.self, c, .cliSessionId).flatMap { $0.isEmpty ? nil : $0 }
        return (kind, cli)
    }

    /// Writes `kind` only for a terminal chat, as the engine does.
    static func encode(kind: SessionKind, cliSessionId: String?, to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: MetaKeys.self)
        if kind == .terminal { try c.encode(kind, forKey: .kind) }
        try c.encodeIfPresent(cliSessionId, forKey: .cliSessionId)
    }

    /// `state.session.terminal` (nil when absent, null or malformed).
    static func session(from decoder: Decoder) -> TerminalSessionInfo? {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self) else { return nil }
        return lenientValue(TerminalSessionInfo.self, c, .terminal)
    }
}

extension EngineCommand {
    private enum TerminalChatKeys: String, CodingKey { case kind, sessionId, pid, exitCode }

    /// `session_new {kind}` and the `terminal_*` commands' fields (`type` is written by the caller).
    func encodeTerminalChatFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: TerminalChatKeys.self)
        switch self {
        case .sessionNewTerminal:
            try c.encode(SessionKind.terminal, forKey: .kind)
        case let .terminalSpec(sessionId), let .terminalEndTurn(sessionId):
            try c.encode(sessionId, forKey: .sessionId)
        case let .terminalStarted(sessionId, pid):
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(pid, forKey: .pid)
        case let .terminalExited(sessionId, exitCode):
            try c.encode(sessionId, forKey: .sessionId)
            if let exitCode { try c.encode(exitCode, forKey: .exitCode) } else { try c.encodeNil(forKey: .exitCode) }
        default:
            break
        }
    }
}
