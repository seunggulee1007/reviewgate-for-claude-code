import Foundation
import Testing
@testable import ReviewGateCore

/// MARK: git-sync — docs/PROTOCOL.md §68 on the Mac: `git_fetch` / `git_pull` on the wire, `state.branches.sync` and the
/// replies read leniently, the branch menu's reasons and badge, and the line a Fetch / Pull leaves under the branch chip.
@Suite @MainActor struct GitSyncTests {
    private func json(_ command: EngineCommand) throws -> [String: Any] {
        let data = try NDJSON.encodeLine(EngineCommandEnvelope(id: nil, command: command))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func makeStore() -> AppState {
        AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: UserDefaults(suiteName: "GitSyncTests.\(UUID().uuidString)")!)
    }

    private func snapshot(seq: Int, sync: GitSyncState?, ahead: Int = 0, behind: Int = 0) -> ReviewState {
        var s = ReviewState.empty
        s.seq = seq
        s.project = ProjectInfo(path: "/Users/dev/acme", root: "/Users/dev/acme", name: "acme", branch: "main", remoteURL: nil)
        s.branches = BranchesInfo(list: [BranchInfo(name: "main", isCurrent: true, upstream: "origin/main", ahead: ahead, behind: behind, lastCommitDate: nil)],
                                  isWorktreeDirty: false, switchBlocker: nil, sync: sync)
        return s
    }

    @Test func theCommandsCarryTheirFieldsOnlyWhenSet() throws {
        let fetch = try json(.gitFetch())
        #expect(fetch["type"] as? String == "git_fetch")
        #expect(fetch["all"] == nil && fetch["auto"] == nil)
        let auto = try json(.gitFetch(all: true, auto: true))
        #expect(auto["all"] as? Bool == true && auto["auto"] as? Bool == true)
        #expect(try json(.gitPull())["type"] as? String == "git_pull")
        #expect(try json(.gitPull())["rebase"] == nil)
        #expect(try json(.gitPull(rebase: true))["rebase"] as? Bool == true)
        var settings = EngineSettings()
        settings.autoFetch = false
        let set = try #require(try json(.setSettings(settings))["settings"] as? [String: Any])
        #expect(set["autoFetch"] as? Bool == false)
    }

