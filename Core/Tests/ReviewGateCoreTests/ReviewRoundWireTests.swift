import Foundation
import Testing
@testable import ReviewGateCore

/// wave2 contract — docs/PROTOCOL.md §34 on the Swift side: the JSON examples of §34 decode, unknown values fall back,
/// malformed ones never fail the snapshot / event, an older engine's JSON leaves every new field empty, and the new
/// commands encode as the engine expects. No client behavior here — only the wire.
@Suite struct ReviewRoundWireTests {
    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // Tests/ReviewGateCoreTests/<file> → repo root
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    private func fixture(_ name: String) throws -> String {
        try String(contentsOf: Self.fixtures.appendingPathComponent(name), encoding: .utf8)
    }

    /// The golden reviewing snapshot as an engine before §34 sent it, with `change` applied to its JSON object.
    private func patchedReviewing(_ change: (inout [String: Any]) -> Void) throws -> ReviewState {
        var object = try #require(JSONSerialization.jsonObject(with: Data(try olderEngine("state.reviewing.json").utf8)) as? [String: Any])
        change(&object)
        let data = try JSONSerialization.data(withJSONObject: object)
        return try NDJSON.decode(ReviewState.self, from: String(decoding: data, as: UTF8.self))
    }

    /// A golden as an engine before §34 sent it: the engine's test suite writes the goldens with every §34 field, so
    /// "older" is that JSON without them (only the §34 keys, by place — `workbenches[].locked.since` is not one).
    private func olderEngine(_ name: String) throws -> String {
        var o = try object(try fixture(name))
        func drop(_ keys: [String], _ dict: [String: Any]) -> [String: Any] {
            var d = dict
            for key in keys { d[key] = nil }
            return d
        }
        if let gate = o["gate"] as? [String: Any] { o["gate"] = drop(["reviewEndTree", "reviewTurns", "lastTurnChanges", "lastRequest"], gate) }
        if let files = o["changedFiles"] as? [[String: Any]] {
            o["changedFiles"] = files.map { drop(["changedThisTurn", "turnAdded", "turnDeleted", "blob", "changedSinceAccepted", "changedSinceRequest",
                                                  "generated", "whitespaceOnly", "sentNoteCount", "why"], $0) }
        }
        if let notes = o["reviewNotes"] as? [[String: Any]] { o["reviewNotes"] = notes.map { drop(["sent", "anchor"], $0) } }
        if let hud = o["hud"] as? [String: Any] { o["hud"] = drop(["turnFiles"], hud) }
        switch o["type"] as? String {
        case "file_diff":
            o = drop(["since", "baseTree", "stale"], o)   // endTree is §17's
            if var diff = o["diff"] as? [String: Any] {
                diff["segmentsLimited"] = nil
                if let hunks = diff["hunks"] as? [[String: Any]] {
                    diff["hunks"] = hunks.map { hunk in
                        var h = hunk
                        if let lines = h["lines"] as? [[String: Any]] { h["lines"] = lines.map { drop(["segments", "wsOnly"], $0) } }
                        return h
                    }
                }
                o["diff"] = diff
            }
        case "full_file_content":
            o = drop(["since", "stale", "endTree"], o)
        default:
            break
        }
        let data = try JSONSerialization.data(withJSONObject: o)
        return String(decoding: data, as: UTF8.self)
    }

