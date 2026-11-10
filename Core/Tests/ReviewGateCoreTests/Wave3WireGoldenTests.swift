import Foundation
import Testing
@testable import ReviewGateCore

/// wave4 w4-check3: the §36 agent / pre-review shapes as the engine really sends them (`engine/test/fixtures/wire/
/// wave3.agents.json`, written by engine.wave3Wire.test.ts) — the 0.2.3 screens were built against the §36 examples only.
@Suite struct Wave3WireGoldenTests {
    private static let fixture: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire/wave3.agents.json")
    }()

    private func golden() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixture)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
        return try NDJSON.decode(type, from: String(decoding: data, as: UTF8.self))
    }

    @Test func everyEventDecodesWithItsWave3Fields() throws {
        let events = try #require(golden()["events"] as? [Any]).map { try decode(EngineEvent.self, $0) }
        #expect(events.count == 7)

        guard case let .toolUse(id, name, _, _, _) = events[0] else { Issue.record("Agent tool_use"); return }
        #expect(id == "toolu_ag" && name == "Agent")
        guard case let .toolUse(_, sendName, _, _, sendInfo) = events[1] else { Issue.record("SendMessage tool_use"); return }
        #expect(sendName == "SendMessage")
        #expect(sendInfo.continues == AgentContinuation(agentToolUseId: "toolu_ag", agentType: "Explore"))
        guard case let .toolUse(_, reportName, input, _, _) = events[2] else { Issue.record("ReportFindings tool_use"); return }
        #expect(reportName == ReportFindingsLine.toolName)
        #expect(ReportFindingsLine.detail(input: input) == "2 findings · README.md:2, other.txt")

        guard case let .toolResult(resultId, isError, preview, resultInfo) = events[3] else { Issue.record("Agent tool_result"); return }
        #expect(resultId == "toolu_ag" && !isError && preview == "## 사용처 14곳")
        #expect(resultInfo.agentUsage == AgentUsage(tokens: 14794, toolUses: 12, durationMs: 491500))
        #expect(resultInfo.cliAgentId == "a1b2c3")
        #expect(resultInfo.stoppedBy == nil)
        guard case let .toolResult(_, _, _, continuedInfo) = events[4] else { Issue.record("SendMessage tool_result"); return }
        #expect(continuedInfo.agentUsage == nil && continuedInfo.cliAgentId == nil)   // CLI 2.1.309 puts no trailer on it

        guard case let .agentReport(report) = events[5] else { Issue.record("agent_report"); return }
        #expect(report == AgentReportReply(id: "req-1", toolUseId: "toolu_ag", text: "## 사용처 14곳\n- api/a.ts", truncated: false,
                                           usage: AgentUsage(tokens: 14794, toolUses: 12, durationMs: 491500), model: "opus",
                                           prompt: "find couponCode"))

        guard case let .prereview(reply) = events[6] else { Issue.record("prereview"); return }
        #expect(reply.run.prereviewId == "toolu_rf")
        #expect(reply.run.source == .main && reply.run.status == .done)
        #expect(reply.run.scope == nil && reply.run.effort == nil)   // a main-chat run has neither
        #expect(reply.run.findings.map(\.file) == ["README.md", "other.txt"])
        #expect(reply.run.findings.map(\.line) == [2, nil])
        #expect(reply.run.findings[0].shortSummary == "no test" && reply.run.findings[0].failureScenario == "a reader of line 2 breaks")
        #expect(reply.run.findings[0].category == "test-coverage" && reply.run.findings[1].category == nil)
    }

    @Test func theHudWhileTheTurnWaitsAndAfterTheContinuation() throws {
        let g = try golden()
        let waiting = try #require(g["waitingHud"] as? [String: Any])
        let agents = try decode([AgentNode].self, try #require(waiting["agents"]))
        #expect(agents.map(\.toolUseId) == ["toolu_ag"])
        #expect(agents[0].prompt == "find couponCode" && agents[0].model == "opus" && agents[0].status == .running)
        #expect(agents[0].reportPreview == nil && agents[0].resumeCount == 0)
        let w = try decode(WaitingOnAgents.self, try #require(waiting["waitingOnAgents"]))
        #expect(w == WaitingOnAgents(count: 1, longest: .init(toolUseId: "toolu_ag", type: "Explore", startedAt: 1_700_000_000_000)))

        let resumed = try #require(g["resumedHud"] as? [String: Any])
        let again = try decode([AgentNode].self, try #require(resumed["agents"]))
        #expect(again[0].resumeCount == 1 && again[0].resumedBy == "toolu_sm" && again[0].status == .running)
        #expect(again[0].cliAgentId == "a1b2c3" && again[0].reportPreview == "## 사용처 14곳\n- api/a.ts")
        #expect(again[0].tokens == 14794 && again[0].toolUses == 12 && again[0].durationMs == 491500)
        // A blocking continuation counts as waiting (§36.4).
        #expect(try decode(WaitingOnAgents.self, try #require(resumed["waitingOnAgents"])).count == 1)
    }

    @Test func theReviewKeepsTheMainChatsRun() throws {
        let runs = try decode([PreReviewRun].self, try #require(golden()["prereviews"]))
        #expect(runs.map(\.prereviewId) == ["toolu_rf"])
        #expect(runs[0].source == .main && runs[0].endTree == "<tree B>")
        #expect(PreReviewDisplay.shownRuns(runs).count == 1)
    }
}
