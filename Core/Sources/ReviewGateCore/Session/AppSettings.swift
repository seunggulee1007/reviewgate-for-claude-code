import Foundation

/// M18: the appearance the app forces on every window, menu and sheet. `system` follows macOS.
public enum Appearance: String, Sendable, CaseIterable, Identifiable, Codable {
    case system, light, dark

    public var id: String { rawValue }

    /// Localized name for the Settings picker.
    public var displayName: String {
        switch self {
        case .system: String(localized: "System", bundle: .module)
        case .light: String(localized: "Light", bundle: .module)
        case .dark: String(localized: "Dark", bundle: .module)
        }
    }
}

/// UserDefaults-backed settings shared by Core and the SwiftUI Settings scene.
public enum AppSettings {
    public enum Key {
        public static let budgetMaxFiles = "budgetMaxFiles"
        public static let budgetMaxLines = "budgetMaxLines"
        /// §54: the change limit is on (Bool, unset → off); only then do `budgetMaxFiles` / `budgetMaxLines` reach the engine.
        public static let budgetEnabled = "budgetEnabled"
        public static let systemPromptAppend = "systemPromptAppend"
        public static let nodePath = "nodePath"
        public static let claudePath = "claudePath"
        public static let checkpointIgnorePatterns = "checkpointIgnorePatterns"
        public static let autoAllowBash = "autoAllowBash"
        public static let loadUserSettings = "loadUserSettings"
        public static let recentProjects = "recentProjects"
        /// Managed folder for workbench worktrees (M10); empty → `defaultWorktreeRoot`.
        public static let worktreeRoot = "worktreeRoot"
        /// §49 "Run as Task" (Bool, default true): the composer's and the Workbenches menu's entry.
        public static let runAsTaskEnabled = "runAsTaskEnabled"
        /// §49: the branch prefix "Run as Task" suggests (the one used last; `TaskBranchName.defaultPrefix` until then).
        public static let taskBranchPrefix = "taskBranchPrefix"
        /// JSON `SessionCapabilities` of the last `session_info`; pre-populates the palette before the first turn.
        public static let cachedCapabilities = "cachedCapabilities"
        /// M12: the commit sheet's "Push to origin" default (Bool, default false).
        public static let commitPushByDefault = "commitPushByDefault"
        /// M12: trailer line appended to every commit message (e.g. `Co-Authored-By: …`); empty → none.
        public static let commitTrailer = "commitTrailer"
        /// M13 (audit 1.4): restart the Claude session once when it dies unexpectedly (Bool, default true).
        public static let autoRestartSession = "autoRestartSession"
        /// M15: JSON `[root: ProjectUIState]` — split position, sidebar tab and selected file per project.
        public static let projectUIState = "projectUIState"
        /// M16: read-only Bash commands never ask (Bool, default true).
        public static let autoAllowReadOnlyBash = "autoAllowReadOnlyBash"
        /// M16: Claude-style allow rules, one per line (`Bash(npm test:*)`).
        public static let bashAllowPatterns = "bashAllowPatterns"
        /// M18: forced appearance (`Appearance.rawValue`); unset → `.system`.
        public static let appearance = "appearance"
        /// M19: JSON `[OpenWindowState]` — the project windows that were open at last quit.
        public static let openWindows = "openWindows"
        /// M19: reopen those windows on the next launch (Bool, default true).
        public static let reopenLastProjects = "reopenLastProjects"
        /// M20: JSON `[projectKey: PermissionMode.rawValue]` — the last mode used per project. The reserved
        /// `"*"` entry is the last mode used anywhere and is what `hello` carries (see `permissionMode(root:)`).
        public static let permissionMode = "permissionMode"
        /// §16: plugins kept off (`name@marketplace` or a bare name), one per line; next session start.
        public static let disabledPlugins = "disabledPlugins"
        /// §16: settings-file and plugin hooks off (Bool, default false); ReviewGate's own hooks keep running.
        public static let disableUserHooks = "disableUserHooks"
        /// JSON `[projectKey: [prompt]]` — the composer's ↑ history per project, oldest first.
        public static let promptHistory = "promptHistory"
        /// JSON `[projectKey: [pattern]]` — "Always allow in this project" Bash patterns (merged after `bashAllowPatterns`).
        public static let projectBashAllowPatterns = "projectBashAllowPatterns"
        /// Post a notification when a window in the background needs you (unset → on).
        public static let notificationsEnabled = "notificationsEnabled"
        /// Notifications play the default sound (unset → on).
        public static let notificationSound = "notificationSound"
        /// §21: model of side questions; empty = the main model.
        public static let sideModel = "sideModel"
        /// §21: side questions may use WebFetch / WebSearch (unset → true).
        public static let sideAllowWeb = "sideAllowWeb"
        // MARK: wave4b w4b-auto
        /// §39.5: Settings › "시작 모드" — the mode a project opened for the first time starts in (unset → the last mode used
        /// anywhere, `permissionMode`'s `"*"`).
        public static let startPermissionMode = "startPermissionMode"
    }

