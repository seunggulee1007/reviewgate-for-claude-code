import Foundation

// MARK: composer parity — docs/PROTOCOL.md §56.4: `/mcp`, as in the terminal — the session's MCP servers listed in the
// message box (↑ / ↓, ↩ reconnects or logs in, ⌥↩ turns on / off), and `/mcp reconnect|enable|disable <name>` typed out.

/// What `/mcp …` typed out asks for (as the terminal's `/mcp [reconnect|enable|disable] <name>`).
public enum McpVerb: String, CaseIterable, Sendable {
    case reconnect, enable, disable
}

/// The app's `/mcp` command — never sent to Claude.
public enum McpCommand: Equatable, Sendable {
    /// `/mcp` or `/mcp <text>`: the list, filtered by `filter` (part of a server's name).
    case list(filter: String)
    /// `/mcp reconnect|enable|disable <name>` (the name may still be partial, or missing).
    case run(McpVerb, name: String)

    /// The palette's entry (Built-in), as the terminal's own /mcp.
    public static let name = "mcp"

    /// The palette's line for it.
    public static var description: String {
        String(localized: "Manage MCP servers — reconnect, log in, turn on or off", bundle: .module)
    }

    /// The palette's argument hint.
    public static let argumentHint = "[reconnect|enable|disable] <server|all>"

    /// `text` is the app's `/mcp` command; nil for anything else (`/mcpx`, a second line, a message).
    public static func parse(_ text: String) -> McpCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("/mcp"), !trimmed.contains(where: \.isNewline) else { return nil }
        let rest = trimmed.dropFirst(4)
        guard rest.isEmpty || rest.first?.isWhitespace == true else { return nil }
        let words = rest.split(whereSeparator: \.isWhitespace).map(String.init)
        guard let first = words.first else { return .list(filter: "") }
        if let verb = McpVerb(rawValue: first.lowercased()) {
            return .run(verb, name: words.dropFirst().joined(separator: " "))
        }
        return .list(filter: words.joined(separator: " "))
    }

    /// `/mcp <verb> all`: every server, as in the terminal.
    public var isAll: Bool {
        if case let .run(_, name) = self { return name.caseInsensitiveCompare("all") == .orderedSame }
        return false
    }

    /// The name part that filters the list (none for `all`: the list shows every server it acts on).
    public var filter: String {
        switch self {
        case let .list(filter): filter
        case let .run(_, name): isAll ? "" : name
        }
    }

    /// `/mcp …` with the name part replaced by `name` (⇥ completes the selected server's name).
    public func completing(_ name: String) -> String {
        switch self {
        case .list: "/mcp \(name)"
        case let .run(verb, _): "/mcp \(verb.rawValue) \(name)"
        }
    }
}

/// What the list does to a server.
public enum McpRowAction: Sendable, Equatable {
    case reconnect, login, enable, disable

    /// The words of a button / menu item.
    public var title: String {
        switch self {
        case .reconnect: String(localized: "Reconnect", bundle: .module)
        case .login: String(localized: "Log in…", bundle: .module)
        case .enable: String(localized: "Turn On", bundle: .module)
        case .disable: String(localized: "Turn Off", bundle: .module)
        }
    }

    /// What it is doing to every server (`/mcp <verb> all`).
    public func progress(count: Int) -> String {
        switch self {
        case .reconnect, .login: String(localized: "Reconnecting \(count) MCP servers…", bundle: .module)
        case .enable: String(localized: "Turning on \(count) MCP servers…", bundle: .module)
        case .disable: String(localized: "Turning off \(count) MCP servers…", bundle: .module)
        }
    }

    /// `/mcp <verb> all` done.
    public func done(count: Int) -> String {
        String(localized: "\(title) — \(count) MCP servers done", bundle: .module)
    }

    /// What it is doing, for the notice line of `/mcp <verb> <name>`.
    public func progress(_ name: String) -> String {
        switch self {
        case .reconnect: String(localized: "Reconnecting “\(name)”…", bundle: .module)
        case .login: String(localized: "Opening Terminal to log in to “\(name)”…", bundle: .module)
        case .enable: String(localized: "Turning on “\(name)”…", bundle: .module)
        case .disable: String(localized: "Turning off “\(name)”…", bundle: .module)
        }
    }
}

/// One row of the list.
public struct McpPaletteRow: Identifiable, Equatable, Sendable {
    public let server: McpServerInfo
    /// An action is in flight for it (a spinner instead of the status).
    public let busy: Bool

    public var id: String { server.name }

    public init(server: McpServerInfo, busy: Bool) {
        self.server = server
        self.busy = busy
    }

    /// The status word (Off for a server the user turned off).
    public var statusText: String {
        busy ? String(localized: "Working…", bundle: .module) : McpText.status(server.isOff ? .disabled : server.status)
    }
}

/// Where the list is and what the engine can do.
public struct McpPaletteContext: Sendable, Equatable {
    /// The engine has §22's MCP commands (`McpStore.isSupported`).
    public var supported: Bool
    /// The session is open (the CLI answers MCP commands).
    public var sessionOpen: Bool

    public init(supported: Bool, sessionOpen: Bool) {
        self.supported = supported
        self.sessionOpen = sessionOpen
    }
}