    @Test func syncStateAndRepliesDecodeLeniently() throws {
        let state = try NDJSON.decode(BranchesInfo.self, from: #"""
        {"list":[],"isWorktreeDirty":false,"switchBlocker":null,"sync":{"fetching":true,"pulling":"x","lastFetchAt":null,
         "lastFetchError":"fetch_failed:could not read from remote","remotes":["origin","upstream"],"upstream":"origin/main",
         "operation":"cherry-pick","pullBlocker":{"kind":"operation","operation":"cherry-pick"},"fetchBlocker":{"kind":"later"}}}
        """#)
        let sync = try #require(state.sync)
        #expect(sync.fetching && !sync.pulling && sync.isBusy)
        #expect(sync.remotes == ["origin", "upstream"] && sync.upstream == "origin/main")
        #expect(sync.operation == .cherryPick && sync.pullBlocker == .operation(.cherryPick))
        #expect(sync.fetchBlocker == nil)   // an unknown kind is dropped, not fatal
        #expect(sync.autoFetch)   // absent: on
        // An older engine: no sync at all.
        #expect(try NDJSON.decode(BranchesInfo.self, from: #"{"list":[],"isWorktreeDirty":false,"switchBlocker":null}"#).sync == nil)

        guard case let .fetched(f) = try NDJSON.decode(EngineEvent.self, from: #"{"type":"fetched","id":"f1","remotes":["origin"],"ahead":0,"behind":3}"#)
        else { Issue.record("not fetched"); return }
        #expect(f == FetchedReply(id: "f1", remotes: ["origin"], skipped: false, ahead: 0, behind: 3))
        guard case let .pulled(p) = try NDJSON.decode(EngineEvent.self, from: #"""
        {"type":"pulled","id":"p1","branch":"main","upstream":"origin/main","mode":"fast_forward","from":"a","to":"b","commits":2,"files":["x.ts","y.ts"]}
        """#) else { Issue.record("not pulled"); return }
        #expect(p.mode == .fastForward && p.commits == 2 && p.fileCount == 2 && p.files == ["x.ts", "y.ts"])
    }

    @Test func reasonsBadgeAndDivergence() {
        let behind = BranchInfo(name: "main", isCurrent: true, upstream: "origin/main", ahead: 0, behind: 3, lastCommitDate: nil)
        let both = BranchInfo(name: "main", isCurrent: true, upstream: "origin/main", ahead: 2, behind: 3, lastCommitDate: nil)
        let local = BranchInfo(name: "topic", isCurrent: true, upstream: nil, ahead: 0, behind: 0, lastCommitDate: nil)
        #expect(GitSyncRules.badge(behind) == "↓3")
        #expect(GitSyncRules.badge(both) == "↑2 ↓3")
        #expect(GitSyncRules.badge(local) == "")
        #expect(GitSyncRules.badgeHelp(both) == "2 commit(s) to push · 3 commit(s) to pull — origin/main")
        #expect(!GitSyncRules.isDiverged(behind) && GitSyncRules.isDiverged(both) && !GitSyncRules.isDiverged(local))

        #expect(GitSyncRules.pullDisabledReason(sync: nil) == nil)   // hidden, not disabled
        #expect(GitSyncRules.pullDisabledReason(sync: GitSyncState()) == nil)
        #expect(GitSyncRules.pullDisabledReason(sync: GitSyncState(pullBlocker: .noUpstream))!.contains("no upstream"))
        #expect(GitSyncRules.pullDisabledReason(sync: GitSyncState(pullBlocker: .operation(.rebase)))!.contains("rebase is in progress"))
        #expect(GitSyncRules.pullDisabledReason(sync: GitSyncState(fetching: true)) == GitSyncText.pullBlocker(.busy))
        #expect(GitSyncRules.fetchDisabledReason(sync: GitSyncState(fetchBlocker: .noRemote)) == "The repository has no remote")
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(), reviewFiles: 1, worktreeDirty: false)!.contains("Finish the review"))
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(), reviewFiles: 0, worktreeDirty: true) == "Commit your changes before rebasing")
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(), reviewFiles: 0, worktreeDirty: false) == nil)
        // Pull's blockers in a rebase's own words — not "pull when the turn ends" on the Rebase item.
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(pullBlocker: .running), reviewFiles: 0, worktreeDirty: false)
                == "Claude is working — rebase when the turn ends")
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(pullBlocker: .operation(.merge)), reviewFiles: 0, worktreeDirty: false)
                == "A merge is in progress — finish or abort it in a terminal, then rebase")
        #expect(GitSyncRules.rebaseDisabledReason(sync: GitSyncState(fetching: true), reviewFiles: 1, worktreeDirty: false)
                == "A fetch or pull is already running")
        #expect(GitSyncRules.pullDisabledReason(sync: GitSyncState(pullBlocker: .running)) == "Claude is working — pull when the turn ends")
    }

    @Test func refusalsSayWhatToDo() {
        #expect(EngineMessages.refusal(error: "pull_diverged:2,3").contains("2 local, 3 incoming"))
        #expect(EngineMessages.refusal(error: "pull_no_upstream:topic").hasPrefix("topic has no upstream"))
        #expect(EngineMessages.refusal(error: "pull_in_progress:merge").hasPrefix("A merge is in progress"))
        #expect(EngineMessages.refusal(error: "pull_would_overwrite:a.ts, b.ts").contains("a.ts, b.ts"))
        #expect(EngineMessages.refusal(error: "pull_blocked:running").hasPrefix("Claude is working"))
        #expect(EngineMessages.refusal(error: "pull_rebase_blocked:review").contains("Finish the review"))
        #expect(EngineMessages.refusal(error: "fetch_failed:fatal: could not read from remote") == "Fetch failed: fatal: could not read from remote")
        #expect(GitSyncText.pulled(PulledReply(upstream: "origin/main", mode: .upToDate)) == "Already up to date with origin/main")
        #expect(GitSyncText.fetched(FetchedReply(remotes: ["origin"], behind: 2)) == "Fetched origin — 2 incoming commit(s) to pull")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(GitSyncText.lastFetched("2027-01-15T08:00:00.000Z", now: Date(timeIntervalSince1970: 1_800_001_000)) != nil)
        #expect(GitSyncText.lastFetched(nil, now: now) == nil)
    }

    @Test func pullLeavesTheOutcomeOrTheRefusalWithItsFiles() async {
        let store = makeStore()
        store.handle(.state(snapshot(seq: 1, sync: GitSyncState(remotes: ["origin"], upstream: "origin/main"), behind: 2)))
        #expect(store.currentBranch?.behind == 2)
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            return .pulled(PulledReply(branch: "main", upstream: "origin/main", mode: .fastForward, from: "a", to: "b", commits: 2, files: ["x.ts"], fileCount: 1))
        }
        await store.pull()
        #expect(sent == [.gitPull(rebase: false)])
        #expect(store.gitSyncNotice == GitSyncNotice(kind: .success, text: "Pulled 2 commit(s) from origin/main · 1 file(s) changed", paths: ["x.ts"]))

        store.replySink = { _ in throw EngineClientError.refused("pull_would_overwrite:a.ts", code: "pull_would_overwrite", paths: ["a.ts"]) }
        await store.pull()
        #expect(store.gitSyncNotice?.kind == .error)
        #expect(store.gitSyncNotice?.paths == ["a.ts"])
        #expect(store.gitSyncNotice?.text.contains("Nothing was changed") == true)
        store.dismissGitSyncNotice()
        #expect(store.gitSyncNotice == nil)

        // Off while the engine says so: nothing is sent.
        store.handle(.state(snapshot(seq: 2, sync: GitSyncState(pullBlocker: .running))))
        sent = []
        await store.pull()
        #expect(sent.isEmpty)
    }

    @Test func autoFetchFollowsTheSettingAndShowsNothing() async {
        let defaults = UserDefaults(suiteName: "GitSyncTests.auto.\(UUID().uuidString)")!
        let store = AppState(engineScript: "/nonexistent/sidecar.mjs", defaults: defaults)
        store.handle(.state(snapshot(seq: 1, sync: GitSyncState(remotes: ["origin"], upstream: "origin/main"))))
        var sent: [EngineCommand] = []
        store.replySink = { command in
            sent.append(command)
            throw EngineClientError.refused("fetch_failed:offline", code: "fetch_failed")
        }
        #expect(AppSettings.autoFetch(defaults: defaults))
        await store.autoFetch()
        #expect(sent == [.gitFetch(all: false, auto: true)])
        #expect(store.gitSyncNotice == nil)   // an automatic fetch never shows an error
        // Older engine (no sync): nothing is sent.
        store.handle(.state(snapshot(seq: 2, sync: nil)))
        sent = []
        await store.autoFetch()
        await store.fetch()
        #expect(sent.isEmpty)
    }
}
