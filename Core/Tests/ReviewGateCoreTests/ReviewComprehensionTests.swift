import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §14–17 on the Swift side: wire decoding (golden fixtures + the event shapes of
/// engine/src/protocol.ts), command encoding, the AppState mirror and the view logic behind the new UI.
@Suite @MainActor struct ReviewComprehensionTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ReviewComprehensionTests.\(UUID().uuidString)")!)
    }

    private func reviewing(seq: Int, files: [ChangedFile], tree: String = "B1", phase: GatePhase = .reviewing,
                           extensions: SessionExtensions? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil,
                                canRestart: true, extensions: extensions)
        s.gate = GateInfo(phase: phase, canSend: true, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0, isRequestingChanges: false,
                          turnStartTree: "A1", turnEndTree: tree, lastReviewSummary: nil)
        s.changedFiles = files
        return s
    }

    private func file(_ path: String, _ status: ChangeStatus = .modified, state: FileReviewState = .pending, binary: Bool = false) -> ChangedFile {
        ChangedFile(path: path, oldPath: nil, status: status, added: 3, deleted: 1, isBinary: binary, tools: ["Edit"], state: state)
    }

    // MARK: - Decoding (§16 golden fixtures)

    @Test func reviewingFixtureCarriesExtensionsAndPluginDetails() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        let ext = try #require(state.session.extensions)
        #expect(ext.settingSources == ["project", "local"])   // §36.6: settings.local.json loads by default
        #expect(!ext.loadsUserSettings)
        #expect(ext.fallback == nil)
        #expect(ext.plugins == [ExtensionPlugin(name: "p", id: nil, path: "/p", enabled: true)])
        #expect(ext.plugins[0].key == "p")
        #expect(ext.skills == ["graphify"] && ext.slashCommands == ["commit"])
        #expect(ext.mcpServers == [MCPServerStatus(name: "fs", status: "connected")])
        #expect(ext.memoryFiles == nil)
        #expect(ext.claudeMd == ClaudeMdInfo(user: false, project: false, source: "files"))
        #expect(ext.hooks.isEmpty && !ext.userHooksDisabled)
        #expect(state.session.capabilities?.pluginDetails == [PluginDetail(name: "p", path: "/p", id: nil)])
        #expect(state.changedFiles.allSatisfy { !$0.partial && $0.rejectedHunks == 0 })
    }

    @Test func initialFixtureHasNoExtensions() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(state.session.extensions == nil)
    }

    @Test func extensionsDecodeFullyAndLeniently() throws {
        let ext = try NDJSON.decode(SessionExtensions.self, from: #"""
        {"settingSources":["user","project"],"fallback":{"reason":"init_timeout","timeoutMs":20000,"at":"2026-10-19T01:02:03.000Z"},
         "plugins":[{"name":"omc","id":"oh-my-claudecode@omc","path":"/x","version":"1.2.0","enabled":false}],
         "disabledPlugins":["oh-my-claudecode@omc"],"unresolvedDisabledPlugins":["ghost"],"userHooksDisabled":true,
         "skills":["a"],"slashCommands":["b"],"mcpServers":[{"name":"gh","status":"needs-auth"}],
         "memoryFiles":[{"path":"/Users/u/.claude/CLAUDE.md","type":"User","tokens":120}],
         "claudeMd":{"user":true,"project":false,"source":"cli"},
         "hooks":[{"source":"plugin","plugin":"omc","path":"/x/hooks/hooks.json","events":["PreToolUse"],"active":false},
                  {"source":"galaxy","path":"/y","events":[]}]}
        """#)
        #expect(ext.fallback == ExtensionsFallback(reason: "init_timeout", timeoutMs: 20000, at: "2026-10-19T01:02:03.000Z"))
        #expect(ext.fallback?.timeoutSeconds == 20)
        #expect(ext.plugins.first?.key == "oh-my-claudecode@omc" && ext.plugins.first?.enabled == false)
        #expect(ext.memoryFiles?.first?.tokens == 120)
        #expect(ext.claudeMd.user && ext.claudeMd.source == "cli")
        #expect(ext.hooks.map(\.source) == [.plugin, .user])   // an unknown source reads as user
        #expect(ext.hooks.first?.active == false)
        // Missing everything: defaults, no throw.
        let empty = try NDJSON.decode(SessionExtensions.self, from: "{}")
        #expect(empty.plugins.isEmpty && empty.fallback == nil && empty.claudeMd == ClaudeMdInfo())
    }

    // MARK: - Decoding (§15 / §14 / §16 events)

    @Test func decodesTurnSummary() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"turn_summary","turn":3,
         "files":[{"path":"src/gate.ts","status":"M","state":"pending","adds":12,"dels":4,"why":"Guard the empty case\nso it never throws","whyToolUseId":"t1","tools":["Edit"],"toolUseIds":["t1"]},
                  {"path":"docs/x.md","status":"A","state":"partial","adds":3,"dels":0,"why":null,"whyToolUseId":null,"tools":["Bash"],"toolUseIds":["b9"],"origin":"bash"}],
         "commands":[{"toolUseId":"b1","command":"npm test","isError":false,"testOutcome":"pass"},
                     {"toolUseId":"b2","command":"npm run lint\n--fix","isError":true,"parentToolUseId":"ag"},
                     {"toolUseId":"b3","command":"swift test","isError":true,"testOutcome":"fail"}],
         "plan":{"path":"/repo/.claude/plans/p.md","steps":[{"index":1,"text":"Fix gate.ts","files":["src/gate.ts"]},{"index":2,"text":"Docs","done":true,"files":[]}],"unplannedFiles":["docs/x.md"]}}
        """#)
        guard case let .turnSummary(summary) = event else { Issue.record("not a turn summary: \(event)"); return }
        #expect(summary.turn == 3)
        #expect(summary.files.map(\.path) == ["src/gate.ts", "docs/x.md"])
        #expect(summary.files[1].state == .pending)   // unknown state value → pending
        #expect(summary.files[0].whyLine() == "Guard the empty case")
        #expect(summary.files[1].whyLine() == nil)
        #expect(summary.commands.map(\.testOutcome) == [.pass, nil, .fail])
        #expect(summary.commands[1].firstLine == "npm run lint" && summary.commands[1].parentToolUseId == "ag")
        #expect(summary.testsPassed == 1 && summary.testsFailed == 1 && summary.failedCommands == 1)
        #expect(summary.totalAdds == 15 && summary.totalDels == 4)
        let plan = try #require(summary.plan)
        #expect(plan.fileName == "p.md")
        #expect(plan.steps.map(\.done) == [nil, true])
        #expect(plan.matchedStepCount == 1)
        #expect(plan.isUnplanned("docs/x.md") && !plan.isUnplanned("src/gate.ts"))
        #expect(summary.files[1].risks.contains(.viaBash))   // §31: from its origin (wave2 mac-diff: and Bash as its only cause)
        #expect(!summary.files[0].risks.contains(.viaBash))

        // No plan approved in the session: `plan: null`.
        let bare = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_summary","turn":1,"files":[],"commands":[],"plan":null}"#)
        #expect(bare == .turnSummary(TurnSummary(turn: 1)))
    }

    @Test func decodesReviewHistoryReplies() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"review_history","id":"q1","sessionId":"s1","entries":[
          {"id":"lx1-0a1b2c3d","sessionId":"s1","turns":[2,3],"startedAt":"2026-10-19T01:00:00.000Z","endedAt":"2026-10-19T01:05:00.000Z",
           "prompt":"Add the parser","turnStartTree":"A","turnEndTree":"B",
           "files":[{"path":"a.ts","oldPath":null,"status":"M","verdict":"accepted","adds":4,"dels":1,"toolUseIds":["t1"],"committed":true},
                    {"path":"b.ts","oldPath":null,"status":"M","verdict":"rejected","adds":2,"dels":0,"toolUseIds":[],"endTree":"B0"},
                    {"path":"c.ts","oldPath":null,"status":"Z","verdict":"changes_requested","adds":1,"dels":1,"toolUseIds":[],"changesRequested":2,"rejectedHunks":1},
                    {"path":"d.ts","oldPath":null,"status":"A","verdict":"superseded","adds":1,"dels":0,"toolUseIds":[]}],
           "notes":[{"path":"c.ts","line":7,"side":"new","body":"rename this"},{"path":"c.ts","line":null,"side":"new","body":"overall"}]}]}
        """#)
        #expect(event.replyId == "q1")
        guard case let .reviewHistory(_, sessionId, entries, _) = event else { Issue.record("not review_history"); return }
        #expect(sessionId == "s1")
        let entry = try #require(entries.first)
        #expect(entry.turns == [2, 3] && entry.prompt == "Add the parser")
        #expect(entry.files.map(\.verdict) == [.accepted, .rejected, .changesRequested, .pending])
        #expect(entry.files[0].committed && entry.files[1].endTree == "B0")
        #expect(entry.files[2].status == .other && entry.files[2].changesRequested == 2 && entry.files[2].rejectedHunks == 1)
        #expect(entry.verdictCounts.map(\.verdict) == [.accepted, .rejected, .changesRequested, .pending])
        #expect(entry.verdictCounts.allSatisfy { $0.count == 1 })
        #expect(entry.notes(for: "c.ts").map(\.body) == ["overall", "rename this"])
        #expect(entry.totalAdds == 8 && entry.totalDels == 2 && entry.rejectedHunks == 1)
        #expect(entry.startedDate != nil && entry.endedDate != nil)

        let all = try NDJSON.decode(EngineEvent.self, from: #"{"type":"review_history","id":"q2","sessionId":null,"entries":[]}"#)
        #expect(all == .reviewHistory(id: "q2", sessionId: nil, entries: []))

        let diff = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"history_diff","id":"q3","entryId":"lx1-0a1b2c3d","path":"a.ts","truncated":false,
         "diff":{"oldPath":"a.ts","newPath":"a.ts","isBinary":false,"hunks":[{"id":0,"header":"@@ -1 +1 @@","lines":[{"id":0,"kind":"hunkHeader","oldNo":null,"newNo":null,"text":"@@ -1 +1 @@"},{"id":1,"kind":"del","oldNo":1,"newNo":null,"text":"a"},{"id":2,"kind":"add","oldNo":null,"newNo":1,"text":"b"}]}]}}
        """#)
        #expect(diff.replyId == "q3")
        guard case let .historyDiff(_, entryId, path, fileDiff, truncated, _) = diff else { Issue.record("not history_diff"); return }
        #expect(entryId == "lx1-0a1b2c3d" && path == "a.ts" && !truncated)
        #expect(fileDiff.hunks.count == 1 && fileDiff.allLines.count == 3)
    }

    @Test func decodesExtensionsFallback() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"extensions_fallback","reason":"init_timeout","timeoutMs":20000,"message":"Claude Code did not start within 20 s"}"#)
        #expect(event == .extensionsFallback(reason: "init_timeout", timeoutMs: 20000, message: "Claude Code did not start within 20 s"))
    }

    /// §17: `partial` / `rejectedHunks` are additive; an unknown future `state` or `status` value must not make the
    /// whole snapshot undecodable.
    @Test func changedFilesDecodePartialAndTolerateUnknownValues() throws {
        var raw = try fixture("state.reviewing.json")
        raw = raw.replacingOccurrences(of: "\"state\": \"pending\",", with: "\"state\": \"pending\", \"partial\": true, \"rejectedHunks\": 2,")
        raw = raw.replacingOccurrences(of: "\"state\": \"accepted\"", with: "\"state\": \"superseded\"")
        raw = raw.replacingOccurrences(of: "\"status\": \"A\"", with: "\"status\": \"T\"")
        let state = try NDJSON.decode(ReviewState.self, from: raw)
        #expect(state.changedFiles.count == 2)
        #expect(state.changedFiles[0].partial && state.changedFiles[0].rejectedHunks == 2 && state.changedFiles[0].state == .pending)
        #expect(state.changedFiles[1].state == .pending && state.changedFiles[1].status == .other)
    }

    // MARK: - Encoding

    @Test func encodesNewCommands() throws {
        let hunks = try json(EngineCommandEnvelope(id: "c1", command: .rejectHunks(path: "a.ts", hunks: [0, 2], expectedEndTree: "B1")))
        #expect(hunks["type"] as? String == "reject_hunks")
        #expect(hunks["path"] as? String == "a.ts")
        #expect(hunks["hunks"] as? [Int] == [0, 2])
        #expect(hunks["expectedEndTree"] as? String == "B1")
        let noTree = try json(EngineCommandEnvelope(command: .rejectHunks(path: "a.ts", hunks: [1])))
        #expect(noTree["expectedEndTree"] == nil)

        let current = try json(EngineCommandEnvelope(id: "c2", command: .reviewHistory()))
        #expect(current["type"] as? String == "review_history" && current["all"] == nil && current["sessionId"] == nil)
        let all = try json(EngineCommandEnvelope(command: .reviewHistory(all: true)))
        #expect(all["all"] as? Bool == true)
        let other = try json(EngineCommandEnvelope(command: .reviewHistory(sessionId: "s9")))
        #expect(other["sessionId"] as? String == "s9")

        let diff = try json(EngineCommandEnvelope(id: "c3", command: .historyDiff(entryId: "e1", path: "a.ts")))
        #expect(diff["type"] as? String == "history_diff" && diff["entryId"] as? String == "e1" && diff["path"] as? String == "a.ts")
        #expect(diff["id"] as? String == "c3")

        let settings = try json(EngineCommandEnvelope(command: .setSettings(EngineSettings(extensionsInitTimeoutMs: 0, disabledPlugins: ["a@m"], disableUserHooks: true))))
        let payload = try #require(settings["settings"] as? [String: Any])
        #expect(payload["disabledPlugins"] as? [String] == ["a@m"])
        #expect(payload["disableUserHooks"] as? Bool == true)
        #expect(payload["extensionsInitTimeoutMs"] as? Int == 0)
        #expect(payload["budget"] == nil)
    }

    @Test func capabilitiesCacheKeepsPluginDetails() throws {
        let caps = SessionCapabilities(slashCommands: ["c"], skills: [], plugins: ["p"], mcpServers: [],
                                       pluginDetails: [PluginDetail(name: "p", path: "/p", id: "p@m", version: "1")])
        let data = try JSONEncoder().encode(caps)
        #expect(try JSONDecoder().decode(SessionCapabilities.self, from: data) == caps)
        // An old cache without the field still decodes.
        let old = try JSONDecoder().decode(SessionCapabilities.self, from: Data(#"{"slashCommands":[],"skills":[],"plugins":[],"mcpServers":[]}"#.utf8))
        #expect(old.pluginDetails.isEmpty)
    }

    @Test func extensionSettingsFlowIntoHello() {
        let defaults = UserDefaults(suiteName: "ReviewComprehensionTests.settings.\(UUID().uuidString)")!
        #expect(AppSettings.disabledPlugins(defaults: defaults).isEmpty)
        #expect(!AppSettings.disableUserHooks(defaults: defaults))
        AppSettings.setDisabledPlugins(["a@m", "", "b", "a@m"], defaults: defaults)
        defaults.set(true, forKey: AppSettings.Key.disableUserHooks)
        #expect(AppSettings.disabledPlugins(defaults: defaults) == ["a@m", "b"])
        let hello = AppSettings.engineSettings(defaults: defaults)
        #expect(hello.disabledPlugins == ["a@m", "b"])
        #expect(hello.disableUserHooks == true)
    }

    // MARK: - AppState

    @Test func turnSummaryLandsInTheTranscriptAfterTheTurnEnd() {
        let app = makeState()
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10), files: 1, added: 3, deleted: 1))
        let summary = TurnSummary(turn: 1, files: [.init(path: "a.ts", adds: 3, dels: 1, why: "w")])
        app.handle(.turnSummary(summary))
        guard case .turnEnd = app.transcript.first, case let .turnSummary(_, got)? = app.transcript.last else {
            Issue.record("unexpected transcript \(app.transcript)"); return
        }
        #expect(got == summary)
        // It is an ordinary top-level row of the transcript tree.
        #expect(TranscriptNode.build(app.transcript).count == 2)
    }

    @Test func extensionsFallbackBannerReplacesTheErrorBanner() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [])))
        #expect(app.extensionsFallback == nil)
        let message = "Claude Code did not start within 20 s with your user settings"
        app.handle(.error(message: message, fatal: false, scope: .session))
        #expect(app.errorBanner != nil)
        app.handle(.extensionsFallback(reason: "init_timeout", timeoutMs: 20000, message: message))
        #expect(app.errorBanner == nil)
        #expect(app.extensionsFallback?.timeoutSeconds == 20)
        // A repeat of the same error does not bring the generic banner back.
        app.handle(.error(message: message, fatal: false, scope: .session))
        #expect(app.errorBanner == nil)
        // The snapshot's fallback (with `at`) takes over; dismissing hides it.
        let fallback = ExtensionsFallback(timeoutMs: 20000, at: "2026-10-19T01:02:03.000Z")
        app.handle(.state(reviewing(seq: 2, files: [], extensions: SessionExtensions(settingSources: ["project"], fallback: fallback))))
        #expect(app.extensionsFallback == fallback)
        #expect(app.extensions?.loadsUserSettings == false)
        app.dismissExtensionsFallback()
        #expect(app.extensionsFallback == nil)
        // A later fallback (a new `at`) shows again.
        let later = ExtensionsFallback(timeoutMs: 20000, at: "2026-10-19T02:00:00.000Z")
        app.handle(.state(reviewing(seq: 3, files: [], extensions: SessionExtensions(settingSources: ["project"], fallback: later))))
        #expect(app.extensionsFallback == later)
    }

    @Test func rejectHunksSendsTheDiffTreeAndWaitsForTheTurn() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let a = file("a.ts")
        app.handle(.state(reviewing(seq: 1, files: [a, file("b.ts", state: .accepted)], phase: .running)))
        #expect(await app.rejectHunks(a, hunks: [1]) == false)
        #expect(sent.isEmpty)
        #expect(app.hunkRefusal?.refusal.code == "session_running")
        app.handle(.state(reviewing(seq: 2, files: [a, file("b.ts", state: .accepted)], tree: "B2")))
        #expect(await app.rejectHunks(a, hunks: [2, 0]))
        #expect(sent == [.rejectHunks(path: "a.ts", hunks: [0, 2], expectedEndTree: "B2")])
        #expect(app.hunkRefusal == nil)
        // Not pending / no hunks: nothing is sent.
        #expect(await app.rejectHunks(file("b.ts", state: .accepted), hunks: [0]) == false)
        #expect(await app.rejectHunks(a, hunks: []) == false)
        #expect(sent.count == 1)
    }

    @Test func rejectingEveryHunkOfAnEditedFileAsksToForce() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.requestSink = { command in
            sent.append(command)
            if case .rejectHunks = command { throw EngineClientError.refused("file_changed_since_review:a.ts", code: "file_changed_since_review", paths: ["a.ts"]) }
        }
        let a = file("a.ts")
        app.handle(.state(reviewing(seq: 1, files: [a], tree: "B1")))
        app.showDiff(FileDiff(oldPath: "a.ts", newPath: "a.ts", isBinary: false, hunks: [DiffHunk(id: 0, header: "@@", lines: []), DiffHunk(id: 1, header: "@@", lines: [])]), truncated: false, endTree: "B1", for: "a.ts")
        // Partial selection keeps the refresh hint.
        #expect(await app.rejectHunks(a, hunks: [1]) == false)
        #expect(app.forceRejectRequest == nil && app.hunkRefusal?.refusal.code == "file_changed_since_review")
        // All hunks: the whole-file force question instead.
        #expect(await app.rejectHunks(a, hunks: [1, 0]) == false)
        #expect(app.forceRejectRequest == ForceRejectRequest(command: .reject(paths: ["a.ts"]), paths: ["a.ts"]))
        #expect(app.hunkRefusal == nil)
        app.confirmForceReject()
        await eventually { sent.last == .reject(paths: ["a.ts"], force: true) }
        #expect(sent.last == .reject(paths: ["a.ts"], force: true))
    }

    @Test func rejectHunksEchoesTheTreeOfTheShownDiffNotTheLatestSnapshot() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let a = file("a.ts")
        app.handle(.state(reviewing(seq: 1, files: [a], tree: "B2")))
        // A reply computed for the previous B arrives after the B2 snapshot: the hunks on screen are B1's.
        app.showDiff(FileDiff(oldPath: "a.ts", newPath: "a.ts", isBinary: false, hunks: []), truncated: false, endTree: "B1", for: "a.ts")
        #expect(app.selectedDiffEndTree == "B1")
        #expect(await app.rejectHunks(a, hunks: [0]))
        #expect(sent == [.rejectHunks(path: "a.ts", hunks: [0], expectedEndTree: "B1")])
    }

    @Test func historyCommandsAndSelection() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        await app.loadReviewHistory()
        #expect(sent.isEmpty)   // no project
        app.handle(.state(reviewing(seq: 1, files: [])))
        await app.loadReviewHistory()
        await app.loadReviewHistory(allSessions: true)
        #expect(app.historyAllSessions)
        await app.openHistoryDiff(entryId: "e1", path: "a.ts")
        #expect(sent == [.reviewHistory(all: false), .reviewHistory(all: true), .historyDiff(entryId: "e1", path: "a.ts")])
        #expect(app.historySelection == HistorySelection(entryId: "e1", path: "a.ts"))
        app.closeHistoryDiff()
        #expect(app.historySelection == nil && app.historyDiff == nil)
    }

    // MARK: - View logic

    @Test func hunkRefusalsAreFriendly() {
        #expect(HunkRefusal.from("stale_diff").remedy == .refresh)
        #expect(HunkRefusal.from("file_changed_since_review:src/a.ts").remedy == .refresh)
        #expect(HunkRefusal.from("binary_file").remedy == .rejectWholeFile)
        #expect(HunkRefusal.from("partial_reject_unsupported:A").remedy == .rejectWholeFile)
        #expect(HunkRefusal.from("partial_reject_unsupported:A").message != HunkRefusal.from("partial_reject_unsupported:D").message)
        #expect(HunkRefusal.from("partial_reject_unsupported:R").message == HunkRefusal.from("partial_reject_unsupported:X").message)
        // §17: symlinks, submodules and mode-only changes have their own words, all pointing at the whole-file reject.
        let kinds = ["symlink", "submodule", "mode"].map { HunkRefusal.from("partial_reject_unsupported:\($0)") }
        #expect(kinds.allSatisfy { $0.remedy == .rejectWholeFile })
        #expect(Set(kinds.map(\.message)).count == 3)
        #expect(!kinds.map(\.message).contains(HunkRefusal.from("partial_reject_unsupported:R").message))
        #expect(HunkRefusal.from("unknown_hunk:7").remedy == .refresh)
        #expect(HunkRefusal.from("session_running").message == AppState.sessionRefusalText("session_running"))
        #expect(HunkRefusal.from("weird_new_code").message == "weird_new_code")
        #expect(file("a.ts").supportsHunkReject)
        #expect(!file("a.ts", .added).supportsHunkReject)
        #expect(!file("a.ts", binary: true).supportsHunkReject)
        #expect(!file("a.ts", state: .accepted).supportsHunkReject)
        #expect(ReviewHistoryText.refusal("history_trees_gone") != "history_trees_gone")
        #expect(ReviewHistoryText.refusal("other") == "other")
    }

    @Test func pluginTogglesAndRestartDetection() {
        let omc = ExtensionPlugin(name: "oh-my-claudecode", id: "oh-my-claudecode@omc")
        let local = ExtensionPlugin(name: "dev", id: nil, path: "/dev")
        #expect(!ExtensionSettingsLogic.isDisabled(omc, in: []))
        #expect(ExtensionSettingsLogic.isDisabled(omc, in: ["oh-my-claudecode"]))   // a bare name counts too
        var disabled = ExtensionSettingsLogic.setting([], plugin: omc, enabled: false)
        #expect(disabled == ["oh-my-claudecode@omc"])
        disabled = ExtensionSettingsLogic.setting(["oh-my-claudecode", "x@y"], plugin: omc, enabled: true)
        #expect(disabled == ["x@y"])
        #expect(ExtensionSettingsLogic.resolved(["oh-my-claudecode", "ghost", "x@y"], plugins: [omc, local]) == ["oh-my-claudecode@omc", "ghost", "x@y"])

        let applied = SessionExtensions(plugins: [ExtensionPlugin(name: "oh-my-claudecode", id: "oh-my-claudecode@omc", enabled: false), local],
                                        disabledPlugins: ["oh-my-claudecode@omc"], unresolvedDisabledPlugins: ["ghost"])
        #expect(!ExtensionSettingsLogic.needsRestart(applied: applied, disabledPlugins: ["oh-my-claudecode", "ghost"], disableUserHooks: false))
        #expect(ExtensionSettingsLogic.needsRestart(applied: applied, disabledPlugins: ["ghost"], disableUserHooks: false))
        #expect(ExtensionSettingsLogic.needsRestart(applied: applied, disabledPlugins: ["oh-my-claudecode@omc", "ghost"], disableUserHooks: true))
        #expect(!ExtensionSettingsLogic.needsRestart(applied: nil, disabledPlugins: ["a"], disableUserHooks: true))

        let hooks = [ExtensionHook(source: .plugin, plugin: "omc", path: "/h"), ExtensionHook(source: .user, path: "/u"),
                     ExtensionHook(source: .plugin, plugin: "z", path: "/z")]
        let groups = ExtensionSettingsLogic.hookGroups(hooks)
        #expect(groups.map(\.source) == [.user, .plugin])
        #expect(groups[1].hooks.count == 2)
        #expect(ExtensionSettingsLogic.health("connected") == .ok)
        #expect(ExtensionSettingsLogic.health("needs-auth") == .problem)
        #expect(ExtensionSettingsLogic.health("pending") == .pending)
    }

    @Test func oneLineWhy() {
        #expect(TurnSummary.oneLine("\n\n  First   line \nsecond") == "First line")
        #expect(TurnSummary.oneLine("   ") == nil)
        #expect(TurnSummary.oneLine(nil) == nil)
        let long = String(repeating: "x", count: 50)
        #expect(TurnSummary.oneLine(long, limit: 10) == String(repeating: "x", count: 9) + "…")
    }
}
