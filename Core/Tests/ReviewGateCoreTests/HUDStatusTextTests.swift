import Foundation
import Testing
@testable import ReviewGateCore

/// The status line under the composer: "Working · 12s" while a turn runs that the engine still reports idle, never "Idle".
@Suite struct HUDStatusTextTests {
    private let start = Date(timeIntervalSince1970: 1_000)

    @Test func aRunningTurnIsNeverIdle() {
        var hud = HUDState()
        hud.turnStartedAt = start
        #expect(hud.activityIsIdle)
        #expect(hud.statusText(isRunning: true, now: start.addingTimeInterval(12.4), language: "en") == "Working · 12s")
        #expect(hud.statusText(isRunning: true, now: start.addingTimeInterval(4.2), language: "en") == "Working · 4.2s")
        #expect(hud.statusText(isRunning: true) == "Working…")   // no clock: no seconds
        hud.turnStartedAt = nil
        #expect(hud.statusText(isRunning: true, now: start) == "Working…")
        #expect(hud.statusText(isRunning: false) == "Idle")
    }

    @Test func theEnginesOwnActivityIsShownAsItIs() {
        var hud = HUDState()
        hud.turnStartedAt = start
        hud.activity = "Running Bash: npm test"
        hud.activityIsIdle = false
        #expect(hud.statusText(isRunning: true, now: start.addingTimeInterval(30)) == "Running Bash: npm test")
        #expect(hud.statusText(isRunning: false) == "Running Bash: npm test")
    }

    @Test func wholeSecondsFromTen() {
        #expect(ElapsedFormat.text(seconds: 12.4, language: "ko", tenths: false) == "12초")
        #expect(ElapsedFormat.text(seconds: 9.5, language: "ko", tenths: false) == "9.5초")
        #expect(ElapsedFormat.text(seconds: 200, language: "ko", tenths: false) == "3분 20초")
        #expect(ElapsedFormat.text(seconds: 12.4, language: "ko") == "12.4초")   // the turn time keeps its tenths
    }
}
