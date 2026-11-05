import Foundation

// wave1 mac-perms — docs/PROTOCOL.md §33 on the wire: the permission queue with attribution (§33.1), the reason a call
// is on a card (§33.3 / §33.4), the "always allow" candidates (§33.6), `permission_rules` (§33.8) and the peer turn (§29)
// the permission card names. Every new field is optional and decoded leniently: an unknown value or a missing key never
// fails the snapshot (an unknown `reason.code` is kept as `.other` and the card shows the engine's `message`).

// MARK: - Attribution and reason

/// §33.1: the subagent whose tool call raised a permission request (absent for the main agent). `agentToolUseId`
/// matches `state.hud.agents[].toolUseId`; the engine leaves the rest out when it has not seen the agent.
public struct PermissionAgent: Codable, Sendable, Equatable, Hashable {
    /// The SDK's agent id (= the subagent's task id).
    public var agentId: String
    /// The Agent / Task tool_use that spawned it (`AgentNode.toolUseId`).
    public var agentToolUseId: String?
    /// Its `subagent_type` ("executor", "test-engineer", …).
    public var subagentType: String?
    public var description: String?

    public init(agentId: String, agentToolUseId: String? = nil, subagentType: String? = nil, description: String? = nil) {
        self.agentId = agentId
        self.agentToolUseId = agentToolUseId
        self.subagentType = subagentType
        self.description = description
    }

    private enum CodingKeys: String, CodingKey { case agentId, agentToolUseId, subagentType, description }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(agentId: (try? c.decodeIfPresent(String.self, forKey: .agentId)) ?? "",
                  agentToolUseId: try? c.decodeIfPresent(String.self, forKey: .agentToolUseId),
                  subagentType: try? c.decodeIfPresent(String.self, forKey: .subagentType),
                  description: try? c.decodeIfPresent(String.self, forKey: .description))
    }
}

/// §33.3 / §33.4: why ReviewGate put a call on a card although it would otherwise run — it works somewhere this
/// window's review does not see. Clients localize on `code`; `message` is the engine's English fallback.
public struct PermissionReason: Sendable, Equatable, Hashable {
    public enum Code: Sendable, Equatable, Hashable {
        /// An edit tool's target outside the project.
        case outsideProject
        /// Inside a nested repository (submodule, linked worktree, clone) under the project.
        case nestedRepository
        /// Another worktree of the repository (an edit there, or a Bash command running there).
        case otherWorktree
        /// A Bash `git worktree add`.
        case worktreeCommand
        /// The Workflow tool / an isolated agent (with `allowWorktreeIsolation` on).
        case worktreeIsolation
        /// Claude Code's own settings (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`).
        case claudeConfig
        /// §46: a git command that changes the repository (commit, merge, pull, checkout, reset, stash …).
        case gitCommand
        /// A code this client does not know (a newer engine): the card shows the engine's `message`.
        case other(String)

        public init(rawValue: String) {
            switch rawValue {
            case "outside_project": self = .outsideProject
            case "nested_repository": self = .nestedRepository
            case "other_worktree": self = .otherWorktree
            case "worktree_command": self = .worktreeCommand
            case "worktree_isolation": self = .worktreeIsolation
            case "claude_config": self = .claudeConfig
            case "git_command": self = .gitCommand
            default: self = .other(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .outsideProject: "outside_project"
            case .nestedRepository: "nested_repository"
            case .otherWorktree: "other_worktree"
            case .worktreeCommand: "worktree_command"
            case .worktreeIsolation: "worktree_isolation"
            case .claudeConfig: "claude_config"
            case .gitCommand: "git_command"
            case let .other(raw): raw
            }
        }
    }

    public var code: Code
    /// The engine's English text (shown as is for an unknown code).
    public var message: String
    /// The nested repository / worktree root / settings file concerned (absolute, native).
    public var path: String?
    /// §39.4 `worktree_command`: the worktree belongs to another repository — no chat of this window can follow it.
    public var otherRepository = false

