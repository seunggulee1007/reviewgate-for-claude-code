import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §71.1 on the Mac: `/usage` — the terminal's Session block and the plan's usage windows.
@Suite struct UsageReportTests {
    private func hud(_ extra: String) throws -> HUDWire {
        let json = #"{"contextTokens":0,"sessionCostUSD":0.55,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0"#
            + extra + "}"
        return try JSONDecoder().decode(HUDWire.self, from: Data(json.utf8))
    }

    @Test func theTotalsOnTheWire() throws {
        let h = try hud(#","sessionTotals":{"startedAt":1700000000000,"apiDurationMs":380000,"linesAdded":12,"linesRemoved":3}"#)
        #expect(h.sessionTotals == SessionTotals(startedAt: 1_700_000_000_000, apiDurationMs: 380_000, linesAdded: 12, linesRemoved: 3))
        #expect(h.sessionTotals?.startedDate == Date(timeIntervalSince1970: 1_700_000_000))
        // No CLI running; an older engine; a malformed value — the snapshot still decodes.
        #expect(try hud(#","sessionTotals":{"startedAt":null,"apiDurationMs":0,"linesAdded":0,"linesRemoved":0}"#).sessionTotals?.startedAt == nil)
        #expect(try hud("").sessionTotals == nil)
        #expect(try hud(#","sessionTotals":"x""#).sessionTotals == nil)
        #expect(try hud(#","sessionTotals":{"apiDurationMs":-4,"linesAdded":"z"}"#).sessionTotals == SessionTotals())
    }

    @Test func theTerminalsShapes() {
        #expect(UsageText.duration(ms: 380_000) == String(localized: "\(6)m \(20)s", bundle: .module))
        #expect(UsageText.duration(ms: 23_590_000) == String(localized: "\(6)h \(33)m \(10)s", bundle: .module))
        #expect(UsageText.duration(ms: 999) == String(localized: "\(0)s", bundle: .module))
        #expect(UsageText.tokens(512) == "512")
        #expect(UsageText.tokens(1_234) == "1.2k")
        #expect(UsageText.tokens(940_000) == "940.0k")
        #expect(UsageText.tokens(1_500_000) == "1.5M")
        #expect(UsageText.cost(0.55) == "$0.5500")
        let m = ModelCost(model: "claude-sonnet-4-6", costUsd: 0.55, inputTokens: 1_200, outputTokens: 5_300, cacheReadTokens: 940_000, cacheCreationTokens: 50_000)
        let line = UsageText.modelTokens(m)
        for part in ["1.2k", "5.3k", "940.0k", "50.0k"] { #expect(line.contains(part), "\(part)") }
    }

    @Test func thePlanWindows() {
        let windows = [RateLimitWindow(kind: "seven_day_opus", status: "allowed", percent: 10),
                       RateLimitWindow(kind: "seven_day", status: "allowed", percent: 41),
                       RateLimitWindow(kind: "five_hour", status: "rejected", percent: 100, resetsAt: "2026-11-27T15:00:00Z"),
                       RateLimitWindow(kind: "zz_other", status: "allowed")]
        #expect(UsageText.ordered(windows).map(\.kind) == ["five_hour", "seven_day", "seven_day_opus", "zz_other"])
        #expect(UsageText.windowTitle("five_hour") == String(localized: "Current session (5 hours)", bundle: .module))
        #expect(UsageText.windowTitle("seven_day_opus") == String(localized: "Current week (Opus)", bundle: .module))
        #expect(UsageText.windowTitle("zz_other") == "zz other")
        #expect(UsageText.used(72).contains("72"))
        let reset = try! #require(windows[2].resetDate)
        #expect(UsageText.resets(reset).contains(LongWorkText.resetTime(reset)))
    }
}
