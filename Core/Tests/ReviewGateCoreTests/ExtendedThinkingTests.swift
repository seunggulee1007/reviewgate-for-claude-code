import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §70.4 on the Mac: ⌥T — extended thinking on or off for the chat.
@Suite @MainActor struct ExtendedThinkingTests {
    private func sent(_ command: EngineCommand) throws -> [String: Any] {
        let data = try JSONEncoder().encode(EngineCommandEnvelope(id: "c1", command: command))
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func theCommand() throws {
        let off = try sent(.setThinking(enabled: false))
        #expect(off["type"] as? String == "set_thinking")
        #expect(off["enabled"] as? Bool == false)
    }

    @Test func theSessionState() throws {
        let json = #"{"open":true,"starting":false,"thinking":{"enabled":false,"alwaysOn":true}}"#
        let session = try JSONDecoder().decode(SessionInfo.self, from: Data(json.utf8))
        #expect(session.thinking == ThinkingState(enabled: false, alwaysOn: true))
        #expect(session.thinking?.thinks == true)
        // An older engine sends none; a malformed one reads as none — the snapshot still decodes.
        let older = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false}"#.utf8))
        #expect(older.thinking == nil)
        let odd = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"open":true,"starting":false,"thinking":3}"#.utf8))
        #expect(odd.thinking == nil)
    }

    @Test func theWords() {
        #expect(ThinkingText.chip(ThinkingState(enabled: false)) == String(localized: "Thinking off", bundle: .module))
        #expect(ThinkingText.chip(ThinkingState(enabled: false, alwaysOn: true)) == String(localized: "Thinking on", bundle: .module))
        #expect(ThinkingText.help(ThinkingState(enabled: true, alwaysOn: true)).contains("⌥T"))
        #expect(ThinkingText.refusal(code: "set_thinking_failed", detail: "boom")?.contains("boom") == true)
        #expect(EngineMessages.refusal(error: "set_thinking_failed:boom").contains("boom"))
        #expect(ThinkingToggle.changed(false).notice.text == ThinkingText.toggled(false))
        #expect(ThinkingToggle.refused("why").notice.warning)
    }

    @Test func theBlockers() {
        let state = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ExtendedThinkingTests.\(UUID().uuidString)")!)
        #expect(state.thinkingBlocker != nil)   // no project
    }
}
