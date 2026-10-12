import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-perms — audit polish-01 regression: ⌘↩ / ⌥⌘↩ / ⌘⌫ / Esc act only in the main composer or on the focused
/// card. From the side-question field, the find bar or a note editor they do nothing (before: a permission was allowed,
/// remembered for the session, the plan was sent back, the question skipped).
@Suite struct CardShortcutsTests {
    private let bash = PermissionRequest(requestId: "R1", toolName: "Bash", input: .object(["command": .string("npm test")]))
    private let keys: [CardShortcutKey] = [.commandReturn, .optionCommandReturn, .commandDelete, .escape]

    @Test func nothingFiresOutsideTheComposerAndTheCards() {
        // The side-question field, the find bar, a review-note editor, a card's own text field: no card action, ever.
        for key in keys {
            #expect(CardShortcuts.action(for: key, focus: .elsewhere, target: bash) == .none)
        }
    }

    @Test func theComposerSendsWithTextAndAnswersTheOldestCardWhenEmpty() {
        let draft = CardShortcutFocus.composer(draft: "run the tests")
        #expect(CardShortcuts.action(for: .commandReturn, focus: draft, target: bash) == .sendDraft)
        #expect(CardShortcuts.action(for: .commandReturn, focus: draft, target: nil) == .sendDraft)
        // ⌥⌘↩ answers a card only with an empty draft — with text it is "stop and send", as on Windows (wave4d w4d-windows,
        // polish-08: docs/SHORTCUTS.md); ⌘⌫ with any character stays a text deletion; Esc never answers anything.
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: draft, target: bash) == .stopAndSendDraft)
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: draft, target: nil) == .stopAndSendDraft)
        #expect(CardShortcuts.action(for: .commandDelete, focus: draft, target: bash) == .none)
        #expect(CardShortcuts.action(for: .commandDelete, focus: .composer(draft: "  "), target: bash) == .none)
        #expect(CardShortcuts.action(for: .escape, focus: draft, target: bash) == .none)

        let empty = CardShortcutFocus.composer(draft: "")
        #expect(CardShortcuts.action(for: .commandReturn, focus: empty, target: bash) == .allowOnce(requestId: "R1"))
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: empty, target: bash) == .allowForSession(requestId: "R1"))
        #expect(CardShortcuts.action(for: .commandDelete, focus: empty, target: bash) == .deny(requestId: "R1"))
        #expect(CardShortcuts.action(for: .escape, focus: empty, target: bash) == .none)
        // Only whitespace typed: ⌘↩ still answers (nothing to send), as before.
        #expect(CardShortcuts.action(for: .commandReturn, focus: .composer(draft: " \n"), target: bash) == .allowOnce(requestId: "R1"))
        // No open card: an empty composer's keys do nothing.
        for key in keys { #expect(CardShortcuts.action(for: key, focus: empty, target: nil) == .none) }
    }

    @Test func aFocusedPermissionCardAnswersItself() {
        let newer = PermissionRequest(requestId: "R2", toolName: "WebFetch", input: .object(["url": .string("https://docs.spring.io")]))
        let focus = CardShortcutFocus.permissionCard(requestId: "R2")
        #expect(CardShortcuts.action(for: .commandReturn, focus: focus, target: newer) == .allowOnce(requestId: "R2"))
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: focus, target: newer) == .allowForSession(requestId: "R2"))
        #expect(CardShortcuts.action(for: .commandDelete, focus: focus, target: newer) == .deny(requestId: "R2"))
        #expect(CardShortcuts.action(for: .escape, focus: focus, target: newer) == .focusComposer)
        // A card whose request is gone answers nothing (Esc still hands the keyboard back).
        #expect(CardShortcuts.action(for: .commandReturn, focus: focus, target: nil) == .none)
        #expect(CardShortcuts.action(for: .commandReturn, focus: focus, target: bash) == .none)
        #expect(CardShortcuts.action(for: .escape, focus: focus, target: nil) == .focusComposer)
        // SendMessage: [보내기] / [거절] only — no session allow.
        let send = PermissionRequest(requestId: "S", toolName: "SendMessage", input: .object(["to": .string("b4"), "message": .string("hi")]))
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: .permissionCard(requestId: "S"), target: send) == .none)
        #expect(CardShortcuts.action(for: .commandReturn, focus: .permissionCard(requestId: "S"), target: send) == .allowOnce(requestId: "S"))
    }

    @Test func escOnlyKeepsPlanningOrSkipsOnTheFocusedCard() {
        #expect(CardShortcuts.action(for: .escape, focus: .planCard, target: nil) == .keepPlanning)
        #expect(CardShortcuts.action(for: .commandReturn, focus: .planCard, target: bash) == .none)
        #expect(CardShortcuts.action(for: .commandDelete, focus: .planCard, target: bash) == .none)
        let question = CardShortcutFocus.questionCard(requestId: "Q1")
        #expect(CardShortcuts.action(for: .escape, focus: question, target: nil) == .skipQuestions(requestId: "Q1"))
        #expect(CardShortcuts.action(for: .commandReturn, focus: question, target: nil) == .answerQuestions(requestId: "Q1"))
        #expect(CardShortcuts.action(for: .optionCommandReturn, focus: question, target: bash) == .none)
        #expect(CardShortcuts.action(for: .commandDelete, focus: question, target: bash) == .none)
        // From the composer (or anywhere else) Esc never keeps planning nor skips the question.
        #expect(CardShortcuts.action(for: .escape, focus: .composer(draft: ""), target: nil) == .none)
        #expect(CardShortcuts.action(for: .escape, focus: .elsewhere, target: nil) == .none)
    }
}
