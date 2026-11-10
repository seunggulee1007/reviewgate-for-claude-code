import Foundation

// MARK: wave4 w4-safety

/// Audit daily-14: why a turn stopped while the user was away — the "turn finished" notification says this instead of
/// "No files to review". Picked from the `error{code}` events that arrived while the turn ran; nil = it simply finished.
///
/// To add a reason: add a `Kind`, map its code in `from(code:…)`, give it a `rank`. The one list of stop reasons —
/// §38.2's tool-call limit (`max_turns`) is one of them (Electron's `workSafety.ts` keeps the same list).
public struct TurnStopReason: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable {
        case usageLimit, rateLimited, loginRequired, apiError, crashed, maxTurns
    }

    public var kind: Kind
    /// The notification's headline: "사용량 한도로 멈췄어요 — 15:00에 풀려요".
    public var text: String
    /// The error was already posted on its own (a fatal one): the turn's end adds no second notification.
    public var alreadyNotified: Bool

    public init(kind: Kind, text: String, alreadyNotified: Bool = false) {
        self.kind = kind
        self.text = text
        self.alreadyNotified = alreadyNotified
    }

    /// Several in one turn: the higher rank wins (a login problem explains an API error after it, not the other way).
    public var rank: Int {
        switch kind {
        case .loginRequired: 6
        case .usageLimit: 5
        case .crashed: 4
        case .maxTurns: 3
        case .rateLimited: 2
        case .apiError: 1
        }
    }

    /// The reason an `error` event gives a running turn; nil for codes that do not stop it (notices, git, side, MCP).
    public static func from(code: String?, message: String, detail: EngineErrorDetail, fatal: Bool,
                            timeZone: TimeZone = .current, locale: Locale = .current, now: Date = Date()) -> TurnStopReason? {
        let time = EngineMessages.resetTime(detail, timeZone: timeZone, locale: locale, now: now)
        switch code {
        case "usage_limit":
            let text = time.map { String(localized: "Stopped at the usage limit — it resets at \($0)", bundle: .module) }
                ?? String(localized: "Stopped at the usage limit", bundle: .module)
            return TurnStopReason(kind: .usageLimit, text: text, alreadyNotified: fatal)
        case "rate_limited":
            let text = time.map { String(localized: "Stopped by the API rate limit — try again after \($0)", bundle: .module) }
                ?? String(localized: "Stopped by the API rate limit", bundle: .module)
            return TurnStopReason(kind: .rateLimited, text: text, alreadyNotified: fatal)
        case "auth_required":
            return TurnStopReason(kind: .loginRequired, text: String(localized: "Login required", bundle: .module),
                                  alreadyNotified: fatal)
        case "api_error":
            let why = EngineMessages.error(message: message, detail: detail, timeZone: timeZone, locale: locale, now: now)
            return TurnStopReason(kind: .apiError, text: String(localized: "Stopped by an error: \(why)", bundle: .module),
                                  alreadyNotified: fatal)
        case "session_crashed":
            return TurnStopReason(kind: .crashed, text: String(localized: "Claude Code quit unexpectedly", bundle: .module),
                                  alreadyNotified: fatal)
        case "max_turns":   // §38.2: the tool-call limit of one message ([이어서 계속] on the banner goes on)
            return TurnStopReason(kind: .maxTurns, text: String(localized: "Stopped at the tool-call limit", bundle: .module),
                                  alreadyNotified: fatal)
        default:
            return nil
        }
    }

    /// Keeps the stronger of two reasons (`rank`); equal ranks keep the first.
    public static func merge(_ current: TurnStopReason?, _ next: TurnStopReason?) -> TurnStopReason? {
        guard let next else { return current }
        guard let current else { return next }
        if next.rank > current.rank { return next }
        var kept = current
        kept.alreadyNotified = current.alreadyNotified || (next.kind == current.kind && next.alreadyNotified)
        return kept
    }

    /// Codes whose own notification waits for the turn's end (it carries the reason): non-fatal ones only — a fatal
    /// error is posted right away, since the turn may never report its end.
    public static func defersNotification(code: String?, fatal: Bool) -> Bool {
        guard !fatal else { return false }
        return ["usage_limit", "rate_limited", "auth_required", "api_error", "max_turns"].contains(code ?? "")
    }
}

extension AttentionEvent {
    /// A finished turn: with a stop reason its headline says why it stopped; the body keeps the files line.
    public static func turnFinished(pending: Int, key: String, stopped: TurnStopReason?) -> AttentionEvent {
        var event = turnFinished(pending: pending, key: key)
        if let stopped { event.title = stopped.text }
        return event
    }
}
