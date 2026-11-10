import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.5 on the client: the slash palette's entries — name, one-line description and dimmed argument hint
// (`capabilities.commands`) — grouped by where they come from (built-in / mine / project / each plugin / MCP) with this
// project's recently used commands first, and its empty state ("Starting session…" while the CLI starts — never "enable
// user settings" when they are on).

/// A palette group, in display order.
public enum SlashCommandGroup: Hashable, Sendable {
    /// This project's recently used commands (no query).
    case recent
    case builtin
    /// The user's own commands and skills (`~/.claude`).
    case mine
    /// `<root>/.claude`.
    case project
    case plugin(String)
    /// An MCP server's prompts (server name when known).
    case mcp(String?)
    /// Not known where from (an engine before §36 sends names only).
    case other
    /// The ranked results of a query: one list, no header.
    case matches

    /// Display order; plugins and MCP servers by name within their rank.
    var rank: Int {
        switch self {
        case .recent: 0
        case .matches: 0
        case .builtin: 1
        case .mine: 2
        case .project: 3
        case .plugin: 4
        case .mcp: 5
        case .other: 6
        }
    }

    var sortName: String {
        switch self {
        case let .plugin(name): name.lowercased()
        case let .mcp(server): server?.lowercased() ?? ""
        default: ""
        }
    }

    /// The section header; nil for `.matches` (and the view hides a lone `.other`).
    public var title: String? {
        switch self {
        case .recent: String(localized: "Recently used", bundle: .module)
        case .builtin: String(localized: "Built-in", bundle: .module)
        case .mine: String(localized: "My commands", bundle: .module)
        case .project: String(localized: "Project", bundle: .module)
        case let .plugin(name): name
        case let .mcp(server): server.map { "MCP · \($0)" } ?? "MCP"
        case .other: String(localized: "Commands", bundle: .module)
        case .matches: nil
        }
    }
}

/// One command of the palette.
public struct SlashCommandEntry: Identifiable, Hashable, Sendable {
    /// Without the leading slash.
    public let name: String
    /// One line (the first line of what the CLI reports); "" when unknown.
    public let description: String
    /// "" when the command takes none.
    public let argumentHint: String
    public let isSkill: Bool
    public let aliases: [String]
    /// Where it comes from (never `.recent` / `.matches`).
    public let group: SlashCommandGroup

    public var id: String { name }

    public init(name: String, description: String = "", argumentHint: String = "", isSkill: Bool = false, aliases: [String] = [],
                group: SlashCommandGroup = .other) {
        self.name = name
        self.description = description
        self.argumentHint = argumentHint
        self.isSkill = isSkill
        self.aliases = aliases
        self.group = group
    }
}

/// A run of entries under one header.
public struct SlashCommandSection: Identifiable, Hashable, Sendable {
    public let group: SlashCommandGroup
    public let entries: [SlashCommandEntry]

    public var id: SlashCommandGroup { group }

    public init(group: SlashCommandGroup, entries: [SlashCommandEntry]) {
        self.group = group
        self.entries = entries
    }
}

/// Why the palette has nothing to list.
public enum SlashPaletteEmptyState: Sendable, Equatable {
    /// The CLI has not answered initialize yet: "Starting session…".
    case starting
    /// An engine before §36 reports the commands with the first message only.
    case afterFirstMessage
    /// "Load user settings" is off: the user's skills and commands are not loaded.
    case userSettingsOff
    /// Nothing matches the typed text.
    case noMatch

    public var text: String {
        switch self {
        case .starting: String(localized: "Starting session…", bundle: .module)
        case .afterFirstMessage: String(localized: "The command list arrives with the first message", bundle: .module)
        case .userSettingsOff: String(localized: "no skills loaded — enable in Settings → Load user settings", bundle: .module)
        case .noMatch: String(localized: "No matching command", bundle: .module)
        }
    }
}

public enum SlashCommandCatalog {
    /// How many recently used commands lead the palette.
    public static let recentLimit = 5
    /// How many are remembered per project.
    public static let recentMemory = 20

