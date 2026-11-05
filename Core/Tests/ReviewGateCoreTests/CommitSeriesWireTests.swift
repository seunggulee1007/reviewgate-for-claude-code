import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §53 on the Swift side: `commit_hunks`, `commit_split_draft` and `commit_series` on the wire, their
/// replies read leniently, and a `commit_failed` refusal's `partial` reaching the request that sent the series.
@Suite struct CommitSeriesWireTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func theCommandsCarryTheirFieldsOnlyWhenGiven() throws {
        let hunks = try json(.commitHunks(paths: ["src/a.ts"]))
        #expect(hunks["type"] as? String == "commit_hunks")
        #expect(hunks["paths"] as? [String] == ["src/a.ts"])
        #expect(try json(.commitHunks())["paths"] == nil)
        let draft = try json(.commitSplitDraft())
        #expect(draft["type"] as? String == "commit_split_draft")
        #expect(draft["paths"] == nil)
        #expect(try json(.commitSplitDraft(paths: ["b.md"]))["paths"] as? [String] == ["b.md"])
    }

    @Test func aSeriesSendsHunksOnlyForSplitFilesAndNeverTheWhy() throws {
        let series = try json(.commitSeries(commits: [
            CommitPlan(message: "fix(cart): round the tax", parts: [CommitPart(path: "src/cart.ts", hunks: [0, 2])], why: "one behavior"),
            CommitPlan(message: "docs: the tax rule", parts: [CommitPart(path: "README.md")]),
        ], push: true))
        #expect(series["type"] as? String == "commit_series")
        #expect(series["push"] as? Bool == true)
        let commits = try #require(series["commits"] as? [[String: Any]])
        #expect(commits.count == 2)
        #expect(commits[0]["message"] as? String == "fix(cart): round the tax")
        #expect(commits[0]["why"] == nil)
        let first = try #require(commits[0]["parts"] as? [[String: Any]])
        #expect(first[0]["path"] as? String == "src/cart.ts" && first[0]["hunks"] as? [Int] == [0, 2])
        let second = try #require(commits[1]["parts"] as? [[String: Any]])
        #expect(second[0]["path"] as? String == "README.md")
        #expect(second[0]["hunks"] == nil)   // the whole file
        #expect(try json(.commitSeries(commits: []))["push"] == nil)   // the engine's default
    }

    @Test func theRepliesDecodeLeniently() throws {
        let hunks = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"commit_hunks","id":"h1","files":[
          {"path":"src/cart.ts","status":"M","binary":false,"hunks":[
            {"id":0,"header":"@@ -1,3 +1,4 @@","added":1,"deleted":0,"text":" a\n+b"},
            {"header":"no id"},
            {"id":1,"header":"@@ -9 +10 @@","added":"x"}]},
          {"path":"logo.png","status":"A","binary":true,"hunks":[]},
          {"status":"M"},
          {"path":"odd","status":"C"}]}
        """#)
        guard case let .commitHunks(reply) = hunks else { Issue.record("not commitHunks"); return }
        #expect(reply.id == "h1")
        #expect(reply.files.map(\.path) == ["src/cart.ts", "logo.png", "odd"])   // a file without a path is dropped
        #expect(reply.files[0].hunks == [CommitHunk(id: 0, header: "@@ -1,3 +1,4 @@", added: 1, deleted: 0, text: " a\n+b"),
                                         CommitHunk(id: 1, header: "@@ -9 +10 @@")])
        #expect(reply.files[1].wholeOnly && reply.files[1].binary && reply.files[1].status == .added)
        #expect(reply.files[2].status == .other)

        let draft = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"commit_split_draft","id":"d1","commits":[
          {"message":"fix: a","why":"  the fix  ","parts":[{"path":"a.ts","hunks":[0]},{"hunks":[1]},{"path":"b.md"}]},
          {"message":7,"parts":"none"}],
         "unassigned":[{"path":"a.ts","hunks":[1]}]}
        """#)
        guard case let .commitSplitDraft(plan) = draft else { Issue.record("not commitSplitDraft"); return }
        #expect(plan.id == "d1")
        #expect(plan.commits == [CommitPlan(message: "fix: a", parts: [CommitPart(path: "a.ts", hunks: [0]), CommitPart(path: "b.md")], why: "the fix"),
                                 CommitPlan(message: "", parts: [])])
        #expect(plan.unassigned == [CommitPart(path: "a.ts", hunks: [1])])

        let made = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"committed_series","id":"s1","commits":[{"sha":"aaaa1111bbbb","shortSha":"aaaa111","message":"fix: a\n\nbody","files":["a.ts"]},{"sha":""}],"branch":"main","pushed":true}
        """#)
        guard case let .committedSeries(series) = made else { Issue.record("not committedSeries"); return }
        #expect(series == CommittedSeries(id: "s1", commits: [SeriesCommit(sha: "aaaa1111bbbb", shortSha: "aaaa111", message: "fix: a\n\nbody", files: ["a.ts"])],
                                          branch: "main", pushed: true))
        #expect(series.commits[0].subject == "fix: a")
        #expect(made.replyId == "s1")
        // A detached HEAD has no branch.
        guard case let .committedSeries(detached) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"committed_series","commits":[],"branch":null,"pushed":false}"#) else {
            Issue.record("not committedSeries"); return
        }
        #expect(detached.branch == nil && detached.commits.isEmpty)
    }

    @Test func aStoppedSeriesRefusalCarriesWhatWasMade() throws {
        let event = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"result","id":"r9","ok":false,"error":"commit_failed:pre-commit hook rejected","code":"commit_failed",
         "partial":{"commits":[{"sha":"1111111aaaa","shortSha":"1111111","message":"feat: one","files":["a.ts"]}],"branch":"main","pushed":false}}
        """#)
        let partial = CommittedSeries(commits: [SeriesCommit(sha: "1111111aaaa", shortSha: "1111111", message: "feat: one", files: ["a.ts"])], branch: "main")
        #expect(event == .result(id: "r9", ok: false, error: "commit_failed:pre-commit hook rejected", code: "commit_failed", partial: partial))
        let refusal = try #require(EngineClientError.refusal(of: event))
        #expect(refusal == .refused("commit_failed:pre-commit hook rejected", code: "commit_failed", partial: partial))
        #expect(refusal.partialSeries == partial)
        #expect(refusal.refusalCode == "commit_failed")

        // The first commit failed: no `partial`. Any other refusal keeps its paths; a success is no refusal.
        let first = try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"r1","ok":false,"error":"commit_failed:hook","code":"commit_failed"}"#)
        #expect(EngineClientError.refusal(of: first)?.partialSeries == nil)
        let paths = try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"r2","ok":false,"error":"not_captured:a","code":"not_captured","paths":["a"]}"#)
        #expect(EngineClientError.refusal(of: paths) == .refused("not_captured:a", code: "not_captured", paths: ["a"]))
        #expect(EngineClientError.refusal(of: .result(id: "r3", ok: true, error: nil)) == nil)
        // A `partial` of another shape never fails the result.
        let odd = try NDJSON.decode(EngineEvent.self, from: #"{"type":"result","id":"r4","ok":false,"error":"commit_failed:x","partial":"made two"}"#)
        #expect(EngineClientError.refusal(of: odd)?.partialSeries == nil)
    }
}
