import Foundation

// MARK: wave4b w4-notify

/// Settings › Notifications turns each group on or off (unset → on): what waits for an answer (permission requests,
/// questions, plans), a finished turn, and everything else (errors, side questions, other sessions, subagents).
/// Electron's `notifyGroupOf` (src/main/notify.ts) sorts its kinds the same way.
public enum NotificationGroup: String, Sendable, CaseIterable {
    case waiting, turnEnd, other

    public init(kind: AttentionEvent.Kind) {
        switch kind {
        case .permission, .question, .plan: self = .waiting
        case .turnFinished: self = .turnEnd
        default: self = .other
        }
    }

    /// The UserDefaults switch (Bool; unset → on).
    public var defaultsKey: String {
        switch self {
        case .waiting: "notifyWaiting"
        case .turnEnd: "notifyTurnEnd"
        case .other: "notifyOther"
        }
    }
}

public extension AppSettings {
    /// One group's switch in Settings › Notifications; unset → true. The app's own switch (`notificationsEnabled`) is above.
    static func notifies(_ group: NotificationGroup, defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: group.defaultsKey) == nil ? true : defaults.bool(forKey: group.defaultsKey)
    }

    /// The window's "notifications are off in macOS" notice was closed (it is shown once; Settings keeps saying it).
    static let notificationsOffNoticeDismissedKey = "notificationsOffNoticeDismissed"
}

/// What macOS lets ReviewGate show — `UNNotificationSettings` reduced to what Settings and the window say.
public enum SystemNotificationStatus: String, Sendable, Equatable {
    /// Not read yet.
    case unknown
    /// macOS never asked (it asks once: at launch, or when Notifications are turned on here).
    case notDetermined
    /// Off in System Settings › Notifications › ReviewGate.
    case denied
    /// Allowed, but the alert style is None: they only collect in Notification Center, no banner.
    case noBanners
    case allowed
}

/// Why the user will not see notifications although the app's own switch is on.
public enum NotificationProblem: Sendable, Equatable {
    case systemOff, noBanners

    public var text: String {
        switch self {
        case .systemOff: String(localized: "Notifications for ReviewGate are off in macOS", bundle: .module)
        case .noBanners: String(localized: "ReviewGate notifications come without a banner — they only collect in Notification Center", bundle: .module)
        }
    }

    public var detail: String {
        String(localized: "Turn them on in System Settings › Notifications › ReviewGate to hear about permission requests and finished work while you are away.", bundle: .module)
    }
}

public enum NotificationHealth {
    /// The line for Settings › Notifications; nil when nothing stands in the way (or the app's own switch is off — the
    /// user chose that).
    public static func problem(appEnabled: Bool, system: SystemNotificationStatus) -> NotificationProblem? {
        guard appEnabled else { return nil }
        switch system {
        case .denied: return .systemOff
        case .noBanners: return .noBanners
        case .unknown, .notDetermined, .allowed: return nil
        }
    }

    /// The window says it once (until closed), and only for notifications that macOS turned off altogether.
    public static func showsWindowNotice(appEnabled: Bool, system: SystemNotificationStatus, dismissed: Bool) -> Bool {
        !dismissed && problem(appEnabled: appEnabled, system: system) == .systemOff
    }

    /// macOS is asked up front (launch, the switch turned on) instead of at the first notification, which would be
    /// lost while the question waits.
    public static func asksUpFront(appEnabled: Bool, system: SystemNotificationStatus) -> Bool {
        appEnabled && system == .notDetermined
    }
}

/// Where a click on a notification takes the user: its window, its chat and the card / summary it was about. Kept in
/// the notification's `userInfo` (strings only) next to `projectPath`.
public struct AttentionTarget: Sendable, Equatable {
    public var kind: AttentionEvent.Kind
    /// `state.sessions.currentId` when it was posted (the chat tab to open); nil on engines without chats.
    public var chatId: String?
    /// The permission / question card's request.
    public var requestId: String?

    public init(kind: AttentionEvent.Kind, chatId: String?, requestId: String?) {
        self.kind = kind
        self.chatId = chatId
        self.requestId = requestId
    }

    private static let kindKey = "attentionKind"
    private static let chatKey = "attentionChat"
    private static let requestKey = "attentionRequest"

    public var userInfo: [String: String] {
        var info = [Self.kindKey: kind.rawValue]
        if let chatId { info[Self.chatKey] = chatId }
        if let requestId { info[Self.requestKey] = requestId }
        return info
    }

    /// nil for a notification without a target (posted by an older build) or of a kind this build does not know.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let raw = userInfo[Self.kindKey] as? String, let kind = AttentionEvent.Kind(rawValue: raw) else { return nil }
        self.init(kind: kind, chatId: userInfo[Self.chatKey] as? String, requestId: userInfo[Self.requestKey] as? String)
    }
}

public enum AttentionReveal {
    /// wave4b integration (§39.2 × §39.6): the chat a clicked notification shows — a click never switches the Claude
    /// session. Its own notification (or one without a chat) shows the running chat, also when another chat is shown
    /// read-only (its card is there); one from a chat the session has left since shows that chat read-only while its tab
    /// is open; nil: its tab is closed (the window only comes forward). Electron: renderer/notifyClick.ts.
    public static func chatToShow(for target: AttentionTarget, currentChatId: String?, openTabIds: [String]) -> String? {
        guard let chat = target.chatId, chat != currentChatId else { return currentChatId }
        return openTabIds.contains(chat) ? chat : nil
    }

    /// The transcript row a clicked notification scrolls to: the permission / question card, the plan still waiting,
    /// the finished turn's summary card (else its end line). nil = no row (the window just comes forward).
    public static func row(for target: AttentionTarget, in transcript: [ChatItem]) -> UUID? {
        switch target.kind {
        case .permission, .question:
            guard let requestId = target.requestId else { return nil }
            return transcript.last {
                if case let .permission(_, request, _) = $0 { return request.requestId == requestId }
                return false
            }?.id
        case .plan:
            // The newest plan row: a proposal still waiting (an approval row after it means it was answered).
            guard let last = transcript.last(where: { if case .plan = $0 { return true }; return false }),
                  case let .plan(id, _, _, approvedMode) = last, approvedMode == nil else { return nil }
            return id
        case .turnFinished:
            var end: UUID?
            for item in transcript.reversed() {
                switch item {
                case .user: return end
                case let .turnSummary(id, _): return id
                case let .turnEnd(id, _): if end == nil { end = id }
                default: continue
                }
            }
            return end
        default:
            return nil
        }
    }
}