    public init(code: Code, message: String = "", path: String? = nil, otherRepository: Bool = false) {
        self.code = code
        self.message = message
        self.path = path
        self.otherRepository = otherRepository
    }
}

extension PermissionReason: Codable {
    private enum CodingKeys: String, CodingKey { case code, message, path, otherRepository }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(code: Code(rawValue: (try? c.decodeIfPresent(String.self, forKey: .code)) ?? ""),
                  message: (try? c.decodeIfPresent(String.self, forKey: .message)) ?? "",
                  path: try? c.decodeIfPresent(String.self, forKey: .path),
                  otherRepository: ((try? c.decodeIfPresent(Bool.self, forKey: .otherRepository)) ?? nil) ?? false)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(code.rawValue, forKey: .code)
        try c.encode(message, forKey: .message)
        try c.encodeIfPresent(path, forKey: .path)
        if otherRepository { try c.encode(true, forKey: .otherRepository) }
    }
}

/// §29: `state.session.peerTurn` — the running review turn is accepted peer messages.
public struct PeerTurnInfo: Codable, Sendable, Equatable {
    public var messageIds: [String]
    /// The names the senders gave (claimed, not verified).
    public var fromNames: [String]

    public init(messageIds: [String] = [], fromNames: [String] = []) {
        self.messageIds = messageIds
        self.fromNames = fromNames
    }

    private enum CodingKeys: String, CodingKey { case messageIds, fromNames }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(messageIds: (try? c.decodeIfPresent([String].self, forKey: .messageIds)) ?? [],
                  fromNames: (try? c.decodeIfPresent([String].self, forKey: .fromNames)) ?? [])
    }
}

// MARK: - PermissionRequest (§33 fields)

extension PermissionRequest {
    /// Every field, §33 ones included.
    public init(requestId: String, toolName: String, input: JSONValue, file: String?, toolUseId: String?,
                agent: PermissionAgent? = nil, reason: PermissionReason? = nil, allowPatterns: [String] = []) {
        self.init(requestId: requestId, toolName: toolName, input: input, file: file)
        self.toolUseId = toolUseId
        self.agent = agent
        self.reason = reason
        self.allowPatterns = allowPatterns
    }

    fileprivate enum WireKeys: String, CodingKey { case requestId, toolName, input, file, toolUseId, agent, reason, allowPatterns }

    /// `requestId` and `toolName` are required (a request without them cannot be answered); everything else is lenient.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: WireKeys.self)
        self.init(requestId: try c.decode(String.self, forKey: .requestId),
                  toolName: try c.decode(String.self, forKey: .toolName),
                  input: (try? c.decodeIfPresent(JSONValue.self, forKey: .input)) ?? .object([:]),
                  file: try? c.decodeIfPresent(String.self, forKey: .file),
                  toolUseId: try? c.decodeIfPresent(String.self, forKey: .toolUseId),
                  agent: try? c.decodeIfPresent(PermissionAgent.self, forKey: .agent),
                  reason: try? c.decodeIfPresent(PermissionReason.self, forKey: .reason),
                  allowPatterns: ((try? c.decodeIfPresent([JSONValue].self, forKey: .allowPatterns)) ?? []).compactMap(\.stringValue))
        // MARK: wave4d w4d-peers — §42.2
        toSession = try? decoder.container(keyedBy: PeerWireKeys.self).decodeIfPresent(PeerSessionInfo.self, forKey: .toSession)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: WireKeys.self)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(toolName, forKey: .toolName)
        try c.encode(input, forKey: .input)
        try c.encodeIfPresent(file, forKey: .file)
        try c.encodeIfPresent(toolUseId, forKey: .toolUseId)
        try c.encodeIfPresent(agent, forKey: .agent)
        try c.encodeIfPresent(reason, forKey: .reason)
        if !allowPatterns.isEmpty { try c.encode(allowPatterns, forKey: .allowPatterns) }
        // MARK: wave4d w4d-peers — §42.2
        var peer = encoder.container(keyedBy: PeerWireKeys.self)
        try peer.encodeIfPresent(toSession, forKey: .toSession)
    }
}

// MARK: - SessionInfo (§33.1 queue, §29 peer turn)

extension SessionInfo {
    private enum PermissionKeys: String, CodingKey { case pendingPermissions, peerTurn }

    /// The open requests the client works with, oldest first: `pendingPermissions`, or — from an engine that sends only
    /// the single slot, or a hand-built state — `pendingPermission` as a one-element queue (answering it brings the
    /// next one into the slot, so the queue still drains first in, first out).
    public var permissionQueue: [PermissionRequest] {
        if !pendingPermissions.isEmpty { return pendingPermissions }
        return pendingPermission.map { [$0] } ?? []
    }

