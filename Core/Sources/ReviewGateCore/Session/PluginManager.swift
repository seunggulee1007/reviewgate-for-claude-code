import Foundation

// MARK: §72.3 — docs/PROTOCOL.md §72.3: `/plugin` and `/reload-plugins` in a classic chat. The terminal's plugin panel has no
// stream-json form, so the engine runs the CLI's own `claude plugin … --json` commands (`plugins_list`, `plugin_run`) and
// the SDK's reload (`plugins_reload`). The wire, how a typed `/plugin …` maps onto the sheet, the words and the store's
// actions.

/// §72.3 what `plugin_run` asks the CLI to do.
public enum PluginAction: String, Sendable, Equatable, CaseIterable {
    case install, uninstall, enable, disable, update
    case marketplaceAdd = "marketplace_add", marketplaceRemove = "marketplace_remove", marketplaceUpdate = "marketplace_update"

    /// The words of `claude plugin …` it runs ("marketplace add").
    public var cliWords: String { rawValue.replacingOccurrences(of: "_", with: " ") }
    /// Asks first (it installs or deletes something), as the terminal's panel shows a details pane or asks.
    public var confirms: Bool { self == .install || self == .uninstall || self == .marketplaceAdd || self == .marketplaceRemove }
}

/// §72.3 an installed plugin.
public struct PluginInstalled: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var marketplace: String?
    public var version: String
    public var scope: String
    public var enabled: Bool
    public var installPath: String?
    public var projectPath: String?
    public var errors: [String]
    public var notes: [String]
    public var appOff: Bool

    public init(id: String, name: String, marketplace: String?, version: String = "unknown", scope: String = "user", enabled: Bool = true,
                installPath: String? = nil, projectPath: String? = nil, errors: [String] = [], notes: [String] = [], appOff: Bool = false) {
        self.id = id
        self.name = name
        self.marketplace = marketplace
        self.version = version
        self.scope = scope
        self.enabled = enabled
        self.installPath = installPath
        self.projectPath = projectPath
        self.errors = errors
        self.notes = notes
        self.appOff = appOff
    }

    private enum CodingKeys: String, CodingKey { case id, name, marketplace, version, scope, enabled, installPath, projectPath, errors, notes, appOff }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = lenientValue(String.self, c, .name) ?? id
        marketplace = lenientValue(String.self, c, .marketplace)
        version = lenientValue(String.self, c, .version) ?? "unknown"
        scope = lenientValue(String.self, c, .scope) ?? "user"
        enabled = lenientValue(Bool.self, c, .enabled) ?? false
        installPath = lenientValue(String.self, c, .installPath)
        projectPath = lenientValue(String.self, c, .projectPath)
        errors = lenientElements(String.self, c, .errors)
        notes = lenientElements(String.self, c, .notes)
        appOff = lenientValue(Bool.self, c, .appOff) ?? false
    }

    /// Why its switch, Update or Uninstall cannot be used here; nil when they can.
    public var manageBlocker: String? {
        switch scope {
        case "managed": PluginText.managedBlocker
        case "session": PluginText.sessionBlocker
        default: nil
        }
    }
}

/// §72.3 a plugin a marketplace offers that is not installed.
public struct PluginAvailable: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var marketplace: String
    public var description: String?
    public var version: String?
    public var installCount: Int?

    public init(id: String, name: String, marketplace: String, description: String? = nil, version: String? = nil, installCount: Int? = nil) {
        self.id = id
        self.name = name
        self.marketplace = marketplace
        self.description = description
        self.version = version
        self.installCount = installCount
    }

    private enum CodingKeys: String, CodingKey { case id, name, marketplace, description, version, installCount }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = lenientValue(String.self, c, .name) ?? id
        marketplace = lenientValue(String.self, c, .marketplace) ?? ""
        description = lenientValue(String.self, c, .description)
        version = lenientValue(String.self, c, .version)
        installCount = lenientValue(Int.self, c, .installCount)
    }
}

/// §72.3 a configured marketplace.
public struct MarketplaceInfo: Sendable, Equatable, Decodable, Identifiable {
    public var name: String
    public var source: String
    public var repo: String?
    public var url: String?
    public var path: String?
    public var ref: String?

    public var id: String { name }

    public init(name: String, source: String, repo: String? = nil, url: String? = nil, path: String? = nil, ref: String? = nil) {
        self.name = name
        self.source = source
        self.repo = repo
        self.url = url
        self.path = path
        self.ref = ref
    }

