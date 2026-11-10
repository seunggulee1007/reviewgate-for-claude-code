import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: '왜?' on plan steps and agent cards (Electron whyQuestions.test.ts).
@Suite struct WhyQuestionsTests {
    @Test func aPlanStepIsQuotedAndItsQuestionCarriesTheStep() {
        let why = WhyQuestions.planStep(number: 3, text: "  Update FooService.java and its mapper  ")
        #expect(why.anchor == SideAnchor(quote: SideQuoteAnchor(text: "3. Update FooService.java and its mapper", turn: nil)))
        // The question names the step itself, so an engine that ignores the anchor still knows what is asked.
        #expect(why.question == "Step 3 of the plan, “Update FooService.java and its mapper” — why is it needed, and which changes so far belong to it?")
        let long = WhyQuestions.planStep(number: 1, text: String(repeating: "x", count: 300))
        #expect(long.question.contains(String(repeating: "x", count: 119) + "…"))
        #expect(long.anchor.quote?.text.count == 303)   // the quote keeps the whole step (the engine cuts at 2 000)
    }

    @Test func anAgentIsAskedAboutItsCall() {
        let why = WhyQuestions.agent(toolUseId: "toolu_01")
        #expect(why.anchor == SideAnchor(toolUseId: "toolu_01"))
        #expect(why.question == "Why was this agent started, and what did it find or change?")
    }
}
