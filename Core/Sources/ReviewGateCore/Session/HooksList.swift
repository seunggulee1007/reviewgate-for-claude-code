import Foundation

// MARK: §72.1 — docs/PROTOCOL.md §72.1: `/hooks` in a classic chat — the hooks in effect, read-only, as the terminal's
// `/hooks` browser lists them: each one's event, matcher, what it runs and where it is defined. The engine reads the
// settings files the session loads (`hooks_list`); the app shows them and opens a file in the editor. The wire, the
// words and the store's action.

/// §72.1 where a hook is defined.
public enum HookSource: String, Sendable, Equatable, CaseIterable {
    case user, project, local, plugin, managed
}

/// §72.1 one hook handler of `hooks_list`.
public struct HookEntry: Sendable, Equatable, Decodable, Identifiable {
    public var event: String
    /// "" — every one (the CLI's `"*"`, `""` or none).
    public var matcher: String
    public var type: String
    /// What it runs: the command, the URL, `server › tool`, the prompt.
    public var text: String
    public var condition: String?
    public var timeout: Double?
    public var async: Bool
    public var statusMessage: String?
    public var source: HookSource
    public var plugin: String?
    public var path: String
    public var active: Bool

    public var id: String { "\(event)|\(source.rawValue)|\(plugin ?? "")|\(path)|\(matcher)|\(text)" }

    public init(event: String, matcher: String = "", type: String = "command", text: String, condition: String? = nil, timeout: Double? = nil,
                async: Bool = false, statusMessage: String? = nil, source: HookSource, plugin: String? = nil, path: String, active: Bool = true) {
        self.event = event
        self.matcher = matcher
        self.type = type
        self.text = text
        self.condition = condition
        self.timeout = timeout
        self.async = async
        self.statusMessage = statusMessage
        self.source = source
        self.plugin = plugin
        self.path = path
        self.active = active
    }

    private enum CodingKeys: String, CodingKey { case event, matcher, type, text, condition = "if", timeout, async, statusMessage, source, plugin, path, active }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = try c.decode(String.self, forKey: .event)
        guard let source = HookSource(rawValue: lenientValue(String.self, c, .source) ?? "") else {
            throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "unknown hook source")
        }
        self.source = source
        matcher = lenientValue(String.self, c, .matcher) ?? ""
        type = lenientValue(String.self, c, .type) ?? "command"
        text = lenientValue(String.self, c, .text) ?? ""
        condition = lenientValue(String.self, c, .condition)
        timeout = lenientValue(Double.self, c, .timeout)
        async = lenientValue(Bool.self, c, .async) ?? false
        statusMessage = lenientValue(String.self, c, .statusMessage)
        plugin = lenientValue(String.self, c, .plugin)
        path = lenientValue(String.self, c, .path) ?? ""
        active = lenientValue(Bool.self, c, .active) ?? true
    }
}

/// §72.1 a settings file `hooks_list` read (`exists` false: the session would read it, it is not there yet).
public struct HookFile: Sendable, Equatable, Decodable, Identifiable {
    public var source: HookSource
    public var plugin: String?
    public var path: String
    public var exists: Bool
    public var count: Int

    public var id: String { path }

    public init(source: HookSource, plugin: String? = nil, path: String, exists: Bool = true, count: Int = 0) {
        self.source = source
        self.plugin = plugin
        self.path = path
        self.exists = exists
        self.count = count
    }

    private enum CodingKeys: String, CodingKey { case source, plugin, path, exists, count }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let source = HookSource(rawValue: lenientValue(String.self, c, .source) ?? "") else {
            throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "unknown hook source")
        }
        self.source = source
        plugin = lenientValue(String.self, c, .plugin)
        path = try c.decode(String.self, forKey: .path)
        exists = lenientValue(Bool.self, c, .exists) ?? true
        count = lenientValue(Int.self, c, .count) ?? 0
    }
}

/// §72.1 why the settings and plugin hooks do not run.
public enum HooksOff: String, Sendable, Equatable {
    case app, settings, managedOnly = "managed_only", managed
}

/// §72.1 reply to `hooks_list`.
public struct HooksList: Sendable, Equatable, Decodable {
    public var hooks: [HookEntry]
    public var files: [HookFile]
    public var off: HooksOff?

    public init(hooks: [HookEntry], files: [HookFile], off: HooksOff? = nil) {
        self.hooks = hooks
        self.files = files
        self.off = off
    }

    private enum CodingKeys: String, CodingKey { case hooks, files, off }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hooks = lenientElements(HookEntry.self, c, .hooks)
        files = lenientElements(HookFile.self, c, .files)
        off = lenientValue(String.self, c, .off).flatMap(HooksOff.init(rawValue:))
    }

    /// The hooks by event, in the engine's (the terminal's lifecycle) order; with `allEvents`, every event the terminal
    /// knows, an empty one too (the terminal's "All events").
    public func byEvent(allEvents: Bool = false) -> [(event: String, hooks: [HookEntry])] {
        var order: [String] = []
        var groups: [String: [HookEntry]] = [:]
        for h in hooks {
            if groups[h.event] == nil { order.append(h.event) }
            groups[h.event, default: []].append(h)
        }
        let events = allEvents ? HooksText.events + order.filter { !HooksText.events.contains($0) } : order
        return events.map { ($0, groups[$0] ?? []) }
    }
}