    private func object(_ json: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: §34.1–34.5 state

    @Test func stateFieldsOfSection34Decode() throws {
        let state = try patchedReviewing { s in
            var gate = s["gate"] as! [String: Any]
            gate["reviewEndTree"] = "b2"
            gate["reviewTurns"] = [3, 4]
            gate["lastTurnChanges"] = ["turn": 4, "files": 1, "added": 2, "deleted": 1]
            gate["lastRequest"] = ["turn": 4, "at": "2026-10-23T01:00:00Z", "notes": 2] as [String: Any]
            s["gate"] = gate
            var files = s["changedFiles"] as! [[String: Any]]
            files[0].merge(try! object(#"""
            {"changedThisTurn": true, "turnAdded": 2, "turnDeleted": 1, "blob": "9f2c", "changedSinceAccepted": true,
             "changedSinceRequest": true, "generated": "lockfile", "whitespaceOnly": true, "sentNoteCount": 2,
             "why": {"text": "Null check for the tenant", "source": "earlier", "age": 3, "toolUseId": "toolu_1",
                     "agent": {"toolUseId": "toolu_ag", "subagentType": "executor"}, "delegation": "executor에게 맡기겠습니다", "turn": 4}}
            """#)) { _, new in new }
            s["changedFiles"] = files
            let notes: [[String: Any]] = [["id": "note-1", "path": "README.md", "line": 5, "side": "new", "excerpt": "b = 2", "body": "b는 2 그대로",
                                           "sent": ["at": "2026-10-23T01:00:00Z", "turn": 4] as [String: Any], "anchor": "moved"]]
            s["reviewNotes"] = notes
            var hud = s["hud"] as! [String: Any]
            hud["turnFiles"] = 3
            s["hud"] = hud
        }
        #expect(state.gate.reviewEndTree == "b2")
        #expect(state.gate.reviewTurns == [3, 4])
        #expect(state.gate.lastTurnChanges == LastTurnChanges(turn: 4, files: 1, added: 2, deleted: 1))
        #expect(state.gate.lastRequest == ReviewRequestInfo(turn: 4, at: "2026-10-23T01:00:00Z", notes: 2))
        let f = try #require(state.changedFiles.first)
        #expect(f.changedThisTurn && f.turnAdded == 2 && f.turnDeleted == 1)
        #expect(f.blob == "9f2c")
        #expect(f.changedSinceAccepted && f.changedSinceRequest && f.whitespaceOnly)
        #expect(f.generated == .lockfile)
        #expect(f.sentNoteCount == 2)
        #expect(f.why == FileWhy(text: "Null check for the tenant", source: .earlier, age: 3, toolUseId: "toolu_1",
                                 agent: WhyAgent(toolUseId: "toolu_ag", subagentType: "executor"), delegation: "executor에게 맡기겠습니다", turn: 4))
        let note = try #require(state.reviewNotes.first)
        #expect(note.sent == NoteSent(at: "2026-10-23T01:00:00Z", turn: 4))
        #expect(note.anchor == .moved)
        #expect(note.line == 5)
        #expect(state.hud.turnFiles == 3)
        // The second file carried none of it.
        let g = state.changedFiles[1]
        #expect(!g.changedThisTurn && g.blob == nil && g.why == nil && g.generated == nil && g.sentNoteCount == 0)
    }

    @Test func olderEngineStateLeavesSection34Empty() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try olderEngine("state.reviewing.json"))
        #expect(state.gate.reviewEndTree == nil && state.gate.reviewTurns.isEmpty && state.gate.lastTurnChanges == nil && state.gate.lastRequest == nil)
        #expect(state.changedFiles.allSatisfy { !$0.changedThisTurn && $0.blob == nil && !$0.changedSinceAccepted && $0.why == nil })
        #expect(state.reviewNotes.allSatisfy { $0.sent == nil && $0.anchor == nil })
        #expect(state.hud.turnFiles == 0)
    }

    /// The goldens as the engine writes them (one reviewed turn: README.md edited by a subagent's call, new.txt from
    /// outside) carry §34: the held / current B, this turn's numbers, blob, the sourced "why", baseTree / endTree.
    @Test func currentEngineGoldensCarrySection34() throws {
        let state = try NDJSON.decode(ReviewState.self, from: try fixture("state.reviewing.json"))
        #expect(state.gate.reviewEndTree == state.gate.turnEndTree && state.gate.reviewEndTree != nil)
        #expect(state.gate.reviewTurns == [1])
        #expect(state.gate.lastTurnChanges == LastTurnChanges(turn: 1, files: 2, added: 3, deleted: 1))
        #expect(state.gate.lastRequest == nil)
        #expect(state.changedFiles.allSatisfy { $0.changedThisTurn && $0.blob != nil && !$0.changedSinceAccepted && !$0.changedSinceRequest })
        #expect(state.changedFiles.map(\.turnAdded) == [2, 1] && state.changedFiles.map(\.turnDeleted) == [1, 0])
        #expect(state.changedFiles[0].why == FileWhy(text: "Tighten line 2.", source: .sameMessage, toolUseId: "toolu_1",
                                                     agent: WhyAgent(toolUseId: "toolu_ag", subagentType: "Explore"), turn: 1))
        #expect(state.changedFiles[1].why == FileWhy(text: nil, source: .noRecord, turn: 1))
        #expect(state.hud.turnFiles == 0)

        let diff = try NDJSON.decode(EngineEvent.self, from: try fixture("file_diff.json"))
        guard case let .fileDiff(_, _, _, _, _, endTree, info) = diff else { Issue.record("not a file_diff"); return }
        #expect(info.baseTree == state.gate.turnStartTree && info.since == nil && !info.stale && endTree == state.gate.reviewEndTree)
        let full = try NDJSON.decode(EngineEvent.self, from: try fixture("full_file_content.json"))
        guard case let .fullFileContent(_, view) = full else { Issue.record("not full_file_content"); return }
        #expect(view.endTree == state.gate.reviewEndTree && view.since == nil && !view.stale)
    }

    @Test func unknownAndMalformedSection34ValuesNeverFailTheSnapshot() throws {
        let state = try patchedReviewing { s in
            var gate = s["gate"] as! [String: Any]
            gate["reviewEndTree"] = 42
            gate["reviewTurns"] = [3, "x", 5] as [Any]
            gate["lastTurnChanges"] = "soon"
            s["gate"] = gate
            var files = s["changedFiles"] as! [[String: Any]]
            files[0]["generated"] = "protobuf"
            files[0]["blob"] = 7
            files[0]["why"] = ["source": "telepathy", "text": "guess"]
            files[1]["why"] = ["oops": true]
            s["changedFiles"] = files
            let notes: [[String: Any]] = [["id": "note-1", "path": "README.md", "line": 2, "side": "new", "excerpt": "", "body": "x",
                                           "sent": "yesterday", "anchor": "teleported"]]
            s["reviewNotes"] = notes
            var hud = s["hud"] as! [String: Any]
            hud["turnFiles"] = "many"
            s["hud"] = hud
        }
        #expect(state.gate.reviewEndTree == nil)
        #expect(state.gate.reviewTurns == [3, 5])
        #expect(state.gate.lastTurnChanges == nil)
        #expect(state.changedFiles[0].generated == .other("protobuf"))
        #expect(state.changedFiles[0].blob == nil)
        #expect(state.changedFiles[0].why?.source == .other("telepathy"))
        #expect(state.changedFiles[0].why?.text == "guess")
        #expect(state.changedFiles[1].why == FileWhy(text: nil, source: .noRecord))
        #expect(state.reviewNotes[0].sent == nil)
        #expect(state.reviewNotes[0].anchor == .other("teleported"))
        #expect(state.hud.turnFiles == 0)
    }

    // MARK: §34.1–34.2 file_diff / full_file_content

    @Test func fileDiffCarriesRangeStaleAndSegments() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"file_diff","id":"c7","scope":"turn","path":"Svc.java","truncated":false,"endTree":"b2","since":"turn",
         "baseTree":"t4","stale":true,
         "diff":{"oldPath":"Svc.java","newPath":"Svc.java","isBinary":false,"segmentsLimited":true,"hunks":[{"id":0,"header":"@@ -1,1 +1,1 @@","lines":[
           {"id":0,"kind":"hunkHeader","oldNo":null,"newNo":null,"text":"@@ -1,1 +1,1 @@"},
           {"id":1,"kind":"del","oldNo":1,"newNo":null,"text":"int b = 1;","segments":[[8,9]]},
           {"id":2,"kind":"add","oldNo":null,"newNo":1,"text":"int b = 2;","segments":[[8,9]]},
           {"id":3,"kind":"add","oldNo":null,"newNo":2,"text":"  x();","wsOnly":true,"segments":[[3,1],[0],"x"]}]}]}}
        """#)
        guard case let .fileDiff(id, scope, path, diff, truncated, endTree, info) = event else { Issue.record("not a file_diff: \(event)"); return }
        #expect(id == "c7" && scope == .turn && path == "Svc.java" && !truncated && endTree == "b2")
        #expect(info == FileDiffInfo(since: .turn, baseTree: "t4", stale: true))
        #expect(diff.segmentsLimited)
        let lines = diff.allLines
        #expect(lines[1].segments == [DiffSegment(start: 8, end: 9)])
        #expect(lines[2].segments == [DiffSegment(start: 8, end: 9)])
        // A malformed list reads as "the whole line changed"; wsOnly survives.
        #expect(lines[3].segments.isEmpty && lines[3].wsOnly)
        #expect(event.replyId == "c7")
    }

    @Test func fileDiffOfAnOlderEngineAndALiveScope() throws {
        let old = try NDJSON.decode(EngineEvent.self, from: try olderEngine("file_diff.json"))
        guard case let .fileDiff(_, _, _, diff, _, _, info) = old else { Issue.record("not a file_diff"); return }
        #expect(info == FileDiffInfo())
        #expect(!diff.segmentsLimited && diff.allLines.allSatisfy { $0.segments.isEmpty && !$0.wsOnly })

        let live = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_diff","scope":"live","path":"a.ts","truncated":false,"endTree":"l9","baseTree":"t5","diff":{"oldPath":"a.ts","newPath":"a.ts","isBinary":false,"hunks":[]}}"#)
        guard case let .fileDiff(_, scope, _, _, _, endTree, liveInfo) = live else { Issue.record("not a file_diff"); return }
        #expect(scope == .live && endTree == "l9" && liveInfo.baseTree == "t5" && liveInfo.since == nil)

        let future = try NDJSON.decode(EngineEvent.self, from: #"{"type":"file_diff","scope":"hologram","path":"a.ts","truncated":false,"since":"yesterday","diff":{"oldPath":"a.ts","newPath":"a.ts","isBinary":false,"hunks":[]}}"#)
        guard case let .fileDiff(_, futureScope, _, _, _, _, futureInfo) = future else { Issue.record("not a file_diff"); return }
        #expect(futureScope == .turn && futureInfo.since == nil)
    }

    @Test func segmentsAreUTF16OffsetsLikeTheEngines() throws {
        // "한글 a😀b": 한(1) 글(1) space(1) a(1) 😀(2 UTF-16 units) b(1) — JS "한글 a😀b".indexOf("b") === 6.
        let text = "한글 a😀b"
        let emoji = try #require(DiffSegment(start: 4, end: 6).range(in: text))
        #expect(text[emoji] == "😀")
        let b = try #require(DiffSegment(start: 6, end: 7).range(in: text))
        #expect(text[b] == "b")
        let word = try #require(DiffSegment(start: 0, end: 2).range(in: text))
        #expect(text[word] == "한글")
        #expect(DiffSegment(start: 5, end: 9).range(in: text) == nil)
        #expect(DiffSegment(start: 3, end: 2).range(in: text) == nil)
        // Round trip through the wire form.
        let line = DiffLine(id: 1, kind: .add, oldNo: nil, newNo: 1, text: text, segments: [DiffSegment(start: 4, end: 6)], wsOnly: true)
        let encoded = try json(line)
        #expect((encoded["segments"] as? [[Int]]) == [[4, 6]])
        #expect(encoded["wsOnly"] as? Bool == true)
        let plain = try json(DiffLine(id: 2, kind: .context, oldNo: 1, newNo: 1, text: "x"))
        #expect(plain["segments"] == nil && plain["wsOnly"] == nil)
    }

    @Test func fullFileContentCarriesRangeAndStale() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"full_file_content","id":"c8","path":"a.ts","lines":["x"],"changedNewLines":[1],"deletedAfterNewLine":{},"isBinary":false,"isTooLarge":false,"oldText":"","newText":"x","since":"request","stale":true,"endTree":"b2"}"#)
        guard case let .fullFileContent(id, view) = event else { Issue.record("not full_file_content"); return }
        #expect(id == "c8" && view.since == .request && view.stale && view.endTree == "b2")
        let old = try NDJSON.decode(EngineEvent.self, from: try olderEngine("full_file_content.json"))
        guard case let .fullFileContent(_, oldView) = old else { Issue.record("not full_file_content"); return }
        #expect(oldView.since == nil && !oldView.stale && oldView.endTree == nil)
    }

    // MARK: §34.3 / §34.8 / §34.9 turn_end, turn_summary, tool_use

    @Test func turnEndCountsThisTurnAndCarriesReviewTotals() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"costUsd":0.5,"durationMs":1500,"cacheReadTokens":0,"cacheCreationTokens":0,"contextTokens":3},"files":1,"added":2,"deleted":1,"changedOutside":[],"external":0,"review":{"files":5,"added":40,"deleted":7},"merged":true}"#)
        guard case let .turnEnd(_, _, files, added, deleted, _, review) = event else { Issue.record("not a turn_end"); return }
        #expect(files == 1 && added == 2 && deleted == 1)
        #expect(review == TurnEndReview(review: ChangeTotals(files: 5, added: 40, deleted: 7), merged: true))

        let row = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":4,"kind":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"costUsd":0,"durationMs":10},"files":0,"added":0,"deleted":0,"changedOutside":[],"review":{"files":2,"added":3,"deleted":1},"merged":true}"#)
        guard case let .turnEnd(_, _, _, _, _, _, _, rowReview) = row.kind else { Issue.record("not a turn_end row"); return }
        #expect(rowReview.review == ChangeTotals(files: 2, added: 3, deleted: 1) && rowReview.merged)

        let older = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_end","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":2,"costUsd":0,"durationMs":1},"files":2,"added":2,"deleted":2,"changedOutside":[]}"#)
        guard case let .turnEnd(_, _, _, _, _, _, olderReview) = older else { Issue.record("not a turn_end"); return }
        #expect(olderReview == TurnEndReview())
    }

