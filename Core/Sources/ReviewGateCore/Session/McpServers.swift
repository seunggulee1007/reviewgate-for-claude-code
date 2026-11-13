import Foundation
import Observation

// docs/PROTOCOL.md §22: the MCP servers of the live session — status, reconnect / on-off / remove / login, and adding
// one (this session, the project's .mcp.json or the user's ~/.claude.json).

/// The live MCP server list (`mcp_status`) and the actions on it. Owned by `AppState` (`store.mcp`).
@MainActor
@Observable
public final class McpStore {
    public private(set) var servers: [McpServerInfo] = []
    /// A project / user server was added or removed: the running session picks it up after a restart.
    public private(set) var restartRequired = false
    /// An `mcp_status` arrived for this project (else the views fall back to `extensions.mcpServers`).
    public private(set) var loaded = false
    /// Names with an action in flight.
    public private(set) var busy: Set<String> = []
    /// The last failed action, in the user's words.
    public private(set) var errorText: String?
    /// The server that reported `needs-auth` (`mcp_auth_required`), until it connects or the user dismisses it.
    public private(set) var authRequiredServer: String?
    /// False once the engine answered `unknown_command` / `mcp_unsupported`.
    public private(set) var isSupported = true
    /// A config file the user opened from here changed on disk (see `configOpened`): the running session reads it at its next start.
    public private(set) var configEdited = false
    @ObservationIgnored private var openedConfigs: [String: Date?] = [:]
    @ObservationIgnored weak var app: AppState?

    public init() {}

    func attach(_ app: AppState) { self.app = app }

    /// Servers that need the user (failed / needs-auth) — the composer caption's warning dot.
    public var attentionServers: [McpServerInfo] { servers.filter(\.needsAttention) }

    public func server(_ name: String) -> McpServerInfo? { servers.first { $0.name == name } }

    // MARK: Commands

    public func refresh() async { await run(.mcpStatus, name: nil) }

    public func reconnect(_ name: String) async { await run(.mcpReconnect(name: name), name: name) }

    public func setEnabled(_ name: String, enabled: Bool) async { await run(.mcpToggle(name: name, enabled: enabled), name: name) }

    /// Removes a server from where it came from; servers from plugins / claude.ai / managed settings cannot be removed here.
    /// MARK: wave4d w4d-config — §42.3: a parent folder's `.mcp.json` names the file the user confirmed; the engine's origin
    /// decides what can be removed.
    public func remove(_ server: McpServerInfo) async {
        guard let scope = server.removeScope else { return }
        if scope == .project, server.isFromParentFolder, let file = server.origin?.file {
            await run(.mcpRemoveFile(name: server.name, scope: scope, file: file), name: server.name)
        } else {
            await run(.mcpRemove(name: server.name, scope: scope), name: server.name)
        }
    }

    // MARK: wave4d w4d-config
    /// §42.3: the engine keeps a choice for every worktree of the repository (it reports where servers live with it).
    public var supportsRepositoryToggle: Bool { servers.contains { $0.origin != nil } }

    /// §42.3: on / off for every worktree of this repository, or (`repository` false) for this worktree as before.
    public func setEnabled(_ name: String, enabled: Bool, repository: Bool) async {
        let command: EngineCommand = repository ? .mcpToggleScoped(name: name, enabled: enabled, repository: true) : .mcpToggle(name: name, enabled: enabled)
        await run(command, name: name)
    }

    /// Adds a server; returns nil on success, else the refusal in the user's words.
    public func add(name: String, scope: McpScope, config: McpAddConfig) async -> String? {
        await run(.mcpAdd(name: name, scope: scope, config: config), name: name)
        return errorText
    }

    /// Opens a terminal with `claude /mcp` where the user logs in to the server.
    public func login(_ name: String) async {
        guard let app else { return }
        errorText = nil
        do {
            _ = try await app.reply(.mcpAuth(name: name))
        } catch {
            errorText = message(error)
        }
    }

