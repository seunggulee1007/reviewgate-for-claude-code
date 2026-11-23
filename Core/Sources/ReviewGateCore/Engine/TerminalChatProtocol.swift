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
    /// §57.4: hooks the current spawn sent so far (0: none, or an older engine) — whether a hook followed an Esc.
    public let hookCount: Int
    // MARK: terminal-stage2
    /// §57.13: the TUI's last status line input (the statusLine tee); nil before the first.
    public let status: TerminalStatus?
    /// §57.14: a Request changes waiting to reach Claude.
    public let requestQueued: TerminalRequestQueued?
    /// §57.15: permission dialogs the app may answer, oldest first.
    public let permissions: [TerminalPermission]
    /// §57.12: the chat is moving to another worktree — the app ends its PTY now (no restart).
    public let moving: TerminalPlace?
    /// §57.12: Claude Code works in another worktree of this repository (EnterWorktree, a cd) — the strip offers the move.
    public let elsewhere: TerminalElsewhere?

    public init(running: Bool, hooksSeen: Bool, promptId: String? = nil, waiting: TerminalWaiting? = nil, interruptSuspected: Bool = false,
                hookCount: Int = 0, status: TerminalStatus? = nil, requestQueued: TerminalRequestQueued? = nil, permissions: [TerminalPermission] = [],
                moving: TerminalPlace? = nil, elsewhere: TerminalElsewhere? = nil) {
        self.running = running
        self.hooksSeen = hooksSeen
        self.promptId = promptId
        self.waiting = waiting
        self.interruptSuspected = interruptSuspected
        self.hookCount = hookCount
        self.status = status
        self.requestQueued = requestQueued
        self.permissions = permissions
        self.moving = moving
        self.elsewhere = elsewhere
    }

    private enum CodingKeys: String, CodingKey {
        case running, hooksSeen, promptId, waiting, interruptSuspected, hookCount, status, requestQueued, permissions, moving, elsewhere
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        hooksSeen = (try? c.decodeIfPresent(Bool.self, forKey: .hooksSeen)) ?? false
        promptId = (try? c.decodeIfPresent(String.self, forKey: .promptId)) ?? nil
        waiting = (try? c.decodeIfPresent(TerminalWaiting.self, forKey: .waiting)) ?? nil
        interruptSuspected = (try? c.decodeIfPresent(Bool.self, forKey: .interruptSuspected)) ?? false
        hookCount = (try? c.decodeIfPresent(Int.self, forKey: .hookCount)) ?? 0
        status = lenientValue(TerminalStatus.self, c, .status)
        requestQueued = lenientValue(TerminalRequestQueued.self, c, .requestQueued)
        permissions = lenientElements(TerminalPermission.self, c, .permissions)
        moving = lenientValue(TerminalPlace.self, c, .moving)
        elsewhere = lenientValue(TerminalElsewhere.self, c, .elsewhere)
    }
}

// MARK: terminal-stage2 (§57.10–57.15)

/// §57.13: what the TUI's status line last saw (cost so far in the CLI's session, model, context).
public struct TerminalStatus: Codable, Sendable, Equatable {
    public let costUsd: Double?
    public let model: String?
    public let modelName: String?
    public let contextTokens: Int?
    public let contextWindow: Int?
    public let at: String

    public init(costUsd: Double?, model: String?, modelName: String?, contextTokens: Int?, contextWindow: Int?, at: String) {
        self.costUsd = costUsd
        self.model = model
        self.modelName = modelName
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case costUsd, model, modelName, contextTokens, contextWindow, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        costUsd = lenientValue(Double.self, c, .costUsd)
        model = lenientValue(String.self, c, .model)
        modelName = lenientValue(String.self, c, .modelName)
        contextTokens = lenientValue(Int.self, c, .contextTokens)
        contextWindow = lenientValue(Int.self, c, .contextWindow)
        at = try c.decode(String.self, forKey: .at)
    }

    /// The context used, 0…100 (nil without both numbers).
    public var contextPercent: Int? {
        guard let used = contextTokens, let window = contextWindow, window > 0 else { return nil }
        return min(100, max(0, Int((Double(used) / Double(window) * 100).rounded())))
    }
}

/// §57.14: a Request changes staged for Claude — at this turn's Stop (`stop`) or with the next prompt (`next_prompt`).
public struct TerminalRequestQueued: Codable, Sendable, Equatable {
    public enum Via: String, Codable, Sendable { case stop, nextPrompt = "next_prompt" }
    public let via: Via
    public let noteIds: [String]?
    public let extra: String?
    public let at: String

    public init(via: Via, noteIds: [String]? = nil, extra: String? = nil, at: String) {
        self.via = via
        self.noteIds = noteIds
        self.extra = extra
        self.at = at
    }
}

/// §57.15: one of Claude Code's permission dialogs the app may answer (`terminal_permission_response`).
public struct TerminalPermission: Codable, Sendable, Equatable, Identifiable {
    public var id: String { requestId }
    public let requestId: String
    public let toolName: String
    public let summary: String
    /// ReviewGate's own reason (the §57.8 git guard's), when it asked first.
    public let reason: String?
    public let since: String
    /// EnterWorktree only: "Allow and follow" is offered (absent → false).
    public let canFollow: Bool

