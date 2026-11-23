import Foundation
import Testing
@testable import ReviewGateCore

/// §56.6: decided permission cards and questions one after another fold into one line ("권한 3건 처리됨 ▸").
@Suite struct HandledCardFoldTests {
    private struct Row { let id = UUID(); let item: ChatItem; let open: Bool }

    private func perm(_ allowed: Bool?, open: Bool = false, tool: String = "Bash") -> Row {
        Row(item: .permission(id: UUID(), request: PermissionRequest(requestId: UUID().uuidString, toolName: tool, input: .object([:])), allowed: allowed),
            open: open)
    }
    private func question(_ allowed: Bool?, open: Bool = false) -> Row { perm(allowed, open: open, tool: AskUserQuestions.toolName) }
    private func text() -> Row { Row(item: .assistant(id: UUID(), text: "Done.", streaming: false), open: false) }

    private func fold(_ rows: [Row]) -> [HandledCardFold.Piece<Row>] {
        HandledCardFold.fold(rows, id: \.id) { HandledCardFold.card($0.item, isOpen: $0.open) }
    }

    /// "s" a row of its own, "rN" a run of N.
    private func shape(_ rows: [Row]) -> [String] {
        fold(rows).map { piece in
            switch piece {
            case .single: "s"
            case let .run(run): "r\(run.elements.count)"
            }
        }
    }

    @Test func twoOrMoreDecidedCardsInARowFold() {
        #expect(HandledCardFold.minCards == 2)
        #expect(shape([text(), perm(true), perm(false), question(false), text()]) == ["s", "r3", "s"])
        // One decided card alone stays a line of its own.
        #expect(shape([perm(true), text(), perm(false)]) == ["s", "s", "s"])
        // A card still waiting ends the run and is never folded; one handled elsewhere (no decision, not open) folds.
        #expect(shape([perm(true), perm(nil, open: true), perm(nil), perm(false)]) == ["s", "s", "r2"])
        #expect(shape([]).isEmpty)
    }

    @Test func theRunKeepsItsFirstRowsIdAndItsRowsInOrder() {
        let rows = [text(), perm(true), perm(false)]
        let pieces = fold(rows)
        guard case let .run(run) = pieces[1] else { Issue.record("no run"); return }
        #expect(run.id == rows[1].id)
        #expect(pieces[1].id == rows[1].id)
        #expect(run.elements.map(\.id) == [rows[1].id, rows[2].id])
    }

    @Test func theLineCountsWhatTheRunHolds() {
        let pieces = fold([perm(true), perm(true), perm(false), question(false), question(true), perm(nil)])
        guard case let .run(run) = pieces.first else { Issue.record("no run"); return }
        var expected = HandledCounts()
        expected.permissions = 4
        expected.questions = 2
        expected.allowed = 2
        expected.denied = 1
        expected.handled = 1
        expected.answered = 1
        expected.skipped = 1
        #expect(run.counts == expected)
        #expect(run.counts.summary == "4 permission(s) · 2 question(s) handled")
        #expect(run.counts.detail == "Allowed 2 · Denied 1 · Answered 1 · Skipped 1 · Handled elsewhere 1")
        var permissions = HandledCounts()
        permissions.permissions = 3
        permissions.allowed = 3
        #expect(permissions.summary == "3 permission(s) handled")
        #expect(permissions.detail == "Allowed 3")
        var questions = HandledCounts()
        questions.questions = 2
        questions.skipped = 2
        #expect(questions.summary == "2 question(s) handled")
    }

    @Test func onlyPermissionRowsAreCards() {
        #expect(HandledCardFold.card(text().item, isOpen: false) == nil)
        #expect(HandledCardFold.card(perm(true, tool: "SendMessage").item, isOpen: false) == HandledCard(question: false, outcome: .allowed))
        #expect(HandledCardFold.card(question(nil).item, isOpen: true) == nil)
        #expect(HandledCardFold.card(question(nil).item, isOpen: false) == HandledCard(question: true, outcome: .handled))
    }
}
