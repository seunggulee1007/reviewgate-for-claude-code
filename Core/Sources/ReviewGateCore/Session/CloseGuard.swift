import Foundation

// MARK: wave4 w4-safety

/// Audit daily-12 / polish-12: why closing a window (⌘W, the close button) or quitting (⌘Q) would stop Claude mid-work.
/// nil = idle — the window closes without asking.
public enum CloseGuardReason: String, Sendable, Equatable {
    /// A turn runs.
    case working
    /// Claude waits for the user: a permission card, a question (AskUserQuestion) or a plan to approve.
    case waiting

    /// Waiting wins: it is the state the user would most regret losing (the card goes away with the session).
    public static func of(isRunning: Bool, waitsForUser: Bool) -> CloseGuardReason? {
        if waitsForUser { return .waiting }
        return isRunning ? .working : nil
    }
}

/// The confirmation's words (Mac and Electron use the same keys).
public enum CloseGuardText {
    public static var title: String { String(localized: "Claude is working right now", bundle: .module) }

    /// One window being closed.
    public static func message(_ reason: CloseGuardReason) -> String {
        switch reason {
        case .working: String(localized: "Closing stops this turn.", bundle: .module)
        case .waiting: String(localized: "Claude is waiting for your answer. Closing stops this turn.", bundle: .module)
        }
    }

    /// Quit: the reasons of every window that would stop — more than one window says how many.
    public static func quitMessage(_ reasons: [CloseGuardReason]) -> String {
        if reasons.count > 1 {
            return String(localized: "Claude is working in \(reasons.count) windows. Quitting stops those turns.", bundle: .module)
        }
        return message(reasons.first ?? .working)
    }

    public static var closeButton: String { String(localized: "Close", bundle: .module) }
    public static var quitButton: String { String(localized: "Quit", bundle: .module) }
    public static var cancelButton: String { String(localized: "Cancel", bundle: .module) }
    public static var dontAskAgain: String { String(localized: "Don't ask again", bundle: .module) }
}

extension AppSettings.Key {
    /// Ask before closing a window / quitting while Claude works or waits (unset → on; "Don't ask again" turns it off).
    public static let confirmCloseWhileWorking = "confirmCloseWhileWorking"
}

extension AppSettings {
    public static func confirmCloseWhileWorking(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.confirmCloseWhileWorking) as? Bool ?? true
    }

    public static func setConfirmCloseWhileWorking(_ on: Bool, defaults: UserDefaults = .standard) {
        defaults.set(on, forKey: Key.confirmCloseWhileWorking)
    }
}

extension AppState {
    /// Why closing this window now would stop Claude (nil = idle). A question is a permission request
    /// (AskUserQuestion), so `pendingPermission` covers it.
    public var closeGuardReason: CloseGuardReason? {
        CloseGuardReason.of(isRunning: isRunning, waitsForUser: pendingPermission != nil || pendingPlan != nil)
    }

    /// The reason to ask before closing — nil when idle or when the user turned the question off.
    public func closeConfirmationReason(defaults: UserDefaults = .standard) -> CloseGuardReason? {
        guard AppSettings.confirmCloseWhileWorking(defaults: defaults) else { return nil }
        return closeGuardReason
    }
}