public enum McpPalette {
    /// The servers whose name matches `filter` (any case): names starting with it first, then names containing it, each by
    /// name. An empty filter lists every server by name.
    public static func rows(servers: [McpServerInfo], busy: Set<String>, filter: String) -> [McpPaletteRow] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let byName: (McpServerInfo, McpServerInfo) -> Bool = { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let picked: [McpServerInfo]
        if q.isEmpty {
            picked = servers.sorted(by: byName)
        } else {
            let prefix = servers.filter { $0.name.lowercased().hasPrefix(q) }.sorted(by: byName)
            let inside = servers.filter { !$0.name.lowercased().hasPrefix(q) && $0.name.lowercased().contains(q) }.sorted(by: byName)
            picked = prefix + inside
        }
        return picked.map { McpPaletteRow(server: $0, busy: busy.contains($0.name)) }
    }

    /// ↩: Log in… for a server that needs it, Turn On for one that is off, else Reconnect.
    public static func primaryAction(_ server: McpServerInfo) -> McpRowAction {
        if server.isOff { return .enable }
        if server.status == .needsAuth { return .login }
        return .reconnect
    }

    /// ⌥↩: Turn Off / Turn On.
    public static func toggleAction(_ server: McpServerInfo) -> McpRowAction {
        server.isOff ? .enable : .disable
    }

    /// What `/mcp <verb> <name>` does to the server.
    public static func action(for verb: McpVerb) -> McpRowAction {
        switch verb {
        case .reconnect: .reconnect
        case .enable: .enable
        case .disable: .disable
        }
    }

    /// Why `action` cannot run on `row` now; nil when it can.
    public static func disabledReason(_ action: McpRowAction, row: McpPaletteRow, context: McpPaletteContext) -> String? {
        if let reason = unavailableReason(context) { return reason }
        if row.busy { return String(localized: "Working on “\(row.server.name)” — wait for it to finish", bundle: .module) }
        switch action {
        case .reconnect where row.server.isOff:
            return String(localized: "“\(row.server.name)” is off — turn it on first (⌥↩)", bundle: .module)
        case .enable where !row.server.isOff:
            return String(localized: "“\(row.server.name)” is already on", bundle: .module)
        case .disable where row.server.isOff:
            return String(localized: "“\(row.server.name)” is already off", bundle: .module)
        default:
            return nil
        }
    }

    /// Why no action runs at all; nil when they can.
    public static func unavailableReason(_ context: McpPaletteContext) -> String? {
        if !context.supported { return String(localized: "This engine cannot manage MCP servers — reopen the project after updating ReviewGate", bundle: .module) }
        if !context.sessionOpen { return String(localized: "The session is not running — MCP servers can be managed once it is", bundle: .module) }
        return nil
    }

    /// The server `/mcp <verb> <name>` means: the one with exactly that name (any case), else the row at `selection`.
    public static func target(name: String, rows: [McpPaletteRow], selection: Int) -> McpPaletteRow? {
        let n = name.trimmingCharacters(in: .whitespaces)
        if let exact = rows.first(where: { $0.server.name.caseInsensitiveCompare(n) == .orderedSame }) { return exact }
        guard !rows.isEmpty else { return nil }
        return rows[min(max(selection, 0), rows.count - 1)]
    }

    /// The list's servers before the first `mcp_status`: the names and states the session reported (`extensions` or the
    /// capabilities).
    public static func fallbackServers(_ applied: [(name: String, status: String)]) -> [McpServerInfo] {
        applied.map { McpServerInfo(name: $0.name, status: McpServerStatus(lenient: $0.status)) }
    }

    /// "No MCP server is called “x”" for `/mcp <verb> x` that matches none.
    public static func noServer(_ name: String) -> String {
        name.isEmpty ? String(localized: "No MCP server to act on — type /mcp to see the list", bundle: .module)
            : String(localized: "No MCP server is called “\(name)” — type /mcp to see the list", bundle: .module)
    }
}

public extension AppState {
    /// §56.4: the composer offers `/mcp` — a regular chat (a terminal chat's TUI has its own) on an engine with §22.
    var offersMcpCommand: Bool { mcp.isSupported && !isTerminalChat }

    /// §56.4: what the `/mcp` list shows — the live list once `mcp_status` came, the session's report until then.
    var mcpPaletteServers: [McpServerInfo] {
        if mcp.loaded { return mcp.servers }
        let applied = extensions?.mcpServers.map { (name: $0.name, status: $0.status) } ?? capabilities?.mcpServers ?? []
        return McpPalette.fallbackServers(applied)
    }

    var mcpPaletteContext: McpPaletteContext { McpPaletteContext(supported: mcp.isSupported, sessionOpen: isSessionOpen) }

    /// §56.4: runs `action` on `name` (Settings › MCP Servers' own commands).
    func runMcp(_ action: McpRowAction, on name: String) async {
        switch action {
        case .reconnect: await mcp.reconnect(name)
        case .login: await mcp.login(name)
        case .enable: await mcp.setEnabled(name, enabled: true)
        case .disable: await mcp.setEnabled(name, enabled: false)
        }
    }
}
