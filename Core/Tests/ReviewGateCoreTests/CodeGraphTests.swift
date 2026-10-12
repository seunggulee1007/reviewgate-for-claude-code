import Foundation
import Testing
@testable import ReviewGateCore

/// wave5 w5-graph: the board's code graph (graphify) and the user's mods on the Mac (docs/PROTOCOL.md §43.3).
@Suite @MainActor struct CodeGraphTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private static let full = #"""
    {"type":"code_graph","id":"r1","root":"/w/shop","reportPath":"/w/shop/graphify-out/GRAPH_REPORT.md","builtAt":"2026-10-20T01:02:03.000Z",
     "report":{"name":"shopfront","date":"2026-10-20","files":1204,"words":310552,"nodes":9876,"edges":32100,"communities":210,
       "extractedPct":91,"inferredPct":9,"ambiguousPct":0,"commit":"1a2b3c4d","hubs":["OrderService","CartController"],"hubCount":5,
       "gods":[{"name":"OrderService","edges":1230},{"name":"Money","edges":640}],
       "surprises":[{"from":"refund()","relation":"calls","to":"values()","confidence":"INFERRED","fromFile":"src/a/RefundPolicy.java","toFile":"src/b/Report.java"}],
       "bigCommunities":[{"id":1,"name":"CartController","nodes":310,"cohesion":0.11},{"id":2,"name":"PaymentGateway","nodes":45,"cohesion":null}],
       "isolated":812},
     "head":"9f8e7d6c","behind":37,"htmlPath":"/w/shop/graphify-out/graph.html","graphify":"/u/.local/bin/graphify","outIgnored":true,
     "build":{"running":false,"startedAt":"2026-10-24T10:00:00.000Z","finishedAt":"2026-10-24T10:02:05.000Z","ok":true,"exitCode":0,"line":"Rebuilt: 9 nodes, 10 edges, 3 communities"}}
    """#

    @Test func replyDecodesEveryFieldAndOlderOrOddShapesLeniently() throws {
        guard case let .codeGraph(r) = try decode(EngineEvent.self, Self.full) else { Issue.record("not code_graph"); return }
        #expect(r.id == "r1")
        #expect(r.root == "/w/shop")
        #expect(!r.shared)
        #expect(r.report?.nodes == 9876)
        #expect(r.report?.gods.first == CodeGraphNode(name: "OrderService", edges: 1230))
        #expect(r.report?.surprises.first?.fromFile == "src/a/RefundPolicy.java")
        #expect(r.report?.bigCommunities.last?.cohesion == nil)
        #expect(r.report?.hubCount == 5)
        #expect(r.behind == 37)
        #expect(r.build?.ok == true)
        #expect(EngineEvent.codeGraph(r).replyId == "r1")
        // A report-less reply with odd values: nothing is fatal.
        let bare = try decode(CodeGraphReply.self, #"{"root":"/w/x","reportPath":null,"report":null,"behind":"many","graphify":null,"outIgnored":false,"build":{"running":true,"startedAt":"x","line":7},"shared":true}"#)
        #expect(bare.report == nil)
        #expect(bare.behind == nil)
        #expect(bare.shared)
        #expect(bare.build?.running == true)
        #expect(bare.build?.line == nil)
    }

    @Test func freshnessSaysHowFarHeadMoved() throws {
        var r = try decode(CodeGraphReply.self, Self.full)
        #expect(CodeGraphText.freshness(r) == .behind(37))
        #expect(CodeGraphText.freshnessLabel(.behind(37)) == "37 commits behind HEAD")
        r.behind = 0
        #expect(CodeGraphText.freshness(r) == .fresh)
        r.behind = nil
        #expect(CodeGraphText.freshness(r) == .unknown)
        r.report?.commit = nil
        #expect(CodeGraphText.freshness(r) == .noCommit)
        r.report = nil
        #expect(CodeGraphText.freshness(r) == nil)
    }

    @Test func theBuildIsBlockedWithOneReasonInOrder() throws {
        var r = try decode(CodeGraphReply.self, Self.full)
        #expect(CodeGraphText.buildBlockedReason(r, unsupported: false) == nil)
        #expect(CodeGraphText.buildBlockedReason(r, unsupported: true) == SessionToolsSupport.updateReason)
        #expect(CodeGraphText.buildBlockedReason(nil, unsupported: false) != nil)
        r.build = CodeGraphBuild(running: true, startedAt: "2026-10-24T10:00:00Z")
        #expect(CodeGraphText.buildBlockedReason(r, unsupported: false) == "A build is running")
        r.outIgnored = false
        #expect(CodeGraphText.buildBlockedReason(r, unsupported: false)?.contains(".gitignore") == true)
        r.graphify = nil
        #expect(CodeGraphText.buildBlockedReason(r, unsupported: false) == "graphify is not installed")
        #expect(CodeGraphText.refusal(code: "graph_out_not_ignored", fallback: "x").contains("graphify-out/"))
        #expect(CodeGraphText.refusal(code: "unknown_command", fallback: "x") == SessionToolsSupport.updateReason)
        #expect(CodeGraphText.refusal(code: "other", fallback: "x") == "x")
    }

    @Test func buildLineAndAgoAndBars() {
        let now = ISO8601DateFormatter().date(from: "2026-10-24T10:01:20Z")!
        let running = CodeGraphBuild(running: true, startedAt: "2026-10-24T10:00:00.000Z", line: "Re-extracting code files")
        #expect(CodeGraphText.buildLine(running, now: now, language: "en") == "Building… 1m 20s · Re-extracting code files")
        let ok = CodeGraphBuild(running: false, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:02:05Z", ok: true, line: "Rebuilt: 9 nodes")
        #expect(CodeGraphText.buildLine(ok, now: now, language: "en") == "Last build succeeded · 2m 05s · Rebuilt: 9 nodes")
        let failed = CodeGraphBuild(running: false, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:00:03Z", ok: false, exitCode: 1, line: "ValueError: boom")
        #expect(CodeGraphText.buildLine(failed, now: now, language: "en") == "Last build failed · 3.0s · ValueError: boom")
        #expect(CodeGraphText.buildLine(CodeGraphBuild(running: false, startedAt: "x", ok: false, timedOut: true), now: now) == "The build ran over 10 minutes and was stopped")
        #expect(CodeGraphText.ago("2026-10-24T10:01:00Z", now: now) == "just now")
        #expect(CodeGraphText.ago("2026-10-24T09:41:20Z", now: now) == "20 min ago")
        #expect(CodeGraphText.ago("2026-10-20T10:00:00Z", now: now) == "4 d ago")
        #expect(CodeGraphText.ago("nope", now: now) == nil)
        #expect(CodeGraphText.share(0, of: 10) == 0)
        #expect(CodeGraphText.share(1, of: 1000) == 0.02)
        #expect(CodeGraphText.share(640, of: 1230) > 0.5)
        #expect(CodeGraphText.share(5, of: 0) == 0)
        #expect(CodeGraphText.fileName("src/main/java/a/B.java") == "B.java")
        #expect(CodeGraphText.fileName(nil) == nil)
        #expect(!CodeGraphText.canOpenHtml("/etc/passwd"))
        #expect(!CodeGraphText.canOpenHtml("relative/graphify-out/graph.html"))
        #expect(!CodeGraphText.canOpenHtml("/nonexistent/graphify-out/graph.html"))
    }

    @Test func storeKeepsTheLastReplyAndSaysWhyARequestFailed() async throws {
        let store = CodeGraphStore()
        let reply = try decode(CodeGraphReply.self, Self.full)
        var sent: [String] = []
        await store.refresh { cmd in
            sent.append(cmd.type)
            return .codeGraph(reply)
        }
        #expect(store.reply == reply)
        #expect(store.errorText == nil)
        await store.build { cmd in
            sent.append(cmd.type)
            throw EngineClientError.refused("graphify_missing", code: "graphify_missing")
        }
        #expect(store.errorText == "graphify is not installed")
        #expect(store.reply == reply)   // the last reply stays
        await store.refresh { _ in throw EngineClientError.refused("unknown command: code_graph", code: "unknown_command") }
        #expect(store.unsupported)
        #expect(sent == ["code_graph", "code_graph_build"])
        // An emitted event (a build's end) replaces the reply; a project change clears everything.
        var done = reply
        done.build = CodeGraphBuild(running: false, startedAt: "x", ok: true)
        store.apply(done)
        #expect(store.reply?.build?.ok == true)
        store.reset()
        #expect(store.reply == nil && store.errorText == nil && !store.unsupported)
    }

    @Test func commandsEncodeWithoutPayload() throws {
        func json(_ cmd: EngineCommand) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(cmd)) as! [String: Any]
        }
        #expect(try json(.codeGraph)["type"] as? String == "code_graph")
        #expect(try json(.codeGraphBuild)["type"] as? String == "code_graph_build")
        #expect(try json(.codeGraphBuild).count == 1)
    }

    @Test func extensionsCarryTheUsersModsWhenTheEngineSendsThem() throws {
        let ext = try decode(SessionExtensions.self, #"""
        {"settingSources":["user","project"],"plugins":[],"skills":[],"slashCommands":[],"mcpServers":[],"hooks":[],
         "mods":[{"name":"agent-board","description":"관제판","version":"0.1.0","path":"/u/.claude/dev-mods/s1/agent-board","source":"dev","sessionId":"s1","loaded":false,"hasHooks":true},
                 {"name":"","path":"/bad"},{"name":"radar","path":"/m/radar","source":"plugin_dirs","loaded":true}]}
        """#)
        #expect(ext.mods?.map(\.name) == ["agent-board", "radar"])
        #expect(ext.mods?.first?.hasHooks == true)
        #expect(CodeGraphText.modState(ext.mods![0]) == "Loads only in the Claude Code session that made it")
        #expect(CodeGraphText.modState(ext.mods![1]) == "Loaded in this session")
        let old = try decode(SessionExtensions.self, #"{"settingSources":["user"],"plugins":[]}"#)
        #expect(old.mods == nil)
    }
}
