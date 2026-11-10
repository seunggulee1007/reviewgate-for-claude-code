import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.5–36.9 on the wire (TypeScript: the §36 block of engine/src/protocol.ts): the slash commands with
// their descriptions (`capabilities.commands` / `state`), what the local settings hold that the session leaves out
// (`extensions.notApplied`), what a starting CLI waits for (`session.extensionsWaitingOn`), the CLI version (`session.cli`,
// `cli_versions`, the `cli_version_changed` notice) and the user's other Claude sessions (`cli_sessions`,
// `cli_session_import`, `SessionMeta.imported`). Every field is optional and read leniently: an engine before §36 sends
// none of them and the screens behave as before.

// MARK: - §36.5 Slash commands

/// Where a slash command comes from (the palette's groups); an unknown value reads as `.unknown`.
public enum SlashCommandSource: String, Codable, Sendable, Hashable, CaseIterable {
    case builtin, user, project, plugin, mcp, unknown

    public init(lenient raw: String?) { self = raw.flatMap(Self.init(rawValue:)) ?? .unknown }

    public init(from decoder: Decoder) throws {
        self.init(lenient: try? decoder.singleValueContainer().decode(String.self))
    }
}

/// One entry of `capabilities.commands`: the SDK's `SlashCommand` plus where it comes from.
public struct SlashCommandInfo: Codable, Sendable, Hashable, Identifiable {
    /// Without the leading slash (`writer-kit:writer-deck`).
    public var name: String
    public var description: String
    /// "" when the command takes no argument.
    public var argumentHint: String
    public var source: SlashCommandSource
    /// `plugin`: the plugin's name.
    public var plugin: String?
    /// `mcp`: the server's name.
    public var server: String?
    public var aliases: [String]

    public var id: String { name }

    public init(name: String, description: String = "", argumentHint: String = "", source: SlashCommandSource = .unknown,
                plugin: String? = nil, server: String? = nil, aliases: [String] = []) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.source = source
        self.plugin = plugin
        self.server = server
        self.aliases = aliases
    }

    private enum CodingKeys: String, CodingKey { case name, description, argumentHint, source, plugin, server, aliases }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var name = try c.decode(String.self, forKey: .name).trimmingCharacters(in: .whitespaces)
        if name.hasPrefix("/") { name.removeFirst() }
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "A slash command without a name")
        }
        self.init(name: name,
                  description: lenientValue(String.self, c, .description) ?? "",
                  argumentHint: lenientValue(String.self, c, .argumentHint) ?? "",
                  source: SlashCommandSource(lenient: lenientValue(String.self, c, .source)),
                  plugin: lenientValue(String.self, c, .plugin).flatMap { $0.isEmpty ? nil : $0 },
                  server: lenientValue(String.self, c, .server).flatMap { $0.isEmpty ? nil : $0 },
                  aliases: lenientValue([String].self, c, .aliases) ?? [])
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(description, forKey: .description)
        try c.encode(argumentHint, forKey: .argumentHint)
        try c.encode(source, forKey: .source)
        try c.encodeIfPresent(plugin, forKey: .plugin)
        try c.encodeIfPresent(server, forKey: .server)
        if !aliases.isEmpty { try c.encode(aliases, forKey: .aliases) }
    }
}

/// `capabilities.state`: `starting` until the CLI answered initialize (the lists are cached or empty meanwhile).
public enum CapabilitiesState: String, Codable, Sendable { case starting, ready }

extension SessionCapabilities {
    private enum CommandKeys: String, CodingKey { case commands, state }

    /// Called at the end of `init(from:)`: one command a newer engine shapes differently never hides the rest; an unknown
    /// `state` reads as absent (= ready).
    mutating func decodeCommandFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: CommandKeys.self) else { return }
        commands = lenientElements(SlashCommandInfo.self, c, .commands)
        state = lenientValue(String.self, c, .state).flatMap(CapabilitiesState.init(rawValue:))
    }

    /// The wire / cache form of the two fields (only when set, so older caches stay as they were).
    func encodeCommandFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CommandKeys.self)
        if !commands.isEmpty { try c.encode(commands, forKey: .commands) }
        try c.encodeIfPresent(state, forKey: .state)
    }

    /// The CLI has not answered initialize yet (absent = ready).
    public var isStarting: Bool { state == .starting }
}

// MARK: - §36.6 Local settings