    /// Where it comes from, as `claude plugin marketplace list` prints it ("acme/plugins#v1", a URL, a path).
    public var location: String {
        let base = repo ?? url ?? path.map { SessionNotices.abbreviatingHome($0) } ?? source
        return ref.map { "\(base)#\($0)" } ?? base
    }
}

/// §72.3 reply to `plugins_list`.
public struct PluginsList: Sendable, Equatable, Decodable {
    public var installed: [PluginInstalled]
    public var available: [PluginAvailable]
    public var marketplaces: [MarketplaceInfo]
    /// The CLI could not list (its words).
    public var error: String?

    public init(installed: [PluginInstalled] = [], available: [PluginAvailable] = [], marketplaces: [MarketplaceInfo] = [], error: String? = nil) {
        self.installed = installed
        self.available = available
        self.marketplaces = marketplaces
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case installed, available, marketplaces, error }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = lenientElements(PluginInstalled.self, c, .installed)
        available = lenientElements(PluginAvailable.self, c, .available)
        marketplaces = lenientElements(MarketplaceInfo.self, c, .marketplaces)
        error = lenientValue(String.self, c, .error)
    }
}

/// §72.3 reply to `plugin_run`: the CLI's words and output.
public struct PluginResult: Sendable, Equatable, Decodable {
    public var action: PluginAction?
    public var target: String
    public var ok: Bool
    public var message: String
    public var output: String

    public init(action: PluginAction?, target: String, ok: Bool, message: String, output: String = "") {
        self.action = action
        self.target = target
        self.ok = ok
        self.message = message
        self.output = output
    }

    private enum CodingKeys: String, CodingKey { case action, target, ok, message, output }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = lenientValue(String.self, c, .action).flatMap(PluginAction.init(rawValue:))
        target = lenientValue(String.self, c, .target) ?? ""
        ok = lenientValue(Bool.self, c, .ok) ?? false
        message = lenientValue(String.self, c, .message) ?? ""
        output = lenientValue(String.self, c, .output) ?? ""
    }
}

/// §72.3 reply to `plugins_reload`.
public struct PluginsReloaded: Sendable, Equatable, Decodable {
    public var applied: Bool
    public var held: Bool
    public var mcpServersAdded: [String]
    public var mcpServersRemoved: [String]
    public var plugins: Int
    public var skills: Int
    public var agents: Int
    public var hooks: Int
    public var mcpServers: Int
    public var errors: Int

    public init(applied: Bool, held: Bool = false, mcpServersAdded: [String] = [], mcpServersRemoved: [String] = [], plugins: Int = 0, skills: Int = 0,
                agents: Int = 0, hooks: Int = 0, mcpServers: Int = 0, errors: Int = 0) {
        self.applied = applied
        self.held = held
        self.mcpServersAdded = mcpServersAdded
        self.mcpServersRemoved = mcpServersRemoved
        self.plugins = plugins
        self.skills = skills
        self.agents = agents
        self.hooks = hooks
        self.mcpServers = mcpServers
        self.errors = errors
    }

    private enum CodingKeys: String, CodingKey { case applied, held, cacheImpact, plugins, skills, agents, hooks, mcpServers, errors }
    private enum ImpactKeys: String, CodingKey { case mcpServersAdded, mcpServersRemoved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        applied = lenientValue(Bool.self, c, .applied) ?? false
        held = lenientValue(Bool.self, c, .held) ?? false
        let impact = try? c.nestedContainer(keyedBy: ImpactKeys.self, forKey: .cacheImpact)
        mcpServersAdded = impact.map { lenientElements(String.self, $0, .mcpServersAdded) } ?? []
        mcpServersRemoved = impact.map { lenientElements(String.self, $0, .mcpServersRemoved) } ?? []
        plugins = lenientValue(Int.self, c, .plugins) ?? 0
        skills = lenientValue(Int.self, c, .skills) ?? 0
        agents = lenientValue(Int.self, c, .agents) ?? 0
        hooks = lenientValue(Int.self, c, .hooks) ?? 0
        mcpServers = lenientValue(Int.self, c, .mcpServers) ?? 0
        errors = lenientValue(Int.self, c, .errors) ?? 0
    }
}