    public static let defaultWorktreeRoot = "~/.reviewgate/worktrees"
    public static let defaultMaxFiles = 10
    public static let defaultMaxLines = 400
    public static let hardMultiplier = 2.0
    /// Paths written by tooling (user hooks, local config) that must never show up in the review list.
    /// `.claude/settings.json` is deliberately not ignored: edits to the project's shared settings are reviewable.
    public static let defaultIgnorePatterns = [".omc/", ".claude/settings.local.json"]
    public static var defaultIgnorePatternsText: String { defaultIgnorePatterns.joined(separator: "\n") }

    /// The append Claude gets unless the user wrote their own. §54: nothing about small units, stopping or waiting.
    public static let defaultSystemPromptAppend = """
    You are working inside a review gate. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user asks — the app shows the user an approval card for each.
    """

    /// §54: what the default append adds while the change limit is on; `{maxFiles}` / `{maxLines}` are substituted.
    public static let budgetPromptSentence = "The user set a change limit of {maxFiles} files and about {maxLines} changed lines per reply: plan each reply to fit it. If an edit is denied with 'REVIEW GATE', report what you changed and what remains."

    /// §54: the built-in appends of earlier versions (Settings' "Reset to default" stored one). A stored copy is the default now.
    static let legacySystemPromptAppends: Set<String> = [
        "You are working inside a review gate. Work in small units: at most {maxFiles} files and about {maxLines} changed lines per reply. After finishing one unit, STOP and report what you changed and what the next unit would be; wait for the user. Run git commands that change the repository (commit, merge, pull, checkout, reset, stash, …) only when the user asks — the app shows the user an approval card for each. If an edit is denied with 'REVIEW GATE', stop immediately and report.",
        "You are working inside a review gate. Work in small units: at most {maxFiles} files and about {maxLines} changed lines per reply. After finishing one unit, STOP and report what you changed and what the next unit would be; wait for the user. Never run git commit/checkout/reset/stash/clean — the app manages git. If an edit is denied with 'REVIEW GATE', stop immediately and report.",
    ]

