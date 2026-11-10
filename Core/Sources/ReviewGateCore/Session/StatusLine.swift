// MARK: wave6 w6-statusline — docs/PROTOCOL.md §44.2: the user's Claude Code status line under the composer — what the
// engine sends (`status_line`), its settings (show it; per project, the project's own command the user allowed), and the
// width / visibility the chat tells the engine.
import Foundation

extension AppSettings.Key {
    /// §44.2: show the user's Claude Code status line under the composer (Bool, unset → true; live).
    public static let showStatusLine = "showStatusLine"
    /// §44.2: JSON `[projectKey: sha256]` — the project's own `statusLine` command (code from the repository) the user
    /// allowed there; a project without an entry runs none of its own, a changed command no longer matches (live).
    public static let projectStatusLineAllowed = "projectStatusLineAllowed"
}

extension AppSettings {
    public static func showStatusLine(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.showStatusLine) as? Bool ?? true
    }

    /// The sha256 of the project's own statusLine command the user allowed for `root` ("" none).
    public static func allowedProjectStatusLine(root: String, defaults: UserDefaults = .standard) -> String {
        allowedProjectStatusLines(defaults: defaults)[root] ?? ""
    }

    /// Allows that command (its sha256) for `root`, or none ("" / nil).
    public static func setAllowedProjectStatusLine(_ sha256: String?, root: String, defaults: UserDefaults = .standard) {
        var all = allowedProjectStatusLines(defaults: defaults)
        all[root] = (sha256?.isEmpty ?? true) ? nil : sha256
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.projectStatusLineAllowed) }
    }

    private static func allowedProjectStatusLines(defaults: UserDefaults) -> [String: String] {
        guard let data = defaults.data(forKey: Key.projectStatusLineAllowed) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    /// `set_settings` with the §44.2 switches: show it, and the open project's allowance ("" without a project).
    public static func statusLineSettings(projectRoot: String?, defaults: UserDefaults = .standard) -> EngineSettings {
        var settings = EngineSettings()
        settings.showStatusLine = showStatusLine(defaults: defaults)
        settings.allowedProjectStatusLine = projectRoot.map { allowedProjectStatusLine(root: $0, defaults: defaults) } ?? ""
        return settings
    }
}

/// The status line of this window's engine: the last `status_line` it sent and those lines as styled runs.
@MainActor
@Observable
public final class StatusLineStore {
    public private(set) var reply: StatusLineReply?
    /// `reply.lines` parsed (styles carried from line to line).
    public private(set) var runs: [[AnsiRun]] = []
    /// The engine does not know `status_line` (an older engine): nothing is asked again.
    public private(set) var unsupported = false
    /// The chat's width in terminal columns, as last measured (0 until then); the lines are cut to it.
    public private(set) var columns = 0
    /// What the chat last told the engine (the same width and visibility are not sent twice in a row).
    @ObservationIgnored private var told: (columns: Int, visible: Bool)?

    public init() {}

    /// The lines to draw: none while the setting is off or nothing is configured.
    public var shownRuns: [[AnsiRun]] {
        guard let reply, reply.enabled, reply.configured else { return [] }
        return runs
    }

    /// Blank columns on each side (`statusLine.padding`).
    public var padding: Int { reply?.padding ?? 0 }

    /// Applies a `status_line` event (a reply or one the engine sent).
    public func apply(_ reply: StatusLineReply) {
        if self.reply?.lines != reply.lines { runs = AnsiText.parseLines(reply.lines) }
        self.reply = reply
    }

    /// The project changed or closed: what was shown goes; the next `status_line` the chat sends is never skipped.
    public func reset() {
        reply = nil
        runs = []
        told = nil
    }

    func tell(columns: Int, visible: Bool, using request: (EngineCommand) async throws -> EngineEvent) async {
        if columns > 0, self.columns != columns { self.columns = columns }
        guard !unsupported else { return }
        if let told, told.columns == columns, told.visible == visible { return }
        told = (columns, visible)
        do {
            // Not measured yet (0): the engine keeps the width it has.
            guard case let .statusLine(r) = try await request(.statusLine(columns: columns > 0 ? columns : nil, visible: visible)) else { return }
            apply(r)
        } catch {
            told = nil
            if (error as? EngineClientError)?.refusalCode == "unknown_command" { unsupported = true }
        }
    }
}

extension AppState {
    /// §44.2: how many columns the chat draws the status line in and whether it is on screen (the engine runs the
    /// command only then, `COLUMNS` = the width); the reply says what it shows now, changes come as events.
    public func tellStatusLine(columns: Int, visible: Bool) async {
        guard projectInfo != nil, isEngineRunning || replySink != nil || commandSink != nil else { return }
        await statusLine.tell(columns: columns, visible: visible) { [weak self] cmd in
            guard let self else { throw EngineClientError.stopped }
            return try await self.reply(cmd)
        }
    }

    /// §44.2: the switches to this window's engine — show it, and this project's allowance (live).
    public func pushStatusLineSettings() {
        guard isEngineRunning || commandSink != nil else { return }
        fire(.setSettings(AppSettings.statusLineSettings(projectRoot: projectURL.map { AppSettings.projectKey($0) }, defaults: settingsDefaults)))
    }

    /// §44.2: the sha256 of this project's own statusLine command the user allowed here ("" none, or no project).
    public var allowedProjectStatusLine: String {
        guard let url = projectURL else { return "" }
        return AppSettings.allowedProjectStatusLine(root: AppSettings.projectKey(url), defaults: settingsDefaults)
    }

    /// The project's own statusLine, as the engine last told it, is the very command allowed here.
    public var projectStatusLineAllowed: Bool {
        guard let project = statusLine.reply?.project, !project.sha256.isEmpty else { return false }
        return allowedProjectStatusLine == project.sha256
    }

    /// A command was allowed here, but the project's statusLine is another one now (a pull changed it): asked again.
    public var projectStatusLineChanged: Bool {
        guard let project = statusLine.reply?.project else { return false }
        let allowed = allowedProjectStatusLine
        return !allowed.isEmpty && allowed != project.sha256
    }

    /// Allows the project's own statusLine command the engine last told (bound to its sha256), or stops it; live.
    public func setProjectStatusLineAllowed(_ on: Bool) {
        guard let url = projectURL else { return }
        let sha = on ? (statusLine.reply?.project?.sha256 ?? "") : ""
        AppSettings.setAllowedProjectStatusLine(sha, root: AppSettings.projectKey(url), defaults: settingsDefaults)
        pushStatusLineSettings()
    }
}