/// §72.3 the plugin sheet's tabs (the terminal's panel: Discover, Installed, Marketplaces).
public enum PluginTab: String, Sendable, Equatable, CaseIterable {
    case installed, discover, marketplaces
}

/// §72.3 a typed `/plugin …`: which tab opens, and the action it asks for (run at once, or after the sheet's confirmation).
public struct PluginRequest: Sendable, Equatable {
    public var tab: PluginTab
    public var action: PluginAction?
    public var target: String?
    /// The subcommand was not one the app knows: the sheet opens and the line says so.
    public var unknown: String?

    public init(tab: PluginTab, action: PluginAction? = nil, target: String? = nil, unknown: String? = nil) {
        self.tab = tab
        self.action = action
        self.target = target
        self.unknown = unknown
    }

    /// As the terminal's session forms (the plugin commands reference): `/plugin` → Discover, `manage` / `list` → Installed,
    /// `install | enable | disable | uninstall <plugin>`, `marketplace [add <source> | update <name> | remove <name>]`.
    public static func parse(_ argument: String) -> PluginRequest {
        var words = argument.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = words.first?.lowercased() else { return PluginRequest(tab: .discover) }
        words.removeFirst()
        let rest = words.joined(separator: " ")
        let target = rest.isEmpty ? nil : rest
        switch first {
        case "install", "i": return PluginRequest(tab: .discover, action: target == nil ? nil : .install, target: target)
        case "manage", "list", "ls": return PluginRequest(tab: .installed)
        case "enable": return PluginRequest(tab: .installed, action: target == nil ? nil : .enable, target: target)
        case "disable": return PluginRequest(tab: .installed, action: target == nil ? nil : .disable, target: target)
        case "uninstall": return PluginRequest(tab: .installed, action: target == nil ? nil : .uninstall, target: target)
        case "update": return PluginRequest(tab: .installed, action: target == nil ? nil : .update, target: target)
        case "marketplace", "market":
            guard let verb = words.first?.lowercased() else { return PluginRequest(tab: .marketplaces) }
            let name = words.dropFirst().joined(separator: " ")
            let t = name.isEmpty ? nil : name
            switch verb {
            case "add": return PluginRequest(tab: .marketplaces, action: t == nil ? nil : .marketplaceAdd, target: t)
            case "update": return PluginRequest(tab: .marketplaces, action: t == nil ? nil : .marketplaceUpdate, target: t)
            case "remove", "rm": return PluginRequest(tab: .marketplaces, action: t == nil ? nil : .marketplaceRemove, target: t)
            case "list": return PluginRequest(tab: .marketplaces)
            default: return PluginRequest(tab: .marketplaces, unknown: "marketplace \(verb)")
            }
        default: return PluginRequest(tab: .discover, unknown: first)
        }
    }
}

/// §72.3: the words of `/plugin`, `/reload-plugins` and the plugin sheet.
public enum PluginText {
    public static var description: String { String(localized: "Manage plugins and marketplaces — install, turn on or off, update", bundle: .module) }
    public static var reloadDescription: String {
        String(localized: "Load the plugins again — what was installed, updated or turned on or off since the chat started", bundle: .module)
    }
    public static var argumentHint: String { "[install|enable|disable|uninstall|marketplace] …" }
    public static var title: String { String(localized: "Plugins", bundle: .module) }
    public static var subtitle: String {
        String(localized: "Through Claude Code's own claude plugin commands — they change the same settings the terminal's /plugin does.", bundle: .module)
    }
    public static func tab(_ tab: PluginTab) -> String {
        switch tab {
        case .installed: String(localized: "Installed", bundle: .module)
        case .discover: String(localized: "Discover", bundle: .module)
        case .marketplaces: String(localized: "Marketplaces", bundle: .module)
        }
    }
    public static var loading: String { String(localized: "Asking Claude Code for its plugins…", bundle: .module) }
    public static var noneInstalled: String { String(localized: "No plugins installed", bundle: .module) }
    public static var noneAvailable: String { String(localized: "Your marketplaces offer no other plugins — add a marketplace first", bundle: .module) }
    public static var noMarketplaces: String { String(localized: "No marketplaces yet — add one below", bundle: .module) }
    public static func listFailed(_ why: String) -> String { String(localized: "Claude Code could not list the plugins: \(why)", bundle: .module) }

