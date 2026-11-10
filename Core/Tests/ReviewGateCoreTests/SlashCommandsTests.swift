import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-session: the slash palette (docs/PROTOCOL.md §36.5) — entries with description and hint, groups by source,
/// recently used first, ranked matches, the empty states and the per-project memory.
@Suite @MainActor struct SlashCommandsTests {
    private func caps(commands: [SlashCommandInfo], skills: [String] = [], slash: [String] = [], plugins: [String] = [],
                      state: CapabilitiesState? = .ready) -> SessionCapabilities {
        var caps = SessionCapabilities(slashCommands: slash, skills: skills, plugins: plugins, mcpServers: [])
        caps.commands = commands
        caps.state = state
        return caps
    }

    private var sample: SessionCapabilities {
        caps(commands: [
            SlashCommandInfo(name: "mcp", description: "Manage MCP servers", argumentHint: "[reconnect|enable|disable]", source: .builtin),
            SlashCommandInfo(name: "compact", description: "Clear history but keep a summary\nSecond line", source: .builtin),
            SlashCommandInfo(name: "writer-kit:writer-deck", description: "슬라이드 초안 작성", argumentHint: "<주제>", source: .plugin, plugin: "writer-kit"),
            SlashCommandInfo(name: "oh-my-claudecode:plan", description: "Strategic planning", source: .plugin),
            SlashCommandInfo(name: "review", description: "Review the current diff", source: .user, aliases: ["rvw"]),
            SlashCommandInfo(name: "deploy-notes", description: "Release notes for the project", source: .project),
            SlashCommandInfo(name: "github:create_issue", description: "Create an issue", source: .mcp, server: "github"),
            SlashCommandInfo(name: "mystery", source: .unknown),
        ], skills: ["writer-kit:writer-deck", "review", "writer-kit:writer-notes"], slash: ["mcp", "legacy-only"], plugins: ["writer-kit"])
    }

    // MARK: - Entries