    /// Every command the session knows, once each: `commands` (with descriptions and source) first, then the bare names of
    /// `skills` / `slashCommands` the list did not have (an engine before §36 sends names only). Sorted by name.
    public static func entries(_ caps: SessionCapabilities?) -> [SlashCommandEntry] {
        guard let caps else { return [] }
        let skills = Set(caps.skills)
        let plugins = Set(caps.plugins)
        var seen = Set<String>()
        var out: [SlashCommandEntry] = []
        for command in caps.commands where seen.insert(command.name).inserted {
            // wave4c w4c-commit (§41.1): /clear is the app's new chat — the palette says so.
            out.append(SlashCommandEntry(name: command.name,
                                         description: command.name == "clear" ? TeamFormat.clearDescription : firstLine(command.description),
                                         argumentHint: command.argumentHint.trimmingCharacters(in: .whitespacesAndNewlines),
                                         isSkill: skills.contains(command.name), aliases: command.aliases,
                                         group: group(for: command)))
        }
        for name in caps.skills + caps.slashCommands where !name.isEmpty && seen.insert(name).inserted {
            out.append(SlashCommandEntry(name: name, isSkill: skills.contains(name), group: inferredGroup(name, plugins: plugins)))
        }
        return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// The palette for `query` (the text after `/`). Without a query: up to `recentLimit` recently used commands, then every
    /// group in order (a command shows once). With one: a single ranked list — name prefix, then a word of the name
    /// (`writer-deck` in `writer-kit:writer-deck`), then anywhere in the name or an alias, then the description — recently used first
    /// within a rank.
    public static func sections(entries: [SlashCommandEntry], query: String, recents: [String]) -> [SlashCommandSection] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let recentRank = Dictionary(recents.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        if !q.isEmpty {
            let ranked = entries.compactMap { entry -> (SlashCommandEntry, Int)? in
                matchTier(entry, q).map { (entry, $0) }
            }
            let sorted = ranked.sorted { a, b in
                if a.1 != b.1 { return a.1 < b.1 }
                let ra = recentRank[a.0.name] ?? Int.max, rb = recentRank[b.0.name] ?? Int.max
                if ra != rb { return ra < rb }
                return a.0.name.localizedCaseInsensitiveCompare(b.0.name) == .orderedAscending
            }
            return sorted.isEmpty ? [] : [SlashCommandSection(group: .matches, entries: sorted.map(\.0))]
        }
        let byName = Dictionary(entries.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        let recent = recents.compactMap { byName[$0] }.prefix(recentLimit)
        let recentNames = Set(recent.map(\.name))
        var sections: [SlashCommandSection] = []
        if !recent.isEmpty { sections.append(SlashCommandSection(group: .recent, entries: Array(recent))) }
        let rest = entries.filter { !recentNames.contains($0.name) }
        let groups = Dictionary(grouping: rest, by: \.group)
        for group in groups.keys.sorted(by: { ($0.rank, $0.sortName) < ($1.rank, $1.sortName) }) {
            sections.append(SlashCommandSection(group: group, entries: groups[group] ?? []))
        }
        return sections
    }

    /// The sections' entries in display order (what ↑ / ↓ walk through).
    public static func flatten(_ sections: [SlashCommandSection]) -> [SlashCommandEntry] { sections.flatMap(\.entries) }

    /// Why nothing is listed; nil when there is something to show.
    public static func emptyState(capabilities: SessionCapabilities?, entries: [SlashCommandEntry], shown: [SlashCommandEntry],
                                  starting: Bool, loadUserSettings: Bool) -> SlashPaletteEmptyState? {
        guard shown.isEmpty else { return nil }
        guard entries.isEmpty else { return .noMatch }
        if starting || capabilities?.isStarting == true { return .starting }
        if !loadUserSettings { return .userSettingsOff }
        return capabilities == nil ? .afterFirstMessage : .noMatch
    }

    /// The command a sent message starts with (`/writer-kit:writer-deck 1406` → `writer-kit:writer-deck`), if it is one of `entries`.
    public static func command(in text: String, entries: [SlashCommandEntry]) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        let token = trimmed.dropFirst().prefix { !$0.isWhitespace }
        guard !token.isEmpty else { return nil }
        let name = String(token)
        if entries.contains(where: { $0.name == name }) { return name }
        return entries.first { $0.aliases.contains(name) }?.name
    }

    /// `recents` with `name` moved to the front, at most `recentMemory` long.
    public static func recording(_ name: String, in recents: [String]) -> [String] {
        Array(([name] + recents.filter { $0 != name }).prefix(recentMemory))
    }

    // MARK: Helpers

    static func group(for command: SlashCommandInfo) -> SlashCommandGroup {
        switch command.source {
        case .builtin: return .builtin
        case .user: return .mine
        case .project: return .project
        case .plugin:
            if let plugin = command.plugin { return .plugin(plugin) }
            if let prefix = command.name.split(separator: ":", maxSplits: 1).first, command.name.contains(":") { return .plugin(String(prefix)) }
            return .plugin(String(localized: "Plugin", bundle: .module))
        case .mcp: return .mcp(command.server)
        case .unknown: return .other
        }
    }

    /// A name without a source: a `<plugin>:` prefix of a known plugin, else unknown.
    static func inferredGroup(_ name: String, plugins: Set<String>) -> SlashCommandGroup {
        guard name.contains(":"), let prefix = name.split(separator: ":", maxSplits: 1).first, plugins.contains(String(prefix)) else {
            return .other
        }
        return .plugin(String(prefix))
    }

    static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.trimmingCharacters(in: .whitespaces)
    }

