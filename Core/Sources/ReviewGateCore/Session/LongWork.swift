import Foundation

// MARK: wave4 w4-longwork
// docs/PROTOCOL.md §38.2 on the Mac: long work that stops says so — the tool-call limit's row and [이어서 계속], the hook /
// CLI notices, the usage limit in the HUD and "풀리면 이어서 하기" (opt-in, once, by the queue rules).

/// What the window remembers of the usage limit (client state; quitting the app forgets it — and disarms the resume).
public struct LongWorkState: Sendable, Equatable {
    /// When the last `usage_limit` lifts (its `resetAt`); nil = unknown.
    public var limitResetAt: Date?
    /// "풀리면 이어서 하기" is on.
    public var resumeArmed = false
    /// The session was idle at least once since it was armed: a turn that starts after that is someone else's (the user
    /// sent a message, the queue went on) and disarms it.
    var idleSinceArmed = false
    // MARK: wave4b w4b-check4
    /// §40.1: the chat it was turned on in (`state.sessions.currentId`; nil from an engine without chats) — another chat
    /// disarms it.
    public var armedChatId: String?

    public init() {}
}

/// The words of §38.2 (English keys, Korean in the catalog; Electron uses the same keys).
public enum LongWorkText {
    /// The notices that stay chat rows only — no banner (`max_turns` keeps its banner: it has [이어서 계속]).
    public static let rowOnlyCodes: Set<String> = ["hook_failed", "hook_blocked", "cli_warning", "cli_notice"]

    public static func isRowOnly(_ code: String?) -> Bool { code.map(rowOnlyCodes.contains) ?? false }

    /// Codes whose row has no gray second line: the CLI's own words are the row.
    public static func hidesSecondary(_ code: String?) -> Bool { code == "cli_warning" || code == "cli_notice" }

    /// The row / banner text of a §38.2 code; nil for any other code.
    public static func errorText(message: String, detail: EngineErrorDetail) -> String? {
        switch detail.code {
        case "max_turns":
            if let n = detail.maxTurns, n > 0 {
                return String(localized: "Claude stopped at the tool-call limit (\(n) calls)", bundle: .module)
            }
            return String(localized: "Claude stopped at the tool-call limit", bundle: .module)
        case "hook_failed":
            let name = detail.hookName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return name.isEmpty ? String(localized: "A hook failed", bundle: .module)
                : String(localized: "A hook failed: \(name)", bundle: .module)
        case "hook_blocked":
            // MARK: wave4b w4b-check4 — §40.1: a hook that blocked on purpose says which one and why (an older engine: no name).
            let name = detail.hookName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let why = (detail.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                return why.isEmpty ? String(localized: "Blocked by a hook: \(name)", bundle: .module)
                    : String(localized: "Blocked by a hook: \(name) — \(why)", bundle: .module)
            }
            return String(localized: "A hook stopped this turn", bundle: .module)
        case "cli_warning", "cli_notice":
            let words = (detail.detail ?? message).trimmingCharacters(in: .whitespacesAndNewlines)
            return words.isEmpty ? message : words
        default:
            return nil
        }
    }

    /// What [이어서 계속] / "풀리면 이어서 하기" send to Claude.
    public static var continueMessage: String { String(localized: "Please continue.", bundle: .module) }

    public static var continueTitle: String { String(localized: "Continue the work", bundle: .module) }
    public static var continueHelp: String {
        String(localized: "Sends “continue” to this chat — queued while Claude is busy", bundle: .module)
    }

    public static var resumeTitle: String { String(localized: "Continue when it resets", bundle: .module) }
    public static var resumeHelp: String {
        String(localized: "Sends “continue” once, a minute after the limit resets, when Claude is idle. Sending another message or quitting the app cancels it.", bundle: .module)
    }
    public static var resumeCancelTitle: String { String(localized: "Cancel auto-continue", bundle: .module) }

    /// The HUD chip while the limit is on: "사용량 한도 — 15:00에 풀려요" (+ the resume's state).
    public static func limitChip(resetTime: String?, armed: Bool) -> String {
        let base = resetTime.map { String(localized: "Usage limit — resets at \($0)", bundle: .module) }
            ?? String(localized: "Usage limit", bundle: .module)
        return armed ? base + " · " + String(localized: "continues after", bundle: .module) : base
    }

