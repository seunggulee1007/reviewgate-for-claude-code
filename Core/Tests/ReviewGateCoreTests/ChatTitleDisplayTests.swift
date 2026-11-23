import Foundation
import Testing
@testable import ReviewGateCore

/// The engine stores a fresh chat's name as "New chat"; the app shows it (and an empty title) in the UI language.
@Suite struct ChatTitleDisplayTests {
    @Test func theDefaultChatNameIsShownLocalizedAndOthersAsTheyAre() {
        let localized = String(localized: "New chat", bundle: .module)
        #expect(SessionMeta.displayTitle("New chat") == localized)
        #expect(SessionMeta.displayTitle("") == localized)
        #expect(SessionMeta.displayTitle("Fix the cart total") == "Fix the cart total")
        #expect(SessionMeta(id: "s1", title: "New chat").displayTitle == localized)
        #expect(SessionMeta.newChatTitle == "New chat")   // the engine's NEW_CHAT_TITLE: stored as it is
    }
}
