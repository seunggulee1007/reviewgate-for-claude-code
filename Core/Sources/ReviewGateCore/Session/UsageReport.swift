import Foundation

// MARK: §71.1 — docs/PROTOCOL.md §71.1: `/usage` (and the terminal's aliases `/cost`, `/stats`) in a classic chat — the
// terminal's Session block (cost, API and wall time, code changes, usage by model) and the plan's usage windows with their
// reset times. The wire (`state.hud.sessionTotals`) and the words; App `UsageSheet.swift` shows them.

/// §71.1 `state.hud.sessionTotals`.
public struct SessionTotals: Sendable, Equatable, Decodable {
    /// Epoch milliseconds the live CLI started; nil while none runs.
    public var startedAt: Double?
    public var apiDurationMs: Int
    public var linesAdded: Int
    public var linesRemoved: Int

    public init(startedAt: Double? = nil, apiDurationMs: Int = 0, linesAdded: Int = 0, linesRemoved: Int = 0) {
        self.startedAt = startedAt
        self.apiDurationMs = apiDurationMs
        self.linesAdded = linesAdded
        self.linesRemoved = linesRemoved
    }

    private enum CodingKeys: String, CodingKey { case startedAt, apiDurationMs, linesAdded, linesRemoved }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func count(_ key: CodingKeys) -> Int {
            guard let v = lenientValue(Double.self, c, key), v.isFinite, v > 0 else { return 0 }
            return Int(v)
        }
        startedAt = lenientValue(Double.self, c, .startedAt).flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        apiDurationMs = count(.apiDurationMs)
        linesAdded = count(.linesAdded)
        linesRemoved = count(.linesRemoved)
    }

    /// The live CLI's start.
    public var startedDate: Date? { startedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// `state.hud.sessionTotals` (lenient: missing or malformed → nil, an engine without §71.1).
enum SessionTotalsWire {
    private enum HudKeys: String, CodingKey { case sessionTotals }

    static func hud(from decoder: Decoder) -> SessionTotals? {
        guard let c = try? decoder.container(keyedBy: HudKeys.self) else { return nil }
        return lenientValue(SessionTotals.self, c, .sessionTotals)
    }
}

/// §71.1: the usage sheet's words, in the terminal's shapes.
public enum UsageText {
    public static var title: String { String(localized: "Usage", bundle: .module) }

    /// The palette's line for `/usage`.
    public static var description: String { String(localized: "Show the session cost, plan usage limits and the cost by model", bundle: .module) }

    /// "6m 20s", "6h 33m 10s", "45s" (as the terminal's `Total duration`).
    public static func duration(ms: Int) -> String {
        let total = max(0, ms) / 1000
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return String(localized: "\(h)h \(m)m \(s)s", bundle: .module) }
        if m > 0 { return String(localized: "\(m)m \(s)s", bundle: .module) }
        return String(localized: "\(s)s", bundle: .module)
    }

    /// "512", "1.2k", "940.0k", "1.5M" — the terminal's token counts.
    public static func tokens(_ n: Int) -> String {
        if n < 1000 { return "\(max(0, n))" }
        if n < 1_000_000 { return String(format: "%.1fk", Double(n) / 1000) }
        return String(format: "%.1fM", Double(n) / 1_000_000)
    }

    /// "$0.5512".
    public static func cost(_ usd: Double) -> String { String(format: "$%.4f", usd) }

    /// "1.2k input, 5.3k output, 940.0k cache read, 50.0k cache write".
    public static func modelTokens(_ m: ModelCost) -> String {
        String(localized: "\(tokens(m.inputTokens)) input, \(tokens(m.outputTokens)) output, \(tokens(m.cacheReadTokens)) cache read, \(tokens(m.cacheCreationTokens)) cache write", bundle: .module)
    }

    /// "3 lines added, 1 line removed".
    public static func codeChanges(added: Int, removed: Int) -> String {
        String(localized: "\(added) lines added, \(removed) lines removed", bundle: .module)
    }

    /// A plan window's name, as the terminal's bars say it; an unknown kind as sent.
    public static func windowTitle(_ kind: String) -> String {
        switch kind {
        case "five_hour": String(localized: "Current session (5 hours)", bundle: .module)
        case "seven_day": String(localized: "Current week (all models)", bundle: .module)
        case "seven_day_opus": String(localized: "Current week (Opus)", bundle: .module)
        case "seven_day_sonnet": String(localized: "Current week (Sonnet)", bundle: .module)
        default: kind.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// The windows in the terminal's order: the five-hour one, the week, then the rest by name.
    public static func ordered(_ windows: [RateLimitWindow]) -> [RateLimitWindow] {
        let rank = ["five_hour": 0, "seven_day": 1, "seven_day_opus": 2, "seven_day_sonnet": 3]
        return windows.sorted { (rank[$0.kind] ?? 9, $0.kind) < (rank[$1.kind] ?? 9, $1.kind) }
    }

    /// "72% used".
    public static func used(_ percent: Int) -> String { String(localized: "\(percent)% used", bundle: .module) }

    /// "Resets 15:00" (a later day with its date).
    public static func resets(_ date: Date) -> String {
        String(localized: "Resets \(LongWorkText.resetTime(date))", bundle: .module)
    }

    public static var limitReached: String { String(localized: "Limit reached", bundle: .module) }

    public static var sessionHeading: String { String(localized: "Session", bundle: .module) }
    public static var planHeading: String { String(localized: "Plan usage", bundle: .module) }
    public static var estimatedCost: String { String(localized: "Estimated cost", bundle: .module) }
    public static var apiDuration: String { String(localized: "Total duration (API)", bundle: .module) }
    public static var wallDuration: String { String(localized: "Total duration (wall)", bundle: .module) }
    public static var codeChangesLabel: String { String(localized: "Total code changes", bundle: .module) }
    public static var byModel: String { String(localized: "Usage by model", bundle: .module) }

    public static var noModels: String { String(localized: "The usage per model shows here once a turn ends.", bundle: .module) }
    public static var noWindows: String {
        String(localized: "With a Claude subscription, the five-hour and weekly limits show here once Claude Code reports them — after Claude's first answer.", bundle: .module)
    }
    public static var estimateNote: String {
        String(localized: "Claude Code's estimate from token counts at list price — not a bill. These totals start again in a new chat.", bundle: .module)
    }
    public static var terminalNote: String {
        String(localized: "The terminal's activity stats and its breakdown of what counts against your plan come from its local history — they're in a terminal chat's /usage.", bundle: .module)
    }
    public static func sideCost(_ usd: Double) -> String {
        String(localized: "Side questions: \(cost(usd)) — not part of the session cost", bundle: .module)
    }
    public static var notRunning: String { String(localized: "No Claude Code session is running", bundle: .module) }
}

public extension AppState {
    /// §71.1: the session block's totals; nil from an engine without them.
    var sessionTotals: SessionTotals? { state.hud.sessionTotals }
}