    /// A reset in local time — the time alone today, else date and time (as the `usage_limit` banner says it).
    public static func resetTime(_ date: Date) -> String {
        var d = EngineErrorDetail()
        d.resetAt = date.ISO8601Format()
        return EngineMessages.resetTime(d) ?? date.formatted(date: .omitted, time: .shortened)
    }

    /// "5시간 72%" / "주간 41%".
    public static func fiveHour(_ percent: Int) -> String { String(localized: "5h \(percentText(percent))", bundle: .module) }
    public static func weekly(_ percent: Int) -> String { String(localized: "Week \(percentText(percent))", bundle: .module) }

    static func percentText(_ percent: Int) -> String { "\(percent)%" }

    /// Settings › Limits: the tool-call limit (§38.2) — off by default.
    public static var settingsToggle: String { String(localized: "Limit tool calls per message", bundle: .module) }
    public static func settingsStepper(_ n: Int) -> String { String(localized: "Tool calls per message: \(n)", bundle: .module) }
    public static var settingsNote: String {
        String(localized: "Claude stops after this many tool calls for one message; Continue goes on from there. Takes effect in a new chat or after restarting the session.", bundle: .module)
    }
    /// The note while the limit is off.
    public static var settingsOffNote: String {
        String(localized: "Off (the default): no limit — Claude works through a message until it is done, as in the terminal, and Stop ends a turn at any time. Takes effect in a new chat or after restarting the session.", bundle: .module)
    }
}

// MARK: r1x — §38.2: a PreToolUse hook's deny is its call's

/// `tool_result.hookDenied`: the user's (or a plugin's) PreToolUse hook denied the call before it ran.
public struct HookDenial: Sendable, Equatable {
    /// The CLI's hook name (`PreToolUse:Read`).
    public var hook: String
    /// What the hook said (Claude reads it and adapts).
    public var reason: String

    public init(hook: String, reason: String) {
        self.hook = hook
        self.reason = reason
    }
}

extension ToolResultInfo {
    private enum HookKeys: String, CodingKey { case hookDenied }
    private struct Wire: Decodable { var hook: String?; var reason: String? }

