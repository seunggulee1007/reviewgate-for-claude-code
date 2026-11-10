import Foundation
import Testing
@testable import ReviewGateCore

/// polish PX-update-wait / P5-sheets-48 (docs/PROTOCOL.md §55.9): the update's restart waits for Claude by window and
/// reason, never forever on a turn whose end was missed, and reopens the windows after it.
@Suite struct UpdateWaitTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func itWaitsForAWorkingWindowAndACardNamingEach() {
        let decision = UpdateWait.decide([
            UpdateWaitWindow(name: "acme-api", reason: .working, lastEventAt: now.addingTimeInterval(-5)),
            UpdateWaitWindow(name: "acme-web", reason: nil, lastEventAt: now),
            UpdateWaitWindow(name: "acme-ops", reason: .waiting, lastEventAt: now.addingTimeInterval(-3600)),
        ], now: now)
        #expect(!decision.restartsNow)
        #expect(decision.blockers.map(\.index) == [0, 2])
        #expect(decision.blockers.map(\.reason) == [.working, .waiting])
        #expect(UpdateWait.line(decision.blockers[0]) == String(localized: "acme-api: Claude is working", bundle: .module))
        #expect(UpdateWait.line(decision.blockers[0]).hasPrefix("acme-api: "))
        #expect(decision.stale.isEmpty)
    }

    @Test func aTurnSilentForTwoMinutesNoLongerHoldsIt() {
        let decision = UpdateWait.decide([
            UpdateWaitWindow(name: "acme-api", reason: .working, lastEventAt: now.addingTimeInterval(-121)),
            UpdateWaitWindow(name: "acme-web", reason: nil, lastEventAt: nil),
        ], now: now)
        #expect(decision.restartsNow)
        #expect(decision.stale == ["acme-api"])
        // Just under: still waited for.
        #expect(!UpdateWait.decide([UpdateWaitWindow(name: "a", reason: .working, lastEventAt: now.addingTimeInterval(-119))], now: now).restartsNow)
    }

    @Test func theRestartReopensTheWindowsOnce() {
        let defaults = UserDefaults(suiteName: "UpdateWaitTests.\(UUID().uuidString)")!
        #expect(!AppSettings.takeRestoreOnceAfterRelaunch(defaults: defaults))
        AppSettings.setRestoreOnceAfterRelaunch(defaults: defaults)
        #expect(AppSettings.takeRestoreOnceAfterRelaunch(defaults: defaults))
        #expect(!AppSettings.takeRestoreOnceAfterRelaunch(defaults: defaults))
    }

    @Test @MainActor func anEngineEventStampsItsWindow() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "UpdateWaitTests.\(UUID().uuidString)")!)
        #expect(app.lastEngineEventAt == nil)
        app.handle(.state(ReviewState.empty))
        #expect(app.lastEngineEventAt != nil)
    }
}
