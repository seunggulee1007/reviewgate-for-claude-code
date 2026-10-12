import Foundation

// Wire types of docs/PROTOCOL.md §21 (side questions, "곁질문") and §22 (MCP servers), engine/src/protocol.ts.
// Every decoder is lenient — missing fields default, unknown enum values fall back — so a newer engine never makes
// an event undecodable.

// MARK: - §21 Side questions

/// What a side question is about; every field optional. `entryId`: a review-history entry (§14) instead of the
/// current review.
public struct SideAnchor: Codable, Sendable, Hashable {
    public var path: String?
    public var hunkId: Int?
    public var line: Int?
    public var side: DiffSide?
    public var toolUseId: String?
    public var entryId: String?
    // MARK: wave3 mac-flow
    /// §36.14: a line / hunk of the PR open in the PR tab (the fields above stay empty then); `SideAnchor(pr:)`.
    public var pr: SidePrAnchor?
    // MARK: wave4b w4b-side
    /// §40.3: a passage of Claude's answer (the fields above stay empty then); `SideAnchor(quote:)`.
    public var quote: SideQuoteAnchor?

    public init(path: String? = nil, hunkId: Int? = nil, line: Int? = nil, side: DiffSide? = nil,
                toolUseId: String? = nil, entryId: String? = nil) {
        self.path = path
        self.hunkId = hunkId
        self.line = line
        self.side = side
        self.toolUseId = toolUseId
        self.entryId = entryId
    }

    public var isEmpty: Bool { path == nil && hunkId == nil && line == nil && toolUseId == nil && entryId == nil && pr == nil && quote == nil }

    private enum CodingKeys: String, CodingKey { case path, hunkId, line, side, toolUseId, entryId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(path: try? c.decodeIfPresent(String.self, forKey: .path),
                  hunkId: try? c.decodeIfPresent(Int.self, forKey: .hunkId),
                  line: try? c.decodeIfPresent(Int.self, forKey: .line),
                  side: try? c.decodeIfPresent(DiffSide.self, forKey: .side),
                  toolUseId: try? c.decodeIfPresent(String.self, forKey: .toolUseId),
                  entryId: try? c.decodeIfPresent(String.self, forKey: .entryId))
        decodePrField(from: decoder)   // wave3 mac-flow (§36.14)
        decodeQuoteField(from: decoder)   // wave4b w4b-side (§40.3)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(path, forKey: .path)
        try c.encodeIfPresent(hunkId, forKey: .hunkId)
        try c.encodeIfPresent(line, forKey: .line)
        try c.encodeIfPresent(side, forKey: .side)
        try c.encodeIfPresent(toolUseId, forKey: .toolUseId)
        try c.encodeIfPresent(entryId, forKey: .entryId)
        try encodePrField(to: encoder)   // wave3 mac-flow (§36.14)
        try encodeQuoteField(to: encoder)   // wave4b w4b-side (§40.3)
    }
}

/// A tool call the side session made (read-only tools only; `denied` when the read-only policy refused it).
public struct SideToolCall: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var input: JSONValue
    /// nil while the call has not returned yet.
    public var isError: Bool?
    public var preview: String?
    public var denied: Bool

    public init(id: String, name: String, input: JSONValue = .object([:]), isError: Bool? = nil, preview: String? = nil, denied: Bool = false) {
        self.id = id
        self.name = name
        self.input = input
        self.isError = isError
        self.preview = preview
        self.denied = denied
    }
}

extension SideToolCall: Decodable {
    private enum CodingKeys: String, CodingKey { case id, name, input, isError, preview, denied }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString,
                  name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
                  input: (try? c.decodeIfPresent(JSONValue.self, forKey: .input)) ?? .object([:]),
                  isError: try? c.decodeIfPresent(Bool.self, forKey: .isError),
                  preview: try? c.decodeIfPresent(String.self, forKey: .preview),
                  denied: (try? c.decodeIfPresent(Bool.self, forKey: .denied)) ?? false)
    }
}

public struct SideMessage: Sendable, Equatable {
    public enum Role: String, Sendable, Equatable { case user, assistant }
    public var role: Role
    public var text: String
    /// ISO-8601.
    public var at: String
    public var toolCalls: [SideToolCall]
    /// Assistant only.
    public var costUSD: Double?
    public var durationMs: Int?
    public var stopReason: String?

    public init(role: Role, text: String, at: String = "", toolCalls: [SideToolCall] = [], costUSD: Double? = nil,
                durationMs: Int? = nil, stopReason: String? = nil) {
        self.role = role
        self.text = text
        self.at = at
        self.toolCalls = toolCalls
        self.costUSD = costUSD
        self.durationMs = durationMs
        self.stopReason = stopReason
    }

