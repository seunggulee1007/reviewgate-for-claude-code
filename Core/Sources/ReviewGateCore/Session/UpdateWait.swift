import Foundation

// MARK: polish p-lifecycle — PX-update-wait / P5-sheets-48: the update's restart waits for Claude, and says for which
// window and why (each line brings that window to the front); a window that has said nothing for two minutes while
// "working" no longer holds it — a turn whose end was missed must not hold an update forever (the 0.5.9 report: "Claude is
// working" while nothing ran in any window). "지금 다시 시작" restarts anyway, asked once. The restart reopens the windows
// even with "Reopen last projects" off — it was not the user's quit. docs/PROTOCOL.md §55.9.

/// One window as the update's wait sees it.
public struct UpdateWaitWindow: Equatable, Sendable {
    /// The project's name ("acme-api"); "" without one.
    public var name: String
    /// Why closing it would stop Claude (`AppState.closeGuardReason`); nil when idle.
    public var reason: CloseGuardReason?
    /// When its engine last said anything (`AppState.lastEngineEventAt`); nil: never.
    public var lastEventAt: Date?

    public init(name: String, reason: CloseGuardReason?, lastEventAt: Date?) {
        self.name = name
        self.reason = reason
        self.lastEventAt = lastEventAt
    }
}

public enum UpdateWait {
    /// A window "working" this long with no word from its engine is not waited for.
    public static let staleAfter: TimeInterval = 120

    /// A window the restart waits for.
    public struct Blocker: Equatable, Sendable {
        /// Its place in the list `decide` was given.
        public var index: Int
        public var name: String
        public var reason: CloseGuardReason

        public init(index: Int, name: String, reason: CloseGuardReason) {
            self.index = index
            self.name = name
            self.reason = reason
        }
    }

    public struct Decision: Equatable, Sendable {
        public var blockers: [Blocker]
        /// The windows "working" without a word for `staleAfter` — counted as idle.
        public var stale: [String]
        public var restartsNow: Bool { blockers.isEmpty }

        public init(blockers: [Blocker], stale: [String]) {
            self.blockers = blockers
            self.stale = stale
        }
    }

    public static func decide(_ windows: [UpdateWaitWindow], now: Date) -> Decision {
        var blockers: [Blocker] = []
        var stale: [String] = []
        for (index, window) in windows.enumerated() {
            guard let reason = window.reason else { continue }
            // A card waits for the user for as long as it takes; only a turn can have ended unseen.
            if reason == .working, let last = window.lastEventAt, now.timeIntervalSince(last) > staleAfter {
                stale.append(window.name)
                continue
            }
            blockers.append(Blocker(index: index, name: window.name, reason: reason))
        }
        return Decision(blockers: blockers, stale: stale)
    }

    /// "acme-api: Claude가 작업 중이에요" / "acme-api: 답을 기다리는 카드가 있어요" (a window without a project is "ReviewGate").
    public static func line(_ blocker: Blocker) -> String {
        let name = shown(blocker.name)
        return switch blocker.reason {
        case .working: String(localized: "\(name): Claude is working", bundle: .module)
        case .waiting: String(localized: "\(name): a card waits for your answer", bundle: .module)
        }
    }

    /// "acme-api: 2분 넘게 소식이 없어 쉬는 것으로 봤어요".
    public static func staleLine(_ name: String) -> String {
        String(localized: "\(shown(name)): no word from Claude for over 2 minutes — counted as idle", bundle: .module)
    }

    private static func shown(_ name: String) -> String { name.isEmpty ? "ReviewGate" : name }

    public static var restartNowButton: String { String(localized: "Restart Now", bundle: .module) }
    public static var restartNowTitle: String { String(localized: "Restart now?", bundle: .module) }
    public static var restartNowMessage: String { String(localized: "The turns that run are stopped.", bundle: .module) }
}

public extension AppSettings.Key {
    /// P5-sheets-48: the next launch reopens the windows once, whatever "Reopen last projects" says (Bool).
    static let restoreOnceAfterRelaunch = "restoreOnceAfterRelaunch"
}

public extension AppSettings {
    /// An update's restart or the move to Applications: the next launch reopens these windows.
    static func setRestoreOnceAfterRelaunch(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: Key.restoreOnceAfterRelaunch)
    }

    /// True once after `setRestoreOnceAfterRelaunch` (it is cleared).
    static func takeRestoreOnceAfterRelaunch(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.bool(forKey: Key.restoreOnceAfterRelaunch) else { return false }
        defaults.removeObject(forKey: Key.restoreOnceAfterRelaunch)
        return true
    }
}