    public static func scope(_ scope: String) -> String {
        switch scope {
        case "user": String(localized: "User", bundle: .module)
        case "project": String(localized: "Project", bundle: .module)
        case "local": String(localized: "Local", bundle: .module)
        case "managed": String(localized: "Managed", bundle: .module)
        case "session": String(localized: "This session", bundle: .module)
        case "synced": String(localized: "claude.ai", bundle: .module)
        default: scope
        }
    }

    public static var appOff: String { String(localized: "Off in ReviewGate (Settings › Extensions) — it stays off in the app's chats", bundle: .module) }
    public static var managedBlocker: String { String(localized: "Your organization manages this plugin", bundle: .module) }
    public static var sessionBlocker: String { String(localized: "Loaded for this session only (--plugin-dir)", bundle: .module) }
    public static func toggleHelp(enabled: Bool) -> String {
        enabled ? String(localized: "Turn off — claude plugin disable, in the settings of the scope that lists it", bundle: .module)
                : String(localized: "Turn on — claude plugin enable", bundle: .module)
    }
    public static var updateButton: String { String(localized: "Update", bundle: .module) }
    public static var updateHelp: String { String(localized: "Update to its marketplace's latest version — claude plugin update", bundle: .module) }
    public static var uninstallButton: String { String(localized: "Uninstall…", bundle: .module) }
    public static var installButton: String { String(localized: "Install…", bundle: .module) }
    public static var marketplaceUpdateHelp: String { String(localized: "Fetch the marketplace's list again — claude plugin marketplace update", bundle: .module) }
    public static var removeButton: String { String(localized: "Remove…", bundle: .module) }
    public static var addMarketplaceButton: String { String(localized: "Add Marketplace…", bundle: .module) }
    public static var addMarketplacePlaceholder: String { String(localized: "owner/repo, a git URL, a folder or a marketplace.json URL", bundle: .module) }
    public static var addMarketplaceBlocker: String { String(localized: "Type a marketplace's source first", bundle: .module) }
    public static var reloadButton: String { String(localized: "Reload Plugins", bundle: .module) }
    public static var reloadHelp: String { String(localized: "Apply the plugin changes to this chat now, as the terminal's /reload-plugins", bundle: .module) }
    public static var appliesNote: String {
        String(localized: "Changes reach this chat by themselves once Claude is not working; Reload Plugins applies them now. Plugin MCP servers start with the next chat.", bundle: .module)
    }
    public static var outputHeading: String { String(localized: "Command output", bundle: .module) }
    public static var busyBlocker: String { String(localized: "A claude plugin command is running", bundle: .module) }
    public static func running(_ action: PluginAction, _ target: String) -> String {
        String(localized: "Running claude plugin \(action.cliWords) \(target)…", bundle: .module)
    }
    public static func failed(_ action: PluginAction, _ message: String) -> String {
        String(localized: "claude plugin \(action.cliWords) failed: \(message)", bundle: .module)
    }
    public static func unknownSubcommand(_ word: String) -> String {
        String(localized: "/plugin has no “\(word)” here — the sheet lists what it can do", bundle: .module)
    }

    // MARK: Confirmations

    public static func confirmTitle(_ action: PluginAction, _ target: String) -> String {
        switch action {
        case .install: String(localized: "Install \(target)?", bundle: .module)
        case .uninstall: String(localized: "Uninstall \(target)?", bundle: .module)
        case .marketplaceAdd: String(localized: "Add the marketplace \(target)?", bundle: .module)
        case .marketplaceRemove: String(localized: "Remove the marketplace \(target)?", bundle: .module)
        default: "claude plugin \(action.cliWords) \(target)"
        }
    }

    public static func confirmMessage(_ action: PluginAction) -> String {
        switch action {
        case .install: String(localized: "A plugin runs its hooks and MCP servers as you — install only one you trust. Claude Code fetches it and turns it on for the scope you pick.", bundle: .module)
        case .uninstall: String(localized: "claude plugin uninstall takes it out of its scope's settings and deletes its files.", bundle: .module)
        case .marketplaceAdd: String(localized: "claude plugin marketplace add fetches it and declares it in your user settings. Its plugins then show under Discover.", bundle: .module)
        case .marketplaceRemove: String(localized: "Claude Code also uninstalls every plugin you installed from it.", bundle: .module)
        default: ""
        }
    }

