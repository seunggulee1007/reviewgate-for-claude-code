import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: git-sync — docs/PROTOCOL.md §68.5 on the Mac: `commit_others` / `commit.extraPaths` on the wire,
/// `state.commit.otherChanges`, the commit sheet's second group (none ticked, untracked on request) and the sheet opening
/// for files outside the review alone.
@Suite @MainActor struct CommitOthersTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "CommitOthersTests.\(UUID().uuidString)")!)
    }

    @Test func theCommandsAndRepliesOnTheWire() throws {
        #expect(try json(.commitOthers)["type"] as? String == "commit_others")
        let commit = try json(.commitWithOthers(message: "both", paths: [], extraPaths: ["notes.md"], push: nil))
        #expect(commit["type"] as? String == "commit")
        #expect(commit["paths"] as? [String] == [])   // no review file ticked: not "every accepted file"
        #expect(commit["extraPaths"] as? [String] == ["notes.md"])
        #expect(commit["push"] == nil)

        guard case let .commitOthers(reply) = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"commit_others","id":"o1","truncated":false,"files":[
          {"path":"new-name.txt","oldPath":"old-name.txt","status":"R","untracked":false},
          {"path":".omc/state.json","oldPath":null,"status":"?","untracked":true,"hidden":true},
          {"status":"M"}]}
        """#) else { Issue.record("not commitOthers"); return }
        #expect(reply.id == "o1" && !reply.truncated)
        #expect(reply.files == [OtherChange(path: "new-name.txt", oldPath: "old-name.txt", status: "R"),
                                OtherChange(path: ".omc/state.json", status: "?", untracked: true, hidden: true)])

        let state = try NDJSON.decode(CommitState.self, from: #"{"canCommit":false,"acceptedPaths":[],"suggestedMessage":"","otherChanges":{"tracked":2,"untracked":"x"}}"#)
        #expect(state.otherChanges == OtherChangeCounts(tracked: 2, untracked: 0))
        #expect(try NDJSON.decode(CommitState.self, from: #"{"canCommit":false}"#).otherChanges == nil)   // an older engine
    }

    @Test func theSecondGroupStartsUntickedAndHidesUntrackedUntilAsked() {
        let files = [OtherChange(path: "README.md"), OtherChange(path: "notes.md", status: "?", untracked: true)]
        #expect(CommitOthersRules.visible(files, showUntracked: false).map(\.path) == ["README.md"])
        #expect(CommitOthersRules.visible(files, showUntracked: true).map(\.path) == ["README.md", "notes.md"])
        // A ticked untracked file that is hidden again is not committed.
        #expect(CommitOthersRules.extraPaths(ticked: ["notes.md", "README.md"], files: files, showUntracked: false) == ["README.md"])
        #expect(CommitOthersRules.extraPaths(ticked: [], files: files, showUntracked: true).isEmpty)
        #expect(!CommitOthersRules.canCommit(reviewTicked: 0, extras: 0))
        #expect(CommitOthersRules.canCommit(reviewTicked: 0, extras: 1))
    }

    @Test func aSheetOfOnlyOtherChangesIsNotAboutAcceptedFiles() {
        #expect(CommitOthersRules.othersOnly(reviewListed: 0, others: 2, truncated: false))
        #expect(CommitOthersRules.othersOnly(reviewListed: 0, others: 0, truncated: true))   // over 500, none listed
        #expect(!CommitOthersRules.othersOnly(reviewListed: 1, others: 2, truncated: false))   // the review's files lead
        #expect(!CommitOthersRules.othersOnly(reviewListed: 0, others: 0, truncated: false))   // nothing at all: as before
    }

    @Test func theSheetOpensForFilesOutsideTheReviewAlone() {
        let store = makeStore()
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/Users/dev/acme", root: "/Users/dev/acme", name: "acme", branch: "main", remoteURL: nil)
        store.handle(.state(s))
        #expect(!store.canOpenCommitSheet)
        s.seq = 2
        s.commit = CommitState(otherChanges: OtherChangeCounts(tracked: 1, untracked: 0))
        store.handle(.state(s))
        #expect(store.otherChangeCounts?.total == 1)
        #expect(store.canOpenCommitSheet)
        #expect(EngineMessages.refusal(error: "invalid_extra:b.txt") == "b.txt is no longer a change outside the review — reopen the commit sheet")
    }

    @Test func theSheetAsksForTheOtherChanges() async {
        let store = makeStore()
        var s = ReviewState.empty
        s.seq = 1
        s.project = ProjectInfo(path: "/Users/dev/acme", root: "/Users/dev/acme", name: "acme", branch: "main", remoteURL: nil)
        store.handle(.state(s))
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            return .commitOthers(CommitOthersReply(files: [OtherChange(path: "README.md")]))
        }
        let others = await store.loadOtherChanges()
        #expect(others?.files.map(\.path) == ["README.md"])
        #expect(sent == [.commitOthers])
    }
}