/// `extensions.notApplied`: what `.claude/settings.local.json` and the local-scope MCP servers hold that the running
/// session does not apply (local settings off, or the §16 fallback). Names, commands and counts only — never a value.
public struct NotAppliedLocalSettings: Codable, Sendable, Equatable {
    public struct Hook: Codable, Sendable, Hashable {
        public var event: String
        /// ≤ 200 chars.
        public var command: String

        public init(event: String, command: String) {
            self.event = event
            self.command = command
        }

        private enum CodingKeys: String, CodingKey { case event, command }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let event = lenientValue(String.self, c, .event) ?? "", command = lenientValue(String.self, c, .command) ?? ""
            guard !(event.isEmpty && command.isEmpty) else {
                throw DecodingError.dataCorruptedError(forKey: .event, in: c, debugDescription: "A hook without event and command")
            }
            self.init(event: event, command: command)
        }
    }

    public var hooks: [Hook]
    public var envKeys: [String]
    public var mcpServers: [String]
    public var allowRuleCount: Int

    public init(hooks: [Hook] = [], envKeys: [String] = [], mcpServers: [String] = [], allowRuleCount: Int = 0) {
        self.hooks = hooks
        self.envKeys = envKeys
        self.mcpServers = mcpServers
        self.allowRuleCount = allowRuleCount
    }

    /// Nothing worth a line (the engine sends null then; a hand-built or odd value may still be empty).
    public var isEmpty: Bool { hooks.isEmpty && envKeys.isEmpty && mcpServers.isEmpty && allowRuleCount == 0 }

    private enum CodingKeys: String, CodingKey { case hooks, envKeys, mcpServers, allowRuleCount }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(hooks: lenientElements(Hook.self, c, .hooks),
                  envKeys: lenientValue([String].self, c, .envKeys) ?? [],
                  mcpServers: lenientValue([String].self, c, .mcpServers) ?? [],
                  allowRuleCount: max(0, lenientValue(Int.self, c, .allowRuleCount) ?? 0))
    }
}

extension SessionExtensions {
    private enum LocalKeys: String, CodingKey { case notApplied }

    /// Called at the end of `init(from:)`.
    mutating func decodeLocalFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: LocalKeys.self) else { return }
        notApplied = lenientValue(NotAppliedLocalSettings.self, c, .notApplied).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// `.claude/settings.local.json` and the local-scope MCP servers took part (`settingSources` has `local`).
    public var loadsLocalSettings: Bool { settingSources.contains("local") }
}

// MARK: - §36.7 Extensions start

/// `session.extensionsWaitingOn`: the latest progress signal of a starting CLI — a hook, an MCP server, a plugin.
public struct ExtensionsWaitingOn: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case hook, mcp, plugin, unknown }

    public var kind: Kind
    /// A hook's name or event, the MCP server, the plugin being installed; nil when the signal named none.
    public var name: String?

    public init(kind: Kind, name: String?) {
        self.kind = kind
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case kind, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = lenientValue(String.self, c, .name)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(kind: lenientValue(String.self, c, .kind).flatMap(Kind.init(rawValue:)) ?? .unknown,
                  name: name?.isEmpty == false ? name : nil)
    }
}

// MARK: - §36.8 CLI version

/// The CLI versions ReviewGate verified (inclusive).
public struct CliVersionRange: Codable, Sendable, Equatable {
    public var min: String
    public var max: String

    public init(min: String, max: String) {
        self.min = min
        self.max = max
    }
}

/// `session.cli.previous`: the version used before this one; `path` while it is still installed (pinnable).
public struct CliPreviousVersion: Codable, Sendable, Equatable {
    public var version: String
    public var path: String?

    public init(version: String, path: String? = nil) {
        self.version = version
        self.path = path
    }

