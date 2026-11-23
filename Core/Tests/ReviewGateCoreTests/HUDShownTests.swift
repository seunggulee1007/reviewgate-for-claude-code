import Foundation
import Testing
@testable import ReviewGateCore

/// §56.5: the HUD hides what is still zero — a fresh chat shows the model and "Idle", not "0 tokens · $0.00 · turn 0 · 0.0s".
@Suite struct HUDShownTests {
    @Test func aFreshChatShowsNoNumbers() {
        let hud = HUDState()
        #expect(hud.shown(isRunning: false) == HUDState.Shown(context: false, cost: false, turn: false))
    }

    @Test func aRunningTurnShowsItsTimeBeforeAnythingIsCounted() {
        #expect(HUDState().shown(isRunning: true) == HUDState.Shown(context: false, cost: false, turn: true))
    }

    @Test func eachNumberComesOnceThereIsOne() {
        var hud = HUDState()
        hud.contextTokens = 48_200
        hud.contextWindow = 200_000
        hud.turnCount = 1
        // A subscription reports no cost: the meter and the turn show, the cost does not.
        #expect(hud.shown(isRunning: false) == HUDState.Shown(context: true, cost: false, turn: true))
        hud.sessionCostUSD = 0.42
        #expect(hud.shown(isRunning: false) == HUDState.Shown(context: true, cost: true, turn: true))
    }
}