    public func dismissError() { errorText = nil }
    public func dismissAuthRequired() { authRequiredServer = nil }

    // MARK: Config files

    /// The restart banner: the engine's own flag, or a config file the user edited after opening it here.
    public var needsRestart: Bool { restartRequired || configEdited }

    /// The user opened `path` from here: remember its modification time, so `checkConfigEdited` can tell a save.
    public func configOpened(_ path: String) { openedConfigs[path] = .some(McpConfigFile.modified(path)) }

    /// Compares the opened files' modification times (the app came back to the front). True when one was saved since.
    @discardableResult
    public func checkConfigEdited() -> Bool {
        var changed = false
        for (path, before) in openedConfigs where McpConfigFile.modified(path) != before {
            openedConfigs[path] = .some(McpConfigFile.modified(path))
            changed = true
        }
        if changed { configEdited = true }
        return changed
    }

    /// The session restarted (or was asked to): what was edited is read now.
    public func configRestarted() { configEdited = false }

    /// A failure of an action outside the engine (the file to open is gone), in the user's words.
    public func report(_ text: String) { errorText = text }

    // MARK: Events

    func apply(servers list: [McpServerInfo], restartRequired: Bool) {
        servers = list
        self.restartRequired = restartRequired
        loaded = true
        if let pending = authRequiredServer, let s = list.first(where: { $0.name == pending }), s.status != .needsAuth {
            authRequiredServer = nil
        }
    }

    func authRequired(_ server: String?) {
        authRequiredServer = server ?? authRequiredServer ?? ""
    }

    func reset() {
        servers = []
        restartRequired = false
        configEdited = false
        openedConfigs = [:]
        loaded = false
        busy = []
        errorText = nil
        authRequiredServer = nil
    }

    private func run(_ command: EngineCommand, name: String?) async {
        guard let app else { return }
        if let name { busy.insert(name) }
        defer { if let name { busy.remove(name) } }
        errorText = nil
        do {
            let reply = try await app.reply(command)
            if case let .mcpStatus(_, list, restart) = reply { apply(servers: list, restartRequired: restart) }
        } catch {
            if let code = (error as? EngineClientError)?.refusalCode {
                // An engine without §22: the MCP actions hide.
                if code == "unknown_command" { isSupported = false; return }
                // `no_session` on a refresh: nothing to show yet — not a failure of something the user did.
                if code == "no_session", name == nil { return }
            }
            errorText = message(error)
        }
    }

    private func message(_ error: Error) -> String {
        (error as? EngineClientError)?.userMessage ?? error.localizedDescription
    }
}

// MARK: - Add form

/// The "Add server" sheet's fields and their validation (the engine checks the same rules, §22).
public struct McpAddForm: Sendable, Equatable {
    public enum Transport: String, Sendable, Equatable, CaseIterable, Identifiable {
        case stdio, http, sse
        public var id: String { rawValue }
    }

    public struct Pair: Sendable, Equatable, Identifiable {
        public var id = UUID()
        public var key: String
        public var value: String

        public init(key: String = "", value: String = "") {
            self.key = key
            self.value = value
        }
    }

    public enum Issue: Sendable, Equatable {
        case name, duplicateName, command, commandStartsWithDash, tooManyArgs, envKey(String), url, headerName(String), controlCharacters

        public var message: String {
            switch self {
            case .name: String(localized: "Use letters, digits, “-”, “_” and “.” (at most 64, starting with a letter or digit)", bundle: .module)
            case .duplicateName: String(localized: "A server with this name already exists", bundle: .module)
            case .command: String(localized: "Enter the command that starts the server", bundle: .module)
            case .commandStartsWithDash: String(localized: "The command cannot start with “-”", bundle: .module)
            case .tooManyArgs: String(localized: "At most 100 arguments", bundle: .module)
            case let .envKey(key): String(localized: "Not a valid variable name: \(key)", bundle: .module)
            case .url: String(localized: "Enter an http:// or https:// URL", bundle: .module)
            case let .headerName(key): String(localized: "Not a valid header name: \(key)", bundle: .module)
            case .controlCharacters: String(localized: "Line breaks and control characters are not allowed", bundle: .module)
            }
        }
    }