    private enum CodingKeys: String, CodingKey { case version, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(version: try c.decode(String.self, forKey: .version),
                  path: lenientValue(String.self, c, .path).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// `session.cli`: the CLI this session runs and whether ReviewGate verified it.
public struct CliInfo: Codable, Sendable, Equatable {
    /// What the running CLI reports; nil until known.
    public var version: String?
    public var verified: Bool
    public var verifiedRange: CliVersionRange?
    public var previous: CliPreviousVersion?

    public init(version: String?, verified: Bool, verifiedRange: CliVersionRange? = nil, previous: CliPreviousVersion? = nil) {
        self.version = version
        self.verified = verified
        self.verifiedRange = verifiedRange
        self.previous = previous
    }

    /// A known version outside the verified range: the "not verified yet" banner.
    public var isUnverified: Bool { (version.map { !$0.isEmpty } ?? false) && !verified }

    private enum CodingKeys: String, CodingKey { case version, verified, verifiedRange, previous }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(version: lenientValue(String.self, c, .version).flatMap { $0.isEmpty ? nil : $0 },
                  // Unknown is treated as verified: no banner on a value we cannot read.
                  verified: lenientValue(Bool.self, c, .verified) ?? true,
                  verifiedRange: lenientValue(CliVersionRange.self, c, .verifiedRange),
                  previous: lenientValue(CliPreviousVersion.self, c, .previous))
    }
}

/// `error{code: "cli_version_changed"}.cli`: the notice sent once when the version differs from the last one seen.
public struct CliVersionChange: Codable, Sendable, Equatable {
    public var from: String?
    public var to: String
    public var verified: Bool

    public init(from: String?, to: String, verified: Bool) {
        self.from = from
        self.to = to
        self.verified = verified
    }

    private enum CodingKeys: String, CodingKey { case from, to, verified }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(from: lenientValue(String.self, c, .from).flatMap { $0.isEmpty ? nil : $0 },
                  to: try c.decode(String.self, forKey: .to),
                  verified: lenientValue(Bool.self, c, .verified) ?? true)
    }
}

/// One installed version (`~/.local/share/claude/versions/<ver>`).
public struct CliVersionEntry: Codable, Sendable, Equatable, Identifiable {
    public var version: String
    public var path: String
    public var verified: Bool

    public var id: String { path }

    public init(version: String, path: String, verified: Bool) {
        self.version = version
        self.path = path
        self.verified = verified
    }

    private enum CodingKeys: String, CodingKey { case version, path, verified }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let path = try c.decode(String.self, forKey: .path)
        guard !path.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .path, in: c, debugDescription: "No path") }
        self.init(version: lenientValue(String.self, c, .version) ?? (path as NSString).lastPathComponent,
                  path: path,
                  verified: lenientValue(Bool.self, c, .verified) ?? false)
    }
}

/// Reply to `cli_versions`: newest first; `pinnedPath` = `settings.claudePath` when set.
public struct CliVersionsReply: Decodable, Sendable, Equatable {
    public var id: String?
    public var versions: [CliVersionEntry]
    public var current: String?
    public var pinnedPath: String?

    public init(id: String? = nil, versions: [CliVersionEntry], current: String?, pinnedPath: String?) {
        self.id = id
        self.versions = versions
        self.current = current
        self.pinnedPath = pinnedPath
    }

    private enum CodingKeys: String, CodingKey { case id, versions, current, pinnedPath }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  versions: lenientElements(CliVersionEntry.self, c, .versions),
                  current: lenientValue(String.self, c, .current).flatMap { $0.isEmpty ? nil : $0 },
                  pinnedPath: lenientValue(String.self, c, .pinnedPath).flatMap { $0.isEmpty ? nil : $0 })
    }
}

extension SessionInfo {
    private enum SessionToolsKeys: String, CodingKey { case cli, extensionsWaitingOn, capabilitiesCached }

    /// Called at the end of `init(from:)`.
    mutating func decodeSessionToolsFields(from decoder: Decoder) {
        guard let c = try? decoder.container(keyedBy: SessionToolsKeys.self) else { return }
        cli = lenientValue(CliInfo.self, c, .cli)
        extensionsWaitingOn = lenientValue(ExtensionsWaitingOn.self, c, .extensionsWaitingOn)
        capabilitiesCached = lenientValue(Bool.self, c, .capabilitiesCached) ?? false
    }
}

// MARK: - §36.9 Other Claude sessions

/// A running Claude process's state as its registry entry says (`waiting` = waiting for the user's input).
public enum CliSessionStatus: String, Codable, Sendable, Hashable { case idle, busy, waiting, unknown }

/// Another live Claude process in this repository or one of its worktrees.
public struct CliRunningSession: Codable, Sendable, Equatable, Identifiable {
    public var pid: Int
    public var sessionId: String?
    public var name: String?
    public var cwd: String
    public var status: CliSessionStatus
    /// `cli` (a terminal), `sdk-ts` / `sdk-cli` (an app or a script), …
    public var entrypoint: String?
    /// Its cwd is inside this window's worktree.
    public var sameWorktree: Bool