/// §72.1: the words of `/hooks`.
public enum HooksText {
    /// The hooks reference's 34 events, in its lifecycle order (2026-11).
    public static let events = [
        "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreSkillShellCommand", "PreToolUse", "PermissionRequest",
        "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "MessageDisplay", "SubagentStart",
        "SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange",
        "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact", "PreModelSwitch",
        "PostModelSwitch", "Elicitation", "ElicitationResult", "SessionEnd",
    ]

    public static var description: String { String(localized: "Show the hooks that run — each one's event, matcher and where it is defined", bundle: .module) }
    public static var title: String { String(localized: "Hooks", bundle: .module) }
    public static var subtitle: String {
        String(localized: "Read-only, as the terminal's /hooks. To change a hook, edit the file that defines it.", bundle: .module)
    }
    public static var empty: String { String(localized: "No hooks in the settings this chat loads", bundle: .module) }
    public static var allEvents: String { String(localized: "All events", bundle: .module) }
    public static var allEventsHelp: String { String(localized: "Also list the events no hook is set for, as the terminal's All events", bundle: .module) }
    public static var noHookForEvent: String { String(localized: "No hooks", bundle: .module) }
    public static var anyMatcher: String { String(localized: "Any", bundle: .module) }
    public static var openInEditor: String { String(localized: "Open in Editor", bundle: .module) }
    public static var inactive: String { String(localized: "Off", bundle: .module) }
    public static var loading: String { String(localized: "Reading the settings files…", bundle: .module) }
    public static var sessionNote: String {
        String(localized: "Hooks a skill or subagent adds while it runs are in no settings file and are not listed.", bundle: .module)
    }
    public static var filesHeading: String { String(localized: "Settings files", bundle: .module) }

    public static func source(_ source: HookSource, plugin: String?) -> String {
        switch source {
        case .user: String(localized: "User settings", bundle: .module)
        case .project: String(localized: "Project settings", bundle: .module)
        case .local: String(localized: "Local settings", bundle: .module)
        case .plugin: plugin.map { String(localized: "Plugin \($0)", bundle: .module) } ?? String(localized: "Plugin", bundle: .module)
        case .managed: String(localized: "Managed policy", bundle: .module)
        }
    }

    /// The matcher as the row shows it: "Bash", or "Any" for every one.
    public static func matcher(_ m: String) -> String { m.isEmpty ? anyMatcher : m }

    /// "if Bash(rm *) · 30 s timeout · async" — what else the handler says, "" when nothing.
    public static func details(_ h: HookEntry) -> String {
        var parts: [String] = []
        if let c = h.condition { parts.append(String(localized: "if \(c)", bundle: .module)) }
        if let t = h.timeout { parts.append(String(localized: "\(Int(t.rounded())) s timeout", bundle: .module)) }
        if h.async { parts.append(String(localized: "runs in the background", bundle: .module)) }
        if let s = h.statusMessage { parts.append("“\(s)”") }
        return parts.joined(separator: " · ")
    }

    /// The line over the list when the hooks do not run; nil when they do.
    public static func off(_ off: HooksOff?) -> String? {
        switch off {
        case .app?: String(localized: "Your hooks are off in ReviewGate (Settings › Extensions) — they are listed but do not run. ReviewGate's own safety hooks still run.", bundle: .module)
        case .settings?: String(localized: "disableAllHooks is on in your settings — these hooks are listed but do not run.", bundle: .module)
        case .managedOnly?: String(localized: "Your organization's policy allows only its managed hooks — the others do not run.", bundle: .module)
        case .managed?: String(localized: "Your organization's policy turned off every hook.", bundle: .module)
        case nil: nil
        }
    }

    /// Open in Editor's tooltip, or why it is disabled.
    public static func openHelp(_ path: String, exists: Bool) -> String {
        exists ? String(localized: "Open \(SessionNotices.abbreviatingHome(path)) in your editor", bundle: .module)
               : String(localized: "\(SessionNotices.abbreviatingHome(path)) does not exist yet — this chat would read it", bundle: .module)
    }

    /// The count in an event's heading.
    public static func count(_ n: Int) -> String { String(localized: "\(n) hooks", bundle: .module) }
}

public extension AppState {
    /// §72.1 `hooks_list`. Throws the engine's refusal.
    func hooksList() async throws -> HooksList {
        if let debugHooksList { return debugHooksList }   // the screenshot tour
        let reply = try await reply(.hooksList)
        guard case let .hooksList(list) = reply else { throw EngineClientError.unexpectedReply(String(describing: reply)) }
        return list
    }
}