    public static func confirmButton(_ action: PluginAction) -> String {
        switch action {
        case .install: String(localized: "Install", bundle: .module)
        case .uninstall: String(localized: "Uninstall", bundle: .module)
        case .marketplaceAdd: String(localized: "Add Marketplace", bundle: .module)
        case .marketplaceRemove: String(localized: "Remove Marketplace", bundle: .module)
        default: String(localized: "Run", bundle: .module)
        }
    }

    /// The install scopes, as the terminal's panel words them.
    public static func installScope(_ scope: String) -> String {
        switch scope {
        case "project": String(localized: "For everyone in this repository (project)", bundle: .module)
        case "local": String(localized: "For you, in this repository only (local)", bundle: .module)
        default: String(localized: "For you, in every project (user)", bundle: .module)
        }
    }

    // MARK: /reload-plugins

    /// The terminal's summary line, or why it was held.
    public static func reloaded(_ r: PluginsReloaded) -> String {
        if r.held {
            let servers = (r.mcpServersAdded + r.mcpServersRemoved).joined(separator: ", ")
            return String(localized: "This reload changes MCP tools (\(servers)) — your next message would read the whole conversation again instead of using the cache. Run /reload-plugins --force to apply it.", bundle: .module)
        }
        let line = String(localized: "Reloaded: \(r.plugins) plugins · \(r.skills) skills · \(r.agents) agents · \(r.hooks) hooks · \(r.mcpServers) plugin MCP servers", bundle: .module)
        return r.errors > 0 ? line + " — " + String(localized: "\(r.errors) errors during load — see /plugin", bundle: .module) : line
    }

    /// The engine's refusals of `plugin_run` / `plugins_reload` in the user's words.
    public static func refusal(code: String, detail: String) -> String? {
        switch code {
        case "invalid_plugin_target": String(localized: "Type a plugin after the command — name@marketplace", bundle: .module)
        case "invalid_plugin_action", "invalid_plugin_scope": String(localized: "The app asked Claude Code for something it does not do", bundle: .module)
        case "plugins_turn_running": String(localized: "Claude is working — reload the plugins once the turn ends", bundle: .module)
        case "plugins_reloading": String(localized: "The plugins are reloading already", bundle: .module)
        case "plugins_reload_unsupported": String(localized: "This Claude Code cannot reload its plugins in a chat — start a new chat to load them", bundle: .module)
        case "plugins_reload_failed": String(localized: "Could not reload the plugins: \(detail)", bundle: .module)
        default: nil
        }
    }
}

extension EngineCommand {
    private enum PluginKeys: String, CodingKey { case action, target, scope, force }

    /// `plugin_run {action, target, scope?}`, `plugins_reload {force?}` (`type` is written by the caller).
    func encodePluginFields(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: PluginKeys.self)
        switch self {
        case let .pluginRun(action, target, scope):
            try c.encode(action.rawValue, forKey: .action)
            try c.encode(target, forKey: .target)
            try c.encodeIfPresent(scope, forKey: .scope)
        case let .pluginsReload(force):
            if force { try c.encode(true, forKey: .force) }
        default: break
        }
    }
}

public extension AppState {
    /// §72.3 `plugins_list`. Throws the engine's refusal.
    func pluginsList() async throws -> PluginsList {
        if let debugPlugins { return debugPlugins }   // the screenshot tour
        let reply = try await reply(.pluginsList)
        guard case let .pluginsList(list) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return list
    }

    /// §72.3 `plugin_run`: the CLI's words (a failure of the CLI is `ok: false`). Throws the engine's refusal.
    func runPlugin(_ action: PluginAction, target: String, scope: String? = nil) async throws -> PluginResult {
        let reply = try await reply(.pluginRun(action: action, target: target, scope: scope))
        guard case let .pluginResult(result) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return result
    }

    /// §72.3 `plugins_reload {force}`. Throws the engine's refusal.
    func reloadPlugins(force: Bool = false) async throws -> PluginsReloaded {
        let reply = try await reply(.pluginsReload(force: force))
        guard case let .pluginsReloaded(r) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return r
    }

    /// Why Reload Plugins cannot run now; nil when it can.
    var reloadPluginsBlocker: String? {
        if !sessionInfo.open || sessionInfo.terminal != nil { return EngineMessages.refusal(error: "no_session") }
        if state.gate.phase == .running || state.gate.phase == .collecting { return PluginText.refusal(code: "plugins_turn_running", detail: "") }
        return nil
    }
}
