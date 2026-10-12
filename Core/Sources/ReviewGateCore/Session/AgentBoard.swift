import Foundation

// MARK: wave5 w5-board
// docs/PROTOCOL.md §43.1 — the agent board ("관제판"): a window per project window with three tabs (agents, sub-brain, code
// graph) that remembers its place and tab, and the agents tab's one-line summary ("지금 3명 일하는 중 · 1명 권한 대기 ·
// 오늘 12명 다녀감"). Electron's `renderer/agentAvatar.ts` (`boardSummary`) counts the same way.

/// The board's tabs, in their order (the raw values are what the board remembers).
public enum BoardTab: String, CaseIterable, Sendable, Identifiable {
    case agents, brain, graph
    public var id: String { rawValue }
}

/// What the board remembers per project (`AppSettings.projectKey`): its tab, whether it was open (it comes back with the
/// project's window), and the name its frame is saved under.
public enum BoardPrefs {
    static func key(_ what: String, project: String) -> String { "board.\(what).\(project)" }

    public static func tab(project: String, defaults: UserDefaults = .standard) -> BoardTab {
        defaults.string(forKey: key("tab", project: project)).flatMap(BoardTab.init(rawValue:)) ?? .agents
    }

    public static func setTab(_ tab: BoardTab, project: String, defaults: UserDefaults = .standard) {
        defaults.set(tab.rawValue, forKey: key("tab", project: project))
    }

    public static func wasOpen(project: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: key("open", project: project))
    }

    public static func setOpen(_ open: Bool, project: String, defaults: UserDefaults = .standard) {
        if open { defaults.set(true, forKey: key("open", project: project)) } else { defaults.removeObject(forKey: key("open", project: project)) }
    }

    /// The `NSWindow` frame autosave name of the project's board (a stable hash: autosave names are UserDefaults keys).
    public static func frameName(project: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in project.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        return "ReviewGate Board \(String(hash, radix: 16))"
    }
}

/// The agents tab's summary line.
public struct AgentBoardSummary: Sendable, Equatable {
    /// Live subagents doing something (not waiting, not paused).
    public var working = 0
    /// Agents (the main one included) waiting for a permission answer.
    public var waiting = 0
    /// Live subagents whose API request the CLI retries.
    public var retrying = 0
    /// Distinct subagents that started today (this turn's and the chat's earlier turns').
    public var today = 0

    public init(working: Int = 0, waiting: Int = 0, retrying: Int = 0, today: Int = 0) {
        self.working = working
        self.waiting = waiting
        self.retrying = retrying
        self.today = today
    }

    /// `awaiting`: whether that subagent waits for a permission answer; `mainWaiting`: the main agent does.
    public static func of(agents: [AgentNode], history: [AgentNode], awaiting: (AgentNode) -> Bool, mainWaiting: Bool = false,
                          now: Date = Date(), calendar: Calendar = .current) -> AgentBoardSummary {
        var s = AgentBoardSummary()
        for a in agents {
            switch AgentMood.of(a, awaitingPermission: awaiting(a)) {
            case .working: s.working += 1
            case .waiting: s.waiting += 1
            case .retrying: s.retrying += 1
            default: break
            }
        }
        if mainWaiting { s.waiting += 1 }
        let dayStart = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
        var seen: Set<String> = []
        for a in agents + history where a.startedAt >= dayStart && seen.insert(a.toolUseId).inserted { s.today += 1 }
        return s
    }

    /// The line's parts, most urgent first; one quiet part when nothing is going on.
    public var parts: [String] {
        var out: [String] = []
        if working > 0 { out.append(String(localized: "\(working) working now", bundle: .module)) }
        if waiting > 0 { out.append(String(localized: "\(waiting) waiting for permission", bundle: .module)) }
        if retrying > 0 { out.append(String(localized: "\(retrying) retrying", bundle: .module)) }
        if out.isEmpty {
            out.append(today > 0 ? String(localized: "Everyone is resting", bundle: .module)
                : String(localized: "All quiet — subagents gather here when Claude calls them", bundle: .module))
        }
        if today > 0 { out.append(String(localized: "\(today) visited today", bundle: .module)) }
        return out
    }

    public var text: String { parts.joined(separator: " · ") }
}