    public var id: Int { pid }

    public init(pid: Int, sessionId: String? = nil, name: String? = nil, cwd: String, status: CliSessionStatus = .unknown,
                entrypoint: String? = nil, sameWorktree: Bool = false) {
        self.pid = pid
        self.sessionId = sessionId
        self.name = name
        self.cwd = cwd
        self.status = status
        self.entrypoint = entrypoint
        self.sameWorktree = sameWorktree
    }

    /// A terminal (`cli`) rather than an app or a script.
    public var isTerminal: Bool { entrypoint == nil || entrypoint == "cli" }

    private enum CodingKeys: String, CodingKey { case pid, sessionId, name, cwd, status, entrypoint, sameWorktree }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = lenientValue(String.self, c, .name)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(pid: try c.decode(Int.self, forKey: .pid),
                  sessionId: lenientValue(String.self, c, .sessionId).flatMap { $0.isEmpty ? nil : $0 },
                  name: name?.isEmpty == false ? name : nil,
                  cwd: lenientValue(String.self, c, .cwd) ?? "",
                  status: lenientValue(String.self, c, .status).flatMap(CliSessionStatus.init(rawValue:)) ?? .unknown,
                  entrypoint: lenientValue(String.self, c, .entrypoint).flatMap { $0.isEmpty ? nil : $0 },
                  sameWorktree: lenientValue(Bool.self, c, .sameWorktree) ?? false)
    }
}

/// A CLI conversation of this repository that can be resumed here (SDK `listSessions`).
public struct CliResumableSession: Codable, Sendable, Equatable, Identifiable {
    public var sessionId: String
    /// Custom title, else the CLI's summary / first prompt (≤ 120 chars).
    public var title: String
    /// ISO-8601.
    public var updatedAt: String
    public var cwd: String?

    public var id: String { sessionId }

    public init(sessionId: String, title: String, updatedAt: String = "", cwd: String? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.updatedAt = updatedAt
        self.cwd = cwd
    }

    public var updatedDate: Date? {
        if let d = try? Date(updatedAt, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(updatedAt, strategy: Date.ISO8601FormatStyle())
    }

    private enum CodingKeys: String, CodingKey { case sessionId, title, updatedAt, cwd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .sessionId)
        guard !id.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .sessionId, in: c, debugDescription: "No id") }
        self.init(sessionId: id,
                  title: lenientValue(String.self, c, .title) ?? "",
                  updatedAt: lenientValue(String.self, c, .updatedAt) ?? "",
                  cwd: lenientValue(String.self, c, .cwd).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// Reply to `cli_sessions`.
public struct CliSessionsReply: Decodable, Sendable, Equatable {
    public var id: String?
    public var running: [CliRunningSession]
    public var resumable: [CliResumableSession]

    public init(id: String? = nil, running: [CliRunningSession], resumable: [CliResumableSession]) {
        self.id = id
        self.running = running
        self.resumable = resumable
    }

    private enum CodingKeys: String, CodingKey { case id, running, resumable }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: lenientValue(String.self, c, .id),
                  running: lenientElements(CliRunningSession.self, c, .running),
                  resumable: lenientElements(CliResumableSession.self, c, .resumable))
        // MARK: wave4d w4d-peers — §42.2
        selfSession = try? decoder.container(keyedBy: PeerWireKeys.self).decodeIfPresent(PeerSelf.self, forKey: .selfSession)
    }

    // MARK: wave4d w4d-peers
    /// §42.2: this window's own session as the user's other sessions see it (`self`); nil from older engines.
    public var selfSession: PeerSelf?
}

/// `SessionMeta.imported`: made by `cli_session_import` from a terminal session — the review gate applies from `at` on.
public struct ImportedSession: Codable, Sendable, Hashable {
    /// ISO-8601 of the import.
    public var at: String
    /// The folder the terminal session ran in.
    public var cwd: String?

    public init(at: String, cwd: String? = nil) {
        self.at = at
        self.cwd = cwd
    }

    private enum CodingKeys: String, CodingKey { case at, cwd }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(at: lenientValue(String.self, c, .at) ?? "", cwd: lenientValue(String.self, c, .cwd).flatMap { $0.isEmpty ? nil : $0 })
    }

    public var date: Date? {
        if let d = try? Date(at, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(at, strategy: Date.ISO8601FormatStyle())
    }
}