    /// §38.2: `hookDenied {hook, reason}` of a `tool_result` (event and transcript row), leniently: no hook name, none.
    func withHookDenied(from decoder: Decoder) -> ToolResultInfo {
        guard let c = try? decoder.container(keyedBy: HookKeys.self),
              let wire = (try? c.decodeIfPresent(Wire.self, forKey: .hookDenied)) ?? nil,
              let hook = wire.hook?.trimmingCharacters(in: .whitespacesAndNewlines), !hook.isEmpty else { return self }
        var info = self
        info.hookDenied = HookDenial(hook: hook, reason: (wire.reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
        return info
    }
}

public extension LongWorkText {
    /// The quiet row under a call a hook denied: "훅이 막음: PreToolUse:Read — <reason>".
    static func hookDenied(_ denial: HookDenial) -> String {
        errorText(message: "", detail: {
            var d = EngineErrorDetail()
            d.code = "hook_blocked"
            d.hookName = denial.hook
            d.detail = denial.reason
            return d
        }()) ?? denial.hook
    }

    /// A hook notice that is no alarm: a PreToolUse hook's block restored from before (§38.2 puts new ones on the call) and
    /// a hook that failed — gray rows. A prompt / stop hook that stopped the turn stays a warning.
    static func isQuietHookNotice(code: String?, hookName: String?) -> Bool {
        switch code {
        case "hook_failed": return true
        case "hook_blocked": return (hookName ?? "").hasPrefix("PreToolUse")
        default: return false
        }
    }
}

/// "풀리면 이어서 하기": when to send, wait or give up.
public enum LimitResume {
    /// The send waits this long after the reset (the window opens a little late at times).
    public static let delay: TimeInterval = 60

    public enum Step: Sendable, Equatable { case wait, fire, cancel }

    public static func dueDate(resetAt: Date) -> Date { resetAt.addingTimeInterval(delay) }

    /// MARK: wave4b w4b-check4 — §40.1: the window shows another chat than the one the resume was armed in (a switch, a move,
    /// another project); armed without a chat id: never.
    public static func leftChat(armed: String?, current: String?) -> Bool {
        guard let armed else { return false }
        return current != armed
    }

    /// `running`: a turn runs now; `idle`: a message can go out now (no turn, permission card or plan waiting).
    public static func step(_ s: LongWorkState, running: Bool, idle: Bool, now: Date) -> Step {
        guard s.resumeArmed else { return .wait }
        if running { return s.idleSinceArmed ? .cancel : .wait }
        guard let resetAt = s.limitResetAt else { return .cancel }
        return idle && now >= dueDate(resetAt: resetAt) ? .fire : .wait
    }

    /// The reset of the limit in force: the latest of the rejected windows' resets and the last `usage_limit`'s, while it
    /// is in the future; nil = no limit now (or none known).
    public static func activeReset(rateLimits: [RateLimitWindow], lastResetAt: Date?, now: Date) -> Date? {
        let dates = rateLimits.filter(\.isRejected).compactMap(\.resetDate) + [lastResetAt].compactMap { $0 }
        return dates.filter { $0 > now }.max()
    }

    /// A rejected window without a reset time (the limit is on, its end unknown).
    public static func limitedWithoutTime(rateLimits: [RateLimitWindow]) -> Bool {
        rateLimits.contains { $0.isRejected && $0.resetDate == nil }
    }
}

/// The HUD's usage meter: the five-hour and weekly windows' use when the CLI reports it; orange from 80 %.
public enum UsageMeter {
    public static let warnPercent = 80

    public static func fiveHour(_ windows: [RateLimitWindow]) -> Int? { windows.first { $0.kind == "five_hour" }?.percent }

    /// `seven_day`, else the highest of the other weekly windows (`seven_day_opus`, …).
    public static func weekly(_ windows: [RateLimitWindow]) -> Int? {
        if let p = windows.first(where: { $0.kind == "seven_day" })?.percent { return p }
        return windows.filter { $0.kind.hasPrefix("seven_day") }.compactMap(\.percent).max()
    }

    public static func isHigh(_ percent: Int?) -> Bool { (percent ?? 0) >= warnPercent }
}

// MARK: Settings

public extension AppSettings {
    /// §38.2: the tool-call limit of one message (`settings.maxTurns`) — off by default (`maxTurnsLimitKey` unset): a message
    /// runs until Claude is done or the user stops it, as in the terminal. The number stays stored for when it is turned on.
    static let maxTurnsLimitKey = "maxTurnsLimit"
    static let maxTurnsKey = "maxTurns"
    /// The number while none was set (what turning the limit on starts at).
    static let defaultMaxTurns = 200
    static let maxTurnsRange = 10...1000

    /// The limit is on (Settings › "메시지당 도구 호출 수 제한하기").
    static func maxTurnsLimitEnabled(defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: maxTurnsLimitKey) }

    static func setMaxTurnsLimitEnabled(_ on: Bool, defaults: UserDefaults = .standard) { defaults.set(on, forKey: maxTurnsLimitKey) }

    /// The number of the limit (on or off): unset / out of range → 200.
    static func maxTurnsNumber(defaults: UserDefaults = .standard) -> Int {
        let raw = defaults.integer(forKey: maxTurnsKey)
        return maxTurnsRange.contains(raw) ? raw : defaultMaxTurns
    }

    /// What the engine gets (`settings.maxTurns`): the number while the limit is on, else 0 — no limit.
    static func maxTurns(defaults: UserDefaults = .standard) -> Int {
        maxTurnsLimitEnabled(defaults: defaults) ? maxTurnsNumber(defaults: defaults) : 0
    }

    static func setMaxTurns(_ n: Int, defaults: UserDefaults = .standard) {
        defaults.set(min(max(n, maxTurnsRange.lowerBound), maxTurnsRange.upperBound), forKey: maxTurnsKey)
    }
}

public extension AppState {
    /// Settings › the tool-call limit: `set_settings {maxTurns}` (the engine uses it at the next session start).
    func pushMaxTurns() {
        // A window whose engine has not answered yet reads the setting with its `hello`.
        guard state.seq > 0 || commandSink != nil else { return }
        var settings = EngineSettings()
        settings.maxTurns = AppSettings.maxTurns(defaults: settingsDefaults)
        fire(.setSettings(settings))
    }
}
