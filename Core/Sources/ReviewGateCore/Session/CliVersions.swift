import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.8 on the client: the banner "New CLI x — not verified yet" from `session.cli` (once per version,
// closable in any window), "Pin previous version" (`set_settings{claudePath}` with the previous version's file; the next
// session start uses it), the `cli_version_changed` notice as a chat row only, and the installed versions (`cli_versions`)
// for Settings › General "Pin CLI version".

public enum CliVersionText {
    /// The banner's title.
    public static func banner(_ version: String) -> String {
        String(localized: "New CLI \(version) — not verified yet", bundle: .module)
    }

    /// The banner's second line.
    public static func bannerDetail(_ range: CliVersionRange?) -> String {
        guard let range else {
            return String(localized: "ReviewGate has not been checked with this version yet. If something behaves oddly, pin the previous version.", bundle: .module)
        }
        return String(localized: "ReviewGate was checked with \(range.min)–\(range.max). If something behaves oddly, pin the previous version.", bundle: .module)
    }

    /// After a pin, until the session runs it.
    public static func pinned(_ version: String) -> String {
        String(localized: "CLI \(version) pinned — restart the session to use it", bundle: .module)
    }

    /// The pinned banner's second line.
    public static func pinnedDetail(running: String) -> String {
        String(localized: "New sessions start with it; this session still runs \(running).", bundle: .module)
    }

    /// Why "Pin previous version" is off.
    public static func cannotPinPrevious(_ previous: CliPreviousVersion?) -> String {
        guard let previous else { return String(localized: "No earlier version was recorded on this Mac", bundle: .module) }
        return String(localized: "\(previous.version) is no longer installed", bundle: .module)
    }

    /// The `cli_version_changed` row: from the event's `cli`, else read back from the engine's words (a restored row).
    public static func notice(_ change: CliVersionChange?, message: String) -> String {
        guard let change = change ?? parse(message) else { return message }
        switch (change.from, change.verified) {
        case let (from?, true): return String(localized: "Claude Code changed from \(from) to \(change.to)", bundle: .module)
        case let (from?, false): return String(localized: "Claude Code changed from \(from) to \(change.to) — not verified yet", bundle: .module)
        case (nil, true): return String(localized: "Claude Code is now \(change.to)", bundle: .module)
        case (nil, false): return String(localized: "Claude Code is now \(change.to) — not verified yet", bundle: .module)
        }
    }

    /// "Claude Code changed from 2.1.307 to 2.1.308 (not verified yet)." → the change.
    static func parse(_ message: String) -> CliVersionChange? {
        guard let range = message.range(of: #"changed from (\S+) to ([0-9][0-9A-Za-z.\-+]*[0-9A-Za-z])"#, options: .regularExpression) else {
            return nil
        }
        let words = message[range].split(separator: " ")
        guard words.count >= 5 else { return nil }
        return CliVersionChange(from: String(words[2]), to: String(words[4]), verified: !message.contains("not verified"))
    }
}

/// What the CLI banner shows.
public enum CliVersionBannerState: Sendable, Equatable {
    /// A version outside the verified range; `previous.path` set = it can be pinned.
    case unverified(version: String, range: CliVersionRange?, previous: CliPreviousVersion?)
    /// Another version is pinned, the running session still uses the unverified one: restart to use the pinned one.
    case pinnedNeedsRestart(version: String, running: String)
}

public enum CliVersionPin {
    /// The version a pinned `claudePath` names — `…/versions/<ver>`, the native installer's folder; nil for any other path
    /// (a `claude` the user picked by hand).
    public static func version(ofPath path: String?) -> String? {
        guard let path = path?.trimmingCharacters(in: .whitespaces), !path.isEmpty else { return nil }
        let url = URL(fileURLWithPath: path)
        guard url.deletingLastPathComponent().lastPathComponent == "versions" else { return nil }
        let name = url.lastPathComponent
        return name.isEmpty ? nil : name
    }
}

public enum CliVersionBanner {
    /// `cli` as the session reports it, the versions closed in any window, `settings.claudePath`. Closing applies to the
    /// running version in both states.
    public static func state(cli: CliInfo?, dismissed: Set<String>, pinnedPath: String?) -> CliVersionBannerState? {
        guard let cli, cli.isUnverified, let version = cli.version, !dismissed.contains(version) else { return nil }
        if let previous = cli.previous, let path = previous.path, path == pinnedPath {
            return .pinnedNeedsRestart(version: previous.version, running: version)
        }
        if let pinned = CliVersionPin.version(ofPath: pinnedPath), pinned != version {
            return .pinnedNeedsRestart(version: pinned, running: version)
        }
        return .unverified(version: version, range: cli.verifiedRange, previous: cli.previous)
    }
}

/// One row of Settings › General "Pin CLI version".
public struct CliVersionRow: Sendable, Equatable, Identifiable {
    public var entry: CliVersionEntry
    /// The version this window's session runs.
    public var isRunning: Bool
    /// `settings.claudePath` names this file.
    public var isPinned: Bool

    public var id: String { entry.path }
}

public enum CliVersionList {
    /// The reply's versions (newest first, as the engine sent them) with what runs and what is pinned. `pinnedPath` is the
    /// app's own setting (it wins over the reply's, which may be older).
    public static func rows(_ reply: CliVersionsReply, running: String?, pinnedPath: String?) -> [CliVersionRow] {
        let current = running ?? reply.current
        return reply.versions.map { entry in
            CliVersionRow(entry: entry, isRunning: entry.version == current, isPinned: pinnedPath.map { $0 == entry.path } ?? false)
        }
    }

    /// A version file is pinned but this session runs another version: "Applies from the next session start".
    public static func pinDiffersFromRunning(pinnedPath: String?, running: String?) -> Bool {
        guard let pinned = CliVersionPin.version(ofPath: pinnedPath), let running else { return false }
        return pinned != running
    }
}

public extension AppSettings.Key {
    /// wave3 mac-session (§36.8): the CLI versions whose "not verified yet" banner was closed, newline-separated (a string
    /// so views can observe it with `@AppStorage`), app-wide.
    static let dismissedCliVersions = "dismissedCliVersions"
}

public extension AppSettings {
    static func dismissedCliVersions(defaults: UserDefaults = .standard) -> [String] {
        (defaults.string(forKey: Key.dismissedCliVersions) ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    /// Closes the banner of `version` in every window, for good (at most 50 kept).
    static func dismissCliVersion(_ version: String, defaults: UserDefaults = .standard) {
        var list = dismissedCliVersions(defaults: defaults).filter { $0 != version }
        list.append(version)
        defaults.set(list.suffix(50).joined(separator: "\n"), forKey: Key.dismissedCliVersions)
    }

    /// `Settings.claudePath`: a version file pinned, or "" / nil for the CLI on the PATH.
    static func setClaudePath(_ path: String?, defaults: UserDefaults = .standard) {
        let trimmed = path?.trimmingCharacters(in: .whitespaces) ?? ""
        if trimmed.isEmpty { defaults.removeObject(forKey: Key.claudePath) } else { defaults.set(trimmed, forKey: Key.claudePath) }
    }
}

public extension AppState {
    /// The CLI this session runs (`session.cli`); nil without a session start / on older engines.
    var cliInfo: CliInfo? { sessionInfo.cli }

    /// The banner to show, if any. Reads the app-wide settings: views observe `AppSettings.Key.dismissedCliVersions` and
    /// `AppSettings.Key.claudePath` to follow a change made in another window.
    var cliVersionBanner: CliVersionBannerState? {
        guard projectInfo != nil else { return nil }
        return CliVersionBanner.state(cli: cliInfo, dismissed: Set(AppSettings.dismissedCliVersions(defaults: settingsDefaults)),
                                      pinnedPath: AppSettings.claudePathOverride(defaults: settingsDefaults))
    }

    /// Closes the banner of `version` (every window: the list is app-wide).
    func dismissCliVersionBanner(_ version: String) {
        AppSettings.dismissCliVersion(version, defaults: settingsDefaults)
    }

    /// Pins a CLI version file: stored as `claudePath` and given to this window's engine (the next session start uses
    /// it — "Restart now"). The caller gives it to the other windows with `applyClaudePath`.
    func pinClaude(path: String) {
        AppSettings.setClaudePath(path, defaults: settingsDefaults)
        applyClaudePath(path)
    }

    /// Back to the claude on the PATH.
    func unpinClaude() {
        AppSettings.setClaudePath(nil, defaults: settingsDefaults)
        applyClaudePath("")
    }

    /// `set_settings{claudePath}` to this window's engine ("" = unpinned); nothing without a running engine (`hello` carries
    /// the stored value).
    func applyClaudePath(_ path: String) {
        guard isEngineRunning || commandSink != nil else { return }
        fire(.setSettings(EngineSettings(claudePath: path)))
    }

    /// Settings › General's rows; nil before `cli_versions` answered.
    var cliVersionRows: [CliVersionRow]? {
        sessionTools.versions.map {
            CliVersionList.rows($0, running: cliInfo?.version, pinnedPath: AppSettings.claudePathOverride(defaults: settingsDefaults))
        }
    }
}