    @Test func turnSummaryCarriesWhyDetailReviewTotalsAndLastTest() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"turn_summary","turn":4,"merged":true,"review":{"files":5,"added":40,"deleted":7},
         "lastTest":{"verdict":"pass","command":"./mvn25.sh -q -o test -pl api","toolUseId":"toolu_t","at":"2026-10-23T01:02:03Z","afterLastEdit":false,"runs":2},
         "files":[{"path":"api/Svc.java","status":"M","state":"pending","adds":2,"dels":1,"why":"Keep b at 2","whyToolUseId":"toolu_e",
                   "tools":["Edit"],"toolUseIds":["toolu_e"],"origin":"tool","reviewAdds":9,"reviewDels":3,
                   "whyDetail":{"text":"Keep b at 2","source":"reported","turn":4}}],
         "commands":[],"plan":null}
        """#)
        guard case let .turnSummary(summary) = event else { Issue.record("not a turn_summary"); return }
        #expect(summary.merged)
        #expect(summary.review == ChangeTotals(files: 5, added: 40, deleted: 7))
        #expect(summary.lastTest == LastTest(verdict: .pass, command: "./mvn25.sh -q -o test -pl api", toolUseId: "toolu_t",
                                             at: "2026-10-23T01:02:03Z", afterLastEdit: false, runs: 2))
        let f = try #require(summary.files.first)
        #expect(f.whyDetail == FileWhy(text: "Keep b at 2", source: .reported, turn: 4))
        #expect(f.reviewAdds == 9 && f.reviewDels == 3)

        let odd = try NDJSON.decode(EngineEvent.self, from: #"{"type":"turn_summary","turn":5,"files":[],"commands":[],"plan":null,"lastTest":{"verdict":"flaky","command":"npm test","afterLastEdit":true},"review":"all"}"#)
        guard case let .turnSummary(oddSummary) = odd else { Issue.record("not a turn_summary"); return }
        #expect(oddSummary.lastTest?.verdict == nil && oddSummary.lastTest?.afterLastEdit == true && oddSummary.lastTest?.runs == 1)
        #expect(oddSummary.review == nil && !oddSummary.merged)
    }

    @Test func toolUseRationaleSourceAndAge() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_use","id":"t9","name":"Edit","input":{},"parentToolUseId":"ag1","rationale":"I'll keep b.","rationaleSource":"earlier","rationaleAge":4}"#)
        #expect(event == .toolUse(id: "t9", name: "Edit", input: .object([:]), file: nil,
                                  info: ToolUseInfo(parentToolUseId: "ag1", rationale: "I'll keep b.", rationaleSource: .earlier, rationaleAge: 4)))
        let row = try NDJSON.decode(TranscriptItem.self, from: #"{"at":"t","turn":1,"kind":"tool_use","id":"t1","name":"Edit","input":{},"rationale":"Fix.","rationaleSource":"same_message","rationaleAge":0}"#)
        #expect(row.kind == .toolUse(id: "t1", name: "Edit", input: .object([:]), file: nil,
                                     info: ToolUseInfo(rationale: "Fix.", rationaleSource: .sameMessage, rationaleAge: 0)))
        let unknown = try NDJSON.decode(EngineEvent.self, from: #"{"type":"tool_use","id":"t2","name":"Edit","input":{},"rationaleSource":"dream","rationaleAge":"x"}"#)
        #expect(unknown == .toolUse(id: "t2", name: "Edit", input: .object([:]), file: nil, info: ToolUseInfo(rationaleSource: .other("dream"))))
    }

    // MARK: §34.4 review_history.current, §34.6 live_changes

    @Test func reviewHistoryCurrentRound() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"review_history","id":"h1","sessionId":"s1","entries":[],
         "current":{"id":"r9","sessionId":"s1","turns":[3,4],"startedAt":"2026-10-23T00:00:00Z","endedAt":"2026-10-23T01:00:00Z",
                    "prompt":"Add tenant check","files":[],"notes":[{"path":"Svc.java","line":3,"side":"new","body":"b는 2 그대로"}],
                    "turnStartTree":"a1","turnEndTree":"b2","inProgress":true}}
        """#)
        guard case let .reviewHistory(id, _, entries, current) = event else { Issue.record("not review_history"); return }
        #expect(id == "h1" && entries.isEmpty)
        let round = try #require(current)
        #expect(round.inProgress && round.turns == [3, 4] && round.notes.count == 1)
        #expect(event.replyId == "h1")
        let older = try NDJSON.decode(EngineEvent.self, from: #"{"type":"review_history","sessionId":null,"entries":[]}"#)
        guard case let .reviewHistory(_, _, _, none) = older else { Issue.record("not review_history"); return }
        #expect(none == nil)
    }

    @Test func liveChangesReply() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"live_changes","id":"l1","running":true,"turn":5,"baseTree":"t5","liveTree":"l9","at":"2026-10-23T01:05:00Z",
         "files":[{"path":"api/Svc.java","oldPath":null,"status":"M","added":12,"deleted":3,"isBinary":false,"inReview":true},
                  {"path":"package-lock.json","oldPath":null,"status":"M","added":300,"deleted":200,"isBinary":false,"inReview":false,"generated":"lockfile"},
                  {"oops":1}],
         "truncated":true}
        """#)
        guard case let .liveChanges(live) = event else { Issue.record("not live_changes: \(event)"); return }
        #expect(event.replyId == "l1")
        #expect(live.running && live.turn == 5 && live.baseTree == "t5" && live.liveTree == "l9" && live.truncated)
        #expect(live.files == [LiveChangedFile(path: "api/Svc.java", status: .modified, added: 12, deleted: 3, inReview: true),
                               LiveChangedFile(path: "package-lock.json", status: .modified, added: 300, deleted: 200, generated: .lockfile)])
        let idle = try NDJSON.decode(EngineEvent.self, from: #"{"type":"live_changes","running":false,"turn":null,"baseTree":null,"liveTree":null,"at":"","files":[]}"#)
        #expect(idle == .liveChanges(LiveChanges(running: false)))
    }

    // MARK: commands and settings

    @Test func section34CommandsEncode() throws {
        let select = try json(EngineCommandEnvelope(id: "c1", command: .selectFile(path: "a.ts", since: .accepted)))
        #expect(select["type"] as? String == "select_file" && select["path"] as? String == "a.ts" && select["since"] as? String == "accepted")
        let plain = try json(EngineCommandEnvelope(command: .selectFile(path: "a.ts")))
        #expect(plain["since"] == nil)
        let full = try json(EngineCommandEnvelope(command: .fullFile(path: "a.ts", since: .turn)))
        #expect(full["type"] as? String == "full_file" && full["since"] as? String == "turn")
        let live = try json(EngineCommandEnvelope(id: "c2", command: .liveChanges))
        #expect(live["type"] as? String == "live_changes" && live.count == 2)
        let liveDiff = try json(EngineCommandEnvelope(command: .liveDiff(path: "b.ts")))
        #expect(liveDiff["type"] as? String == "live_diff" && liveDiff["path"] as? String == "b.ts")
        let hunks = try json(EngineCommandEnvelope(command: .rejectHunks(path: "a.ts", hunks: [1], expectedEndTree: "b2", expectedBaseTree: "a1")))
        #expect(hunks["expectedBaseTree"] as? String == "a1" && hunks["expectedEndTree"] as? String == "b2")
        var settings = EngineSettings()
        settings.testCommandPatterns = ["./mvn25.sh*test*"]
        let set = try json(EngineCommandEnvelope(command: .setSettings(settings)))
        #expect((set["settings"] as? [String: Any])?["testCommandPatterns"] as? [String] == ["./mvn25.sh*test*"])
    }

    @Test func reviewNoteRoundTripsWithSentAndAnchor() throws {
        let note = ReviewNote(id: "n1", path: "a.ts", line: 3, side: .new, excerpt: "b = 2", body: "keep",
                              sent: NoteSent(at: "2026-10-23T01:00:00Z", turn: 4), anchor: .gone)
        let data = try JSONEncoder().encode(note)
        let back = try JSONDecoder().decode(ReviewNote.self, from: data)
        #expect(back == note)
        let encoded = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(encoded["anchor"] as? String == "gone")
    }
}
