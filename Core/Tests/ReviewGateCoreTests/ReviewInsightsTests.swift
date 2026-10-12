import Foundation
import Testing
@testable import ReviewGateCore

@Suite struct ReviewInsightsTests {
    private func file(_ path: String, status: ChangeStatus = .modified, added: Int = 1, deleted: Int = 0,
                      tools: [String] = ["Edit"], ids: [String] = [], origin: FileOrigin? = nil) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: status, added: added, deleted: deleted, isBinary: false, tools: tools, toolUseIds: ids)
        f.origin = origin
        return f
    }

    private func use(_ id: String, _ name: String, parent: String? = nil, rationale: String? = nil, file: String? = nil,
                     input: [String: JSONValue] = [:]) -> ChatItem {
        .toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: .object(input),
                 info: ToolUseInfo(parentToolUseId: parent, rationale: rationale))
    }

    private func result(_ id: String, parent: String? = nil, isError: Bool = false) -> ChatItem {
        .toolResult(id: UUID(), toolUseId: id, isError: isError, preview: "ok", info: ToolResultInfo(parentToolUseId: parent))
    }

    // MARK: Risk

    @Test func classifiesRisks() {
        #expect(FileRisk.risks(for: file(".env.local")) == [.sensitive])
        #expect(FileRisk.risks(for: file("src/a.ts", status: .deleted)) == [.deleted])
        #expect(FileRisk.risks(for: file("src/big.ts", added: 250, deleted: 51)) == [.large])
        #expect(FileRisk.risks(for: file("src/big.ts", added: 250, deleted: 50)) == [])
        // §31 (M2): "via Bash" is the engine's origin, not an empty tool list (that may be the IDE or another session).
        // wave2 mac-diff (comp-05): and Bash is the only cause — empty tools read "원인 기록 없음", never "Bash로 변경".
        #expect(FileRisk.risks(for: file("src/gen.ts", tools: [], origin: .bash)) == [])
        #expect(FileRisk.risks(for: file("src/gen.ts", tools: ["Bash"], origin: .bash)) == [.viaBash])
        #expect(FileRisk.risks(for: file("src/gen.ts", tools: ["Bash", "Edit"], origin: .tool)) == [])
        #expect(FileRisk.risks(for: file("src/mine.ts", tools: [], origin: .external)) == [])
        #expect(FileRisk.risks(for: file("src/old.ts", tools: [])) == [])
        #expect(FileRisk.risks(for: file("package-lock.json")) == [.config])
        #expect(FileRisk.risks(for: file("Core/Tests/FooTests/BarTests.swift")) == [.test])
        #expect(FileRisk.risks(for: file(".github/workflows/ci.yml")) == [.sensitive, .config])
    }

    @Test func recognizesTestAndConfigPaths() {
        for p in ["src/a.test.ts", "src/a.spec.tsx", "tests/x.py", "pkg/x_test.go", "test_api.py", "src/__tests__/a.js", "FooTest.kt"] {
            #expect(FileRisk.isTestPath(p), "\(p)")
        }
        for p in ["src/contest.ts", "src/testing.ts", "README.md"] { #expect(!FileRisk.isTestPath(p), "\(p)") }
        for p in ["yarn.lock", "Cargo.toml", "tsconfig.json", "vite.config.ts", ".eslintrc", "app/config.yaml", "go.sum", "Package.resolved"] {
            #expect(FileRisk.isConfigPath(p), "\(p)")
        }
        for p in ["src/index.ts", "docs/guide.md"] { #expect(!FileRisk.isConfigPath(p), "\(p)") }
    }

    @Test func ordersRiskyFirstAndKeepsGitOrderAmongEquals() {
        let files = [file("a.ts"), file("b.test.ts"), file("c.ts", status: .deleted), file("d.ts"), file("CLAUDE.md"), file("e.ts", tools: ["Bash"], origin: .bash)]
        // wave4b w4b-files (comp-12): a test file weighs below an ordinary edit — never above the code it tests.
        #expect(FileRisk.ordered(files).map(\.path) == ["CLAUDE.md", "c.ts", "e.ts", "a.ts", "d.ts", "b.test.ts"])
    }

    // MARK: Transcript nesting

    @Test func nestsSubagentRowsUnderTheirAgentCall() {
        let items: [ChatItem] = [
            .user(id: UUID(), text: "go"),
            use("ag1", "Agent", input: ["description": .string("explore")]),
            use("r1", "Read", parent: "ag1"),
            use("ag2", "Task", parent: "ag1"),
            use("e1", "Edit", parent: "ag2"),
            result("e1"),                       // parent inferred from its tool_use
            result("r1", parent: "ag1"),
            result("ag2", parent: "ag1"),
            result("ag1"),
            use("b1", "Bash"),
            result("b1"),
        ]
        let tree = TranscriptNode.build(items)
        #expect(tree.count == 4)   // user, ag1 group, b1, b1 result
        guard case let .agentGroup(_, id, children, res) = tree[1] else { Issue.record("no group"); return }
        #expect(id == "ag1")
        #expect(res != nil)
        #expect(children.count == 3)   // r1, ag2 group, r1 result
        guard case let .agentGroup(_, innerId, inner, innerResult) = children[1] else { Issue.record("no inner group"); return }
        #expect(innerId == "ag2" && inner.count == 2 && innerResult != nil)
        #expect(tree[1].callCount == 3)   // r1, ag2, e1
        #expect(TranscriptNode.enclosingGroups(of: "e1", in: tree) == ["ag1", "ag2"])
        #expect(TranscriptNode.enclosingGroups(of: "ag2", in: tree) == ["ag1"])
        #expect(TranscriptNode.enclosingGroups(of: "b1", in: tree) == [])
        #expect(TranscriptNode.enclosingGroups(of: "zz", in: tree) == nil)
    }

    @Test func orphanSubagentRowsStayAtTopLevel() {
        let items: [ChatItem] = [use("e1", "Edit", parent: "gone"), result("e1", parent: "gone")]
        #expect(TranscriptNode.build(items).allSatisfy { !$0.isGroup })
        #expect(TranscriptNode.build(items).count == 2)
    }

    // MARK: Change → cause

    @Test func resolvesCausesWithRationaleAndAgent() {
        let items: [ChatItem] = [
            use("ag1", "Agent", rationale: "Delegate the refactor.", input: ["subagent_type": .string("executor")]),
            use("e1", "Edit", parent: "ag1", file: "/repo/a.ts"),
            use("e2", "Edit", parent: "ag1", rationale: "Rename the helper.", file: "/repo/a.ts"),
            use("b1", "Bash", input: ["command": .string("npx prettier -w a.ts\necho done")]),
        ]
        let index = TranscriptIndex(items)
        let causes = ChangeCause.causes(for: file("a.ts", ids: ["e1", "e2", "b1", "e1", "missing"]), in: index)
        #expect(causes.map(\.toolUseId) == ["e1", "e2", "b1", "missing"])
        // wave2 mac-diff (agents-03): the agent call's sentence is the delegation, not the call's own reason.
        #expect(causes[0].rationale == nil && causes[0].delegation == "Delegate the refactor.")
        #expect(causes[0].agentLabel == "executor")
        #expect(causes[1].rationale == "Rename the helper." && causes[1].delegation == "Delegate the refactor.")
        #expect(causes[2].delegation == nil)
        #expect(causes[2].agent == nil && causes[2].call?.shortInput(root: "/repo") == "npx prettier -w a.ts")
        #expect(causes[3].call == nil && causes[3].toolName == "?")
        #expect(index.calls["e1"]?.shortInput(root: "/repo") == "a.ts")
    }

    @Test func linksToolCallsToFiles() {
        let a = file("a.ts", ids: ["b1", "e1"]), b = file("b.ts", ids: ["b1"])
        let map = ChangeLinks.filesByToolUse([a, b])
        #expect(map["b1"]?.map(\.path) == ["a.ts", "b.ts"])
        #expect(ChangeLinks.targetFile(toolUseId: "e9", file: "/repo/b.ts", files: [a, b], root: "/repo", byToolUse: map)?.path == "b.ts")
        #expect(ChangeLinks.targetFile(toolUseId: "e1", file: nil, files: [a, b], root: "/repo", byToolUse: map)?.path == "a.ts")
        #expect(ChangeLinks.targetFile(toolUseId: "e9", file: "/elsewhere/b.ts", files: [a, b], root: "/repo", byToolUse: map) == nil)
        #expect(RepoPath.relative("/repo/x/y", root: "/repo/") == "x/y")
        #expect(RepoPath.relative("x/y", root: "/repo") == "x/y")
    }

    // MARK: Agent tree

    @Test func buildsTheAgentTreeAndParallelBatches() {
        let agents = [
            AgentNode(id: "t2", toolUseId: "a2", status: .running, startedAt: 2_000),
            AgentNode(id: "t1", toolUseId: "a1", status: .completed, startedAt: 1_000, endedAt: 1_500),
            AgentNode(id: "t3", toolUseId: "a3", parentToolUseId: "a2", status: .running, depth: 2, startedAt: 2_100),
            AgentNode(id: "t4", toolUseId: "a4", status: .failed, startedAt: 2_500, endedAt: 3_000),
            AgentNode(id: "t5", toolUseId: "a5", parentToolUseId: "gone", status: .stopped, startedAt: 9_000, endedAt: 9_100),
        ]
        let roots = AgentTreeNode.build(agents)
        #expect(roots.map(\.id) == ["a1", "a2", "a4", "a5"])
        #expect(roots[1].children.map(\.id) == ["a3"])
        let batches = AgentTreeNode.parallelBatches(roots, now: 4_000)
        #expect(batches.map { $0.map(\.id) } == [["a1"], ["a2", "a4"], ["a5"]])
        #expect(AgentTreeNode.flatten(roots).map { "\($0.agent.toolUseId):\($0.level)" } == ["a1:0", "a2:0", "a3:1", "a4:0", "a5:0"])
        #expect(agents[0].elapsedMs(now: 4_000) == 2_000)
        #expect(agents[1].elapsedMs(now: 4_000) == 500)
        #expect(AgentStatus.paused.isLive && !AgentStatus.stopped.isLive)
    }

    @MainActor @Test func appStateSelectsByAbsolutePathAndCountsViewed() {
        let app = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "RI.\(UUID().uuidString)")!)
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.changedFiles = [file("a.ts"), file("b.ts")]
        s.hud.agents = [AgentNode(id: "x", toolUseId: "x", status: .running), AgentNode(id: "y", toolUseId: "y", status: .completed)]
        app.handle(.state(s))
        #expect(app.liveAgentCount == 1)
        #expect(app.selectFile(path: "/repo/b.ts"))
        #expect(app.selectedPath == "b.ts")
        #expect(!app.selectFile(path: "/repo/zzz.ts"))
        // A turn summary's file chips: relative or absolute, only a file still in the review opens.
        #expect(app.changedFile(path: "a.ts")?.path == "a.ts")
        #expect(app.changedFile(path: "/repo/a.ts")?.path == "a.ts")
        #expect(app.changedFile(path: "/elsewhere/a.ts") == nil && app.changedFile(path: "zzz.ts") == nil)
        #expect(app.viewedChangedCount == 0)   // no turnEndTree: nothing is loaded, nothing counts as viewed
    }
}