    @Test func entriesCarryDescriptionHintSkillAndGroup() {
        let entries = SlashCommandCatalog.entries(sample)
        let byName = Dictionary(entries.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        #expect(entries.map(\.name) == entries.map(\.name).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending })
        #expect(byName["mcp"]?.group == .builtin)
        #expect(byName["mcp"]?.argumentHint == "[reconnect|enable|disable]")
        #expect(byName["compact"]?.description == "Clear history but keep a summary")   // one line
        #expect(byName["writer-kit:writer-deck"]?.group == .plugin("writer-kit"))
        #expect(byName["writer-kit:writer-deck"]?.isSkill == true)
        #expect(byName["oh-my-claudecode:plan"]?.group == .plugin("oh-my-claudecode"))   // the prefix when the plugin is not named
        #expect(byName["review"]?.group == .mine)
        #expect(byName["deploy-notes"]?.group == .project)
        #expect(byName["github:create_issue"]?.group == .mcp("github"))
        #expect(byName["mystery"]?.group == .other)
        // Names the list did not have (an engine before §36 or a skill the CLI did not list): names only.
        #expect(byName["writer-kit:writer-notes"]?.group == .plugin("writer-kit"))
        #expect(byName["writer-kit:writer-notes"]?.description == "")
        #expect(byName["writer-kit:writer-notes"]?.isSkill == true)
        #expect(byName["legacy-only"]?.group == .other)
        #expect(entries.filter { $0.name == "mcp" }.count == 1)   // once each
        #expect(SlashCommandCatalog.entries(nil).isEmpty)
    }

    // MARK: - Sections

    @Test func noQueryShowsRecentThenEachGroupInOrder() {
        let entries = SlashCommandCatalog.entries(sample)
        let sections = SlashCommandCatalog.sections(entries: entries, query: "", recents: ["review", "gone", "mcp"])
        #expect(sections.map(\.group) == [.recent, .builtin, .project, .plugin("oh-my-claudecode"), .plugin("writer-kit"), .mcp("github"), .other])
        #expect(sections.first?.entries.map(\.name) == ["review", "mcp"])   // recency order; an unknown name is skipped
        let builtin = sections.first { $0.group == .builtin }
        #expect(builtin?.entries.map(\.name) == ["compact"])   // a recent command is not repeated in its group
        #expect(sections.first { $0.group == .mine } == nil)   // its only command is in "recent"
        #expect(SlashCommandCatalog.flatten(sections).count == entries.count)
        // At most five recent commands.
        let many = SlashCommandCatalog.sections(entries: entries, query: "", recents: entries.map(\.name))
        #expect(many.first?.entries.count == SlashCommandCatalog.recentLimit)
    }

    @Test func queryRanksPrefixWordContainsDescriptionWithRecentFirst() {
        let entries = SlashCommandCatalog.entries(sample)
        let dev = SlashCommandCatalog.sections(entries: entries, query: "writer-", recents: [])
        #expect(dev.count == 1 && dev[0].group == .matches)
        #expect(dev[0].entries.map(\.name) == ["writer-kit:writer-deck", "writer-kit:writer-notes"])
        // A word of the name: "plan" finds oh-my-claudecode:plan.
        #expect(SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "plan", recents: [])).map(\.name)
                == ["oh-my-claudecode:plan"])
        // Prefix before word before inside before description; the alias counts as inside.
        let r = SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "r", recents: []))
        #expect(r.first?.name == "review")
        #expect(SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "rvw", recents: [])).map(\.name) == ["review"])
        let issue = SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "summary", recents: []))
        #expect(issue.map(\.name) == ["compact"])   // found by its description
        // Recently used first within the same rank.
        let team = SlashCommandCatalog.flatten(SlashCommandCatalog.sections(entries: entries, query: "writer", recents: ["writer-kit:writer-notes"]))
        #expect(team.first?.name == "writer-kit:writer-notes")
        #expect(SlashCommandCatalog.sections(entries: entries, query: "zzz", recents: []).isEmpty)
    }

    // MARK: - Empty states

    @Test func emptyStatesNeverBlameUserSettingsWhileStarting() {
        let none: [SlashCommandEntry] = []
        // An engine before §36, the session still starting: "Starting session…".
        #expect(SlashCommandCatalog.emptyState(capabilities: nil, entries: none, shown: none, starting: true, loadUserSettings: true) == .starting)
        // §36.5: empty lists with state starting.
        let starting = caps(commands: [], state: .starting)
        #expect(SlashCommandCatalog.emptyState(capabilities: starting, entries: none, shown: none, starting: false, loadUserSettings: true) == .starting)
        // An engine before §36 after the start: the list comes with the first message.
        #expect(SlashCommandCatalog.emptyState(capabilities: nil, entries: none, shown: none, starting: false, loadUserSettings: true) == .afterFirstMessage)
        #expect(SlashCommandCatalog.emptyState(capabilities: nil, entries: none, shown: none, starting: false, loadUserSettings: false) == .userSettingsOff)
        let entries = SlashCommandCatalog.entries(sample)
        #expect(SlashCommandCatalog.emptyState(capabilities: sample, entries: entries, shown: [], starting: false, loadUserSettings: true) == .noMatch)
        #expect(SlashCommandCatalog.emptyState(capabilities: sample, entries: entries, shown: entries, starting: true, loadUserSettings: true) == nil)
    }

    // MARK: - Recently used

    @Test func sentCommandsAndRecording() {
        let entries = SlashCommandCatalog.entries(sample)
        #expect(SlashCommandCatalog.command(in: "/writer-kit:writer-deck 1406", entries: entries) == "writer-kit:writer-deck")
        #expect(SlashCommandCatalog.command(in: "  /review", entries: entries) == "review")
        #expect(SlashCommandCatalog.command(in: "/rvw now", entries: entries) == "review")   // an alias records its command
        #expect(SlashCommandCatalog.command(in: "/Users/me/app is broken", entries: entries) == nil)
        #expect(SlashCommandCatalog.command(in: "review this", entries: entries) == nil)
        #expect(SlashCommandCatalog.command(in: "/", entries: entries) == nil)
        #expect(SlashCommandCatalog.recording("b", in: ["a", "b", "c"]) == ["b", "a", "c"])
        let long = (0..<30).map { "c\($0)" }
        #expect(SlashCommandCatalog.recording("new", in: long).count == SlashCommandCatalog.recentMemory)
    }

    @Test func recentCommandsAreKeptPerProject() {
        let defaults = UserDefaults(suiteName: "SlashCommandsTests.\(UUID().uuidString)")!
        AppSettings.recordSlashCommand("review", root: "/repo", defaults: defaults)
        AppSettings.recordSlashCommand("mcp", root: "/repo", defaults: defaults)
        AppSettings.recordSlashCommand("plan", root: "/other", defaults: defaults)
        #expect(AppSettings.slashRecents(root: "/repo", defaults: defaults) == ["mcp", "review"])
        #expect(AppSettings.slashRecents(root: "/other", defaults: defaults) == ["plan"])
        #expect(AppSettings.slashRecents(root: "/none", defaults: defaults).isEmpty)

        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var snapshot = ReviewState.empty
        snapshot.seq = 1
        snapshot.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        snapshot.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: sample, pendingPermission: nil)
        store.handle(.state(snapshot))
        store.recordSlashUse(inPrompt: "/deploy-notes v2")
        store.recordSlashUse(inPrompt: "/not-a-command")
        #expect(store.slashRecents == ["deploy-notes", "mcp", "review"])
        #expect(!store.capabilitiesAreCached)
        snapshot.seq = 2
        snapshot.session.capabilitiesCached = true
        store.handle(.state(snapshot))
        #expect(store.capabilitiesAreCached)
    }

    /// The app's own cache (shown before the engine reports) keeps the session's real lists, not the placeholder a §36
    /// engine reports while the CLI starts (its cache or empty lists, `state: starting`).
    @Test func appCacheKeepsTheReadyLists() {
        let defaults = UserDefaults(suiteName: "SlashCommandsTests.\(UUID().uuidString)")!
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        var snapshot = ReviewState.empty
        snapshot.seq = 1
        snapshot.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        snapshot.session = SessionInfo(open: true, starting: true, sessionId: "s", model: nil,
                                       capabilities: caps(commands: [], state: .starting), pendingPermission: nil)
        store.handle(.state(snapshot))
        snapshot.seq = 2
        snapshot.session.starting = false
        snapshot.session.capabilities = sample
        store.handle(.state(snapshot))
        #expect(AppSettings.cachedCapabilities(defaults: defaults)?.commands.count == sample.commands.count)
        // The engine's replayed cache is not this session's: not written back.
        snapshot.seq = 3
        var replay = caps(commands: [SlashCommandInfo(name: "old", source: .builtin)])
        replay.state = .ready
        snapshot.session.capabilities = replay
        snapshot.session.capabilitiesCached = true
        store.handle(.state(snapshot))
        #expect(AppSettings.cachedCapabilities(defaults: defaults)?.commands.count == sample.commands.count)
    }
}
