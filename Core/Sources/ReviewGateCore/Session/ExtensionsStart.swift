import Foundation

// MARK: wave3 mac-session
// docs/PROTOCOL.md §36.7 on the client: while the CLI starts, what it waits for ("serena 기다리는 중", from
// `session.extensionsWaitingOn`); after the init-timeout fallback, the HUD's "Extensions off" chip (from the existing
// `extensions.fallback`) with "Retry with extensions" (`retry_extensions`, the project reopened by an older engine). The engine
// retries once by itself when idle; the banner the user closed stays closed for the project.

public enum ExtensionsStartText {
    /// "Waiting for serena" — or the kind of thing when the signal named none.
    public static func waiting(_ waiting: ExtensionsWaitingOn) -> String {
        let subject = waiting.name ?? noun(waiting.kind)
        return String(localized: "Waiting for \(subject)", bundle: .module)
    }

    /// The tooltip: what Claude Code is doing with it.
    public static func detail(_ waiting: ExtensionsWaitingOn) -> String {
        guard let name = waiting.name else {
            return String(localized: "Claude Code is loading extensions", bundle: .module)
        }
        switch waiting.kind {
        case .hook: return String(localized: "Claude Code is running a hook: \(name)", bundle: .module)
        case .mcp: return String(localized: "Claude Code is connecting the MCP server \(name)", bundle: .module)
        case .plugin: return String(localized: "Claude Code is installing the plugin \(name)", bundle: .module)
        case .unknown: return String(localized: "Claude Code is loading extensions: \(name)", bundle: .module)
        }
    }

    static func noun(_ kind: ExtensionsWaitingOn.Kind) -> String {
        switch kind {
        case .hook: String(localized: "a hook", bundle: .module)
        case .mcp: String(localized: "an MCP server", bundle: .module)
        case .plugin: String(localized: "a plugin", bundle: .module)
        case .unknown: String(localized: "extensions", bundle: .module)
        }
    }
}

public extension AppState {
    /// What the starting CLI waits for; nil once it initialized (a stale value is never shown).
    var extensionsWaitingOn: ExtensionsWaitingOn? {
        guard projectInfo != nil, isClaudeCodeStarting else { return nil }
        return sessionInfo.extensionsWaitingOn
    }

    /// "Extensions off": the session runs without the user's extensions since the init-timeout fallback — until a retry
    /// succeeds or the project is reopened (the chip never goes away by being dismissed).
    var extensionsOff: ExtensionsFallback? {
        guard projectInfo != nil else { return nil }
        return sessionInfo.extensions?.fallback
    }

    /// The fallback banner: as before, but once closed it stays closed for this project (the engine's own retry may fall
    /// back again; the chip says so).
    var extensionsFallbackBanner: ExtensionsFallback? {
        sessionTools.fallbackBannerSilenced ? nil : extensionsFallback
    }

    /// Whether "Retry with extensions" can run now, else why not.
    var extensionsRetryBlockedReason: String? {
        if sessionTools.isRetryingExtensions || isStarting { return String(localized: "Claude is still starting — wait a moment", bundle: .module) }
        if isRunning || isSnapshotting || isReverting { return String(localized: "Claude is working — wait for the turn to finish", bundle: .module) }
        return nil
    }
}
