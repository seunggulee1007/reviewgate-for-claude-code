import Foundation
import Testing
@testable import ReviewGateCore

/// wave4 w4-check3: the 0.2.3 follow-ups — a side question about a subagent offers questions about its work, and the main
/// chat's ReportFindings row reads as its findings.
@Suite struct ChatFollowupsTests {
    @Test func anAgentAnchorOffersQuestionsAboutTheAgentsWork() {
        let anchor = SideAnchor(toolUseId: "toolu_ag")
        let agent = SideQuestionText.suggestions(for: anchor, toolName: "Agent")
        #expect(agent == ["What did this agent change?", "Did this agent do what it was asked?",
                          "What are the key points of this report, and what should I check?"])
        #expect(!agent.contains("Is this safe to allow?"))
        #expect(SideQuestionText.suggestions(for: anchor, toolName: "Task") == agent)   // older CLIs
    }

    @Test func otherAnchorsKeepTheirSuggestions() {
        let bash = SideAnchor(toolUseId: "toolu_b")
        #expect(SideQuestionText.suggestions(for: bash, toolName: "Bash") == SideQuestionText.suggestions(for: bash))
        #expect(SideQuestionText.suggestions(for: bash, toolName: nil).contains("Is this safe to allow?"))
        // An agent's call on a file (an edit row's anchor) and no anchor at all are unchanged.
        let file = SideAnchor(path: "a.ts", toolUseId: "toolu_ag")
        #expect(SideQuestionText.suggestions(for: file, toolName: "Agent") == SideQuestionText.suggestions(for: file))
        #expect(SideQuestionText.suggestions(for: nil, toolName: "Agent") == SideQuestionText.suggestions(for: nil))
    }

    private func input(_ json: String) throws -> JSONValue { try NDJSON.decode(JSONValue.self, from: json) }

    @Test func reportFindingsReadsAsItsFindings() throws {
        let two = try input(#"""
        {"level":"medium","findings":[
          {"file":"api/src/main/java/com/x/Svc.java","line":42,"summary":"A soft-deleted cart now throws","short_summary":"x","failure_scenario":"y"},
          {"file":"api/src/main/java/com/x/Svc.java","line":80,"summary":"second in the same file","short_summary":"x","failure_scenario":"y"},
          {"file":"web/app.ts","line":null,"summary":"whole file","short_summary":"x","failure_scenario":"y"}]}
        """#)
        #expect(ReportFindingsLine.detail(input: two) == "3 findings · Svc.java:42, app.ts")
        let many = try input(#"{"findings":[{"file":"a.ts","line":1},{"file":"b.ts","line":2},{"file":"c.ts","line":3},{"file":"d\\e.ts","line":4.0},{"file":"f.ts"}]}"#)
        #expect(ReportFindingsLine.detail(input: many) == "5 findings · a.ts:1, b.ts:2, c.ts:3 +2")
        #expect(ReportFindingsLine.detail(input: try input(#"{"findings":[]}"#)) == "No findings")
        #expect(ReportFindingsLine.detail(input: try input(#"{"findings":[{"summary":"no file"}]}"#)) == "1 findings")
        #expect(ReportFindingsLine.detail(input: try input(#"{"command":"ls"}"#)) == nil)
        #expect(ReportFindingsLine.detail(input: try input(#"{"findings":"odd"}"#)) == nil)
    }
}