    /// Sets the queue and keeps the single slot (`pendingPermission`, read by older code paths) on its first entry.
    mutating func setPermissionQueue(_ queue: [PermissionRequest]) {
        pendingPermissions = queue
        pendingPermission = queue.first
    }

    /// Called at the end of `init(from:)`. Element by element: one request a newer engine shapes differently never
    /// hides the rest; without the key (older engines) the queue is the single slot.
    mutating func decodePermissionFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: PermissionKeys.self) else { return }
        if var list = try? c.nestedUnkeyedContainer(forKey: .pendingPermissions) {
            var out: [PermissionRequest] = []
            while !list.isAtEnd {
                if let item = try? list.decode(PermissionRequest.self) {
                    out.append(item)
                } else if (try? list.decode(JSONValue.self)) == nil {
                    break
                }
            }
            pendingPermissions = out
        } else {
            pendingPermissions = pendingPermission.map { [$0] } ?? []
        }
        peerTurn = (try? c.decodeIfPresent(PeerTurnInfo.self, forKey: .peerTurn)).flatMap { $0 }
    }
}

// MARK: - permission_rules (§33.8)

/// Where a Claude Code settings file / rule comes from.
public enum PermissionRuleScope: Sendable, Equatable, Hashable {
    case user, project, local
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "user": self = .user
        case "project": self = .project
        case "local": self = .local
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .user: "user"
        case .project: "project"
        case .local: "local"
        case let .other(raw): raw
        }
    }
}

/// §33.8: one Claude Code settings file `permission_rules` read.
public struct PermissionRuleSource: Sendable, Equatable, Hashable, Identifiable {
    public var scope: PermissionRuleScope
    public var path: String
    public var exists: Bool
    /// Why the file could not be read / parsed.
    public var error: String?

    public var id: String { scope.rawValue + "|" + path }

    public init(scope: PermissionRuleScope, path: String, exists: Bool, error: String? = nil) {
        self.scope = scope
        self.path = path
        self.exists = exists
        self.error = error
    }
}

extension PermissionRuleSource: Decodable {
    private enum CodingKeys: String, CodingKey { case scope, path, exists, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(scope: PermissionRuleScope(rawValue: (try? c.decodeIfPresent(String.self, forKey: .scope)) ?? ""),
                  path: (try? c.decodeIfPresent(String.self, forKey: .path)) ?? "",
                  exists: (try? c.decodeIfPresent(Bool.self, forKey: .exists)) ?? false,
                  error: try? c.decodeIfPresent(String.self, forKey: .error))
    }
}

/// §33.8: one `permissions.allow` entry of the user's Claude Code settings and what ReviewGate does with it.
public struct UserPermissionRule: Sendable, Equatable, Hashable, Identifiable {
    public enum Status: Sendable, Equatable, Hashable {
        case applied, ignored
        case other(String)

        public init(rawValue: String) {
            switch rawValue {
            case "applied": self = .applied
            case "ignored": self = .ignored
            default: self = .other(rawValue)
            }
        }
    }

    /// Why a rule is applied / ignored (the 12 kinds of §33.8; `.other` for a newer engine's word).
    public enum Why: Sendable, Equatable, Hashable {
        case nonMutatingTool, readMcpTool, readMcpTools, alreadyAllowed
        case mutatingMcpTool, bash, editTool, sendMessage, unsupported, invalid
        case rulesOff, userSettingsOff
        /// §36.6: a local rule while "Load local settings" is off.
        case localSettingsOff
        case other(String)

        public init(rawValue: String) {
            switch rawValue {
            case "non_mutating_tool": self = .nonMutatingTool
            case "read_mcp_tool": self = .readMcpTool
            case "read_mcp_tools": self = .readMcpTools
            case "already_allowed": self = .alreadyAllowed
            case "mutating_mcp_tool": self = .mutatingMcpTool
            case "bash": self = .bash
            case "edit_tool": self = .editTool
            case "send_message": self = .sendMessage
            case "unsupported": self = .unsupported
            case "invalid": self = .invalid
            case "rules_off": self = .rulesOff
            case "user_settings_off": self = .userSettingsOff
            case "local_settings_off": self = .localSettingsOff
            default: self = .other(rawValue)
            }
        }
    }