    public init(requestId: String, toolName: String, summary: String, reason: String? = nil, since: String, canFollow: Bool = false) {
        self.requestId = requestId
        self.toolName = toolName
        self.summary = summary
        self.reason = reason
        self.since = since
        self.canFollow = canFollow
    }

    private enum CodingKeys: String, CodingKey { case requestId, toolName, summary, reason, since, canFollow }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        toolName = try c.decode(String.self, forKey: .toolName)
        summary = lenientValue(String.self, c, .summary) ?? ""
        reason = lenientValue(String.self, c, .reason)
        since = try c.decode(String.self, forKey: .since)
        canFollow = lenientValue(Bool.self, c, .canFollow) ?? false
    }
}

/// §57.12: a worktree of this repository (where the chat moves to).
public struct TerminalPlace: Codable, Sendable, Equatable {
    public let path: String
    public let name: String

    public init(path: String, name: String) {
        self.path = path
        self.name = name
    }
}

/// §57.12: Claude Code works in another worktree (`toolName`: `EnterWorktree` or `CwdChanged`).
public struct TerminalElsewhere: Codable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let toolName: String
    public let canMove: Bool

    public init(path: String, name: String, toolName: String, canMove: Bool) {
        self.path = path
        self.name = name
        self.toolName = toolName
        self.canMove = canMove
    }

    private enum CodingKeys: String, CodingKey { case path, name, toolName, canMove }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = try c.decode(String.self, forKey: .name)
        toolName = lenientValue(String.self, c, .toolName) ?? ""
        canMove = lenientValue(Bool.self, c, .canMove) ?? false
    }
}

/// §57.10: `state.sessions.backgroundTerminals[]` — a terminal chat of this window whose Claude Code keeps running while
/// another chat is current.
public struct BackgroundTerminalInfo: Codable, Sendable, Equatable {
    public let chatId: String
    public let running: Bool
    public let hooksSeen: Bool
    public let waiting: TerminalWaiting?

    public init(chatId: String, running: Bool, hooksSeen: Bool = false, waiting: TerminalWaiting? = nil) {
        self.chatId = chatId
        self.running = running
        self.hooksSeen = hooksSeen
        self.waiting = waiting
    }

    private enum CodingKeys: String, CodingKey { case chatId, running, hooksSeen, waiting }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try c.decode(String.self, forKey: .chatId)
        running = lenientValue(Bool.self, c, .running) ?? false
        hooksSeen = lenientValue(Bool.self, c, .hooksSeen) ?? false
        waiting = lenientValue(TerminalWaiting.self, c, .waiting)
    }
}

enum TerminalChatWire {
    private enum MetaKeys: String, CodingKey { case kind, cliSessionId, continuedFrom, continuedIn }
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

    /// §57.9: `continuedFrom` / `continuedIn` of a `SessionMeta` (an empty or malformed id → nil).
    static func continuation(from decoder: Decoder) -> (from: String?, into: String?) {
        guard let c = try? decoder.container(keyedBy: MetaKeys.self) else { return (nil, nil) }
        let id = { (k: MetaKeys) in lenientValue(String.self, c, k).flatMap { $0.isEmpty ? nil : $0 } }
        return (id(.continuedFrom), id(.continuedIn))
    }

    static func encode(continuedFrom: String?, continuedIn: String?, to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: MetaKeys.self)
        try c.encodeIfPresent(continuedFrom, forKey: .continuedFrom)
        try c.encodeIfPresent(continuedIn, forKey: .continuedIn)
    }

    /// `state.session.terminal` (nil when absent, null or malformed).
    static func session(from decoder: Decoder) -> TerminalSessionInfo? {
        guard let c = try? decoder.container(keyedBy: SessionKeys.self) else { return nil }
        return lenientValue(TerminalSessionInfo.self, c, .terminal)
    }
}

extension EngineCommand {
    private enum TerminalChatKeys: String, CodingKey { case kind, sessionId, pid, exitCode, requestId, allow, message, follow }

    /// `session_new {kind}` and the `terminal_*` commands' fields (`type` is written by the caller).
    func encodeTerminalChatFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: TerminalChatKeys.self)
        switch self {
        case .sessionNewTerminal:
            try c.encode(SessionKind.terminal, forKey: .kind)
        case let .terminalSpec(sessionId), let .terminalEndTurn(sessionId), let .sessionContinueTerminal(sessionId),
             let .terminalRequestCancel(sessionId):
            try c.encode(sessionId, forKey: .sessionId)
        case let .terminalPermissionResponse(sessionId, requestId, allow, message, follow):   // §57.15
            try c.encode(sessionId, forKey: .sessionId)
            try c.encode(requestId, forKey: .requestId)
            try c.encode(allow, forKey: .allow)
            try c.encodeIfPresent(message, forKey: .message)
            if follow { try c.encode(true, forKey: .follow) }
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
