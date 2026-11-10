import Foundation

// MARK: wave5 w5-fixes — docs/PROTOCOL.md §43.5: '왜?' on plan steps and agent cards (Electron whyQuestions.ts)
//
// A side question (§21) about a plan step quotes the step (§40.3 `quote` anchor); one about an agent anchors at its
// Agent call (`toolUseId`, §21: the call and Claude's words before it). The question names the step itself, so an
// engine that does not read the anchor still knows what is asked.

public enum WhyQuestions {
    /// Longest step text the question repeats (the quote keeps the whole step).
    static let questionLimit = 120

    /// Step `number` (1-based, as shown) of a plan.
    public static func planStep(number: Int, text: String) -> (anchor: SideAnchor, question: String) {
        let step = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = step.count > questionLimit ? String(step.prefix(questionLimit - 1)) + "…" : step
        return (SideAnchor(quote: SideQuoteAnchor(text: "\(number). \(step)", turn: nil)),
                String(localized: "Step \(number) of the plan, “\(shown)” — why is it needed, and which changes so far belong to it?", bundle: .module))
    }

    /// An agent, by its Agent / Task call.
    public static func agent(toolUseId: String) -> (anchor: SideAnchor, question: String) {
        (SideAnchor(toolUseId: toolUseId), String(localized: "Why was this agent started, and what did it find or change?", bundle: .module))
    }
}