    public var name = ""
    public var scope: McpScope = .session
    public var transport: Transport = .stdio
    public var command = ""
    public var args: [String] = []
    public var env: [Pair] = []
    public var url = ""
    public var headers: [Pair] = []

    public init() {}

    public static func isValidName(_ name: String) -> Bool {
        name.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"#, options: .regularExpression) != nil
    }

    static func isEnvKey(_ key: String) -> Bool {
        key.range(of: #"^[A-Za-z_][A-Za-z0-9_]*$"#, options: .regularExpression) != nil
    }

    /// RFC 7230 token characters.
    static func isHeaderName(_ key: String) -> Bool {
        key.range(of: #"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$"#, options: .regularExpression) != nil
    }

    static func hasControl(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0 == "\r" || $0 == "\n" || $0.value == 0 }
    }

    private var cleanArgs: [String] { args.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var cleanEnv: [Pair] { env.filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty } }
    private var cleanHeaders: [Pair] { headers.filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty } }

    /// Every problem, in field order; empty = ready to add.
    public func issues(existingNames: [String] = []) -> [Issue] {
        var out: [Issue] = []
        let n = name.trimmingCharacters(in: .whitespaces)
        if !Self.isValidName(n) { out.append(.name) } else if existingNames.contains(n) { out.append(.duplicateName) }
        var strings: [String] = [n]
        switch transport {
        case .stdio:
            let cmd = command.trimmingCharacters(in: .whitespaces)
            if cmd.isEmpty { out.append(.command) } else if cmd.hasPrefix("-") { out.append(.commandStartsWithDash) }
            if cleanArgs.count > 100 { out.append(.tooManyArgs) }
            for pair in cleanEnv where !Self.isEnvKey(pair.key.trimmingCharacters(in: .whitespaces)) {
                out.append(.envKey(pair.key))
            }
            strings += [cmd] + cleanArgs + cleanEnv.flatMap { [$0.key, $0.value] }
        case .http, .sse:
            let u = url.trimmingCharacters(in: .whitespaces)
            if let parsed = URL(string: u), let scheme = parsed.scheme?.lowercased(), scheme == "http" || scheme == "https", parsed.host != nil {
            } else {
                out.append(.url)
            }
            for pair in cleanHeaders where !Self.isHeaderName(pair.key.trimmingCharacters(in: .whitespaces)) {
                out.append(.headerName(pair.key))
            }
            strings += [u] + cleanHeaders.flatMap { [$0.key, $0.value] }
        }
        if strings.contains(where: Self.hasControl) { out.append(.controlCharacters) }
        return out
    }

    public func isValid(existingNames: [String] = []) -> Bool { issues(existingNames: existingNames).isEmpty }

    /// The trimmed name the command takes.
    public var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    /// The wire config; nil while the form is invalid.
    public var config: McpAddConfig? {
        guard isValid() else { return nil }
        switch transport {
        case .stdio:
            var envMap: [String: String] = [:]
            for pair in cleanEnv { envMap[pair.key.trimmingCharacters(in: .whitespaces)] = pair.value }
            return .stdio(command: command.trimmingCharacters(in: .whitespaces), args: cleanArgs, env: envMap)
        case .http, .sse:
            var headerMap: [String: String] = [:]
            for pair in cleanHeaders { headerMap[pair.key.trimmingCharacters(in: .whitespaces)] = pair.value }
            return .remote(sse: transport == .sse, url: url.trimmingCharacters(in: .whitespaces), headers: headerMap)
        }
    }