    /// §54: Settings' change-limit switch (unset → off).
    public static func budgetEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.budgetEnabled)
    }

    /// The change limit's numbers as set in Settings (10 / 400 until changed), whether the limit is on or not.
    public static func budgetLimits(defaults: UserDefaults = .standard) -> Budget {
        let files = defaults.integer(forKey: Key.budgetMaxFiles)
        let lines = defaults.integer(forKey: Key.budgetMaxLines)
        return Budget(maxFiles: files > 0 ? files : defaultMaxFiles,
                      maxLines: lines > 0 ? lines : defaultMaxLines,
                      hardMultiplier: hardMultiplier)
    }

    /// `Settings.budget`: the limits while the switch is on, else `Budget.off` — no change budget (§54).
    public static func budget(defaults: UserDefaults = .standard) -> Budget {
        budgetEnabled(defaults: defaults) ? budgetLimits(defaults: defaults) : .off
    }

    /// Stored as one pattern per line under `Key.checkpointIgnorePatterns`; unset → `defaultIgnorePatterns`.
    public static func ignorePatterns(defaults: UserDefaults = .standard) -> [String] {
        guard let raw = defaults.string(forKey: Key.checkpointIgnorePatterns) else { return defaultIgnorePatterns }
        return raw.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    public static func autoAllowBash(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.autoAllowBash)
    }

    /// `Settings.loadUserSettings`: also load `~/.claude/settings.json` (skills, plugins, slash commands, MCP servers).
    /// Default true; the sidecar's ask hook keeps user `permissions.allow` rules from bypassing the permission card.
    public static func loadUserSettings(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.loadUserSettings) == nil ? true : defaults.bool(forKey: Key.loadUserSettings)
    }

    /// Tool names passed as `Settings.autoAllowTools` (edit tools are always auto-allowed by the engine).
    public static func autoAllowTools(defaults: UserDefaults = .standard) -> [String] {
        autoAllowBash(defaults: defaults) ? ["Bash"] : []
    }

    /// M16: unset → true.
    public static func autoAllowReadOnlyBash(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.autoAllowReadOnlyBash) == nil ? true : defaults.bool(forKey: Key.autoAllowReadOnlyBash)
    }

    /// M16: stored one rule per line under `Key.bashAllowPatterns`; blank lines and `#` comments are skipped.
    public static func bashAllowPatterns(defaults: UserDefaults = .standard) -> [String] {
        (defaults.string(forKey: Key.bashAllowPatterns) ?? "").split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    // MARK: Permission mode (M20, docs/M20-MODES.md)

    /// The mode stored for `root` (a `projectKey`), else Settings › 시작 모드, else the last mode used anywhere — 자동 included
    /// (§40.1: keeping it out started every new worktree of a repository worked in auto mode in 기본, a card for every
    /// command) — else `.default`. A worktree whose repository's other worktrees ran in ReviewGate starts as they ran last:
    /// the engine applies that before this value (§11).
    public static func permissionMode(root: String? = nil, defaults: UserDefaults = .standard) -> PermissionMode {
        let modes = permissionModes(defaults: defaults)
        if let root, let mode = modes[root].flatMap(PermissionMode.init(rawValue:)) { return mode }
        if let start = startPermissionMode(defaults: defaults) { return start }   // wave4b w4b-auto (§39.5)
        return modes["*"].flatMap(PermissionMode.init(rawValue:)) ?? .default
    }

    // MARK: wave4b w4b-auto (§39.5)

    /// Settings › "시작 모드", nil while unset (then a new project starts in the last mode used anywhere).
    public static func startPermissionMode(defaults: UserDefaults = .standard) -> PermissionMode? {
        defaults.string(forKey: Key.startPermissionMode).flatMap(PermissionMode.init(rawValue:))
    }

    public static func setStartPermissionMode(_ mode: PermissionMode, defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: Key.startPermissionMode)
    }

    /// Records `mode` for `root` (when known) and as the last mode used anywhere.
    public static func setPermissionMode(_ mode: PermissionMode, root: String?, defaults: UserDefaults = .standard) {
        var modes = permissionModes(defaults: defaults)
        if let root { modes[root] = mode.rawValue }
        modes["*"] = mode.rawValue
        if let data = try? JSONEncoder().encode(modes) { defaults.set(data, forKey: Key.permissionMode) }
    }

    private static func permissionModes(defaults: UserDefaults) -> [String: String] {
        guard let data = defaults.data(forKey: Key.permissionMode) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    // MARK: Appearance (M18)

    /// Unset or unrecognised → `.system`.
    public static func appearance(defaults: UserDefaults = .standard) -> Appearance {
        Appearance(rawValue: defaults.string(forKey: Key.appearance) ?? "") ?? .system
    }

    public static func setAppearance(_ appearance: Appearance, defaults: UserDefaults = .standard) {
        defaults.set(appearance.rawValue, forKey: Key.appearance)
    }

    /// The stored append — the default when unset, empty or a copy of an earlier built-in text (§54).
    public static func systemPromptAppend(defaults: UserDefaults = .standard) -> String {
        guard let raw = defaults.string(forKey: Key.systemPromptAppend), !raw.isEmpty, !isLegacySystemPromptAppend(raw) else {
            return defaultSystemPromptAppend
        }
        return raw
    }

    static func isLegacySystemPromptAppend(_ text: String) -> Bool {
        legacySystemPromptAppends.contains(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// §54, at launch: a stored copy of an earlier built-in append is removed, so Settings shows — and the app sends — the
    /// current one. A text of the user's own stays.
    public static func forgetLegacySystemPromptAppend(defaults: UserDefaults = .standard) {
        guard let raw = defaults.string(forKey: Key.systemPromptAppend), isLegacySystemPromptAppend(raw) else { return }
        defaults.removeObject(forKey: Key.systemPromptAppend)
    }

    /// The append as Claude gets it: the stored or default text — the default one followed by `budgetPromptSentence` while
    /// the change limit is on — with `{maxFiles}` / `{maxLines}` replaced by the limit's numbers (§54).
    public static func renderedSystemPromptAppend(defaults: UserDefaults = .standard) -> String {
        var template = systemPromptAppend(defaults: defaults)
        if template == defaultSystemPromptAppend && budgetEnabled(defaults: defaults) { template += " " + budgetPromptSentence }
        return renderSystemPrompt(template, budget: budgetLimits(defaults: defaults))
    }

    public static func renderSystemPrompt(_ template: String, budget: Budget) -> String {
        template
            .replacingOccurrences(of: "{maxFiles}", with: String(budget.maxFiles))
            .replacingOccurrences(of: "{maxLines}", with: String(budget.maxLines))
    }

    /// The `hello` / `set_settings` payload: rendered prompt, parsed ignore patterns, tool auto-allow list,
    /// user-settings flag, toolchain overrides and the PR browser host.
    public static func engineSettings(defaults: UserDefaults = .standard) -> EngineSettings {
        var settings = EngineSettings(
            budget: budget(defaults: defaults),
            ignorePatterns: ignorePatterns(defaults: defaults),
            autoAllowTools: autoAllowTools(defaults: defaults),
            loadUserSettings: loadUserSettings(defaults: defaults),
            systemPromptAppend: renderedSystemPromptAppend(defaults: defaults),
            claudePath: claudePathOverride(defaults: defaults),
            ghHost: PRStore.storedHost(defaults: defaults),
            worktreeRoot: worktreeRoot(defaults: defaults),
            commitPushByDefault: commitPushByDefault(defaults: defaults),
            commitTrailer: commitTrailer(defaults: defaults),
            autoRestartSession: autoRestartSession(defaults: defaults),
            autoAllowReadOnlyBash: autoAllowReadOnlyBash(defaults: defaults),
            bashAllowPatterns: bashAllowPatterns(defaults: defaults),
            permissionMode: permissionMode(defaults: defaults),
            disabledPlugins: disabledPlugins(defaults: defaults),
            disableUserHooks: disableUserHooks(defaults: defaults),
            sideModel: sideModel(defaults: defaults),
            sideAllowWeb: sideAllowWeb(defaults: defaults))
        // MARK: wave1 mac-perms — §33.4 / §33.5 / §33.7 (AppSettings+Permissions.swift)
        settings.allowWorktreeIsolation = allowWorktreeIsolation(defaults: defaults)
        settings.applyUserAllowRules = applyUserAllowRules(defaults: defaults)
        settings.persistSessionAllows = persistSessionAllows(defaults: defaults)
        // MARK: wave3 check-clients — §34.9 the user's test commands (TestCommandSettings.swift)
        settings.testCommandPatterns = testCommandPatterns(defaults: defaults)
        settings.maxTurns = maxTurns(defaults: defaults)   // MARK: wave4 w4-longwork (§38.2, LongWork.swift)
        settings.backgroundWork = backgroundWork(defaults: defaults)   // §52 (AppState+Background.swift)
        settings.largeFileMB = largeFileMB(defaults: defaults)   // MARK: wave4b w4b-bigturn (§39.1, BigTurn.swift)
        // MARK: wave4b w4b-side — §40.3 (SideTrust.swift): the web is off unless chosen; an older engine reads sideAllowWeb.
        settings.sideWeb = sideWeb(defaults: defaults).rawValue
        settings.sideAllowWeb = sideWeb(defaults: defaults) == .on
        // MARK: wave5 w5-model — §43.4 (AutoModel.swift): auto is off unless chosen in the model chip.
        settings.modelMode = modelMode(defaults: defaults).rawValue
        settings.modelAutoPolicy = autoModelPolicy(defaults: defaults).rawValue
        // MARK: wave6 w6-statusline — §44.2 (StatusLine.swift): the user's status line shows unless turned off.
        settings.showStatusLine = showStatusLine(defaults: defaults)
        // Per project: the project's own command is allowed with its settings before each open_project (projectSessionSettings).
        settings.allowedProjectStatusLine = ""
        return settings
    }

    // MARK: Side questions (docs/PROTOCOL.md §21)

    /// nil = the main session's model.
    public static func sideModel(defaults: UserDefaults = .standard) -> String? {
        let raw = defaults.string(forKey: Key.sideModel)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return raw.isEmpty ? nil : raw
    }

    /// Unset → true.
    public static func sideAllowWeb(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.sideAllowWeb) as? Bool ?? true
    }

    // MARK: User extensions (docs/PROTOCOL.md §16)

    /// Stored one id per line under `Key.disabledPlugins`; blank lines skipped, duplicates dropped (order kept).
    public static func disabledPlugins(defaults: UserDefaults = .standard) -> [String] {
        var seen = Set<String>()
        return (defaults.string(forKey: Key.disabledPlugins) ?? "").split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public static func setDisabledPlugins(_ ids: [String], defaults: UserDefaults = .standard) {
        defaults.set(ids.joined(separator: "\n"), forKey: Key.disabledPlugins)
    }

    public static func disableUserHooks(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.disableUserHooks)
    }

    /// M13: unset → true.
    public static func autoRestartSession(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.autoRestartSession) == nil ? true : defaults.bool(forKey: Key.autoRestartSession)
    }

    // MARK: Commit (docs/M12-COMMIT.md)

    public static func commitPushByDefault(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.commitPushByDefault)
    }

    /// Trimmed; empty when unset.
    public static func commitTrailer(defaults: UserDefaults = .standard) -> String {
        defaults.string(forKey: Key.commitTrailer)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// `Settings.worktreeRoot`: the stored folder (tilde-expanded) or `defaultWorktreeRoot`.
    public static func worktreeRoot(defaults: UserDefaults = .standard) -> String {
        let raw = defaults.string(forKey: Key.worktreeRoot)?.trimmingCharacters(in: .whitespaces)
        return NSString(string: (raw?.isEmpty == false) ? raw! : defaultWorktreeRoot).expandingTildeInPath
    }

    // MARK: Recent projects

    public static let maxRecentProjects = 10

    /// The single key a project folder is compared by everywhere (recents, the window registry, `openWindows`):
    /// its standardized path, so `/tmp/p1`, `/tmp/p1/` and `/tmp/./p1` are one project.
    public static func projectKey(_ url: URL) -> String { url.standardizedFileURL.path }

    /// Most recent first, at most `maxRecentProjects`. Stored under `Key.recentProjects` as an array of paths.
    public static func recentProjects(defaults: UserDefaults = .standard) -> [URL] {
        (defaults.stringArray(forKey: Key.recentProjects) ?? []).map { URL(fileURLWithPath: $0) }
    }

    /// Moves `url` to the front (deduplicated by standardized path) and trims to `maxRecentProjects`.
    public static func addRecentProject(_ url: URL, defaults: UserDefaults = .standard) {
        let path = url.standardizedFileURL.path
        if RecentProjects.isTransient(path) { return }   // MARK: wave4 w4-install (daily-17): scratch / test folders stay out
        var paths = (defaults.stringArray(forKey: Key.recentProjects) ?? []).filter { $0 != path }
        paths.insert(path, at: 0)
        if paths.count > maxRecentProjects { paths.removeLast(paths.count - maxRecentProjects) }
        defaults.set(paths, forKey: Key.recentProjects)
    }

    public static func removeRecentProject(_ url: URL, defaults: UserDefaults = .standard) {
        let path = url.standardizedFileURL.path
        let paths = (defaults.stringArray(forKey: Key.recentProjects) ?? []).filter { $0 != path }
        defaults.set(paths, forKey: Key.recentProjects)
    }

    // MARK: Open windows / session restore (M19)

    /// At most this many windows are reopened on launch.
    public static let maxRestoredWindows = 5

    /// One window of the last session: the project it had open and the frame it had on screen.
    public struct OpenWindowState: Codable, Sendable, Equatable {
        /// Standardized path of the project root (`projectKey`).
        public var path: String
        /// `NSStringFromRect` form (`{{x, y}, {w, h}}`); nil when the window's frame was unknown.
        public var frame: String?

        public init(path: String, frame: String? = nil) {
            self.path = path
            self.frame = frame
        }
    }

    /// Stored under `Key.openWindows` as a JSON array, in window order.
    public static func openWindows(defaults: UserDefaults = .standard) -> [OpenWindowState] {
        guard let data = defaults.data(forKey: Key.openWindows) else { return [] }
        return (try? JSONDecoder().decode([OpenWindowState].self, from: data)) ?? []
    }

    public static func setOpenWindows(_ windows: [OpenWindowState], defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(windows) else { return }
        defaults.set(data, forKey: Key.openWindows)
    }

    /// Settings → General "Reopen last projects on launch"; unset → true.
    public static func reopenLastProjects(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.reopenLastProjects) == nil ? true : defaults.bool(forKey: Key.reopenLastProjects)
    }

    // MARK: Per-project UI state (M15)

    /// What a window remembers per project (keyed by the repository root): split position, sidebar tab, selection.
    public struct ProjectUIState: Codable, Sendable, Equatable {
        /// Width of the diff pane as a fraction of the diff+chat split (0…1).
        public var diffFraction: Double?
        /// `MainTab.rawValue`.
        public var sidebarTab: String?
        /// Repo-relative path of the last selected changed file.
        public var selectedPath: String?
        /// M16: the diff pane is collapsed (chat takes the width); nil → collapsed while there are no changed files.
        public var diffCollapsed: Bool?
        /// M19: the window frame this project was last seen at, in `NSStringFromRect` form (`{{x, y}, {w, h}}`).
        public var frame: String?

        public init(diffFraction: Double? = nil, sidebarTab: String? = nil, selectedPath: String? = nil,
                    diffCollapsed: Bool? = nil, frame: String? = nil) {
            self.diffFraction = diffFraction
            self.sidebarTab = sidebarTab
            self.selectedPath = selectedPath
            self.diffCollapsed = diffCollapsed
            self.frame = frame
        }
    }

    /// Stored under `Key.projectUIState` as `{ "<root>": ProjectUIState }`.
    public static func projectUIState(root: String, defaults: UserDefaults = .standard) -> ProjectUIState {
        projectUIStates(defaults: defaults)[root] ?? ProjectUIState()
    }

    public static func setProjectUIState(_ state: ProjectUIState, root: String, defaults: UserDefaults = .standard) {
        var all = projectUIStates(defaults: defaults)
        all[root] = state
        if let data = try? JSONEncoder().encode(all) { defaults.set(data, forKey: Key.projectUIState) }
    }

    private static func projectUIStates(defaults: UserDefaults) -> [String: ProjectUIState] {
        guard let data = defaults.data(forKey: Key.projectUIState) else { return [:] }
        return (try? JSONDecoder().decode([String: ProjectUIState].self, from: data)) ?? [:]
    }

    // MARK: Capabilities cache

    public static func cachedCapabilities(defaults: UserDefaults = .standard) -> SessionCapabilities? {
        guard let data = defaults.data(forKey: Key.cachedCapabilities) else { return nil }
        return try? JSONDecoder().decode(SessionCapabilities.self, from: data)
    }

    public static func setCachedCapabilities(_ caps: SessionCapabilities, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(caps) { defaults.set(data, forKey: Key.cachedCapabilities) }
    }

    public static func nodePathOverride(defaults: UserDefaults = .standard) -> String? {
        let v = defaults.string(forKey: Key.nodePath)?.trimmingCharacters(in: .whitespaces)
        return (v?.isEmpty == false) ? v : nil
    }

    public static func claudePathOverride(defaults: UserDefaults = .standard) -> String? {
        let v = defaults.string(forKey: Key.claudePath)?.trimmingCharacters(in: .whitespaces)
        return (v?.isEmpty == false) ? v : nil
    }
}