    public var date: Date? { isoDate(at) }
    /// The answer was cut short with `side_cancel`.
    public var wasInterrupted: Bool { stopReason == "interrupted" }
}

extension SideMessage: Decodable {
    private enum CodingKeys: String, CodingKey { case role, text, at, toolCalls, costUSD, durationMs, stopReason }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let role = (try? c.decodeIfPresent(String.self, forKey: .role)).flatMap(Role.init(rawValue:)) ?? .assistant
        self.init(role: role,
                  text: (try? c.decodeIfPresent(String.self, forKey: .text)) ?? "",
                  at: (try? c.decodeIfPresent(String.self, forKey: .at)) ?? "",
                  toolCalls: (try? c.decodeIfPresent([SideToolCall].self, forKey: .toolCalls)) ?? [],
                  costUSD: try? c.decodeIfPresent(Double.self, forKey: .costUSD),
                  durationMs: try? c.decodeIfPresent(Int.self, forKey: .durationMs),
                  stopReason: try? c.decodeIfPresent(String.self, forKey: .stopReason))
    }
}

public enum SideThreadStatus: String, Sendable, Equatable {
    case idle, running, error
}

/// How the first question started: forked at the main session's last completed turn, a full fork, or fresh.
public struct SideFork: Sendable, Equatable {
    public enum Mode: String, Sendable, Equatable { case forkAt = "fork_at", forkFull = "fork_full", fresh }
    public var mode: Mode
    public var fromSessionId: String?
    public var at: String?
    // MARK: wave3 mac-agents
    /// §36.10: the last main turn the fork contains (nil: fresh, or an engine before §36).
    public var atTurn: Int?
    /// §36.10: the main turn that was running and is only summarized in the first prompt; nil when none.
    public var runningTurn: Int?

    public init(mode: Mode, fromSessionId: String? = nil, at: String? = nil) {
        self.mode = mode
        self.fromSessionId = fromSessionId
        self.at = at
    }
}

extension SideFork: Decodable {
    private enum CodingKeys: String, CodingKey { case mode, fromSessionId, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(mode: (try? c.decodeIfPresent(String.self, forKey: .mode)).flatMap(Mode.init(rawValue:)) ?? .fresh,
                  fromSessionId: try? c.decodeIfPresent(String.self, forKey: .fromSessionId),
                  at: try? c.decodeIfPresent(String.self, forKey: .at))
        (atTurn, runningTurn) = AgentWire.forkTurns(from: decoder)   // wave3 mac-agents (§36.10)
    }
}

public enum SidePromoteTarget: String, Codable, Sendable, Equatable {
    /// `send` of the main conversation.
    case message
    /// A review note on the anchor.
    case note
}

public struct SidePromotion: Sendable, Equatable {
    public var target: SidePromoteTarget
    public var at: String
    // MARK: wave4b w4b-side
    /// §40.3: put in the composer queue (the main turn was running), not sent yet.
    public var queued = false

    public init(target: SidePromoteTarget, at: String) {
        self.target = target
        self.at = at
    }
}

extension SidePromotion: Decodable {
    private enum CodingKeys: String, CodingKey { case target = "as", at, queued }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(target: (try? c.decodeIfPresent(SidePromoteTarget.self, forKey: .target)).flatMap { $0 } ?? .message,
                  at: (try? c.decodeIfPresent(String.self, forKey: .at)) ?? "")
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)).flatMap { $0 } ?? false   // wave4b w4b-side (§40.3)
    }
}

public struct SideThread: Sendable, Equatable, Identifiable {
    public var id: String
    /// The chat (`SessionMeta.id`) it belongs to.
    public var mainSessionId: String?
    public var anchor: SideAnchor?
    public var createdAt: String
    public var updatedAt: String
    /// First line of the first question, ≤ 60 chars.
    public var title: String
    public var messages: [SideMessage]
    public var status: SideThreadStatus
    public var error: String?
    /// The side Claude session; nil until the CLI started one.
    public var sessionId: String?
    public var fork: SideFork?
    /// Every question + promote drafts.
    public var costUSD: Double
    public var promotions: [SidePromotion]

    public init(id: String, mainSessionId: String? = nil, anchor: SideAnchor? = nil, createdAt: String = "", updatedAt: String = "",
                title: String = "", messages: [SideMessage] = [], status: SideThreadStatus = .idle, error: String? = nil,
                sessionId: String? = nil, fork: SideFork? = nil, costUSD: Double = 0, promotions: [SidePromotion] = []) {
        self.id = id
        self.mainSessionId = mainSessionId
        self.anchor = anchor
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.title = title
        self.messages = messages
        self.status = status
        self.error = error
        self.sessionId = sessionId
        self.fork = fork
        self.costUSD = costUSD
        self.promotions = promotions
    }

