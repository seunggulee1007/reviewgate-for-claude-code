import Foundation
import Testing
@testable import ReviewGateCore

/// docs/PROTOCOL.md §53 in the Mac commit sheet's "나눠서 커밋" mode: the cards and "커밋하지 않음" as one state (moves,
/// reorder, delete, Claude's proposal and its restore), the `commit_series` commits, the button's reason, the words, and
/// the requests with a stopped series' commits (the Electron client's commitSplit.test.ts, on the Swift side).
@MainActor
@Suite struct CommitSplitTests {
    private static func hunk(_ id: Int) -> CommitHunk { CommitHunk(id: id, header: "@@ -\(id),1 +\(id),2 @@", added: 1, deleted: 0, text: "+x") }
    private let files = [
        CommitFile(path: "a.ts", hunks: [hunk(0), hunk(1), hunk(2)]),
        CommitFile(path: "b.md", status: .added),
        CommitFile(path: "c.ts", hunks: [hunk(0)]),
    ]

    private func keys(_ s: CommitSplitState, _ target: SplitTarget) -> [String] { s.parts(in: target).map(\.key) }

    private func makeStore(project: Bool = true) -> AppState {
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "CommitSplitTests.\(UUID().uuidString)")!)
        if project { store.handle(.state(snapshot(seq: 1))) }
        return store
    }

    private func snapshot(seq: Int, lastCommit: LastCommit? = nil) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/work/acme", root: "/work/acme", name: "acme", branch: "main", remoteURL: nil)
        s.commit = CommitState(lastCommit: lastCommit, canCommit: true, acceptedPaths: ["a.ts", "b.md", "c.ts"])
        return s
    }

    // MARK: - The state

    @Test func startsAsOneCardWithEverythingAWholeOnlyFileIsOnePart() {
        let s = CommitSplitState(files: files, message: "msg")
        #expect(s.cards.count == 1 && s.cards[0].message == "msg")
        #expect(keys(s, .card(1)) == ["a.ts#0", "a.ts#1", "a.ts#2", "b.md#whole", "c.ts#0"])
        #expect(CommitSplitState.allParts(files).count == 5)
        #expect(s.unassigned.isEmpty && !s.canRestore)
    }

    @Test func movesAHunkAWholeFileToANewCardAndToNotCommittedAndBack() {
        var s = CommitSplitState(files: files)
        let two = s.addCard()
        #expect(two == 2)
        let moved1 = s.movePart(SplitPart(path: "a.ts", hunk: 1), from: .card(1), to: .card(2), files: files)
        #expect(moved1)
        #expect(keys(s, .card(1)) == ["a.ts#0", "a.ts#2", "b.md#whole", "c.ts#0"])
        #expect(keys(s, .card(2)) == ["a.ts#1"])
        let movedFile = s.moveFile("a.ts", from: .card(1), to: .card(2), files: files)   // the file: every part of it in the card
        #expect(movedFile)
        #expect(keys(s, .card(2)) == ["a.ts#0", "a.ts#1", "a.ts#2"])
        let moved2 = s.moveFile("b.md", from: .card(1), to: .notCommitted, files: files)
        #expect(moved2)
        #expect(keys(s, .notCommitted) == ["b.md#whole"])
        let moved3 = s.movePart(SplitPart(path: "b.md"), from: .notCommitted, to: .card(1), files: files)
        #expect(moved3)
        #expect(s.unassigned.isEmpty)
        #expect(keys(s, .card(1)) == ["b.md#whole", "c.ts#0"])
        // Nothing to move, the same place, an unknown card: unchanged.
        let before = s
        let moved4 = s.moveFile("c.ts", from: .card(1), to: .card(1), files: files)
        #expect(!moved4)
        let moved5 = s.moveFile("zzz", from: .card(2), to: .card(1), files: files)
        #expect(!moved5)
        let moved6 = s.moveFile("c.ts", from: .card(1), to: .card(99), files: files)
        #expect(!moved6)
        #expect(s == before)
    }

    @Test func theMoveMenuListsTheOtherCardsThenNotCommitted() {
        var s = CommitSplitState(files: files)
        s.addCard()
        s.addCard()
        #expect(s.targets(from: .card(2)) == [.card(1), .card(3), .notCommitted])
        #expect(s.targets(from: .notCommitted) == [.card(1), .card(2), .card(3)])
        #expect(s.number(of: 3) == 3 && s.number(of: 9) == nil)
    }

    @Test func reordersNotPastTheEndsAndDeletingACardSendsItsPartsToNotCommitted() {
        var s = CommitSplitState(files: files)
        s.addCard()
        s.reorder(2, by: -1)
        #expect(s.cards.map(\.id) == [2, 1])
        let top = s
        s.reorder(2, by: -1)
        s.reorder(1, by: 1)
        #expect(s == top)
        s.deleteCard(1, files: files)
        #expect(s.cards.map(\.id) == [2])
        #expect(s.unassigned.count == 5)
        #expect(s.unassigned.first == SplitPart(path: "a.ts", hunk: 0))
    }

    @Test func appliesAProposalAndRestoresTheArrangementBeforeIt() {
        var s = CommitSplitState(files: files, message: "mine")
        s.setMessage("mine edited", card: 1)
        s.propose(files: files, commits: [
            CommitPlan(message: "fix a", parts: [CommitPart(path: "a.ts", hunks: [0, 7]), CommitPart(path: "zzz")], why: "first"),
            CommitPlan(message: "docs", parts: [CommitPart(path: "b.md"), CommitPart(path: "a.ts", hunks: [0]), CommitPart(path: "c.ts")]),
        ])
        #expect(s.cards.map(\.message) == ["fix a", "docs"])
        #expect(s.cards[0].why == "first" && s.cards[1].why == nil)
        #expect(s.cards[0].parts.map(\.key) == ["a.ts#0"])   // an unknown id and path dropped
        #expect(s.cards[1].parts.map(\.key) == ["b.md#whole", "c.ts#0"])   // no hunk twice
        #expect(s.unassigned.map(\.key) == ["a.ts#1", "a.ts#2"])
        #expect(Set(s.cards.flatMap(\.parts) + s.unassigned).count == 5)
        #expect(s.cards.map(\.id) == [2, 3] && s.canRestore)
        s.restore()
        #expect(s.cards.map(\.message) == ["mine edited"] && s.cards[0].parts.count == 5)
        #expect(!s.canRestore)
        let restored = s
        s.restore()
        #expect(s == restored)
    }

    @Test func aProposedPartWithoutHunksIsEveryHunkOfItsFile() {
        var s = CommitSplitState(files: files)
        s.propose(files: files, commits: [CommitPlan(message: "all a", parts: [CommitPart(path: "a.ts")])])
        #expect(s.cards[0].parts.map(\.key) == ["a.ts#0", "a.ts#1", "a.ts#2"])
        #expect(s.unassigned.map(\.key) == ["b.md#whole", "c.ts#0"])
    }

    // MARK: - The commit_series commits

    @Test func aFileWithHunksGoesAsHunksAWholeOnlyFileWholeMessagesTrimmed() {
        var s = CommitSplitState(files: files, message: "  one  ")
        let two = s.addCard()
        s.setMessage("two", card: two)
        s.movePart(SplitPart(path: "a.ts", hunk: 2), from: .card(1), to: .card(two), files: files)
        s.moveFile("c.ts", from: .card(1), to: .notCommitted, files: files)
        #expect(s.series() == [
            CommitPlan(message: "one", parts: [CommitPart(path: "a.ts", hunks: [0, 1]), CommitPart(path: "b.md")]),
            CommitPlan(message: "two", parts: [CommitPart(path: "a.ts", hunks: [2])]),
        ])
        // Every hunk of a file that has hunks still goes as hunks.
        #expect(CommitSplitState(files: files, message: "all").series()[0].parts[0] == CommitPart(path: "a.ts", hunks: [0, 1, 2]))
    }

    // MARK: - The button's reason and the words

    @Test func theButtonSaysWhyItIsOff() {
        let s = CommitSplitState(files: files, message: "m")
        #expect(s.blocker() == nil)
        var none = s
        none.deleteCard(1, files: files)
        #expect(none.blocker() == "Add a commit first")
        var blank = s
        blank.setMessage("  ", card: 1)
        #expect(blank.blocker() == "Commit 1 has no message")
        var added = s
        added.addCard()
        #expect(added.blocker() == "Commit 2 has no message")
        added.setMessage("second", card: 2)
        #expect(added.blocker() == "Commit 2 has no changes")
        #expect(s.blocker(splitting: true) == "Splitting…")
        #expect(s.blocker(committing: true) == "Committing…")
    }

    @Test func theResultAndTheRefusalsInWords() {
        let made = [SeriesCommit(sha: "aaa1111", shortSha: "aaa1", message: "m1", files: ["a"]),
                    SeriesCommit(sha: "bbb2222", shortSha: "bbb2", message: "m2", files: ["b"])]
        #expect(CommitSplitText.done(made, pushed: false) == "Made 2 commit(s): aaa1, bbb2")
        #expect(CommitSplitText.done(made, pushed: true) == "Made 2 commit(s): aaa1, bbb2 · pushed")
        func words(_ error: String, code: String? = nil) -> String { CommitSplitText.refusal(EngineClientError.refused(error, code: code)) }
        #expect(words("commit_split_failed:the fork answered nothing", code: "commit_split_failed") == "Claude could not split the changes: the fork answered nothing")
        #expect(words("commit_split_failed") == "Claude could not split the changes")
        #expect(words("nothing_to_commit").contains("accepted"))
        #expect(words("side_limit").contains("side sessions"))
        #expect(words("invalid_part:src/a.ts", code: "invalid_part").hasPrefix("src/a.ts cannot be committed this way"))
        #expect(words("hunk_twice:src/a.ts#1", code: "hunk_twice") == "src/a.ts#1 is in two commits — a part can only be in one")
        #expect(words("empty message") == "A commit has no message")
        #expect(words("session_running").contains("Claude is working"))
        #expect(words("merge_unresolved:a merge is in progress", code: "merge_unresolved") == "There are unresolved merge conflicts — resolve them first")
        #expect(words("commit_failed:hook rejected", code: "commit_failed") == "git could not commit: hook rejected")
        #expect(words("git_identity_missing:user.name not set").contains("git config"))
        #expect(words("unknown command: commit_series") == FlowText.updateReason)
        #expect(words("brand_new:words") == "brand_new:words")   // an unknown code: the engine's own text
        let stopped = EngineClientError.refused("commit_failed:hook rejected", code: "commit_failed")
        #expect(CommitSplitText.failure(stopped, made: made) == "Made 2 commit(s): aaa1, bbb2 — then it stopped: git could not commit: hook rejected")
        #expect(CommitSplitText.failure(EngineClientError.refused("empty message"), made: []) == "A commit has no message")
    }

    /// Every word above has its Korean in the Core catalog, as the Electron client says it (its ko.json is generated from it).
    @Test func theWordsAreInTheCatalog() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ReviewGateCore/Resources/Localizable.xcstrings")
        let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let strings = try #require(doc?["strings"] as? [String: Any])
        func korean(_ key: String) -> String? {
            let entry = strings[key] as? [String: Any]
            return (((entry?["localizations"] as? [String: Any])?["ko"] as? [String: Any])?["stringUnit"] as? [String: Any])?["value"] as? String
        }
        #expect(korean("Made %lld commit(s): %@") == "커밋 %lld개를 만들었어요 (%@)")
        #expect(korean("then it stopped") == "그다음에 멈췄어요")
        #expect(korean("Commit %lld has no message") == "%lld번째 커밋에 메시지가 없어요")
        for key in ["Add a commit first", "Commit %lld has no changes", "Splitting…", "Committing…", "Loading…", "pushed",
                    "Close this sheet — some commits were already made", "Claude could not split the changes",
                    "Claude could not split the changes: %@", "%@ cannot be committed this way — it is not an accepted file, or the part is gone",
                    "%@ is in two commits — a part can only be in one", "A commit has no message",
                    "There are unresolved merge conflicts — resolve them first", "git could not commit", "git could not commit: %@"] {
            #expect(korean(key)?.isEmpty == false, "no Korean for \(key)")
        }
    }

    // MARK: - The requests

    @Test func theHunksAndClaudesSplitComeFromTheEngine() async {
        let store = makeStore()
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            switch command {
            case .commitHunks: return .commitHunks(CommitHunksReply(files: self.files))
            default: return .commitSplitDraft(CommitSplitDraftReply(commits: [CommitPlan(message: "docs", parts: [CommitPart(path: "b.md")], why: "docs alone")]))
            }
        }
        let session = CommitSplitSession(paths: ["a.ts", "b.md", "c.ts"], message: "from the sheet")
        #expect(session.files == nil && session.blocker == "Loading…")
        await session.load(store)
        #expect(session.files == files)
        #expect(session.state.cards.map(\.message) == ["from the sheet"] && session.state.cards[0].parts.count == 5)
        #expect(session.blocker == nil)
        await session.splitWithClaude(store)
        #expect(session.state.cards.map(\.message) == ["docs"] && session.state.cards[0].why == "docs alone")
        #expect(session.state.unassigned.count == 4 && session.state.canRestore && !session.isSplitting)
        #expect(sent == [.commitHunks(paths: ["a.ts", "b.md", "c.ts"]), .commitSplitDraft(paths: ["a.ts", "b.md", "c.ts"])])

        // Claude's failure in words; an engine before §53 says to update.
        store.replySink = { _ in throw EngineClientError.refused("commit_split_failed:no JSON plan in the answer", code: "commit_split_failed") }
        await session.splitWithClaude(store)
        #expect(session.splitError == "Claude could not split the changes: no JSON plan in the answer")
        #expect(session.state.cards.map(\.message) == ["docs"])   // the cards stay
        store.replySink = { _ in throw EngineClientError.refused("unknown command: commit_hunks", code: "unknown_command") }
        let old = CommitSplitSession(paths: ["a.ts"])
        await old.load(store)
        #expect(old.files == nil && old.loadError == FlowText.updateReason && old.blocker == FlowText.updateReason)
        guard case let .failure(failure) = await store.loadCommitHunks(paths: nil) else { Issue.record("not a failure"); return }
        #expect(failure.unsupported)
    }

    @Test func theSeriesGoesOutAsTheCardsSayAndItsResultComesBack() async {
        let store = makeStore()
        var sent: [EngineCommand] = []
        let made = CommittedSeries(commits: [SeriesCommit(sha: "aaa1111", shortSha: "aaa1111", message: "one")], branch: "main", pushed: false)
        store.replySink = { command in sent.append(command); return .committedSeries(made) }
        store.flow.commitMessageDraft = "typed"
        let session = CommitSplitSession(paths: ["a.ts", "b.md", "c.ts"], files: files, message: "one")
        #expect(await session.commit(store, push: true) == made)
        #expect(sent == [.commitSeries(commits: session.state.series(), push: true)])
        #expect(store.flow.lastSeries == made && store.flow.commitMessageDraft == nil)
        // A card without a message: nothing goes out.
        let blank = CommitSplitSession(paths: ["a.ts"], files: files)
        #expect(await blank.commit(store, push: false) == nil)
        #expect(sent.count == 1)
    }

    @Test func aStoppedSeriesSaysWhatItMadeThenWhyAndOnlyCloses() async {
        let store = makeStore()
        let partial = CommittedSeries(commits: [SeriesCommit(sha: "1111111aaaa", shortSha: "1111111", message: "feat: one", files: ["a.ts"])], branch: "main")
        store.replySink = { _ in throw EngineClientError.refused("commit_failed:pre-commit hook rejected", code: "commit_failed", partial: partial) }
        let session = CommitSplitSession(paths: ["a.ts", "b.md", "c.ts"], files: files, message: "one")
        #expect(await session.commit(store, push: false) == nil)
        #expect(session.made == partial.commits && session.stopped)
        #expect(session.commitError == "Made 1 commit(s): 1111111 — then it stopped: git could not commit: pre-commit hook rejected")
        #expect(session.blocker == CommitSplitText.stopped && !session.canSplit)
        // The first commit failed: nothing was made, the series can be fixed and made again.
        store.replySink = { _ in throw EngineClientError.refused("commit_failed:hook", code: "commit_failed") }
        let first = CommitSplitSession(paths: ["a.ts"], files: files, message: "one")
        #expect(await first.commit(store, push: false) == nil)
        #expect(!first.stopped && first.commitError == "git could not commit: hook" && first.blocker == nil)
    }

    @Test func aRefusedPushAfterEveryCommitIsASuccessTheBannerOffersPushNow() async {
        let store = makeStore()
        store.replySink = { _ in
            store.handle(.state(self.snapshot(seq: 2, lastCommit: LastCommit(sha: "ccc3333", shortSha: "ccc3333", branch: "main", pushError: "push_failed:rejected"))))
            throw EngineClientError.refused("push_failed:rejected", code: "push_failed")
        }
        guard case let .success(series) = await store.commitSeries([CommitPlan(message: "m", parts: [CommitPart(path: "b.md")])], push: true) else {
            Issue.record("not a success"); return
        }
        #expect(series == CommittedSeries(branch: "main", pushed: false))
        #expect(store.flow.lastSeries == nil)
        // Without a project nothing goes out.
        let closed = makeStore(project: false)
        closed.replySink = { _ in Issue.record("sent without a project"); return .committedSeries(CommittedSeries()) }
        guard case let .failure(failure) = await closed.commitSeries([], push: nil) else { Issue.record("not a failure"); return }
        #expect(failure.text == EngineMessages.refusal(error: "no_project"))
    }
}
