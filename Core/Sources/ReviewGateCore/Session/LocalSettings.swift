import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.6 on the client: "Load local settings (settings.local.json)" kept per project (default on) and sent
// before every `open_project`, the restart notice when it differs from what the running session applied, and what the
// session left out ("Not applied in the app"). Local allow rules never skip a permission card or the review: the engine's
// PreToolUse hook decides first (§33.5).

public extension AppSettings.Key {
    /// wave3 mac-session (§36.6): JSON `[projectKey: Bool]`; a project without an entry loads its local settings.
    static let projectLoadLocalSettings = "projectLoadLocalSettings"
}

public extension AppSettings {
    /// §36.6: this project's "Load local settings"; unset → true (as the terminal's claude does).
    static func loadLocalSettings(root: String, defaults: UserDefaults = .standard) -> Bool {
        loadLocalSettingsByProject(defaults: defaults)[root] ?? true
    }

    static func setLoadLocalSettings(_ on: Bool, root: String, defaults: UserDefaults = .standard) {
        var all = loadLocalSettingsByProject(defaults: defaults)
        all[root] = on
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.projectLoadLocalSettings) }
    }

    private static func loadLocalSettingsByProject(defaults: UserDefaults) -> [String: Bool] {
        guard let data = defaults.data(forKey: Key.projectLoadLocalSettings) else { return [:] }
        return (try? JSONDecoder().decode([String: Bool].self, from: data)) ?? [:]
    }
}

/// Whether the engine implements the session half of §36 (§36.5–36.9 land together) — the controls that need it are shown
/// disabled with a reason otherwise.
public enum SessionToolsSupport {
    /// Any §36.5–36.9 field the engine only sends once it knows them.
    public static func knowsSessionTools(_ session: SessionInfo) -> Bool {
        if session.cli != nil || session.extensionsWaitingOn != nil { return true }
        if let caps = session.capabilities, caps.state != nil || !caps.commands.isEmpty { return true }
        if let ext = session.extensions, ext.loadsLocalSettings || ext.notApplied != nil { return true }
        return false
    }

    /// The one-line reason a §36 control is off with an older engine.
    public static var updateReason: String {
        String(localized: "This engine does not support it yet — update ReviewGate", bundle: .module)
    }
}

public enum LocalSettingsLogic {
    /// The project's choice differs from what the running session applied: it takes effect after `restart_session`. Never
    /// with an engine that does not know §36.6 (it would never apply it) or during the §16 fallback (which drops local with
    /// user; "Retry with extensions" brings both back).
    public static func needsRestart(applied: SessionExtensions?, wanted: Bool, supported: Bool) -> Bool {
        guard let applied, supported, applied.fallback == nil else { return false }
        return applied.loadsLocalSettings != wanted
    }
}

public extension AppState {
    /// The engine knows §36.5–36.9 (see `SessionToolsSupport`).
    var supportsSessionTools: Bool { SessionToolsSupport.knowsSessionTools(sessionInfo) }

    /// This project's "Load local settings (settings.local.json)" (true without a project).
    var loadsLocalSettingsForProject: Bool {
        guard let url = projectURL else { return true }
        return AppSettings.loadLocalSettings(root: AppSettings.projectKey(url), defaults: settingsDefaults)
    }

    /// Stores the project's choice and gives it to the engine; the next session start applies it.
    func setLoadsLocalSettingsForProject(_ on: Bool) {
        guard let url = projectURL else { return }
        AppSettings.setLoadLocalSettings(on, root: AppSettings.projectKey(url), defaults: settingsDefaults)
        guard isEngineRunning || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.loadLocalSettings = on
        fire(.setSettings(settings))
    }

    /// The choice differs from what the running session applied ("Applies from the next session — Restart now").
    var localSettingsNeedRestart: Bool {
        LocalSettingsLogic.needsRestart(applied: extensions, wanted: loadsLocalSettingsForProject, supported: supportsSessionTools)
    }

    /// What goes to the engine right before `open_project` / `switch_project` for `url`: the project's local-settings choice.
    func projectSessionSettings(for url: URL) -> EngineSettings {
        var settings = EngineSettings()
        settings.loadLocalSettings = AppSettings.loadLocalSettings(root: AppSettings.projectKey(url), defaults: settingsDefaults)
        // MARK: wave6 w6-statusline — §44.2: the project's own statusLine command allowed here ("" none), never the last project's.
        settings.allowedProjectStatusLine = AppSettings.allowedProjectStatusLine(root: AppSettings.projectKey(url), defaults: settingsDefaults)
        return settings
    }
}