    public var isRunning: Bool { status == .running }
    public var updatedDate: Date? { isoDate(updatedAt) }
    /// An answer exists (what `side_promote_draft` needs).
    public var hasAnswer: Bool { messages.contains { $0.role == .assistant && !$0.text.isEmpty } }
}

extension SideThread: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, mainSessionId, anchor, createdAt, updatedAt, title, messages, status, error, sessionId, fork, costUSD, promotions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let anchor = (try? c.decodeIfPresent(SideAnchor.self, forKey: .anchor)).flatMap { $0 }
        self.init(id: try c.decode(String.self, forKey: .id),
                  mainSessionId: try? c.decodeIfPresent(String.self, forKey: .mainSessionId),
                  anchor: anchor?.isEmpty == true ? nil : anchor,
                  createdAt: (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? "",
                  updatedAt: (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? "",
                  title: (try? c.decodeIfPresent(String.self, forKey: .title)) ?? "",
                  messages: (try? c.decodeIfPresent([SideMessage].self, forKey: .messages)) ?? [],
                  status: (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap(SideThreadStatus.init(rawValue:)) ?? .idle,
                  error: try? c.decodeIfPresent(String.self, forKey: .error),
                  sessionId: try? c.decodeIfPresent(String.self, forKey: .sessionId),
                  fork: (try? c.decodeIfPresent(SideFork.self, forKey: .fork)).flatMap { $0 },
                  costUSD: (try? c.decodeIfPresent(Double.self, forKey: .costUSD)) ?? 0,
                  promotions: (try? c.decodeIfPresent([SidePromotion].self, forKey: .promotions)) ?? [])
    }
}

// MARK: - §22 MCP servers

public enum McpScope: String, Codable, Sendable, Equatable, CaseIterable, Identifiable {
    /// This app's running session only (re-applied at every session start of the project).
    case session
    // MARK: wave3 mac-session
    /// §36.6: `~/.claude.json` for this project only (`claude mcp add --scope local`) — not shared through git.
    case local
    /// The project's `.mcp.json` (shared through git).
    case project
    /// `~/.claude.json` — every project.
    case user

    public var id: String { rawValue }
}

public enum McpServerStatus: String, Sendable, Equatable {
    case connected, failed, needsAuth = "needs-auth", pending, disabled, unknown

    public init(lenient raw: String?) {
        self = raw.flatMap(McpServerStatus.init(rawValue:)) ?? .unknown
    }
}

public enum McpSource: String, Sendable, Equatable {
    case user, project, local, plugin, claudeAI = "claude.ai", managed, session, unknown

    public init(lenient raw: String?) {
        self = raw.flatMap(McpSource.init(rawValue:)) ?? .unknown
    }

    /// The scope `mcp_remove` takes for a server from this source; nil = not removable from the app.
    public var removableScope: McpScope? {
        switch self {
        case .user: .user
        case .project: .project
        case .session: .session
        case .local: .local   // wave3 mac-session (§36.6)
        default: nil
        }
    }
}

public enum McpTransport: String, Sendable, Equatable {
    case stdio, http, sse, sdk, claudeAIProxy = "claudeai-proxy", unknown

    public init(lenient raw: String?) {
        self = raw.flatMap(McpTransport.init(rawValue:)) ?? .unknown
    }
}

/// The redacted config the engine reports: env / header VALUES never leave the engine, only their keys.
public struct McpConfigSummary: Sendable, Equatable {
    public var command: String?
    public var args: [String]
    public var url: String?
    public var envKeys: [String]
    public var headerKeys: [String]

    public init(command: String? = nil, args: [String] = [], url: String? = nil, envKeys: [String] = [], headerKeys: [String] = []) {
        self.command = command
        self.args = args
        self.url = url
        self.envKeys = envKeys
        self.headerKeys = headerKeys
    }
}

extension McpConfigSummary: Decodable {
    private enum CodingKeys: String, CodingKey { case command, args, url, envKeys, headerKeys }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(command: try? c.decodeIfPresent(String.self, forKey: .command),
                  args: (try? c.decodeIfPresent([String].self, forKey: .args)) ?? [],
                  url: try? c.decodeIfPresent(String.self, forKey: .url),
                  envKeys: (try? c.decodeIfPresent([String].self, forKey: .envKeys)) ?? [],
                  headerKeys: (try? c.decodeIfPresent([String].self, forKey: .headerKeys)) ?? [])
    }
}