    /// 0 name prefix, 1 a word of the name, 2 inside the name or an alias, 3 the description; nil = no match.
    static func matchTier(_ entry: SlashCommandEntry, _ q: String) -> Int? {
        let name = entry.name.lowercased()
        if name.hasPrefix(q) { return 0 }
        let words = name.split(whereSeparator: { $0 == ":" || $0 == "-" || $0 == "_" || $0 == "/" || $0 == "." })
        if words.contains(where: { $0.hasPrefix(q) }) { return 1 }
        if name.contains(q) || entry.aliases.contains(where: { $0.lowercased().contains(q) }) { return 2 }
        if entry.description.lowercased().contains(q) { return 3 }
        return nil
    }
}

// MARK: - Recently used commands (per project, in the app's UserDefaults)

public extension AppSettings.Key {
    /// wave3 mac-session (§36.5): JSON `[projectKey: [command name]]`, most recent first.
    static let slashRecents = "slashRecents"
}

public extension AppSettings {
    /// This project's recently used slash commands, most recent first.
    static func slashRecents(root: String, defaults: UserDefaults = .standard) -> [String] {
        slashRecentsByProject(defaults: defaults)[root] ?? []
    }

    static func recordSlashCommand(_ name: String, root: String, defaults: UserDefaults = .standard) {
        var all = slashRecentsByProject(defaults: defaults)
        all[root] = SlashCommandCatalog.recording(name, in: all[root] ?? [])
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.slashRecents) }
    }

    private static func slashRecentsByProject(defaults: UserDefaults) -> [String: [String]] {
        guard let data = defaults.data(forKey: Key.slashRecents) else { return [:] }
        return (try? JSONDecoder().decode([String: [String]].self, from: data)) ?? [:]
    }
}

public extension AppState {
    /// The palette's commands (`capabilities`, the cache until this session's arrive).
    var slashEntries: [SlashCommandEntry] { SlashCommandCatalog.entries(capabilities) }

    /// This project's recently used commands, most recent first.
    var slashRecents: [String] {
        guard let url = projectURL else { return [] }
        return AppSettings.slashRecents(root: AppSettings.projectKey(url), defaults: settingsDefaults)
    }

    /// A command picked in the palette (or sent typed out) leads the palette next time.
    func recordSlashCommand(_ name: String) {
        guard let url = projectURL, !name.isEmpty else { return }
        AppSettings.recordSlashCommand(name, root: AppSettings.projectKey(url), defaults: settingsDefaults)
    }

    /// A sent message that starts with a known command counts as using it.
    func recordSlashUse(inPrompt text: String) {
        guard text.hasPrefix("/"), let name = SlashCommandCatalog.command(in: text, entries: slashEntries) else { return }
        recordSlashCommand(name)
    }

    /// The palette lists a cache (the engine's or this app's) rather than this session's commands.
    var capabilitiesAreCached: Bool { sessionInfo.capabilitiesCached || isCapabilitiesCached }

    /// The CLI has not answered initialize yet — the palette and the caption say "Starting session…".
    var isSessionStarting: Bool { isClaudeCodeStarting || capabilities?.isStarting == true }

    /// Why the palette shows nothing for `shown` (its entries for the typed text); nil when it lists something.
    func slashPaletteEmptyState(shown: [SlashCommandEntry]) -> SlashPaletteEmptyState? {
        SlashCommandCatalog.emptyState(capabilities: capabilities, entries: slashEntries, shown: shown, starting: isSessionStarting,
                                       loadUserSettings: AppSettings.loadUserSettings(defaults: settingsDefaults))
    }
}
