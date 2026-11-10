import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-check4 — docs/PROTOCOL.md §40.1: the turn-end line's stop reason in words (as in Electron, stopWords.test.ts).
@Suite struct Check4Tests {
    @Test func stopReasonsInWords() {
        #expect(TurnEndText.stopWords("success") == "Finished")
        #expect(TurnEndText.stopWords("ended") == "Finished")
        #expect(TurnEndText.stopWords("interrupted") == "Stopped by you")
        #expect(TurnEndText.stopWords("error_max_turns") == "Stopped at the tool-call limit")
        #expect(TurnEndText.stopWords("error_max_budget_usd") == "Stopped at the cost limit")
        #expect(TurnEndText.stopWords("error_during_execution") == "Stopped by an error")
        #expect(TurnEndText.stopWords("chat moved") == "Stopped — the chat moved to another worktree")
        #expect(TurnEndText.stopWords("something_new") == "something_new")
        let usage = Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1000)
        let row = TurnEndText.row(stopReason: "error_max_turns", usage: usage, files: 0, added: 0, deleted: 0, external: 0, review: TurnEndReview())
        #expect(row.hasPrefix(String(localized: "Changed \(0) file(s) (+\(0) −\(0)) · \("Stopped at the tool-call limit")", bundle: .module)))
    }
}
