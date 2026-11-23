import Foundation

// docs/PROTOCOL.md §55.11 — "다음 세션부터 적용돼요 — [지금 재시작]": what a Claude session took when it started, compared with
// the settings now. The engine reads these at each session start (`startSession`), so a changed one waits for a restart
// or a new chat; Settings says so in one banner on every pane.

/// The settings a Claude session reads when it starts (`SettingApplies.nextSession`), as this Mac has them.
public struct SessionStartSettings: Equatable, Sendable {
    public var autoAllowBash: Bool
    public var loadUserSettings: Bool
    public var systemPromptAppend: String
    public var backgroundWork: Bool
    public var subagentsInTurn: Bool
    public var allowWorktreeIsolation: Bool
    public var maxTurns: Int
    public var claudePath: String?
    public var disabledPlugins: [String]
    public var disableUserHooks: Bool

    public init(autoAllowBash: Bool = false, loadUserSettings: Bool = true, systemPromptAppend: String = "", backgroundWork: Bool = true,
                subagentsInTurn: Bool = false, allowWorktreeIsolation: Bool = true, maxTurns: Int = 0, claudePath: String? = nil,
                disabledPlugins: [String] = [], disableUserHooks: Bool = false) {
        self.autoAllowBash = autoAllowBash
        self.loadUserSettings = loadUserSettings
        self.systemPromptAppend = systemPromptAppend
        self.backgroundWork = backgroundWork
        self.subagentsInTurn = subagentsInTurn
        self.allowWorktreeIsolation = allowWorktreeIsolation
        self.maxTurns = maxTurns
        self.claudePath = claudePath
        self.disabledPlugins = disabledPlugins
        self.disableUserHooks = disableUserHooks
    }

    public static func current(defaults: UserDefaults = .standard) -> SessionStartSettings {
        SessionStartSettings(
            autoAllowBash: AppSettings.autoAllowBash(defaults: defaults),
            loadUserSettings: AppSettings.loadUserSettings(defaults: defaults),
            systemPromptAppend: AppSettings.renderedSystemPromptAppend(defaults: defaults),
            backgroundWork: AppSettings.backgroundWork(defaults: defaults),
            subagentsInTurn: AppSettings.subagentsInTurn(defaults: defaults),
            allowWorktreeIsolation: AppSettings.allowWorktreeIsolation(defaults: defaults),
            maxTurns: AppSettings.maxTurns(defaults: defaults),
            claudePath: AppSettings.claudePathOverride(defaults: defaults),
            disabledPlugins: AppSettings.disabledPlugins(defaults: defaults),
            disableUserHooks: AppSettings.disableUserHooks(defaults: defaults))
    }

    /// The catalog ids (`SettingsCatalog`) of what differs from what the session started with, in catalog order. The
    /// plugins and hooks are left to the Extensions pane's own comparison with what the session applied (§16), which knows
    /// a plugin id the session did not resolve.
    public func changed(since start: SessionStartSettings) -> [String] {
        var ids: [String] = []
        if autoAllowBash != start.autoAllowBash { ids.append("autoAllowBash") }
        if allowWorktreeIsolation != start.allowWorktreeIsolation { ids.append("allowWorktreeIsolation") }
        if backgroundWork != start.backgroundWork { ids.append("backgroundWork") }
        if subagentsInTurn != start.subagentsInTurn { ids.append("subagentsInTurn") }
        if maxTurns != start.maxTurns { ids.append("maxTurns") }
        if systemPromptAppend != start.systemPromptAppend { ids.append("systemPromptAppend") }
        if loadUserSettings != start.loadUserSettings { ids.append("loadUserSettings") }
        if claudePath != start.claudePath { ids.append("claudePath") }
        return ids
    }
}

public extension AppState {
    /// The catalog ids of the settings changed since this window's Claude session started — they apply once it restarts.
    /// Empty without an open session.
    var settingsWaitingForRestart: [String] {
        guard let start = settingsAtSessionStart else { return [] }
        return SessionStartSettings.current(defaults: settingsDefaults).changed(since: start)
    }

    /// `set_settings` with what a session reads at its start and the Mac only sent with `hello` before: the Bash auto-allow,
    /// the user-settings switch and the rendered system prompt. Without it a change waited for a new window's engine (what
    /// the old "next Open Project" note meant); now a restart or a new chat takes it.
    func pushSessionStartSettings() {
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.autoAllowTools = AppSettings.autoAllowTools(defaults: settingsDefaults)
        settings.loadUserSettings = AppSettings.loadUserSettings(defaults: settingsDefaults)
        settings.systemPromptAppend = AppSettings.renderedSystemPromptAppend(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }
}

#if DEBUG
public extension AppState {
    /// The screenshot tour's restart banner (App/Debug/ScreenshotTour.swift, `SHOTS_LAYOUT=settings`); nil ends it.
    func debugSetSettingsAtSessionStart(_ start: SessionStartSettings?) { settingsAtSessionStart = start }
}
#endif

extension AppState {
    /// Keeps `settingsAtSessionStart` with the session: taken when a session starts (or the first time an open one is seen),
    /// dropped when none is open.
    func noteSessionStart(from old: SessionInfo, to new: SessionInfo) {
        guard new.open else {
            if settingsAtSessionStart != nil { settingsAtSessionStart = nil }
            return
        }
        if settingsAtSessionStart == nil || (new.starting && !old.starting) {
            settingsAtSessionStart = SessionStartSettings.current(defaults: settingsDefaults)
        }
    }
}
