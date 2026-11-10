import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: wave7 w7-chat — docs/PROTOCOL.md §45.1: the row-by-row transcript model gives what the full build gives (random
/// append / prepend / replace sequences), appends in order never rebuild, the streaming answer stays out of the transcript
/// until it finishes, the shared index follows the rows, and the prompt history is decoded once.
@Suite @MainActor struct TranscriptModelTests {
    /// SplitMix64: the same sequences on every run.
    struct Seeded: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// Random rows: prompts, answers, explore / edit / agent calls (parents before or after them, now and then their own
    /// id or one seen before), results (errors too, now and then before their call), cards, errors and turn ends.
    struct Rows {
        var rng: Seeded
        var calls = 0
        var agents: [String] = []
        var seen: [String] = []

        init(seed: UInt64) { rng = Seeded(state: seed) }

        mutating func chance(_ p: Double) -> Bool { Double.random(in: 0..<1, using: &rng) < p }

        mutating func parent() -> String? {
            if chance(0.55) || agents.isEmpty { return chance(0.05) ? "c\(calls + Int.random(in: 1...3, using: &rng))" : nil }
            return agents.randomElement(using: &rng)
        }

        mutating func row() -> ChatItem {
            let roll = Int.random(in: 0..<100, using: &rng)
            switch roll {
            case 0..<8:
                return .user(id: UUID(), text: "prompt \(roll)", meta: UserMessageMeta(turn: Int.random(in: 0...4, using: &rng)))
            case 8..<16:
                return .assistant(id: UUID(), text: "answer \(roll)", streaming: false)
            case 16..<60:
                calls += 1
                var id = "c\(calls)"
                if chance(0.03), let old = seen.randomElement(using: &rng) { id = old }
                let names = ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "Agent", "Task", "mcp__github__get_issue"]
                let name = names.randomElement(using: &rng)!
                var info = ToolUseInfo(parentToolUseId: chance(0.02) ? id : parent())
                info.explore = ["Read", "Grep", "Glob", "Bash", "mcp__github__get_issue"].contains(name) && chance(0.7)
                if ToolCallRecord.isAgentTool(name) { agents.append(id) }
                seen.append(id)
                let file: String? = ["Read", "Edit", "Write"].contains(name) ? "/repo/f\(Int.random(in: 0..<6, using: &rng)).swift" : nil
                return .toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: .object(["n": .number(Double(roll))]), info: info)
            case 60..<90:
                let id = chance(0.9) && !seen.isEmpty ? seen.randomElement(using: &rng)! : "c\(calls + Int.random(in: 1...2, using: &rng))"
                return .toolResult(id: UUID(), toolUseId: id, isError: chance(0.15), preview: "out \(roll)",
                                   info: ToolResultInfo(parentToolUseId: chance(0.3) ? parent() : nil))
            case 90..<94:
                return .permission(id: UUID(), request: PermissionRequest(requestId: "r\(roll)", toolName: "Bash", input: .object([:])),
                                   allowed: chance(0.5) ? true : nil)
            case 94..<97:
                return .error(id: UUID(), message: "failed \(roll)", fatal: false)
            case 97:
                return .turnSummary(id: UUID(), summary: TurnSummary(turn: 1, files: [TurnSummary.File(path: "a.ts")]))
            default:
                return .turnEnd(id: UUID(), summary: "done")
            }
        }

        mutating func rows(_ n: Int) -> [ChatItem] { (0..<n).map { _ in row() } }
    }

    /// The model equals the full build: tree, fold, index, positions and the answers' turns.
    private func expectMatchesBuild(_ model: TranscriptModel, _ items: [ChatItem], _ note: String,
                                    sourceLocation: SourceLocation = #_sourceLocation) {
        let nodes = TranscriptNode.build(items)
        #expect(model.nodes == nodes, "nodes after \(note)", sourceLocation: sourceLocation)
        #expect(model.entries == ExploreFold.fold(nodes), "entries after \(note)", sourceLocation: sourceLocation)
        #expect(model.index == TranscriptIndex(items), "index after \(note)", sourceLocation: sourceLocation)
        var positions: [UUID: Int] = [:]
        for (i, item) in items.enumerated() { positions[item.id] = i }
        #expect(model.positions == positions, "positions after \(note)", sourceLocation: sourceLocation)
        var turns: [UUID: Int] = [:]
        for (i, item) in items.enumerated() {
            if case .assistant = item, let turn = SideTrust.turnBefore(items, position: i) { turns[item.id] = turn }
        }
        #expect(model.answerTurns == turns, "answer turns after \(note)", sourceLocation: sourceLocation)
        let summary = items.last(where: { if case .turnSummary = $0 { true } else { false } })?.id
        #expect(model.lastSummaryID == summary, "last summary after \(note)", sourceLocation: sourceLocation)
    }

    @Test(arguments: [1, 2, 3, 4, 5, 6, 7, 8] as [UInt64])
    func randomSequencesMatchTheFullBuild(seed: UInt64) {
        var gen = Rows(seed: seed)
        var items: [ChatItem] = []
        var model = TranscriptModel()
        var placed = 0
        for step in 0..<160 {
            let roll = Int.random(in: 0..<100, using: &gen.rng)
            switch roll {
            case 0..<78: items += gen.rows(Int.random(in: 1...6, using: &gen.rng))
            case 78..<88: items.insert(contentsOf: gen.rows(Int.random(in: 1...4, using: &gen.rng)), at: 0)
            case 88..<93: items.removeLast(min(items.count, Int.random(in: 1...3, using: &gen.rng)))
            case 93..<96: items = gen.rows(Int.random(in: 0...30, using: &gen.rng))
            default: break   // nothing changed
            }
            if model.update(items) { placed += 1 }
            expectMatchesBuild(model, items, "step \(step) (seed \(seed), \(items.count) rows)")
        }
        #expect(placed > 20, "the row-by-row path ran (\(placed) of 160)")
    }

    /// A turn as the engine streams it: appended rows never rebuild, whatever groups, runs and errors they make.
    @Test func appendsInOrderNeverRebuild() {
        var items: [ChatItem] = []
        var model = TranscriptModel()
        func add(_ item: ChatItem) {
            items.append(item)
            model.update(items)
        }
        func call(_ id: String, _ name: String, parent: String? = nil, explore: Bool = false, file: String? = nil) {
            var info = ToolUseInfo(parentToolUseId: parent)
            info.explore = explore
            add(.toolUse(id: UUID(), toolUseId: id, name: name, file: file, input: .object([:]), info: info))
        }
        func result(_ id: String, error: Bool = false, parent: String? = nil) {
            add(.toolResult(id: UUID(), toolUseId: id, isError: error, preview: "ok", info: ToolResultInfo(parentToolUseId: parent)))
        }
        add(.user(id: UUID(), text: "go", meta: UserMessageMeta(turn: 1)))
        #expect(model.rebuilds == 1)   // the first rows are a build
        add(.assistant(id: UUID(), text: "Looking", streaming: false))
        call("r1", "Read", explore: true); result("r1")
        call("r2", "Grep", explore: true); result("r2")
        call("r3", "Read", explore: true)
        call("b1", "Bash"); result("b1", error: true)   // an error of a call no run took
        result("r3")
        call("a1", "Agent")
        call("a1.1", "Read", parent: "a1", explore: true); result("a1.1", parent: "a1")
        call("a2", "Task", parent: "a1")
        call("a2.1", "Edit", parent: "a2", file: "/repo/x.swift"); result("a2.1")
        result("a2", parent: "a1")
        call("e1", "Edit", file: "/repo/y.swift")
        result("a1")
        result("e1")
        add(.permission(id: UUID(), request: PermissionRequest(requestId: "p", toolName: "Bash", input: .object([:])), allowed: nil))
        add(.turnEnd(id: UUID(), summary: "done"))
        #expect(model.rebuilds == 1)
        expectMatchesBuild(model, items, "the turn")
        guard case let .agentGroup(_, "a1", children, result?) = model.nodes.first(where: { $0.isGroup }) else {
            Issue.record("no agent group: \(model.nodes)")
            return
        }
        #expect(children.count == 3 && result.id == items.first { if case .toolResult(_, "a1", _, _, _) = $0 { true } else { false } }?.id)
        // A row put in front rebuilds.
        items.insert(.user(id: UUID(), text: "earlier", meta: UserMessageMeta(turn: 0)), at: 0)
        model.update(items)
        #expect(model.rebuilds == 2)
        expectMatchesBuild(model, items, "the prepend")
    }

    /// The build would move earlier rows: each case rebuilds and still matches it.
    @Test func lateRowsThatMoveEarlierOnesRebuild() {
        let cases: [[ChatItem]] = [
            // a subagent row before its Agent call
            [.toolUse(id: UUID(), toolUseId: "x", name: "Read", file: nil, input: .null, info: ToolUseInfo(parentToolUseId: "a")),
             .toolUse(id: UUID(), toolUseId: "a", name: "Agent", file: nil, input: .null)],
            // a result before its call
            [.toolResult(id: UUID(), toolUseId: "a", isError: false, preview: "done"),
             .toolUse(id: UUID(), toolUseId: "a", name: "Agent", file: nil, input: .null)],
            // an error that takes a folded call out of its run
            [.toolUse(id: UUID(), toolUseId: "r1", name: "Read", file: nil, input: .null, info: { var i = ToolUseInfo(); i.explore = true; return i }()),
             .toolUse(id: UUID(), toolUseId: "r2", name: "Read", file: nil, input: .null, info: { var i = ToolUseInfo(); i.explore = true; return i }()),
             .toolResult(id: UUID(), toolUseId: "r1", isError: true, preview: "no")],
            // the same call twice
            [.toolUse(id: UUID(), toolUseId: "a", name: "Agent", file: nil, input: .null),
             .toolUse(id: UUID(), toolUseId: "a", name: "Agent", file: nil, input: .null),
             .toolUse(id: UUID(), toolUseId: "k", name: "Read", file: nil, input: .null, info: ToolUseInfo(parentToolUseId: "a"))],
        ]
        for (n, rows) in cases.enumerated() {
            var model = TranscriptModel()
            var items: [ChatItem] = [.user(id: UUID(), text: "go", meta: UserMessageMeta(turn: 1))]
            model.update(items)
            for row in rows {
                items.append(row)
                model.update(items)
                expectMatchesBuild(model, items, "case \(n)")
            }
            #expect(model.rebuilds > 1, "case \(n) rebuilt")
        }
    }

    // MARK: - The streaming answer (AppState)

    private func makeState(_ d: UserDefaults? = nil) -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: d ?? UserDefaults(suiteName: "TranscriptModelTests.\(UUID().uuidString)")!)
    }

    @Test func deltasStayOutOfTheTranscriptUntilTheRowFinishes() {
        let app = makeState()
        app.handle(.userMessage(text: "hi", turn: 1))
        app.handle(.textDelta(text: "Hel"))
        let rows = app.transcript.count
        let structure = app.transcriptStructureRevision
        let revision = app.transcriptRevision
        guard case let .assistant(id, "Hel", true, false) = app.transcript.last else { Issue.record("\(app.transcript)"); return }
        #expect(app.liveText.rowID == id && app.liveText.text == "Hel")
        let liveRevision = app.liveText.revision
        for piece in ["lo", ", ", "world"] { app.handle(.textDelta(text: piece)) }
        // The row is untouched (no copy of the transcript per delta); the buffer has the text; nobody was told yet.
        #expect(app.transcript.count == rows && app.transcriptStructureRevision == structure && app.transcriptRevision == revision)
        guard case .assistant(_, "Hel", true, false) = app.transcript.last else { Issue.record("\(app.transcript)"); return }
        #expect(app.liveText.text == "Hello, world" && app.liveText.revision == liveRevision)
        // The burst is told once.
        app.publishLiveText()
        app.publishLiveText()
        #expect(app.liveText.revision == liveRevision + 1 && app.transcriptRevision == revision + 1)
        // The turn goes on: the row gets the whole text, finished, and nothing streams any more.
        app.handle(.toolUse(id: "t", name: "Read", input: .object([:]), file: nil))
        guard case .assistant(id, "Hello, world", false, false) = app.transcript[rows - 1] else { Issue.record("\(app.transcript)"); return }
        #expect(app.liveText.rowID == nil && app.liveText.text.isEmpty)
        #expect(app.transcriptStructureRevision == structure + 1)
    }

    @Test func coalescedPublishRunsAfterTheBurst() async {
        let app = makeState()
        app.handle(.textDelta(text: "a"))
        let revision = app.transcriptRevision
        for piece in ["b", "c", "d"] { app.handle(.textDelta(text: piece)) }
        #expect(app.transcriptRevision == revision)
        for _ in 0..<5 { await Task.yield() }
        #expect(app.transcriptRevision == revision + 1 && app.liveText.text == "abcd")
    }

    @Test func aRowPutAfterTheStreamingOneKeepsItsTextAndTheNextDeltaStartsAnew() {
        let app = makeState()
        app.handle(.textDelta(text: "one "))
        app.handle(.textDelta(text: "two"))
        // A budget row comes between deltas: the open row gets its text and is finished, a new message follows.
        app.handle(.budgetEvent(kind: .warn, toolName: "Edit", file: nil, files: 1, lines: 2, budget: Budget(maxFiles: 5, maxLines: 100)))
        app.handle(.textDelta(text: "three"))
        #expect(app.transcript.count == 3)
        guard case .assistant(_, "one two", false, false) = app.transcript[0],
              case .assistant(let second, "three", true, false) = app.transcript[2] else { Issue.record("\(app.transcript)"); return }
        #expect(app.liveText.rowID == second)
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1), files: 0, added: 0, deleted: 0))
        guard case .assistant(_, "three", false, false) = app.transcript[2] else { Issue.record("\(app.transcript)"); return }
    }

    @Test func aRowPutAfterTheLastAnswerDoesNotLeaveItStreaming() {
        let app = makeState()
        app.handle(.textDelta(text: "the answer"))
        // The turn ends with a row after the answer (a Stop hook's error, a lock notice) and no delta follows.
        app.handle(.budgetEvent(kind: .warn, toolName: "Edit", file: nil, files: 1, lines: 2, budget: Budget(maxFiles: 5, maxLines: 100)))
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1), files: 0, added: 0, deleted: 0))
        guard case .assistant(_, "the answer", false, false) = app.transcript[0] else { Issue.record("\(app.transcript)"); return }
        #expect(app.liveText.rowID == nil)
    }

    @Test func aReplacedTranscriptDropsTheStreamingText() {
        let app = makeState()
        app.handle(.textDelta(text: "partial"))
        app.replaceTranscriptOnRestore = true
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 1, kind: .userMessage(text: "old"))]))
        #expect(app.liveText.rowID == nil && app.transcript.count == 1)
        app.handle(.textDelta(text: "new"))
        guard case .assistant(_, "new", true, false) = app.transcript.last else { Issue.record("\(app.transcript)"); return }
    }

    @Test func structureRevisionFollowsTheShapeOnly() {
        let app = makeState()
        app.handle(.userMessage(text: "a", turn: 1))
        let request = PermissionRequest(requestId: "p", toolName: "Bash", input: .object([:]))
        app.transcript.append(.permission(id: UUID(), request: request, allowed: nil))
        let structure = app.transcriptStructureRevision
        // A decision in place: same shape.
        app.transcript[1] = .permission(id: app.transcript[1].id, request: request, allowed: true)
        #expect(app.transcriptStructureRevision == structure)
        // Same count, another last row: a new shape.
        app.transcript[1] = .turnEnd(id: UUID(), summary: "x")
        #expect(app.transcriptStructureRevision == structure + 1)
        // A row in front.
        app.transcript.insert(.turnEnd(id: UUID(), summary: "y"), at: 0)
        #expect(app.transcriptStructureRevision == structure + 2)
    }

    // MARK: - The shared index

    @Test func theSharedIndexFollowsTheRowsNotTheDeltas() {
        let app = makeState()
        app.handle(.userMessage(text: "go", turn: 1))
        app.handle(.toolUse(id: "e1", name: "Edit", input: .object([:]), file: "/repo/a.swift"))
        #expect(app.transcriptIndex.calls["e1"]?.name == "Edit")
        let builds = app.transcriptModel.rebuilds
        app.handle(.toolResult(toolUseId: "e1", isError: false, preview: "ok"))
        #expect(app.transcriptIndex.calls["e1"]?.preview == "ok")
        app.handle(.textDelta(text: "Done"))
        for _ in 0..<20 { app.handle(.textDelta(text: ".")) }
        app.handle(.toolUse(id: "b1", name: "Bash", input: .object(["command": .string("ls")]), file: nil))
        #expect(app.transcriptIndex.calls["b1"] != nil)
        #expect(app.transcriptModel.rebuilds == builds)   // appended rows are placed, never rebuilt
        // A page of earlier rows goes in front: rebuilt once, with them.
        app.handle(.transcriptRestore(items: [TranscriptItem(at: "t", turn: 0, kind: .toolUse(id: "old", name: "Read", input: .object([:]), file: nil))]))
        #expect(app.transcriptIndex.calls["old"] != nil && app.transcriptModel.rebuilds == builds + 1)
    }

    @Test func groupFilesAndConclusionsAreTheGlanceRules() {
        let items: [ChatItem] = [
            .toolUse(id: UUID(), toolUseId: "a", name: "Agent", file: nil, input: .null),
            .toolUse(id: UUID(), toolUseId: "b", name: "Task", file: nil, input: .null, info: ToolUseInfo(parentToolUseId: "a")),
            .toolUse(id: UUID(), toolUseId: "e1", name: "Edit", file: "/r/z.swift", input: .null, info: ToolUseInfo(parentToolUseId: "b")),
            .toolUse(id: UUID(), toolUseId: "e2", name: "Write", file: "/r/a.swift", input: .null, info: ToolUseInfo(parentToolUseId: "a")),
            .toolUse(id: UUID(), toolUseId: "e3", name: "Edit", file: "/r/z.swift", input: .null, info: ToolUseInfo(parentToolUseId: "a")),
            .toolUse(id: UUID(), toolUseId: "r", name: "Read", file: "/r/q.swift", input: .null, info: ToolUseInfo(parentToolUseId: "a")),
        ]
        let lookups = TranscriptLookups()
        lookups.update(items, key: 1)
        let index = TranscriptIndex(items)
        for group in ["a", "b", "e1", "x"] {
            #expect(lookups.groupFiles(under: group) == AgentGlance.groupFiles(index, under: group), "group \(group)")
        }
        let row = UUID()
        #expect(lookups.conclusion(row: row, text: "## 결론\n**all** good") == AgentGlance.conclusionLine("## 결론\n**all** good"))
        #expect(lookups.conclusion(row: row, text: "ignored: the row's line was worked out") == "결론")
        let call = items[1]
        #expect(lookups.searchText(call) == TranscriptSearch.searchableText(call))
    }

    /// A reveal / ⌘F jump to a row deep inside an expanded agent group: the chat draws the groups around it all at once
    /// (`eagerGroups`) and scrolls to the outermost group's head before the row, so both lookups must name them.
    @Test func aDeepGroupRowNamesItsGroupsAndTheOuterHead() {
        let outer = ChatItem.toolUse(id: UUID(), toolUseId: "ag", name: "Agent", file: nil, input: .null)
        let inner = ChatItem.toolUse(id: UUID(), toolUseId: "sub", name: "Task", file: nil, input: .null, info: ToolUseInfo(parentToolUseId: "ag"))
        var items = [ChatItem.user(id: UUID(), text: "go"), outer, inner]
        for i in 0..<70 {
            items.append(.toolUse(id: UUID(), toolUseId: "e\(i)", name: "Edit", file: "/r/f\(i).swift", input: .null,
                                  info: ToolUseInfo(parentToolUseId: "sub")))
            items.append(.toolResult(id: UUID(), toolUseId: "e\(i)", isError: false, preview: "ok \(i)",
                                     info: ToolResultInfo(parentToolUseId: "sub")))
        }
        let lookups = TranscriptLookups()
        lookups.update(items, key: 1)
        let model = lookups.model
        let deep = items[items.count - 2]   // the 70th Edit
        #expect(TranscriptNode.enclosingGroups(of: "e69", in: model.nodes) == ["ag", "sub"])
        #expect(TranscriptSearch.enclosingGroups(ofRow: deep.id, in: model.nodes) == ["ag", "sub"])
        #expect(TranscriptSearch.enclosingGroups(ofRow: items.last!.id, in: model.nodes) == ["ag", "sub"])
        #expect(model.index.calls["e69"]?.rowID == deep.id)
        #expect(model.index.calls["ag"]?.rowID == outer.id)
    }

    @Test func aRowPutInFrontMovesTheBuildCountTheRowsCompare() {
        let lookups = TranscriptLookups()
        let call = ChatItem.toolUse(id: UUID(), toolUseId: "b1", name: "Bash", file: nil, input: .null)
        let result = ChatItem.toolResult(id: UUID(), toolUseId: "b1", isError: false, preview: "ok")
        lookups.update([result], key: 1)
        let before = lookups.model.rebuilds
        #expect(lookups.model.index.calls["b1"] == nil)
        lookups.update([result, .assistant(id: UUID(), text: "a", streaming: false)], key: 2)
        #expect(lookups.model.rebuilds == before)   // appended: the shown rows keep their facts
        lookups.update([call, result], key: 3)
        #expect(lookups.model.rebuilds == before + 1)   // the call put in front: the result's row looks its call up again
        #expect(lookups.model.index.calls["b1"]?.name == "Bash")
    }

    // MARK: - Row texts

    @Test func rowTextsAreWorkedOutOncePerRow() {
        let row = UUID()
        let small: JSONValue = .object(["command": .string("ls -la"), "n": .number(3)])
        #expect(TranscriptRowCache.tooltip(row: row, input: small) == small.prettyPrinted)
        // A call's input never changes: the row's text is the first one worked out.
        #expect(TranscriptRowCache.tooltip(row: row, input: .object(["other": .string("x")])) == small.prettyPrinted)
        // A 1.3 MB Write: capped, its path still there.
        let big: JSONValue = .object(["file_path": .string("/r/a.swift"), "content": .string(String(repeating: "line of code\n", count: 100_000))])
        let tip = TranscriptRowCache.tooltip(row: UUID(), input: big)
        #expect(tip.count <= TranscriptRowCache.tooltipLimit + 1 && tip.contains("\"file_path\" : \"/r/a.swift\"") && tip.contains("…"))
        let medium: JSONValue = .object(["prompt": .string(String(repeating: "x", count: 3_000))])
        #expect(medium.prettyPrinted(limit: TranscriptRowCache.tooltipLimit) == medium.prettyPrinted)
        let edit: JSONValue = .object(["old_string": .string("a\nb"), "new_string": .string("a\nc")])
        let editRow = UUID()
        #expect(TranscriptRowCache.editPreview(row: editRow, name: "Edit", input: edit) == ToolEditPreview.make(name: "Edit", input: edit))
        #expect(TranscriptRowCache.editPreview(row: editRow, name: "Edit", input: .null) == ToolEditPreview.make(name: "Edit", input: edit))
        #expect(TranscriptRowCache.editPreview(row: UUID(), name: "Read", input: edit) == nil)
        let md = "## Title\n\n- one\n- two\n\n```swift\nlet x = 1\n```"
        #expect(TranscriptRowCache.markdownBlocks(md) == MarkdownBlocks.parse(md))
        #expect(TranscriptRowCache.markdownBlocks(md) == MarkdownBlocks.parse(md))
    }

    // MARK: - Prompt history

    @Test func promptHistoryIsDecodedOnceUntilThisWindowAddsOne() {
        let suite = "TranscriptModelTests.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        defer { d.removePersistentDomain(forName: suite) }   // the history it wrote does not stay behind
        let app = makeState(d)
        app.commandSink = { _ in }
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/h", root: "/h", name: "h", branch: "main", remoteURL: nil)
        app.handle(.state(s))
        AppSettings.appendPromptHistory("first", root: AppSettings.projectKey(URL(fileURLWithPath: "/h")), defaults: d)
        #expect(app.promptHistory == ["first"])
        // Written behind its back (no window does that): the decoded list is kept.
        AppSettings.appendPromptHistory("behind", root: AppSettings.projectKey(URL(fileURLWithPath: "/h")), defaults: d)
        #expect(app.promptHistory == ["first"])
        // This window's own prompt drops it.
        app.recordPrompt("mine")
        #expect(app.promptHistory == ["first", "behind", "mine"])
    }
}
