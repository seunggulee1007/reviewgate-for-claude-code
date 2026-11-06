import Foundation
import Testing
@testable import ReviewGateCore

/// answered-composer M08 (docs/PROTOCOL.md §50, "An open question"): Claude's AskUserQuestion is answered from the message box —
/// a typed answer goes to the question the box answers instead of into the running turn (where it would wait behind the
/// open question), the number keys pick an option, ↩ sends the card.
@Suite @MainActor struct ComposerQuestionTests {
    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ComposerQuestionTests.\(UUID().uuidString)")!)
    }

    private static func option(_ label: String) -> JSONValue { .object(["label": .string(label), "description": .string("")]) }

    private static func ask(_ id: String, _ questions: [(text: String, options: [String], multi: Bool)]) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: AskUserQuestions.toolName, input: .object([
            "questions": .array(questions.map { q in
                .object(["question": .string(q.text), "header": .string("H"), "options": .array(q.options.map(option)),
                         "multiSelect": .bool(q.multi)])
            }),
        ]))
    }

    private func bash(_ id: String) -> PermissionRequest {
        PermissionRequest(requestId: id, toolName: "Bash", input: .object(["command": .string("make")]), file: nil, toolUseId: "t-\(id)")
    }

    /// A running turn waiting on `queue`.
    private func running(_ seq: Int, _ queue: [PermissionRequest]) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil,
                                pendingPermission: queue.first, canRestart: true)
        s.session.pendingPermissions = queue
        s.gate = GateInfo(phase: .running, canSend: false, canRequestChanges: false,
                          blockedReason: queue.isEmpty ? .running : .awaitingPermission, collectError: nil,
                          pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false, turnStartTree: "A", turnEndTree: nil,
                          lastReviewSummary: nil)
        return s
    }

    private func open(_ app: AppState, _ queue: [PermissionRequest]) {
        for request in queue { app.handle(.permissionRequest(request)) }
        app.handle(.state(running(1, queue)))
    }

    private let which = Self.ask("Q1", [("Which database?", ["Postgres", "SQLite"], false)])

    @Test func theOpenQuestionIsTheOldestOneWhileNoOtherCardIsOpen() {
        let app = makeState()
        let later = Self.ask("Q2", [("Ship it?", ["Yes", "No"], false)])
        open(app, [which, later])
        #expect(app.openQuestion?.requestId == "Q1")
        #expect(app.openQuestion?.questions.questions.map(\.question) == ["Which database?"])

        // A command waits too: ⌘↩ / ⌘⌫ answer that card first, the message box answers no question.
        let other = makeState()
        open(other, [which, bash("R1")])
        #expect(other.shortcutPermission?.requestId == "R1")
        #expect(other.openQuestion == nil)

        // Without a question there is none; an unreadable one (no questions) is not one either.
        let none = makeState()
        open(none, [PermissionRequest(requestId: "Q3", toolName: AskUserQuestions.toolName, input: .object([:]))])
        #expect(none.openQuestion == nil)
    }

    @Test func aTypedAnswerAnswersTheQuestionInsteadOfGoingIntoTheTurn() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        open(app, [which])

        #expect(app.answerOpenQuestion("  use whatever is installed  "))
        let updated = AskUserQuestions.updatedInput(for: which, answers: ["Which database?": "use whatever is installed"])
        #expect(sent == [.permissionResponse(requestId: "Q1", allow: true, updatedInput: updated)])
        #expect(app.openQuestion == nil && app.openPermissions.isEmpty)
        // Nothing went into the turn and nothing waits in the queue.
        #expect(app.queuedMessages.isEmpty)
    }

    @Test func anAnswerThatIsAnOptionsLabelPicksThatOption() {
        var draft = QuestionDraft()
        let questions = AskUserQuestions(request: which)!
        let answered = draft.fill("sqlite", in: questions)
        #expect(answered == 0)
        #expect(draft.selected["Which database?"] == ["SQLite"] && draft.otherChosen.isEmpty)
        #expect(draft.answers(questions) == ["Which database?": "SQLite"])
    }

    @Test func severalQuestionsTakeTheTypedAnswerForTheFirstUnansweredOne() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let two = Self.ask("Q1", [("Which database?", ["Postgres", "SQLite"], false), ("Which checks?", ["Lint", "Tests", "Types"], true)])
        open(app, [two])
        let questions = app.openQuestion!.questions

        var draft = QuestionDraft()
        #expect(draft.current(in: questions) == 0)
        // The first question is answered; the card waits for the second (nothing sent).
        let cardSent = app.answerOpenQuestion("Postgres", draft: &draft)
        #expect(!cardSent)
        #expect(sent.isEmpty && draft.current(in: questions) == 1)
        #expect(draft.answers(questions) == ["Which database?": "Postgres"])

        // 2 picks the second option of the question the box answers now; several answers can be turned on and off.
        let picked2 = app.pickOpenQuestionOption(2, draft: &draft)
        #expect(picked2)
        let picked3 = app.pickOpenQuestionOption(3, draft: &draft)
        #expect(picked3)
        let unpicked3 = app.pickOpenQuestionOption(3, draft: &draft)
        #expect(unpicked3)
        let picked4 = app.pickOpenQuestionOption(4, draft: &draft)
        #expect(!picked4)   // no fourth option
        #expect(draft.answers(questions)["Which checks?"] == "Tests")

        // ↩ with an empty box sends the card as it is.
        #expect(app.submitOpenQuestion(draft))
        let updated = AskUserQuestions.updatedInput(for: two, answers: ["Which database?": "Postgres", "Which checks?": "Tests"])
        #expect(sent == [.permissionResponse(requestId: "Q1", allow: true, updatedInput: updated)])
    }

    @Test func aNoteTypedAfterAPickJoinsThePickedOption() {
        // "1번으로 해줘": 1 picks the first option, the rest of the words follow it in the answer.
        var draft = QuestionDraft()
        let questions = AskUserQuestions(request: which)!
        let picked1 = draft.pick(1, in: questions)
        #expect(picked1)
        let noted = draft.fill("번으로 해줘", in: questions)
        #expect(noted == 0)
        #expect(draft.answers(questions) == ["Which database?": "Postgres, 번으로 해줘"])
        // Picking again leaves the typed words out of the answer (they stay in the card's "Other…" field).
        let repicked = draft.pick(2, in: questions)
        #expect(repicked)
        #expect(draft.answers(questions) == ["Which database?": "SQLite"])
    }

    @Test func anIncompleteCardIsNotSentAndNothingIsAnsweredWithoutAnOpenQuestion() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        var draft = QuestionDraft()
        let answeredNone = app.answerOpenQuestion("yes", draft: &draft)
        #expect(!answeredNone)
        let pickedNone = app.pickOpenQuestionOption(1, draft: &draft)
        #expect(!pickedNone)
        #expect(draft == QuestionDraft())

        open(app, [which])
        #expect(!app.submitOpenQuestion(QuestionDraft()))
        #expect(!app.answerOpenQuestion("   "))
        #expect(sent.isEmpty && app.openQuestion?.requestId == "Q1")
    }
}
