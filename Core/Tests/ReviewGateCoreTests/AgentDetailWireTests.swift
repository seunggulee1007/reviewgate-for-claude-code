import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-agents: docs/PROTOCOL.md §36.1–36.4 and §36.10 on the wire — the JSON examples of §36, the lenient reading of
/// every new field (an engine before §36 sends none of them) and the two new commands.
@Suite struct AgentDetailWireTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: "q1", command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func event(_ line: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: line) }

    // MARK: - §36.1–36.3 AgentNode

    @Test func agentNodeCarriesInstructionsModelReportAndResumes() throws {
        let node = try NDJSON.decode(AgentNode.self, from: #"""
        {"id":"task-1","toolUseId":"toolu_01Ab","type":"executor","description":"couponCode 사용처","status":"running","isBackground":false,
         "depth":1,"startedAt":1792710000000,"files":[],"tokens":14794,"toolUses":12,"durationMs":491500,
         "prompt":"couponCode 가 쓰이는 곳을 모두 찾아…","model":"opus","reportPreview":"## 쿠폰 코드 사용처 14곳","cliAgentId":"a1b2c3d4",
         "resumeCount":2,"resumedBy":"toolu_02Cd"}
        """#)
        #expect(node.prompt == "couponCode 가 쓰이는 곳을 모두 찾아…")
        #expect(node.model == "opus")
        #expect(node.reportPreview == "## 쿠폰 코드 사용처 14곳")
        #expect(node.cliAgentId == "a1b2c3d4")
        #expect(node.resumeCount == 2)
        #expect(node.resumedBy == "toolu_02Cd")
        #expect(node.stoppedBy == nil)
        // §13 keeps usage where it was: the parsed <usage> overrides these numbers.
        #expect(node.tokens == 14794 && node.toolUses == 12 && node.durationMs == 491500)
    }

    @Test func agentNodeStoppedByTheUser() throws {
        let node = try NDJSON.decode(AgentNode.self, from: #"""
        {"id":"task-1","toolUseId":"toolu_01Ab","status":"stopped","stoppedBy":"user","startedAt":1,"endedAt":2,"files":[]}
        """#)
        #expect(node.status == .stopped)
        #expect(node.stoppedBy == .user)
    }

    @Test func olderAndOddAgentNodesReadAsBefore() throws {
        let old = try NDJSON.decode(AgentNode.self, from: #"{"id":"t","toolUseId":"t","status":"completed","startedAt":1,"files":[]}"#)
        #expect(old.prompt == nil && old.model == nil && old.reportPreview == nil && old.cliAgentId == nil)
        #expect(old.stoppedBy == nil && old.resumeCount == 0 && old.resumedBy == nil)
        let odd = try NDJSON.decode(AgentNode.self, from: #"""
        {"id":"t","toolUseId":"t","status":"completed","startedAt":1,"files":[],"prompt":42,"model":null,"reportPreview":"   ",
         "cliAgentId":["x"],"stoppedBy":"engine","resumeCount":"two","resumedBy":false}
        """#)
        #expect(odd.prompt == nil && odd.model == nil && odd.reportPreview == nil && odd.cliAgentId == nil)
        #expect(odd.stoppedBy == nil && odd.resumeCount == 0 && odd.resumedBy == nil)
        let doubled = try NDJSON.decode(AgentNode.self, from: #"{"id":"t","toolUseId":"t","startedAt":1,"files":[],"resumeCount":3.0}"#)
        #expect(doubled.resumeCount == 3)
    }

    // MARK: - §36.1 agent_report

    @Test func agentReportReplyFromTheExample() throws {
        let ev = try event(#"""
        {"type":"agent_report","id":"r7","toolUseId":"toolu_01Ab…","text":"## 쿠폰 코드 사용처 14곳\n- api/src/main/…","truncated":false,
         "usage":{"tokens":14794,"toolUses":12,"durationMs":491500},"model":"opus","prompt":"couponCode 가 쓰이는 곳을 모두 찾아…"}
        """#)
        guard case let .agentReport(reply) = ev else { Issue.record("not agent_report: \(ev)"); return }
        #expect(ev.replyId == "r7")
        #expect(reply.toolUseId == "toolu_01Ab…")
        #expect(reply.text == "## 쿠폰 코드 사용처 14곳\n- api/src/main/…")
        #expect(!reply.truncated)
        #expect(reply.usage == AgentUsage(tokens: 14794, toolUses: 12, durationMs: 491500))
        #expect(reply.model == "opus")
        #expect(reply.prompt == "couponCode 가 쓰이는 곳을 모두 찾아…")
    }

    @Test func agentReportWithoutNumbersModelOrInstructions() throws {
        let ev = try event(#"{"type":"agent_report","id":"r8","toolUseId":"t","text":"done","truncated":true,"usage":null,"model":null,"prompt":null}"#)
        guard case let .agentReport(reply) = ev else { Issue.record("not agent_report"); return }
        #expect(reply.truncated)
        #expect(reply.usage == nil && reply.model == nil && reply.prompt == nil)
        // A usage object without a single number reads as unknown, not as zeros.
        let empty = try event(#"{"type":"agent_report","toolUseId":"t","text":"x","usage":{"tokens":"many"}}"#)
        guard case let .agentReport(other) = empty else { Issue.record("not agent_report"); return }
        #expect(other.usage == nil)
        #expect(other.truncated == false)
    }

    // MARK: - §36.1–36.3 tool rows

    @Test func sendMessageContinuesAKnownAgent() throws {
        let ev = try event(#"""
        {"type":"tool_use","id":"toolu_02Cd…","name":"SendMessage","input":{"to":"a1b2c3d4","message":"gradle 테스트도 돌려줘"},
         "continues":{"agentToolUseId":"toolu_01Ab…","agentType":"executor"}}
        """#)
        guard case let .toolUse(id, name, _, _, info) = ev else { Issue.record("not tool_use"); return }
        #expect(id == "toolu_02Cd…" && name == "SendMessage")
        #expect(info.continues == AgentContinuation(agentToolUseId: "toolu_01Ab…", agentType: "executor"))
        // Another target (a session, a teammate) has none; a continuation without its call is no continuation.
        let other = try event(#"{"type":"tool_use","id":"x","name":"SendMessage","input":{"to":"peer"}}"#)
        guard case let .toolUse(_, _, _, _, plain) = other else { Issue.record("not tool_use"); return }
        #expect(plain.continues == nil)
        let broken = try event(#"{"type":"tool_use","id":"x","name":"SendMessage","input":{},"continues":{"agentType":"executor"}}"#)
        guard case let .toolUse(_, _, _, _, none) = broken else { Issue.record("not tool_use"); return }
        #expect(none.continues == nil)
    }

    @Test func agentResultCarriesUsageAgentIdAndStop() throws {
        let ev = try event(#"""
        {"type":"tool_result","toolUseId":"toolu_01Ab","isError":true,"preview":"[Request interrupted by user for tool use]",
         "agentUsage":{"tokens":14794,"toolUses":12,"durationMs":491500},"cliAgentId":"a1b2c3d4","stoppedBy":"user"}
        """#)
        guard case let .toolResult(_, isError, _, info) = ev else { Issue.record("not tool_result"); return }
        #expect(isError)
        #expect(info.agentUsage == AgentUsage(tokens: 14794, toolUses: 12, durationMs: 491500))
        #expect(info.cliAgentId == "a1b2c3d4")
        #expect(info.stoppedBy == .user)
        // A plain result (an older engine, another tool) has none of them.
        let plain = try event(#"{"type":"tool_result","toolUseId":"b","isError":false,"preview":"ok","truncated":true}"#)
        guard case let .toolResult(_, _, _, plainInfo) = plain else { Issue.record("not tool_result"); return }
        #expect(plainInfo.agentUsage == nil && plainInfo.cliAgentId == nil && plainInfo.stoppedBy == nil)
        #expect(plainInfo.truncated)
    }

    @Test func transcriptRowsKeepTheAgentFields() throws {
        let items = try NDJSON.decode([TranscriptItem].self, from: #"""
        [{"at":"2026-10-23T01:00:00.000Z","turn":3,"kind":"tool_use","id":"s1","name":"SendMessage","input":{"to":"a1b2c3d4","message":"m"},
          "continues":{"agentToolUseId":"a1","agentType":"executor"}},
         {"at":"2026-10-23T01:00:01.000Z","turn":3,"kind":"tool_result","toolUseId":"a1","isError":false,"preview":"## 보고","truncated":true,
          "agentUsage":{"tokens":10,"toolUses":2,"durationMs":3000},"cliAgentId":"a1b2c3d4","report":"## 보고\n전문","reportTruncated":true}]
        """#)
        guard case let .toolUse(_, _, _, _, useInfo) = items[0].kind else { Issue.record("not tool_use"); return }
        #expect(useInfo.continues?.agentToolUseId == "a1")
        guard case let .toolResult(toolUseId, _, preview, info) = items[1].kind else { Issue.record("not tool_result"); return }
        #expect(toolUseId == "a1" && preview == "## 보고")
        #expect(info.agentUsage == AgentUsage(tokens: 10, toolUses: 2, durationMs: 3000))
        #expect(info.cliAgentId == "a1b2c3d4")
        #expect(info.truncated)
    }

    // MARK: - §36.4 hud.waitingOnAgents

    private func hud(_ extra: String) throws -> HUDWire {
        try NDJSON.decode(HUDWire.self, from: #"""
        {"contextTokens":0,"contextWindow":null,"sessionCostUSD":0,"turnCount":6,"lastTurnMs":0,"activity":{"kind":"subagent"},
         "subagentDepth":2,"turnStartedAt":1792710000000,"agents":[]\#(extra)}
        """#)
    }

    @Test func waitingOnAgentsFromTheExample() throws {
        let wire = try hud(#","waitingOnAgents":{"count":2,"longest":{"toolUseId":"toolu_01Ab…","type":"executor","startedAt":1792710000000}}"#)
        #expect(wire.waitingOnAgents == WaitingOnAgents(count: 2, longest: .init(toolUseId: "toolu_01Ab…", type: "executor", startedAt: 1792710000000)))
    }

    @Test func notWaitingBetweenTurnsOrOnOlderEngines() throws {
        #expect(try hud("").waitingOnAgents == nil)
        #expect(try hud(#","waitingOnAgents":null"#).waitingOnAgents == nil)
        #expect(try hud(#","waitingOnAgents":{"count":0,"longest":null}"#).waitingOnAgents == nil)
        #expect(try hud(#","waitingOnAgents":"yes""#).waitingOnAgents == nil)
        // A count without a readable `longest` still says how many.
        let partial = try hud(#","waitingOnAgents":{"count":1,"longest":7}"#)
        #expect(partial.waitingOnAgents == WaitingOnAgents(count: 1, longest: nil))
    }

    // MARK: - §36.10 side thread fork

    @Test func sideForkSaysWhichTurnsTheForkHolds() throws {
        let fork = try NDJSON.decode(SideFork.self, from: #"{"mode":"fork_at","fromSessionId":"4c2a…","at":"b7e1…","atTurn":6,"runningTurn":7}"#)
        #expect(fork.mode == .forkAt)
        #expect(fork.atTurn == 6)
        #expect(fork.runningTurn == 7)
        let fresh = try NDJSON.decode(SideFork.self, from: #"{"mode":"fresh","fromSessionId":null,"at":null,"atTurn":null,"runningTurn":1}"#)
        #expect(fresh.mode == .fresh && fresh.atTurn == nil && fresh.runningTurn == 1)
        let old = try NDJSON.decode(SideFork.self, from: #"{"mode":"fork_full","fromSessionId":"m","at":null}"#)
        #expect(old.atTurn == nil && old.runningTurn == nil)
    }

    // MARK: - Commands

    @Test func agentReportAndStopAgentCommands() throws {
        let report = try json(.agentReport(toolUseId: "toolu_01Ab"))
        #expect(report["type"] as? String == "agent_report")
        #expect(report["toolUseId"] as? String == "toolu_01Ab")
        #expect(report["id"] as? String == "q1")
        let stop = try json(.stopAgent(toolUseId: "toolu_01Ab"))
        #expect(stop["type"] as? String == "stop_agent")
        #expect(stop["toolUseId"] as? String == "toolu_01Ab")
        #expect(Set(stop.keys) == ["type", "id", "toolUseId"])
    }
}
