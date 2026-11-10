import Foundation
import Testing
@testable import ReviewGateCore

/// polish PX-15 (docs/PROTOCOL.md §55.8): what the user has seen in the window goes from Notification Center.
@Suite struct DeliveredNotificationsTests {
    @Test func theCardsAndTheSummaryOfAWindow() {
        #expect(DeliveredNotifications.identifier(scope: "/work/acme-api", kind: .permission) == "/work/acme-api#permission")
        #expect(DeliveredNotifications.waiting(scope: "/w") == ["/w#permission", "/w#question", "/w#plan"])
        #expect(DeliveredNotifications.seen(scope: "/w") == ["/w#permission", "/w#question", "/w#plan", "/w#turnFinished"])
    }

    @Test func aWindowNoLongerWaitingIsAnswered() {
        #expect(DeliveredNotifications.answered(was: ["/a", "/b"], now: ["/b", "/c"]) == ["/a"])
        #expect(DeliveredNotifications.answered(was: [], now: ["/a"]).isEmpty)
    }
}
