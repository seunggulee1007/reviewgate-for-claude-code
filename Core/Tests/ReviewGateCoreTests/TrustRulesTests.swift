import Foundation
import Testing
@testable import ReviewGateCore

/// wave4c w4c-trust — docs/PROTOCOL.md §41.2: the auto-accept marks, the summary's [모두 대기로 되돌리기] and the reject
/// banner's [거절 취소] as the engine sends them (as in Electron, trust.test.ts).
@Suite @MainActor struct TrustRulesTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try NDJSON.decode(type, from: json)
    }

    @Test func decodesTheMarksLeniently() throws {
        let file = try decode(ChangedFile.self, #"{"path":"a/Svc.java","oldPath":null,"status":"M","added":1,"deleted":1,"isBinary":false,"tools":["Edit"],"toolUseIds":["e"],"state":"accepted","autoAccepted":"whitespace"}"#)
        #expect(file.autoAccepted == "whitespace")
        let older = try decode(ChangedFile.self, #"{"path":"a","status":"M","state":"accepted","autoAccepted":7}"#)
        #expect(older.autoAccepted == nil)
        let gate = try decode(GateInfo.self, #"{"phase":"idle","rejectUndo":{"path":"a/Svc.java","oldPath":null,"status":"M","available":false,"reason":"changed_on_disk"}}"#)
        #expect(gate.rejectUndo == RejectUndoInfo(path: "a/Svc.java", oldPath: nil, status: "M", available: false, reason: "changed_on_disk"))
        let bad = try decode(GateInfo.self, #"{"phase":"idle","rejectUndo":{"path":1}}"#)
        #expect(bad.rejectUndo == nil)
        let summary = try decode(TurnSummary.self, #"{"turn":3,"files":[],"commands":[],"plan":null,"autoAccepted":[{"path":"a/Svc.java","rule":"whitespace"},{"rule":"tests"}]}"#)
        #expect(summary.autoAccepted == [AutoAcceptedFile(path: "a/Svc.java", rule: "whitespace")])
        let history = try decode(ReviewHistoryFile.self, #"{"path":"web/package-lock.json","status":"M","verdict":"accepted","autoAccepted":"lockfile"}"#)
        #expect(history.autoAccepted == "lockfile")
        let rules = try decode(AutoAcceptRules.self, #"{"whitespace":true,"tests":"yes"}"#)
        #expect(rules == AutoAcceptRules(whitespace: true))
        let sent = try JSONEncoder().encode(EngineCommand.setAutoAccept(rules: AutoAcceptRules(lockfile: true)))
        #expect(String(decoding: sent, as: UTF8.self).contains(#""rules":{"lockfile":true}"#))
        #expect(EngineCommand.rejectUndo(path: "a").type == "reject_undo")
        #expect(EngineCommand.autoAcceptUndo(paths: nil).type == "auto_accept_undo")
    }

    @Test func namesAndButtons() {
        #expect(TrustRules.name("whitespace") == "Whitespace only")
        #expect(TrustRules.name("lockfile") == "Lockfile with its manifest")
        #expect(TrustRules.name("tests") == "Test passed after the edit")
        #expect(TrustRules.name("newer") == nil)
        #expect(TrustRules.badgeLabel("tests") == "By rule · Test passed after the edit")
        #expect(TrustRules.summaryLine(count: 2) == "Accepted by a rule: 2 file(s)")

        var s = ReviewState.empty
        s.gate.phase = .reviewing
        var a = ChangedFile(path: "a.java", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, state: .accepted)
        a.autoAccepted = "whitespace"
        let b = ChangedFile(path: "b.java", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, state: .accepted)
        s.changedFiles = [a, b]
        #expect(TrustRules.autoUndo(state: s, paths: ["a.java", "c.lock"]) == .init(paths: ["a.java"], blocked: nil))
        #expect(TrustRules.autoUndo(state: s, paths: ["b.java"]).blocked == "Already back to pending or out of the review")
        s.gate.phase = .running
        #expect(TrustRules.autoUndo(state: s, paths: ["a.java"]).blocked == "Claude is working — wait for the turn to end")

        s.gate.phase = .idle
        #expect(TrustRules.rejectUndo(state: s) == nil)
        s.gate.rejectUndo = RejectUndoInfo(path: "a.java")
        #expect(TrustRules.rejectUndo(state: s) == .init(path: "a.java", blocked: nil))
        s.gate.rejectUndo = RejectUndoInfo(path: "a.java", available: false, reason: "review_changed")
        #expect(TrustRules.rejectUndo(state: s)?.blocked == "The review changed after the reject — it can no longer be put back")
        #expect(TrustRules.rejectedText("a.java") == "Rejected — a.java")
    }

    @Test func appStateSendsTheCommands() {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "TrustRulesTests-\(UUID().uuidString)")!)
        var sent: [EngineCommand] = []
        store.commandSink = { sent.append($0) }
        var s = ReviewState.empty
        s.project = ProjectInfo(path: "/repo", root: "/repo", name: "repo", branch: "main", remoteURL: nil)
        s.gate.phase = .idle
        var a = ChangedFile(path: "a.java", oldPath: nil, status: .modified, added: 1, deleted: 0, isBinary: false, state: .accepted)
        a.autoAccepted = "tests"
        s.changedFiles = [a]
        s.gate.rejectUndo = RejectUndoInfo(path: "b.java")
        s.autoAcceptRules = AutoAcceptRules(whitespace: true)
        store.state = s
        store.setAutoAcceptRule(.tests, on: true)
        store.undoAutoAccept(paths: ["a.java"])
        store.undoLastReject()
        #expect(sent.map(\.type) == ["set_auto_accept", "auto_accept_undo", "reject_undo"])
        if case let .setAutoAccept(rules) = sent.first { #expect(rules == AutoAcceptRules(whitespace: true, tests: true)) }
    }
}