    /// As written in the settings file: "mcp__github", "Bash(./gradlew:*)", "WebFetch(domain:docs.spring.io)".
    public var rule: String
    public var source: PermissionRuleScope
    public var status: Status
    public var why: Why
    /// The app allow pattern (§33.6) importing the rule adds; nil = cannot / need not be imported.
    public var importAs: String?

    public var id: String { source.rawValue + "|" + rule }

    public init(rule: String, source: PermissionRuleScope, status: Status, why: Why, importAs: String? = nil) {
        self.rule = rule
        self.source = source
        self.status = status
        self.why = why
        self.importAs = importAs
    }
}

extension UserPermissionRule: Decodable {
    private enum CodingKeys: String, CodingKey { case rule, source, status, why, importAs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let importAs = (try? c.decodeIfPresent(String.self, forKey: .importAs)).flatMap { $0 }
        self.init(rule: try c.decode(String.self, forKey: .rule),
                  source: PermissionRuleScope(rawValue: (try? c.decodeIfPresent(String.self, forKey: .source)) ?? ""),
                  status: Status(rawValue: (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""),
                  why: Why(rawValue: (try? c.decodeIfPresent(String.self, forKey: .why)) ?? ""),
                  importAs: importAs?.isEmpty == true ? nil : importAs)
    }
}

/// §33.8: the reply to `permission_rules`.
public struct PermissionRulesReply: Sendable, Equatable {
    /// The correlation id when it answers a request.
    public var id: String?
    public var sources: [PermissionRuleSource]
    /// User → project → local; user rules skipped because user settings are off come last.
    public var rules: [UserPermissionRule]
    /// `permissions.defaultMode` of the most specific file that sets it.
    public var defaultMode: String?
    /// `defaultMode` is one of the four modes ReviewGate offers (§11).
    public var defaultModeSupported: Bool
    public var applyUserAllowRules: Bool
    public var loadUserSettings: Bool

    public init(id: String? = nil, sources: [PermissionRuleSource] = [], rules: [UserPermissionRule] = [], defaultMode: String? = nil,
                defaultModeSupported: Bool = false, applyUserAllowRules: Bool = true, loadUserSettings: Bool = true) {
        self.id = id
        self.sources = sources
        self.rules = rules
        self.defaultMode = defaultMode
        self.defaultModeSupported = defaultModeSupported
        self.applyUserAllowRules = applyUserAllowRules
        self.loadUserSettings = loadUserSettings
    }

    /// The terminal's default mode when ReviewGate can start in it.
    public var supportedDefaultMode: PermissionMode? {
        guard defaultModeSupported, let raw = defaultMode else { return nil }
        return PermissionMode(rawValue: raw)
    }
}

extension PermissionRulesReply: Decodable {
    private enum CodingKeys: String, CodingKey { case id, sources, rules, defaultMode, defaultModeSupported, applyUserAllowRules, loadUserSettings }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try? c.decodeIfPresent(String.self, forKey: .id),
                  sources: Self.lenientList(PermissionRuleSource.self, c, .sources),
                  rules: Self.lenientList(UserPermissionRule.self, c, .rules),
                  defaultMode: (try? c.decodeIfPresent(String.self, forKey: .defaultMode)).flatMap { $0 },
                  defaultModeSupported: (try? c.decodeIfPresent(Bool.self, forKey: .defaultModeSupported)).flatMap { $0 } ?? false,
                  applyUserAllowRules: (try? c.decodeIfPresent(Bool.self, forKey: .applyUserAllowRules)).flatMap { $0 } ?? true,
                  loadUserSettings: (try? c.decodeIfPresent(Bool.self, forKey: .loadUserSettings)).flatMap { $0 } ?? true)
    }

    private static func lenientList<T: Decodable>(_ type: T.Type, _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
        guard var list = try? c.nestedUnkeyedContainer(forKey: key) else { return [] }
        var out: [T] = []
        while !list.isAtEnd {
            if let item = try? list.decode(T.self) { out.append(item) } else if (try? list.decode(JSONValue.self)) == nil { break }
        }
        return out
    }
}
