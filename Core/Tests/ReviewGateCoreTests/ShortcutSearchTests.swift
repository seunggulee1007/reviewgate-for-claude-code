import Foundation
import Testing
@testable import ReviewGateCore

/// polish P1-chrome-10 (docs/PROTOCOL.md §55.8): Help › Keyboard Shortcuts narrows the table as the user types.
@Suite struct ShortcutSearchTests {
    private let korean = ["Reject": "거절", "Close Chat Tab": "채팅 탭 닫기", "Chat tabs 1–9": "채팅 탭 1–9", "Review": "리뷰"]

    private func actions(_ query: String) -> [String] {
        ShortcutTable.filtered(query, localize: { korean[$0] ?? $0 }).flatMap { $0.rows.map(\.action) }
    }

    @Test func rowsByTheirWordsInEitherLanguageAndTheirKeys() {
        #expect(actions("거절").contains("Reject"))
        #expect(actions("REJECT").contains("Reject"))
        #expect(actions("ctrl+shift+k") == ["Commit Accepted…"])
        #expect(actions("⌘⇧K") == ["Commit Accepted…"])
        #expect(Set(actions("탭 채팅")).isSuperset(of: ["Close Chat Tab", "Chat tabs 1–9"]))
    }

    @Test func aSectionTitleKeepsTheSectionNothingFoundIsEmptyAnEmptyQueryAll() {
        let review = ShortcutTable.sections.first { $0.title == "Review" }
        #expect(ShortcutTable.filtered("리뷰", localize: { korean[$0] ?? $0 }).first { $0.title == "Review" }?.rows == review?.rows)
        #expect(ShortcutTable.filtered("zzz-nothing").isEmpty)
        #expect(ShortcutTable.filtered("  ") == ShortcutTable.sections)
    }
}