    /// Splits a pasted command line (`npx -y @x/server --flag "a b"`) into the command and its arguments.
    public static func splitCommandLine(_ line: String) -> [String] {
        var out: [String] = []
        var current = ""
        var quote: Character?
        var hasToken = false
        for ch in line {
            if let q = quote {
                if ch == q { quote = nil } else { current.append(ch) }
            } else if ch == "\"" || ch == "'" {
                quote = ch
                hasToken = true
            } else if ch == " " || ch == "\t" {
                if hasToken { out.append(current); current = ""; hasToken = false }
            } else {
                current.append(ch)
                hasToken = true
            }
        }
        if hasToken { out.append(current) }
        return out
    }
}

/// Words for the MCP list.
public enum McpText {
    public static func status(_ status: McpServerStatus) -> String {
        switch status {
        case .connected: String(localized: "Connected", bundle: .module)
        case .failed: String(localized: "Failed", bundle: .module)
        case .needsAuth: String(localized: "Needs login", bundle: .module)
        case .pending: String(localized: "Connecting…", bundle: .module)
        case .disabled: String(localized: "Off", bundle: .module)
        case .unknown: String(localized: "Unknown", bundle: .module)
        }
    }

    public static func source(_ source: McpSource) -> String {
        switch source {
        case .user: String(localized: "User", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case .local: String(localized: "Local", bundle: .module)
        case .plugin: String(localized: "Plugin", bundle: .module)
        case .claudeAI: "claude.ai"
        case .managed: String(localized: "Managed", bundle: .module)
        case .session: String(localized: "This session", bundle: .module)
        case .unknown: String(localized: "Other", bundle: .module)
        }
    }

    public static func transport(_ transport: McpTransport) -> String {
        switch transport {
        case .stdio: "stdio"
        case .http: "HTTP"
        case .sse: "SSE"
        case .sdk: "SDK"
        case .claudeAIProxy: "claude.ai"
        case .unknown: "—"
        }
    }

    public static func scopeTitle(_ scope: McpScope) -> String {
        switch scope {
        case .session: String(localized: "This session only", bundle: .module)
        case .local: String(localized: "Local (this project, only me)", bundle: .module)   // wave3 mac-session (§36.6)
        case .project: String(localized: "Project (.mcp.json)", bundle: .module)
        case .user: String(localized: "User (~/.claude.json)", bundle: .module)
        }
    }

    public static func scopeExplanation(_ scope: McpScope) -> String {
        switch scope {
        case .session: String(localized: "Starts right away for this project's sessions in ReviewGate; nothing is written to disk.", bundle: .module)
        case .local: String(localized: "Written to ~/.claude.json for this project only — not shared through git, also used by claude in the terminal. Applies after a session restart.", bundle: .module)
        case .project: String(localized: "Written to .mcp.json in the project — shared with everyone through git. Shows as a working-tree change; applies after a session restart.", bundle: .module)
        case .user: String(localized: "Written to ~/.claude.json — available in all your projects. Applies after a session restart.", bundle: .module)
        }
    }

    /// Where a remove deletes the server from (for the confirmation).
    public static func removeExplanation(_ server: McpServerInfo) -> String {
        // MARK: wave4d w4d-config — §42.3: a parent folder's file, or why it cannot be removed where it is defined.
        if let parent = McpOriginText.removeExplanation(server) { return parent }
        if let reason = McpOriginText.notRemovable(server) { return reason }
        return switch server.source.removableScope {
        case .session: String(localized: "Removes “\(server.name)” from this session.", bundle: .module)
        case .local: String(localized: "Removes “\(server.name)” from this project's entry in ~/.claude.json — only for you.", bundle: .module)
        case .project: String(localized: "Removes “\(server.name)” from the project's .mcp.json — a change everyone gets through git.", bundle: .module)
        case .user: String(localized: "Removes “\(server.name)” from ~/.claude.json — for all your projects.", bundle: .module)
        case nil: String(localized: "This server comes from \(source(server.source)) and cannot be removed here.", bundle: .module)
        }
    }
}
