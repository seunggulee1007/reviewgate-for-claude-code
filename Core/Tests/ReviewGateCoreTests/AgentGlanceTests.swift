import Foundation
import Testing
@testable import ReviewGateCore

/// wave4b w4b-agents: docs/PROTOCOL.md §39.3 — the MCP / Skill label rule (the engine's fixture), the new fields read
/// leniently, and the glance rules Electron's agentGlance.test.ts checks with the same cases.
@Suite struct AgentGlanceTests {
    private static let repo: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func toolLabelsMatchTheEngineFixture() throws {
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("engine/test/fixtures/toolLabels.json"))
        let root = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let cases = try #require(root["cases"] as? [[String: Any]])
        #expect(cases.count >= 10)
        for c in cases {
            let name = try #require(c["name"] as? String)
            let inputData = try JSONSerialization.data(withJSONObject: c["input"] ?? [:])
            let input = try JSONDecoder().decode(JSONValue.self, from: inputData)
            let want = try #require(c["label"] as? [String: Any])
            let got = ToolLabel.of(name, input: input)
            #expect(got.kind.rawValue == want["kind"] as? String, "\(name)")
            #expect(got.name == want["name"] as? String, "\(name)")
            #expect(got.server == want["server"] as? String, "\(name)")
            #expect(got.arg == want["arg"] as? String, "\(name) \(c["input"] ?? "")")
        }
    }

    @Test func readsTheGlanceFieldsLeniently() throws {
        let node = try decode(AgentNode.self, """
        {"id":"t1","toolUseId":"ag1","type":"executor","description":"x","status":"running","isBackground":false,"depth":1,
         "startedAt":1000,"files":[],"lastStep":{"tool":"Bash","detail":"./gradlew test","since":1500},
         "retry":{"attempt":3,"max":10,"at":2000,"status":529},"activeAt":2000,"turn":4,
         "isolation":"worktree","worktreePath":"/r/.claude/worktrees/agent-a1","worktreeBranch":"worktree-agent-a1"}
        """)
        #expect(node.lastStep == AgentStep(tool: "Bash", detail: "./gradlew test", since: 1500))
        #expect(node.retry == AgentRetry(attempt: 3, max: 10, at: 2000, status: 529))
        #expect(node.activeAt == 2000)
        #expect(node.turn == 4)
        #expect(node.isolation == "worktree")
        #expect(node.worktreeBranch == "worktree-agent-a1")
        let odd = try decode(AgentNode.self, """
        {"id":"t1","toolUseId":"ag1","status":"running","lastStep":{"tool":""},"retry":"soon","activeAt":"x","turn":null,"isolation":7}
        """)
        #expect(odd.lastStep == nil && odd.retry == nil && odd.activeAt == nil && odd.turn == nil && odd.isolation == nil)
        let hud = try decode(HUDWire.self, """
        {"contextTokens":0,"contextWindow":null,"sessionCostUSD":0,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},
         "subagentDepth":0,"agents":[],"agentHistory":[{"id":"t9","toolUseId":"ag9","status":"completed","turn":1},{"bogus":true}]}
        """)
        #expect(hud.agentHistory.map(\.toolUseId) == ["ag9"])
        let old = try decode(HUDWire.self, """
        {"contextTokens":0,"contextWindow":null,"sessionCostUSD":0,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0}
        """)
        #expect(old.agentHistory.isEmpty)
    }

    private func node(_ toolUseId: String = "ag1", type: String = "oh-my-claudecode:executor", status: AgentStatus = .running,
                      step: AgentStep? = nil) -> AgentNode {
        var n = AgentNode(id: toolUseId, toolUseId: toolUseId, type: type, description: "배치 모듈 영향 확인", status: status, startedAt: 1000)
        n.lastStep = step
        return n
    }

    @Test func stepsBadgesAndTheHudLine() {
        #expect(AgentGlance.stepLine(AgentStep(tool: "Bash", detail: "./gradlew :acme-api:test", since: 0), nowMs: 252_000, language: "ko")
            == "Bash · ./gradlew :acme-api:test · 4분 12초")
        #expect(AgentGlance.toolTitle("mcp__dooray__dooray_get_posts", detail: "4821") == "dooray · get posts · 4821")
        #expect(AgentGlance.callTitle("mcp__dooray__dooray_get_posts", input: .object(["postNumber": .number(4821)])) == "dooray · get posts · 4821")
        #expect(AgentGlance.toolTitle("Read", detail: nil) == "Read")

        var a = node()
        a.retry = AgentRetry(attempt: 3, max: 10, status: 529)
        a.activeAt = 0
        #expect(AgentGlance.badges(a, nowMs: 60_000).map(\.kind) == [.retry])
        #expect(AgentGlance.badges(a, nowMs: 125_000).map(\.kind) == [.retry, .stale])
        #expect(AgentGlance.badges(a, nowMs: 125_000, awaitingPermission: true).isEmpty)
        a.status = .completed
        #expect(AgentGlance.badges(a, nowMs: 125_000).isEmpty)
        #expect(AgentGlance.badges(node(), nowMs: 10_000_000).isEmpty)   // an older engine: no activeAt

        let agents = [
            node("a", type: "explore", step: AgentStep(tool: "Grep", detail: "TenantFilter", since: 9_000, endedAt: 9_500)),
            node("b", step: AgentStep(tool: "Edit", detail: "TenantService.java", since: 5_000)),
            node("c", type: "test-engineer"),
            node("d", status: .completed),
        ]
        let line = AgentGlance.hudLine(agents)
        #expect(line?.hasSuffix("executor: Edit TenantService.java") == true)
        #expect(line?.contains("3") == true)
        #expect(AgentGlance.hudLine([node(status: .completed)]) == nil)
        // The HUD reads the MCP tool by its label; the subagent line replaces "Subagent working" while one has a step.
        let mcp = HUDState.localizedActivity(HUDActivity(kind: .tool, toolName: "mcp__dooray__dooray_get_posts", detail: "4821"), subagentDepth: 0)
        #expect(mcp.contains("dooray · get posts") && mcp.contains("4821"))
    }

    @Test func finishedNumbersAndEarlierTurns() {
        #expect(AgentGlance.finishedLine(status: .completed, tokens: 35_000, durationMs: 64_000, files: 2, language: "en")?.hasSuffix("· 1m 04s · 35k tokens · Files 2") == true)
        #expect(AgentGlance.finishedLine(status: .running, tokens: nil, durationMs: nil, files: 0) == nil)
        #expect(AgentGlance.compactTokens(35_200) == "35.2k")
        #expect(AgentGlance.conclusionLine("\n## **쿠폰 코드** 사용처 14곳\n- api/…") == "쿠폰 코드 사용처 14곳")
        #expect(AgentGlance.conclusionLine("  \n") == nil)
        #expect(AgentGlance.conclusionLine(nil) == nil)
        var x = node("x", status: .completed); x.turn = 2
        var y = node("y", status: .failed); y.turn = 1
        var z = node("z", status: .completed); z.turn = 2
        let w = node("w", status: .completed)
        let groups = AgentGlance.historyByTurn([x, y, z, w])
        #expect(groups.map(\.turn) == [2, 1, nil])
        #expect(groups.first?.agents.map(\.toolUseId) == ["x", "z"])
    }

    @Test func whoChangedAFile() {
        func use(_ id: String, _ name: String, _ input: [String: JSONValue] = [:], parent: String? = nil, file: String? = nil) -> ChatItem {
            .toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: .object(input), info: ToolUseInfo(parentToolUseId: parent))
        }
        let index = TranscriptIndex([
            use("ag1", "Agent", ["subagent_type": .string("oh-my-claudecode:executor")]),
            use("e1", "Edit", parent: "ag1", file: "/r/A.java"),
            use("ag2", "Agent", ["subagent_type": .string("test-engineer")], parent: "ag1"),
            use("b1", "Bash", parent: "ag2"),
            use("w1", "Write", file: "/r/C.java"),
        ])
        #expect(AgentGlance.fileAuthors(["e1"], index: index).map(\.label) == ["executor"])
        #expect(AgentGlance.fileAuthors(["b1"], index: index).map(\.label) == ["test-engineer"])
        #expect(AgentGlance.fileAuthors(["w1", "e1", "e1"], index: index).map(\.key) == ["main", "ag1"])
        #expect(AgentGlance.groupFiles(index, under: "ag1") == ["/r/A.java"])
        let per: [String: [String]] = ["A.java": ["e1"], "B.java": ["b1"], "C.java": ["w1"]]
        let authors = { (p: String) in AgentGlance.fileAuthors(per[p] ?? [], index: index) }
        let offered = AgentGlance.authorFilters(["A.java", "B.java", "C.java"].map(authors))
        #expect(offered.map(\.key) == ["main", "ag1", "ag2"])
        #expect(AgentGlance.authorFilters([authors("A.java")]).isEmpty)
        #expect(AgentGlance.changesByAgent(["A.java", "B.java", "C.java"], authors: authors).map(\.paths) == [["A.java"], ["B.java"], ["C.java"]])
        #expect(AgentGlance.changesByAgent(["C.java"], authors: authors).isEmpty)
    }

    @Test func isolation() {
        var a = node()
        a.isolation = "worktree"
        a.worktreePath = "/r/.claude/worktrees/agent-a1"
        #expect(AgentGlance.isolationBadge(a) != nil)
        a.worktreePath = nil
        a.status = .failed
        #expect(AgentGlance.isolationBadge(a) == nil)   // denied by the hooks: it never ran apart
        a.isolation = "none"
        a.status = .running
        #expect(AgentGlance.isolationBadge(a) == nil)
        #expect(AgentGlance.isolationBadge(node()) == nil)
    }
}
