import Foundation
import Testing
@testable import ReviewGateCore

/// Protocol v2 wire types against the golden fixtures the engine's test suite writes to
/// `engine/test/fixtures/wire/` (decoding) and the command JSON the app sends (encoding).
@Suite struct EngineProtocolTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Decoding goldens

    @Test func decodesInitialState() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(state.seq == 1)
        #expect(state.project == nil)
        #expect(state.gitInit == nil)
        #expect(!state.session.open)
        #expect(state.session.capabilities == nil)
        #expect(state.toolchain.claude == nil)
        #expect(state.gate.phase == .idle)
        #expect(state.gate.blockedReason == .noSession)
        #expect(state.changedFiles.isEmpty)
        #expect(state.budget == Budget(maxFiles: 5, maxLines: 200))
        #expect(state.hud.activity.kind == .idle)
        #expect(state.hud.turnStartedAt == nil)
        #expect(state.branches.switchBlocker == nil)
        #expect(state.pr.host == "github.com")
        #expect(state.pr.lastSubmitResult == nil)
        #expect(state.lastError == nil)
        // A `state` event wraps the same snapshot.
        let event = try NDJSON.decode(EngineEvent.self, from: "{\"type\":\"state\",\"state\":\(try fixture("state.initial.json"))}")
        #expect(event == .state(state))
    }

    /// `state.hud.agents` is optional (older engines) and tolerant of unknown statuses / missing fields.
    @Test func decodesHudAgentsLeniently() throws {
        let old = try NDJSON.decode(HUDWire.self, from: #"{"contextTokens":0,"contextWindow":null,"sessionCostUSD":0,"turnCount":0,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0,"turnStartedAt":null}"#)
        #expect(old.agents.isEmpty)
        let hud = try NDJSON.decode(HUDWire.self, from: #"{"contextTokens":0,"contextWindow":null,"sessionCostUSD":0,"turnCount":0,"lastTurnMs":0,"activity":{"kind":"subagent"},"subagentDepth":1,"turnStartedAt":5,"agents":[{"id":"t1","toolUseId":"ag1","parentToolUseId":"ag0","type":"Plan","description":"d","status":"hibernating","isBackground":true,"depth":2,"startedAt":5,"files":["a.ts"]},{"id":"ag2"}]}"#)
        #expect(hud.agents == [AgentNode(id: "t1", toolUseId: "ag1", parentToolUseId: "ag0", type: "Plan", description: "d", status: .running,
                                         isBackground: true, depth: 2, startedAt: 5, files: ["a.ts"]),
                               AgentNode(id: "ag2", toolUseId: "ag2")])
    }

    @Test func decodesReviewingState() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        #expect(state.seq == 42)
        #expect(state.project == ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil))
        #expect(state.session.open)
        #expect(state.session.sessionId == "sess-1")
        #expect(state.session.model == "claude-test")
        let caps = try #require(state.session.capabilities)
        // §36.5: the engine says the session's lists are ready (`capabilities.state`); the fixture's CLI lists no commands.
        var expected = SessionCapabilities(slashCommands: ["commit"], skills: ["graphify"], plugins: ["p"],
                                           mcpServers: [(name: "fs", status: "connected")],
                                           pluginDetails: [PluginDetail(name: "p", path: "/p", id: nil)])
        expected.state = .ready
        #expect(caps == expected)
        #expect(state.toolchain.claude == "/usr/bin/true")
        #expect(state.gate.phase == .reviewing)
        // A pending review leaves the input open: sending asks a question, it never accepts (§10).
        #expect(state.gate.canSend && state.gate.canRequestChanges && state.gate.blockedReason == nil)
        #expect(state.gate.pendingCount == 1)
        #expect(state.gate.turnStartTree == "39d4a6a666e123cf991fb753f142aa4132a12ef7")
        #expect(state.gate.turnEndTree == "a914defe34f932be66198d956585ee44643d4f89")
        #expect(state.gate.lastReviewSummary == "[Review gate] Accepted: new.txt.")

        #expect(state.changedFiles.count == 2)
        let readme = state.changedFiles[0]
        #expect(readme.path == "README.md" && readme.oldPath == nil && readme.status == .modified)
        #expect(readme.added == 2 && readme.deleted == 1 && !readme.isBinary)
        #expect(readme.tools == ["Edit"] && readme.state == .pending && readme.noteCount == 1)
        #expect(readme.toolUseIds == ["toolu_1"])
        var newFile = ChangedFile(path: "new.txt", oldPath: nil, status: .added, added: 1, deleted: 0, isBinary: false, tools: [],
                                  state: .accepted, noteCount: 0)
        newFile.origin = .external   // §31: no tool explains it
        // §34 (the engine's suite writes the golden): the turn added it, its blob in B, no recorded reason.
        newFile.changedThisTurn = true
        newFile.turnAdded = 1
        newFile.turnDeleted = 0
        newFile.blob = "d5a09df94c94924d13f8b5cd72a193b3eddb08cb"
        newFile.why = FileWhy(text: nil, source: .noRecord, turn: 1)
        // wave4b w4b-files (§40.2): the engine's badges — "앱 밖 변경" — and its weight.
        newFile.engineRisks = ["external"]
        newFile.riskScore = 20
        #expect(readme.engineRisks == [] && readme.riskScore == 0)
        #expect(state.changedFiles[1] == newFile)
        #expect(state.reviewNotes == [ReviewNote(id: "note-1", path: "README.md", line: 2, side: .new, excerpt: "line2 changed", body: "why?")])

        #expect(state.hud.contextTokens == 100 && state.hud.sessionCostUSD == 0.01 && state.hud.turnCount == 1 && state.hud.lastTurnMs == 1234)
        // wave4b w4b-agents (§39.3): the golden's node also carries the turn it started in.
        #expect(state.hud.agents.first?.turn == 1)
        #expect(state.hud.agents.map { var n = $0; n.turn = nil; return n } == [AgentNode(id: "task-1", toolUseId: "toolu_ag", type: "Explore", description: "Inspect README",
                                               status: .completed, isBackground: false, depth: 1, lastTool: "Edit", summary: "Edited README",
                                               tokens: 1500, toolUses: 2, durationMs: 3000, startedAt: 1_700_000_000_000,
                                               endedAt: 1_700_000_000_000, files: ["README.md"])])
        let branch = try #require(state.branches.list.first)
        #expect(branch.name == "main" && branch.isCurrent && branch.upstream == nil && branch.ahead == 0 && branch.behind == 0)
        #expect(branch.lastCommitDate == Date(timeIntervalSince1970: 1_767_323_045))
        #expect(state.branches.switchBlocker == .pendingReview(1))
    }

    @Test func decodesFileDiff() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: try fixture("file_diff.json"))
        guard case let .fileDiff(id, scope, path, diff, truncated, endTree, _) = event else { Issue.record("not a file_diff: \(event)"); return }
        #expect(endTree == "a914defe34f932be66198d956585ee44643d4f89")   // §17: the B the diff was computed for
        #expect(id == "req-1" && event.replyId == "req-1")
        #expect(scope == .turn && path == "README.md" && !truncated)
        #expect(diff.oldPath == "README.md" && diff.newPath == "README.md" && !diff.isBinary)
        #expect(diff.hunks.count == 1)
        let hunk = diff.hunks[0]
        #expect(hunk.id == 0 && hunk.header == "@@ -1,3 +1,4 @@")
        #expect(hunk.lines.map(\.kind) == [.hunkHeader, .context, .del, .add, .context, .add])
        #expect(hunk.lines[0] == DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@ -1,3 +1,4 @@"))
        #expect(hunk.lines[2] == DiffLine(id: 2, kind: .del, oldNo: 2, newNo: nil, text: "line2"))
        #expect(hunk.lines[3] == DiffLine(id: 3, kind: .add, oldNo: nil, newNo: 2, text: "line2 changed"))
        #expect(hunk.lines[5] == DiffLine(id: 5, kind: .add, oldNo: nil, newNo: 4, text: "line4"))
        #expect(diff.allLines.count == 6)
    }

    @Test func decodesFullFileContent() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: try fixture("full_file_content.json"))
        guard case let .fullFileContent(id, view) = event else { Issue.record("not a full_file_content: \(event)"); return }
        #expect(id == "req-2")
        #expect(view.path == "README.md")
        #expect(view.lines == ["line1", "line2 changed", "line3", "line4"])
        #expect(view.changedNewLines == [2, 4])
        #expect(view.deletedAfterNewLine == [1: ["line2"]])   // string keys on the wire
        #expect(!view.isBinary && !view.isTooLarge)
    }

    // MARK: - M10 workbenches

    /// `state.workbenches` / `state.lockConflict` / `state.pr.lastCreatedPR` decode from a hand-written fixture
    /// (docs/M10-WORKBENCHES.md shapes) and default to nil when an older engine omits them.
    @Test func decodesWorkbenchesAndLockConflict() throws {
        let initial = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(initial.workbenches == .empty && initial.lockConflict == nil && initial.pr.lastCreatedPR == nil)

        var obj = try #require(JSONSerialization.jsonObject(with: Data(try fixture("state.initial.json").utf8)) as? [String: Any])
        // An engine without M10 omits the keys entirely.
        obj["workbenches"] = nil
        obj["lockConflict"] = nil
        var prObj = try #require(obj["pr"] as? [String: Any])
        prObj["lastCreatedPR"] = nil
        obj["pr"] = prObj
        let legacy = try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        #expect(legacy.workbenches == nil && legacy.lockConflict == nil && legacy.pr.lastCreatedPR == nil)

        obj["workbenches"] = [
            "list": [
                ["path": "/repo", "branch": "main", "head": "abc123", "isMain": true, "isCurrent": false,
                 "locked": ["pid": 4242, "since": "2026-01-02T03:04:05.678Z", "client": "mac"], "dirty": false],
                ["path": "/Users/me/.reviewgate/worktrees/repo-deadbeef/feature-x", "branch": "feature-x", "head": "def456",
                 "isMain": false, "isCurrent": true, "locked": NSNull(), "dirty": NSNull()],
                ["path": "/elsewhere/detached"],
            ],
            "current": "/Users/me/.reviewgate/worktrees/repo-deadbeef/feature-x",
            "managedRoot": "/Users/me/.reviewgate/worktrees/repo-deadbeef",
        ]
        obj["lockConflict"] = ["path": "/repo", "pid": 777, "since": "2026-01-02T03:04:05Z", "client": "windows"]
        prObj["lastCreatedPR"] = ["url": "https://github.com/o/r/pull/9", "branch": "feature-x"]
        obj["pr"] = prObj
        let decoded = try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        let wb = try #require(decoded.workbenches)
        #expect(wb.current == "/Users/me/.reviewgate/worktrees/repo-deadbeef/feature-x")
        #expect(wb.managedRoot == "/Users/me/.reviewgate/worktrees/repo-deadbeef")
        #expect(wb.list.count == 3)
        let main = wb.list[0]
        #expect(main.path == "/repo" && main.branch == "main" && main.head == "abc123" && main.isMain && !main.isCurrent)
        #expect(main.dirty == false)
        let lock = try #require(main.locked)
        #expect(lock.pid == 4242 && lock.client == "mac" && lock.path == nil)
        #expect(abs((lock.sinceDate?.timeIntervalSince1970 ?? 0) - 1_767_323_045.678) < 0.001)
        let feature = wb.list[1]
        #expect(feature.id == feature.path && feature.branch == "feature-x" && !feature.isMain && feature.isCurrent)
        #expect(feature.locked == nil && feature.dirty == nil)
        // Missing optional fields default (only `path` is required).
        #expect(wb.list[2] == WorkbenchInfo(path: "/elsewhere/detached", branch: nil, head: "", isMain: false, isCurrent: false, locked: nil, dirty: nil))
        let conflict = try #require(decoded.lockConflict)
        #expect(conflict == LockConflict(pid: 777, since: "2026-01-02T03:04:05Z", client: "windows", path: "/repo"))
        #expect(conflict.sinceDate == Date(timeIntervalSince1970: 1_767_323_045))
        let pr = try #require(decoded.pr.lastCreatedPR)
        #expect(pr.url == "https://github.com/o/r/pull/9" && pr.branch == "feature-x")
        // A bare URL string is accepted too.
        prObj["lastCreatedPR"] = "https://github.com/o/r/pull/10"
        obj["pr"] = prObj
        let bare = try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        #expect(bare.pr.lastCreatedPR == CreatedPR(url: "https://github.com/o/r/pull/10"))
        // `WorkbenchesInfo` with nothing but an empty object decodes to `.empty`.
        #expect(try NDJSON.decode(WorkbenchesInfo.self, from: "{}") == .empty)
        // `pr_created` is the typed reply to `pr_create`.
        let created = try NDJSON.decode(EngineEvent.self, from: #"{"type":"pr_created","id":"p1","url":"https://x/pull/1","branch":"feature-x"}"#)
        #expect(created == .prCreated(id: "p1", url: "https://x/pull/1", branch: "feature-x") && created.replyId == "p1")
    }

    @Test func encodesToolOutputCommand() throws {
        let cmd = try json(EngineCommandEnvelope(id: "o1", command: .toolOutput(toolUseId: "b1")))
        #expect(cmd["type"] as? String == "tool_output" && cmd["toolUseId"] as? String == "b1" && cmd["id"] as? String == "o1")
    }

    @Test func encodesWorkbenchCommands() throws {
        let plain = try json(EngineCommandEnvelope(id: "o", command: .openProject(path: "/wt")))
        #expect(Set(plain.keys) == ["type", "id", "path"])   // takeover omitted unless true
        let takeover = try json(EngineCommandEnvelope(command: .openProject(path: "/wt", takeover: true)))
        #expect(takeover["type"] as? String == "open_project" && takeover["takeover"] as? Bool == true)

        let create = try json(EngineCommandEnvelope(command: .workbenchCreate(branch: "feature-x", from: "main")))
        #expect(create["type"] as? String == "workbench_create")
        #expect(Set(create.keys) == ["type", "branch", "from"])
        #expect(create["branch"] as? String == "feature-x" && create["from"] as? String == "main")
        let createDefault = try json(EngineCommandEnvelope(command: .workbenchCreate(branch: "b")))
        #expect(Set(createDefault.keys) == ["type", "branch"])
        let withPath = try json(EngineCommandEnvelope(command: .workbenchCreate(branch: "b", path: "/custom")))
        #expect(withPath["path"] as? String == "/custom")

        let remove = try json(EngineCommandEnvelope(command: .workbenchRemove(path: "/wt/feature-x")))
        #expect(Set(remove.keys) == ["type", "path"] && remove["type"] as? String == "workbench_remove")
        let forced = try json(EngineCommandEnvelope(command: .workbenchRemove(path: "/wt/feature-x", force: true)))
        #expect(forced["force"] as? Bool == true)

        for (cmd, type) in [(EngineCommand.workbenchList, "workbench_list"), (.workbenchPrune, "workbench_prune")] {
            let obj = try json(EngineCommandEnvelope(command: cmd))
            #expect(obj["type"] as? String == type && obj.count == 1)
        }

        let pr = try json(EngineCommandEnvelope(command: .prCreate(base: "main", title: "T", body: "B", draft: true)))
        #expect(pr["type"] as? String == "pr_create")
        #expect(Set(pr.keys) == ["type", "base", "title", "body", "draft"])
        #expect(pr["base"] as? String == "main" && pr["draft"] as? Bool == true)
        let prMinimal = try json(EngineCommandEnvelope(command: .prCreate(base: "develop")))
        #expect(Set(prMinimal.keys) == ["type", "base"])

        let root = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(worktreeRoot: "/wt"))))
        #expect((root["settings"] as? [String: Any])?["worktreeRoot"] as? String == "/wt")
    }

    // MARK: - M12 commit (docs/M12-COMMIT.md)

    /// `state.commit` decodes from an inline fixture, tolerates missing fields, and is nil on engines without M12;
    /// `committed` is the typed reply to `commit`.
    @Test func decodesCommitStateAndCommittedEvent() throws {
        let initial = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        let initialCommit = try #require(initial.commit)
        #expect(!initialCommit.canCommit && initialCommit.acceptedPaths.isEmpty && initialCommit.lastCommit == nil)
        #expect(initialCommit.identity == CommitIdentity(name: nil, email: nil) && !initialCommit.identity.isComplete)
        let reviewing = try #require(try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json")).commit)
        #expect(reviewing.canCommit && reviewing.acceptedPaths == ["new.txt"] && reviewing.identity.isComplete)
        #expect(reviewing.suggestedMessage == "Change README\n\nFiles:\n- new.txt")

        var obj = try #require(JSONSerialization.jsonObject(with: Data(try fixture("state.initial.json").utf8)) as? [String: Any])
        // An engine without M12 omits the key entirely.
        obj["commit"] = nil
        let legacy = try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        #expect(legacy.commit == nil)
        obj["commit"] = [
            "lastCommit": [
                "sha": "0123456789abcdef0123456789abcdef01234567", "shortSha": "0123456", "message": "Add README\n\nFiles:\n- README.md",
                "branch": "main", "pushed": false, "pushError": "push_failed:fatal: no remote", "files": ["README.md"],
                "at": "2026-01-02T03:04:05.678Z",
            ],
            "canCommit": true,
            "acceptedPaths": ["README.md", "src/a.swift"],
            "identity": ["name": "Me", "email": NSNull()],
            "suggestedMessage": "Append commit-test to README.md\n\nFiles:\n- README.md",
        ]
        let decoded = try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self))
        let commit = try #require(decoded.commit)
        #expect(commit.canCommit && commit.acceptedPaths == ["README.md", "src/a.swift"])
        #expect(commit.identity == CommitIdentity(name: "Me", email: nil) && !commit.identity.isComplete)
        #expect(commit.suggestedMessage.hasPrefix("Append commit-test to README.md\n\nFiles:"))
        let last = try #require(commit.lastCommit)
        #expect(last == LastCommit(sha: "0123456789abcdef0123456789abcdef01234567", shortSha: "0123456", message: "Add README\n\nFiles:\n- README.md",
                                   branch: "main", pushed: false, pushError: "push_failed:fatal: no remote", files: ["README.md"],
                                   at: "2026-01-02T03:04:05.678Z"))

        // Tolerant: `lastCommit: null`, missing identity / suggestedMessage, shortSha derived from sha.
        obj["commit"] = ["lastCommit": NSNull(), "canCommit": false, "acceptedPaths": []]
        let sparse = try #require(try NDJSON.decode(ReviewState.self, from: String(decoding: try JSONSerialization.data(withJSONObject: obj), as: UTF8.self)).commit)
        #expect(sparse == CommitState(lastCommit: nil, canCommit: false, acceptedPaths: [], identity: CommitIdentity(), suggestedMessage: ""))
        #expect(try NDJSON.decode(CommitState.self, from: "{}") == .empty)
        #expect(try NDJSON.decode(LastCommit.self, from: #"{"sha":"abcdef0123456789"}"#).shortSha == "abcdef0")
        #expect(CommitIdentity(name: "Me", email: "me@x").isComplete)

        let committed = try NDJSON.decode(EngineEvent.self, from: #"{"type":"committed","id":"c1","sha":"abc123def456","shortSha":"abc123d","pushed":true,"branch":"main"}"#)
        #expect(committed == .committed(id: "c1", sha: "abc123def456", shortSha: "abc123d", pushed: true, branch: "main") && committed.replyId == "c1")
        let minimal = try NDJSON.decode(EngineEvent.self, from: #"{"type":"committed","sha":"abc123def456","branch":null}"#)
        #expect(minimal == .committed(id: nil, sha: "abc123def456", shortSha: "abc123d", pushed: false, branch: ""))
    }

    @Test func encodesCommitCommandsAndSettings() throws {
        let full = try json(EngineCommandEnvelope(id: "c", command: .commit(message: "msg\n\nbody", paths: ["a", "b"], push: true)))
        #expect(full["type"] as? String == "commit")
        #expect(Set(full.keys) == ["type", "id", "message", "paths", "push"])
        #expect(full["message"] as? String == "msg\n\nbody" && full["paths"] as? [String] == ["a", "b"] && full["push"] as? Bool == true)
        let minimal = try json(EngineCommandEnvelope(command: .commit(message: "m")))
        #expect(Set(minimal.keys) == ["type", "message"])   // paths / push omitted → engine defaults
        let push = try json(EngineCommandEnvelope(command: .push))
        #expect(push["type"] as? String == "push" && push.count == 1)

        let settings = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(commitPushByDefault: true, commitTrailer: "Co-Authored-By: X <x@y>"))))
        let s = try #require(settings["settings"] as? [String: Any])
        #expect(Set(s.keys) == ["commitPushByDefault", "commitTrailer"])
        #expect(s["commitPushByDefault"] as? Bool == true && s["commitTrailer"] as? String == "Co-Authored-By: X <x@y>")

        let d = UserDefaults(suiteName: "EngineProtocolTests.commit.\(UUID().uuidString)")!
        let defaults = AppSettings.engineSettings(defaults: d)
        #expect(defaults.commitPushByDefault == false && defaults.commitTrailer == "")
        d.set(true, forKey: AppSettings.Key.commitPushByDefault)
        d.set("  Signed-off-by: Me <me@x>\n", forKey: AppSettings.Key.commitTrailer)
        let stored = AppSettings.engineSettings(defaults: d)
        #expect(stored.commitPushByDefault == true && stored.commitTrailer == "Signed-off-by: Me <me@x>")
    }

    // MARK: - Decoding streaming events

    @Test func decodesStreamingEventsAndReplies() throws {
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"ready","id":"h","engineVersion":"0.1.0","platform":"darwin","protocolVersion":2}"#)
                == .ready(id: "h", engineVersion: "0.1.0", platform: "darwin", protocolVersion: 2))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"a","ok":true}"#) == .result(id: "a", ok: true, error: nil))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"b","ok":false,"error":"gate_closed:running"}"#)
                == .result(id: "b", ok: false, error: "gate_closed:running"))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"user_message","text":"hi","turn":1}"#) == .userMessage(text: "hi", turn: 1))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"text_delta","text":"pong"}"#) == .textDelta(text: "pong"))
        // §18: text of a turn Claude Code ran on its own.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"text_delta","text":"bg","unprompted":true}"#) == .textDelta(text: "bg", unprompted: true))
        // §17: the tree the diff was computed for.
        let withTree = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_diff","id":"d","scope":"turn","path":"a","diff":{"oldPath":"a","newPath":"a","isBinary":false,"hunks":[]},"truncated":false,"endTree":"B7"}"#)
        guard case let .fileDiff(_, _, _, _, _, tree, _) = withTree else { Issue.record("not a file_diff"); return }
        #expect(tree == "B7")
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/p/x"},"file":"/p/x"}"#)
                == .toolUse(id: "t1", name: "Edit", input: .object(["file_path": .string("/p/x")]), file: "/p/x"))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_result","toolUseId":"t1","isError":false,"preview":"ok"}"#)
                == .toolResult(toolUseId: "t1", isError: false, preview: "ok"))
        // Cause linkage (newer engines): parent / rationale on tool_use, truncated / testOutcome on tool_result, tool_output reply.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_use","id":"t2","name":"Edit","input":{},"parentToolUseId":"ag1","rationale":"Fix it."}"#)
                == .toolUse(id: "t2", name: "Edit", input: .object([:]), file: nil, info: ToolUseInfo(parentToolUseId: "ag1", rationale: "Fix it.")))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_result","toolUseId":"b1","isError":true,"preview":"x","parentToolUseId":"ag1","truncated":true,"testOutcome":"fail"}"#)
                == .toolResult(toolUseId: "b1", isError: true, preview: "x", info: ToolResultInfo(parentToolUseId: "ag1", truncated: true, testOutcome: .fail)))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_result","toolUseId":"b2","isError":false,"preview":"x","testOutcome":"flaky"}"#)
                == .toolResult(toolUseId: "b2", isError: false, preview: "x"))
        let output = try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_output","id":"o1","toolUseId":"b1","output":"full","truncated":false}"#)
        #expect(output == .toolOutput(id: "o1", toolUseId: "b1", output: "full", truncated: false) && output.replyId == "o1")
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_output","toolUseId":"zz","output":null,"truncated":false}"#)
                == .toolOutput(id: nil, toolUseId: "zz", output: nil, truncated: false))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"permission_request","requestId":"r1","toolName":"Bash","input":{"command":"ls"}}"#)
                == .permissionRequest(PermissionRequest(requestId: "r1", toolName: "Bash", input: .object(["command": .string("ls")]))))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"budget_event","kind":"warn","toolName":"Edit","files":6,"lines":10,"budget":{"maxFiles":5,"maxLines":200}}"#)
                == .budgetEvent(kind: .warn, toolName: "Edit", file: nil, files: 6, lines: 10, budget: Budget(maxFiles: 5, maxLines: 200)))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"activity","kind":"tool_start","toolName":"Bash","detail":"ls"}"#)
                == .activity(kind: .toolStart, toolName: "Bash", detail: "ls"))
        let turnEnd = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"costUsd":0.5,"durationMs":1500,"cacheReadTokens":0,"cacheCreationTokens":0,"contextTokens":3},"files":2,"added":5,"deleted":1}"#)
        #expect(turnEnd == .turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 2, costUsd: 0.5, durationMs: 1500, contextTokens: 3),
                                    files: 2, added: 5, deleted: 1))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"error","message":"boom","fatal":true,"scope":"session"}"#)
                == .error(message: "boom", fatal: true, scope: .session))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"log","level":"warn","message":"m"}"#) == .log(level: .warn, message: "m"))
        #expect(EngineEvent.textDelta(text: "x").replyId == nil)
    }

    // MARK: - M13 (audit 1.1–1.4, 3.1): review-integrity signals, session restart, transcript restore

    @Test func decodesReviewIntegritySignalsAndCanRestart() throws {
        let reviewing = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        #expect(reviewing.gate.changedOutside.isEmpty && reviewing.gate.ignoredTouched.isEmpty && reviewing.gate.filteredByPattern.isEmpty)
        #expect(!reviewing.gate.restored)
        #expect(reviewing.session.canRestart)

        // Older engines omit every M13 field → empty / false.
        var legacy = try fixture("state.reviewing.json")
        for key in ["changedOutside", "ignoredTouched", "filteredByPattern"] {
            legacy = legacy.replacingOccurrences(of: "\"\(key)\": \\[\\],\\s*", with: "", options: .regularExpression)
        }
        legacy = legacy.replacingOccurrences(of: ",\\s*\"restored\": false", with: "", options: .regularExpression)
        legacy = legacy.replacingOccurrences(of: ",\\s*\"canRestart\": true", with: "", options: .regularExpression)
        #expect(!legacy.contains("canRestart") && !legacy.contains("restored") && !legacy.contains("changedOutside"))
        let old = try NDJSON.decode(ReviewState.self, from: legacy)
        #expect(old.gate.changedOutside.isEmpty && !old.gate.restored && !old.session.canRestart)

        let signals = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json")
            .replacingOccurrences(of: "\"changedOutside\": []", with: "\"changedOutside\": [\"/Users/me/.claude/CLAUDE.md\"]")
            .replacingOccurrences(of: "\"ignoredTouched\": []", with: "\"ignoredTouched\": [\".env\", \"build/out.js\"]")
            .replacingOccurrences(of: "\"filteredByPattern\": []", with: "\"filteredByPattern\": [\".omc/state.json\"]")
            .replacingOccurrences(of: "\"restored\": false", with: "\"restored\": true"))
        #expect(signals.gate.changedOutside == ["/Users/me/.claude/CLAUDE.md"])
        #expect(signals.gate.ignoredTouched == [".env", "build/out.js"])
        #expect(signals.gate.filteredByPattern == [".omc/state.json"])
        #expect(signals.gate.restored)
    }

    @Test func encodesRestartSessionAndAutoRestartSetting() throws {
        let restart = try json(EngineCommandEnvelope(id: "r", command: .restartSession))
        #expect(restart["type"] as? String == "restart_session" && Set(restart.keys) == ["type", "id"])

        let settings = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(autoRestartSession: false))))
        let s = try #require(settings["settings"] as? [String: Any])
        #expect(Set(s.keys) == ["autoRestartSession"] && s["autoRestartSession"] as? Bool == false)

        let d = UserDefaults(suiteName: "EngineProtocolTests.restart.\(UUID().uuidString)")!
        #expect(AppSettings.engineSettings(defaults: d).autoRestartSession == true)   // default on
        d.set(false, forKey: AppSettings.Key.autoRestartSession)
        #expect(AppSettings.engineSettings(defaults: d).autoRestartSession == false)
    }

    @Test func decodesTranscriptRestore() throws {
        let line = #"{"type":"transcript_restore","items":[{"at":"2026-09-14T00:00:00.000Z","turn":1,"kind":"user_message","text":"hi"},{"at":"2026-09-14T00:00:01.000Z","turn":1,"kind":"assistant_text","text":"pong"},{"at":"t","turn":1,"kind":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/p/x"},"file":"/p/x"},{"at":"t","turn":1,"kind":"tool_result","toolUseId":"t1","isError":false,"preview":"ok"},{"at":"t","turn":1,"kind":"permission","requestId":"r1","toolName":"Bash","allow":true},{"at":"t","turn":1,"kind":"budget_event","event":"deny","toolName":"Write","files":6,"lines":300},{"at":"t","turn":1,"kind":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"costUsd":0.5,"durationMs":1500},"files":2,"added":5,"deleted":1,"changedOutside":["/x"]},{"at":"t","turn":2,"kind":"something_new","payload":1}]}"#
        let event = try NDJSON.decode(EngineEvent.self, from: line)
        guard case let .transcriptRestore(items) = event else { Issue.record("not a transcript_restore: \(event)"); return }
        #expect(items.count == 8)
        #expect(items[0] == TranscriptItem(at: "2026-09-14T00:00:00.000Z", turn: 1, kind: .userMessage(text: "hi")))
        #expect(items[1].kind == .assistantText(text: "pong"))
        #expect(items[1].kind != .assistantText(text: "pong", unprompted: true))
        let marked = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":1,"kind":"assistant_text","text":"bg","unprompted":true}"#)
        #expect(marked.kind == .assistantText(text: "bg", unprompted: true))
        #expect(items[2].kind == .toolUse(id: "t1", name: "Edit", input: .object(["file_path": .string("/p/x")]), file: "/p/x"))
        #expect(items[3].kind == .toolResult(toolUseId: "t1", isError: false, preview: "ok"))
        #expect(items[4].kind == .permission(requestId: "r1", toolName: "Bash", allow: true, file: nil))
        #expect(items[5].kind == .budgetEvent(kind: .deny, toolName: "Write", file: nil, files: 6, lines: 300))
        #expect(items[6].kind == .turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 2, costUsd: 0.5, durationMs: 1500),
                                          files: 2, added: 5, deleted: 1, changedOutside: ["/x"]))
        #expect(items[7].kind == .other(kind: "something_new") && items[7].turn == 2)
        let linked = #"{"type":"transcript_restore","items":[{"at":"t","turn":1,"kind":"tool_use","id":"t1","name":"Edit","input":{},"parentToolUseId":"ag1","rationale":"why"},{"at":"t","turn":1,"kind":"tool_result","toolUseId":"t1","isError":false,"preview":"ok","truncated":true,"testOutcome":"pass"}]}"#
        guard case let .transcriptRestore(linkedItems) = try NDJSON.decode(EngineEvent.self, from: linked) else { Issue.record("not a transcript_restore"); return }
        #expect(linkedItems[0].kind == .toolUse(id: "t1", name: "Edit", input: .object([:]), file: nil, info: ToolUseInfo(parentToolUseId: "ag1", rationale: "why")))
        #expect(linkedItems[1].kind == .toolResult(toolUseId: "t1", isError: false, preview: "ok", info: ToolResultInfo(truncated: true, testOutcome: .pass)))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"transcript_restore"}"#) == .transcriptRestore(items: []))
    }

    // MARK: - M15 (docs/M15-POLISH.md): chat sessions, refresh

    @Test func decodesSessionsInfoTolerantly() throws {
        let line = """
        {"list":[{"id":"s2","title":"Fix the build","createdAt":"2026-09-15T01:00:00.000Z","updatedAt":"2026-09-15T01:05:00.000Z","turns":3,"costUSD":0.42,"lastUserText":"and the tests"},
                 {"id":"s1","title":"New chat","createdAt":"2026-09-14T00:00:00Z","updatedAt":"2026-09-14T00:00:00Z","turns":0,"costUSD":0,"lastUserText":"","archived":true,"resumeFailed":true},
                 {"id":"s0"}],
         "currentId":"s2","openTabIds":["s1","s2"]}
        """
        let info = try NDJSON.decode(SessionsInfo.self, from: line)
        #expect(info.currentId == "s2" && info.openTabIds == ["s1", "s2"])
        #expect(info.list.count == 3)
        #expect(info.list[0] == SessionMeta(id: "s2", title: "Fix the build", createdAt: "2026-09-15T01:00:00.000Z",
                                            updatedAt: "2026-09-15T01:05:00.000Z", turns: 3, costUSD: 0.42, lastUserText: "and the tests"))
        #expect(info.list[0].updatedDate == Date(timeIntervalSince1970: 1_789_434_300))
        #expect(info.list[1].archived && info.list[1].resumeFailed && info.list[1].updatedDate == Date(timeIntervalSince1970: 1_789_344_000))
        #expect(info.list[2] == SessionMeta(id: "s0", title: "") && info.list[2].updatedDate == nil)
        #expect(try NDJSON.decode(SessionsInfo.self, from: "{}") == .empty)

        // `state.sessions` is optional (absent on older engines: `state.initial.json`) and rides along in the snapshot.
        #expect(try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json")).sessions?.currentId == nil)
        let golden = try #require(try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json")).sessions)
        #expect(golden.currentId == "sess-1" && golden.openTabIds == ["sess-1"])
        var expected = SessionMeta(id: "sess-1", title: "Change README", createdAt: "2026-01-02T03:04:05Z",
                                   updatedAt: "2026-01-02T03:04:05Z", turns: 1, costUSD: 0.01, lastUserText: "Change README")
        expected.cliKnown = true   // §30 (wave1 mac-session)
        #expect(golden.list == [expected])
    }

    @Test func encodesRefreshAndSessionCommands() throws {
        let all = try json(EngineCommandEnvelope(id: "r1", command: .refresh()))
        #expect(all["type"] as? String == "refresh" && all["id"] as? String == "r1" && Set(all.keys) == ["type", "id"])
        let scoped = try json(EngineCommandEnvelope(command: .refresh(scope: [.review, .pr])))
        #expect(scoped["scope"] as? [String] == ["review", "pr"])

        #expect(Set(try json(EngineCommandEnvelope(id: "l", command: .sessionList)).keys) == ["type", "id"])
        #expect(try json(EngineCommandEnvelope(command: .sessionNew))["type"] as? String == "session_new")
        // The session id is `sessionId`: `id` stays the correlation id of the envelope.
        let open = try json(EngineCommandEnvelope(id: "o1", command: .sessionOpen(id: "s1")))
        #expect(open["type"] as? String == "session_open" && open["id"] as? String == "o1" && open["sessionId"] as? String == "s1")
        let rename = try json(EngineCommandEnvelope(command: .sessionRename(id: "s1", title: "Better")))
        #expect(rename["type"] as? String == "session_rename" && rename["sessionId"] as? String == "s1" && rename["title"] as? String == "Better")
        let archive = try json(EngineCommandEnvelope(command: .sessionArchive(id: "s1", archived: true)))
        #expect(archive["type"] as? String == "session_archive" && archive["archived"] as? Bool == true)
        let delete = try json(EngineCommandEnvelope(command: .sessionDelete(id: "s1")))
        #expect(delete["type"] as? String == "session_delete" && delete["sessionId"] as? String == "s1")
        let tabs = try json(EngineCommandEnvelope(command: .tabsSet(openTabIds: ["s1", "s2"])))
        #expect(tabs["type"] as? String == "tabs_set" && tabs["openTabIds"] as? [String] == ["s1", "s2"])
    }

    @Test func projectUIStateRoundTripsPerRoot() {
        let d = UserDefaults(suiteName: "EngineProtocolTests.ui.\(UUID().uuidString)")!
        #expect(AppSettings.projectUIState(root: "/a", defaults: d) == AppSettings.ProjectUIState())
        AppSettings.setProjectUIState(AppSettings.ProjectUIState(diffFraction: 0.6, sidebarTab: "prs", selectedPath: "x.txt"), root: "/a", defaults: d)
        AppSettings.setProjectUIState(AppSettings.ProjectUIState(diffFraction: 0.3, diffCollapsed: true), root: "/b", defaults: d)
        #expect(AppSettings.projectUIState(root: "/a", defaults: d) == AppSettings.ProjectUIState(diffFraction: 0.6, sidebarTab: "prs", selectedPath: "x.txt"))
        #expect(AppSettings.projectUIState(root: "/a", defaults: d).diffCollapsed == nil)
        #expect(AppSettings.projectUIState(root: "/b", defaults: d).diffFraction == 0.3)
        #expect(AppSettings.projectUIState(root: "/b", defaults: d).diffCollapsed == true)
    }

    @Test func sensitivePathsForAcceptAll() {
        for path in [".claude/settings.json", "sub/.claude/hooks.json", ".mcp.json", "CLAUDE.md", "docs/CLAUDE.md",
                     ".github/workflows/ci.yml", ".env", ".env.local", "config/prod.env", "secrets.env.example"] {
            #expect(AppState.isSensitivePath(path), "\(path) should be sensitive")
        }
        for path in ["README.md", "src/env.ts", "environment.md", ".githubx/workflows/a.yml", "claude.md.bak", "src/.envelope/x"] {
            #expect(!AppState.isSensitivePath(path), "\(path) should not be sensitive")
        }
    }

    /// PR dates arrive as GitHub emits them; `submittedAt` may carry fractional seconds (`toISOString()`).
    @Test func decodesWireDatesWithAndWithoutFractionalSeconds() throws {
        var state = try fixture("state.initial.json")
        state = state.replacingOccurrences(of: "\"lastSubmitResult\": null",
            with: #""lastSubmitResult": {"reviewURL":"https://x/1","inlineCount":2,"event":"APPROVE","submittedAt":"2026-01-02T03:04:05.678Z"}"#)
        state = state.replacingOccurrences(of: "\"mine\": []",
            with: #""mine": [{"number":1,"title":"t","repo":"o/r","host":"github.com","author":"me","updatedAt":"2026-01-02T03:04:05Z","url":"u","isDraft":false}]"#)
        let decoded = try NDJSON.decode(ReviewState.self, from: state)
        let result = try #require(decoded.pr.lastSubmitResult)
        #expect(result.event == .approve && result.inlineCount == 2)
        #expect(abs(result.submittedAt.timeIntervalSince1970 - 1_767_323_045.678) < 0.001)
        #expect(decoded.pr.mine.first?.updatedAt == Date(timeIntervalSince1970: 1_767_323_045))
        #expect(decoded.pr.mine.first?.id == "github.com/o/r#1")
        // `state.pr.files` carries no patch.
        var withFile = try fixture("state.initial.json")
        withFile = withFile.replacingOccurrences(of: "\"files\": []",
            with: #""files": [{"filename":"a.swift","previousFilename":null,"status":"modified","additions":1,"deletions":0}]"#)
        let file = try #require(try NDJSON.decode(ReviewState.self, from: withFile).pr.files.first)
        #expect(file.filename == "a.swift" && file.patch == nil)
    }

    // MARK: - Encoding commands

    @Test func encodesHelloWithProtocolVersionAndSettings() throws {
        let settings = EngineSettings(budget: Budget(maxFiles: 5, maxLines: 200, hardMultiplier: 1.5), ignorePatterns: [".omc/"],
                                      autoAllowTools: ["Bash"], loadUserSettings: true, systemPromptAppend: "prompt",
                                      claudePath: nil, ghHost: "github.com")
        let obj = try json(EngineCommandEnvelope(id: "h1", command: .hello(env: ["PATH": "/usr/bin"], settings: settings)))
        #expect(obj["type"] as? String == "hello")
        #expect(obj["id"] as? String == "h1")
        #expect(obj["protocolVersion"] as? Int == 2)
        #expect(obj["client"] as? String == "mac")
        #expect((obj["env"] as? [String: String]) == ["PATH": "/usr/bin"])
        let s = try #require(obj["settings"] as? [String: Any])
        #expect(Set(s.keys) == ["budget", "ignorePatterns", "autoAllowTools", "loadUserSettings", "systemPromptAppend", "ghHost"])   // worktreeRoot omitted when nil
        #expect((s["budget"] as? [String: Any])?["hardMultiplier"] as? Double == 1.5)
        #expect(s["autoAllowTools"] as? [String] == ["Bash"])
    }

    @Test func encodesPartialSettingsAndPayloadCommands() throws {
        let budgetOnly = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(budget: Budget(maxFiles: 3, maxLines: 30)))))
        #expect(budgetOnly["id"] == nil)
        #expect(Set(budgetOnly.keys) == ["type", "settings"])
        #expect(Set(try #require(budgetOnly["settings"] as? [String: Any]).keys) == ["budget"])
        let hostOnly = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(ghHost: "ghe.example"))))
        #expect((hostOnly["settings"] as? [String: Any])?["ghHost"] as? String == "ghe.example")

        let open = try json(EngineCommandEnvelope(id: "o", command: .openProject(path: "/tmp/p")))
        #expect(open["type"] as? String == "open_project" && open["path"] as? String == "/tmp/p" && open["id"] as? String == "o")

        let note = try json(EngineCommandEnvelope(command: .addNote(path: "a.txt", line: nil, side: .new, excerpt: "x", body: "why")))
        #expect(note["type"] as? String == "add_note")
        #expect(note["line"] is NSNull)   // explicit null for whole-file notes
        #expect(note["side"] as? String == "new")

        let perm = try json(EngineCommandEnvelope(command: .permissionResponse(requestId: "r", allow: false, message: "no")))
        #expect(Set(perm.keys) == ["type", "requestId", "allow", "message"])
        #expect(perm["allow"] as? Bool == false)

        let reject = try json(EngineCommandEnvelope(command: .reject(paths: ["a", "b"])))
        #expect(reject["type"] as? String == "reject" && reject["paths"] as? [String] == ["a", "b"])

        let draft = try json(EngineCommandEnvelope(command: .prAddDraft(path: "f", line: 3, side: "RIGHT", body: "nit")))
        #expect(Set(draft.keys) == ["type", "path", "line", "side", "body"])
        let submit = try json(EngineCommandEnvelope(command: .prSubmit(event: .requestChanges, body: "b")))
        #expect(submit["event"] as? String == "REQUEST_CHANGES")
        let create = try json(EngineCommandEnvelope(command: .createBranch(name: "feat")))
        #expect(Set(create.keys) == ["type", "name"])

        for (cmd, type) in [(EngineCommand.closeProject, "close_project"), (.acceptAll, "accept_all"), (.rejectAll(), "reject_all"),
                            (.retryCollect, "retry_collect"), (.branches, "branches"), (.prList, "pr_list"),
                            (.prReloadComments, "pr_reload_comments"), (.accounts, "accounts"), (.shutdown, "shutdown")] {
            let obj = try json(EngineCommandEnvelope(command: cmd))
            #expect(obj["type"] as? String == type)
            #expect(obj.count == 1, "\(type) carries no payload")
        }
        #expect(EngineCommandEnvelope.shutdown.command == .shutdown)
    }

    @Test func settingsFromDefaultsRendersPromptAndParsesPatterns() throws {
        let d = UserDefaults(suiteName: "EngineProtocolTests.\(UUID().uuidString)")!
        d.set(7, forKey: AppSettings.Key.budgetMaxFiles)
        d.set("Limit {maxFiles}/{maxLines}", forKey: AppSettings.Key.systemPromptAppend)
        d.set(".omc/\n# c\n\n*.log\n", forKey: AppSettings.Key.checkpointIgnorePatterns)
        d.set(true, forKey: AppSettings.Key.autoAllowBash)
        d.set(false, forKey: AppSettings.Key.loadUserSettings)
        d.set("ghe.example", forKey: PRStore.hostDefaultsKey)
        let s = AppSettings.engineSettings(defaults: d)
        #expect(s.budget == .off)   // §54: the change limit is off until Settings turns it on
        #expect(s.systemPromptAppend == "Limit 7/400")   // placeholders get the limit's numbers, on or off
        #expect(s.ignorePatterns == [".omc/", "*.log"])
        #expect(s.autoAllowTools == ["Bash"])
        #expect(s.loadUserSettings == false)
        #expect(s.ghHost == "ghe.example")
        #expect(s.claudePath == nil && s.model == nil)
        #expect(s.worktreeRoot == NSString(string: "~/.reviewgate/worktrees").expandingTildeInPath)
        d.set("~/wb ", forKey: AppSettings.Key.worktreeRoot)
        #expect(AppSettings.engineSettings(defaults: d).worktreeRoot == NSString(string: "~/wb").expandingTildeInPath)
        d.set(true, forKey: AppSettings.Key.budgetEnabled)
        #expect(AppSettings.engineSettings(defaults: d).budget == Budget(maxFiles: 7, maxLines: 400, hardMultiplier: 2.0))   // M16 defaults 10/400/×2
    }

    // MARK: M16 friction (docs/M16-FRICTION.md)

    @Test func encodesAcceptPendingRememberAndForgetAllows() throws {
        let plain = try json(EngineCommandEnvelope(command: .send(text: "hi")))
        #expect(Set(plain.keys) == ["type", "text"])   // flag omitted when false (older engines)
        let accept = try json(EngineCommandEnvelope(command: .send(text: "hi", acceptPending: true)))
        #expect(accept["type"] as? String == "send" && accept["acceptPending"] as? Bool == true)

        let remember = try json(EngineCommandEnvelope(command: .permissionResponse(requestId: "r", allow: true, remember: true)))
        #expect(Set(remember.keys) == ["type", "requestId", "allow", "remember"] && remember["remember"] as? Bool == true)
        let once = try json(EngineCommandEnvelope(command: .permissionResponse(requestId: "r", allow: true)))
        #expect(Set(once.keys) == ["type", "requestId", "allow"])

        let forget = try json(EngineCommandEnvelope(command: .forgetAllows))
        #expect(forget["type"] as? String == "forget_allows" && forget.count == 1)

        let settings = try json(EngineCommandEnvelope(command: .setSettings(
            EngineSettings(autoAllowReadOnlyBash: false, bashAllowPatterns: ["Bash(npm test:*)", "Bash(git *)"]))))
        let s = try #require(settings["settings"] as? [String: Any])
        #expect(Set(s.keys) == ["autoAllowReadOnlyBash", "bashAllowPatterns"])
        #expect(s["autoAllowReadOnlyBash"] as? Bool == false && s["bashAllowPatterns"] as? [String] == ["Bash(npm test:*)", "Bash(git *)"])

        let d = UserDefaults(suiteName: "EngineProtocolTests.m16.\(UUID().uuidString)")!
        let defaults = AppSettings.engineSettings(defaults: d)
        #expect(defaults.budget == .off)   // §54
        #expect(defaults.autoAllowReadOnlyBash == true && defaults.bashAllowPatterns == [])
        d.set(false, forKey: AppSettings.Key.autoAllowReadOnlyBash)
        d.set("Bash(npm test:*)\n# comment\n\n  Bash(git *)  \n", forKey: AppSettings.Key.bashAllowPatterns)
        let custom = AppSettings.engineSettings(defaults: d)
        #expect(custom.autoAllowReadOnlyBash == false && custom.bashAllowPatterns == ["Bash(npm test:*)", "Bash(git *)"])
    }

    @Test func decodesRememberedAllowsAndReviewSummaryTolerantly() throws {
        // The M16 golden carries both fields.
        let golden = try NDJSON.decode(ReviewState.self, from: fixture("state.reviewing.json"))
        #expect(golden.session.rememberedAllows.isEmpty)
        #expect(golden.gate.reviewSummary == ReviewSummary(files: 2, added: 3, deleted: 1))

        // Absent on older engines: strip them from the golden.
        let stripped = try fixture("state.reviewing.json")
            .replacingOccurrences(of: "\"rememberedAllows\": [],", with: "")
            .replacing(try Regex(#",\s*"reviewSummary": \{[^}]*\}"#), with: "")
        let old = try NDJSON.decode(ReviewState.self, from: stripped)
        #expect(old.session.rememberedAllows.isEmpty && old.gate.reviewSummary == nil)

        let new = try NDJSON.decode(ReviewState.self, from: stripped
            .replacingOccurrences(of: "\"open\": true", with: "\"open\": true, \"rememberedAllows\": [\"Bash:npm test\", \"WebFetch\"]")
            .replacingOccurrences(of: "\"restored\": false", with: "\"restored\": false, \"reviewSummary\": {\"files\": 2, \"added\": 30, \"deleted\": 4}"))
        #expect(new.session.rememberedAllows == ["Bash:npm test", "WebFetch"])
        #expect(new.gate.reviewSummary == ReviewSummary(files: 2, added: 30, deleted: 4))

        // A partial / malformed summary never breaks the snapshot.
        let partial = try NDJSON.decode(ReviewState.self, from: stripped
            .replacingOccurrences(of: "\"restored\": false", with: "\"restored\": false, \"reviewSummary\": {\"files\": 1}"))
        #expect(partial.gate.reviewSummary == ReviewSummary(files: 1, added: 0, deleted: 0))
        let bad = try NDJSON.decode(ReviewState.self, from: stripped
            .replacingOccurrences(of: "\"restored\": false", with: "\"restored\": false, \"reviewSummary\": \"nope\""))
        #expect(bad.gate.reviewSummary == nil)
    }

    // MARK: - Permission modes (M20, docs/PROTOCOL.md §11)

    @Test func encodesPermissionModeCommandsAndSetting() throws {
        let set = try json(EngineCommandEnvelope(id: "m", command: .setPermissionMode(mode: .plan)))
        #expect(set["type"] as? String == "set_permission_mode")
        #expect(Set(set.keys) == ["type", "id", "mode"] && set["mode"] as? String == "plan")

        let approve = try json(EngineCommandEnvelope(command: .planResponse(approve: true, mode: .acceptEdits)))
        #expect(approve["type"] as? String == "plan_response")
        #expect(Set(approve.keys) == ["type", "approve", "mode"])
        #expect(approve["approve"] as? Bool == true && approve["mode"] as? String == "acceptEdits")

        // Keep planning: no mode, the note travels as `message`; both are omitted when absent.
        let reject = try json(EngineCommandEnvelope(command: .planResponse(approve: false, message: "tighten step 2")))
        #expect(Set(reject.keys) == ["type", "approve", "message"])
        #expect(reject["approve"] as? Bool == false && reject["message"] as? String == "tighten step 2")
        #expect(Set(try json(EngineCommandEnvelope(command: .planResponse(approve: true))).keys) == ["type", "approve"])

        // `hello` / `set_settings` carry the mode a NEW session starts in.
        let settings = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(permissionMode: .auto))))
        let s = try #require(settings["settings"] as? [String: Any])
        #expect(Set(s.keys) == ["permissionMode"] && s["permissionMode"] as? String == "auto")

        let d = UserDefaults(suiteName: "EngineProtocolTests.mode.\(UUID().uuidString)")!
        #expect(AppSettings.engineSettings(defaults: d).permissionMode == .default)
        AppSettings.setPermissionMode(.plan, root: "/repo", defaults: d)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .plan)
        #expect(AppSettings.permissionMode(root: "/other", defaults: d) == .plan)   // the last mode used anywhere
        #expect(AppSettings.engineSettings(defaults: d).permissionMode == .plan)
        AppSettings.setPermissionMode(.default, root: "/other", defaults: d)
        #expect(AppSettings.permissionMode(root: "/repo", defaults: d) == .plan)    // per project
    }

    @Test func decodesPermissionModeAndPendingPlanTolerantly() throws {
        // The goldens carry both fields.
        let golden = try NDJSON.decode(ReviewState.self, from: fixture("state.reviewing.json"))
        #expect(golden.session.permissionMode == .default && golden.session.pendingPlan == nil)

        // Older engines send neither.
        let stripped = try fixture("state.reviewing.json")
            .replacingOccurrences(of: "\"permissionMode\": \"default\",", with: "")
            .replacingOccurrences(of: "\"pendingPlan\": null,", with: "")
        #expect(try NDJSON.decode(ReviewState.self, from: stripped).session.permissionMode == .default)

        let planning = try NDJSON.decode(ReviewState.self, from: stripped
            .replacingOccurrences(of: "\"open\": true", with: """
            "open": true, "permissionMode": "plan", \
            "pendingPlan": {"path": "/home/u/.claude/plans/x.md", "plan": "# Plan\\n1. do it", "at": "2026-09-18T00:00:00.000Z"}
            """))
        #expect(planning.session.permissionMode == .plan)
        #expect(planning.session.pendingPlan == PendingPlan(path: "/home/u/.claude/plans/x.md", plan: "# Plan\n1. do it",
                                                            at: "2026-09-18T00:00:00.000Z"))

        // A mode we do not expose (or a plan without a path) never breaks the snapshot.
        let unknown = try NDJSON.decode(ReviewState.self, from: stripped
            .replacingOccurrences(of: "\"open\": true", with: """
            "open": true, "permissionMode": "bypassPermissions", "pendingPlan": {"path": null, "plan": "p"}
            """))
        #expect(unknown.session.permissionMode == .default)
        #expect(unknown.session.pendingPlan == PendingPlan(path: nil, plan: "p", at: ""))
    }

    @Test func decodesPlanEvents() throws {
        let proposed = try NDJSON.decode(EngineEvent.self,
            from: ##"{"type":"plan_proposed","path":"/home/u/.claude/plans/x.md","plan":"# Plan\n- step"}"##)
        #expect(proposed == .planProposed(path: "/home/u/.claude/plans/x.md", plan: "# Plan\n- step"))
        // `path` is null when the plan only came through `ExitPlanMode`.
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"plan_proposed","path":null,"plan":"p"}"#)
                == .planProposed(path: nil, plan: "p"))

        let approved = try NDJSON.decode(EngineEvent.self,
            from: #"{"type":"plan_approved","mode":"acceptEdits","path":"/p/x.md"}"#)
        #expect(approved == .planApproved(mode: .acceptEdits, path: "/p/x.md"))
        #expect(try NDJSON.decode(EngineEvent.self, from: #"{"type":"plan_approved","mode":"nope","path":null}"#)
                == .planApproved(mode: .default, path: nil))
    }
}
