import Foundation
import Testing
@testable import ReviewGateCore

/// §21 side questions and §22 MCP servers: wire decoding / encoding, the side-thread store (streaming, anchors, promote),
/// the MCP store and the add-server form.
@Suite @MainActor struct SideQuestionsTests {
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "SideQuestionsTests.\(UUID().uuidString)")! }
    private func makeState() -> AppState { AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults()) }

    private func event(_ json: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: json) }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func thread(_ id: String, status: String = "running", anchor: String = #"{"path":"src/a.ts","line":12}"#,
                        messages: String = #"[{"role":"user","text":"왜?","at":"2026-10-21T01:00:00.000Z"}]"#,
                        updatedAt: String = "2026-10-21T01:00:00.000Z", main: String = "chat-1") -> String {
        #"{"id":"\#(id)","mainSessionId":"\#(main)","anchor":\#(anchor),"createdAt":"2026-10-21T01:00:00.000Z","updatedAt":"\#(updatedAt)","title":"왜?","messages":\#(messages),"status":"\#(status)","error":null,"sessionId":null,"fork":{"mode":"fork_at","fromSessionId":"m","at":"u1"},"costUSD":0.0123}"#
    }

    private func snapshot(seq: Int, chat: String = "chat-1", phase: GatePhase = .idle) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: chat, model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        let canSend = phase == .idle || phase == .reviewing
        s.gate = GateInfo(phase: phase, canSend: canSend, canRequestChanges: false, blockedReason: canSend ? nil : .running,
                          collectError: nil, pendingCount: 0, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: nil, turnEndTree: nil, lastReviewSummary: nil)
        return s
    }

    // MARK: - Wire

    @Test func decodesSideThreadAndToleratesUnknownValues() throws {
        let ev = try event(#"{"type":"side_thread","id":"r1","thread":\#(thread("t1", status: "weird", anchor: #"{"path":"a.ts","side":"middle","hunkId":2}"#))}"#)
        guard case let .sideThread(id, t) = ev else { Issue.record("not side_thread"); return }
        #expect(id == "r1")
        #expect(ev.replyId == "r1")
        #expect(t.id == "t1")
        #expect(t.status == .idle)
        #expect(t.anchor == SideAnchor(path: "a.ts", hunkId: 2))
        #expect(t.fork?.mode == .forkAt)
        #expect(t.costUSD == 0.0123)
        #expect(t.messages.first?.role == .user)
        #expect(t.promotions.isEmpty)
    }

    @Test func decodesThreadListSkippingABadThread() throws {
        let ev = try event(#"{"type":"side_threads","mainSessionId":"chat-1","threads":[\#(thread("t1")),{"title":"no id"},\#(thread("t2"))]}"#)
        guard case let .sideThreads(_, main, threads) = ev else { Issue.record("not side_threads"); return }
        #expect(main == "chat-1")
        #expect(threads.map(\.id) == ["t1", "t2"])
    }

    @Test func decodesStreamingEventsAndErrorsWithThreadAndServer() throws {
        #expect(try event(#"{"type":"side_text_delta","threadId":"t","text":"ab"}"#) == .sideTextDelta(threadId: "t", text: "ab"))
        #expect(try event(#"{"type":"side_tool_use","threadId":"t","id":"u","name":"Read","input":{"file_path":"/a"}}"#)
                == .sideToolUse(threadId: "t", id: "u", name: "Read", input: .object(["file_path": .string("/a")])))
        #expect(try event(#"{"type":"side_tool_result","threadId":"t","toolUseId":"u","isError":true,"preview":"no","denied":true}"#)
                == .sideToolResult(threadId: "t", toolUseId: "u", isError: true, preview: "no", denied: true))
        #expect(try event(#"{"type":"side_turn_end","threadId":"t","costUSD":0.5,"durationMs":900,"stopReason":"end_turn"}"#)
                == .sideTurnEnd(threadId: "t", costUSD: 0.5, durationMs: 900, stopReason: "end_turn"))
        #expect(try event(#"{"type":"side_thread_closed","threadId":"t"}"#) == .sideThreadClosed(threadId: "t"))
        #expect(try event(#"{"type":"side_promote_draft","id":"x","threadId":"t","text":"Do it"}"#).replyId == "x")
        let err = try event(#"{"type":"error","message":"Side question failed: boom","fatal":false,"scope":"session","code":"side_failed","threadId":"t"}"#)
        guard case let .error(_, _, _, detail) = err else { Issue.record("not error"); return }
        #expect(detail.threadId == "t")
        let auth = try event(#"{"type":"error","message":"x","fatal":false,"scope":"session","code":"mcp_auth_required","server":"linear"}"#)
        guard case let .error(_, _, _, d2) = auth else { Issue.record("not error"); return }
        #expect(d2.server == "linear")
    }

    @Test func decodesMcpStatusRedactedAndLenient() throws {
        let ev = try event(#"""
        {"type":"mcp_status","id":"m","restartRequired":true,"servers":[
          {"name":"gh","status":"connected","scope":"user","source":"user","transport":"stdio","toolCount":2,"tools":["a","b"],"error":null,
           "serverInfo":{"name":"github","version":"1.2"},"config":{"command":"npx","args":["-y","x","--token","***"],"envKeys":["GITHUB_TOKEN"]},
           "disabledByUser":false,"sessionAdded":false},
          {"name":"new","status":"sleeping","source":"martian","transport":"pigeon"},
          {"status":"connected"}
        ]}
        """#)
        guard case let .mcpStatus(id, servers, restart) = ev else { Issue.record("not mcp_status"); return }
        #expect(id == "m")
        #expect(restart)
        #expect(servers.map(\.name) == ["gh", "new"])
        #expect(servers[0].serverVersion == "1.2")
        #expect(servers[0].config?.envKeys == ["GITHUB_TOKEN"])
        #expect(servers[0].tools == ["a", "b"])
        #expect(servers[1].status == .unknown)
        #expect(servers[1].source == .unknown)
        #expect(servers[1].transport == .unknown)
        #expect(servers[1].toolCount == nil)
    }

    @Test func hudCarriesSideCostSeparately() throws {
        let data = #"{"contextTokens":1,"sessionCostUSD":0.2,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0,"sideCostUSD":0.07}"#
        let wire = try NDJSON.decode(HUDWire.self, from: data)
        #expect(wire.sideCostUSD == 0.07)
        #expect(HUDState(wire).sideCostUSD == 0.07)
        #expect(HUDState(wire).sessionCostUSD == 0.2)
        let old = try NDJSON.decode(HUDWire.self, from: #"{"contextTokens":1,"sessionCostUSD":0.2,"turnCount":1,"lastTurnMs":0,"activity":{"kind":"idle"},"subagentDepth":0}"#)
        #expect(old.sideCostUSD == 0)
    }

    @Test func encodesSideAndMcpCommands() throws {
        let ask = try json(.sideAsk(anchor: SideAnchor(path: "a.ts", line: 3, side: .new), question: "왜?"))
        #expect(ask["type"] as? String == "side_ask")
        #expect(ask["threadId"] == nil)
        #expect((ask["anchor"] as? [String: Any])?["line"] as? Int == 3)
        #expect((ask["anchor"] as? [String: Any])?["side"] as? String == "new")
        let follow = try json(.sideAsk(threadId: "t", anchor: SideAnchor(), question: "더"))
        #expect(follow["anchor"] == nil)
        #expect(follow["threadId"] as? String == "t")
        let promote = try json(.sidePromote(threadId: "t", target: .note, text: "fix", acceptPending: false))
        #expect(promote["as"] as? String == "note")
        #expect(promote["acceptPending"] == nil)
        #expect(try json(.sidePromote(threadId: "t", target: .message, text: nil, acceptPending: true))["acceptPending"] as? Bool == true)
        #expect(try json(.sideList)["type"] as? String == "side_list")
        #expect(try json(.mcpToggle(name: "gh", enabled: false))["enabled"] as? Bool == false)
        let add = try json(.mcpAdd(name: "gh", scope: .project, config: .stdio(command: "npx", args: ["-y", "x"], env: ["K": "v"])))
        #expect(add["scope"] as? String == "project")
        let config = try #require(add["config"] as? [String: Any])
        #expect(config["type"] as? String == "stdio")
        #expect(config["args"] as? [String] == ["-y", "x"])
        #expect((config["env"] as? [String: String])?["K"] == "v")
        let http = try #require(try json(.mcpAdd(name: "h", scope: .session, config: .remote(sse: false, url: "https://x", headers: [:])))["config"] as? [String: Any])
        #expect(http["type"] as? String == "http")
        #expect(http["headers"] == nil)
        #expect(try json(.mcpRemove(name: "gh", scope: .user))["scope"] as? String == "user")
        #expect(try json(.mcpAuth(name: "gh"))["name"] as? String == "gh")
    }

    // MARK: - Side store

    @Test func askStreamsAnAnswerAndNotifiesWhenItFinishes() async throws {
        let app = makeState()
        var commands: [EngineCommand] = []
        let running = try NDJSON.decode(SideThread.self, from: thread("t1"))
        app.replySink = { command in
            commands.append(command)
            if case .sideList = command { return .sideThreads(id: "l", mainSessionId: "chat-1", threads: []) }
            return .sideThread(id: "r", thread: running)
        }
        var attention: [AttentionEvent] = []
        app.onAttention = { attention.append($0) }
        app.handle(.state(snapshot(seq: 1)))
        try await Task.sleep(for: .milliseconds(20))
        #expect(commands.contains(.sideList))

        app.handle(.sideThread(id: nil, thread: running))   // the engine's own snapshot comes first
        let ok = await app.side.ask("왜?", anchor: SideAnchor(path: "src/a.ts", line: 12))
        #expect(ok)
        #expect(app.side.selectedThreadId == "t1")
        #expect(!app.side.isComposing)
        app.handle(.sideTextDelta(threadId: "t1", text: "검증을 "))
        app.handle(.sideToolUse(threadId: "t1", id: "u1", name: "Read", input: .object([:])))
        app.handle(.sideToolResult(threadId: "t1", toolUseId: "u1", isError: false, preview: "ok", denied: false))
        app.handle(.sideTextDelta(threadId: "t1", text: "앞당겼어요"))
        var shown = app.side.displayMessages(try #require(app.side.thread("t1")))
        #expect(shown.count == 2)
        #expect(shown.last?.streaming == true)
        #expect(shown.last?.message.text == "검증을 앞당겼어요")
        #expect(shown.last?.message.toolCalls.first?.preview == "ok")
        #expect(app.transcript.isEmpty)   // the main conversation is untouched

        app.handle(.sideTurnEnd(threadId: "t1", costUSD: 0.01, durationMs: 800, stopReason: "end_turn"))
        let done = try NDJSON.decode(SideThread.self, from: thread("t1", status: "idle", messages:
            #"[{"role":"user","text":"왜?","at":"x"},{"role":"assistant","text":"검증을 앞당겼어요","at":"y","costUSD":0.01}]"#,
            updatedAt: "2026-10-21T01:01:00.000Z"))
        app.handle(.sideThread(id: nil, thread: done))
        shown = app.side.displayMessages(try #require(app.side.thread("t1")))
        #expect(shown.count == 2)
        #expect(shown.allSatisfy { !$0.streaming })
        #expect(app.side.live["t1"] == nil)
        #expect(attention.map(\.kind) == [.sideAnswer])
        if case let .sideAsk(threadId, anchor, question)? = commands.last {
            #expect(threadId == nil)
            #expect(anchor?.line == 12)
            #expect(question == "왜?")
        } else {
            Issue.record("no side_ask")
        }
    }

    @Test func refusalsStayInTheSidePanelAndFailuresDoNotTouchTheMainChat() async {
        let app = makeState()
        app.replySink = { _ in throw EngineClientError.refused("side_limit", code: "side_limit") }
        #expect(await app.side.ask("q") == false)
        #expect(app.side.errors[""]?.isEmpty == false)
        #expect(await app.side.ask("   ") == false)
        app.handle(.error(message: "Side question failed: boom", fatal: false, scope: .session,
                          detail: EngineErrorDetail(code: "side_failed", threadId: "t9")))
        #expect(app.side.errors["t9"]?.contains("boom") == true)
        #expect(app.transcript.isEmpty)
        #expect(app.errorBanner == nil)
    }

    @Test func anchorCountsPerFileAndHunk() throws {
        let app = makeState()
        app.side.reset(mainSessionId: "chat-1")
        app.side.replace(mainSessionId: "chat-1", threads: [
            try NDJSON.decode(SideThread.self, from: thread("a", anchor: #"{"path":"src/a.ts","line":12}"#)),
            try NDJSON.decode(SideThread.self, from: thread("b", anchor: #"{"path":"src/a.ts","hunkId":1}"#)),
            try NDJSON.decode(SideThread.self, from: thread("c", anchor: #"{"path":"src/a.ts","entryId":"h1"}"#)),
            try NDJSON.decode(SideThread.self, from: thread("d", anchor: #"{"toolUseId":"u"}"#)),
        ])
        #expect(app.side.count(onPath: "src/a.ts") == 2)
        let hunk0 = DiffHunk(id: 0, header: "@@", lines: [
            DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@"),
            DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 12, text: "x"),
        ])
        let hunk1 = DiffHunk(id: 1, header: "@@", lines: [DiffLine(id: 2, kind: .context, oldNo: 40, newNo: 41, text: "y")])
        #expect(app.side.count(onPath: "src/a.ts", hunk: hunk0) == 1)
        #expect(app.side.count(onPath: "src/a.ts", hunk: hunk1) == 1)
        #expect(app.side.count(onPath: "other.ts") == 0)
    }

    @Test func aSnapshotOfAnotherChatIsIgnored() throws {
        let app = makeState()
        app.side.reset(mainSessionId: "chat-1")
        app.side.upsert(try NDJSON.decode(SideThread.self, from: thread("x", main: "chat-2")))
        #expect(app.side.threads.isEmpty)
        app.side.upsert(try NDJSON.decode(SideThread.self, from: thread("y")))
        #expect(app.side.threads.map(\.id) == ["y"])
        app.handle(.sideThreadClosed(threadId: "y"))
        #expect(app.side.threads.isEmpty)
    }

    @Test func promoteWhileTheMainTurnRunsOffersTheQueue() async throws {
        let app = makeState()
        let idle = try NDJSON.decode(SideThread.self, from: thread("t1", status: "idle", messages:
            #"[{"role":"user","text":"왜?","at":"x"},{"role":"assistant","text":"이유","at":"y"}]"#))
        var sent: [EngineCommand] = []
        app.replySink = { _ in throw EngineClientError.stopped }
        app.handle(.state(snapshot(seq: 1, phase: .running)))
        try await Task.sleep(for: .milliseconds(20))
        app.side.upsert(idle)
        app.replySink = { command in
            sent.append(command)
            switch command {
            case .sidePromoteDraft: return .sidePromoteDraft(id: "r", threadId: "t1", text: "src/a.ts:12 — 검증을 유지하세요")
            default: throw EngineClientError.refused("gate_closed:running", code: "gate_closed")
            }
        }
        await app.side.preparePromotion("t1", target: .message)
        let draft = try #require(app.side.draft)
        #expect(draft.text.contains("검증"))
        #expect(draft.anchor?.path == "src/a.ts")
        #expect(await app.side.sendDraft(text: "편집한 지시", acceptPending: true) == false)
        #expect(app.side.draft?.canQueue == true)
        #expect(app.side.draft?.refusal?.isEmpty == false)
        if case let .sidePromote(_, target, text, acceptPending)? = sent.last {
            #expect(target == .message)
            #expect(text == "편집한 지시")
            #expect(acceptPending)
        } else {
            Issue.record("no side_promote")
        }
        // The queue holds it until Claude is free.
        app.commandSink = { sent.append($0) }
        app.side.queueDraft(text: "편집한 지시")
        #expect(app.side.draft == nil)
        #expect(app.side.queuedThreadIds == ["t1"])
        #expect(app.queuedMessages.map(\.text) == ["편집한 지시\n\n(곁질문에서 정리됨)"])
    }

    @Test func noteRefusalIsShownAndSuccessClosesTheSheet() async throws {
        let app = makeState()
        app.side.reset(mainSessionId: "chat-1")
        var refuse = true
        app.replySink = { command in
            if case .sidePromoteDraft = command { return .sidePromoteDraft(id: "r", threadId: "t1", text: "draft") }
            if refuse { throw EngineClientError.refused("not_a_changed_file:src/a.ts", code: "not_a_changed_file") }
            return .result(id: "ok", ok: true, error: nil)
        }
        await app.side.preparePromotion("t1", target: .note)
        #expect(await app.side.sendDraft(text: "note") == false)
        #expect(app.side.draft?.canQueue == false)
        #expect(app.side.draft?.refusal == HunkRefusal.from("not_a_changed_file").message)
        refuse = false
        #expect(await app.side.sendDraft(text: "note"))
        #expect(app.side.draft == nil)
    }

    /// What is typed in the panel outlives ‹, the panel toggle and the agent panel (the views go, the store stays).
    @Test func typedQuestionsOutliveThePanelAndGoOnceAsked() async throws {
        let app = makeState()
        let running = try NDJSON.decode(SideThread.self, from: thread("t1"))
        app.replySink = { command in
            if case .sideList = command { return .sideThreads(id: "l", mainSessionId: "chat-1", threads: []) }
            return .sideThread(id: "r", thread: running)
        }
        app.handle(.state(snapshot(seq: 1)))
        let lock = SideAnchor(path: "src/a.ts", line: 12)
        app.side.compose(anchor: lock)
        app.side.composeDraft = "why this lock?"
        app.side.showList()
        app.side.compose(anchor: lock)
        #expect(app.side.composeDraft == "why this lock?")
        // MARK: r2-skills-side — P3-transcript-28: every anchor keeps its own draft — another "왜?" clears nothing.
        let other = SideAnchor(path: "src/b.ts", line: 3)
        app.side.compose(anchor: other)   // a question about something else starts empty…
        #expect(app.side.composeDraft.isEmpty)
        app.side.compose(anchor: lock)   // …and the first one is still there
        #expect(app.side.composeDraft == "why this lock?")

        app.side.compose(anchor: other)
        app.side.composeDraft = "and this?"
        #expect(await app.side.ask("and this?", anchor: other))
        app.side.compose(anchor: other)
        #expect(app.side.composeDraft.isEmpty)   // asked: gone
        app.side.compose(anchor: lock)
        #expect(app.side.composeDraft == "why this lock?")
        app.side.followUpDrafts["t1"] = "and the timeout?"
        app.side.followUpDrafts["t2"] = "other"
        app.side.remove("t1")
        #expect(app.side.followUpDrafts == ["t2": "other"])
        #expect(app.side.hasUnsentDrafts)
        app.side.reset(mainSessionId: "chat-2")   // another chat: its own drafts, not these
        #expect(app.side.followUpDrafts.isEmpty && app.side.composeDrafts.isEmpty && !app.side.hasUnsentDrafts)
        app.side.reset(mainSessionId: "chat-1")   // back: they were kept for that chat (a restart too: they are in the defaults)
        #expect(app.side.followUpDrafts == ["t2": "other"])
        app.side.compose(anchor: lock)
        #expect(app.side.composeDraft == "why this lock?")
        // Asked with the anchor removed (×): the draft the view opened on goes too.
        #expect(await app.side.ask("why this lock?", anchor: nil))
        app.side.compose(anchor: lock)
        #expect(app.side.composeDraft.isEmpty)
    }

    /// MARK: r2-skills-side — §21 (M18): a skill / slash command asked in a side question goes to the main conversation.
    @Test func aSkillAskedHereIsOfferedToTheMainConversation() async throws {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }   // the main send (no request seam: fire-and-forget)
        app.replySink = { command in
            if case .sideList = command { return .sideThreads(id: "l", mainSessionId: "chat-1", threads: []) }
            if case .sideAsk = command { throw EngineClientError.refused("side_command:acme-verify", code: "side_command") }
            return .result(id: "ok", ok: true, error: nil)
        }
        app.handle(.state(snapshot(seq: 1)))
        app.side.compose(anchor: nil)
        app.side.composeDraft = "/acme-verify --fast"
        #expect(!(await app.side.ask("/acme-verify --fast")))
        #expect(app.side.mainOnly[""] == SideMainOnly(text: "/acme-verify --fast", name: "acme-verify"))
        #expect(app.side.errors[""] == SideQuestionText.mainOnlyNotice("acme-verify"))
        #expect(app.side.sendToMain("") == false)   // idle: sent now
        #expect(sent.contains { if case let .send(text, _, _, _) = $0 { return text == "/acme-verify --fast" }; return false })
        #expect(app.side.mainOnly[""] == nil && app.side.errors[""] == nil && app.side.composeDraft.isEmpty)
        #expect(app.side.sendToMain("") == nil)
        // While Claude works it waits in the queue, and says so.
        app.handle(.state(snapshot(seq: 2, phase: .running)))
        #expect(!(await app.side.ask("/acme-verify")))
        #expect(app.side.sendToMain("") == true)
        #expect(app.queuedMessages.map(\.text) == ["/acme-verify"])

        // An answer whose Skill call the side policy denied: the thread's question goes as typed.
        let denied = #"[{"role":"user","text":"PR 12 리뷰해 줘","at":"2026-10-21T01:00:00.000Z"},{"role":"assistant","text":"메인 대화에서 실행돼요.","at":"2026-10-21T01:00:05.000Z","toolCalls":[{"id":"k1","name":"Skill","input":{"skill":"acme-plugin:release-notes"},"isError":true,"denied":true}]}]"#
        let t = try NDJSON.decode(SideThread.self, from: thread("t9", status: "idle", messages: denied))
        app.side.upsert(t)
        #expect(app.side.mainOnlyRequest("t9") == SideMainOnly(text: "PR 12 리뷰해 줘", name: "acme-plugin:release-notes"))
        let plain = try NDJSON.decode(SideThread.self, from: thread("t8", status: "idle"))
        app.side.upsert(plain)
        #expect(app.side.mainOnlyRequest("t8") == nil)
    }

    @Test func chatSwitchReloadsTheThreads() async throws {
        let app = makeState()
        var lists = 0
        app.replySink = { command in
            if case .sideList = command { lists += 1 }
            return .sideThreads(id: "l", mainSessionId: "chat-2", threads: [])
        }
        app.handle(.state(snapshot(seq: 1, chat: "chat-1")))
        app.handle(.state(snapshot(seq: 2, chat: "chat-1")))
        try await Task.sleep(for: .milliseconds(20))
        #expect(lists == 1)
        app.handle(.state(snapshot(seq: 3, chat: "chat-2")))
        try await Task.sleep(for: .milliseconds(20))
        #expect(lists == 2)
        #expect(app.side.mainSessionId == "chat-2")
    }

    @Test func oneClickQuestionsAndLabels() {
        #expect(SideQuestionText.defaultQuestion(for: SideAnchor(path: "a", line: 3)) != SideQuestionText.defaultQuestion(for: SideAnchor(path: "a")))
        #expect(SideQuestionText.location(SideAnchor(path: "a.ts", line: 3)) == "a.ts:3")
        #expect(SideQuestionText.location(SideAnchor(toolUseId: "u")) == nil)
        #expect(SideQuestionText.chip(SideAnchor(toolUseId: "u"), toolName: "Bash").contains("Bash"))
        let req = PermissionRequest(requestId: "r", toolName: "Bash", input: .object(["command": .string("npm test\nrm -rf x")]))
        #expect(SideQuestionText.permissionQuestion(req).contains("npm test"))
        #expect(!SideQuestionText.permissionQuestion(req).contains("rm -rf"))
        #expect(SideQuestionText.cost(0.001) == "<$0.01")
        #expect(SideQuestionText.cost(0.126) == "$0.13")
        #expect(EngineMessages.refusal(code: "side_busy", error: "side_busy") != "side_busy")
        #expect(EngineMessages.refusal(error: "invalid_mcp_config:env key x") .contains("env key x"))
        #expect(EngineMessages.actions(for: "mcp_auth_required") == [.mcpLogin])
    }

    @Test func anchorPreviewAndPermissionLookup() {
        let lines = (0..<30).map { i in DiffLine(id: i + 1, kind: i == 20 ? .add : .context, oldNo: i == 20 ? nil : i + 1, newNo: i + 1, text: "l\(i)") }
        let diff = FileDiff(oldPath: "a", newPath: "a", isBinary: false, hunks: [
            DiffHunk(id: 0, header: "@@", lines: [DiffLine(id: 0, kind: .hunkHeader, oldNo: nil, newNo: nil, text: "@@")] + lines),
        ])
        let around = SideAnchors.previewLines(SideAnchor(path: "a", line: 21), in: diff, context: 2, limit: 5)
        #expect(around.map(\.newNo) == [19, 20, 21, 22, 23])
        let whole = SideAnchors.previewLines(SideAnchor(path: "a", hunkId: 0), in: diff, limit: 4)
        #expect(whole.count == 4)
        #expect(whole.contains { $0.kind == .add })
        #expect(SideAnchors.previewLines(nil, in: nil).isEmpty)

        let req = PermissionRequest(requestId: "p1", toolName: "Bash", input: .object(["command": .string("npm test")]))
        let rows: [ChatItem] = [
            .toolUse(id: UUID(), toolUseId: "u1", name: "Bash", file: nil, input: .object(["command": .string("npm test")])),
            .toolUse(id: UUID(), toolUseId: "u2", name: "Bash", file: nil, input: .object(["command": .string("ls")])),
            .permission(id: UUID(), request: req, allowed: nil),
            .toolUse(id: UUID(), toolUseId: "u3", name: "Bash", file: nil, input: .object(["command": .string("npm test")])),
        ]
        #expect(SideAnchors.toolUseId(for: req, in: rows) == "u1")
        #expect(SideAnchors.toolUseId(for: PermissionRequest(requestId: "x", toolName: "WebFetch", input: .object([:])), in: rows) == nil)
        let anchor = SideAnchors.toolAnchor(toolUseId: "u", file: "/repo/src/a.ts", root: "/repo", changedPaths: ["src/a.ts"])
        #expect(anchor == SideAnchor(path: "src/a.ts", toolUseId: "u"))
        #expect(SideAnchors.toolAnchor(toolUseId: "u", file: "/elsewhere/b", root: "/repo", changedPaths: ["src/a.ts"]).path == nil)
    }

    // MARK: - MCP

    @Test func mcpStoreAppliesStatusAndAuthBanner() async {
        let app = makeState()
        app.handle(.mcpStatus(id: nil, servers: [McpServerInfo(name: "linear", status: .needsAuth, source: .user)], restartRequired: false))
        #expect(app.mcp.loaded)
        #expect(app.mcp.attentionServers.map(\.name) == ["linear"])
        app.handle(.error(message: "needs auth", fatal: false, scope: .session, detail: EngineErrorDetail(code: "mcp_auth_required", server: "linear")))
        #expect(app.mcp.authRequiredServer == "linear")
        #expect(app.errorBanner?.actions == [.mcpLogin])
        #expect(app.transcript.isEmpty)
        app.handle(.mcpStatus(id: nil, servers: [McpServerInfo(name: "linear", status: .connected, source: .user)], restartRequired: true))
        #expect(app.mcp.authRequiredServer == nil)
        #expect(app.mcp.restartRequired)

        var sent: [EngineCommand] = []
        app.replySink = { command in
            sent.append(command)
            return .mcpStatus(id: "x", servers: [], restartRequired: false)
        }
        await app.mcp.remove(McpServerInfo(name: "p", status: .connected, source: .plugin))
        #expect(sent.isEmpty)   // plugin servers cannot be removed here
        await app.mcp.remove(McpServerInfo(name: "linear", status: .connected, source: .user))
        #expect(sent == [.mcpRemove(name: "linear", scope: .user)])
        #expect(app.mcp.servers.isEmpty)
        app.replySink = { _ in throw EngineClientError.refused("mcp_cli_failed:boom", code: "mcp_cli_failed") }
        let error = await app.mcp.add(name: "x", scope: .project, config: .stdio(command: "x"))
        #expect(error?.contains("boom") == true)
    }

    @Test func addFormValidation() {
        var form = McpAddForm()
        #expect(form.issues().contains(.name))
        #expect(form.issues().contains(.command))
        form.name = "github"
        form.command = "npx"
        form.args = ["-y", " @x/server ", ""]
        form.env = [McpAddForm.Pair(key: "GITHUB_TOKEN", value: "secret"), McpAddForm.Pair(key: "", value: "ignored")]
        #expect(form.isValid())
        #expect(form.issues(existingNames: ["github"]) == [.duplicateName])
        #expect(form.config == .stdio(command: "npx", args: ["-y", "@x/server"], env: ["GITHUB_TOKEN": "secret"]))
        form.env.append(McpAddForm.Pair(key: "1BAD", value: "v"))
        #expect(form.issues() == [.envKey("1BAD")])
        form.env.removeLast()
        form.command = "--evil"
        #expect(form.issues() == [.commandStartsWithDash])
        form.command = "npx"
        form.args.append("a\nb")
        #expect(form.issues() == [.controlCharacters])

        var http = McpAddForm()
        http.name = "remote.api"
        http.transport = .sse
        http.url = "ftp://x"
        #expect(http.issues() == [.url])
        http.url = "https://mcp.example.com/sse"
        http.headers = [McpAddForm.Pair(key: "Authorization", value: "Bearer t"), McpAddForm.Pair(key: "Bad Header", value: "")]
        #expect(http.issues() == [.headerName("Bad Header")])
        http.headers.removeLast()
        #expect(http.config == .remote(sse: true, url: "https://mcp.example.com/sse", headers: ["Authorization": "Bearer t"]))
        #expect(!McpAddForm.isValidName("-x"))
        #expect(!McpAddForm.isValidName(String(repeating: "a", count: 65)))
        #expect(McpAddForm.splitCommandLine(#"npx -y "@x/server name" --flag='a b'"#) == ["npx", "-y", "@x/server name", "--flag=a b"])
        #expect(McpSource.project.removableScope == .project)
        #expect(McpSource.claudeAI.removableScope == nil)
    }
}
