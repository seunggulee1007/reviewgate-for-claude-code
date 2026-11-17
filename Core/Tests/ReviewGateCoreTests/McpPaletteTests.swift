import Foundation
import Testing
@testable import ReviewGateCore

/// §56.4: `/mcp` in the message box, as in the terminal — the list's filter, what ↩ / ⌥↩ do per status, why an action
/// cannot run, and `/mcp reconnect|enable|disable <name>` typed out.
@Suite @MainActor struct McpPaletteTests {
    private let servers = [
        McpServerInfo(name: "acme-docs", status: .connected, source: .project, toolCount: 3),
        McpServerInfo(name: "tickets", status: .needsAuth, source: .user),
        McpServerInfo(name: "docs-search", status: .failed, source: .local),
        McpServerInfo(name: "Archive", status: .connected, source: .user, disabledByUser: true),
    ]
    private let live = McpPaletteContext(supported: true, sessionOpen: true)

    // MARK: Parsing

    @Test func parsesTheCommandAsTheTerminalDoes() {
        #expect(McpCommand.parse("/mcp") == .list(filter: ""))
        #expect(McpCommand.parse("  /MCP  ") == .list(filter: ""))
        #expect(McpCommand.parse("/mcp acme") == .list(filter: "acme"))
        #expect(McpCommand.parse("/mcp reconnect acme-docs") == .run(.reconnect, name: "acme-docs"))
        #expect(McpCommand.parse("/mcp Enable  tickets ") == .run(.enable, name: "tickets"))
        #expect(McpCommand.parse("/mcp disable") == .run(.disable, name: ""))
        #expect(McpCommand.parse("/mcp re") == .list(filter: "re"))   // a verb only once it is whole
        #expect(McpCommand.parse("/mcp disable ALL")?.isAll == true)   // every server, as the terminal's `all`
        #expect(McpCommand.parse("/mcp disable ALL")?.filter == "")
        #expect(McpCommand.parse("/mcp disable allegro")?.isAll == false)
        #expect(McpCommand.list(filter: "all").isAll == false)
        // Not the command: another command, a word glued on, a message, a second line.
        #expect(McpCommand.parse("/mcpx") == nil)
        #expect(McpCommand.parse("/mcp__acme-docs__search") == nil)
        #expect(McpCommand.parse("please /mcp") == nil)
        #expect(McpCommand.parse("/mcp reconnect acme\nand more") == nil)
    }

    @Test func tabCompletesTheNameAndKeepsTheVerb() {
        #expect(McpCommand.list(filter: "ac").completing("acme-docs") == "/mcp acme-docs")
        #expect(McpCommand.run(.reconnect, name: "ac").completing("acme-docs") == "/mcp reconnect acme-docs")
        #expect(McpCommand.run(.disable, name: "").filter == "")
    }

    // MARK: The list

    @Test func filtersByNamePrefixFirst() {
        #expect(McpPalette.rows(servers: servers, busy: [], filter: "").map(\.id) == ["acme-docs", "Archive", "docs-search", "tickets"])
        #expect(McpPalette.rows(servers: servers, busy: [], filter: "DOCS").map(\.id) == ["docs-search", "acme-docs"])
        #expect(McpPalette.rows(servers: servers, busy: [], filter: "nothing").isEmpty)
        let busy = McpPalette.rows(servers: servers, busy: ["tickets"], filter: "tick")
        #expect(busy.first?.busy == true)
        #expect(busy.first?.statusText == String(localized: "Working…", bundle: .module))
        #expect(McpPalette.rows(servers: servers, busy: [], filter: "archive").first?.statusText == McpText.status(.disabled))
    }

    @Test func enterAndOptionEnterDependOnTheStatus() {
        let byName = Dictionary(uniqueKeysWithValues: servers.map { ($0.name, $0) })
        #expect(McpPalette.primaryAction(byName["acme-docs"]!) == .reconnect)
        #expect(McpPalette.primaryAction(byName["docs-search"]!) == .reconnect)
        #expect(McpPalette.primaryAction(byName["tickets"]!) == .login)
        #expect(McpPalette.primaryAction(byName["Archive"]!) == .enable)
        #expect(McpPalette.toggleAction(byName["acme-docs"]!) == .disable)
        #expect(McpPalette.toggleAction(byName["Archive"]!) == .enable)
        #expect(McpPalette.action(for: .reconnect) == .reconnect)
        #expect(McpPalette.action(for: .enable) == .enable)
        #expect(McpPalette.action(for: .disable) == .disable)
    }

    @Test func saysWhyAnActionCannotRun() {
        let rows = McpPalette.rows(servers: servers, busy: ["tickets"], filter: "")
        let row = { (name: String) in rows.first { $0.id == name }! }
        #expect(McpPalette.disabledReason(.reconnect, row: row("acme-docs"), context: live) == nil)
        #expect(McpPalette.disabledReason(.reconnect, row: row("Archive"), context: live) != nil)   // off: turn it on first
        #expect(McpPalette.disabledReason(.enable, row: row("acme-docs"), context: live) != nil)
        #expect(McpPalette.disabledReason(.disable, row: row("Archive"), context: live) != nil)
        #expect(McpPalette.disabledReason(.login, row: row("tickets"), context: live) != nil)   // busy
        let stopped = McpPaletteContext(supported: true, sessionOpen: false)
        #expect(McpPalette.disabledReason(.reconnect, row: row("acme-docs"), context: stopped) == McpPalette.unavailableReason(stopped))
        let old = McpPaletteContext(supported: false, sessionOpen: true)
        #expect(McpPalette.unavailableReason(old) != nil && McpPalette.unavailableReason(live) == nil)
    }

    @Test func aTypedNameWinsOverTheSelection() {
        let rows = McpPalette.rows(servers: servers, busy: [], filter: "")
        #expect(McpPalette.target(name: "TICKETS", rows: rows, selection: 0)?.id == "tickets")
        #expect(McpPalette.target(name: "", rows: rows, selection: 2)?.id == "docs-search")
        #expect(McpPalette.target(name: "", rows: rows, selection: 99)?.id == "tickets")
        #expect(McpPalette.target(name: "gone", rows: [], selection: 0) == nil)
    }

    // MARK: The store

    private func snapshot(capabilities: SessionCapabilities?, terminal: Bool = false) -> ReviewState {
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: capabilities,
                                pendingPermission: nil, canRestart: true)
        if terminal {
            var term = SessionMeta(id: "s", title: "In the terminal")
            term.kind = .terminal
            s.sessions = SessionsInfo(list: [term], currentId: "s", openTabIds: ["s"])
        }
        return s
    }

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "McpPaletteTests.\(UUID().uuidString)")!)
    }

    @Test func thePaletteListsMcpInARegularChatOnly() {
        let caps = SessionCapabilities(slashCommands: ["compact"], skills: [], plugins: [], mcpServers: [(name: "acme-docs", status: "connected")])
        let app = makeState()
        app.handle(.state(snapshot(capabilities: caps)))
        #expect(app.offersMcpCommand)
        let entry = app.slashEntries.first { $0.name == McpCommand.name }
        #expect(entry?.group == .builtin && entry?.description == McpCommand.description)
        // Before the first mcp_status: the session's own report.
        #expect(app.mcpPaletteServers.map(\.name) == ["acme-docs"] && app.mcpPaletteServers.first?.status == .connected)

        let terminal = makeState()
        terminal.handle(.state(snapshot(capabilities: caps, terminal: true)))
        #expect(!terminal.offersMcpCommand)
        #expect(!terminal.slashEntries.contains { $0.name == McpCommand.name })
    }
}