public struct McpServerInfo: Sendable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var status: McpServerStatus
    /// The SDK's raw scope (user, project, local, claudeai, managed, dynamic, …).
    public var scope: String?
    public var source: McpSource
    public var transport: McpTransport
    /// nil when the server did not report tools (not connected).
    public var toolCount: Int?
    public var tools: [String]
    public var error: String?
    public var serverName: String?
    public var serverVersion: String?
    public var config: McpConfigSummary?
    /// Turned off with `mcp_toggle {enabled:false}` (persisted per project).
    public var disabledByUser: Bool
    /// Added with `mcp_add {scope:"session"}`.
    public var sessionAdded: Bool
    // MARK: wave4d w4d-config
    /// §42.3: the file that defines it and whether ReviewGate can remove it there; nil from older engines.
    public var origin: McpServerOrigin? = nil
    /// §42.3: which choice turned it off — "worktree" or "repository" (every worktree).
    public var disabledIn: String? = nil
    /// §42.3: `mcp_auth` opened a terminal; the engine reconnects it until the login took.
    public var authWaiting = false

    public init(name: String, status: McpServerStatus, scope: String? = nil, source: McpSource = .unknown, transport: McpTransport = .unknown,
                toolCount: Int? = nil, tools: [String] = [], error: String? = nil, serverName: String? = nil, serverVersion: String? = nil,
                config: McpConfigSummary? = nil, disabledByUser: Bool = false, sessionAdded: Bool = false) {
        self.name = name
        self.status = status
        self.scope = scope
        self.source = source
        self.transport = transport
        self.toolCount = toolCount
        self.tools = tools
        self.error = error
        self.serverName = serverName
        self.serverVersion = serverVersion
        self.config = config
        self.disabledByUser = disabledByUser
        self.sessionAdded = sessionAdded
    }

    /// Needs the user (the composer caption's warning dot).
    public var needsAttention: Bool { status == .failed || status == .needsAuth }
    /// Off (by the user or the CLI).
    public var isOff: Bool { status == .disabled || disabledByUser }
}

extension McpServerInfo: Decodable {
    private enum CodingKeys: String, CodingKey {
        case name, status, scope, source, transport, toolCount, tools, error, serverInfo, config, disabledByUser, sessionAdded
    }
    private enum ServerInfoKeys: String, CodingKey { case name, version }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let info = try? c.nestedContainer(keyedBy: ServerInfoKeys.self, forKey: .serverInfo)
        self.init(name: (try? c.decodeIfPresent(String.self, forKey: .name)).flatMap { $0 } ?? "",
                  status: McpServerStatus(lenient: (try? c.decodeIfPresent(String.self, forKey: .status)).flatMap { $0 }),
                  scope: try? c.decodeIfPresent(String.self, forKey: .scope),
                  source: McpSource(lenient: (try? c.decodeIfPresent(String.self, forKey: .source)).flatMap { $0 }),
                  transport: McpTransport(lenient: (try? c.decodeIfPresent(String.self, forKey: .transport)).flatMap { $0 }),
                  toolCount: try? c.decodeIfPresent(Int.self, forKey: .toolCount),
                  tools: (try? c.decodeIfPresent([String].self, forKey: .tools)).flatMap { $0 } ?? [],
                  error: try? c.decodeIfPresent(String.self, forKey: .error),
                  serverName: (try? info?.decodeIfPresent(String.self, forKey: .name)).flatMap { $0 },
                  serverVersion: (try? info?.decodeIfPresent(String.self, forKey: .version)).flatMap { $0 },
                  config: (try? c.decodeIfPresent(McpConfigSummary.self, forKey: .config)).flatMap { $0 },
                  disabledByUser: (try? c.decodeIfPresent(Bool.self, forKey: .disabledByUser)).flatMap { $0 } ?? false,
                  sessionAdded: (try? c.decodeIfPresent(Bool.self, forKey: .sessionAdded)).flatMap { $0 } ?? false)
        decodeOriginFields(from: decoder)   // wave4d w4d-config (§42.3)
    }
}

/// `mcp_add.config`.
public enum McpAddConfig: Sendable, Equatable, Encodable {
    case stdio(command: String, args: [String] = [], env: [String: String] = [:])
    /// `sse` = true for the legacy SSE transport, else streamable HTTP.
    case remote(sse: Bool, url: String, headers: [String: String] = [:])

    private enum CodingKeys: String, CodingKey { case type, command, args, env, url, headers }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .stdio(command, args, env):
            try c.encode("stdio", forKey: .type)
            try c.encode(command, forKey: .command)
            if !args.isEmpty { try c.encode(args, forKey: .args) }
            if !env.isEmpty { try c.encode(env, forKey: .env) }
        case let .remote(sse, url, headers):
            try c.encode(sse ? "sse" : "http", forKey: .type)
            try c.encode(url, forKey: .url)
            if !headers.isEmpty { try c.encode(headers, forKey: .headers) }
        }
    }
}
