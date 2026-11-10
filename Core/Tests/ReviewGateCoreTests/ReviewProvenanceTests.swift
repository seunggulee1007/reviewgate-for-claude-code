import Foundation
import Testing
@testable import ReviewGateCore

/// wave1 mac-review — docs/PROTOCOL.md §31–§32 on the Mac: the wire (goldens, lenient values), the review list's
/// groups and badges, "Reject all" that leaves the changes from outside the app, the stale sheet and "Finish review",
/// and the banners (handoff §6 test points 8–15, 30).
@Suite @MainActor struct ReviewProvenanceTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    /// The golden snapshot with `change` applied to its JSON object.
    private func patchedReviewing(_ change: (inout [String: Any]) -> Void) throws -> ReviewState {
        var object = try #require(JSONSerialization.jsonObject(with: Data(try fixture("state.reviewing.json").utf8)) as? [String: Any])
        change(&object)
        let data = try JSONSerialization.data(withJSONObject: object)
        return try NDJSON.decode(ReviewState.self, from: String(decoding: data, as: UTF8.self))
    }

    private func makeState() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "ReviewProvenanceTests.\(UUID().uuidString)")!)
    }

    private func file(_ path: String, _ state: FileReviewState = .pending, origin: FileOrigin? = .tool, mods: Bool = false,
                      risk: [ModsRisk] = [], uncaptured: Bool = false, ignored: Bool = false, tools: [String] = ["Edit"]) -> ChangedFile {
        var f = ChangedFile(path: path, oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, tools: tools,
                            toolUseIds: tools.isEmpty ? [] : ["toolu_\(path)"], state: state)
        f.origin = origin
        f.group = mods ? .mods : nil
        f.risk = risk
        f.uncaptured = uncaptured
        f.ignored = ignored
        return f
    }

    private func reviewing(seq: Int, files: [ChangedFile], phase: GatePhase = .reviewing, gate: (inout GateInfo) -> Void = { _ in },
                           notes: [ReviewNote] = [], turnCount: Int = 1) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.session = SessionInfo(open: true, starting: false, sessionId: "s", model: nil, capabilities: nil, pendingPermission: nil, canRestart: true)
        s.gate = GateInfo(phase: phase, canSend: phase == .reviewing, canRequestChanges: true, blockedReason: nil, collectError: nil,
                          pendingCount: files.filter { $0.state == .pending }.count, changesRequestedCount: 0, isRequestingChanges: false,
                          // No B: nothing gets selected, so no diff is requested from the absent engine (its failure
                          // would land as an error row at a machine-dependent time).
                          turnStartTree: "A1", turnEndTree: nil, lastReviewSummary: nil)
        s.gate.externalPendingCount = files.filter { $0.state == .pending && $0.origin == .external }.count
        gate(&s.gate)
        s.changedFiles = files
        s.reviewNotes = notes
        s.hud.turnCount = turnCount
        return s
    }

    private func json(_ command: EngineCommand) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: NDJSON.encodeLine(EngineCommandEnvelope(command: command))) as? [String: Any])
    }

    // MARK: - Wire: goldens and lenient values

    @Test func goldensDecodeTheProvenanceFields() throws {
        let reviewing = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        #expect(reviewing.gate.externalPendingCount == 0)
        #expect(reviewing.gate.headMoved == nil && reviewing.gate.stale == nil && reviewing.gate.localSettingsChanged == nil)
        #expect(reviewing.gate.concurrentClaude.isEmpty && reviewing.gate.nestedChanges.isEmpty && reviewing.gate.snapshotSkipped.isEmpty)
        #expect(reviewing.changedFiles.map(\.origin) == [.tool, .external])
        #expect(reviewing.changedFiles.allSatisfy { $0.group == nil && $0.risk.isEmpty && !$0.uncaptured && !$0.ignored })
        // M2: a file without tools is not "via Bash" any more — it is the external one.
        #expect(!FileRisk.risks(for: reviewing.changedFiles[1]).contains(.viaBash))
        #expect(reviewing.changedFiles[1].isExternal)

        let initial = try NDJSON.decode(ReviewState.self, from: try fixture("state.initial.json"))
        #expect(initial.gate.externalPendingCount == 0 && initial.gate.stale == nil && initial.changedFiles.isEmpty)
    }

    @Test func gateSignalsDecodeLenientlyAndOneOddEntryNeverFailsTheSnapshot() throws {
        let state = try patchedReviewing { object in
            var gate = object["gate"] as! [String: Any]
            gate["externalPendingCount"] = 2
            gate["headMoved"] = ["from": ["sha": "1111111aaaa", "branch": "main"], "to": ["sha": "2222222bbbb", "branch": NSNull()]]
            gate["concurrentClaude"] = [
                ["pid": 4242, "sessionId": "abc", "cwd": "/repo", "name": "acme-b4", "kind": "interactive", "entrypoint": "cli",
                 "status": "busy", "startedAt": "2026-10-22T01:00:00Z"],
                ["name": "no pid — dropped"],
                ["pid": 77, "sessionId": NSNull(), "cwd": "/repo/sub", "name": NSNull(), "kind": NSNull(), "entrypoint": "sdk-ts",
                 "status": NSNull(), "startedAt": NSNull()],
            ]
            gate["stale"] = ["reasons": ["head_moved", "old", "brand_new"], "savedAt": "2026-10-01T00:00:00.000Z",
                             "savedHead": ["sha": "aaaaaaa1", "branch": "feat"], "head": ["sha": "bbbbbbb2", "branch": "feat"], "externalFiles": 3]
            gate["localSettingsChanged"] = ["path": ".claude/settings.local.json", "hooks": true, "permissions": true, "env": false, "mcp": false]
            gate["nestedChanges"] = [
                ["path": ".claude/worktrees/x", "kind": "worktree", "branch": "wf-x", "head": ["from": "ccccccc3", "to": "ddddddd4"],
                 "dirtyFiles": NSNull(), "touchedFiles": [".claude/worktrees/x/a.ts"], "via": ["edit", "teleport"]],
                ["path": "vendor/lib", "kind": "fork-of-a-fork", "branch": NSNull(), "head": NSNull(), "dirtyFiles": 4, "touchedFiles": [], "via": ["bash"]],
            ]
            gate["snapshotSkipped"] = [["path": "logs/app.log", "reason": "unreadable"], ["reason": "no path — dropped"]]
            object["gate"] = gate
            var files = object["changedFiles"] as! [[String: Any]]
            files[0]["origin"] = "teleported"   // unknown → nil
            files[0]["group"] = "mods"
            files[0]["risk"] = ["hook", "network", 7]
            files[0]["uncaptured"] = true
            files[1]["ignored"] = true
            files[1]["group"] = "galaxy"        // unknown → nil
            object["changedFiles"] = files
        }
        let gate = state.gate
        #expect(gate.externalPendingCount == 2)
        #expect(gate.headMoved == HeadMove(from: HeadInfo(sha: "1111111aaaa", branch: "main"), to: HeadInfo(sha: "2222222bbbb", branch: nil)))
        #expect(gate.concurrentClaude.map(\.pid) == [4242, 77])
        #expect(gate.concurrentClaude[0].isTerminal && !gate.concurrentClaude[1].isTerminal)
        #expect(gate.stale?.reasons == [.headMoved, .old, .other("brand_new")])
        #expect(gate.stale?.externalFiles == 3)
        #expect(gate.localSettingsChanged == LocalSettingsChange(hooks: true, permissions: true))
        #expect(gate.nestedChanges.map(\.kind) == [.worktree, .other("fork-of-a-fork")])
        #expect(gate.nestedChanges[0].head == NestedHeadMove(from: "ccccccc3", to: "ddddddd4"))
        #expect(gate.nestedChanges[0].dirtyFiles == nil && gate.nestedChanges[1].dirtyFiles == 4)
        #expect(gate.nestedChanges[0].via == ["edit", "teleport"])
        #expect(gate.snapshotSkipped == [SkippedPath(path: "logs/app.log")])
        let mods = state.changedFiles[0]
        #expect(mods.origin == nil && mods.isMods && mods.uncaptured)
        #expect(mods.risk == [.hook, .other("network")])
        #expect(state.changedFiles[1].ignored && state.changedFiles[1].group == nil && state.changedFiles[1].origin == .external)
    }

    @Test func provenanceEventsAndTurnFieldsDecode() throws {
        let moved = try NDJSON.decode(EngineEvent.self, from: #"{"type":"head_moved","turn":3,"from":{"sha":"aaaaaaa1","branch":"main"},"to":{"sha":"bbbbbbb2","branch":"main"}}"#)
        #expect(moved == .headMoved(HeadMovedEvent(turn: 3, move: HeadMove(from: HeadInfo(sha: "aaaaaaa1", branch: "main"), to: HeadInfo(sha: "bbbbbbb2", branch: "main")))))
        let claude = try NDJSON.decode(EngineEvent.self, from: #"{"type":"concurrent_claude","at":"open","sessions":[{"pid":9,"cwd":"/r","entrypoint":"cli"},{"oops":true}]}"#)
        #expect(claude == .concurrentClaude(ConcurrentClaudeEvent(at: "open", sessions: [ConcurrentClaude(pid: 9, cwd: "/r", entrypoint: "cli")])))
        let local = try NDJSON.decode(EngineEvent.self, from: #"{"type":"local_settings_changed","turn":4,"path":".claude/settings.local.json","hooks":false,"permissions":true,"env":true,"mcp":false}"#)
        #expect(local == .localSettingsChanged(LocalSettingsChangedEvent(turn: 4, change: LocalSettingsChange(permissions: true, env: true))))
        let nested = try NDJSON.decode(EngineEvent.self, from: #"{"type":"nested_changes","turn":5,"repos":[{"path":"sub","kind":"submodule","branch":null,"head":null,"dirtyFiles":2,"touchedFiles":["sub/a"],"via":["edit"]}]}"#)
        #expect(nested == .nestedChanges(NestedChangesEvent(turn: 5, repos: [NestedChange(path: "sub", kind: .submodule, dirtyFiles: 2, touchedFiles: ["sub/a"], via: ["edit"])])))

        let end = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"costUsd":0,"durationMs":1},"files":3,"added":4,"deleted":1,"changedOutside":[],"external":2}"#)
        guard case let .turnEnd(_, _, files, _, _, external, _) = end else { Issue.record("not a turn_end"); return }
        #expect(files == 3 && external == 2)
        let older = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"costUsd":0,"durationMs":1},"files":1,"added":1,"deleted":0,"external":"lots"}"#)
        guard case let .turnEnd(_, _, _, _, _, olderExternal, _) = older else { Issue.record("not a turn_end"); return }
        #expect(olderExternal == 0)

        let row = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":2,"kind":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"costUsd":0,"durationMs":1},"files":2,"added":1,"deleted":1,"changedOutside":[],"external":1}"#)
        guard case let .turnEnd(_, _, _, _, _, _, rowExternal, _) = row.kind else { Issue.record("not a turn_end row"); return }
        #expect(rowExternal == 1)

        let summary = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_summary","turn":2,"files":[{"path":"a","status":"M","state":"pending","adds":1,"dels":0,"why":null,"whyToolUseId":null,"tools":[],"toolUseIds":[],"origin":"external"},{"path":"b","status":"M","state":"pending","adds":1,"dels":0,"why":null,"whyToolUseId":null,"tools":["Bash"],"toolUseIds":["t"],"origin":"bash"},{"path":"c","status":"A","state":"pending","adds":1,"dels":0,"why":null,"whyToolUseId":null,"tools":[],"toolUseIds":[],"origin":"wormhole"}],"commands":[],"plan":null}"#)
        guard case let .turnSummary(turnSummary) = summary else { Issue.record("not a turn_summary"); return }
        #expect(turnSummary.files.map(\.origin) == [.external, .bash, nil])
        #expect(turnSummary.externalCount == 1)
        #expect(turnSummary.files[1].risks.contains(.viaBash) && !turnSummary.files[0].risks.contains(.viaBash) && !turnSummary.files[2].risks.contains(.viaBash))

        let history = try NDJSON.decode(EngineEvent.self, from: #"{"type":"review_history","sessionId":"s","entries":[{"id":"h1","sessionId":"s","turns":[1],"startedAt":"t","endedAt":"t","prompt":"p","files":[],"notes":[],"turnStartTree":"a","turnEndTree":"b","finished":true},{"id":"h2","sessionId":"s","turns":[2],"startedAt":"t","endedAt":"t","prompt":"q","files":[],"notes":[],"turnStartTree":"a","turnEndTree":"b"}]}"#)
        guard case let .reviewHistory(_, _, entries, _) = history else { Issue.record("not a review_history"); return }
        #expect(entries.map(\.finished) == [true, false])
    }

    @Test func commandsEncodeOnTheWire() throws {
        #expect(try json(.finishReview).keys.sorted() == ["type"])
        #expect(try json(.finishReview)["type"] as? String == "finish_review")
        #expect(try json(.keepReview)["type"] as? String == "keep_review")
        #expect(try json(.rejectAll()).keys.sorted() == ["type"])
        let all = try json(.rejectAll(includeExternal: true))
        #expect(all["type"] as? String == "reject_all" && all["includeExternal"] as? Bool == true && all["force"] == nil)
        #expect(try json(.rejectAll(force: true, includeExternal: true)).keys.sorted() == ["force", "includeExternal", "type"])
    }

    // MARK: - The review list (M2, §31–32 display)

    @Test func viaBashFollowsTheOriginNotEmptyTools() {
        #expect(FileRisk.isViaBash(file("a", origin: .bash, tools: ["Bash"])))
        #expect(!FileRisk.isViaBash(file("b", origin: .external, tools: [])))   // the IDE / another session / git pull
        #expect(!FileRisk.isViaBash(file("c", origin: nil, tools: [])))         // unknown origin: no claim either way
        #expect(!FileRisk.isViaBash(file("d", origin: .tool, tools: ["Edit"])))
    }

    @Test func sectionsPutModsFirstThenClaudeThenExternal() {
        let files = [file("src/a.ts"), file("ide.java", origin: .external, tools: []), file(".claude/hooks/pre.sh", mods: true, risk: [.hook, .script]),
                     file("gen.ts", origin: .bash, tools: ["Bash"]), file("CLAUDE.md", origin: .external, mods: true, tools: [])]
        let sections = ChangedFileSection.build(files, riskOrder: false)
        #expect(sections.map(\.kind) == [.mods, .claude, .external])
        #expect(sections[0].files.map(\.path) == [".claude/hooks/pre.sh", "CLAUDE.md"])
        #expect(sections[1].files.map(\.path) == ["src/a.ts", "gen.ts"])
        #expect(sections[2].files.map(\.path) == ["ide.java"])
        #expect(sections[1].title == "Claude changes 2" && sections[2].title == "Outside the app 1")
        #expect(ChangedFileSection.build([file("a"), file("b")], riskOrder: true).map(\.kind) == [.claude])
        #expect(ChangedFileSection.build([], riskOrder: true).isEmpty)
        #expect(ModsRisk.hook.label == "Hook — runs automatically from the next prompt")
    }

    @Test func uncapturedFilesHaveNoPartialRevert() {
        #expect(!file("big.bin.json", uncaptured: true).supportsHunkReject)
        #expect(file("a.ts").supportsHunkReject)
        #expect(HunkRefusal.from("partial_reject_unsupported:uncaptured").message == ReviewProvenanceText.uncaptured)
        #expect(HunkRefusal.from("partial_reject_unsupported:uncaptured").remedy == .none)
        #expect(EngineMessages.refusal(code: "not_captured", error: "not_captured:a, b", paths: ["a", "b"])
                == "These files' content was not captured, so they cannot be reverted: a, b")
        #expect(EngineMessages.refusal(error: "not_captured:x.log") == "These files' content was not captured, so they cannot be reverted: x.log")
    }

    @Test func turnEndRowSaysHowManyChangesCameFromOutside() {
        let app = makeState()
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10), files: 3, added: 2, deleted: 1, external: 2))
        app.handle(.turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10), files: 1, added: 1, deleted: 0))
        guard case let .turnEnd(_, first) = app.transcript[0], case let .turnEnd(_, second) = app.transcript[1] else { Issue.record("no turn rows"); return }
        #expect(first.hasSuffix(" · Includes 2 change(s) from outside the app"))
        #expect(!second.contains("outside the app"))
        app.handle(.transcriptRestore(items: [
            TranscriptItem(at: "t", turn: 1, kind: .turnEnd(stopReason: "end_turn", usage: Usage(inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 10),
                                                            files: 2, added: 1, deleted: 0, changedOutside: [], external: 1)),
        ]))
        guard case let .turnEnd(_, restored) = app.transcript[0] else { Issue.record("no restored row"); return }
        #expect(restored.hasSuffix(" · Includes 1 change(s) from outside the app"))
    }

    @Test func dockBadgeLeavesTheExternalFilesOut() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [file("a"), file("b", origin: .external, tools: []), file("c", origin: .external, tools: []), file("d", .accepted)])))
        #expect(app.externalPendingCount == 2)
        #expect(app.dockBadgeCount == 1)
    }

    // MARK: - Reject all / single reject (M3, test points 8–9)

    @Test func rejectAllLeavesExternalFilesAndAsksBeforeIncludingThem() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let files = [file("claude.ts"), file("mine.java", origin: .external, tools: []), file("pulled.md", origin: .external, tools: [])]
        app.handle(.state(reviewing(seq: 1, files: files)))
        let plan = app.rejectAllPlan
        #expect(plan.claude == ["claude.ts"] && plan.external == ["mine.java", "pulled.md"] && plan.externalCount == 2)
        #expect(plan.message == "Reverts 1 change(s) by Claude. The 2 change(s) from outside the app stay as they are.")

        app.rejectAll()
        #expect(sent == [.rejectAll()])   // includeExternal omitted: the engine leaves the external files alone

        app.requestRejectAllIncludingExternal()
        #expect(app.externalRejectRequest == ExternalRejectRequest(command: .rejectAll(includeExternal: true), paths: ["mine.java", "pulled.md"]))
        #expect(app.externalRejectRequest?.message.hasPrefix(ReviewProvenanceText.externalRejectWarning) == true)
        #expect(sent.count == 1)          // nothing goes out before the second confirmation
        app.confirmExternalReject()
        #expect(sent.last == .rejectAll(includeExternal: true))
        #expect(app.externalRejectRequest == nil)
    }

    @Test func rejectingOneExternalFileIsConfirmedFirst() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let external = file("mine.java", origin: .external, tools: [])
        app.handle(.state(reviewing(seq: 1, files: [external, file("claude.ts")])))
        app.reject(external)
        #expect(sent.isEmpty)
        #expect(app.externalRejectRequest == ExternalRejectRequest(command: .reject(paths: ["mine.java"]), paths: ["mine.java"]))
        app.cancelExternalReject()
        #expect(sent.isEmpty && app.externalRejectRequest == nil)
        app.reject(external)
        app.confirmExternalReject()
        #expect(sent == [.reject(paths: ["mine.java"])])
        // A Claude file still goes out right away.
        app.reject(file("claude.ts"))
        #expect(sent.last == .reject(paths: ["claude.ts"]))
    }

    @Test func uncapturedFilesAreNeverSentToARevert() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let stub = file(".claude/big.json", mods: true, uncaptured: true)
        app.handle(.state(reviewing(seq: 1, files: [stub, file("a.ts"), file("ide.txt", origin: .external, tools: [])])))
        #expect(app.rejectAllPlan.uncaptured == [".claude/big.json"] && app.rejectAllPlan.claude == ["a.ts"])
        #expect(app.rejectAllPlan.message.contains("1 file(s) whose content was not captured cannot be reverted"))
        app.rejectAll()
        #expect(sent == [.reject(paths: ["a.ts"])])   // reject_all would be refused whole (not_captured)
        app.reject(stub)
        #expect(sent.count == 1)
        #expect(app.lastError == "These files' content was not captured, so they cannot be reverted: .claude/big.json")

        // Only uncaptured Claude files left: nothing is sent, the reason is shown.
        app.handle(.state(reviewing(seq: 2, files: [stub, file("ide.txt", origin: .external, tools: [])])))
        app.rejectAll()
        #expect(sent.count == 1)
        app.rejectAll(includeExternal: true)
        #expect(sent.last == .reject(paths: ["ide.txt"]))
    }

    @Test func forcedRejectAllKeepsIncludeExternal() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.handle(.state(reviewing(seq: 1, files: [file("a.ts"), file("ide.txt", origin: .external, tools: [])])))
        app.requestSink = { command in
            sent.append(command)
            if case .rejectAll(false, _) = command {
                throw EngineClientError.refused("file_changed_since_review:ide.txt", code: "file_changed_since_review", paths: ["ide.txt"])
            }
        }
        app.rejectAll(includeExternal: true)
        await eventually { app.forceRejectRequest != nil }
        #expect(app.forceRejectRequest?.command == .rejectAll(includeExternal: true))
        app.confirmForceReject()
        await eventually { sent.count == 2 }
        #expect(sent.last == .rejectAll(force: true, includeExternal: true))
    }

    // MARK: - Stale review and Finish review (test points 11–12)

    @Test func staleSheetLinesSayWhyAndWhen() throws {
        let saved = try #require(isoDate("2026-10-19T09:00:00Z"))
        let stale = StaleReview(reasons: [.headMoved, .old], savedAt: "2026-10-19T09:00:00Z",
                                savedHead: HeadInfo(sha: "aaaaaaa111", branch: "feat"), head: HeadInfo(sha: "bbbbbbb222", branch: nil), externalFiles: 48)
        let lines = stale.lines(now: saved.addingTimeInterval(3 * 86_400), locale: Locale(identifier: "en_US"))
        #expect(lines == ["Saved 3 days ago", "HEAD has changed since then: feat@aaaaaaa → bbbbbbb", "More than 12 hours have passed",
                          "48 change(s) from outside the app are mixed in"])
        #expect(StaleReview(reasons: [.other("x")], savedAt: "").lines().isEmpty)
        #expect(ReviewProvenanceText.headLabel(HeadInfo(sha: nil, branch: "main")) == "main (no commits)")
    }

    @Test func finishReviewIsRefusedWhileBusyAndSentOtherwise() async {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        for (seq, phase) in [(1, GatePhase.running), (2, .collecting), (3, .reverting), (4, .collectFailed)] {
            app.handle(.state(reviewing(seq: seq, files: [file("a")], phase: phase)))
            #expect(!app.canFinishReview)
            #expect(await app.finishReview(reportFailure: false) != nil)
        }
        #expect(sent.isEmpty)
        app.handle(.state(reviewing(seq: 5, files: [])))
        #expect(app.finishReviewBlocker == "There is no review to finish")
        let note = ReviewNote(id: "n1", path: "a", line: 1, side: .new, excerpt: "x", body: "why?")
        app.handle(.state(reviewing(seq: 6, files: [], notes: [note])))
        #expect(app.canFinishReview)
        app.handle(.state(reviewing(seq: 7, files: [file("a")])))
        #expect(await app.finishReview() == nil)
        #expect(sent == [.finishReview])
        #expect(FinishReviewRules.confirmation(notes: 2).hasSuffix("2 note(s) will be deleted too."))
        #expect(!FinishReviewRules.confirmation(notes: 0).contains("note"))
    }

    @Test func finishReviewRefusalComesBackInTheUsersWords() async {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [file("a")])))
        app.requestSink = { _ in throw EngineClientError.refused("session_running", code: "session_running") }
        #expect(await app.finishReview(reportFailure: false) == AppState.sessionRefusalText("session_running"))
        #expect(app.transcript.isEmpty)
        #expect(await app.finishReview() == AppState.sessionRefusalText("session_running"))
        #expect(app.lastError == AppState.sessionRefusalText("session_running"))
    }

    @Test func keepReviewDismissesTheStaleFlag() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let stale = StaleReview(reasons: [.old], savedAt: "2026-10-01T00:00:00Z")
        app.handle(.state(reviewing(seq: 1, files: [file("a")], gate: { $0.stale = stale; $0.restored = true })))
        #expect(app.staleReview == stale)
        // A stale review with nothing listed can still be finished (the flag goes).
        #expect(FinishReviewRules.blocker(phase: .reviewing, collectError: nil, files: 0, notes: 0, stale: true) == nil)
        app.keepReview()
        #expect(app.staleReview == nil && sent == [.keepReview])
        // A snapshot that still carries the flag (sent before the engine processed keep_review) does not reopen the sheet.
        app.handle(.state(reviewing(seq: 2, files: [file("a")], gate: { $0.stale = stale; $0.restored = true })))
        #expect(app.staleReview == nil)
        app.keepReview()
        #expect(sent.count == 1)
        // Another stale review (saved at another time) is asked about again.
        app.handle(.state(reviewing(seq: 3, files: [file("a")], gate: { $0.stale = StaleReview(reasons: [.headMoved], savedAt: "2026-10-02T00:00:00Z") })))
        #expect(app.staleReview != nil)
    }

    @Test func restoredBannerStaysWhenSomethingSlippedIn() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [file("a")], gate: { $0.restored = true })))
        #expect(app.restoredBanner?.autoHides == true)
        #expect(app.restoredBanner?.message == "Review restored from a previous session")
        app.handle(.state(reviewing(seq: 2, files: [file("a"), file("b", origin: .external, tools: [])], gate: { $0.restored = true })))
        #expect(app.restoredBanner?.autoHides == false)
        #expect(app.restoredBanner?.message == "Review restored from a previous session · 1 change(s) slipped in since")
        app.handle(.state(reviewing(seq: 3, files: [file("a")], gate: { $0.restored = true; $0.stale = StaleReview(reasons: [.headMoved]) })))
        #expect(app.restoredBanner?.autoHides == false)
        app.dismissRestoredBanner()
        #expect(app.restoredBanner == nil)
    }

    // MARK: - Banners (test points 10, 13–15, 30)

    @Test func otherClaudeSessionsAreShownOncePerProcess() {
        let app = makeState()
        let terminal = ConcurrentClaude(pid: 4242, cwd: "/repo", name: "acme-b4", entrypoint: "cli", startedAt: "s1")
        app.handle(.state(reviewing(seq: 1, files: [], gate: { $0.concurrentClaude = [terminal] })))
        guard let notice = app.reviewNotices.first, case .concurrent(let shown) = notice.kind else { Issue.record("no banner"); return }
        #expect(shown == [terminal] && notice.severity == .caution)
        #expect(notice.message == "Another Claude session is running in this worktree: acme-b4 (terminal) — its edits mix in as changes from outside the app. Move it to a workbench.")
        app.dismissReviewNotice(notice)
        // Every send reports the same process again: no banner.
        app.handle(.concurrentClaude(ConcurrentClaudeEvent(at: "send", sessions: [terminal])))
        app.handle(.state(reviewing(seq: 2, files: [], gate: { $0.concurrentClaude = [terminal] }, turnCount: 2)))
        #expect(app.reviewNotices.isEmpty)
        // A new process (or a reused pid) is news; only it is listed.
        let sdk = ConcurrentClaude(pid: 77, cwd: "/repo", entrypoint: "sdk-ts", startedAt: "s2")
        app.handle(.state(reviewing(seq: 3, files: [], gate: { $0.concurrentClaude = [terminal, sdk] }, turnCount: 3)))
        guard case .concurrent(let fresh)? = app.reviewNotices.first?.kind else { Issue.record("no banner for the new session"); return }
        #expect(fresh == [sdk])
        #expect(app.reviewNotices.first?.message.contains("pid 77 (app / SDK)") == true)
    }

    @Test func headMovedBannerLastsUntilTheNextTurn() {
        let app = makeState()
        let move = HeadMove(from: HeadInfo(sha: "1111111aaaa", branch: "main"), to: HeadInfo(sha: "2222222bbbb", branch: "main"))
        app.handle(.headMoved(HeadMovedEvent(turn: 4, move: move)))   // logged; the banner renders the snapshot
        #expect(app.logs.last == "[info] head_moved turn 4: main@1111111 → main@2222222")
        app.handle(.state(reviewing(seq: 1, files: [], gate: { $0.headMoved = move }, turnCount: 4)))
        let notice = app.reviewNotices.first
        #expect(notice?.severity == .warning)
        #expect(notice?.message == "The branch / commit changed during this turn (main@1111111 → main@2222222). The difference is shown as changes from outside the app.")
        if let notice { app.dismissReviewNotice(notice) }
        #expect(app.reviewNotices.isEmpty)
        // The next turn clears it; a later move (another turn) is shown again.
        app.handle(.state(reviewing(seq: 2, files: [], turnCount: 5)))
        #expect(app.reviewNotices.isEmpty)
        app.handle(.state(reviewing(seq: 3, files: [], gate: { $0.headMoved = move }, turnCount: 6)))
        #expect(app.reviewNotices.count == 1)
    }

    @Test func localSettingsBannerNamesThePartsAndThePermissionsCaveat() {
        let app = makeState()
        app.handle(.state(reviewing(seq: 1, files: [], gate: { $0.localSettingsChanged = LocalSettingsChange(hooks: true, permissions: true, mcp: true) })))
        let notice = app.reviewNotices.first
        #expect(notice?.severity == .critical)
        #expect(notice?.message == ".claude/settings.local.json changed (hooks·permissions·MCP) — it may hold secrets, so its content is not kept and the change cannot be reverted.")
        #expect(notice?.details == [ReviewProvenanceText.localSettingsPermissionsNote])
        #expect(ReviewNotices.build(gate: { var g = app.state.gate; g.localSettingsChanged = LocalSettingsChange(env: true); return g }(),
                                    scope: ReviewNotices.Scope(project: "/repo", turn: "t"), dismissed: []).first?.details == [])
    }

    @Test func nestedChangesBannerSaysWhereAndWhatIsUnknown() {
        let app = makeState()
        let worktree = NestedChange(path: ".claude/worktrees/x", kind: .worktree, branch: "wf-x", head: NestedHeadMove(from: "ccccccc3", to: "ddddddd4"),
                                    dirtyFiles: nil, touchedFiles: [".claude/worktrees/x/a.ts", ".claude/worktrees/x/b.ts"], via: ["edit"])
        let clone = NestedChange(path: "vendor/lib", kind: .repo, dirtyFiles: 4)
        let unknown = NestedChange(path: "sub", kind: .submodule, dirtyFiles: nil)
        app.handle(.state(reviewing(seq: 1, files: [], gate: { $0.nestedChanges = [worktree, clone, unknown] })))
        let notices = app.reviewNotices
        #expect(notices.map(\.severity) == [.critical, .critical, .critical])
        #expect(notices[0].message == "Outside the review — .claude/worktrees/x (worktree · wf-x, 2 file(s)): not reviewed in this window")
        #expect(notices[0].details == ["HEAD ccccccc → ddddddd", "Status check timed out"])
        #expect(notices[1].message == "Outside the review — vendor/lib (nested repository, 4 file(s)): not reviewed in this window")
        #expect(notices[1].details.isEmpty)
        #expect(notices[2].message == "Outside the review — sub (submodule): not reviewed in this window")
        app.dismissReviewNotice(notices[1])
        #expect(app.reviewNotices.map(\.id) == [notices[0].id, notices[2].id])
        #expect(ReviewProvenanceText.nestedKind(.other("x")) == ReviewProvenanceText.nestedKind(.repo))
    }

    @Test func skippedFilesBannerAddsThemToTheIgnorePatterns() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        let skipped = [SkippedPath(path: "logs/app.log"), SkippedPath(path: "logs/b.log")]
        app.handle(.state(reviewing(seq: 1, files: [], gate: { $0.snapshotSkipped = skipped })))
        let notice = app.reviewNotices.first
        #expect(notice?.message == "Left 2 unreadable file(s) out of this review: logs/app.log, logs/b.log")
        // Closed once, the same files skipped again by the next turn do not bring it back.
        if let notice { app.dismissReviewNotice(notice) }
        app.handle(.state(reviewing(seq: 2, files: [], gate: { $0.snapshotSkipped = skipped.reversed() }, turnCount: 2)))
        #expect(app.reviewNotices.isEmpty)
        app.handle(.state(reviewing(seq: 3, files: [], gate: { $0.snapshotSkipped = skipped + [SkippedPath(path: "c.log")] }, turnCount: 3)))
        #expect(app.reviewNotices.count == 1)
        app.addIgnorePatterns(skipped.map(\.path))
        let expected = AppSettings.defaultIgnorePatterns + ["logs/app.log", "logs/b.log"]
        #expect(sent == [.setSettings(EngineSettings(ignorePatterns: expected))])
        app.addIgnorePatterns(["logs/app.log"])   // already listed: nothing to push
        #expect(sent.count == 1)
        #expect(ReviewNotices.ignorePatterns(adding: ["a", "a", " "], to: "x\n", defaults: []) == "x\na")
        #expect(ReviewNotices.ignorePatterns(adding: ["x"], to: "x", defaults: []) == nil)
    }

    @Test func noticesNeedAProjectAndComeInSeverityOrder() {
        let app = makeState()
        #expect(app.reviewNotices.isEmpty)
        app.handle(.state(reviewing(seq: 1, files: [], gate: {
            $0.snapshotSkipped = [SkippedPath(path: "x")]
            $0.concurrentClaude = [ConcurrentClaude(pid: 1)]
            $0.headMoved = HeadMove(from: HeadInfo(sha: "a", branch: "m"), to: HeadInfo(sha: "b", branch: "m"))
            $0.localSettingsChanged = LocalSettingsChange(env: true)
            $0.nestedChanges = [NestedChange(path: "n", dirtyFiles: 1)]
        })))
        let kinds = app.reviewNotices.map { notice -> String in
            switch notice.kind {
            case .nested: "nested"
            case .localSettings: "local"
            case .headMoved: "head"
            case .concurrent: "claude"
            case .skipped: "skipped"
            }
        }
        #expect(kinds == ["nested", "local", "head", "claude", "skipped"])
    }

    /// The confirmed list is what gets reverted: when a newer snapshot (or another project) changed it, nothing is.
    @Test func externalRevertNeedsTheListTheUserSaw() {
        let app = makeState()
        var sent: [EngineCommand] = []
        app.commandSink = { sent.append($0) }
        app.handle(.state(reviewing(seq: 1, files: [file("claude.ts"), file("mine.java", origin: .external, tools: [])])))
        app.requestRejectAllIncludingExternal()
        // Another external change arrives while the alert is open.
        app.handle(.state(reviewing(seq: 2, files: [file("claude.ts"), file("mine.java", origin: .external, tools: []),
                                                     file("pulled.md", origin: .external, tools: [])])))
        app.confirmExternalReject()
        #expect(sent.isEmpty)
        #expect(app.lastError == "The files changed meanwhile, so nothing was reverted — check the list again")
        // One file that is no longer pending (another project, or it was accepted meanwhile): nothing either.
        app.reject(file("mine.java", origin: .external, tools: []))
        app.handle(.state(reviewing(seq: 3, files: [file("claude.ts"), file("mine.java", .accepted, origin: .external, tools: [])])))
        app.confirmExternalReject()
        #expect(sent.isEmpty)
    }

    /// Test point 13: a gitignored hook Claude changed is in the mods group with its badge, and never offered to commit.
    @Test func gitignoredModsFilesAreReviewedButNotCommitted() {
        let app = makeState()
        var s = reviewing(seq: 1, files: [file("a.ts", .accepted), file(".claude/hooks/pre.sh", .accepted, mods: true, risk: [.hook], ignored: true)])
        s.commit = CommitState(canCommit: true, acceptedPaths: ["a.ts", ".claude/hooks/pre.sh"])   // as a lagging snapshot might
        app.handle(.state(s))
        #expect(app.ignoredAcceptedPaths == [".claude/hooks/pre.sh"])
        #expect(app.committablePaths == ["a.ts"])
        let first = app.changedFileSections(riskOrder: true).first
        #expect(first?.kind == .mods && first?.files.map(\.risk) == [[.hook]])
    }
}
