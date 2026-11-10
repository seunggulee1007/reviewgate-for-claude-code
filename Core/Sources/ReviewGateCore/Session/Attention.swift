import Foundation

/// Something in a workbench that needs the user while they look elsewhere: the app posts it as a user notification
/// when the window is not in front (`AppState.onAttention`).
public struct AttentionEvent: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable {
        case turnFinished, permission, question, plan, actionNeeded
        /// §21: a side question finished answering.
        case sideAnswer
        /// §29 (wave1 mac-session): another Claude session sent a message that waits for the user (`held`).
        case peerMessage
        // MARK: wave3 mac-agents
        /// §36.4: every foreground subagent finished and Claude goes on with the turn (one per turn).
        case agentsFinished

        /// Waiting kinds block Claude until answered (the dock badge shows "!" for them).
        public var blocksClaude: Bool { self == .permission || self == .question || self == .plan }
    }

    public var kind: Kind
    public var title: String
    public var body: String
    /// Dedupe key: the same key is posted once (`AttentionCoalescer`).
    public var key: String
    // MARK: wave4b w4-notify
    /// The permission / question card it is about — a click scrolls there (`AttentionTarget`).
    public var requestId: String?

    public init(kind: Kind, title: String, body: String, key: String) {
        self.kind = kind
        self.title = title
        self.body = body
        self.key = key
    }

    /// wave4b w4-notify: "작업이 끝났어요" over "리뷰할 파일 3개" (a stop reason replaces the title, `TurnStopReason`).
    public static func turnFinished(pending: Int, key: String) -> AttentionEvent {
        AttentionEvent(kind: .turnFinished,
                       title: String(localized: "Work finished", bundle: .module),
                       body: pending > 0 ? String(localized: "\(pending) file(s) to review", bundle: .module)
                                         : String(localized: "No files to review", bundle: .module),
                       key: key)
    }

    /// wave4b w4-notify: "허용이 필요해요" (a subagent's: "허용이 필요해요 — code-reviewer 에이전트") over "Bash: <the command's
    /// first line>" (else the path or URL); a question: "Claude가 질문했어요" over its first question.
    public static func permission(_ request: PermissionRequest) -> AttentionEvent {
        var event: AttentionEvent
        if let questions = AskUserQuestions(request: request) {
            event = AttentionEvent(kind: .question, title: String(localized: "Claude asked a question", bundle: .module),
                                   body: clip(questions.questions.first?.question ?? "", 160), key: "perm:\(request.requestId)")
        } else if request.toolName == "SendMessage" {
            // §33.2: a message to another Claude session — say so instead of the bare tool name.
            event = AttentionEvent(kind: .permission,
                                   title: String(localized: "Claude wants to send a message to another session", bundle: .module),
                                   body: SendMessageCardContent(request: request).to ?? "", key: "perm:\(request.requestId)")
        } else {
            let detail = clip(request.input["command"]?.stringValue ?? request.file ?? request.input["url"]?.stringValue ?? "", 120)
            let agent = request.agent.flatMap { $0.subagentType ?? $0.description }.map { clip($0, 60) }.flatMap { $0.isEmpty ? nil : $0 }
            event = AttentionEvent(kind: .permission,
                                   title: agent.map { String(localized: "Permission needed — \($0) agent", bundle: .module) }
                                       ?? String(localized: "Permission needed", bundle: .module),
                                   body: detail.isEmpty ? request.toolName : "\(request.toolName): \(detail)",
                                   key: "perm:\(request.requestId)")
        }
        event.requestId = request.requestId
        return event
    }

    /// The first non-empty line, at most `max` characters ("…" where cut).
    static func clip(_ text: String, _ max: Int) -> String {
        let line = text.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }

    public static func plan(path: String?, plan: String) -> AttentionEvent {
        let firstLine = plan.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "# ").union(.whitespaces)) }
            .first { !$0.isEmpty } ?? ""
        return AttentionEvent(kind: .plan, title: String(localized: "Approve the plan", bundle: .module),
                              body: firstLine, key: "plan:\(path ?? "")#\(plan.count)")
    }

    public static func actionNeeded(message: String, code: String?) -> AttentionEvent {
        AttentionEvent(kind: .actionNeeded, title: String(localized: "ReviewGate needs your action", bundle: .module),
                       body: message, key: "err:\(code ?? message)")
    }
}

/// Posts each key once, and the same kind of one window at most every `minimumInterval` (a burst of permission
/// requests becomes one notification; the window shows the rest).
public struct AttentionCoalescer: Sendable {
    public var minimumInterval: TimeInterval
    private var seenKeys: [String: Date] = [:]
    private var lastByKind: [String: Date] = [:]
    /// Keys are forgotten after this long, so a long session does not grow the table forever.
    private let keyLifetime: TimeInterval = 6 * 3600

    public init(minimumInterval: TimeInterval = 3) {
        self.minimumInterval = minimumInterval
    }

    /// `scope` is the window (project path); kinds are throttled per scope.
    public mutating func shouldPost(_ event: AttentionEvent, scope: String, now: Date = Date()) -> Bool {
        seenKeys = seenKeys.filter { now.timeIntervalSince($0.value) < keyLifetime }
        let key = scope + "|" + event.key
        guard seenKeys[key] == nil else { return false }
        seenKeys[key] = now
        let kindKey = scope + "|" + event.kind.rawValue
        if let last = lastByKind[kindKey], now.timeIntervalSince(last) < minimumInterval { return false }
        lastByKind[kindKey] = now
        return true
    }
}

/// The dock tile badge over every open window.
public enum DockBadge {
    /// "!" while any window waits on a permission / question / plan, else the total of files pending review; nil at 0.
    public static func label(pendingCounts: [Int], anyWaiting: Bool) -> String? {
        if anyWaiting { return "!" }
        let total = pendingCounts.reduce(0, +)
        return total > 0 ? String(total) : nil
    }
}

// MARK: polish p-lifecycle — PX-15: a notification the user has seen in the window goes from Notification Center
//
// docs/PROTOCOL.md §55.8: one live notification per window and kind ("<project>#<kind>"). The window coming to the front
// removes its cards' and its "work finished" (what they said is in front of the user now); a card answered anywhere — the
// window, the board, a rule — removes the cards' — clicked later, they led to a card already gone.
public enum DeliveredNotifications {
    /// The notification window `scope` posts for `kind`.
    public static func identifier(scope: String, kind: AttentionEvent.Kind) -> String { "\(scope)#\(kind.rawValue)" }

    /// The cards' notifications: a permission, a question, a plan.
    public static func waiting(scope: String) -> [String] {
        [AttentionEvent.Kind.permission, .question, .plan].map { identifier(scope: scope, kind: $0) }
    }

    /// The window came to the front: the cards' and the turn summary's.
    public static func seen(scope: String) -> [String] {
        waiting(scope: scope) + [identifier(scope: scope, kind: .turnFinished)]
    }

    /// The windows that waited for the user and do not any more (`was` / `now`: the scopes waiting before and now).
    public static func answered(was: Set<String>, now: Set<String>) -> Set<String> { was.subtracting(now) }
}
