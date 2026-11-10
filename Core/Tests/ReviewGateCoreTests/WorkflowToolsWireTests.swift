import Foundation
import Testing
@testable import ReviewGateCore

/// wave3 mac-flow — docs/PROTOCOL.md §36.11–36.14 on the Swift side: the JSON examples of §36 decode, unknown values fall
/// back, malformed ones never fail a reply / the snapshot, an older engine's JSON leaves every new field empty, and the new
/// commands and settings encode as the engine expects. No client behavior here — only the wire.
@Suite struct WorkflowToolsWireTests {
    private func event(_ json: String) throws -> EngineEvent { try NDJSON.decode(EngineEvent.self, from: json) }

    private func json(_ command: EngineCommand, id: String? = nil) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: id, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func settingsJSON(_ settings: EngineSettings) throws -> [String: Any] {
        try json(.setSettings(settings))["settings"] as? [String: Any] ?? [:]
    }

    private static let fixtures: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/test/fixtures/wire")
    }()

    /// The golden reviewing snapshot with `change` applied to its JSON object.
    private func reviewing(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> ReviewState {
        let raw = try String(contentsOf: Self.fixtures.appendingPathComponent("state.reviewing.json"), encoding: .utf8)
        var object = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        if var gate = object["gate"] as? [String: Any] {   // the goldens may already carry §36 fields: start without them
            gate["prereviews"] = nil
            object["gate"] = gate
        }
        if var branches = object["branches"] as? [String: Any] {
            branches["remotes"] = nil
            object["branches"] = branches
        }
        change(&object)
        let data = try JSONSerialization.data(withJSONObject: object)
        return try NDJSON.decode(ReviewState.self, from: String(decoding: data, as: UTF8.self))
    }

    // MARK: §36.11

    @Test func commitDraftExampleDecodesAsAReply() throws {
        let ev = try event(##"{"type":"commit_draft","id":"c4","message":"PAY-1502: 재고 동기화 - 중복 차감 방지\n\n- 같은 주문의 재고를 두 번 차감하던 조건 수정"}"##)
        guard case let .commitDraft(reply) = ev else { Issue.record("not commit_draft"); return }
        #expect(ev.replyId == "c4")
        #expect(reply.message.hasPrefix("PAY-1502: 재고 동기화"))
        #expect(reply.message.contains("\n\n- 같은 주문의 재고"))
        // A reply without its message still decodes (the request must never wait forever).
        guard case let .commitDraft(empty) = try event(#"{"type":"commit_draft","id":"c5","message":42}"#) else { Issue.record("x"); return }
        #expect(empty.message.isEmpty)
    }

    @Test func commitDraftCommandAndTemplateSettingEncode() throws {
        let all = try json(.commitDraft())
        #expect(all["type"] as? String == "commit_draft")
        #expect(all["paths"] == nil)
        let some = try json(.commitDraft(paths: ["a.java", "b.java"]), id: "c4")
        #expect(some["paths"] as? [String] == ["a.java", "b.java"])
        #expect(some["id"] as? String == "c4")
        var settings = EngineSettings()
        settings.commitTemplate = "PAY-{issue}: "
        #expect(try settingsJSON(settings)["commitTemplate"] as? String == "PAY-{issue}: ")
        settings.commitTemplate = ""
        #expect(try settingsJSON(settings)["commitTemplate"] as? String == "")   // clears it — nil would leave it as it was
        #expect(try settingsJSON(EngineSettings())["commitTemplate"] == nil)
    }

    // MARK: §36.12

    @Test func workbenchProgressExampleDecodesWithItsExit() throws {
        let ev = try event(#"{"type":"workbench_progress","path":"/Users/me/acme-1600","branch":"feature/PAY-1600","step":"setup","logTail":"[INFO] BUILD SUCCESS\n","exitCode":0}"#)
        guard case let .workbenchProgress(p) = ev else { Issue.record("not workbench_progress"); return }
        #expect(ev.replyId == nil)
        #expect(p.path == "/Users/me/acme-1600")
        #expect(p.branch == "feature/PAY-1600")
        #expect(p.step == .setup)
        #expect(p.logTail == "[INFO] BUILD SUCCESS\n")
        #expect(p.exit == .code(0))
        #expect(!p.exit.failed)
        guard case let .workbenchProgress(killed) = try event(#"{"type":"workbench_progress","path":"/p","branch":"b","step":"setup","exitCode":null}"#),
              case let .workbenchProgress(created) = try event(#"{"type":"workbench_progress","path":"/p","branch":"b","step":"create"}"#),
              case let .workbenchProgress(failed) = try event(#"{"type":"workbench_progress","path":"/p","branch":"b","step":"done","exitCode":2}"#)
        else { Issue.record("not workbench_progress"); return }
        #expect(killed.exit == .killed)
        #expect(killed.exit.failed)
        #expect(created.exit == .none)
        #expect(failed.exit.failed)
        #expect(throws: (any Error).self) { try event(#"{"type":"workbench_progress","path":"/p","branch":"b","step":"teleport"}"#) }
        #expect(WorkbenchStep.fetch < WorkbenchStep.setup)
    }

    @Test func workbenchPreviewDecodesLenientlyAsAReply() throws {
        let ev = try event(#"{"type":"workbench_preview","id":"w1","path":"/Users/me/acme-1600","copy":[{"path":"mvnw","bytes":10665},{"bytes":3},{"path":".mvn/wrapper/maven-wrapper.properties","bytes":"x"}],"totalBytes":20000,"truncated":true}"#)
        guard case let .workbenchPreview(p) = ev else { Issue.record("not workbench_preview"); return }
        #expect(ev.replyId == "w1")
        #expect(p.path == "/Users/me/acme-1600")
        #expect(p.copy.map(\.path) == ["mvnw", ".mvn/wrapper/maven-wrapper.properties"])   // the entry without a path is dropped
        #expect(p.copy.last?.bytes == 0)
        #expect(p.totalBytes == 20000)
        #expect(p.count == 2)   // an engine without `count`: the list's length
        #expect(p.truncated)
        guard case let .workbenchPreview(bare) = try event(#"{"type":"workbench_preview","id":"w2"}"#) else { Issue.record("x"); return }
        #expect(bare.path.isEmpty && bare.copy.isEmpty && bare.totalBytes == 0 && !bare.truncated && bare.count == 0)
        // §36.12 (integration): `count` is every file the create copies — the list stops at 500.
        guard case let .workbenchPreview(many) = try event(#"{"type":"workbench_preview","id":"w3","path":"/w","copy":[{"path":"a","bytes":1}],"totalBytes":9000,"count":812,"truncated":true}"#) else { Issue.record("x"); return }
        #expect(many.count == 812 && many.copy.count == 1)
    }

    @Test func workbenchCommandsEncodeTheNewFieldsOnlyWhenSet() throws {
        let plain = try json(.workbenchCreate(branch: "b", from: "main"))
        #expect(plain["type"] as? String == "workbench_create")
        for key in ["fetch", "setup", "location", "fromPr"] { #expect(plain[key] == nil) }
        let full = try json(.workbenchCreate(branch: "feature/PAY-1600", from: "origin/develop",
                                             options: WorkbenchCreateOptions(fetch: true, setup: false, location: .sibling)))
        #expect(full["from"] as? String == "origin/develop")
        #expect(full["fetch"] as? Bool == true)
        #expect(full["setup"] as? Bool == false)
        #expect(full["location"] as? String == "sibling")
        let pr = try json(.workbenchCreate(branch: "feature/x", options: WorkbenchCreateOptions(fromPr: WorkbenchFromPr(number: 512, headRef: "feature/x"))))
        let fromPr = try #require(pr["fromPr"] as? [String: Any])
        #expect(fromPr["number"] as? Int == 512)
        #expect(fromPr["headRef"] as? String == "feature/x")
        let preview = try json(.workbenchPreview(branch: "feature/PAY-1600", from: "origin/develop", location: .managed))
        #expect(preview["type"] as? String == "workbench_preview")
        #expect(preview["branch"] as? String == "feature/PAY-1600")
        #expect(preview["from"] as? String == "origin/develop")
        #expect(preview["location"] as? String == "managed")
        let bare = try json(.workbenchPreview(branch: "b"))
        #expect(bare["from"] == nil && bare["location"] == nil)
    }

    @Test func workbenchSetupSettingEncodesTheWholeObjectAndReadsOldValues() throws {
        var settings = EngineSettings()
        settings.workbenchSetup = WorkbenchSetup(copy: ["mvnw", ".mvn/**"], setupCommand: "./mvnw -q -o compile", location: .sibling)
        let setup = try #require(try settingsJSON(settings)["workbenchSetup"] as? [String: Any])
        #expect(setup["copy"] as? [String] == ["mvnw", ".mvn/**"])
        #expect(setup["useWorktreeInclude"] as? Bool == true)
        #expect(setup["setupCommand"] as? String == "./mvnw -q -o compile")
        #expect(setup["fetchBase"] as? Bool == true)
        #expect(setup["location"] as? String == "sibling")
        let partial = try NDJSON.decode(WorkbenchSetup.self, from: #"{"copy":"nope","location":"moon","fetchBase":false}"#)
        #expect(partial == WorkbenchSetup(fetchBase: false))
        #expect(WorkbenchSetup(setupCommand: "  \n").command == nil)
        #expect(WorkbenchSetup(setupCommand: " make \n").command == "make")
    }

    @Test func remoteBranchesAreReadElementByElementAndAbsentFromOlderEngines() throws {
        let older = try reviewing()
        #expect(older.branches.remotes == nil)
        let newer = try reviewing { o in
            var branches = o["branches"] as! [String: Any]
            branches["remotes"] = [["name": "origin/develop", "isCurrent": false, "upstream": NSNull(), "ahead": 0, "behind": 0, "lastCommitDate": 1_760_000_000, "remote": true],
                                   ["isCurrent": false],
                                   ["name": "origin/main", "remote": true]]
            o["branches"] = branches
        }
        #expect(newer.branches.remotes?.branches.map(\.name) == ["origin/develop", "origin/main"])
        #expect(newer.branches.list == older.branches.list)   // never part of the switcher's list
        let none = try reviewing { o in
            var branches = o["branches"] as! [String: Any]
            branches["remotes"] = []
            o["branches"] = branches
        }
        #expect(none.branches.remotes?.branches.isEmpty == true)   // an engine that knows §36.12, a repository without remotes
        let odd = try reviewing { o in
            var branches = o["branches"] as! [String: Any]
            branches["remotes"] = "origin/develop"
            o["branches"] = branches
        }
        #expect(odd.branches.remotes?.branches.isEmpty == true)   // never fails the snapshot
    }

    // MARK: §36.13

    private static let prereviewExample = #"{"type":"prereview","id":"p1","prereviewId":"pr-3f2a","status":"done","source":"round","scope":"round","effort":"medium","endTree":"9ac0","startedAt":"2026-10-23T03:00:00.000Z","endedAt":"2026-10-23T03:01:40.000Z","costUSD":0.21,"findings":[{"id":"f1","file":"api/src/main/java/com/x/Svc.java","line":42,"summary":"A soft-deleted cart now throws NotFound","shortSummary":"deleted cart throws","failureScenario":"cart soft-deleted → the nightly batch aborts","category":"correctness"}]}"#

    @Test func prereviewExampleDecodes() throws {
        let ev = try event(Self.prereviewExample)
        guard case let .prereview(reply) = ev else { Issue.record("not prereview"); return }
        #expect(ev.replyId == "p1")
        let run = reply.run
        #expect(run.prereviewId == "pr-3f2a")
        #expect(run.status == .done)
        #expect(run.source == .round)
        #expect(run.scope == .round)
        #expect(run.effort == .medium)
        #expect(run.endTree == "9ac0")
        #expect(run.startedAt == "2026-10-23T03:00:00.000Z")
        #expect(run.endedAt == "2026-10-23T03:01:40.000Z")
        #expect(run.costUSD == 0.21)
        let f = try #require(run.findings.first)
        #expect(f.id == "f1")
        #expect(f.file == "api/src/main/java/com/x/Svc.java")
        #expect(f.line == 42)
        #expect(f.shortSummary == "deleted cart throws")
        #expect(f.failureScenario.contains("nightly batch"))
        #expect(f.category == "correctness")
    }

    @Test func prereviewToleratesUnknownValuesAndBadFindings() throws {
        let raw = #"{"type":"prereview","prereviewId":"toolu_1","status":"queued","source":"elsewhere","effort":"max","endTree":null,"startedAt":"2026-10-23T03:00:00Z","findings":[{"id":"f1","file":"a.ts","line":0,"summary":"s"},{"id":"f2"},{"id":"f3","file":"b.ts","line":"7"}]}"#
        guard case let .prereview(reply) = try event(raw) else { Issue.record("not prereview"); return }
        #expect(reply.id == nil)
        #expect(reply.run.status == .running)   // unknown, no end yet
        #expect(reply.run.source == .round)
        #expect(reply.run.effort == nil)
        #expect(reply.run.endTree == nil)
        #expect(reply.run.findings.map(\.id) == ["f1", "f3"])
        #expect(reply.run.findings.first?.line == nil)   // line 0: the whole file
        #expect(reply.run.findings.last?.line == nil)
        guard case let .prereview(ended) = try event(#"{"type":"prereview","prereviewId":"x","status":"later","endedAt":"2026-10-23T03:00:00Z"}"#) else { Issue.record("x"); return }
        #expect(ended.run.status == .done)
        #expect(ended.run.findings.isEmpty)
    }

    @Test func gatePrereviewsDecodeAndAreEmptyFromOlderEngines() throws {
        #expect(try reviewing().gate.prereviews.isEmpty)
        let example = try #require(JSONSerialization.jsonObject(with: Data(Self.prereviewExample.utf8)) as? [String: Any])
        var run = example
        run["type"] = nil
        run["id"] = nil
        let state = try reviewing { o in
            var gate = o["gate"] as! [String: Any]
            gate["prereviews"] = [run, ["status": "done"], ["prereviewId": "toolu_9", "status": "done", "source": "main", "findings": []]]
            o["gate"] = gate
        }
        #expect(state.gate.prereviews.map(\.prereviewId) == ["pr-3f2a", "toolu_9"])   // the run without an id is dropped
        #expect(state.gate.prereviews.last?.source == .main)
        let odd = try reviewing { o in
            var gate = o["gate"] as! [String: Any]
            gate["prereviews"] = ["nope": 1]
            o["gate"] = gate
        }
        #expect(odd.gate.prereviews.isEmpty)
    }

    @Test func prereviewCommandsEncode() throws {
        let start = try json(.prereviewStart(scope: .round, effort: .medium), id: "p1")
        #expect(start["type"] as? String == "prereview_start")
        #expect(start["scope"] as? String == "round")
        #expect(start["effort"] as? String == "medium")
        #expect(start["paths"] == nil)
        #expect(start["id"] as? String == "p1")
        let files = try json(.prereviewStart(scope: .files, paths: ["a.ts"], effort: .high))
        #expect(files["paths"] as? [String] == ["a.ts"])
        let cancel = try json(.prereviewCancel(prereviewId: "pr-3f2a"))
        #expect(cancel["type"] as? String == "prereview_cancel")
        #expect(cancel["prereviewId"] as? String == "pr-3f2a")
        #expect(cancel["id"] == nil)   // `prereviewId`, never the correlation id
        let dismiss = try json(.prereviewDismiss(prereviewId: "pr-3f2a", findingId: "f1"))
        #expect(dismiss["type"] as? String == "prereview_dismiss")
        #expect(dismiss["findingId"] as? String == "f1")
    }

    // MARK: §36.14

    @Test func prAnchorRoundTripsAndGoesOutWithSideAsk() throws {
        let pr = SidePrAnchor(number: 512, path: "batch/src/Job.java", line: 88, side: "RIGHT", hunk: "@@ -80,6 +80,9 @@\n+x\n", commitId: "abc123")
        let anchor = SideAnchor(pr: pr)
        #expect(!anchor.isEmpty)
        #expect(anchor.path == nil)
        let ask = try json(.sideAsk(anchor: anchor, question: "장바구니 정리에 영향 있나?"))
        let sent = try #require((ask["anchor"] as? [String: Any])?["pr"] as? [String: Any])
        #expect(sent["number"] as? Int == 512)
        #expect(sent["path"] as? String == "batch/src/Job.java")
        #expect(sent["line"] as? Int == 88)
        #expect(sent["side"] as? String == "RIGHT")
        #expect(sent["hunk"] as? String == "@@ -80,6 +80,9 @@\n+x\n")
        #expect(sent["commitId"] as? String == "abc123")
        let hunkOnly = try json(.sideAsk(anchor: SideAnchor(pr: SidePrAnchor(number: 1, path: "a", line: nil, side: "LEFT", hunk: "h")), question: "q"))
        let wire = try #require((hunkOnly["anchor"] as? [String: Any])?["pr"] as? [String: Any])
        #expect(wire["line"] is NSNull)   // explicit null: the whole hunk
        #expect(wire["commitId"] == nil)
        // A thread's anchor comes back with it; a malformed pr anchor reads as none.
        let decoded = try NDJSON.decode(SideAnchor.self, from: #"{"pr":{"number":512,"path":"batch/src/Job.java","line":88,"side":"RIGHT","hunk":"h"}}"#)
        #expect(decoded.pr?.number == 512)
        #expect(decoded.pr?.commitId == nil)
        #expect(try NDJSON.decode(SideAnchor.self, from: #"{"path":"a.ts","pr":{"number":"x"}}"#).pr == nil)
        #expect(try NDJSON.decode(SideAnchor.self, from: #"{"path":"a.ts"}"#) == SideAnchor(path: "a.ts"))
    }
}
