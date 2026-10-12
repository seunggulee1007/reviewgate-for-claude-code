import Foundation

// wave1 mac-perms — the §33 permission settings the Mac client keeps in UserDefaults (docs/PROTOCOL.md §33.4–33.8).

extension AppSettings.Key {
    /// §33.4: the Workflow tool and isolated (worktree) agents get a card instead of a deny (Bool, unset → false;
    /// next session start).
    public static let allowWorktreeIsolation = "allowWorktreeIsolation"
    /// §33.5: the terminal's (Claude Code) allow rules apply to lookup / read tools (Bool, unset → true; live).
    public static let applyUserAllowRules = "applyUserAllowRules"
    /// §33.7: "세션 동안 허용" answers are kept per worktree and come back when the project opens (Bool, unset → false).
    public static let persistSessionAllows = "persistSessionAllows"
    /// JSON `[projectKey]`: projects the terminal's default mode was offered for (answered either way, never asked again).
    public static let defaultModeOffered = "defaultModeOffered"
}

extension AppSettings {
    /// §33.4: unset → false.
    public static func allowWorktreeIsolation(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.allowWorktreeIsolation)
    }

    /// §33.5: unset → true.
    public static func applyUserAllowRules(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.applyUserAllowRules) as? Bool ?? true
    }

    /// §33.7: unset → false.
    public static func persistSessionAllows(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.persistSessionAllows)
    }

    /// `set_settings` carrying the three §33 switches (also part of `hello`, see `engineSettings`).
    public static func worktreePermissionSettings(defaults: UserDefaults = .standard) -> EngineSettings {
        var settings = EngineSettings()
        settings.allowWorktreeIsolation = allowWorktreeIsolation(defaults: defaults)
        settings.applyUserAllowRules = applyUserAllowRules(defaults: defaults)
        settings.persistSessionAllows = persistSessionAllows(defaults: defaults)
        return settings
    }

    /// Appends `patterns` to the global allow list (one per line under `Key.bashAllowPatterns`), skipping blanks and the
    /// ones already listed; returns what was added.
    @discardableResult
    public static func appendBashAllowPatterns(_ patterns: [String], defaults: UserDefaults = .standard) -> [String] {
        let added = newPatterns(patterns, existing: bashAllowPatterns(defaults: defaults))
        guard !added.isEmpty else { return [] }
        var raw = defaults.string(forKey: Key.bashAllowPatterns) ?? ""
        if !raw.isEmpty, !raw.hasSuffix("\n") { raw += "\n" }
        raw += added.joined(separator: "\n")
        defaults.set(raw, forKey: Key.bashAllowPatterns)
        return added
    }

    /// Appends `patterns` to `root`'s "이 프로젝트에서 항상 허용" list; returns what was added.
    @discardableResult
    public static func appendProjectAllowPatterns(_ patterns: [String], root: String, defaults: UserDefaults = .standard) -> [String] {
        let current = projectBashAllowPatterns(root: root, defaults: defaults)
        let added = newPatterns(patterns, existing: current)
        guard !added.isEmpty else { return [] }
        setProjectBashAllowPatterns(current + added, root: root, defaults: defaults)
        return added
    }

    private static func newPatterns(_ patterns: [String], existing: [String]) -> [String] {
        var seen = Set(existing)
        return patterns.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    // MARK: The terminal's default mode, offered once per project (§2.8)

    public static func defaultModeOffered(root: String, defaults: UserDefaults = .standard) -> Bool {
        offeredRoots(defaults: defaults).contains(root)
    }

    public static func markDefaultModeOffered(root: String, defaults: UserDefaults = .standard) {
        var roots = offeredRoots(defaults: defaults)
        guard !roots.contains(root) else { return }
        roots.append(root)
        if let data = try? JSONEncoder().encode(roots) { defaults.set(data, forKey: Key.defaultModeOffered) }
    }

    private static func offeredRoots(defaults: UserDefaults) -> [String] {
        guard let data = defaults.data(forKey: Key.defaultModeOffered) else { return [] }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }
}
